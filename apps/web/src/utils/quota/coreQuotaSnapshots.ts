/**
 * 把 core `GET /quota/snapshots` 的持久快照适配成 cpamp 认证文件页可用的
 * observed quota 输入（CodexQuotaState / ClaudeQuotaState）。
 *
 * core 快照是只读、周期由 core 后台调度器刷新写入的持久数据，前端只在挂载时
 * 拉一次，不据此自建 provider 轮询；因此这里产出的状态只作为 observed 兜底，
 * 通过 `resolveQuotaDisplayState` 与 cooldown 恢复 / expiry 触发的真实刷新结果
 * 合并，不覆盖后者。
 *
 * 多身份场景下同名文件可能对应不同 auth_index/auth_id（身份隔离），所以匹配
 * 沿用 `usageHeaderSnapshots.ts` 的多键 + 置信度策略：auth_id 精确匹配优先于
 * name+auth_index 组合，再退化到单独 name 匹配，避免同名不同账号串号。
 */

import type { TFunction } from 'i18next';
import type { AuthFileItem, ClaudeExtraUsage, ClaudeQuotaState, ClaudeQuotaWindow, ClaudeUsagePayload, CodexQuotaState, CodexUsagePayload } from '@/types';
import type { CoreQuotaSnapshotEntry } from '@/services/api/quotaSnapshots';
import { normalizeAuthIndex } from '@/utils/authIndex';
import {
  CLAUDE_USAGE_WINDOW_KEYS,
  buildCodexQuotaWindows,
  formatQuotaResetTime,
  normalizeNumberValue,
  normalizePlanType,
  normalizeStringValue,
  parseClaudeUsagePayload,
  parseCodexUsagePayload,
  resolveCodexPlanType,
} from '@/utils/quota';
import { parseCoreQuotaTimestamp } from '@/services/api/quotaSnapshots';

export type CoreQuotaSnapshotMatchConfidence = 'none' | 'low' | 'high';

export type CoreQuotaSnapshotMatch = {
  entry?: CoreQuotaSnapshotEntry;
  confidence: CoreQuotaSnapshotMatchConfidence;
};

export interface CoreQuotaSnapshotLookup {
  byAuthId: Map<string, CoreQuotaSnapshotEntry>;
  byNameAuthIndex: Map<string, CoreQuotaSnapshotEntry>;
  byName: Map<string, CoreQuotaSnapshotEntry>;
}

const normalizeKey = (value: unknown): string =>
  typeof value === 'string'
    ? value.trim().toLowerCase()
    : typeof value === 'number'
      ? String(value).trim().toLowerCase()
      : '';

const nameAuthIndexKey = (name: string, authIndex: string): string =>
  name && authIndex ? `${normalizeKey(name)}::${normalizeKey(authIndex)}` : '';

const entryTimestampMs = (entry: CoreQuotaSnapshotEntry): number => {
  const date = parseCoreQuotaTimestamp(entry.last_refreshed_at);
  return date ? date.getTime() : 0;
};

const newerEntry = (
  current: CoreQuotaSnapshotEntry | undefined,
  next: CoreQuotaSnapshotEntry
): CoreQuotaSnapshotEntry => {
  if (!current) return next;
  return entryTimestampMs(next) >= entryTimestampMs(current) ? next : current;
};

const setNewest = (
  map: Map<string, CoreQuotaSnapshotEntry>,
  key: string,
  entry: CoreQuotaSnapshotEntry
) => {
  if (!key) return;
  map.set(key, newerEntry(map.get(key), entry));
};

export const buildCoreQuotaSnapshotLookup = (
  entries: CoreQuotaSnapshotEntry[] = []
): CoreQuotaSnapshotLookup => {
  const lookup: CoreQuotaSnapshotLookup = {
    byAuthId: new Map(),
    byNameAuthIndex: new Map(),
    byName: new Map(),
  };

  entries.forEach((entry) => {
    const authId = normalizeKey(entry.auth_id);
    const name = normalizeStringValue(entry.name) ?? '';
    const authIndex = normalizeAuthIndex(entry.auth_index) ?? '';

    setNewest(lookup.byAuthId, authId, entry);
    setNewest(lookup.byNameAuthIndex, nameAuthIndexKey(name, authIndex), entry);
    setNewest(lookup.byName, normalizeKey(name), entry);
  });

  return lookup;
};

