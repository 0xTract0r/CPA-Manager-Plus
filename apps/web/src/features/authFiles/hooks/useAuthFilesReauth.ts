import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isOAuthCancelSuccessful, oauthApi, type OAuthProvider } from '@/services/api/oauth';
import { useNotificationStore } from '@/stores';
import type { AuthFileItem } from '@/types';

export type AuthFileReauthState = {
  provider: OAuthProvider;
  status: 'starting' | 'polling' | 'success' | 'cancelled' | 'error';
  url?: string;
  state?: string;
  error?: string;
  callbackUrl?: string;
  callbackSubmitting?: boolean;
  callbackStatus?: 'success' | 'error';
  callbackError?: string;
};

type UseAuthFilesReauthOptions = {
  loadFiles: () => Promise<void>;
  /**
   * 重认证成功 / 失败后，让页面刷新该文件的审计面板（reauth / 状态历史）。
   * cpamp 用 auditReloadKey 机制，这里透传 fileName 由页面 bump。
   */
  onReauthHistoryChanged?: (fileName: string) => void | Promise<void>;
};

// 认证文件 provider（type/provider 字段）→ core OAuth provider 的映射。
// 与旧版 apps/web 的 AUTH_FILE_OAUTH_PROVIDER_MAP 一致，用于判断某个认证文件是否
// 可走通用 OAuth 重认证流程。codex 仍保留在映射里，但卡片层会把 codex 排除出通用
// 流程（codex 走既有的 CodexReauthDialog），避免同一账号出现两个重认证入口。
const AUTH_FILE_OAUTH_PROVIDER_MAP: Record<string, OAuthProvider> = {
  anthropic: 'anthropic',
  claude: 'anthropic',
  codex: 'codex',
  antigravity: 'antigravity',
  gemini: 'gemini-cli',
  'gemini-cli': 'gemini-cli',
  kimi: 'kimi',
  xai: 'xai',
  grok: 'xai',
};

// 支持「手动粘贴回调 URL」补全 OAuth 的 provider 集合。其余 provider 只能靠
// 授权链接跳转 + 轮询完成，不展示回调输入框。
const AUTH_FILE_CALLBACK_SUPPORTED_PROVIDERS: OAuthProvider[] = [
  'codex',
  'anthropic',
  'antigravity',
  'gemini-cli',
  'xai',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isRecord(error) && typeof error.message === 'string') return error.message;
  return typeof error === 'string' ? error : '';
}

function getErrorStatus(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  return typeof error.status === 'number' ? error.status : undefined;
}

const readProviderKey = (file: AuthFileItem): string => {
  const provider =
    typeof file.provider === 'string' && file.provider.trim()
      ? file.provider.trim()
      : typeof file.type === 'string'
        ? file.type.trim()
        : '';
  return provider.toLowerCase();
};

const readGeminiProjectId = (file: AuthFileItem): string => {
  const raw =
    file.project_id ?? file.projectId ?? file.gemini_virtual_project ?? file.geminiVirtualProject;
  return typeof raw === 'string' ? raw.trim() : '';
};

export const resolveAuthFileOAuthProvider = (file: AuthFileItem): OAuthProvider | null => {
  const providerKey = readProviderKey(file);
  return AUTH_FILE_OAUTH_PROVIDER_MAP[providerKey] ?? null;
};

export const supportsAuthFileReauthCallback = (provider: OAuthProvider | null | undefined) =>
  Boolean(provider && AUTH_FILE_CALLBACK_SUPPORTED_PROVIDERS.includes(provider));

