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
import { authFilesApi, type AuthFileFieldsPatch } from '@/services/api';
import { normalizeAuthIndex } from '@/utils/usage';
import { findAccountsUsingProxy, runProxyPreflight } from '@/utils/proxyPreflight';
import {
  normalizeProviderKey,
  parsePriorityValue,
  readAuthFileWebsockets,
  supportsAuthFileWebsockets,
  toProxyOwnerAccount,
} from '@/features/authFiles/constants';
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
  | 'tlsProfileText'
  // 迁移自旧「登录文件详情」弹窗（AuthFilesPrefixProxyEditorModal）的原始 JSON 字段：
  // prefix / priority / websockets 走 `/auth-files/fields`（原始 JSON 补丁），
  // rawJsonText 走整份 auth 文件覆写（危险操作，保存前二次确认）。
  | 'prefix'
  | 'priority'
  | 'websockets'
  | 'rawJsonText';

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
  /** 原始 auth 文件对象；供弹窗内的身份变更审计面板（reauth / status 历史）消费。 */
  file: AuthFileItem;
  /** 该账号的 auth_index（若下发）；用于速度体感面板精确 join analytics 事件。 */
  authIndex: string | number | null;
  provider: string;
  /** 归一化后的 provider key（codex/xai 等）；仅用于 websockets 开关的 provider gate。 */
  providerKey: string;
  fileInfoText: string;
  /**
   * 迁移自旧「登录文件详情」弹窗的原始 JSON 字段（走 `/auth-files/fields`）。
   * 仅当成功下载并解析为对象时可用（rawJsonAvailable=true）；数组/非对象/下载
   * 失败时这些结构化字段不渲染，只保留账号设置白名单能力。
   */
  prefix: string;
  priority: string;
  websockets: boolean;
  /** 是否成功加载到可结构化编辑的原始 JSON 对象。 */
  rawJsonAvailable: boolean;
  /** 原始 JSON 解析出的对象基线（用于计算 prefix/priority/websockets 补丁增量）。 */
  rawJsonObject: Record<string, unknown> | null;
  /** 可编辑的整份原始 auth JSON 文本（折叠区内，保存前二次确认）。 */
  rawJsonText: string;
  /** 原始 JSON 文本基线（首次加载格式化后的文本），用于判断是否手工改过。 */
  rawJsonBaseline: string;
  rawJsonTouched: boolean;
  /** 原始 JSON 文本非法（无法解析为对象）时的错误文案；为 null 表示合法。 */
  rawJsonError: string | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  proxyUrl: string;
  /**
   * 打开编辑器时加载到的 proxy_url 原值（变更前基线）。保存前若当前值与其逐字符相同，视为
   * 未变更 → 跳过连通性探针（该值此前已校验/已落库），避免改无关字段时被临时不通的旧代理阻断。
   */
  proxyUrlBaseline: string;
  /** proxy_url 必填/格式校验错误（'empty' 未填，'invalid' 非法）；为 null 表示通过。 */
  proxyUrlError: ProxyUrlValidationReason | null;
  /**
   * 代理查重（L2）冲突提示：保存时发现该代理已被其它现有账号占用时，写入含冲突账号名的
   * 本地化文案（供弹窗就地标红展示）；为 null 表示无冲突。改动 proxy_url 时清空。
   */
  proxyUrlDuplicateError?: string | null;
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
  /**
   * 现有账号列表（用于保存前的代理查重 L2）。父组件已加载的 auth-files 列表内联下发
   * account_settings.proxy_url，故直接客户端比对、不新增后端。缺省为空数组（不查重）。
   */
  accounts?: AuthFileItem[];
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
  settings: Partial<AuthFileAccountSettings> | null | undefined,
  provider: string
): AuthFileAccountSettingsPatchRequest => ({
  name: fileName,
  proxy_url: (settings?.proxy_url || '').trim() || null,
  note: (settings?.note || '').trim() || null,
  disabled: settings?.disabled === true,
  refresh_enabled: settings?.refresh_enabled !== false,
  fast: settings?.fast === true,
  // 农场是 Claude 专属能力：仅对 claude 账号带 farm_enrolled 字段。这里必须与
  // buildPatchRequest 的省略逻辑保持一致，否则「原始序列化」与「当前序列化」
  // 会因该字段有无而恒不相等，导致非 claude 账号误判为 dirty。
  // farm_enrolled 默认 false（老号免疫农场治理），与 refresh_enabled 的默认
  // true 语义相反——不能复用同一套「!== false」判断。
  ...(provider === 'claude' ? { farm_enrolled: settings?.farm_enrolled === true } : {}),
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

  // 农场是 Claude 专属能力：仅对 claude 账号在保存请求体里带 farm_enrolled；
  // 非 claude 账号省略该字段（后端 `*bool` 指针 nil=不改），避免给 codex 等
  // 写入无意义的 farm_enrolled。editor.provider 已由 resolveAuthFileProvider
  // 归一化为小写。必须与 normalizeSettings 的省略逻辑一致以避免误判 dirty。
  const isClaudeProvider = editor.provider === 'claude';

  return {
    request: {
      name: editor.fileName,
      proxy_url: editor.proxyUrl.trim() || null,
      note: editor.note.trim() || null,
      disabled: editor.disabled,
      refresh_enabled: editor.refreshEnabled,
      fast: editor.fast,
      ...(isClaudeProvider ? { farm_enrolled: editor.farmEnrolled } : {}),
      extra_headers: parsedHeaders.value || {},
      transport_profile: parsedTransportProfile.value,
      tls_profile: parsedTLSProfile.value,
    },
    error: null,
  };
};

/**
 * 迁移自旧弹窗：把下载到的原始 auth 文件文本解析成「可结构化编辑的对象」。
 * 只有 JSON 对象（非数组、非标量）才允许结构化编辑 prefix/priority/websockets
 * 并暴露可编辑的原始 JSON；否则回退为不可用（不臆造结构，避免误写多账号数组文件）。
 */
const parseRawAuthJson = (
  rawText: string
): { object: Record<string, unknown> | null; text: string } => {
  const trimmed = (rawText || '').trim();
  if (!trimmed) return { object: null, text: '' };
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isRecordObject(parsed)) {
      return { object: parsed, text: JSON.stringify(parsed, null, 2) };
    }
    // 数组/标量：保留原文供只读参考，但不开放结构化字段。
    return { object: null, text: trimmed };
  } catch {
    return { object: null, text: trimmed };
  }
};

