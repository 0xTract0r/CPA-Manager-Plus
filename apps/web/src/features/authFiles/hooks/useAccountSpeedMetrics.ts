import { useMemo } from 'react';
import { useMonitoringAnalytics } from '@/features/monitoring/hooks/useMonitoringAnalytics';
import type {
  MonitoringAnalyticsEventsPageRequest,
  MonitoringAnalyticsFilters,
} from '@/services/api/usageService';
import { normalizeAuthIndex } from '@/utils/usage';
import {
  computeAccountSpeedMetrics,
  type AccountSpeedMetricsResult,
} from '@/features/authFiles/model/accountSpeedMetrics';
import {
  extractSpeedSeries,
  type SpeedSeriesPoint,
} from '@/features/authFiles/model/accountSpeedSeries';

export const ACCOUNT_SPEED_DEFAULT_WINDOW_HOURS = 24;
export const ACCOUNT_SPEED_DEFAULT_MAX_EVENTS = 120;
export const ACCOUNT_SPEED_DEFAULT_MIN_SAMPLES = 3;

const HOUR_MS = 60 * 60 * 1000;

export type AccountSpeedMetricsStatus =
  | 'disabled'
  | 'unavailable'
  | 'loading'
  | 'error'
  | 'insufficient'
  | 'ok';

export interface UseAccountSpeedMetricsParams {
  /** 账号名（auth file name），当没有 authIndex 时用作 analytics 的 accounts 过滤。 */
  accountName?: string | null;
  /** 账号 auth_index（首选的精确 join 键，优先于 accountName 过滤）。 */
  authIndex?: string | number | null;
  /** 关闭时不发起请求（如非 codex 且无近期活动的账号），默认 true。 */
  enabled?: boolean;
  /** 统计窗口（小时），默认 24。 */
  windowHours?: number;
  /** events_page 拉取上限，默认 120。 */
  maxEvents?: number;
  /** 单项中位数所需最小样本数，默认 3。 */
  minSamples?: number;
}

export interface UseAccountSpeedMetricsReturn {
  status: AccountSpeedMetricsStatus;
  loading: boolean;
  error: string;
  /** 计算后的中位读数（含 service_tier 分组），无数据时为 null。 */
  metrics: AccountSpeedMetricsResult | null;
  /**
   * 按 timestamp_ms 升序的逐事件序列（Phase 3 sparkline / runway 复用同一批已拉取数据，
   * 全程一次请求）。无数据时为空数组。
   */
  series: SpeedSeriesPoint[];
  /** 生效的统计窗口（小时），供 UI 标注。 */
  windowHours: number;
  /** 实际纳入统计的请求数（UI「基于 N 次」用）。 */
  sampleCount: number;
}

const normalizeWindowHours = (value: number | undefined): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return ACCOUNT_SPEED_DEFAULT_WINDOW_HOURS;
  return Math.min(Math.floor(parsed), 24 * 30);
};

const normalizeMaxEvents = (value: number | undefined): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return ACCOUNT_SPEED_DEFAULT_MAX_EVENTS;
  return Math.min(Math.floor(parsed), 500);
};

/**
 * 账号级速度读数可复用数据 hook（Phase 2）。
 *
 * 输入单个账号（authIndex 优先、否则 accountName），拉取近 `windowHours` 小时内该账号的
 * analytics 事件明细（events_page 原始行），交给 `computeAccountSpeedMetrics` 计算中位
 * TTFT / latency / TPS，并保留 service_tier 分组结果供 Phase 3 前后对比复用。
 *
 * 过滤优先用 `auth_indices=[authIndex]`（与事件行的 auth_index 精确对齐），缺失时回退到
 * `accounts=[accountName]`。窗口在 active 参数变化时冻结一次，避免每次 render 刷新时间戳
 * 导致的重复请求循环（useMonitoringAnalytics 在 requestKey 稳定时只拉一次）。
 */
export function useAccountSpeedMetrics({
  accountName,
  authIndex,
  enabled = true,
  windowHours,
  maxEvents,
  minSamples = ACCOUNT_SPEED_DEFAULT_MIN_SAMPLES,
}: UseAccountSpeedMetricsParams): UseAccountSpeedMetricsReturn {
  const normalizedAuthIndex = normalizeAuthIndex(authIndex);
  const normalizedAccount = typeof accountName === 'string' ? accountName.trim() : '';
  const resolvedWindowHours = normalizeWindowHours(windowHours);
  const resolvedMaxEvents = normalizeMaxEvents(maxEvents);

  const hasIdentity = Boolean(normalizedAuthIndex) || Boolean(normalizedAccount);
  const active = enabled && hasIdentity;

  // 冻结窗口：仅当 active / 身份 / 窗口 / 上限变化时重算时间戳，render 之间保持稳定。
  const timeWindow = useMemo<{ fromMs: number | null; toMs: number | null; nowMs: number | undefined }>(() => {
    if (!active) return { fromMs: null, toMs: null, nowMs: undefined };
    const nowMs = Date.now();
    return { fromMs: nowMs - resolvedWindowHours * HOUR_MS, toMs: nowMs, nowMs };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, normalizedAuthIndex, normalizedAccount, resolvedWindowHours, resolvedMaxEvents]);

  const filters = useMemo<MonitoringAnalyticsFilters | undefined>(() => {
    if (!active) return undefined;
    if (normalizedAuthIndex) return { auth_indices: [normalizedAuthIndex] };
    return { accounts: [normalizedAccount] };
  }, [active, normalizedAuthIndex, normalizedAccount]);

  const eventsPage = useMemo<MonitoringAnalyticsEventsPageRequest | null>(
    () => (active ? { limit: resolvedMaxEvents } : null),
    [active, resolvedMaxEvents]
  );

  const dataScopeKey = active
    ? `account-speed:${normalizedAuthIndex || normalizedAccount}:${resolvedWindowHours}:${resolvedMaxEvents}`
    : '';

  const analytics = useMonitoringAnalytics({
    fromMs: timeWindow.fromMs,
    toMs: timeWindow.toMs,
    nowMs: timeWindow.nowMs,
    dataScopeKey,
    filters,
    eventsPage,
  });

  const eventItems = analytics.data?.events?.items;
  const metrics = useMemo(
    () => (eventItems ? computeAccountSpeedMetrics(eventItems, { minSamples }) : null),
    [eventItems, minSamples]
  );
  const series = useMemo<SpeedSeriesPoint[]>(
    () => (eventItems ? extractSpeedSeries(eventItems) : []),
    [eventItems]
  );

  const status = useMemo<AccountSpeedMetricsStatus>(() => {
    if (!active) return 'disabled';
    if (analytics.loading) return 'loading';
    if (!analytics.enabled) return 'unavailable';
    if (analytics.error) return 'error';
    if (!metrics || !metrics.hasData) return 'insufficient';
    return 'ok';
  }, [active, analytics.loading, analytics.enabled, analytics.error, metrics]);

  return useMemo(
    () => ({
      status,
      loading: analytics.loading,
      error: analytics.error,
      metrics,
      series,
      windowHours: resolvedWindowHours,
      sampleCount: metrics?.usedEvents ?? 0,
    }),
    [status, analytics.loading, analytics.error, metrics, series, resolvedWindowHours]
  );
}
