import type {
  MonitoringAnalyticsEventsPageRequest,
  MonitoringAnalyticsInclude,
} from '@/services/api/usageService';
import type { MonitoringDataTab } from '../monitoringCenterUiState';
import {
  buildMonitoringUnsupportedFocusFilterValue,
  isMonitoringUnsupportedFocusFilterValue,
  parseMonitoringAccountFilterValue,
  readMonitoringAccountFocusId,
} from './analyticsAdapters';
import type { MonitoringAccountRow, MonitoringTimeRange } from './types';

/**
 * Keep the monitoring request bounded to the data panel that is currently
 * visible.  Summary is deliberately compact because the monitoring page only
 * renders the core counters; the full-only diagnostics are owned by the
 * dedicated analytics page.
 */
export const buildMonitoringCenterAnalyticsInclude = (
  activeDataTab: MonitoringDataTab,
  granularity: 'hour' | 'day',
  eventsPage?: MonitoringAnalyticsEventsPageRequest | null
): MonitoringAnalyticsInclude => {
  const include: MonitoringAnalyticsInclude = {
    summary: true,
    summary_profile: 'compact',
    granularity,
  };

  if (activeDataTab === 'accounts') {
    include.account_stats = true;
  } else if (activeDataTab === 'apiKeys') {
    include.api_key_stats = true;
  } else if (activeDataTab === 'realtime' && eventsPage) {
    include.events_page = eventsPage;
  }

  return include;
};

/**
 * Selector loading is independent from the visible data tab.  Keep
 * filter_options in the request for older Manager Server versions; current
 * servers prioritize filter_selectors and return the inexpensive selector
 * payload instead of recomputing all dimension aggregates.
 */
export const buildMonitoringFilterSelectorsInclude = (): MonitoringAnalyticsInclude => ({
  filter_options: true,
  filter_selectors: true,
  account_focus: true,
});

/** 收集本轮服务端在 account_stats 行上确实返回的非空 account_focus_id（原样）。 */
export const collectIssuedAccountFocusIds = (
  ...groups: ReadonlyArray<ReadonlyArray<{ account_focus_id?: string | null }> | null | undefined>
) => {
  const ids = new Set<string>();
  groups.forEach((rows) =>
    (rows ?? []).forEach((row) => {
      const id = typeof row.account_focus_id === 'string' ? row.account_focus_id.trim() : '';
      if (id) ids.add(id);
    })
  );
  return ids;
};

export type MonitoringAccountFocusState =
  | 'none'
  | 'pending'
  | 'active'
  | 'unavailable'
  | 'unsupported';

export type MonitoringFocusWindow = { fromMs: number; toMs: number };

/**
 * 在线模式下所有未带服务端 focus token 的账号行（含由服务端事件本地回退拼出的行）
 * 一律改为 fail-closed 标记：无法证明服务端能精确返回该行成员，禁止发旧 AND 宽查询。
 */
export const markOnlineAccountRowsFailClosed = <
  T extends { id: string; filterValue?: string; legacyFilterValue?: string; account: string },
>(
  rows: readonly T[]
): T[] =>
  rows.map((row) => {
    const value = row.filterValue?.trim() || row.account;
    if (readMonitoringAccountFocusId(value) || isMonitoringUnsupportedFocusFilterValue(value)) {
      return row;
    }
    return {
      ...row,
      filterValue: buildMonitoringUnsupportedFocusFilterValue(row.id || value),
      legacyFilterValue: row.legacyFilterValue || value,
    };
  });

/**
 * token 绑定签发列表的原始窗口：详情请求使用“签发窗口 ∩ 当前窗口”，
 * 吸收相对窗口的毫秒级 now 漂移，同时不放宽用户当前选择的范围；交集为空返回 null。
 */
export const intersectMonitoringFocusWindow = (
  issued: MonitoringFocusWindow | null | undefined,
  current: { startMs: number; endMs: number } | null | undefined
): MonitoringFocusWindow | null => {
  if (!current) return null;
  if (!issued) return { fromMs: current.startMs, toMs: current.endMs };
  const fromMs = Math.max(issued.fromMs, current.startMs);
  const toMs = Math.min(issued.toMs, current.endMs);
  return fromMs < toMs ? { fromMs, toMs } : null;
};

