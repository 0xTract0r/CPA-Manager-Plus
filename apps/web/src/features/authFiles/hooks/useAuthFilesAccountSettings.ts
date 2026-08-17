/**
 * 账号设置(身份隔离)弹窗的数据 hook。
 *
 * 迁移自旧版 fork `useAuthFilesPrefixProxyEditor`（同名但语义不同的旧 cpamp
 * 弹窗除外，本 hook 只服务新增的 `AuthFilesAccountSettingsModal`）：
 * 走 `/auth-files/account-settings` 的结构化白名单 PATCH，而不是原始 JSON 编辑。
 *
 * 身份只读字段（synthetic_device_id / managed_header_state /
 * client_version_observations / warnings 等）只用于展示，不进 PATCH 请求体；
 * 可编辑字段见 `AuthFileAccountSettingsPatchRequest` 白名单
 * （proxy_url / note / disabled / refresh_enabled / farm_enrolled /
 * extra_headers / transport_profile / tls_profile）。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { authFilesApi } from '@/services/api';
import { normalizeAuthIndex } from '@/utils/usage';
import type {
  AuthFileAccountSettings,
  AuthFileAccountSettingsPatchRequest,
  AuthFileClientVersionObservation,
  AuthFileManagedHeaderState,
  AuthFileItem,
} from '@/types/authFile';
import { useNotificationStore } from '@/stores';

type AuthFileHeaders = Record<string, string>;
type AuthFileHeadersErrorKey =
  | 'auth_files.headers_invalid_json'
  | 'auth_files.headers_invalid_object'
  | 'auth_files.headers_invalid_value';

export type AccountSettingsEditorField =
  | 'proxyUrl'
  | 'note'
  | 'disabled'
  | 'refreshEnabled'
  | 'fast'
  | 'farmEnrolled'
  | 'extraHeadersText'
  | 'transportProfileText'
  | 'tlsProfileText';

export type AccountSettingsEditorFieldValue = string | boolean;

/**
 * 账号 proxy_url 校验结果。
 * - `valid: false` + `reason: 'empty'`：未填写（住宅代理为必填）。
 * - `valid: false` + `reason: 'invalid'`：填了但 scheme/格式非法。
 * - `valid: true`：可提交。
 *
 * 内联在本 hook 内，不改动共享 `src/utils/validation.ts`（当前 cpamp 版本尚无
 * `validateProxyUrl`，避免越权改动未列入本次任务范围的共享工具文件）。
 */
export type ProxyUrlValidationReason = 'empty' | 'invalid';

const PROXY_URL_ALLOWED_SCHEMES = new Set(['http', 'https', 'socks5', 'socks5h']);

function validateProxyUrl(value: string): { valid: boolean; reason?: ProxyUrlValidationReason } {
  const trimmed = (value || '').trim();
  if (!trimmed) {
    return { valid: false, reason: 'empty' };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, reason: 'invalid' };
  }

  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
  if (!PROXY_URL_ALLOWED_SCHEMES.has(scheme)) {
    return { valid: false, reason: 'invalid' };
  }
  if (!parsed.hostname) {
    return { valid: false, reason: 'invalid' };
  }

  return { valid: true };
}

