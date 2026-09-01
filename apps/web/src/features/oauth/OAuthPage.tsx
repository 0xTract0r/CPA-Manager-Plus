import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useAuthStore, useNotificationStore, useThemeStore } from '@/stores';
import {
  oauthApi,
  pluginsApi,
  isOAuthCancelSuccessful,
  type BuiltInOAuthProvider,
  type OAuthProvider,
  type OAuthStatusResponse,
} from '@/services/api';
import { authFilesApi } from '@/services/api/authFiles';
import type { AuthFileItem } from '@/types/authFile';
import { vertexApi, type VertexImportResponse } from '@/services/api/vertex';
import { copyToClipboard } from '@/utils/clipboard';
import { runProxyPreflight } from '@/utils/proxyPreflight';
import type { PluginListEntry } from '@/types';
import { getPluginTitle, resolvePluginAssetURL } from '@/features/plugins/pluginResources';
import {
  resolvePluginOAuthProviderId,
  shouldShowPluginOAuthProvider,
} from './oauthProviderHelpers';
import styles from './OAuthPage.module.scss';
import iconCodex from '@/assets/icons/codex.svg';
import iconClaude from '@/assets/icons/claude.svg';
import iconAntigravity from '@/assets/icons/antigravity.svg';
import iconKimiLight from '@/assets/icons/kimi-light.svg';
import iconKimiDark from '@/assets/icons/kimi-dark.svg';
import iconVertex from '@/assets/icons/vertex.svg';
import iconGrok from '@/assets/icons/grok.svg';
import iconGrokDark from '@/assets/icons/grok-dark.svg';

type OAuthFlowStep = 'generate_link' | 'wait_callback' | 'submit_callback' | 'exchange_token' | 'saved';

interface OAuthSuccessResult {
  authFile?: string;
  account?: string;
  note?: string;
  proxyUrl?: string;
}

interface ProviderState {
  url?: string;
  state?: string;
  status?: 'idle' | 'starting' | 'waiting' | 'success' | 'cancelled' | 'error';
  error?: string;
  polling?: boolean;
  cancelling?: boolean;
  accountNote?: string;
  proxyUrl?: string;
  proxyUrlError?: string;
  /** 起 OAuth 前的连通性探针进行中标志（禁用按钮，防重复点）。 */
  proxyProbing?: boolean;
  /** 连通性探针通过后返回的出口 IP，用于就地展示。 */
  proxyExitIp?: string;
  savedProxyUrl?: string;
  expiresAtMs?: number;
  expiresInSeconds?: number;
  callbackUrl?: string;
  callbackSubmitting?: boolean;
  callbackStatus?: 'success' | 'error';
  callbackError?: string;
  authFilesBeforeStart?: string[];
  successResult?: OAuthSuccessResult;
}

interface VertexImportResult {
  projectId?: string;
  email?: string;
  location?: string;
  authFile?: string;
}

interface VertexImportState {
  file?: File;
  fileName: string;
  location: string;
  loading: boolean;
  error?: string;
  result?: VertexImportResult;
}

interface BuiltInProviderDefinition {
  id: BuiltInOAuthProvider;
  titleKey: string;
  hintKey: string;
  urlLabelKey: string;
  icon: string | { light: string; dark: string };
}

interface OAuthProviderDefinition {
  id: OAuthProvider;
  title: string;
  hint: string;
  urlLabel: string;
  icon?: string | { light: string; dark: string };
  supportsCallback: boolean;
  isPlugin: boolean;
}

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

const BUILT_IN_PROVIDERS: BuiltInProviderDefinition[] = [
  {
    id: 'codex',
    titleKey: 'auth_login.codex_oauth_title',
    hintKey: 'auth_login.codex_oauth_hint',
    urlLabelKey: 'auth_login.codex_oauth_url_label',
    icon: iconCodex,
  },
  {
    id: 'anthropic',
    titleKey: 'auth_login.anthropic_oauth_title',
    hintKey: 'auth_login.anthropic_oauth_hint',
    urlLabelKey: 'auth_login.anthropic_oauth_url_label',
    icon: iconClaude,
  },
  {
    id: 'antigravity',
    titleKey: 'auth_login.antigravity_oauth_title',
    hintKey: 'auth_login.antigravity_oauth_hint',
    urlLabelKey: 'auth_login.antigravity_oauth_url_label',
    icon: iconAntigravity,
  },
  {
    id: 'kimi',
    titleKey: 'auth_login.kimi_oauth_title',
    hintKey: 'auth_login.kimi_oauth_hint',
    urlLabelKey: 'auth_login.kimi_oauth_url_label',
    icon: { light: iconKimiLight, dark: iconKimiDark },
  },
  {
    id: 'xai',
    titleKey: 'auth_login.xai_oauth_title',
    hintKey: 'auth_login.xai_oauth_hint',
    urlLabelKey: 'auth_login.xai_oauth_url_label',
    icon: { light: iconGrok, dark: iconGrokDark },
  },
];

const BUILT_IN_PROVIDER_IDS = new Set<string>(BUILT_IN_PROVIDERS.map((provider) => provider.id));

const CALLBACK_SUPPORTED = new Set<string>([
  'codex',
  'anthropic',
  'antigravity',
  'xai',
]);
const XAI_CALLBACK_URL = 'http://127.0.0.1:56121/callback';
const getProviderI18nPrefix = (provider: BuiltInOAuthProvider) => provider.replace('-', '_');
const getAuthKey = (provider: BuiltInOAuthProvider, suffix: string) =>
  `auth_login.${getProviderI18nPrefix(provider)}_${suffix}`;

const getIcon = (icon: string | { light: string; dark: string }, theme: 'light' | 'dark') => {
  return typeof icon === 'string' ? icon : icon[theme];
};

interface FingerprintPreset {
  profile: string;
  tls: string;
  headers: string;
}

