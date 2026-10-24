import { authFilesApi } from '@/services/api/authFiles';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { AccountIdentity } from '@/components/ui/AccountIdentity';
import { Input } from '@/components/ui/Input';
import {
  publishAccountCredentialMutationRevision,
  useAuthStore,
  useNotificationStore,
  useThemeStore,
} from '@/stores';
import {
  oauthApi,
  pluginsApi,
  isOAuthCancelSuccessful,
  type BuiltInOAuthProvider,
  type OAuthProvider,
  type OAuthStatusResponse,
} from '@/services/api';
import type { AuthFileItem } from '@/types/authFile';
import { vertexApi, type VertexImportResponse } from '@/services/api/vertex';
import { copyToClipboard } from '@/utils/clipboard';
import { resolveAccountIdentity } from '@/utils/accountIdentity';
import { findAccountsUsingProxy } from '@/utils/proxyPreflight';
import {
  precheckProxyInlineFormat,
  runProxyInlineChecks,
  isProxyInlineValidatedOk,
  isProxyInlineChecking,
  isProxyInlineInvalid,
  type ProxyInlineValidationState,
  type ProxyInlineStage,
} from '@/utils/proxyInlineValidation';
import { toProxyOwnerAccount } from '@/features/authFiles/constants';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import type { PluginListEntry } from '@/types';
import { getPluginTitle, resolvePluginAssetURL } from '@/features/plugins/pluginResources';
import { createCodexInspectionConnectionFingerprint } from '@/features/monitoring/codexInspection';
import {
  createAccountCredentialMutationBaseline,
  recordAccountCredentialMutationMarker,
  type AccountCredentialMutationBaseline,
} from '@/features/accounts/model/accountCredentialMutationMarker';
import { probeProxyConnectivity } from '@/services/api/proxyProbe';
import type { ApiClientRequestScope } from '@/services/api/client';
import {
  completeAccountOAuthReauthSessionFromSearch,
  readAccountOAuthReauthSessionId,
} from '@/features/accounts/model/accountReauthSession';
import {
  isOAuthProviderAttemptCurrent,
  isOAuthPollingScopeCurrent,
  resolvePluginOAuthProviderId,
  shouldShowPluginOAuthProvider,
  type OAuthProviderAttempt,
  type OAuthPollingScope,
} from './oauthProviderHelpers';
import { validateDevinCallback } from './devinOAuth';
import styles from './OAuthPage.module.scss';
import iconCodex from '@/assets/icons/codex.svg';
import iconClaude from '@/assets/icons/claude.svg';
import iconAntigravity from '@/assets/icons/antigravity.svg';
import iconKimiLight from '@/assets/icons/kimi-light.svg';
import iconKimiDark from '@/assets/icons/kimi-dark.svg';
import iconVertex from '@/assets/icons/vertex.svg';
import iconGrok from '@/assets/icons/grok.svg';
import iconGrokDark from '@/assets/icons/grok-dark.svg';
import iconDevin from '@/assets/icons/devin.svg';
import iconDevinDark from '@/assets/icons/devin-dark.svg';
import iconMeta from '@/assets/icons/meta.svg';

type OAuthFlowStep =
  | 'generate_link'
  | 'wait_callback'
  | 'submit_callback'
  | 'exchange_token'
  | 'saved';

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
  /**
   * 代理输入框的内联实时校验状态（失焦即验 + 就地展示过程/结果）。
   * 主校验路径走这里；startAuth 只读该状态做提交门控，不再是唯一触发点。
   */
  proxyInline?: ProxyInlineValidationState;
  savedProxyUrl?: string;
  expiresAtMs?: number;
  expiresInSeconds?: number;
  userCode?: string;
  cancelError?: string;
  callbackUrl?: string;
  callbackSubmitting?: boolean;
  callbackStatus?: 'success' | 'error';
  callbackError?: string;
  authFilesBeforeStart?: string[];
  successResult?: OAuthSuccessResult;
}

interface ScopedOAuthProviderAttempt extends OAuthProviderAttempt {
  requestScope: ApiClientRequestScope;
  credentialBaseline?: AccountCredentialMutationBaseline;
  beforeNames?: string[];
  stateSnapshot?: ProviderState;
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
  {
    id: 'devin',
    titleKey: 'auth_login.devin_oauth_title',
    hintKey: 'auth_login.devin_oauth_hint',
    urlLabelKey: 'auth_login.devin_oauth_url_label',
    icon: { light: iconDevin, dark: iconDevinDark },
  },
  {
    id: 'meta',
    titleKey: 'auth_login.meta_oauth_title',
    hintKey: 'auth_login.meta_oauth_hint',
    urlLabelKey: 'auth_login.meta_oauth_url_label',
    icon: iconMeta,
  },
];

const BUILT_IN_PROVIDER_IDS = new Set<string>(BUILT_IN_PROVIDERS.map((provider) => provider.id));

const CALLBACK_SUPPORTED = new Set<string>(['codex', 'anthropic', 'antigravity', 'xai', 'devin']);
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
const resolveExpiresAtMs = (expiresAt?: string, expiresInSeconds?: number): number | undefined => {
  const parsedExpiresAt = expiresAt ? Date.parse(expiresAt) : NaN;
  if (Number.isFinite(parsedExpiresAt)) return parsedExpiresAt;
  if (expiresInSeconds && Number.isFinite(expiresInSeconds)) {
    return Date.now() + expiresInSeconds * 1000;
  }
  return undefined;
};

const SUCCESS_RESET_DELAY_MS = 5000;
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
  if (provider === 'devin') return input.trim();
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
  const candidates = files.filter((entry) => matchesAuthFileProvider(entry, provider));
  if (authFileName) {
    const physicalName = authFileName.split('/').pop();
    const exact = candidates.filter((entry) => entry.name === physicalName);
    return exact.length === 1 ? exact[0] : undefined;
  }
  if (!beforeNames) return undefined;
  const before = new Set(beforeNames);
  const created = candidates.filter((entry) => !before.has(entry.name));
  return created.length === 1 ? created[0] : undefined;
};