export type AccountSettingsEditorState = {
  fileName: string;
  /** 该账号的 auth_index（若下发）；用于速度体感面板精确 join analytics 事件。 */
  authIndex: string | number | null;
  provider: string;
  fileInfoText: string;
  loading: boolean;
  saving: boolean;
  error: string | null;
  proxyUrl: string;
  /** proxy_url 必填/格式校验错误（'empty' 未填，'invalid' 非法）；为 null 表示通过。 */
  proxyUrlError: ProxyUrlValidationReason | null;
  note: string;
  disabled: boolean;
  refreshEnabled: boolean;
  /** 该账号是否启用 codex `fast`（service_tier=priority）；仅对 codex 账号生效。 */
  fast: boolean;
  /**
   * 农场契约字段（TR8）：账号级农场纳管开关（`farm_enrolled`）。老号默认
   * false（免疫农场治理：不受咬合门/自动供给/平台分流管辖），operator 显式
   * 开启后才纳入管辖。可写，随本编辑器一起 PATCH。
   */
  farmEnrolled: boolean;
  managedHeaders: AuthFileHeaders;
  managedHeaderState: AuthFileManagedHeaderState | null;
  /** 只读脱敏合成 device_id；为空表示后端未派生（omitempty 缺省）。 */
  syntheticDeviceId: string;
  /**
   * 农场契约字段（后端 AG1 同步实现中）：是否已绑定农场容器。undefined = 后端
   * 尚未下发该字段，前端防御式回退旧的合成假名展示，不臆造绑定。
   */
  farmBound: boolean | undefined;
  /** 农场契约字段：device_id 展示口径来源（container_synced/synthetic/drift/unknown）。 */
  deviceIdSource: string | undefined;
  clientVersionObservations: AuthFileClientVersionObservation[];
  runtimeProfileText: string;
  runtimeIdentityText: string;
  warnings: string[];
  extraHeadersText: string;
  extraHeadersTouched: boolean;
  extraHeadersError: string | null;
  transportProfileText: string;
  transportProfileTouched: boolean;
  transportProfileError: string | null;
  tlsProfileText: string;
  tlsProfileTouched: boolean;
  tlsProfileError: string | null;
  originalSerializedRequest: string;
};

export type UseAuthFilesAccountSettingsOptions = {
  disableControls: boolean;
  loadFiles: () => Promise<void>;
  loadKeyStats: () => Promise<void>;
};

export type UseAuthFilesAccountSettingsResult = {
  accountSettingsEditor: AccountSettingsEditorState | null;
  accountSettingsUpdatedText: string;
  accountSettingsDirty: boolean;
  openAccountSettingsEditor: (file: AuthFileItem) => Promise<void>;
  closeAccountSettingsEditor: () => void;
  handleAccountSettingsChange: (
    field: AccountSettingsEditorField,
    value: AccountSettingsEditorFieldValue
  ) => void;
  handleAccountSettingsSave: () => Promise<void>;
};

const isRecordObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * 计算 proxy_url 校验错误（必填 + 格式）。
 * 初次打开/水合时即评估，使空 proxy_url 的历史账号一进编辑器就提示需补填。
 */
const computeProxyUrlError = (value: string): ProxyUrlValidationReason | null => {
  const result = validateProxyUrl(value);
  return result.valid ? null : (result.reason ?? 'invalid');
};

/** proxy_url 校验错误对应的 i18n key。 */
const proxyUrlErrorKey = (reason: ProxyUrlValidationReason): string =>
  reason === 'empty' ? 'auth_files.proxy_url_required_error' : 'auth_files.proxy_url_invalid_error';

const validateHeadersValue = (value: unknown): AuthFileHeadersErrorKey | null => {
  if (!isRecordObject(value)) {
    return 'auth_files.headers_invalid_object';
  }
  return Object.values(value).every((item) => typeof item === 'string')
    ? null
    : 'auth_files.headers_invalid_value';
};

const parseHeadersText = (
  text: string
): { value: AuthFileHeaders | null; errorKey: AuthFileHeadersErrorKey | null } => {
  const trimmed = text.trim();
  if (!trimmed) {
    return { value: {}, errorKey: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { value: null, errorKey: 'auth_files.headers_invalid_json' };
  }

  const errorKey = validateHeadersValue(parsed);
  if (errorKey) {
    return { value: null, errorKey };
  }

  return { value: parsed as AuthFileHeaders, errorKey: null };
};

const stringifyProfile = (value: string | Record<string, unknown> | null | undefined): string => {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
};

const resolveAuthFileProvider = (
  file: AuthFileItem,
  settings: Partial<AuthFileAccountSettings> | null | undefined
): string => {
  const runtimeProvider = settings?.runtime_profile?.provider;
  const rawProvider =
    (typeof runtimeProvider === 'string' && runtimeProvider) ||
    (typeof file.provider === 'string' && file.provider) ||
    (typeof file.type === 'string' && file.type) ||
    '';
  return rawProvider.trim().toLowerCase();
};

const parseProfileText = (
  text: string
): { value: string | Record<string, unknown> | null; error: string | null } => {
  const trimmed = text.trim();
  if (!trimmed) {
    return { value: null, error: null };
  }
  if (!trimmed.startsWith('{')) {
    return { value: trimmed, error: null };
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!isRecordObject(parsed)) {
      return { value: null, error: 'Profile must be a JSON object or plain string preset.' };
    }
    return { value: parsed, error: null };
  } catch {
    return { value: null, error: 'Profile JSON is invalid.' };
  }
};