// 登录前请求身份预览：仅 core 里真实存在的三个原生指纹预设为“UI 快照”。
// 其余 provider（含 antigravity/kimi/xai 及插件 provider）后端不存在硬编码指纹，
// 统一显示 provider-default，避免展示杜撰值。真实身份是 per-account、账号创建后由 core 生成。
const FINGERPRINT_PRESETS: Record<string, FingerprintPreset> = {
  codex: {
    profile: 'codex_rustls_native_v1',
    tls: 'codex_rustls_native_v1',
    headers: 'Codex CLI native request identity',
  },
  anthropic: {
    profile: 'claude_cli_clienthello_v1',
    tls: 'claude_cli_clienthello_v1',
    headers: 'Claude Code managed headers',
  },
  'gemini-cli': {
    profile: 'gemini_cli_native_v1',
    tls: 'gemini_cli_native_v1',
    headers: 'Gemini CLI native request identity',
  },
};

const PROVIDER_DEFAULT_FINGERPRINT: FingerprintPreset = {
  profile: 'provider-default',
  tls: 'provider-default',
  headers: 'Provider OAuth defaults with account proxy isolation',
};

const getFingerprintPreset = (provider: OAuthProvider): FingerprintPreset =>
  FINGERPRINT_PRESETS[provider] ?? PROVIDER_DEFAULT_FINGERPRINT;

const formatDuration = (seconds: number) => {
  const safe = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

// 从 core 返回的过期字段推导授权链接的绝对到期时间戳（ms）。
// 优先用 expires_at 的绝对时间；否则用 expires_in_seconds 相对当前时间换算。
// 放在组件外的纯模块函数里，避免在组件渲染作用域内直接调用 Date.now()。
const resolveExpiresAtMs = (
  expiresAt?: string,
  expiresInSeconds?: number
): number | undefined => {
  const parsedExpiresAt = expiresAt ? Date.parse(expiresAt) : NaN;
  if (Number.isFinite(parsedExpiresAt)) return parsedExpiresAt;
  if (expiresInSeconds && Number.isFinite(expiresInSeconds)) {
    return Date.now() + expiresInSeconds * 1000;
  }
  return undefined;
};

const validateProxyUrl = (value: string, requiredMessage: string, invalidMessage: string): string | undefined => {
  const trimmed = value.trim();
  if (!trimmed) {
    return requiredMessage;
  }
  try {
    const parsed = new URL(trimmed);
    if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(parsed.protocol) || !parsed.host) {
      return invalidMessage;
    }
    return undefined;
  } catch {
    return invalidMessage;
  }
};

const OAUTH_FLOW_STEPS: OAuthFlowStep[] = [
  'generate_link',
  'wait_callback',
  'submit_callback',
  'exchange_token',
  'saved',
];

const getOAuthFlowStep = (state: ProviderState, supportsCallback: boolean): OAuthFlowStep => {
  if (state.status === 'success') return 'saved';
  if (!supportsCallback) {
    // 无回调提交步骤的 provider（例如插件 OAuth）跳过 submit_callback / exchange_token 展示。
    if (state.status === 'waiting') return 'wait_callback';
    return 'generate_link';
  }
  if (state.callbackStatus === 'success' && state.status === 'waiting') return 'exchange_token';
  if (state.callbackSubmitting) return 'submit_callback';
  if (state.status === 'waiting') return 'wait_callback';
  return 'generate_link';
};

const isAbsoluteUrl = (value: string): boolean => {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
};

