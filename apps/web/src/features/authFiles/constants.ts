import type { TFunction } from 'i18next';
import iconAntigravity from '@/assets/icons/antigravity.svg';
import iconClaude from '@/assets/icons/claude.svg';
import iconCodex from '@/assets/icons/codex.svg';
import iconGemini from '@/assets/icons/gemini.svg';
import iconGrok from '@/assets/icons/grok.svg';
import iconGrokDark from '@/assets/icons/grok-dark.svg';
import iconIflow from '@/assets/icons/iflow.svg';
import iconKimiDark from '@/assets/icons/kimi-dark.svg';
import iconKimiLight from '@/assets/icons/kimi-light.svg';
import iconQwen from '@/assets/icons/qwen.svg';
import iconVertex from '@/assets/icons/vertex.svg';
import type { AuthFileItem } from '@/types';
import { parseTimestamp } from '@/utils/timestamp';
import { formatInUtc8 } from '@/utils/format';

export type ThemeColors = { bg: string; text: string; border?: string };
export type TypeColorSet = { light: ThemeColors; dark?: ThemeColors };
export type ResolvedTheme = 'light' | 'dark';
export type AuthFileModelItem = {
  id: string;
  display_name?: string;
  type?: string;
  owned_by?: string;
};
export type AuthFileIconAsset = string | { light: string; dark: string };

export type QuotaProviderType = 'antigravity' | 'claude' | 'codex' | 'kimi' | 'xai';

export const QUOTA_PROVIDER_TYPES = new Set<QuotaProviderType>([
  'antigravity',
  'claude',
  'codex',
  'kimi',
  'xai',
]);

export const MIN_CARD_PAGE_SIZE = 3;
export const MAX_CARD_PAGE_SIZE = 30;
export const AUTH_FILE_REFRESH_WARNING_MS = 24 * 60 * 60 * 1000;

export const INTEGER_STRING_PATTERN = /^[+-]?\d+$/;
export const TRUTHY_TEXT_VALUES = new Set(['true', '1', 'yes', 'y', 'on']);
export const FALSY_TEXT_VALUES = new Set(['false', '0', 'no', 'n', 'off']);
export const AUTH_FILE_WEBSOCKET_PROVIDERS = new Set(['codex', 'xai']);

// 标签类型颜色配置 — 基于各提供商 Logo 品牌色调配，确保彼此不重复
export const TYPE_COLORS: Record<string, TypeColorSet> = {
  // Qwen logo: 紫罗兰渐变 #6336E7 → #6F69F7
  qwen: {
    light: { bg: '#ede5fd', text: '#5530c7' },
    dark: { bg: '#36208a', text: '#b5a3f0' },
  },
  // Kimi logo: 亮蓝 #027AFF（K字 + 蓝色圆点）
  kimi: {
    light: { bg: '#dce8ff', text: '#0560cf' },
    dark: { bg: '#003880', text: '#70b5ff' },
  },
  // Gemini logo: 多色蓝 #3186FF（偏柔和的蓝）
  gemini: {
    light: { bg: '#e3f2fd', text: '#1565c0' },
    dark: { bg: '#0d47a1', text: '#64b5f6' },
  },
  // AI Studio: 使用 Gemini 图标，中性灰标签
  aistudio: {
    light: { bg: '#f0f2f5', text: '#2f343c' },
    dark: { bg: '#373c42', text: '#cfd3db' },
  },
  // Claude logo: 陶土橙 #D97757
  claude: {
    light: { bg: '#fbece4', text: '#c05621' },
    dark: { bg: '#5e2c14', text: '#e8a882' },
  },
  // Codex logo: 靛蓝渐变 #B1A7FF → #3941FF
  codex: {
    light: { bg: '#eae7ff', text: '#3538d4' },
    dark: { bg: '#262395', text: '#b5b0ff' },
  },
  // Antigravity logo: 多色（主色 #3789F9 蓝 + #53A89A 青绿），用青色区分
  antigravity: {
    light: { bg: '#e0f7fa', text: '#006064' },
    dark: { bg: '#004d40', text: '#80deea' },
  },
  // xAI / Grok: graphite brand treatment, distinct from blue and purple providers
  xai: {
    light: { bg: '#f3f4f6', text: '#111827', border: '1px solid #d1d5db' },
    dark: { bg: '#111827', text: '#f9fafb', border: '1px solid #374151' },
  },
  // iFlow logo: 品红紫渐变 #5C5CFF → #AE5CFF，偏品红以区别于 Qwen 的紫罗兰
  iflow: {
    light: { bg: '#f5e3fc', text: '#9025c8' },
    dark: { bg: '#521490', text: '#d49cf5' },
  },
  // Vertex logo: Google 蓝 #4285F4
  vertex: {
    light: { bg: '#e4edfd', text: '#2b5fbc' },
    dark: { bg: '#1a3d80', text: '#89b3f7' },
  },
  empty: {
    light: { bg: '#f5f5f5', text: '#616161' },
    dark: { bg: '#424242', text: '#bdbdbd' },
  },
  unknown: {
    light: { bg: '#f0f0f0', text: '#666666', border: '1px dashed #999999' },
    dark: { bg: '#3a3a3a', text: '#aaaaaa', border: '1px dashed #666666' },
  },
};