/** 从原始 JSON 对象派生 prefix / priority / websockets 的初始编辑值。 */
const deriveRawEditableFields = (
  object: Record<string, unknown> | null,
  providerKey: string
): { prefix: string; priority: string; websockets: boolean } => {
  if (!object) return { prefix: '', priority: '', websockets: false };
  const prefix = typeof object.prefix === 'string' ? object.prefix : '';
  const priority = parsePriorityValue(object.priority);
  const websockets = supportsAuthFileWebsockets(providerKey)
    ? readAuthFileWebsockets(object)
    : false;
  return {
    prefix,
    priority: priority !== undefined ? String(priority) : '',
    websockets,
  };
};

/**
 * 计算 prefix / priority / websockets 相对原始 JSON 基线的增量补丁
 * （走 `/auth-files/fields`）。proxy_url / note / headers 不在此——它们由账号设置
 * 白名单 PATCH（proxy_url / note / extra_headers）负责，避免两个端点重复写同一字段。
 */
const buildRawFieldsPatch = (editor: AccountSettingsEditorState): AuthFileFieldsPatch => {
  const patch: AuthFileFieldsPatch = {};
  const original = editor.rawJsonObject ?? {};

  const originalPrefix = typeof original.prefix === 'string' ? original.prefix.trim() : '';
  const nextPrefix = editor.prefix.trim();
  if (nextPrefix !== originalPrefix) {
    patch.prefix = nextPrefix;
  }

  const originalPriority = parsePriorityValue(original.priority);
  const priorityText = editor.priority.trim();
  const nextPriority = parsePriorityValue(priorityText);
  if (!priorityText) {
    if (originalPriority !== undefined && originalPriority !== 0) {
      patch.priority = 0;
    }
  } else if (nextPriority !== undefined) {
    if (nextPriority === 0) {
      if (originalPriority !== undefined && originalPriority !== 0) {
        patch.priority = 0;
      }
    } else if (nextPriority !== originalPriority) {
      patch.priority = nextPriority;
    }
  }

  if (supportsAuthFileWebsockets(editor.providerKey)) {
    const originalWebsockets = readAuthFileWebsockets(original);
    const nextWebsockets = Boolean(editor.websockets);
    if (nextWebsockets !== originalWebsockets) {
      patch.websockets = nextWebsockets;
    }
  }

  return patch;
};