export function useAuthFilesReauth(options: UseAuthFilesReauthOptions) {
  const { loadFiles, onReauthHistoryChanged } = options;
  const { t } = useTranslation();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const showConfirmation = useNotificationStore((state) => state.showConfirmation);
  const [states, setStates] = useState<Record<string, AuthFileReauthState>>({});
  const pollingTimersRef = useRef<Record<string, ReturnType<typeof setInterval>>>({});

  const clearPollingTimer = useCallback((fileName: string) => {
    const timer = pollingTimersRef.current[fileName];
    if (timer !== undefined) {
      clearInterval(timer);
      delete pollingTimersRef.current[fileName];
    }
  }, []);

  useEffect(() => {
    return () => {
      Object.values(pollingTimersRef.current).forEach((timer) => clearInterval(timer));
      pollingTimersRef.current = {};
    };
  }, []);

  const copyReauthLink = useCallback(
    async (fileName: string) => {
      const url = states[fileName]?.url;
      if (!url) return;

      try {
        if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
          throw new Error('Clipboard API unavailable');
        }
        await navigator.clipboard.writeText(url);
        showNotification(
          t('auth_files.reauth_copy_success', { defaultValue: 'Authentication link copied' }),
          'success'
        );
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : '';
        showNotification(
          t('auth_files.reauth_copy_failed', {
            defaultValue: 'Failed to copy authentication link',
          }) + (errorMessage ? `: ${errorMessage}` : ''),
          'error'
        );
      }
    },
    [showNotification, states, t]
  );

  const startPolling = useCallback(
    (file: AuthFileItem, provider: OAuthProvider, state: string) => {
      clearPollingTimer(file.name);

      const timer = setInterval(async () => {
        try {
          const response = await oauthApi.getAuthStatus(state);
          if (response.status === 'ok') {
            clearPollingTimer(file.name);
            setStates((prev) => ({
              ...prev,
              [file.name]: { ...(prev[file.name] ?? { provider }), provider, status: 'success' },
            }));
            await loadFiles();
            await onReauthHistoryChanged?.(file.name);
            showNotification(
              t('auth_files.reauth_success', {
                defaultValue: 'Re-authenticated "{{name}}" successfully',
                name: file.name,
              }),
              'success'
            );
            return;
          }

          if (response.status === 'cancelled') {
            clearPollingTimer(file.name);
            setStates((prev) => {
              const next = { ...prev };
              delete next[file.name];
              return next;
            });
            showNotification(
              response.error?.trim() ||
                t('auth_files.reauth_cancelled', {
                  defaultValue: 'Re-authentication cancelled. Current auth file was kept.',
                }),
              'info'
            );
            return;
          }

          if (response.status === 'error') {
            clearPollingTimer(file.name);
            const failureMessage = response.error?.trim() || '';
            setStates((prev) => ({
              ...prev,
              [file.name]: {
                ...(prev[file.name] ?? { provider }),
                provider,
                status: 'error',
                error: failureMessage,
              },
            }));
            showNotification(
              t('auth_files.reauth_failed', {
                defaultValue: 'Failed to re-authenticate "{{name}}"',
                name: file.name,
              }) + (failureMessage ? `: ${failureMessage}` : ''),
              'error'
            );
            await onReauthHistoryChanged?.(file.name);
          }
        } catch (error: unknown) {
          clearPollingTimer(file.name);
          const errorMessage = error instanceof Error ? error.message : '';
          setStates((prev) => ({
            ...prev,
            [file.name]: {
              ...(prev[file.name] ?? { provider }),
              provider,
              status: 'error',
              error: errorMessage,
            },
          }));
          showNotification(
            t('auth_files.reauth_failed', {
              defaultValue: 'Failed to re-authenticate "{{name}}"',
              name: file.name,
            }) + (errorMessage ? `: ${errorMessage}` : ''),
            'error'
          );
          await onReauthHistoryChanged?.(file.name);
        }
      }, 3000);

      pollingTimersRef.current[file.name] = timer;
    },
    [clearPollingTimer, loadFiles, onReauthHistoryChanged, showNotification, t]
  );

  const cancelReauth = useCallback(
    async (fileName: string) => {
      clearPollingTimer(fileName);
      const state = states[fileName]?.state;
      if (state) {
        try {
          const response = await oauthApi.cancelAuth(state);
          if (!isOAuthCancelSuccessful(response)) {
            const failureMessage = response.error?.trim() || '';
            showNotification(
              t('auth_files.reauth_cancel_failed', {
                defaultValue: 'Failed to cancel re-authentication',
              }) + (failureMessage ? `: ${failureMessage}` : ''),
              'error'
            );
            return;
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : '';
          showNotification(
            t('auth_files.reauth_cancel_failed', {
              defaultValue: 'Failed to cancel re-authentication',
            }) + (errorMessage ? `: ${errorMessage}` : ''),
            'error'
          );
          return;
        }
      }

      setStates((prev) => {
        const next = { ...prev };
        delete next[fileName];
        return next;
      });
      showNotification(
        t('auth_files.reauth_cancelled', {
          defaultValue: 'Re-authentication cancelled. Current auth file was kept.',
        }),
        'info'
      );
    },
    [clearPollingTimer, showNotification, states, t]
  );

  const updateReauthCallbackUrl = useCallback((fileName: string, callbackUrl: string) => {
    setStates((prev) => {
      const current = prev[fileName];
      if (!current) return prev;
      return {
        ...prev,
        [fileName]: {
          ...current,
          callbackUrl,
          callbackStatus: undefined,
          callbackError: undefined,
        },
      };
    });
  }, []);

  const submitReauthCallback = useCallback(
    async (fileName: string) => {
      const current = states[fileName];
      if (!current || !supportsAuthFileReauthCallback(current.provider)) return;

      const redirectUrl = (current.callbackUrl || '').trim();
      if (!redirectUrl) {
        showNotification(t('auth_login.oauth_callback_required'), 'warning');
        return;
      }

      setStates((prev) => {
        const existing = prev[fileName];
        if (!existing) return prev;
        return {
          ...prev,
          [fileName]: {
            ...existing,
            callbackSubmitting: true,
            callbackStatus: undefined,
            callbackError: undefined,
          },
        };
      });

      try {
        await oauthApi.submitCallback(current.provider, redirectUrl);
        setStates((prev) => {
          const existing = prev[fileName];
          if (!existing) return prev;
          return {
            ...prev,
            [fileName]: {
              ...existing,
              callbackSubmitting: false,
              callbackStatus: 'success',
              callbackError: undefined,
            },
          };
        });
        showNotification(t('auth_login.oauth_callback_success'), 'success');
      } catch (error: unknown) {
        const status = getErrorStatus(error);
        const message = getErrorMessage(error);
        const errorMessage =
          status === 404
            ? t('auth_login.oauth_callback_upgrade_hint', {
                defaultValue: 'Please update CLI Proxy API or check the connection.',
              })
            : message || undefined;

        setStates((prev) => {
          const existing = prev[fileName];
          if (!existing) return prev;
          return {
            ...prev,
            [fileName]: {
              ...existing,
              callbackSubmitting: false,
              callbackStatus: 'error',
              callbackError: errorMessage,
            },
          };
        });

        const notificationMessage = errorMessage
          ? `${t('auth_login.oauth_callback_error')} ${errorMessage}`
          : t('auth_login.oauth_callback_error');
        showNotification(notificationMessage, 'error');
      }
    },
    [showNotification, states, t]
  );

  const actuallyStartReauth = useCallback(
    async (file: AuthFileItem) => {
      const provider = resolveAuthFileOAuthProvider(file);
      if (!provider) return;

      clearPollingTimer(file.name);
      setStates((prev) => ({
        ...prev,
        [file.name]: { provider, status: 'starting' },
      }));

      try {
        // gemini-cli 重认证需要 project_id 指向对应 GCP 项目；startAuth 内部只在
        // provider === 'gemini-cli' 时使用它，传给其它 provider 会被忽略，安全。
        const projectId =
          provider === 'gemini-cli' ? readGeminiProjectId(file) || undefined : undefined;
        const response = await oauthApi.startAuth(provider, {
          authName: file.name,
          projectId,
        });
        setStates((prev) => ({
          ...prev,
          [file.name]: {
            provider,
            status: 'polling',
            url: response.url,
            state: response.state,
            callbackUrl: '',
            callbackSubmitting: false,
            callbackStatus: undefined,
            callbackError: undefined,
          },
        }));
        if (response.state) {
          startPolling(file, provider, response.state);
        }
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : '';
        setStates((prev) => ({
          ...prev,
          [file.name]: {
            provider,
            status: 'error',
            error: errorMessage,
          },
        }));
        showNotification(
          t('auth_files.reauth_failed', {
            defaultValue: 'Failed to re-authenticate "{{name}}"',
            name: file.name,
          }) + (errorMessage ? `: ${errorMessage}` : ''),
          'error'
        );
      }
    },
    [clearPollingTimer, showNotification, startPolling, t]
  );

  const startReauth = useCallback(
    async (file: AuthFileItem) => {
      showConfirmation({
        title: t('auth_files.reauth_confirm_title', {
          defaultValue: 'Re-authenticate this account?',
        }),
        message: t('auth_files.reauth_confirm_message', {
          defaultValue:
            'The current auth file will stay unchanged until the new OAuth flow completes successfully. You can cancel at any time to keep the current account as-is.',
        }),
        confirmText: t('auth_files.reauth_confirm_action', {
          defaultValue: 'Continue',
        }),
        cancelText: t('common.cancel'),
        onConfirm: async () => {
          await actuallyStartReauth(file);
        },
      });
    },
    [actuallyStartReauth, showConfirmation, t]
  );

  return {
    reauthStates: states,
    startReauth,
    copyReauthLink,
    cancelReauth,
    updateReauthCallbackUrl,
    submitReauthCallback,
  };
}