export const AUTH_FILE_ICONS: Record<string, AuthFileIconAsset> = {
  antigravity: iconAntigravity,
  aistudio: iconGemini,
  claude: iconClaude,
  codex: iconCodex,
  gemini: iconGemini,
  xai: { light: iconGrok, dark: iconGrokDark },
  iflow: iconIflow,
  kimi: { light: iconKimiLight, dark: iconKimiDark },
  qwen: iconQwen,
  vertex: iconVertex,
};

export const clampCardPageSize = (value: number) =>
  Math.min(MAX_CARD_PAGE_SIZE, Math.max(MIN_CARD_PAGE_SIZE, Math.round(value)));

export const resolveQuotaErrorMessage = (
  t: TFunction,
  status: number | undefined,
  fallback: string
): string => {
  if (status === 404) return t('common.quota_update_required');
  if (status === 403) return t('common.quota_check_credential');
  return fallback;
};

export const normalizeProviderKey = (value: string) => {
  const key = value.trim().toLowerCase().replace(/_/g, '-');
  if (key === 'x-ai' || key === 'grok') return 'xai';
  return key;
};

export const getAuthFileStatusMessage = (file: AuthFileItem): string => {
  const raw = file['status_message'] ?? file.statusMessage;
  if (typeof raw === 'string') return raw.trim();
  if (raw == null) return '';
  return String(raw).trim();
};

export const hasAuthFileStatusMessage = (file: AuthFileItem): boolean =>
  getAuthFileStatusMessage(file).length > 0;

export const isHealthyAuthFile = (file: AuthFileItem): boolean =>
  file.disabled !== true && !hasAuthFileStatusMessage(file);

// --- 迁移自 cpa fork：身份隔离/账号设置相关的结构化状态判定 ---
// 与上面基于 status_message 文本的 isHealthyAuthFile 并存，不替换：
// isHealthyAuthFile 是既有卡片健康态判定的既有入口，继续保留；
// hasAuthFileStatusWarning 是 cpa 新增的更细粒度判定（结构化 unavailable/status
// 优先，legacy status_message 白名单兜底），供 Phase 2 身份隔离弹窗/审计面板使用。

/**
 * 归一 core 顶层 `status` 字段（snake/camel 都从同名字段读，core 实际是顶层 `status`）。
 * 返回小写 trim 后的字符串；缺省返回空串。
 */
export const getAuthFileStatusValue = (file: AuthFileItem): string => {
  const raw = file.status;
  if (typeof raw === 'string') return raw.trim().toLowerCase();
  if (raw == null) return '';
  return String(raw).trim().toLowerCase();
};

/**
 * 归一 core 顶层 `unavailable`(boolean) 字段，兼容 snake_case / camelCase 与字符串布尔。
 * 这是「账号是否不可用」的机器真源（core#26/#27 缺 proxy_url 等会置 true），
 * 优先于 status_message 文本判断。返回 undefined 表示该 payload 没有显式下发该字段。
 */