const hasRawFieldsPatch = (editor: AccountSettingsEditorState): boolean =>
  editor.rawJsonAvailable && Object.keys(buildRawFieldsPatch(editor)).length > 0;

/** 原始 JSON 文本是否被手工改动（相对格式化基线）。 */
const isRawJsonDirty = (editor: AccountSettingsEditorState): boolean =>
  editor.rawJsonAvailable &&
  editor.rawJsonTouched &&
  editor.rawJsonText.trim() !== editor.rawJsonBaseline.trim();

export function useAuthFilesAccountSettings(
  options: UseAuthFilesAccountSettingsOptions
): UseAuthFilesAccountSettingsResult {
  const { disableControls, loadFiles, loadKeyStats, accounts = [] } = options;
  const { t } = useTranslation();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const showConfirmation = useNotificationStore((state) => state.showConfirmation);

  const [accountSettingsEditor, setAccountSettingsEditor] =
    useState<AccountSettingsEditorState | null>(null);

  const accountSettingsUpdatedText = (() => {
    if (!accountSettingsEditor) return '';
    const { request, error } = buildPatchRequest(accountSettingsEditor);
    if (!request || error) return '';
    return JSON.stringify(request, null, 2);
  })();

  // 账号设置白名单是否被改动（proxy_url / note / disabled / refresh / fast /
  // farm_enrolled / extra_headers / transport / tls）。
  const accountSettingsWhitelistDirty =
    Boolean(accountSettingsEditor) &&
    accountSettingsUpdatedText !== '' &&
    accountSettingsUpdatedText !== accountSettingsEditor?.originalSerializedRequest;

  // 总 dirty = 账号设置白名单改动 ∪ 原始 JSON 字段（prefix/priority/websockets）改动
  // ∪ 手工编辑整份原始 JSON。任一改动都应让保存可用。
  const accountSettingsDirty =
    accountSettingsWhitelistDirty ||
    (accountSettingsEditor !== null &&
      (hasRawFieldsPatch(accountSettingsEditor) || isRawJsonDirty(accountSettingsEditor)));

  const closeAccountSettingsEditor = () => {
    setAccountSettingsEditor(null);
  };

  const hydrateEditor = (
    name: string,
    file: AuthFileItem,
    settings: Partial<AuthFileAccountSettings> | null | undefined,
    rawText?: string
  ) => {
    const provider = resolveAuthFileProvider(file, settings);
    const normalizedRequest = normalizeSettings(name, settings, provider);
    const { object: rawObject, text: rawJsonText } = parseRawAuthJson(rawText ?? '');
    const providerKey = normalizeProviderKey(
      String(
        rawObject?.type ?? rawObject?.provider ?? file.type ?? file.provider ?? provider ?? ''
      )
    );
    const rawFields = deriveRawEditableFields(rawObject, providerKey);
    setAccountSettingsEditor({
      fileName: name,
      file,
      authIndex: normalizeAuthIndex(file['auth_index'] ?? file.authIndex),
      provider,
      providerKey,
      fileInfoText: JSON.stringify(file, null, 2),
      prefix: rawFields.prefix,
      priority: rawFields.priority,
      websockets: rawFields.websockets,
      rawJsonAvailable: rawObject !== null,
      rawJsonObject: rawObject,
      rawJsonText,
      rawJsonBaseline: rawJsonText,
      rawJsonTouched: false,
      rawJsonError: null,
      loading: false,
      saving: false,
      error: null,
      proxyUrl: settings?.proxy_url || '',
      proxyUrlBaseline: settings?.proxy_url || '',
      proxyUrlError: computeProxyUrlError(settings?.proxy_url || ''),
      proxyUrlDuplicateError: null,
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
      file,
      authIndex: normalizeAuthIndex(file['auth_index'] ?? file.authIndex),
      provider: resolveAuthFileProvider(file, inlineSettings),
      providerKey: normalizeProviderKey(String(file.type ?? file.provider ?? '')),
      fileInfoText: JSON.stringify(file, null, 2),
      prefix: '',
      priority: '',
      websockets: false,
      rawJsonAvailable: false,
      rawJsonObject: null,
      rawJsonText: '',
      rawJsonBaseline: '',
      rawJsonTouched: false,
      rawJsonError: null,
      loading: true,
      saving: false,
      error: null,
      proxyUrl: inlineSettings?.proxy_url || '',
      proxyUrlBaseline: inlineSettings?.proxy_url || '',
      proxyUrlError: computeProxyUrlError(inlineSettings?.proxy_url || ''),
      proxyUrlDuplicateError: null,
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

    // 账号设置白名单视图与原始 auth JSON 并发拉取：原始 JSON 仅供 prefix/priority/
    // websockets 结构化编辑与整份 JSON 危险编辑，失败不阻断账号设置本身（降级为
    // 不可结构化编辑原始字段）。
    const [settingsResult, rawResult] = await Promise.allSettled([
      authFilesApi.getAccountSettings(name),
      authFilesApi.downloadText(name),
    ]);
    const rawText = rawResult.status === 'fulfilled' ? rawResult.value : '';

    if (settingsResult.status === 'fulfilled') {
      hydrateEditor(name, file, settingsResult.value, rawText);
      return;
    }

    if (inlineSettings) {
      hydrateEditor(name, file, inlineSettings, rawText);
      return;
    }

    const err = settingsResult.reason;
    const errorMessage = err instanceof Error ? err.message : t('notification.download_failed');
    setAccountSettingsEditor((prev) => {
      if (!prev || prev.fileName !== name) return prev;
      return { ...prev, loading: false, error: errorMessage };
    });
    showNotification(`${t('notification.download_failed')}: ${errorMessage}`, 'error');
  };

  const handleAccountSettingsChange = (
    field: AccountSettingsEditorField,
    value: AccountSettingsEditorFieldValue
  ) => {
    setAccountSettingsEditor((prev) => {
      if (!prev) return prev;
      if (field === 'proxyUrl') {
        const proxyUrl = String(value);
        return {
          ...prev,
          proxyUrl,
          proxyUrlError: computeProxyUrlError(proxyUrl),
          // 改动代理即清除上一次的查重冲突提示，重新编辑后需再次查重才知是否仍冲突。
          proxyUrlDuplicateError: null,
        };
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
      if (field === 'tlsProfileText') {
        const tlsProfileText = String(value);
        return {
          ...prev,
          tlsProfileText,
          tlsProfileTouched: true,
          tlsProfileError: parseProfileText(tlsProfileText).error,
        };
      }
      if (field === 'prefix') return { ...prev, prefix: String(value) };
      if (field === 'priority') return { ...prev, priority: String(value) };
      if (field === 'websockets') return { ...prev, websockets: Boolean(value) };
      if (field === 'rawJsonText') {
        const rawJsonText = String(value);
        const trimmed = rawJsonText.trim();
        let rawJsonError: string | null = null;
        if (!trimmed) {
          rawJsonError = t('auth_files.account_settings_raw_json_invalid', {
            defaultValue: 'Invalid JSON: content is empty.',
          });
        } else {
          try {
            const parsed = JSON.parse(trimmed) as unknown;
            if (!isRecordObject(parsed)) {
              rawJsonError = t('auth_files.account_settings_raw_json_invalid_object', {
                defaultValue: 'Auth JSON must be a single JSON object.',
              });
            }
          } catch {
            rawJsonError = t('auth_files.account_settings_raw_json_invalid', {
              defaultValue: 'Invalid JSON.',
            });
          }
        }
        return { ...prev, rawJsonText, rawJsonTouched: true, rawJsonError };
      }
      return prev;
    });
  };

  // 危险路径：手工编辑整份原始 auth JSON 后整份覆写（走 upload，不经账号设置白名单）。
  const performRawJsonOverwrite = async (name: string, rawJsonText: string) => {
    setAccountSettingsEditor((prev) =>
      prev && prev.fileName === name ? { ...prev, saving: true } : prev
    );
    try {
      await authFilesApi.saveText(name, rawJsonText);
      showNotification(t('auth_files.prefix_proxy_saved_success', { name }), 'success');
      await loadFiles();
      await loadKeyStats();
      setAccountSettingsEditor(null);
    } catch (err: unknown) {
      const rawMessage = err instanceof Error ? err.message : '';
      showNotification(`${t('notification.upload_failed')}: ${rawMessage}`, 'error');
      setAccountSettingsEditor((prev) =>
        prev && prev.fileName === name ? { ...prev, saving: false } : prev
      );
    }
  };

  const handleAccountSettingsSave = async () => {
    if (!accountSettingsEditor || !accountSettingsDirty) return;
    const editor = accountSettingsEditor;

    // 危险路径优先：手工改过整份原始 JSON —— 只校验 JSON 合法性 + 二次确认 + 整份覆写，
    // 不再叠加账号设置白名单 / 字段补丁（原始 JSON 已是完整真源）。
    if (isRawJsonDirty(editor)) {
      let validObject = false;
      try {
        validObject = isRecordObject(JSON.parse(editor.rawJsonText.trim()));
      } catch {
        validObject = false;
      }
      if (!validObject) {
        const message = t('auth_files.account_settings_raw_json_invalid_object', {
          defaultValue: 'Auth JSON must be a single JSON object.',
        });
        setAccountSettingsEditor((prev) =>
          prev && prev.fileName === editor.fileName
            ? { ...prev, rawJsonError: message }
            : prev
        );
        showNotification(message, 'error');
        return;
      }
      showConfirmation({
        title: t('auth_files.account_settings_raw_json_confirm_title', {
          defaultValue: 'Overwrite raw auth JSON?',
        }),
        message: t('auth_files.account_settings_raw_json_confirm_message', {
          defaultValue:
            'Editing the raw auth JSON directly can break this account (invalid credentials or lost identity binding). Saving overwrites the entire auth file. Continue?',
        }),
        confirmText: t('auth_files.account_settings_raw_json_confirm_ok', {
          defaultValue: 'Overwrite auth JSON',
        }),
        cancelText: t('common.cancel'),
        variant: 'danger',
        onConfirm: () => {
          void performRawJsonOverwrite(editor.fileName, editor.rawJsonText);
        },
      });
      return;
    }

    // proxy_url 必填 + 格式校验：为空或非法时前端拦截，不提交（T041：core#26/#27 服务端守卫呼应）。
    const proxyError = computeProxyUrlError(editor.proxyUrl);
    if (proxyError) {
      setAccountSettingsEditor((prev) =>
        prev ? { ...prev, proxyUrlError: proxyError } : prev
      );
      showNotification(t(proxyUrlErrorKey(proxyError)), 'error');
      return;
    }

    // L2 查重（本地秒级，先于慢的连通性探针 fail-fast）：仅当代理相对基线发生变更（或新填）时
    // 才查重——未变更=账号自身既有值，不算重复，直接放行。命中其它现有账号占用即阻断，不进探针、
    // 不落库（两个账号共用同一出口会 IP 聚类被关联）。excludeName 排除自身作纵深防御。
    const trimmedProxy = editor.proxyUrl.trim();
    const baselineProxy = (editor.proxyUrlBaseline || '').trim();
    if (trimmedProxy && trimmedProxy !== baselineProxy) {
      const conflicts = findAccountsUsingProxy(
        editor.proxyUrl,
        accounts.map(toProxyOwnerAccount),
        { excludeName: editor.fileName }
      );
      if (conflicts.length > 0) {
        const message = t('proxy_preflight.duplicate_account', {
          accounts: conflicts.join('、'),
        });
        setAccountSettingsEditor((prev) =>
          prev && prev.fileName === editor.fileName
            ? { ...prev, proxyUrlDuplicateError: message }
            : prev
        );
        showNotification(message, 'error');
        return;
      }
    }

    // 格式过后再做后端连通性探针：不通就不落库（fail-closed），把 proxy_url 标红并提示；
    // 通了展示出口 IP 再继续保存。探测期间置 saving，禁用保存/关闭按钮防重复提交。
    // 仅当 proxy_url 相对打开时的原值发生变更（或新填）时才探针：未变更（逐字符相同）直接放行，
    // 避免用户只改其它字段时被临时不通的旧代理阻断（该值此前已校验/已落库，后端仍兜底）。
    setAccountSettingsEditor((prev) =>
      prev && prev.fileName === editor.fileName ? { ...prev, saving: true } : prev
    );
    const preflight = await runProxyPreflight(editor.proxyUrl, {
      formatValidator: () => ({ valid: true }),
      translate: (reason) => t(`proxy_preflight.reason_${reason}`),
      previousProxyUrl: editor.proxyUrlBaseline,
    });
    if (!preflight.ok) {
      setAccountSettingsEditor((prev) =>
        prev && prev.fileName === editor.fileName
          ? { ...prev, saving: false, proxyUrlError: 'invalid' }
          : prev
      );
      showNotification(preflight.message, 'error');
      return;
    }
    // 未变更放行时不做探针、无出口 IP，跳过「已连通(出口 IP)」提示；只有真正探针成功才展示。
    if (preflight.exitIp) {
      showNotification(
        t('proxy_preflight.connected_with_ip', { ip: preflight.exitIp }),
        'success'
      );
    }

    const { request, error } = buildPatchRequest(editor);
    if (!request) {
      const errorMessage = error?.startsWith('auth_files.') ? t(error) : error || 'Invalid format';
      // 探针阶段已置 saving=true，这里失败要复位，避免保存按钮永久 loading。
      setAccountSettingsEditor((prev) =>
        prev && prev.fileName === editor.fileName ? { ...prev, saving: false } : prev
      );
      showNotification(errorMessage, 'error');
      return;
    }

    // prefix / priority / websockets 走 `/auth-files/fields` 原始 JSON 补丁；只在真正
    // 改动时追加一次请求（与账号设置白名单 PATCH 的字段不重叠，顺序执行不冲突）。
    const fieldsPatch = buildRawFieldsPatch(editor);
    const shouldPatchFields = editor.rawJsonAvailable && Object.keys(fieldsPatch).length > 0;

    setAccountSettingsEditor((prev) => {
      if (!prev) return prev;
      return { ...prev, saving: true };
    });

    try {
      // 账号设置白名单未改动（仅改了原始字段）时可省略该请求，避免无谓写回。
      if (accountSettingsWhitelistDirty) {
        await authFilesApi.updateAccountSettings(request);
      }
      if (shouldPatchFields) {
        await authFilesApi.patchFields(editor.fileName, fieldsPatch);
      }
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