const normalizeSettings = (
  fileName: string,
  settings: Partial<AuthFileAccountSettings> | null | undefined
): AuthFileAccountSettingsPatchRequest => ({
  name: fileName,
  proxy_url: (settings?.proxy_url || '').trim() || null,
  note: (settings?.note || '').trim() || null,
  disabled: settings?.disabled === true,
  refresh_enabled: settings?.refresh_enabled !== false,
  fast: settings?.fast === true,
  // farm_enrolled 默认 false（老号免疫农场治理），与 refresh_enabled 的默认
  // true 语义相反——不能复用同一套「!== false」判断。
  farm_enrolled: settings?.farm_enrolled === true,
  extra_headers: settings?.extra_headers || {},
  transport_profile: settings?.transport_profile || null,
  tls_profile: settings?.tls_profile || null,
});

const buildPatchRequest = (
  editor: AccountSettingsEditorState
): {
  request: AuthFileAccountSettingsPatchRequest | null;
  error: string | null;
} => {
  const parsedHeaders = parseHeadersText(editor.extraHeadersText);
  if (parsedHeaders.errorKey) {
    return { request: null, error: parsedHeaders.errorKey };
  }
  const parsedTransportProfile = parseProfileText(editor.transportProfileText);
  if (parsedTransportProfile.error) {
    return { request: null, error: parsedTransportProfile.error };
  }
  const parsedTLSProfile = parseProfileText(editor.tlsProfileText);
  if (parsedTLSProfile.error) {
    return { request: null, error: parsedTLSProfile.error };
  }

  return {
    request: {
      name: editor.fileName,
      proxy_url: editor.proxyUrl.trim() || null,
      note: editor.note.trim() || null,
      disabled: editor.disabled,
      refresh_enabled: editor.refreshEnabled,
      fast: editor.fast,
      farm_enrolled: editor.farmEnrolled,
      extra_headers: parsedHeaders.value || {},
      transport_profile: parsedTransportProfile.value,
      tls_profile: parsedTLSProfile.value,
    },
    error: null,
  };
};