const matchOf = (
  entry: CoreQuotaSnapshotEntry | undefined,
  confidence: CoreQuotaSnapshotMatchConfidence
): CoreQuotaSnapshotMatch => (entry ? { entry, confidence } : { confidence: 'none' });

const confidenceRank: Record<CoreQuotaSnapshotMatchConfidence, number> = {
  none: 0,
  low: 1,
  high: 2,
};

const preferMatch = (
  current: CoreQuotaSnapshotMatch,
  next: CoreQuotaSnapshotMatch
): CoreQuotaSnapshotMatch => {
  if (!next.entry) return current;
  if (!current.entry) return next;
  return confidenceRank[next.confidence] > confidenceRank[current.confidence] ? next : current;
};

/**
 * 按 auth_id > name+auth_index > name 的优先级匹配 core 快照条目。
 *
 * auth_id 精确匹配和 name+auth_index 组合匹配都视为高置信度（身份隔离场景下
 * 足以区分同名文件的不同账号）；只有单独 name 匹配（缺少 auth_index 时的
 * 退化路径）才标记为低置信度。
 */
export const getCoreQuotaSnapshotMatchForAuthFile = (
  lookup: CoreQuotaSnapshotLookup | undefined,
  file: AuthFileItem
): CoreQuotaSnapshotMatch => {
  if (!lookup) return { confidence: 'none' };

  const authId = normalizeKey(file['auth_id']);
  const name = file.name ?? '';
  const authIndex = normalizeAuthIndex(file['auth_index'] ?? file.authIndex) ?? '';

  const candidates: CoreQuotaSnapshotMatch[] = [
    matchOf(lookup.byAuthId.get(authId), 'high'),
    matchOf(lookup.byNameAuthIndex.get(nameAuthIndexKey(name, authIndex)), 'high'),
    matchOf(authIndex ? undefined : lookup.byName.get(normalizeKey(name)), 'low'),
  ];

  return candidates.reduce<CoreQuotaSnapshotMatch>(
    (acc, candidate) => preferMatch(acc, candidate),
    { confidence: 'none' }
  );
};

export const getCoreQuotaSnapshotForAuthFile = (
  lookup: CoreQuotaSnapshotLookup | undefined,
  file: AuthFileItem
): CoreQuotaSnapshotEntry | undefined =>
  getCoreQuotaSnapshotMatchForAuthFile(lookup, file).entry;

export const getHighConfidenceCoreQuotaSnapshotForAuthFile = (
  lookup: CoreQuotaSnapshotLookup | undefined,
  file: AuthFileItem
): CoreQuotaSnapshotEntry | undefined => {
  const match = getCoreQuotaSnapshotMatchForAuthFile(lookup, file);
  return match.confidence === 'high' ? match.entry : undefined;
};

const isSupportedCoreQuotaSnapshotStatus = (entry: CoreQuotaSnapshotEntry): boolean =>
  entry.status === 'ok' || Boolean(entry.snapshot && Object.keys(entry.snapshot).length > 0);

const readCodexUsagePayload = (
  entry: CoreQuotaSnapshotEntry | undefined
): CodexUsagePayload | null => {
  const raw = entry?.snapshot?.usage;
  return parseCodexUsagePayload(raw) ?? null;
};

/**
 * 把 core codex 快照（`{usage: CodexUsagePayload}`）适配成 CodexQuotaState，
 * 复用与 header-snapshot observed 路径一致的 `buildCodexQuotaWindows` 渲染逻辑。
 */
export const buildObservedCodexQuotaStateFromCoreSnapshot = (
  file: AuthFileItem,
  entry: CoreQuotaSnapshotEntry | undefined,
  t: TFunction
): CodexQuotaState | undefined => {
  if (!entry || !isSupportedCoreQuotaSnapshotStatus(entry)) return undefined;
  const usage = readCodexUsagePayload(entry);
  if (!usage) return undefined;

  const planTypeFromSnapshot = normalizePlanType(entry.plan_type ?? usage.plan_type ?? usage.planType);
  const planType = resolveCodexPlanType(file) ?? planTypeFromSnapshot ?? null;
  const windows = buildCodexQuotaWindows(usage, t, planType);
  const observedAtMs = parseCoreQuotaTimestamp(entry.last_refreshed_at)?.getTime();

  return {
    status: 'success',
    windows,
    planType,
    observedFromUsageHeaders: true,
    observedResetCreditsUnknown: true,
    observedAtMs,
  };
};