export const getAuthFileUnavailable = (file: AuthFileItem): boolean | undefined => {
  const raw = file.unavailable ?? file['is_unavailable'] ?? file['isUnavailable'];
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw !== 0;
  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase();
    if (!normalized) return undefined;
    if (TRUTHY_TEXT_VALUES.has(normalized)) return true;
    if (FALSY_TEXT_VALUES.has(normalized)) return false;
  }
  return undefined;
};

/**
 * 健康态 `status` 值白名单（用于「core 下发了 status 但未下发 unavailable」的兼容判断）。
 * 仅作为结构化 status 字段的判定，不再用 status_message 自由文本做关键字匹配。
 */
export const HEALTHY_AUTH_FILE_STATUS_VALUES = new Set([
  'ok',
  'healthy',
  'ready',
  'active',
  'available',
  'success',
]);

/**
 * 旧 payload 兼容回退：当 core 既没下发结构化 `unavailable` 也没下发 `status` 时，
 * 退化为旧的 status_message 文本白名单判断。仅在结构化字段全缺时才走到这里。
 */
const HEALTHY_AUTH_FILE_STATUS_MESSAGES = new Set([
  'ok',
  'healthy',
  'ready',
  'success',
  'available',
]);

const hasLegacyStatusMessageWarning = (file: AuthFileItem): boolean => {
  const rawStatusMessage = getAuthFileStatusMessage(file);
  return (
    Boolean(rawStatusMessage) &&
    !HEALTHY_AUTH_FILE_STATUS_MESSAGES.has(rawStatusMessage.toLowerCase())
  );
};

/**
 * 是否处于「告警 / 不可用」态。判定优先级（迁移自 cpa fork T047 改造）：
 *  1. core 顶层结构化 `unavailable`(boolean)：显式 true=告警，显式 false=健康。
 *  2. core 顶层结构化 `status`：非健康白名单值即告警。
 *  3. 两者都缺时，回退旧 status_message 文本白名单（兼容历史 payload）。
 * status_message 退化为纯展示文案，不再作为判定真源。
 */
export const hasAuthFileStatusWarning = (file: AuthFileItem): boolean => {
  const unavailable = getAuthFileUnavailable(file);
  if (unavailable !== undefined) return unavailable;

  const status = getAuthFileStatusValue(file);
  if (status) return !HEALTHY_AUTH_FILE_STATUS_VALUES.has(status);

  return hasLegacyStatusMessageWarning(file);
};

/**
 * 解析账号视图的 warnings（core#26/#27 在 account 视图 `warnings []string` 下发，
 * 例如缺失 proxy_url 的不可用账号）。兼容 snake_case / camelCase 两种 account_settings 键。
 */
export const getAuthFileWarnings = (file: AuthFileItem): string[] => {
  const settings = file.account_settings || file.accountSettings || null;
  const warnings = settings?.warnings;
  if (!Array.isArray(warnings)) return [];
  return warnings.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
};

/**
 * 是否缺失 proxy_url（住宅代理）。优先用 core 下发的 warnings 命中 "proxy_url" 关键字；
 * 退化情况下，非虚拟账号且 account_settings.proxy_url 为空也判定为缺失。
 * 让账号卡片一眼看出哪个号缺 proxy、需要补填，避免请求直连暴露真 IP。
 */
export const isAuthFileMissingProxyUrl = (file: AuthFileItem): boolean => {
  const warnings = getAuthFileWarnings(file);
  if (warnings.some((warning) => warning.toLowerCase().includes('proxy_url'))) {
    return true;
  }
  if (isRuntimeOnlyAuthFile(file)) return false;
  const settings = file.account_settings || file.accountSettings || null;
  if (!settings) return false;
  return typeof settings.proxy_url === 'string' && settings.proxy_url.trim() === '';
};

export const getTypeLabel = (t: TFunction, type: string): string => {
  const providerKey = normalizeProviderKey(type);
  const key = `auth_files.filter_${providerKey}`;
  const translated = t(key);
  if (translated !== key) return translated;
  if (providerKey === 'iflow') return 'iFlow';
  return type.charAt(0).toUpperCase() + type.slice(1);
};