export function useAuthFilesAccountSettings(
  options: UseAuthFilesAccountSettingsOptions
): UseAuthFilesAccountSettingsResult {
  const { disableControls, loadFiles, loadKeyStats } = options;
  const { t } = useTranslation();
  const showNotification = useNotificationStore((state) => state.showNotification);

  const [accountSettingsEditor, setAccountSettingsEditor] =
    useState<AccountSettingsEditorState | null>(null);

  const accountSettingsUpdatedText = (() => {
    if (!accountSettingsEditor) return '';
    const { request, error } = buildPatchRequest(accountSettingsEditor);
    if (!request || error) return '';
    return JSON.stringify(request, null, 2);
  })();

  const accountSettingsDirty =
    Boolean(accountSettingsEditor) &&
    accountSettingsUpdatedText !== '' &&
    accountSettingsUpdatedText !== accountSettingsEditor?.originalSerializedRequest;

  const closeAccountSettingsEditor = () => {
    setAccountSettingsEditor(null);
  };

  const hydrateEditor = (
    name: string,
    file: AuthFileItem,
    settings: Partial<AuthFileAccountSettings> | null | undefined
  ) => {
    const normalizedRequest = normalizeSettings(name, settings);
    setAccountSettingsEditor({
      fileName: name,
      authIndex: normalizeAuthIndex(file['auth_index'] ?? file.authIndex),
      provider: resolveAuthFileProvider(file, settings),
      fileInfoText: JSON.stringify(file, null, 2),
      loading: false,
      saving: false,
      error: null,
      proxyUrl: settings?.proxy_url || '',
      proxyUrlError: computeProxyUrlError(settings?.proxy_url || ''),
      note: settings?.note || '',
      disabled: settings?.disabled === true,
      refreshEnabled: settings?.refresh_enabled !== false,
      fast: settings?.fast === true,
      farmEnrolled: settings?.farm_enrolled === true,
      managedHeaders: settings?.managed_headers || {},
      managedHeaderState: settings?.managed_header_state || null,
      syntheticDeviceId:
        typeof settings?.synthetic_device_id === 'string' ? settings.synthetic_device_id : '',
      farmBound: typeof settings?.farm_bound === 'boolean' ? settings.farm_bound : undefined,
      deviceIdSource:
        typeof settings?.device_id_source === 'string' ? settings.device_id_source : undefined,
      clientVersionObservations: Array.isArray(settings?.client_version_observations)
        ? settings.client_version_observations
        : [],
      runtimeProfileText: stringifyProfile(settings?.runtime_profile),
      runtimeIdentityText: stringifyProfile(settings?.runtime_identity),
      warnings: Array.isArray(settings?.warnings) ? settings.warnings : [],
      extraHeadersText: JSON.stringify(settings?.extra_headers || {}, null, 2),
      extraHeadersTouched: false,
      extraHeadersError: null,
      transportProfileText: stringifyProfile(settings?.transport_profile),
      transportProfileTouched: false,
      transportProfileError: null,
      tlsProfileText: stringifyProfile(settings?.tls_profile),
      tlsProfileTouched: false,
      tlsProfileError: null,
      originalSerializedRequest: JSON.stringify(normalizedRequest, null, 2),
    });
  };

  const openAccountSettingsEditor = async (file: AuthFileItem) => {
    const name = file.name;

    if (disableControls) return;
    if (accountSettingsEditor?.fileName === name) {
      setAccountSettingsEditor(null);
      return;
    }

    const inlineSettings = file.account_settings || file.accountSettings || null;
    setAccountSettingsEditor({
      fileName: name,
      authIndex: normalizeAuthIndex(file['auth_index'] ?? file.authIndex),
      provider: resolveAuthFileProvider(file, inlineSettings),
      fileInfoText: JSON.stringify(file, null, 2),
      loading: true,
      saving: false,
      error: null,
      proxyUrl: inlineSettings?.proxy_url || '',
      proxyUrlError: computeProxyUrlError(inlineSettings?.proxy_url || ''),
      note: inlineSettings?.note || '',
      disabled: inlineSettings?.disabled === true,
      refreshEnabled: inlineSettings?.refresh_enabled !== false,
      fast: inlineSettings?.fast === true,
      farmEnrolled: inlineSettings?.farm_enrolled === true,
      managedHeaders: inlineSettings?.managed_headers || {},
      managedHeaderState: inlineSettings?.managed_header_state || null,
      syntheticDeviceId:
        typeof inlineSettings?.synthetic_device_id === 'string'
          ? inlineSettings.synthetic_device_id
          : '',
      farmBound:
        typeof inlineSettings?.farm_bound === 'boolean' ? inlineSettings.farm_bound : undefined,
      deviceIdSource:
        typeof inlineSettings?.device_id_source === 'string'
          ? inlineSettings.device_id_source
          : undefined,
      clientVersionObservations: Array.isArray(inlineSettings?.client_version_observations)
        ? inlineSettings.client_version_observations
        : [],
      runtimeProfileText: stringifyProfile(inlineSettings?.runtime_profile),
      runtimeIdentityText: stringifyProfile(inlineSettings?.runtime_identity),
      warnings: Array.isArray(inlineSettings?.warnings) ? inlineSettings.warnings : [],
      extraHeadersText: JSON.stringify(inlineSettings?.extra_headers || {}, null, 2),
      extraHeadersTouched: false,
      extraHeadersError: null,
      transportProfileText: stringifyProfile(inlineSettings?.transport_profile),
      transportProfileTouched: false,
      transportProfileError: null,
      tlsProfileText: stringifyProfile(inlineSettings?.tls_profile),
      tlsProfileTouched: false,
      tlsProfileError: null,
      originalSerializedRequest: '',
    });

    try {
      const settings = await authFilesApi.getAccountSettings(name);
      hydrateEditor(name, file, settings);
    } catch (err: unknown) {
      if (inlineSettings) {
        hydrateEditor(name, file, inlineSettings);
        return;
      }
      const errorMessage = err instanceof Error ? err.message : t('notification.download_failed');
      setAccountSettingsEditor((prev) => {
        if (!prev || prev.fileName !== name) return prev;
        return { ...prev, loading: false, error: errorMessage };
      });
      showNotification(`${t('notification.download_failed')}: ${errorMessage}`, 'error');
    }
  };

  const handleAccountSettingsChange = (
    field: AccountSettingsEditorField,
    value: AccountSettingsEditorFieldValue
  ) => {
    setAccountSettingsEditor((prev) => {
      if (!prev) return prev;
      if (field === 'proxyUrl') {
        const proxyUrl = String(value);
        return { ...prev, proxyUrl, proxyUrlError: computeProxyUrlError(proxyUrl) };
      }
      if (field === 'note') return { ...prev, note: String(value) };
      if (field === 'disabled') return { ...prev, disabled: Boolean(value) };
      if (field === 'refreshEnabled') return { ...prev, refreshEnabled: Boolean(value) };
      if (field === 'fast') return { ...prev, fast: Boolean(value) };
      if (field === 'farmEnrolled') return { ...prev, farmEnrolled: Boolean(value) };
      if (field === 'extraHeadersText') {
        const extraHeadersText = String(value);
        const { errorKey } = parseHeadersText(extraHeadersText);
        return {
          ...prev,
          extraHeadersText,
          extraHeadersTouched: true,
          extraHeadersError: errorKey ? t(errorKey) : null,
        };
      }
      if (field === 'transportProfileText') {
        const transportProfileText = String(value);
        return {
          ...prev,
          transportProfileText,
          transportProfileTouched: true,
          transportProfileError: parseProfileText(transportProfileText).error,
        };
      }
      const tlsProfileText = String(value);
      return {
        ...prev,
        tlsProfileText,
        tlsProfileTouched: true,
        tlsProfileError: parseProfileText(tlsProfileText).error,
      };
    });
  };

  const handleAccountSettingsSave = async () => {
    if (!accountSettingsEditor || !accountSettingsDirty) return;

    // proxy_url 必填 + 格式校验：为空或非法时前端拦截，不提交（T041：core#26/#27 服务端守卫呼应）。
    const proxyError = computeProxyUrlError(accountSettingsEditor.proxyUrl);
    if (proxyError) {
      setAccountSettingsEditor((prev) =>
        prev ? { ...prev, proxyUrlError: proxyError } : prev
      );
      showNotification(t(proxyUrlErrorKey(proxyError)), 'error');
      return;
    }

    const { request, error } = buildPatchRequest(accountSettingsEditor);
    if (!request) {
      const errorMessage = error?.startsWith('auth_files.') ? t(error) : error || 'Invalid format';
      showNotification(errorMessage, 'error');
      return;
    }

    setAccountSettingsEditor((prev) => {
      if (!prev) return prev;
      return { ...prev, saving: true };
    });

    try {
      await authFilesApi.updateAccountSettings(request);
      showNotification(
        t('auth_files.prefix_proxy_saved_success', { name: request.name }),
        'success'
      );
      await loadFiles();
      await loadKeyStats();
      setAccountSettingsEditor(null);
    } catch (err: unknown) {
      const statusCode =
        err && typeof err === 'object' && 'status' in err
          ? (err as { status?: number }).status
          : undefined;
      const rawMessage = err instanceof Error ? err.message : '';
      // core#26/#27：proxy_url 为空/非法时服务端返回 400。展示可读错误而非吞掉/崩溃，
      // 并在编辑器内把 proxy_url 标红，提示用户补填合法住宅代理。
      if (statusCode === 400) {
        setAccountSettingsEditor((prev) =>
          prev ? { ...prev, saving: false, proxyUrlError: prev.proxyUrlError ?? 'invalid' } : prev
        );
        const detail = rawMessage
          ? `${t('auth_files.proxy_url_invalid_error')} (${rawMessage})`
          : t('auth_files.proxy_url_invalid_error');
        showNotification(detail, 'error');
        return;
      }
      showNotification(`${t('notification.upload_failed')}: ${rawMessage}`, 'error');
      setAccountSettingsEditor((prev) => {
        if (!prev) return prev;
        return { ...prev, saving: false };
      });
    }
  };

  return {
    accountSettingsEditor,
    accountSettingsUpdatedText,
    accountSettingsDirty,
    openAccountSettingsEditor,
    closeAccountSettingsEditor,
    handleAccountSettingsChange,
    handleAccountSettingsSave,
  };
}