const readQueryLikeCallbackInput = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const queryStart = trimmed.indexOf('?');
  const hashStart = trimmed.indexOf('#');
  const rawParams =
    queryStart >= 0
      ? trimmed.slice(queryStart + 1)
      : hashStart >= 0
        ? trimmed.slice(hashStart + 1)
        : trimmed;

  if (!/(^|[&#?])(code|state|error)=/i.test(rawParams)) return null;
  return new URLSearchParams(rawParams.replace(/^[?#]/, ''));
};

const extractDisplayedXaiCode = (value: string): string => {
  const trimmed = value.trim();
  const codeMatch = trimmed.match(/\bcode\s*[:=]\s*([^\s&]+)/i);
  return (codeMatch?.[1] ?? trimmed).trim();
};

const buildXaiCallbackUrl = (input: string, state?: string): string | null => {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (isAbsoluteUrl(trimmed)) return trimmed;

  const params = readQueryLikeCallbackInput(trimmed);
  if (params) {
    const code = params.get('code')?.trim();
    const error = params.get('error')?.trim();
    const errorDescription = params.get('error_description')?.trim();
    const callbackState = params.get('state')?.trim() || state?.trim();
    if (!callbackState) return null;

    const callbackUrl = new URL(XAI_CALLBACK_URL);
    callbackUrl.searchParams.set('state', callbackState);
    if (code) callbackUrl.searchParams.set('code', code);
    if (error) callbackUrl.searchParams.set('error', error);
    if (errorDescription) callbackUrl.searchParams.set('error_description', errorDescription);
    return callbackUrl.toString();
  }

  const code = extractDisplayedXaiCode(trimmed);
  const callbackState = state?.trim();
  if (!code || !callbackState) return null;

  const callbackUrl = new URL(XAI_CALLBACK_URL);
  callbackUrl.searchParams.set('code', code);
  callbackUrl.searchParams.set('state', callbackState);
  return callbackUrl.toString();
};

const resolveCallbackUrl = (
  provider: OAuthProvider,
  input: string,
  state?: string
): string | null => {
  if (provider !== 'xai') return input.trim();
  return buildXaiCallbackUrl(input, state);
};

// 迁移自旧版 apps/web OAuthPage：按 provider 匹配认证文件，用于成功后展示落地文件与账号信息。
const PROVIDER_MATCHERS: Record<string, string[]> = {
  codex: ['codex', 'openai'],
  anthropic: ['anthropic', 'claude'],
  antigravity: ['antigravity'],
  kimi: ['kimi'],
  xai: ['xai', 'grok'],
};

const normalizeComparable = (value: string) => value.trim().toLowerCase().replace(/[_\s]/g, '-');

const readStringField = (record: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
};

const getAuthFileModifiedMs = (entry: AuthFileItem) => {
  const record = entry as Record<string, unknown>;
  const raw = record.modified ?? record.modtime ?? record.updated_at ?? record.created_at;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};

const matchesAuthFileProvider = (entry: AuthFileItem, provider: OAuthProvider) => {
  const matchers = PROVIDER_MATCHERS[provider];
  if (!matchers) return false;
  const record = entry as Record<string, unknown>;
  const haystack = [
    entry.provider,
    entry.type,
    readStringField(record, ['account_type', 'oauth_provider']),
    entry.name,
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map(normalizeComparable);
  const needles = matchers.map(normalizeComparable);
  return needles.some((needle) => haystack.some((value) => value.includes(needle)));
};

const getAuthFileAccount = (entry?: AuthFileItem) => {
  if (!entry) return undefined;
  const record = entry as Record<string, unknown>;
  return readStringField(record, [
    'email',
    'account',
    'account_email',
    'user_email',
    'username',
    'login',
    'project_id',
    'chatgpt_account_id',
    'account_id',
  ]);
};

const findSavedAuthFile = (
  provider: OAuthProvider,
  authFileName: string | undefined,
  beforeNames: string[] | undefined,
  files: AuthFileItem[]
): AuthFileItem | undefined => {
  if (authFileName) {
    const exact = files.find((entry) => entry.name === authFileName);
    if (exact) return exact;
  }
  const before = new Set(beforeNames ?? []);
  const candidates = files
    .filter((entry) => matchesAuthFileProvider(entry, provider))
    .sort((left, right) => getAuthFileModifiedMs(right) - getAuthFileModifiedMs(left));
  return candidates.find((entry) => !before.has(entry.name)) ?? candidates[0];
};

export function OAuthPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { showNotification } = useNotificationStore();
  const resolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const apiBase = useAuthStore((state) => state.apiBase);
  const supportsPlugin = useAuthStore((state) => state.supportsPlugin);
  const pluginOAuthAvailable = connectionStatus === 'connected' && supportsPlugin;
  const [states, setStates] = useState<Record<string, ProviderState>>({});
  // 选中的登录选项卡：provider id 或 'vertex'（一次只显示/登录一个）。
  const [activeTab, setActiveTab] = useState<string>('codex');
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [pluginOAuthPlugins, setPluginOAuthPlugins] = useState<PluginListEntry[]>([]);
  const [vertexState, setVertexState] = useState<VertexImportState>({
    fileName: '',
    location: '',
    loading: false,
  });
  const pollingTimers = useRef<Partial<Record<string, number>>>({});
  const statesRef = useRef(states);
  const vertexFileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    statesRef.current = states;
  }, [states]);

  const providers = useMemo<OAuthProviderDefinition[]>(() => {
    const builtIn = BUILT_IN_PROVIDERS.map((provider) => ({
      id: provider.id,
      title: t(provider.titleKey),
      hint: t(provider.hintKey),
      urlLabel: t(provider.urlLabelKey),
      icon: provider.icon,
      supportsCallback: CALLBACK_SUPPORTED.has(provider.id),
      isPlugin: false,
    }));
    const pluginProviders = pluginOAuthAvailable
      ? pluginOAuthPlugins
          .filter((plugin) => shouldShowPluginOAuthProvider(plugin, BUILT_IN_PROVIDER_IDS))
          .map((plugin) => {
            const title = getPluginTitle(plugin);
            const logo = resolvePluginAssetURL(plugin.logo || plugin.metadata?.logo || '', apiBase);
            return {
              id: resolvePluginOAuthProviderId(plugin),
              title,
              hint: t('auth_login.plugin_oauth_hint', { plugin: title }),
              urlLabel: t('auth_login.plugin_oauth_url_label'),
              icon: logo || undefined,
              supportsCallback: false,
              isPlugin: true,
            };
          })
      : [];
    return [...builtIn, ...pluginProviders];
  }, [apiBase, pluginOAuthAvailable, pluginOAuthPlugins, t]);

  // 选项卡有效性守卫在渲染期解析：若当前选中的 provider tab 因插件列表变化而消失，
  // 直接回退到第一个内建 provider（不写 state，避免 effect 级联渲染）。
  const activeProvider =
    activeTab === 'vertex'
      ? undefined
      : (providers.find((provider) => provider.id === activeTab) ?? providers[0]);
  // 高亮判定：vertex 精确匹配；provider tab 命中当前有效 provider（含回退后的默认项）。
  const resolvedTabId = activeTab === 'vertex' ? 'vertex' : activeProvider?.id;

  const clearTimers = useCallback(() => {
    Object.values(pollingTimers.current).forEach((timer) => {
      if (timer !== undefined) window.clearInterval(timer);
    });
    pollingTimers.current = {};
  }, []);

  useEffect(() => {
    return () => {
      clearTimers();
    };
  }, [clearTimers]);

  // 授权链接倒计时：仅当存在等待中的、带过期时间的授权链接时才每秒 tick。
  useEffect(() => {
    const hasActiveCountdown = Object.values(states).some(
      (state) => state.url && state.status === 'waiting' && state.expiresAtMs
    );
    if (!hasActiveCountdown) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [states]);

  useEffect(() => {
    if (!pluginOAuthAvailable) return;

    let cancelled = false;
    pluginsApi
      .list()
      .then((response) => {
        if (cancelled) return;
        setPluginOAuthPlugins(response.plugins.filter((plugin) => plugin.supportsOAuth));
      })
      .catch(() => {
        if (cancelled) return;
        setPluginOAuthPlugins([]);
      });

    return () => {
      cancelled = true;
    };
  }, [apiBase, pluginOAuthAvailable]);

  const getProviderDefinition = useCallback(
    (provider: OAuthProvider) => providers.find((item) => item.id === provider),
    [providers]
  );

  const getProviderActionText = useCallback(
    (provider: OAuthProvider, suffix: string) => {
      const definition = getProviderDefinition(provider);
      if (!definition?.isPlugin && BUILT_IN_PROVIDER_IDS.has(provider)) {
        return t(getAuthKey(provider as BuiltInOAuthProvider, suffix));
      }
      return t(`auth_login.plugin_${suffix}`, {
        plugin: definition?.title || provider,
      });
    },
    [getProviderDefinition, t]
  );

  const updateProviderState = (provider: OAuthProvider, next: Partial<ProviderState>) => {
    setStates((prev) => ({
      ...prev,
      [provider]: { ...(prev[provider] ?? {}), ...next },
    }));
  };

  const clearPollingTimer = (provider: OAuthProvider) => {
    const timer = pollingTimers.current[provider];
    if (timer !== undefined) {
      window.clearInterval(timer);
      delete pollingTimers.current[provider];
    }
  };

  const resetProviderAttempt = (provider: OAuthProvider) => {
    clearPollingTimer(provider);
    setStates((prev) => ({
      ...prev,
      [provider]: {},
    }));
  };

  const resolveOAuthSuccessResult = async (
    provider: OAuthProvider,
    current: ProviderState,
    response: OAuthStatusResponse
  ): Promise<OAuthSuccessResult> => {
    const authFileFromStatus = response.auth_name || response.saved_path;
    let matchedFile: AuthFileItem | undefined;
    try {
      const filesResponse = await authFilesApi.list();
      matchedFile = findSavedAuthFile(
        provider,
        authFileFromStatus,
        current.authFilesBeforeStart,
        filesResponse.files || []
      );
    } catch {
      matchedFile = undefined;
    }

    return {
      authFile: authFileFromStatus || matchedFile?.name,
      account: getAuthFileAccount(matchedFile),
      note: response.note || (current.accountNote || '').trim() || undefined,
      proxyUrl: response.proxy_url || (current.proxyUrl || '').trim() || undefined,
    };
  };

  const completeProviderAuth = async (provider: OAuthProvider, response: OAuthStatusResponse) => {
    clearPollingTimer(provider);
    const current = statesRef.current[provider] ?? {};
    const successResult = await resolveOAuthSuccessResult(provider, current, response);
    setStates((prev) => {
      const latest = prev[provider] ?? {};
      return {
        ...prev,
        [provider]: {
          ...latest,
          url: undefined,
          state: undefined,
          status: 'success',
          error: undefined,
          polling: false,
          cancelling: false,
          savedProxyUrl: successResult.proxyUrl,
          callbackUrl: '',
          callbackSubmitting: false,
          callbackStatus: undefined,
          callbackError: undefined,
          successResult,
        },
      };
    });
  };

  const startPolling = (provider: OAuthProvider, state: string) => {
    clearPollingTimer(provider);
    const timer = window.setInterval(async () => {
      try {
        const res = await oauthApi.getAuthStatus(state);
        if (res.status === 'ok') {
          window.clearInterval(timer);
          delete pollingTimers.current[provider];
          await completeProviderAuth(provider, res);
          showNotification(getProviderActionText(provider, 'oauth_status_success'), 'success');
        } else if (res.status === 'cancelled') {
          const cancelledMessage =
            res.error?.trim() ||
            t('auth_login.oauth_status_cancelled', {
              defaultValue: '认证已取消，可重新开始。',
            });
          updateProviderState(provider, {
            status: 'cancelled',
            error: cancelledMessage,
            polling: false,
            cancelling: false,
            url: undefined,
            state: undefined,
          });
          showNotification(cancelledMessage, 'info');
          window.clearInterval(timer);
          delete pollingTimers.current[provider];
        } else if (res.status === 'error') {
          updateProviderState(provider, { status: 'error', error: res.error, polling: false, cancelling: false });
          showNotification(
            `${getProviderActionText(provider, 'oauth_status_error')} ${res.error || ''}`,
            'error'
          );
          window.clearInterval(timer);
          delete pollingTimers.current[provider];
        }
      } catch (err: unknown) {
        updateProviderState(provider, {
          status: 'error',
          error: getErrorMessage(err),
          polling: false,
          cancelling: false,
        });
        window.clearInterval(timer);
        delete pollingTimers.current[provider];
      }
    }, 3000);
    pollingTimers.current[provider] = timer;
  };

  const startAuth = async (provider: OAuthProvider) => {
    const current = states[provider] || {};
    const proxyUrl = (current.proxyUrl || '').trim();
    const proxyUrlError = validateProxyUrl(
      proxyUrl,
      t('auth_login.account_proxy_required'),
      t('auth_login.account_proxy_invalid')
    );
    if (proxyUrlError) {
      updateProviderState(provider, { proxyUrlError });
      showNotification(proxyUrlError, 'warning');
      return;
    }
    // 格式过后、真正起 OAuth 前，先做后端连通性探针：不通就不进入 OAuth（fail-closed），
    // 通了则展示出口 IP 再继续。探测期间置 proxyProbing，禁用登录按钮防重复点。
    updateProviderState(provider, {
      proxyProbing: true,
      proxyUrlError: undefined,
      proxyExitIp: undefined,
    });
    const preflight = await runProxyPreflight(proxyUrl, {
      formatValidator: () => ({ valid: true }),
      translate: (reason) => t(`proxy_preflight.reason_${reason}`),
    });
    if (!preflight.ok) {
      updateProviderState(provider, {
        proxyProbing: false,
        proxyUrlError: preflight.message,
      });
      showNotification(preflight.message, 'error');
      return;
    }
    updateProviderState(provider, { proxyProbing: false, proxyExitIp: preflight.exitIp });
    showNotification(
      t('proxy_preflight.connected_with_ip', { ip: preflight.exitIp }),
      'success'
    );
    clearPollingTimer(provider);
    updateProviderState(provider, {
      url: undefined,
      state: undefined,
      status: 'starting',
      polling: true,
      cancelling: false,
      error: undefined,
      proxyUrlError: undefined,
      savedProxyUrl: undefined,
      expiresAtMs: undefined,
      expiresInSeconds: undefined,
      callbackStatus: undefined,
      callbackError: undefined,
      callbackUrl: '',
      authFilesBeforeStart: undefined,
      successResult: undefined,
    });
    try {
      let authFilesBeforeStart: string[] | undefined;
      try {
        const filesResponse = await authFilesApi.list();
        authFilesBeforeStart = (filesResponse.files || []).map((file) => file.name);
        updateProviderState(provider, { authFilesBeforeStart });
      } catch {
        authFilesBeforeStart = undefined;
      }
      const res = await oauthApi.startAuth(provider, {
        note: (current.accountNote || '').trim() || undefined,
        proxyUrl: proxyUrl || undefined,
      });
      if (!res.state) {
        const message = t('auth_login.missing_state');
        updateProviderState(provider, {
          url: res.url,
          state: undefined,
          status: 'error',
          error: message,
          polling: false,
        });
        showNotification(message, 'error');
        return;
      }
      const expiresInSeconds = Number.isFinite(res.expires_in_seconds)
        ? Number(res.expires_in_seconds)
        : undefined;
      const expiresAtMs = resolveExpiresAtMs(res.expires_at, expiresInSeconds);
      updateProviderState(provider, {
        url: res.url,
        state: res.state,
        status: 'waiting',
        polling: true,
        expiresAtMs,
        expiresInSeconds,
      });
      startPolling(provider, res.state);
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      updateProviderState(provider, { status: 'error', error: message, polling: false });
      showNotification(
        `${getProviderActionText(provider, 'oauth_start_error')}${message ? ` ${message}` : ''}`,
        'error'
      );
    }
  };

  const cancelAuth = async (provider: OAuthProvider) => {
    const state = states[provider]?.state;
    if (!state) {
      resetProviderAttempt(provider);
      return;
    }
    updateProviderState(provider, { cancelling: true });
    try {
      const res = await oauthApi.cancelAuth(state);
      clearPollingTimer(provider);
      if (isOAuthCancelSuccessful(res)) {
        updateProviderState(provider, {
          status: 'cancelled',
          error: t('auth_login.oauth_status_cancelled', {
            defaultValue: '认证已取消，可重新开始。',
          }),
          polling: false,
          cancelling: false,
          url: undefined,
          state: undefined,
        });
      } else {
        updateProviderState(provider, {
          cancelling: false,
          error: res.error || t('auth_login.oauth_cancel_error', { defaultValue: '取消登录失败' }),
        });
        showNotification(
          res.error || t('auth_login.oauth_cancel_error', { defaultValue: '取消登录失败' }),
          'error'
        );
      }
    } catch (err: unknown) {
      updateProviderState(provider, { cancelling: false });
      showNotification(
        getErrorMessage(err) || t('auth_login.oauth_cancel_error', { defaultValue: '取消登录失败' }),
        'error'
      );
    }
  };

  const copyLink = async (url?: string) => {
    if (!url) return;
    const copied = await copyToClipboard(url);
    showNotification(
      t(copied ? 'notification.link_copied' : 'notification.copy_failed'),
      copied ? 'success' : 'error'
    );
  };

  const submitCallback = async (provider: OAuthProvider) => {
    const callbackInput = (states[provider]?.callbackUrl || '').trim();
    if (!callbackInput) {
      showNotification(
        t(
          provider === 'xai'
            ? 'auth_login.xai_callback_required'
            : 'auth_login.oauth_callback_required'
        ),
        'warning'
      );
      return;
    }
    const redirectUrl = resolveCallbackUrl(provider, callbackInput, states[provider]?.state);
    if (!redirectUrl) {
      showNotification(
        t(
          provider === 'xai' ? 'auth_login.xai_callback_state_missing' : 'auth_login.missing_state'
        ),
        'warning'
      );
      return;
    }
    updateProviderState(provider, {
      callbackSubmitting: true,
      callbackStatus: undefined,
      callbackError: undefined,
    });
    try {
      await oauthApi.submitCallback(provider, redirectUrl);
      updateProviderState(provider, { callbackSubmitting: false, callbackStatus: 'success' });
      showNotification(t('auth_login.oauth_callback_success'), 'success');
    } catch (err: unknown) {
      const status = getErrorStatus(err);
      const message = getErrorMessage(err);
      const errorMessage =
        status === 404
          ? t('auth_login.oauth_callback_upgrade_hint', {
              defaultValue: 'Please update CLI Proxy API or check the connection.',
            })
          : message || undefined;
      updateProviderState(provider, {
        callbackSubmitting: false,
        callbackStatus: 'error',
        callbackError: errorMessage,
      });
      const notificationMessage = errorMessage
        ? `${t('auth_login.oauth_callback_error')} ${errorMessage}`
        : t('auth_login.oauth_callback_error');
      showNotification(notificationMessage, 'error');
    }
  };

  const handleVertexFilePick = () => {
    vertexFileInputRef.current?.click();
  };

  const handleVertexFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.name.endsWith('.json')) {
      showNotification(t('vertex_import.file_required'), 'warning');
      event.target.value = '';
      return;
    }
    setVertexState((prev) => ({
      ...prev,
      file,
      fileName: file.name,
      error: undefined,
      result: undefined,
    }));
    event.target.value = '';
  };

  const handleVertexImport = async () => {
    if (!vertexState.file) {
      const message = t('vertex_import.file_required');
      setVertexState((prev) => ({ ...prev, error: message }));
      showNotification(message, 'warning');
      return;
    }
    const location = vertexState.location.trim();
    setVertexState((prev) => ({ ...prev, loading: true, error: undefined, result: undefined }));
    try {
      const res: VertexImportResponse = await vertexApi.importCredential(
        vertexState.file,
        location || undefined
      );
      const result: VertexImportResult = {
        projectId: res.project_id,
        email: res.email,
        location: res.location,
        authFile: res['auth-file'] ?? res.auth_file,
      };
      setVertexState((prev) => ({ ...prev, loading: false, result }));
      showNotification(t('vertex_import.success'), 'success');
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      setVertexState((prev) => ({
        ...prev,
        loading: false,
        error: message || t('notification.upload_failed'),
      }));
      const notification = message
        ? `${t('notification.upload_failed')}: ${message}`
        : t('notification.upload_failed');
      showNotification(notification, 'error');
    }
  };

  const renderProviderCard = (provider: OAuthProviderDefinition) => {
          const state = states[provider.id] || {};
          const canSubmitCallback =
            provider.supportsCallback && Boolean(state.url) && state.status !== 'cancelled';
          const loginButtonLabel =
            state.status === 'success'
              ? t('auth_login.login_another_account')
              : getProviderActionText(provider.id, 'oauth_button');
          const statusBadgeClassName = [
            'status-badge',
            state.status === 'success' ? 'success' : '',
            state.status === 'error' ? 'error' : '',
          ]
            .filter(Boolean)
            .join(' ');
          const flowStep = getOAuthFlowStep(state, provider.supportsCallback);
          const flowStepIndex = OAUTH_FLOW_STEPS.indexOf(flowStep);
          const showFlowSteps = Boolean(state.status) && state.status !== 'idle' && state.status !== 'cancelled';
          const canCancel =
            (state.status === 'starting' || state.status === 'waiting') && Boolean(state.state);
          return (
              <Card
                key={provider.id}
                title={
                  <span className={styles.cardTitle}>
                    {provider.icon ? (
                      <img
                        src={getIcon(provider.icon, resolvedTheme)}
                        alt=""
                        className={styles.cardTitleIcon}
                      />
                    ) : (
                      <span className={styles.pluginIconFallback} aria-hidden="true">
                        {provider.title.slice(0, 1).toUpperCase()}
                      </span>
                    )}
                    {provider.title}
                  </span>
                }
                extra={
                  <Button
                    onClick={() => startAuth(provider.id)}
                    loading={Boolean(state.polling) || Boolean(state.proxyProbing)}
                    disabled={Boolean(state.proxyProbing)}
                  >
                    {loginButtonLabel}
                  </Button>
                }
              >
                <div className={styles.cardContent}>
                  <div className={styles.cardHint}>{provider.hint}</div>
                  <div className={styles.accountSetupGrid}>
                    <Input
                      label={t('auth_login.account_note_label')}
                      value={state.accountNote || ''}
                      disabled={Boolean(state.polling)}
                      onChange={(e) =>
                        updateProviderState(provider.id, { accountNote: e.target.value })
                      }
                      placeholder={t('auth_login.account_note_placeholder')}
                    />
                    <Input
                      label={t('auth_login.account_proxy_label')}
                      hint={t('auth_login.account_proxy_hint')}
                      value={state.proxyUrl || ''}
                      error={state.proxyUrlError}
                      disabled={Boolean(state.polling) || Boolean(state.proxyProbing)}
                      onChange={(e) =>
                        updateProviderState(provider.id, {
                          proxyUrl: e.target.value,
                          proxyUrlError: undefined,
                          proxyExitIp: undefined,
                        })
                      }
                      placeholder={t('auth_login.account_proxy_placeholder')}
                    />
                  </div>
                  {state.proxyProbing && (
                    <div className={styles.connectionLabel}>{t('proxy_preflight.probing')}</div>
                  )}
                  {!state.proxyProbing && state.proxyExitIp && (
                    <div className={styles.connectionLabel}>
                      {t('proxy_preflight.connected_with_ip', { ip: state.proxyExitIp })}
                    </div>
                  )}
                  {(() => {
                    const fingerprint = getFingerprintPreset(provider.id);
                    return (
                      <div className={styles.fingerprintBox}>
                        <div className={styles.connectionLabel}>
                          {t('auth_login.fingerprint_snapshot_title')}
                        </div>
                        <div className={styles.keyValueList}>
                          <div className={styles.keyValueItem}>
                            <span className={styles.keyValueKey}>
                              {t('auth_login.fingerprint_profile')}
                            </span>
                            <span className={styles.keyValueValue}>{fingerprint.profile}</span>
                          </div>
                          <div className={styles.keyValueItem}>
                            <span className={styles.keyValueKey}>
                              {t('auth_login.fingerprint_tls')}
                            </span>
                            <span className={styles.keyValueValue}>{fingerprint.tls}</span>
                          </div>
                          <div className={styles.keyValueItem}>
                            <span className={styles.keyValueKey}>
                              {t('auth_login.fingerprint_headers')}
                            </span>
                            <span className={styles.keyValueValue}>{fingerprint.headers}</span>
                          </div>
                        </div>
                        <div className={styles.cardHintSecondary}>
                          {t('auth_login.fingerprint_snapshot_note')}
                        </div>
                      </div>
                    );
                  })()}
                  {showFlowSteps && (
                    <div className={styles.flowSteps}>
                      {OAUTH_FLOW_STEPS.map((step, index) => {
                        const isDone = state.status === 'success' || index < flowStepIndex;
                        const isActive = index === flowStepIndex && state.status !== 'success';
                        return (
                          <div
                            key={step}
                            className={`${styles.flowStep} ${isDone ? styles.flowStepDone : ''} ${isActive ? styles.flowStepActive : ''}`.trim()}
                          >
                            <span className={styles.flowStepDot} />
                            <span className={styles.flowStepLabel}>
                              {t(`auth_login.oauth_flow_${step}`)}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {state.url && (
                    <div className={styles.authUrlBox}>
                      <div className={styles.authUrlLabel}>{provider.urlLabel}</div>
                      {state.expiresAtMs && state.status === 'waiting' && (
                        <div className={styles.countdownBadge}>
                          {t('auth_login.oauth_countdown', {
                            time: formatDuration((state.expiresAtMs - nowMs) / 1000),
                          })}
                        </div>
                      )}
                      <div className={styles.authUrlValue}>{state.url}</div>
                      <div className={styles.cardHintSecondary}>
                        {t('auth_login.oauth_link_ready_hint')}
                      </div>
                      <div className={styles.authUrlActions}>
                        <Button variant="secondary" size="sm" onClick={() => copyLink(state.url!)}>
                          {getProviderActionText(provider.id, 'copy_link')}
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => window.open(state.url, '_blank', 'noopener,noreferrer')}
                        >
                          {getProviderActionText(provider.id, 'open_link')}
                        </Button>
                        {canCancel && (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => cancelAuth(provider.id)}
                            loading={state.cancelling}
                          >
                            {t('auth_login.oauth_cancel_button', { defaultValue: '取消本次登录' })}
                          </Button>
                        )}
                      </div>
                    </div>
                  )}
                  {canSubmitCallback && (
                    <div className={styles.callbackSection}>
                      <Input
                        label={t(
                          provider.id === 'xai'
                            ? 'auth_login.xai_callback_label'
                            : 'auth_login.oauth_callback_label'
                        )}
                        hint={t(
                          provider.id === 'xai'
                            ? 'auth_login.xai_callback_hint'
                            : 'auth_login.oauth_callback_hint'
                        )}
                        value={state.callbackUrl || ''}
                        onChange={(e) =>
                          updateProviderState(provider.id, {
                            callbackUrl: e.target.value,
                            callbackStatus: undefined,
                            callbackError: undefined,
                          })
                        }
                        placeholder={t(
                          provider.id === 'xai'
                            ? 'auth_login.xai_callback_placeholder'
                            : 'auth_login.oauth_callback_placeholder'
                        )}
                      />
                      <div className={styles.callbackActions}>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => submitCallback(provider.id)}
                          loading={state.callbackSubmitting}
                        >
                          {t('auth_login.oauth_callback_button')}
                        </Button>
                      </div>
                      {state.callbackStatus === 'success' && state.status === 'waiting' && (
                        <div className="status-badge success">
                          {t('auth_login.oauth_callback_status_success')}
                        </div>
                      )}
                      {state.callbackStatus === 'error' && (
                        <div className="status-badge error">
                          {t('auth_login.oauth_callback_status_error')} {state.callbackError || ''}
                        </div>
                      )}
                    </div>
                  )}
                  {state.status && state.status !== 'idle' && (
                    <div className={statusBadgeClassName}>
                      {state.status === 'success'
                        ? getProviderActionText(provider.id, 'oauth_status_success')
                        : state.status === 'cancelled'
                          ? state.error ||
                            t('auth_login.oauth_status_cancelled', {
                              defaultValue: '认证已取消，可重新开始。',
                            })
                          : state.status === 'error'
                            ? `${getProviderActionText(provider.id, 'oauth_status_error')} ${state.error || ''}`
                            : state.status === 'starting'
                              ? t('auth_login.oauth_status_starting', { defaultValue: '正在准备授权链接...' })
                              : getProviderActionText(provider.id, 'oauth_status_waiting')}
                    </div>
                  )}
                  {state.status === 'success' && state.successResult && (
                    <div className={styles.successResultBox}>
                      <div className={styles.connectionLabel}>
                        {t('auth_login.oauth_saved_result_title', { defaultValue: '登录成功' })}
                      </div>
                      <div className={styles.keyValueList}>
                        <div className={styles.keyValueItem}>
                          <span className={styles.keyValueKey}>
                            {t('auth_login.oauth_saved_auth_file', { defaultValue: '认证文件' })}
                          </span>
                          <span className={styles.keyValueValue}>
                            {state.successResult.authFile ||
                              t('auth_login.oauth_saved_auth_file_unknown', { defaultValue: '未知' })}
                          </span>
                        </div>
                        {state.successResult.account && (
                          <div className={styles.keyValueItem}>
                            <span className={styles.keyValueKey}>
                              {t('auth_login.oauth_saved_account', { defaultValue: '账号' })}
                            </span>
                            <span className={styles.keyValueValue}>{state.successResult.account}</span>
                          </div>
                        )}
                        {state.successResult.note && (
                          <div className={styles.keyValueItem}>
                            <span className={styles.keyValueKey}>
                              {t('auth_login.oauth_saved_note', { defaultValue: '备注' })}
                            </span>
                            <span className={styles.keyValueValue}>{state.successResult.note}</span>
                          </div>
                        )}
                        {state.successResult.proxyUrl && (
                          <div className={styles.keyValueItem}>
                            <span className={styles.keyValueKey}>
                              {t('auth_login.oauth_saved_proxy')}
                            </span>
                            <span className={styles.keyValueValue}>
                              {state.successResult.proxyUrl}
                            </span>
                          </div>
                        )}
                      </div>
                      <div className={styles.successActions}>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() =>
                            navigate('/auth-files', {
                              state: { highlightAuthFile: state.successResult?.authFile },
                            })
                          }
                        >
                          {t('auth_login.oauth_view_auth_file', { defaultValue: '查看认证文件' })}
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => resetProviderAttempt(provider.id)}
                        >
                          {t('auth_login.oauth_add_another', { defaultValue: '继续添加下一个账号' })}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              </Card>
          );
  };

  const renderVertexCard = () => (
        <Card
          title={
            <span className={styles.cardTitle}>
              <img src={iconVertex} alt="" className={styles.cardTitleIcon} />
              {t('vertex_import.title')}
            </span>
          }
          extra={
            <Button onClick={handleVertexImport} loading={vertexState.loading}>
              {t('vertex_import.import_button')}
            </Button>
          }
        >
          <div className={styles.cardContent}>
            <div className={styles.cardHint}>{t('vertex_import.description')}</div>
            <Input
              label={t('vertex_import.location_label')}
              hint={t('vertex_import.location_hint')}
              value={vertexState.location}
              onChange={(e) =>
                setVertexState((prev) => ({
                  ...prev,
                  location: e.target.value,
                }))
              }
              placeholder={t('vertex_import.location_placeholder')}
            />
            <div className={styles.formItem}>
              <label className={styles.formItemLabel}>{t('vertex_import.file_label')}</label>
              <div className={styles.filePicker}>
                <Button variant="secondary" size="sm" onClick={handleVertexFilePick}>
                  {t('vertex_import.choose_file')}
                </Button>
                <div
                  className={`${styles.fileName} ${
                    vertexState.fileName ? '' : styles.fileNamePlaceholder
                  }`.trim()}
                >
                  {vertexState.fileName || t('vertex_import.file_placeholder')}
                </div>
              </div>
              <div className={styles.cardHintSecondary}>{t('vertex_import.file_hint')}</div>
              <input
                ref={vertexFileInputRef}
                type="file"
                accept=".json,application/json"
                style={{ display: 'none' }}
                onChange={handleVertexFileChange}
              />
            </div>
            {vertexState.error && <div className="status-badge error">{vertexState.error}</div>}
            {vertexState.result && (
              <div className={styles.connectionBox}>
                <div className={styles.connectionLabel}>{t('vertex_import.result_title')}</div>
                <div className={styles.keyValueList}>
                  {vertexState.result.projectId && (
                    <div className={styles.keyValueItem}>
                      <span className={styles.keyValueKey}>
                        {t('vertex_import.result_project')}
                      </span>
                      <span className={styles.keyValueValue}>{vertexState.result.projectId}</span>
                    </div>
                  )}
                  {vertexState.result.email && (
                    <div className={styles.keyValueItem}>
                      <span className={styles.keyValueKey}>{t('vertex_import.result_email')}</span>
                      <span className={styles.keyValueValue}>{vertexState.result.email}</span>
                    </div>
                  )}
                  {vertexState.result.location && (
                    <div className={styles.keyValueItem}>
                      <span className={styles.keyValueKey}>
                        {t('vertex_import.result_location')}
                      </span>
                      <span className={styles.keyValueValue}>{vertexState.result.location}</span>
                    </div>
                  )}
                  {vertexState.result.authFile && (
                    <div className={styles.keyValueItem}>
                      <span className={styles.keyValueKey}>{t('vertex_import.result_file')}</span>
                      <span className={styles.keyValueValue}>{vertexState.result.authFile}</span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </Card>
  );

  return (
    <div className={styles.container}>
      <div className={styles.content}>
        <div className={styles.tabHeader}>
          <div className={styles.tabHeaderText}>
            <div className={styles.sectionTitle}>
              {t('auth_login.add_account_title', { defaultValue: '添加登录账号' })}
            </div>
            <div className={styles.cardHint}>
              {t('auth_login.add_account_hint', {
                defaultValue: '选择一个 provider，绑定账号备注和代理后，在同一流程内完成 OAuth。',
              })}
            </div>
          </div>
        </div>

        <div
          className={styles.providerTabs}
          role="tablist"
          aria-label={t('nav.oauth', { defaultValue: 'OAuth' })}
        >
          {providers.map((provider) => {
            const state = states[provider.id] || {};
            const selected = resolvedTabId === provider.id;
            return (
              <button
                key={provider.id}
                type="button"
                role="tab"
                aria-selected={selected}
                className={`${styles.providerTab} ${selected ? styles.providerTabActive : ''}`.trim()}
                onClick={() => setActiveTab(provider.id)}
                data-testid={`oauth-provider-tab-${provider.id}`}
              >
                {provider.icon ? (
                  <img
                    src={getIcon(provider.icon, resolvedTheme)}
                    alt=""
                    className={styles.providerTabIcon}
                  />
                ) : (
                  <span className={styles.providerTabIconFallback} aria-hidden="true">
                    {provider.title.slice(0, 1).toUpperCase()}
                  </span>
                )}
                <span className={styles.providerTabLabel}>{provider.title}</span>
                {state.status && state.status !== 'idle' && (
                  <span
                    className={`${styles.providerTabStatus} ${styles[`providerStatus${state.status}`] || ''}`.trim()}
                  />
                )}
              </button>
            );
          })}
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'vertex'}
            className={`${styles.providerTab} ${activeTab === 'vertex' ? styles.providerTabActive : ''}`.trim()}
            onClick={() => setActiveTab('vertex')}
            data-testid="oauth-provider-tab-vertex"
          >
            <img src={iconVertex} alt="" className={styles.providerTabIcon} />
            <span className={styles.providerTabLabel}>{t('vertex_import.title')}</span>
          </button>
        </div>

        {activeTab === 'vertex'
          ? renderVertexCard()
          : activeProvider
            ? renderProviderCard(activeProvider)
            : null}
      </div>
    </div>
  );
}