export const getTypeColor = (type: string, resolvedTheme: ResolvedTheme): ThemeColors => {
  const set = TYPE_COLORS[normalizeProviderKey(type)] || TYPE_COLORS.unknown;
  return resolvedTheme === 'dark' && set.dark ? set.dark : set.light;
};

export const getAuthFileIcon = (type: string, resolvedTheme: ResolvedTheme): string | null => {
  const iconEntry = AUTH_FILE_ICONS[normalizeProviderKey(type)];
  if (!iconEntry) return null;
  return typeof iconEntry === 'string'
    ? iconEntry
    : resolvedTheme === 'dark'
      ? iconEntry.dark
      : iconEntry.light;
};

export const parsePriorityValue = (value: unknown): number | undefined => {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : undefined;
  }

  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || !INTEGER_STRING_PATTERN.test(trimmed)) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
};

export const normalizeExcludedModels = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const normalized: string[] = [];
  value.forEach((entry) => {
    const model = String(entry ?? '')
      .trim()
      .toLowerCase();
    if (!model || seen.has(model)) return;
    seen.add(model);
    normalized.push(model);
  });

  return normalized.sort((a, b) => a.localeCompare(b));
};

export const parseExcludedModelsText = (value: string): string[] =>
  normalizeExcludedModels(value.split(/[\n,]+/));

export const parseDisableCoolingValue = (value: unknown): boolean | undefined => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value !== 0;
  if (typeof value !== 'string') return undefined;

  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (TRUTHY_TEXT_VALUES.has(normalized)) return true;
  if (FALSY_TEXT_VALUES.has(normalized)) return false;
  return undefined;
};

export const supportsAuthFileWebsockets = (providerKey: string): boolean =>
  AUTH_FILE_WEBSOCKET_PROVIDERS.has(normalizeProviderKey(providerKey));

export const readAuthFileWebsockets = (value: Record<string, unknown>): boolean =>
  parseDisableCoolingValue(value.websockets ?? value.websocket) ?? false;

export const applyAuthFileWebsockets = (
  value: Record<string, unknown>,
  websockets: boolean
): Record<string, unknown> => {
  const next = { ...value };
  delete next.websocket;
  next.websockets = websockets;
  return next;
};

export const readCodexAuthFileWebsockets = readAuthFileWebsockets;
export const applyCodexAuthFileWebsockets = applyAuthFileWebsockets;

export function isRuntimeOnlyAuthFile(file: AuthFileItem): boolean {
  const raw = file['runtime_only'] ?? file.runtimeOnly;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') return raw.trim().toLowerCase() === 'true';
  return false;
}

export const formatModified = (item: AuthFileItem): string => {
  const raw = item['modtime'] ?? item.modified;
  if (!raw) return '-';
  const asNumber = Number(raw);
  const date =
    Number.isFinite(asNumber) && !Number.isNaN(asNumber)
      ? new Date(asNumber < 1e12 ? asNumber * 1000 : asNumber)
      : parseTimestamp(raw) ?? new Date(String(raw));
  // 与旧版一致：强制 UTC+8（Asia/Shanghai）展示，不跟随浏览器本地时区。
  return Number.isNaN(date.getTime())
    ? '-'
    : formatInUtc8(
        date,
        { dateStyle: 'medium', timeStyle: 'medium', withZoneLabel: true },
        undefined,
        '-'
      );
};

// 检查模型是否被 OAuth 排除
export const isModelExcluded = (
  modelId: string,
  providerType: string,
  excluded: Record<string, string[]>
): boolean => {
  const providerKey = normalizeProviderKey(providerType);
  const excludedModels = excluded[providerKey] || excluded[providerType] || [];
  return excludedModels.some((pattern) => {
    if (pattern.includes('*')) {
      // 支持通配符匹配：先转义正则特殊字符，再将 * 视为通配符
      const regexSafePattern = pattern
        .split('*')
        .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*');
      const regex = new RegExp(`^${regexSafePattern}$`, 'i');
      return regex.test(modelId);
    }
    return pattern.toLowerCase() === modelId.toLowerCase();
  });
};