const readClaudeUsagePayload = (
  entry: CoreQuotaSnapshotEntry | undefined
): ClaudeUsagePayload | null => {
  const raw = entry?.snapshot?.usage;
  return parseClaudeUsagePayload(raw) ?? null;
};

const readClaudeExtraUsage = (usage: ClaudeUsagePayload | null): ClaudeExtraUsage | null =>
  usage?.extra_usage ?? null;

const buildClaudeQuotaWindowsFromSnapshot = (
  usage: ClaudeUsagePayload,
  t: TFunction
): ClaudeQuotaWindow[] => {
  const windows: ClaudeQuotaWindow[] = [];

  for (const { key, id, labelKey } of CLAUDE_USAGE_WINDOW_KEYS) {
    const window = usage[key as keyof ClaudeUsagePayload];
    if (!window || typeof window !== 'object' || !('utilization' in window)) continue;
    const typedWindow = window as { utilization: number; resets_at: string };
    windows.push({
      id,
      label: t(labelKey),
      labelKey,
      usedPercent: normalizeNumberValue(typedWindow.utilization),
      resetLabel: formatQuotaResetTime(typedWindow.resets_at),
    });
  }

  return windows;
};

const readBooleanFlag = (value: unknown): boolean | undefined => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  }
  return undefined;
};

/**
 * core 侧的 plan_type 已经是归一化后的字符串（"max" / "pro" / "free" / ...，见
 * `inferClaudePlanType`），这里映射为 cpamp `claude_quota.*` i18n key 使用的
 * `plan_max` / `plan_pro` / `plan_team` / `plan_free` 前缀；未知取值原样透传，
 * 交给渲染层按 `claude_quota.${planType}` 兜底。
 */
const normalizeClaudePlanTypeFromSnapshot = (
  entry: CoreQuotaSnapshotEntry,
  profile: Record<string, unknown> | null
): string | null => {
  const rawPlanType = normalizeStringValue(entry.plan_type)?.toLowerCase() ?? '';
  if (rawPlanType === 'max') return 'plan_max';
  if (rawPlanType === 'pro') return 'plan_pro';
  if (rawPlanType === 'free') return 'plan_free';
  if (rawPlanType) return rawPlanType;

  if (!profile) return null;
  const account = profile.account as Record<string, unknown> | undefined;
  if (readBooleanFlag(account?.has_claude_max)) return 'plan_max';
  if (readBooleanFlag(account?.has_claude_pro)) return 'plan_pro';
  const organization = profile.organization as Record<string, unknown> | undefined;
  const organizationType = normalizeStringValue(organization?.organization_type)?.toLowerCase();
  const subscriptionStatus = normalizeStringValue(organization?.subscription_status)?.toLowerCase();
  if (organizationType === 'claude_team' && subscriptionStatus === 'active') return 'plan_team';
  if (readBooleanFlag(account?.has_claude_max) === false && readBooleanFlag(account?.has_claude_pro) === false) {
    return 'plan_free';
  }
  return null;
};

/**
 * 把 core claude 快照（`{profile: ClaudeProfileResponse, usage: ClaudeUsagePayload}`）
 * 适配成 ClaudeQuotaState。
 */
export const buildObservedClaudeQuotaStateFromCoreSnapshot = (
  _file: AuthFileItem,
  entry: CoreQuotaSnapshotEntry | undefined,
  t: TFunction
): ClaudeQuotaState | undefined => {
  if (!entry || !isSupportedCoreQuotaSnapshotStatus(entry)) return undefined;
  const usage = readClaudeUsagePayload(entry);
  if (!usage) return undefined;

  const profile =
    entry.snapshot?.profile && typeof entry.snapshot.profile === 'object'
      ? (entry.snapshot.profile as Record<string, unknown>)
      : null;

  return {
    status: 'success',
    windows: buildClaudeQuotaWindowsFromSnapshot(usage, t),
    extraUsage: readClaudeExtraUsage(usage),
    planType: normalizeClaudePlanTypeFromSnapshot(entry, profile),
  };
};