export function OAuthPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { showNotification } = useNotificationStore();
  const resolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const apiBase = useAuthStore((state) => state.apiBase);
  const managementKey = useAuthStore((state) => state.managementKey);
  const supportsPlugin = useAuthStore((state) => state.supportsPlugin);
  const requestScope = useMemo(() => ({ apiBase, managementKey }), [apiBase, managementKey]);
  const pluginOAuthAvailable = connectionStatus === 'connected' && supportsPlugin;
  const connectionFingerprint = useMemo(
    () => createCodexInspectionConnectionFingerprint(apiBase, managementKey),
    [apiBase, managementKey]
  );
  const oauthPollingScope = useMemo<OAuthPollingScope>(
    () => ({
      connectionFingerprint,
      accountReauthSessionId: readAccountOAuthReauthSessionId(location.search),
      search: location.search,
    }),
    [connectionFingerprint, location.search]
  );
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
  const successResetTimers = useRef<Partial<Record<string, number>>>({});
  const providerAttemptVersions = useRef<Partial<Record<string, number>>>({});
  const providerCredentialBaselines = useRef<
    Partial<Record<string, { version: number; baseline: AccountCredentialMutationBaseline }>>
  >({});
  const callbackAttemptVersions = useRef<Partial<Record<string, number>>>({});
  const oauthPollingScopeRef = useRef(oauthPollingScope);
  const connectionFingerprintRef = useRef(connectionFingerprint);
  const vertexImportGenerationRef = useRef(0);
  const attemptSequence = useRef(0);
  const blurSequence = useRef(0);
  const blurVersions = useRef<Partial<Record<string, number>>>({});
  const activeSessions = useRef<
    Partial<Record<string, { state: string; attempt: ScopedOAuthProviderAttempt }>>
  >({});
  const completionTasks = useRef<
    Partial<Record<string, { version: number; promise: Promise<boolean> }>>
  >({});
  const vertexFileInputRef = useRef<HTMLInputElement | null>(null);
  connectionFingerprintRef.current = connectionFingerprint;

  const clearTimers = useCallback(() => {
    Object.values(pollingTimers.current).forEach((timer) => {
      if (timer !== undefined) window.clearInterval(timer);
    });
    Object.values(successResetTimers.current).forEach((timer) => {
      if (timer !== undefined) window.clearTimeout(timer);
    });
    pollingTimers.current = {};
    successResetTimers.current = {};
  }, []);

  useLayoutEffect(() => {
    const previousScope = oauthPollingScopeRef.current;
    oauthPollingScopeRef.current = oauthPollingScope;
    if (isOAuthPollingScopeCurrent(previousScope, oauthPollingScope)) return;
    providerAttemptVersions.current = {};
    blurVersions.current = {};
    activeSessions.current = {};
    completionTasks.current = {};
    providerCredentialBaselines.current = {};
    callbackAttemptVersions.current = {};
    vertexImportGenerationRef.current += 1;
    clearTimers();
    setStates((prev) => (Object.keys(prev).length === 0 ? prev : {}));
    setPluginOAuthPlugins([]);
    setVertexState({ fileName: '', location: '', loading: false });
  }, [clearTimers, oauthPollingScope]);

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

  useEffect(() => {
    const targetId = location.hash.replace(/^#/, '');
    if (!targetId) return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(targetId)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [location.hash, providers.length]);

  useEffect(() => {
    return () => {
      providerAttemptVersions.current = {};
      blurVersions.current = {};
      activeSessions.current = {};
      completionTasks.current = {};
      providerCredentialBaselines.current = {};
      callbackAttemptVersions.current = {};
      vertexImportGenerationRef.current += 1;
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
    const loadConnectionFingerprint = connectionFingerprint;
    pluginsApi
      .list(requestScope)
      .then((response) => {
        if (cancelled || connectionFingerprintRef.current !== loadConnectionFingerprint) return;
        setPluginOAuthPlugins(response.plugins.filter((plugin) => plugin.supportsOAuth));
      })
      .catch(() => {
        if (cancelled || connectionFingerprintRef.current !== loadConnectionFingerprint) return;
        setPluginOAuthPlugins([]);
      });

    return () => {
      cancelled = true;
    };
  }, [connectionFingerprint, pluginOAuthAvailable, requestScope]);

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

  // 内联校验结果落地（并发防抖）：仅当输入框当前值仍与被校验值逐字符相同才写回，
  // 避免旧探针结果覆盖用户已改动的新输入。
  const applyProxyInlineResult = (
    provider: OAuthProvider,
    expectedValue: string,
    next: ProxyInlineValidationState
  ) => {
    setStates((prev) => {
      const prevState = prev[provider] ?? {};
      if ((prevState.proxyUrl || '').trim() !== expectedValue) return prev;
      return { ...prev, [provider]: { ...prevState, proxyInline: next } };
    });
  };

  // 「校验中」阶段推进（查重 → 探针）：同样只在仍处于校验中且值未变时更新细分文案。
  const setProxyInlineStage = (
    provider: OAuthProvider,
    expectedValue: string,
    stage: ProxyInlineStage
  ) => {
    setStates((prev) => {
      const prevState = prev[provider] ?? {};
      if ((prevState.proxyUrl || '').trim() !== expectedValue) return prev;
      const inline = prevState.proxyInline;
      if (!inline || inline.phase !== 'checking') return prev;
      return {
        ...prev,
        [provider]: {
          ...prevState,
          proxyInline: { ...inline, stage, checkedValue: expectedValue },
        },
      };
    });
  };

  // 代理输入框失焦（blur）时的内联实时校验：格式（同步、不触网）→ 查重（L2）→ 连通性探针（L1）。
  // 空值不就地报错（必填在提交时拦）；同值已校验 / 校验中时不重复触发（缓存上次结果、防网络刷屏）。
  const handleProxyBlur = async (provider: OAuthProvider) => {
    const version = ++blurSequence.current;
    blurVersions.current[provider] = version;
    const capturedScope = requestScope;
    const capturedFingerprint = connectionFingerprintRef.current;
    const isBlurCurrent = () =>
      blurVersions.current[provider] === version &&
      connectionFingerprintRef.current === capturedFingerprint &&
      createCodexInspectionConnectionFingerprint(
        useAuthStore.getState().apiBase,
        useAuthStore.getState().managementKey
      ) === capturedFingerprint &&
      (statesRef.current[provider]?.proxyUrl || '').trim() === trimmed;
    const current = statesRef.current[provider] ?? {};
    const rawValue = current.proxyUrl || '';
    const trimmed = rawValue.trim();
    const precheck = precheckProxyInlineFormat(rawValue);
    if (precheck === 'empty') {
      updateProviderState(provider, { proxyInline: { phase: 'idle' } });
      return;
    }
    if (precheck === 'invalid') {
      updateProviderState(provider, {
        proxyInline: {
          phase: 'invalid',
          message: t('auth_login.account_proxy_invalid'),
          checkedValue: trimmed,
        },
      });
      return;
    }
    // 同值已校验（成功/失败）或正在校验 → 不重复触发（对同一值缓存上次结果）。
    const existing = current.proxyInline;
    if (
      existing &&
      existing.checkedValue === trimmed &&
      (existing.phase === 'ok' || existing.phase === 'invalid' || existing.phase === 'checking')
    ) {
      return;
    }
    updateProviderState(provider, {
      proxyInline: { phase: 'checking', stage: 'dedup', checkedValue: trimmed },
    });
    const result = await runProxyInlineChecks({
      proxyUrl: trimmed,
      translate: (reason) => t(`proxy_preflight.reason_${reason}`),
      probe: (value) =>
        isBlurCurrent()
          ? probeProxyConnectivity(value, capturedScope)
          : Promise.resolve({ ok: false, exitIp: '', reason: 'probe_failed' }),
      checkDuplicate: async (value) => {
        if (!isBlurCurrent()) return [];
        const filesResponse = await authFilesApi.list(capturedScope);
        return findAccountsUsingProxy(value, (filesResponse.files || []).map(toProxyOwnerAccount), {
          provider,
        });
      },
      duplicateMessage: (accounts) =>
        t('proxy_preflight.duplicate_account', { accounts: accounts.join('、') }),
      onStage: (stage) => {
        if (isBlurCurrent()) setProxyInlineStage(provider, trimmed, stage);
      },
    });
    if (isBlurCurrent()) applyProxyInlineResult(provider, trimmed, result);
  };

  const beginProviderAttempt = (provider: OAuthProvider): ScopedOAuthProviderAttempt => {
    const version = ++attemptSequence.current;
    providerAttemptVersions.current[provider] = version;
    return {
      scope: oauthPollingScopeRef.current,
      version,
      requestScope,
      stateSnapshot: { ...statesRef.current[provider] },
    };
  };

  const isProviderAttemptCurrent = (
    provider: OAuthProvider,
    attempt: OAuthProviderAttempt
  ): boolean => {
    const currentAuth = useAuthStore.getState();
    const currentConnectionFingerprint = createCodexInspectionConnectionFingerprint(
      currentAuth.apiBase,
      currentAuth.managementKey
    );
    return (
      Boolean(attempt.scope.connectionFingerprint) &&
      currentConnectionFingerprint === attempt.scope.connectionFingerprint &&
      connectionFingerprintRef.current === attempt.scope.connectionFingerprint &&
      isOAuthProviderAttemptCurrent(
        attempt,
        oauthPollingScopeRef.current,
        providerAttemptVersions.current[provider]
      )
    );
  };

  const finishProviderAttempt = (provider: OAuthProvider, attempt: OAuthProviderAttempt) => {
    if (providerAttemptVersions.current[provider] === attempt.version) {
      delete providerAttemptVersions.current[provider];
      delete providerCredentialBaselines.current[provider];
    }
  };

  const beginCallbackAttempt = (provider: OAuthProvider): ScopedOAuthProviderAttempt => {
    const version = ++attemptSequence.current;
    callbackAttemptVersions.current[provider] = version;
    return {
      scope: oauthPollingScopeRef.current,
      version,
      requestScope,
      stateSnapshot: { ...statesRef.current[provider] },
    };
  };

  const isCallbackAttemptCurrent = (
    provider: OAuthProvider,
    attempt: OAuthProviderAttempt
  ): boolean => {
    const currentAuth = useAuthStore.getState();
    const currentConnectionFingerprint = createCodexInspectionConnectionFingerprint(
      currentAuth.apiBase,
      currentAuth.managementKey
    );
    return (
      Boolean(attempt.scope.connectionFingerprint) &&
      currentConnectionFingerprint === attempt.scope.connectionFingerprint &&
      connectionFingerprintRef.current === attempt.scope.connectionFingerprint &&
      isOAuthProviderAttemptCurrent(
        attempt,
        oauthPollingScopeRef.current,
        callbackAttemptVersions.current[provider]
      )
    );
  };

  const finishCallbackAttempt = (provider: OAuthProvider, attempt: OAuthProviderAttempt) => {
    if (callbackAttemptVersions.current[provider] === attempt.version) {
      delete callbackAttemptVersions.current[provider];
    }
  };

  const clearPollingTimer = (provider: OAuthProvider) => {
    const timer = pollingTimers.current[provider];
    if (timer !== undefined) {
      window.clearInterval(timer);
      delete pollingTimers.current[provider];
    }
  };

  const clearSuccessResetTimer = (provider: OAuthProvider) => {
    const timer = successResetTimers.current[provider];
    if (timer !== undefined) {
      window.clearTimeout(timer);
      delete successResetTimers.current[provider];
    }
  };
  const clearProviderTimers = (provider: OAuthProvider) => {
    clearPollingTimer(provider);
    clearSuccessResetTimer(provider);
  };
  const resetProviderAttempt = (provider: OAuthProvider) => {
    delete providerAttemptVersions.current[provider];
    delete providerCredentialBaselines.current[provider];
    delete callbackAttemptVersions.current[provider];
    delete activeSessions.current[provider];
    clearProviderTimers(provider);
    setStates((prev) => {
      return {
        ...prev,
        [provider]: {},
      };
    });
  };

  const completeProviderAuth = (
    provider: OAuthProvider,
    response: OAuthStatusResponse,
    attempt: ScopedOAuthProviderAttempt
  ): Promise<boolean> => {
    const existing = completionTasks.current[provider];
    if (existing?.version === attempt.version) return existing.promise;
    const complete = async (): Promise<boolean> => {
      if (!isProviderAttemptCurrent(provider, attempt)) return false;
      clearPollingTimer(provider);
      const snapshot = attempt.stateSnapshot ?? {};
      const authFile = response.auth_name || response.saved_path;
      let matched: AuthFileItem | undefined;
      try {
        const result = await authFilesApi.list(attempt.requestScope);
        if (!isProviderAttemptCurrent(provider, attempt)) return false;
        matched = findSavedAuthFile(provider, authFile, attempt.beforeNames, result.files || []);
      } catch {
        if (!isProviderAttemptCurrent(provider, attempt)) return false;
      }
      if (!isProviderAttemptCurrent(provider, attempt)) return false;
      const successResult: OAuthSuccessResult = {
        authFile: authFile || matched?.name,
        account: getAuthFileAccount(matched),
        note: response.note || snapshot.accountNote?.trim() || undefined,
        proxyUrl: response.proxy_url || snapshot.proxyUrl?.trim() || undefined,
      };
      const currentScope = oauthPollingScopeRef.current;
      const completionConnectionFingerprint = attempt.scope.connectionFingerprint;
      if (
        !completionConnectionFingerprint ||
        !isOAuthPollingScopeCurrent(attempt.scope, currentScope)
      ) {
        return false;
      }
      completeAccountOAuthReauthSessionFromSearch(
        currentScope.search,
        provider,
        completionConnectionFingerprint
      );
      recordAccountCredentialMutationMarker({
        connectionFingerprint: completionConnectionFingerprint,
        provider,
        baseline: attempt.credentialBaseline,
        requireObservedMutation: true,
      });
      publishAccountCredentialMutationRevision({
        connectionFingerprint: completionConnectionFingerprint,
        provider,
        kind: 'oauth',
      });
      clearPollingTimer(provider);
      clearSuccessResetTimer(provider);
      finishProviderAttempt(provider, attempt);
      delete callbackAttemptVersions.current[provider];
      updateProviderState(provider, {
        url: undefined,
        state: undefined,
        userCode: undefined,
        status: 'success',
        successResult,
        savedProxyUrl: successResult.proxyUrl,
        error: undefined,
        polling: false,
        ...(provider === 'devin'
          ? {
              cancelling: false,
              cancelError: undefined,
            }
          : {}),
        callbackUrl: '',
        callbackSubmitting: false,
        callbackStatus: undefined,
        callbackError: undefined,
      });
      const timer = window.setTimeout(() => {
        if (successResetTimers.current[provider] !== timer) return;
        resetProviderAttempt(provider);
      }, SUCCESS_RESET_DELAY_MS);
      successResetTimers.current[provider] = timer;
      return true;
    };
    const promise = complete();
    completionTasks.current[provider] = { version: attempt.version, promise };
    return promise;
  };

  const handleProviderAuthStatus = async (
    provider: OAuthProvider,
    response: Awaited<ReturnType<typeof oauthApi.getAuthStatus>>,
    attempt: ScopedOAuthProviderAttempt,
    successMessage: string
  ): Promise<'completed' | 'waiting' | 'error' | 'stale'> => {
    if (!isProviderAttemptCurrent(provider, attempt)) return 'stale';
    if (response.status === 'ok') {
      if (completionTasks.current[provider]?.version === attempt.version) return 'waiting';
      if (!(await completeProviderAuth(provider, response, attempt))) return 'stale';
      showNotification(successMessage, 'success');
      return 'completed';
    }
    if (response.status === 'cancelled') {
      finishProviderAttempt(provider, attempt);
      clearProviderTimers(provider);
      delete activeSessions.current[provider];
      delete callbackAttemptVersions.current[provider];
      const message = response.error?.trim() || t('auth_login.oauth_status_cancelled');
      updateProviderState(provider, {
        status: 'cancelled',
        error: message,
        polling: false,
        cancelling: false,
        url: undefined,
        state: undefined,
        userCode: undefined,
      });
      showNotification(message, 'info');
      return 'completed';
    }
    if (response.status === 'error') {
      finishProviderAttempt(provider, attempt);
      delete callbackAttemptVersions.current[provider];
      clearPollingTimer(provider);
      updateProviderState(provider, {
        ...(provider === 'devin'
          ? {
              url: undefined,
              state: undefined,
              callbackUrl: '',
              cancelling: false,
              cancelError: undefined,
            }
          : {}),
        userCode: undefined,
        status: 'error',
        error: response.error,
        polling: false,
        callbackSubmitting: false,
        callbackStatus: 'error',
        callbackError: response.error,
      });
      showNotification(
        `${getProviderActionText(provider, 'oauth_status_error')} ${response.error || ''}`,
        'error'
      );
      return 'error';
    }
    return 'waiting';
  };

  const startPolling = (
    provider: OAuthProvider,
    state: string,
    attempt: ScopedOAuthProviderAttempt
  ) => {
    clearPollingTimer(provider);
    let requestInFlight = false;
    const timer = window.setInterval(async () => {
      const isCurrentAttempt = () =>
        pollingTimers.current[provider] === timer && isProviderAttemptCurrent(provider, attempt);
      const stopAttempt = () => {
        window.clearInterval(timer);
        if (pollingTimers.current[provider] === timer) {
          delete pollingTimers.current[provider];
        }
      };
      if (!isCurrentAttempt()) {
        stopAttempt();
        return;
      }
      if (requestInFlight) return;
      requestInFlight = true;
      try {
        const res = await oauthApi.getAuthStatus(state, attempt.requestScope);
        if (!isCurrentAttempt()) {
          stopAttempt();
          return;
        }
        const result = await handleProviderAuthStatus(
          provider,
          res,
          attempt,
          getProviderActionText(provider, 'oauth_status_success')
        );
        if (result === 'error' || result === 'completed') {
          stopAttempt();
        }
      } catch (err: unknown) {
        if (!isCurrentAttempt()) {
          stopAttempt();
          return;
        }
        if (provider === 'devin') {
          updateProviderState(provider, {
            status: 'error',
            error: `${getErrorMessage(err) || ''} ${t('auth_login.devin_oauth_retry_hint')}`.trim(),
            polling: false,
          });
          stopAttempt();
          return;
        }
        finishProviderAttempt(provider, attempt);
        updateProviderState(provider, {
          userCode: undefined,
          status: 'error',
          error: getErrorMessage(err),
          polling: false,
          cancelling: false,
        });
        stopAttempt();
      } finally {
        requestInFlight = false;
      }
    }, 3000);
    pollingTimers.current[provider] = timer;
  };

  const startAuth = async (provider: OAuthProvider) => {
    if (provider === 'devin' && states[provider]?.state) return;
    const attempt = beginProviderAttempt(provider);
    const isStartCurrent = () =>
      isProviderAttemptCurrent(provider, attempt) &&
      (statesRef.current[provider]?.proxyUrl || '').trim() === proxyUrl;
    const current = states[provider] || {};
    const proxyUrl = (current.proxyUrl || '').trim();
    // 提交门控：读取输入框内联实时校验状态。主校验路径在失焦时已跑，这里只做最后确认门，
    // 不再是唯一触发点，也不再对已校验通过的值隐藏地重跑探针。
    // 空 / 格式非法 → 就地标红输入框并拦住（不触网）。
    const precheck = precheckProxyInlineFormat(current.proxyUrl || '');
    if (precheck === 'empty' || precheck === 'invalid') {
      const message =
        precheck === 'empty'
          ? t('auth_login.account_proxy_required')
          : t('auth_login.account_proxy_invalid');
      updateProviderState(provider, {
        proxyInline: { phase: 'invalid', message, checkedValue: proxyUrl },
      });
      showNotification(message, 'warning');
      return;
    }
    // 正在校验 → 拦住并提示「代理验证中，请稍候」，不放行。
    if (isProxyInlineChecking(current.proxyInline, proxyUrl)) {
      showNotification(t('proxy_preflight.validating_wait'), 'warning');
      return;
    }
    // 已校验失败（同值）→ 拦住并提示（错误已就地展示），不放行、也不重跑探针。
    if (isProxyInlineInvalid(current.proxyInline, proxyUrl)) {
      showNotification(
        current.proxyInline?.message || t('auth_login.account_proxy_invalid'),
        'error'
      );
      return;
    }
    // 已校验通过（同值）→ 直接放行；否则（未校验 / 值已变更后未重验）→ 就地补跑一次完整
    // 校验作为最后确认门（fail-closed）：查重（L2）先于连通性探针（L1），不过则不进 OAuth。
    if (!isProxyInlineValidatedOk(current.proxyInline, proxyUrl)) {
      updateProviderState(provider, {
        proxyInline: { phase: 'checking', stage: 'dedup', checkedValue: proxyUrl },
      });
      const result = await runProxyInlineChecks({
        proxyUrl,
        translate: (reason) => t(`proxy_preflight.reason_${reason}`),
        probe: (value) =>
          isStartCurrent()
            ? probeProxyConnectivity(value, attempt.requestScope)
            : Promise.resolve({ ok: false, exitIp: '', reason: 'probe_failed' }),
        checkDuplicate: async (value) => {
          if (!isStartCurrent()) return [];
          const filesResponse = await authFilesApi.list(attempt.requestScope);
          return findAccountsUsingProxy(
            value,
            (filesResponse.files || []).map(toProxyOwnerAccount),
            { provider }
          );
        },
        duplicateMessage: (accounts) =>
          t('proxy_preflight.duplicate_account', { accounts: accounts.join('、') }),
        onStage: (stage) => {
          if (isStartCurrent()) setProxyInlineStage(provider, proxyUrl, stage);
        },
      });
      if (!isStartCurrent()) return;
      applyProxyInlineResult(provider, proxyUrl, result);
      if (result.phase !== 'ok') {
        showNotification(result.message || t('auth_login.account_proxy_invalid'), 'error');
        return;
      }
      if (result.exitIp) {
        showNotification(t('proxy_preflight.connected_with_ip', { ip: result.exitIp }), 'success');
      }
    }
    if (!isStartCurrent()) return;
    clearProviderTimers(provider);
    updateProviderState(provider, {
      url: undefined,
      state: undefined,
      status: 'starting',
      polling: true,
      cancelling: false,
      error: undefined,
      savedProxyUrl: undefined,
      expiresAtMs: undefined,
      expiresInSeconds: undefined,
      cancelError: undefined,
      callbackSubmitting: false,
      callbackStatus: undefined,
      callbackError: undefined,
      callbackUrl: '',
      authFilesBeforeStart: undefined,
      successResult: undefined,
    });
    try {
      try {
        const response = await authFilesApi.list(attempt.requestScope);
        if (!isProviderAttemptCurrent(provider, attempt)) return;
        attempt.beforeNames = response.files.map((file) => file.name);
        attempt.credentialBaseline =
          createAccountCredentialMutationBaseline(response.files, provider) ?? undefined;
        if (attempt.credentialBaseline) {
          providerCredentialBaselines.current[provider] = {
            version: attempt.version,
            baseline: attempt.credentialBaseline,
          };
        }
      } catch {
        if (!isProviderAttemptCurrent(provider, attempt)) return;
        // OAuth remains available, but completion will fail closed without a mutation marker.
      }
      if (!isStartCurrent()) return;
      const res = await oauthApi.startAuth(provider, {
        ...attempt.requestScope,
        note: (current.accountNote || '').trim() || undefined,
        proxyUrl: proxyUrl || undefined,
      });
      if (!isProviderAttemptCurrent(provider, attempt)) return;
      if (!res.state) {
        const message = t('auth_login.missing_state');
        finishProviderAttempt(provider, attempt);
        updateProviderState(provider, {
          url: res.url,
          state: undefined,
          userCode: undefined,
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
        userCode: res.user_code,
        status: 'waiting',
        polling: true,
        expiresAtMs,
        expiresInSeconds,
      });
      activeSessions.current[provider] = { state: res.state, attempt };
      startPolling(provider, res.state, attempt);
    } catch (err: unknown) {
      if (!isProviderAttemptCurrent(provider, attempt)) return;
      const message = getErrorMessage(err);
      finishProviderAttempt(provider, attempt);
      updateProviderState(provider, {
        status: 'error',
        error: message,
        polling: false,
        userCode: undefined,
      });
      showNotification(
        `${getProviderActionText(provider, 'oauth_start_error')}${message ? ` ${message}` : ''}`,
        'error'
      );
    }
  };

  const cancelAuth = async (provider: OAuthProvider) => {
    const session = activeSessions.current[provider];
    if (!session || !isProviderAttemptCurrent(provider, session.attempt)) return;
    const { state } = session;

    const previousVersion = providerAttemptVersions.current[provider];
    const previousBaseline = providerCredentialBaselines.current[provider];

    clearPollingTimer(provider);
    delete callbackAttemptVersions.current[provider];

    const attempt = { ...session.attempt, version: ++attemptSequence.current };
    providerAttemptVersions.current[provider] = attempt.version;
    activeSessions.current[provider] = { state, attempt };

    if (previousBaseline && previousBaseline.version === previousVersion) {
      attempt.credentialBaseline = previousBaseline.baseline;
      providerCredentialBaselines.current[provider] = {
        version: attempt.version,
        baseline: previousBaseline.baseline,
      };
    }

    updateProviderState(provider, {
      cancelling: true,
      cancelError: undefined,
    });

    try {
      const res =
        provider === 'devin'
          ? await oauthApi.cancelSession(state, attempt.requestScope)
          : await oauthApi.cancelAuth(state, attempt.requestScope);
      if (!isProviderAttemptCurrent(provider, attempt)) return;

      if (provider === 'devin' ? res.cancelled : isOAuthCancelSuccessful(res)) {
        resetProviderAttempt(provider);
        updateProviderState(provider, { status: 'cancelled', polling: false, cancelling: false });
        showNotification(
          t(
            provider === 'devin'
              ? 'auth_login.devin_oauth_cancelled'
              : 'auth_login.oauth_status_cancelled'
          ),
          'success'
        );
        return;
      }

      updateProviderState(provider, { cancelling: false });
      const statusRes = await oauthApi.getAuthStatus(state, attempt.requestScope);
      if (!isProviderAttemptCurrent(provider, attempt)) return;

      const result = await handleProviderAuthStatus(
        provider,
        statusRes,
        attempt,
        getProviderActionText(provider, 'oauth_status_success')
      );
      if (result === 'waiting') {
        updateProviderState(provider, { polling: true });
        startPolling(provider, state, attempt);
      }
    } catch (err: unknown) {
      if (!isProviderAttemptCurrent(provider, attempt)) return;
      const message = getErrorMessage(err);
      const cancelErrorMessage = message || t('auth_login.devin_oauth_cancel_error');
      updateProviderState(provider, {
        cancelling: false,
        cancelError: cancelErrorMessage,
        status: 'waiting',
        polling: true,
      });
      showNotification(cancelErrorMessage, 'error');
      startPolling(provider, state, attempt);
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

  const copyCode = async (code?: string) => {
    if (!code) return;
    const copied = await copyToClipboard(code);
    showNotification(
      t(copied ? 'auth_login.device_code_copied' : 'notification.copy_failed', {
        defaultValue: copied ? t('notification.link_copied') : t('notification.copy_failed'),
      }),
      copied ? 'success' : 'error'
    );
  };

  const submitCallback = async (provider: OAuthProvider) => {
    const providerState = states[provider];
    const callbackInput = (providerState?.callbackUrl || '').trim();
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
    const state = providerState?.state;
    const providerVersion = providerAttemptVersions.current[provider];
    if (provider === 'devin') {
      const validation = validateDevinCallback(callbackInput, state);
      if (!validation.valid) {
        const errorMsg = t(validation.errorKey || 'auth_login.devin_callback_invalid');
        updateProviderState(provider, {
          callbackStatus: 'error',
          callbackError: errorMsg,
        });
        showNotification(errorMsg, 'warning');
        return;
      }
    }
    const redirectUrl = resolveCallbackUrl(provider, callbackInput, state);
    if (!redirectUrl) {
      showNotification(
        t(
          provider === 'xai' ? 'auth_login.xai_callback_state_missing' : 'auth_login.missing_state'
        ),
        'warning'
      );
      return;
    }
    if (!state || providerVersion === undefined) {
      showNotification(t('auth_login.missing_state'), 'warning');
      return;
    }
    const session = activeSessions.current[provider];
    if (!session || session.state !== state || session.attempt.version !== providerVersion) return;
    const providerAttempt = session.attempt;
    if (!isProviderAttemptCurrent(provider, providerAttempt)) return;
    const callbackAttempt = beginCallbackAttempt(provider);
    updateProviderState(provider, {
      callbackSubmitting: true,
      callbackStatus: undefined,
      callbackError: undefined,
    });
    const probeStatus = async () => {
      const response = await oauthApi.getAuthStatus(state, providerAttempt.requestScope);
      if (
        !isCallbackAttemptCurrent(provider, callbackAttempt) ||
        !isProviderAttemptCurrent(provider, providerAttempt)
      ) {
        return;
      }
      finishCallbackAttempt(provider, callbackAttempt);
      await handleProviderAuthStatus(
        provider,
        response,
        providerAttempt,
        getProviderActionText(provider, 'oauth_status_success')
      );
    };
    try {
      await oauthApi.submitCallback(provider, redirectUrl, callbackAttempt.requestScope);
      if (!isCallbackAttemptCurrent(provider, callbackAttempt)) return;
      if (!isProviderAttemptCurrent(provider, providerAttempt)) return;
      updateProviderState(provider, {
        callbackSubmitting: false,
        callbackStatus: 'success',
        callbackError: undefined,
      });
      showNotification(t('auth_login.oauth_callback_success'), 'success');
      try {
        await probeStatus();
      } catch {
        if (isCallbackAttemptCurrent(provider, callbackAttempt)) {
          finishCallbackAttempt(provider, callbackAttempt);
        }
      }
    } catch (err: unknown) {
      if (!isCallbackAttemptCurrent(provider, callbackAttempt)) return;
      const status = getErrorStatus(err);
      if (status === 409 && isProviderAttemptCurrent(provider, providerAttempt)) {
        updateProviderState(provider, {
          callbackSubmitting: false,
          callbackStatus: 'success',
          callbackError: undefined,
        });
        try {
          await probeStatus();
        } catch (probeError: unknown) {
          if (!isCallbackAttemptCurrent(provider, callbackAttempt)) return;
          finishCallbackAttempt(provider, callbackAttempt);
          updateProviderState(provider, {
            callbackSubmitting: false,
            callbackStatus: 'error',
            callbackError: getErrorMessage(probeError) || undefined,
          });
        }
        return;
      }
      const message = getErrorMessage(err);
      const errorMessage =
        status === 404
          ? t('auth_login.oauth_callback_upgrade_hint', {
              defaultValue: 'Please update CLI Proxy API or check the connection.',
            })
          : message || undefined;
      finishCallbackAttempt(provider, callbackAttempt);
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
    const importGeneration = vertexImportGenerationRef.current + 1;
    vertexImportGenerationRef.current = importGeneration;
    const importConnectionFingerprint = connectionFingerprint;
    if (!importConnectionFingerprint) return;
    const importRequestScope = requestScope;
    const isCurrentImport = () =>
      connectionFingerprintRef.current === importConnectionFingerprint &&
      vertexImportGenerationRef.current === importGeneration;
    setVertexState((prev) => ({ ...prev, loading: true, error: undefined, result: undefined }));
    try {
      const res: VertexImportResponse = await vertexApi.importCredential(
        vertexState.file,
        location || undefined,
        importRequestScope
      );
      if (!isCurrentImport()) return;
      const result: VertexImportResult = {
        projectId: res.project_id,
        email: res.email,
        location: res.location,
        authFile: res['auth-file'] ?? res.auth_file,
      };
      recordAccountCredentialMutationMarker({
        connectionFingerprint: importConnectionFingerprint,
        provider: 'vertex',
      });
      publishAccountCredentialMutationRevision({
        connectionFingerprint: importConnectionFingerprint,
        provider: 'vertex',
        kind: 'credential',
      });
      setVertexState((prev) => ({ ...prev, loading: false, result }));
      showNotification(t('vertex_import.success'), 'success');
    } catch (err: unknown) {
      if (!isCurrentImport()) return;
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
    const showFlowSteps =
      Boolean(state.status) && state.status !== 'idle' && state.status !== 'cancelled';
    const canCancel =
      (state.status === 'starting' ||
        state.status === 'waiting' ||
        (provider.id === 'devin' && state.status === 'error')) &&
      Boolean(state.state);
    return (
      <div key={provider.id} id={`oauth-provider-${provider.id}`}>
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
              loading={Boolean(state.polling) || state.proxyInline?.phase === 'checking'}
              disabled={
                state.proxyInline?.phase === 'checking' ||
                (provider.id === 'devin' && Boolean(state.state))
              }
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
                onChange={(e) => updateProviderState(provider.id, { accountNote: e.target.value })}
                placeholder={t('auth_login.account_note_placeholder')}
              />
              <Input
                label={t('auth_login.account_proxy_label')}
                hint={t('auth_login.account_proxy_hint')}
                value={state.proxyUrl || ''}
                error={
                  state.proxyInline?.phase === 'invalid' ? state.proxyInline.message : undefined
                }
                disabled={Boolean(state.polling) || state.proxyInline?.phase === 'checking'}
                onChange={(e) =>
                  updateProviderState(provider.id, {
                    proxyUrl: e.target.value,
                    // 编辑即清空上次内联校验结果（回 idle），失焦后重新校验。
                    proxyInline: { phase: 'idle' },
                  })
                }
                onBlur={() => void handleProxyBlur(provider.id)}
                placeholder={t('auth_login.account_proxy_placeholder')}
                data-testid={`oauth-proxy-url-input-${provider.id}`}
              />
            </div>
            {/* 代理内联校验状态区：紧邻输入框就地展示「验证中 / 已连通(出口 IP)」；
                      失败文案走 Input 自身的 error 红框（不重复展示）。 */}
            {state.proxyInline?.phase === 'checking' && (
              <div
                className={`status-badge muted ${styles.proxyInlineStatus}`}
                data-testid={`oauth-proxy-status-${provider.id}`}
                data-proxy-phase="checking"
              >
                <LoadingSpinner size={12} />
                {state.proxyInline.stage === 'dedup'
                  ? t('proxy_preflight.checking_dedup', { defaultValue: '正在查重代理…' })
                  : t('proxy_preflight.probing')}
              </div>
            )}
            {state.proxyInline?.phase === 'ok' && (
              <div
                className="status-badge success"
                data-testid={`oauth-proxy-status-${provider.id}`}
                data-proxy-phase="ok"
              >
                {state.proxyInline.exitIp
                  ? `✓ ${t('proxy_preflight.connected_with_ip', { ip: state.proxyInline.exitIp })}`
                  : `✓ ${t('proxy_preflight.connected', { defaultValue: '连通正常' })}`}
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
                      <span className={styles.keyValueKey}>{t('auth_login.fingerprint_tls')}</span>
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
                {state.userCode && (
                  <div className={styles.deviceCodeSection}>
                    <div className={styles.authUrlLabel}>{t('auth_login.device_code_label')}</div>
                    <div className={styles.deviceCodeRow}>
                      <span
                        className={styles.deviceCodeValue}
                        aria-label={t('auth_login.device_code_label')}
                      >
                        {state.userCode}
                      </span>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => copyCode(state.userCode)}
                        aria-label={t('auth_login.device_code_copy')}
                      >
                        {t('auth_login.device_code_copy')}
                      </Button>
                    </div>
                  </div>
                )}
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
                      disabled={state.cancelling}
                    >
                      {t(
                        provider.id === 'devin'
                          ? 'auth_login.devin_oauth_cancel'
                          : 'auth_login.oauth_cancel_button',
                        { defaultValue: '取消本次登录' }
                      )}
                    </Button>
                  )}
                </div>
                {state.cancelError && <div className="status-badge error">{state.cancelError}</div>}
              </div>
            )}
            {canSubmitCallback && (
              <div className={styles.callbackSection}>
                <Input
                  label={t(
                    provider.id === 'devin'
                      ? 'auth_login.devin_callback_label'
                      : provider.id === 'xai'
                        ? 'auth_login.xai_callback_label'
                        : 'auth_login.oauth_callback_label'
                  )}
                  hint={t(
                    provider.id === 'devin'
                      ? 'auth_login.devin_callback_hint'
                      : provider.id === 'xai'
                        ? 'auth_login.xai_callback_hint'
                        : 'auth_login.oauth_callback_hint'
                  )}
                  value={state.callbackUrl || ''}
                  disabled={
                    provider.id === 'devin' &&
                    (state.cancelling === true || state.status !== 'waiting')
                  }
                  onChange={(e) =>
                    updateProviderState(provider.id, {
                      callbackUrl: e.target.value,
                      callbackStatus: undefined,
                      callbackError: undefined,
                    })
                  }
                  placeholder={t(
                    provider.id === 'devin'
                      ? 'auth_login.devin_callback_placeholder'
                      : provider.id === 'xai'
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
                    disabled={
                      provider.id === 'devin' &&
                      (state.cancelling === true || state.status !== 'waiting')
                    }
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
                        ? t('auth_login.oauth_status_starting', {
                            defaultValue: '正在准备授权链接...',
                          })
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
                  {(state.successResult.account || state.successResult.note) && (
                    <div className={styles.keyValueItem}>
                      <span className={styles.keyValueKey}>
                        {t('auth_login.oauth_saved_account', { defaultValue: '账号' })}
                      </span>
                      <AccountIdentity
                        identity={resolveAccountIdentity({
                          note: state.successResult.note,
                          email: state.successResult.account,
                          fallback: state.successResult.account,
                        })}
                        compact
                        className={styles.keyValueValue}
                        testId={`oauth-success-account-${provider.id}`}
                      />
                    </div>
                  )}
                  {state.successResult.proxyUrl && (
                    <div className={styles.keyValueItem}>
                      <span className={styles.keyValueKey}>
                        {t('auth_login.oauth_saved_proxy')}
                      </span>
                      <span className={styles.keyValueValue}>{state.successResult.proxyUrl}</span>
                    </div>
                  )}
                </div>
                <div className={styles.successActions}>
                  <Button variant="secondary" size="sm" onClick={() => navigate('/accounts')}>
                    {t('auth_login.view_credentials')}
                  </Button>
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
      </div>
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
                  <span className={styles.keyValueKey}>{t('vertex_import.result_project')}</span>
                  <span className={styles.keyValueValue}>{vertexState.result.projectId}</span>
                </div>
              )}
              {vertexState.result.email && (
                <div className={styles.keyValueItem}>
                  <span className={styles.keyValueKey}>{t('vertex_import.result_email')}</span>
                  <AccountIdentity
                    identity={resolveAccountIdentity({ email: vertexState.result.email })}
                    compact
                    className={styles.keyValueValue}
                    testId="vertex-import-account-identity"
                  />
                </div>
              )}
              {vertexState.result.location && (
                <div className={styles.keyValueItem}>
                  <span className={styles.keyValueKey}>{t('vertex_import.result_location')}</span>
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