/**
 * 判定 typed focus token 能否下发：只有本轮服务端选项/账号列表确实发出同一 token 才 active；
 * 选项尚未返回为 pending；选项已返回但没有该 token（旧服务/过期）或服务端拒绝为 unavailable。
 */
export const resolveMonitoringAccountFocusState = ({
  focusId,
  issuedIds,
  optionsSettled,
  rejected,
  unsupported,
  windowExpired,
}: {
  focusId: string;
  issuedIds: ReadonlySet<string>;
  optionsSettled: boolean;
  rejected: boolean;
  unsupported?: boolean;
  windowExpired?: boolean;
}): MonitoringAccountFocusState => {
  if (unsupported) return 'unsupported';
  if (!focusId) return 'none';
  if (windowExpired) return 'unavailable';
  if (rejected) return 'unavailable';
  if (issuedIds.has(focusId)) return 'active';
  return optionsSettled ? 'unavailable' : 'pending';
};

export const buildMonitoringFilterSelectorsScopeKey = (
  timeRange: MonitoringTimeRange,
  bounds: { startMs: number; endMs: number } | null,
  searchQuery: string,
  searchApiKeyHash?: string
) =>
  JSON.stringify({
    range: timeRange,
    bounds: timeRange === 'custom' ? bounds : null,
    searchQuery,
    searchApiKeyHash,
  });

export const mergeMonitoringAccountOptionRows = (
  ...collections: ReadonlyArray<readonly MonitoringAccountRow[]>
) => {
  const rowsByFilterValue = new Map<string, MonitoringAccountRow>();
  collections.forEach((collection) => {
    collection.forEach((row) => {
      // 带服务端 token 的行按 token 去重（不同 token 绝不合并）；无 token 的 fail-closed 行
      // 按旧口径键去重，避免与本地回退行重复出现。
      const key = row.accountFocusId
        ? row.filterValue?.trim() || row.id
        : row.legacyFilterValue?.trim() || row.filterValue?.trim() || row.id;
      if (!rowsByFilterValue.has(key)) {
        rowsByFilterValue.set(key, row);
      }
    });
  });

  const rows = Array.from(rowsByFilterValue.values());
  const accountsWithIdentitySelectors = new Set(
    rows
      .filter((row) => {
        const criteria = parseMonitoringAccountFilterValue(row.filterValue);
        return criteria.authIndices.length > 0 || criteria.sourceHashes.length > 0;
      })
      .map((row) => row.account.trim().toLowerCase())
      .filter(Boolean)
  );

  return rows.filter((row) => {
    const criteria = parseMonitoringAccountFilterValue(row.filterValue);
    const isPlainAccountSelector =
      row.id === `selector:${row.account.trim().toLowerCase()}` &&
      criteria.accounts.length > 0 &&
      criteria.authIndices.length === 0 &&
      criteria.sourceHashes.length === 0 &&
      criteria.apiKeyHashes.length === 0;
    return (
      !isPlainAccountSelector ||
      !accountsWithIdentitySelectors.has(row.account.trim().toLowerCase())
    );
  });
};

export const resolveMonitoringDimensionCounts = ({
  activeDataTab,
  accountRowCount,
  apiKeyRowCount,
  accountSelectorCount,
  apiKeySelectorCount,
}: {
  activeDataTab: MonitoringDataTab;
  accountRowCount: number;
  apiKeyRowCount: number;
  accountSelectorCount: number;
  apiKeySelectorCount: number;
}) => ({
  accountCount: activeDataTab === 'accounts' ? accountRowCount : accountSelectorCount,
  apiKeyCount: activeDataTab === 'apiKeys' ? apiKeyRowCount : apiKeySelectorCount,
});

export const resolveMonitoringAccountFocusNotice = (
  state: MonitoringAccountFocusState | undefined,
  t: (key: string) => string
) => {
  if (state === 'pending') return t('monitoring.account_focus_pending');
  if (state === 'unavailable') return t('monitoring.account_focus_unavailable');
  if (state === 'unsupported') return t('monitoring.account_focus_unsupported');
  return null;
};
