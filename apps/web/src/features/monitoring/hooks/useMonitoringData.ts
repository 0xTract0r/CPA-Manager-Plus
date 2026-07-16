import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MonitoringAnalyticsEventRow } from '@/services/api/usageService';
import type { AuthFileItem } from '@/types/authFile';
import type { CredentialInfo } from '@/types/sourceInfo';
import { buildSourceInfoMap } from '@/utils/sourceResolver';
import { collectUsageDetailsWithEndpoint, normalizeAuthIndex } from '@/utils/usage';
import { readString } from '../model/base';
import { buildApiKeyDisplayMap } from '../model/apiKeys';
import { buildMonitoringAuthMetaMap } from '../model/authMeta';
import { getRangeBounds, shouldUseHourlyTimeline } from '../model/range';
import {
  buildChannelRows,
  buildFailureRows,
  buildFailureSourceRows,
  buildHourlyDistribution,
  buildModelRows,
  buildModelShareRows,
  buildStatusChips,
  buildTaskBuckets,
  buildTimeline,
} from '../model/chartBuilders';
import {
  buildAnalyticsFilters,
  buildAccountRowsFromAnalytics,
  buildApiKeyRowsFromAnalytics,
  buildChannelRowsFromAnalytics,
  buildFailureRowsFromAnalytics,
  buildFailureSourceRowsFromAnalytics,
  buildFilterOptionsFromAnalytics,
  buildHourlyDistributionFromAnalytics,
  buildModelRowsFromAnalytics,
  buildModelShareRowsFromAnalytics,
  buildSummaryFromAnalytics,
  buildTaskBucketsFromAnalytics,
  buildTimelineFromAnalytics,
  buildUsageDetailsFromAnalyticsEvents,
  mergeAnalyticsEventItems,
} from '../model/analyticsAdapters';
import { buildEventRows } from '../model/eventRows';
import {
  buildAccountRows,
  buildApiKeyRows,
  buildMonitoringSummary,
  buildRangeFilteredRows,
  buildScopeFilteredRows,
  shouldIncludeInStats,
} from '../model/rowBuilders';
import type {
  MonitoringAuthMeta,
  MonitoringChannelMeta,
  MonitoringFilterOptions,
  MonitoringMetadata,
  UseMonitoringDataParams,
  UseMonitoringDataReturn,
} from '../model/types';
import { loadMonitoringMetaPayload } from '../services/monitoringMetaService';
import { useMonitoringAnalytics } from './useMonitoringAnalytics';

export type {
  MonitoringAccountModelSpendRow,
  MonitoringAccountRow,
  MonitoringApiKeyModelSpendRow,
  MonitoringApiKeyRow,
  MonitoringChannelMeta,
  MonitoringChannelRow,
  MonitoringCustomTimeRange,
  MonitoringEventRow,
  MonitoringFailureRow,
  MonitoringFailureSourceRow,
  MonitoringKpi,
  MonitoringMetadata,
  MonitoringModelRow,
  MonitoringModelShareRow,
  MonitoringRealtimeRow,
  MonitoringScopeFilters,
  MonitoringStatusChip,
  MonitoringStatusTone,
  MonitoringSummary,
  MonitoringTaskBucketRow,
  MonitoringTimeRange,
  MonitoringTimelinePoint,
  UseMonitoringDataParams,
  UseMonitoringDataReturn,
} from '../model/types';
export { buildApiKeyDisplayMap } from '../model/apiKeys';
export { buildMonitoringAuthMetaMap } from '../model/authMeta';
export { getRangeBounds } from '../model/range';
export {
  buildAccountRows,
  buildApiKeyRows,
  buildMonitoringSummary,
  buildRangeFilteredRows,
  buildScopeFilteredRows,
  buildRealtimeMonitorRows,
} from '../model/rowBuilders';

const MONITORING_EVENTS_PAGE_LIMIT = 500;
export const MONITORING_EVENTS_RETENTION_LIMIT = 2_000;
// 事件明细分页(events_page)体积大(500 条/页可达约 1.9MB)，从首屏聚合请求中拆出，
// 用独立的 useMonitoringAnalytics 实例单独请求，避免拖慢首屏概览面板(KPI/图表)。
// 拆分后的请求耗时更长（大范围/慢查询），超时相应调大到 60s，与 usageService 默认
// 的 30s 通用超时区分开，只影响这一个较重的分页请求。
const MONITORING_EVENTS_REQUEST_TIMEOUT_MS = 60 * 1000;
const MONITORING_PRESENTATION_CACHE_LIMIT = 4;
const EMPTY_MONITORING_ANALYTICS_EVENT_ROWS: MonitoringAnalyticsEventRow[] = [];

interface MonitoringEventsPageState {
  scopeKey: string;
  beforeMs: number | null;
  beforeId: number | null;
  items: MonitoringAnalyticsEventRow[];
  hasMore: boolean;
  loadingMore: boolean;
  lastPageKey: string;
}

export type MonitoringPresentationSnapshot = Pick<
  UseMonitoringDataReturn,
  | 'summary'
  | 'timeline'
  | 'timelineGranularity'
  | 'hourlyDistribution'
  | 'modelShareRows'
  | 'channelRows'
  | 'modelRows'
  | 'failureSourceRows'
  | 'taskBuckets'
  | 'recentFailures'
  | 'accountRows'
  | 'apiKeyRows'
  | 'filterOptions'
  | 'filteredRows'
  | 'eventsHasMore'
  | 'eventsLoadingMore'
  | 'eventsRetentionLimited'
  | 'eventsTotalCount'
  | 'eventsLoadedCount'
  | 'lastRefreshedAt'
>;

export interface MonitoringPresentationSnapshotResolution {
  snapshot: MonitoringPresentationSnapshot;
  hasPresentationSnapshot: boolean;
  usingSnapshotFallback: boolean;
}

interface MonitoringPresentationSnapshotStore {
  cachedSnapshots: Map<string, MonitoringPresentationSnapshot>;
  lastStableSnapshot: MonitoringPresentationSnapshot | null;
}

const createEventsPageState = (scopeKey = ''): MonitoringEventsPageState => ({
  scopeKey,
  beforeMs: null,
  beforeId: null,
  items: [],
  hasMore: false,
  loadingMore: false,
  lastPageKey: '',
});

const buildEventsPageKey = (
  scopeKey: string,
  beforeMs: number | null,
  pageItems: MonitoringAnalyticsEventRow[],
  nextBeforeMs: number
) =>
  [
    scopeKey,
    beforeMs ?? 'root',
    nextBeforeMs,
    pageItems.length,
    pageItems[0]?.event_hash ?? '',
    pageItems[pageItems.length - 1]?.event_hash ?? '',
  ].join(':');

export const buildMonitoringEventsScopeKey = (
  timeRange: UseMonitoringDataParams['timeRange'],
  analyticsBounds: { startMs: number; endMs: number } | null,
  searchQuery: string,
  searchApiKeyHash: string | undefined,
  filters: unknown,
  granularity: string
) =>
  // 事件表 scope 身份/staleness 判定用 key。滚动档(24h/7d/…)的 analyticsBounds.startMs
  // 会随每 30s 自动刷新前移(nowMs - N)，若把它纳入 scopeKey，会让"同一档位的定时刷新"
  // 被误判为切换到了新 scope → eventsDataStale 翻 true → 事件表回退到被清空事件的缓存快照
  // (filteredRows=[]) → 实时表某一帧渲染 0 行 → 整表卸载重挂载(闪屏)。
  //
  // 修复：非 custom 的滚动/锚定档 scopeKey 只纳入 range 档位标识，剔除会漂移的 startMs。
  // 档位名本身已唯一区分各滚动档(24h/7d/…)与锚定档(today/yesterday)，切换档位时 scopeKey
  // 仍会变化 → 正常触发 stale/refetch。custom 档仍纳入显式 startMs/endMs 边界。
  //
  // 注意：真实请求体仍使用漂移的 analyticsBounds.startMs/endMs 与 nowMs(见 useMonitoringData
  // 中 useMonitoringAnalytics 的 fromMs/toMs/nowMs)，scopeKey 不参与请求参数，只做 staleness
  // 判定 → 数据每 30s 仍真实刷新，稳定 scopeKey 下拿到新数据会原地覆盖 displayedRows。
  JSON.stringify({
    range: timeRange,
    bounds: timeRange === 'custom' ? analyticsBounds : null,
    searchQuery,
    searchApiKeyHash,
    filters,
    granularity,
  });

export const mergeMonitoringEventsPageItems = (
  previousItems: MonitoringAnalyticsEventRow[],
  pageItems: MonitoringAnalyticsEventRow[],
  requestBeforeMs: number | null
) => {
  if (requestBeforeMs) {
    return mergeAnalyticsEventItems(previousItems, pageItems).slice(
      0,
      MONITORING_EVENTS_RETENTION_LIMIT
    );
  }
  if (previousItems.length === 0) {
    return pageItems.slice(0, MONITORING_EVENTS_RETENTION_LIMIT);
  }
  return mergeAnalyticsEventItems(pageItems, previousItems).slice(
    0,
    MONITORING_EVENTS_RETENTION_LIMIT
  );
};

export const withoutMonitoringSnapshotEvents = (
  snapshot: MonitoringPresentationSnapshot
): MonitoringPresentationSnapshot => ({
  ...snapshot,
  filteredRows: [],
  eventsHasMore: false,
  eventsLoadingMore: false,
  eventsRetentionLimited: false,
  eventsTotalCount: 0,
  eventsLoadedCount: 0,
});

const uniqueOptionValues = (values: Array<string | null | undefined>) =>
  Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean))).sort(
    (left, right) => left.localeCompare(right)
  );

export const resolveMonitoringDisplayEventItems = ({
  analyticsData,
  currentPageItems,
  eventsPageItems,
  eventsBeforeMs,
  dataStale,
}: {
  analyticsData: { events?: { items: MonitoringAnalyticsEventRow[] } } | null;
  currentPageItems: MonitoringAnalyticsEventRow[] | null;
  eventsPageItems: MonitoringAnalyticsEventRow[];
  eventsBeforeMs: number | null;
  dataStale: boolean;
}): MonitoringAnalyticsEventRow[] => {
  if (dataStale) {
    return eventsPageItems.length > 0
      ? eventsPageItems
      : (analyticsData?.events?.items ?? EMPTY_MONITORING_ANALYTICS_EVENT_ROWS);
  }

  if (!currentPageItems) {
    return eventsPageItems;
  }

  const existingEventHashes = new Set(eventsPageItems.map((item) => item.event_hash));
  if (currentPageItems.every((item) => existingEventHashes.has(item.event_hash))) {
    return eventsPageItems;
  }

  return mergeMonitoringEventsPageItems(eventsPageItems, currentPageItems, eventsBeforeMs);
};

export const resolveMonitoringPresentationSnapshot = ({
  computedSnapshot,
  scopeKey,
  dataStale,
  cachedSnapshots,
  lastStableSnapshot,
}: {
  computedSnapshot: MonitoringPresentationSnapshot;
  scopeKey: string;
  dataStale: boolean;
  cachedSnapshots: ReadonlyMap<string, MonitoringPresentationSnapshot>;
  lastStableSnapshot: MonitoringPresentationSnapshot | null;
}): MonitoringPresentationSnapshotResolution => {
  if (!dataStale) {
    return {
      snapshot: computedSnapshot,
      hasPresentationSnapshot: true,
      usingSnapshotFallback: false,
    };
  }

  const snapshot = cachedSnapshots.get(scopeKey) ?? lastStableSnapshot;
  return {
    snapshot: snapshot ?? computedSnapshot,
    hasPresentationSnapshot: Boolean(snapshot),
    usingSnapshotFallback: Boolean(snapshot),
  };
};

export function useMonitoringData({
  usage,
  config,
  modelPrices,
  apiKeyAliases,
  timeRange,
  customTimeRange,
  searchQuery,
  searchApiKeyHash,
  scopeFilters,
}: UseMonitoringDataParams): UseMonitoringDataReturn {
  const [authFiles, setAuthFiles] = useState<AuthFileItem[]>([]);
  const [channels, setChannels] = useState<MonitoringChannelMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [analyticsNowMs, setAnalyticsNowMs] = useState(() => Date.now());
  const [eventsPageState, setEventsPageState] = useState<MonitoringEventsPageState>(() =>
    createEventsPageState()
  );
  const [presentationSnapshotStore, setPresentationSnapshotStore] =
    useState<MonitoringPresentationSnapshotStore>(() => ({
      cachedSnapshots: new Map(),
      lastStableSnapshot: null,
    }));

  const analyticsBounds = useMemo(() => {
    const bounds = getRangeBounds(timeRange, analyticsNowMs, customTimeRange);
    if (!bounds) return null;
    return {
      startMs: Number.isFinite(bounds.startMs) && bounds.startMs > 0 ? bounds.startMs : 1,
      endMs: Math.max(bounds.endMs, 1),
    };
  }, [analyticsNowMs, customTimeRange, timeRange]);

  const refreshMeta = useCallback(
    async (showLoading: boolean = true) => {
      if (showLoading) {
        setLoading(true);
        setError('');
      }

      const payload = await loadMonitoringMetaPayload(config);
      setAuthFiles(payload.authFiles);
      setChannels(payload.channels);
      setError(payload.error);
      setLoading(false);
      setEventsPageState((previous) =>
        previous.beforeMs === null && previous.beforeId === null && !previous.loadingMore
          ? previous
          : { ...previous, beforeMs: null, beforeId: null, loadingMore: false }
      );
      setAnalyticsNowMs(Date.now());
    },
    [config]
  );

  useEffect(() => {
    let cancelled = false;

    loadMonitoringMetaPayload(config).then((payload) => {
      if (cancelled) return;
      setAuthFiles(payload.authFiles);
      setChannels(payload.channels);
      setError(payload.error);
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [config]);

  const authMetaMap = useMemo(() => buildMonitoringAuthMetaMap(authFiles), [authFiles]);

  const uniqueAuthMeta = useMemo(() => {
    const map = new Map<string, MonitoringAuthMeta>();
    authMetaMap.forEach((item) => {
      map.set(item.authIndex, item);
    });
    return Array.from(map.values());
  }, [authMetaMap]);

  const authFileMap = useMemo(() => {
    const map = new Map<string, CredentialInfo>();
    authFiles.forEach((entry) => {
      const authIndex = normalizeAuthIndex(entry['auth_index'] ?? entry.authIndex);
      if (!authIndex) return;
      map.set(authIndex, {
        name:
          readString(entry.label) ||
          readString(entry.name) ||
          readString(entry.email) ||
          readString(entry.account) ||
          authIndex,
        type: readString(entry.provider) || readString(entry.type),
      });
    });
    return map;
  }, [authFiles]);

  const sourceInfoMap = useMemo(
    () =>
      buildSourceInfoMap({
        geminiApiKeys: config?.geminiApiKeys || [],
        claudeApiKeys: config?.claudeApiKeys || [],
        codexApiKeys: config?.codexApiKeys || [],
        vertexApiKeys: config?.vertexApiKeys || [],
        openaiCompatibility: config?.openaiCompatibility || [],
      }),
    [config]
  );

  const channelByAuthIndex = useMemo(() => {
    const map = new Map<string, MonitoringChannelMeta>();
    channels.forEach((channel) => {
      channel.authIndices.forEach((authIndex) => {
        map.set(authIndex, channel);
      });
    });
    return map;
  }, [channels]);

  const apiKeyDisplayMap = useMemo(() => {
    return buildApiKeyDisplayMap(config?.apiKeys || [], apiKeyAliases || []);
  }, [apiKeyAliases, config?.apiKeys]);

  const analyticsFilters = useMemo(
    () => buildAnalyticsFilters(scopeFilters, authMetaMap, channels),
    [authMetaMap, channels, scopeFilters]
  );

  const analyticsGranularity = useMemo(
    () => (shouldUseHourlyTimeline(timeRange, customTimeRange) ? 'hour' : 'day'),
    [customTimeRange, timeRange]
  );

  const eventsScopeKey = useMemo(
    () =>
      buildMonitoringEventsScopeKey(
        timeRange,
        analyticsBounds,
        searchQuery,
        searchApiKeyHash,
        analyticsFilters,
        analyticsGranularity
      ),
    [
      analyticsBounds,
      analyticsFilters,
      analyticsGranularity,
      searchApiKeyHash,
      searchQuery,
      timeRange,
    ]
  );

  const activeEventsPageState = useMemo(
    () =>
      eventsPageState.scopeKey === eventsScopeKey
        ? eventsPageState
        : createEventsPageState(eventsScopeKey),
    [eventsPageState, eventsScopeKey]
  );
  const eventsBeforeMs = activeEventsPageState.beforeMs;
  const eventsBeforeId = activeEventsPageState.beforeId;
  const eventItems = activeEventsPageState.items;
  const eventsHasMore = activeEventsPageState.hasMore;
  const eventsLoadingMore = activeEventsPageState.loadingMore;

  // 首屏概览请求：只取 KPI/图表/账号-API Key 汇总等聚合数据，不再勾 events_page /
  // recent_failures。recent_failures 在监控页当前 UI 未被任何面板消费（"最近失败"是
  // 独立的仪表盘页面 dashboard/summary 接口，与本页无关），移出首屏后无可见回归。
  const analytics = useMonitoringAnalytics({
    fromMs: analyticsBounds?.startMs,
    toMs: analyticsBounds?.endMs,
    nowMs: analyticsNowMs,
    dataScopeKey: eventsScopeKey,
    searchQuery,
    searchApiKeyHash,
    filters: analyticsFilters,
    include: {
      summary: true,
      timeline: true,
      hourly_distribution: true,
      model_share: true,
      channel_share: true,
      model_stats: true,
      failure_sources: true,
      account_stats: true,
      api_key_stats: true,
      filter_options: true,
      task_buckets: true,
      granularity: analyticsGranularity,
    },
    throttleMs: 1_000,
  });
  const analyticsData = analytics.data;
  const currentAnalyticsData = analytics.dataStale ? null : analyticsData;

  // 事件明细分页独立请求：账号总览的"近期状态"迷你条形图（accountStatusDataByRowId）
  // 需要事件级时间戳，因此不能完全推迟到用户滚动到"实时"分栏才请求；但把它从首屏聚合
  // 请求中拆开后，概览面板（KPI/图表）不必等这个大分页请求返回即可先渲染，且该请求可
  // 独立设置更长超时/更低 limit。分页游标(loadMoreEvents)固定走这个独立请求。
  const eventsAnalytics = useMonitoringAnalytics({
    fromMs: analyticsBounds?.startMs,
    toMs: analyticsBounds?.endMs,
    nowMs: analyticsNowMs,
    dataScopeKey: eventsScopeKey,
    searchQuery,
    searchApiKeyHash,
    filters: analyticsFilters,
    include: {
      events_page: {
        limit: MONITORING_EVENTS_PAGE_LIMIT,
        before_ms: eventsBeforeMs,
        before_id: eventsBeforeId,
      },
      granularity: analyticsGranularity,
    },
    throttleMs: 1_000,
    timeoutMs: MONITORING_EVENTS_REQUEST_TIMEOUT_MS,
  });
  const eventsAnalyticsData = eventsAnalytics.data;
  const currentEventsAnalyticsData = eventsAnalytics.dataStale ? null : eventsAnalyticsData;
  const displayEventItems = useMemo(
    () =>
      resolveMonitoringDisplayEventItems({
        analyticsData: eventsAnalyticsData,
        currentPageItems: currentEventsAnalyticsData?.events?.items ?? null,
        eventsPageItems: eventItems,
        eventsBeforeMs,
        dataStale: eventsAnalytics.dataStale,
      }),
    [
      eventsAnalytics.dataStale,
      eventsAnalyticsData,
      currentEventsAnalyticsData?.events?.items,
      eventItems,
      eventsBeforeMs,
    ]
  );
  const eventsLoadedCount = displayEventItems.length;
  const displayEventsTotalCount =
    currentEventsAnalyticsData?.events?.total_count ?? eventsLoadedCount;
  const eventsRetentionLimited =
    eventsLoadedCount >= MONITORING_EVENTS_RETENTION_LIMIT &&
    (Boolean(currentEventsAnalyticsData?.events?.has_more) ||
      eventsHasMore ||
      displayEventsTotalCount > MONITORING_EVENTS_RETENTION_LIMIT);
  const displayEventsHasMore =
    !eventsRetentionLimited && (currentEventsAnalyticsData?.events?.has_more ?? eventsHasMore);

  useEffect(() => {
    const page = currentEventsAnalyticsData?.events;
    if (!page) return;
    const requestBeforeMs = eventsBeforeMs;
    const requestBeforeId = eventsBeforeId;
    const pageKey = buildEventsPageKey(
      eventsScopeKey,
      requestBeforeMs,
      page.items,
      page.next_before_ms
    );
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setEventsPageState((previous) => {
        const base =
          previous.scopeKey === eventsScopeKey ? previous : createEventsPageState(eventsScopeKey);
        if (base.lastPageKey === pageKey) return base;
        const items = mergeMonitoringEventsPageItems(base.items, page.items, requestBeforeMs);
        return {
          scopeKey: eventsScopeKey,
          beforeMs: requestBeforeMs,
          beforeId: requestBeforeId,
          items,
          hasMore: page.has_more && items.length < MONITORING_EVENTS_RETENTION_LIMIT,
          loadingMore: false,
          lastPageKey: pageKey,
        };
      });
    });
    return () => {
      cancelled = true;
    };
  }, [currentEventsAnalyticsData?.events, eventsScopeKey, eventsBeforeMs, eventsBeforeId]);

  useEffect(() => {
    if (eventsAnalytics.error) {
      let cancelled = false;
      queueMicrotask(() => {
        if (cancelled) return;
        setEventsPageState((previous) =>
          previous.loadingMore ? { ...previous, loadingMore: false } : previous
        );
      });
      return () => {
        cancelled = true;
      };
    }
  }, [eventsAnalytics.error]);

  const loadMoreEvents = useCallback(() => {
    if (
      eventsAnalytics.loading ||
      eventsLoadingMore ||
      !eventsHasMore ||
      eventItems.length >= MONITORING_EVENTS_RETENTION_LIMIT
    )
      return;
    const nextBeforeMs = currentEventsAnalyticsData?.events?.next_before_ms;
    if (!nextBeforeMs) return;
    const nextBeforeId = currentEventsAnalyticsData?.events?.next_before_id ?? null;
    setEventsPageState((previous) => {
      const base =
        previous.scopeKey === eventsScopeKey ? previous : createEventsPageState(eventsScopeKey);
      if (base.loadingMore) return base;
      return { ...base, beforeMs: nextBeforeMs, beforeId: nextBeforeId, loadingMore: true };
    });
  }, [
    currentEventsAnalyticsData?.events?.next_before_ms,
    currentEventsAnalyticsData?.events?.next_before_id,
    eventsAnalytics.loading,
    eventItems.length,
    eventsScopeKey,
    eventsHasMore,
    eventsLoadingMore,
  ]);

  const allRows = useMemo(() => {
    const details = eventsAnalyticsData
      ? buildUsageDetailsFromAnalyticsEvents(displayEventItems)
      : collectUsageDetailsWithEndpoint(usage);
    return buildEventRows(
      details,
      authMetaMap,
      authFileMap,
      sourceInfoMap,
      channelByAuthIndex,
      modelPrices,
      apiKeyDisplayMap
    ).sort((left, right) => right.timestampMs - left.timestampMs);
  }, [
    apiKeyDisplayMap,
    authFileMap,
    authMetaMap,
    channelByAuthIndex,
    eventsAnalyticsData,
    displayEventItems,
    modelPrices,
    sourceInfoMap,
    usage,
  ]);

  const rangeFilteredRows = useMemo(
    () =>
      buildRangeFilteredRows(allRows, timeRange, customTimeRange, searchQuery, searchApiKeyHash),
    [allRows, customTimeRange, searchApiKeyHash, searchQuery, timeRange]
  );
  const filteredRows = useMemo(
    () => buildScopeFilteredRows(rangeFilteredRows, scopeFilters),
    [rangeFilteredRows, scopeFilters]
  );
  const statsRows = useMemo(() => filteredRows.filter(shouldIncludeInStats), [filteredRows]);

  const summary = useMemo(
    () =>
      currentAnalyticsData?.summary
        ? buildSummaryFromAnalytics(currentAnalyticsData.summary)
        : buildMonitoringSummary(statsRows),
    [currentAnalyticsData, statsRows]
  );
  const timelineData = useMemo(
    () =>
      currentAnalyticsData?.timeline
        ? {
            granularity:
              currentAnalyticsData.granularity === 'hour' ? ('hour' as const) : ('day' as const),
            points: buildTimelineFromAnalytics(
              currentAnalyticsData.timeline,
              currentAnalyticsData.granularity
            ),
          }
        : buildTimeline(statsRows, timeRange, customTimeRange),
    [currentAnalyticsData, customTimeRange, statsRows, timeRange]
  );
  const hourlyDistribution = useMemo(
    () =>
      currentAnalyticsData?.hourly_distribution
        ? buildHourlyDistributionFromAnalytics(currentAnalyticsData.hourly_distribution)
        : buildHourlyDistribution(statsRows),
    [currentAnalyticsData, statsRows]
  );
  const modelShareRows = useMemo(
    () =>
      currentAnalyticsData?.model_share
        ? buildModelShareRowsFromAnalytics(
            currentAnalyticsData.model_share,
            currentAnalyticsData.model_stats
          )
        : buildModelShareRows(statsRows),
    [currentAnalyticsData, statsRows]
  );
  const channelRows = useMemo(
    () =>
      currentAnalyticsData?.channel_share
        ? buildChannelRowsFromAnalytics(
            currentAnalyticsData.channel_share,
            authMetaMap,
            authFileMap,
            sourceInfoMap,
            channelByAuthIndex
          )
        : buildChannelRows(statsRows),
    [currentAnalyticsData, authFileMap, authMetaMap, channelByAuthIndex, sourceInfoMap, statsRows]
  );
  const modelRows = useMemo(
    () =>
      currentAnalyticsData?.model_stats
        ? buildModelRowsFromAnalytics(currentAnalyticsData.model_stats)
        : buildModelRows(statsRows),
    [currentAnalyticsData, statsRows]
  );
  const failureSourceRows = useMemo(
    () =>
      currentAnalyticsData?.failure_sources
        ? buildFailureSourceRowsFromAnalytics(
            currentAnalyticsData.failure_sources,
            authMetaMap,
            authFileMap,
            sourceInfoMap,
            channelByAuthIndex
          )
        : buildFailureSourceRows(statsRows),
    [currentAnalyticsData, authFileMap, authMetaMap, channelByAuthIndex, sourceInfoMap, statsRows]
  );
  const taskBuckets = useMemo(
    () =>
      currentAnalyticsData?.task_buckets
        ? buildTaskBucketsFromAnalytics(
            currentAnalyticsData.task_buckets,
            authMetaMap,
            authFileMap,
            sourceInfoMap,
            channelByAuthIndex
          )
        : buildTaskBuckets(statsRows),
    [currentAnalyticsData, authFileMap, authMetaMap, channelByAuthIndex, sourceInfoMap, statsRows]
  );
  const recentFailures = useMemo(
    () =>
      currentAnalyticsData?.recent_failures
        ? buildFailureRowsFromAnalytics(
            currentAnalyticsData.recent_failures,
            authMetaMap,
            authFileMap,
            sourceInfoMap,
            channelByAuthIndex
          )
        : buildFailureRows(statsRows),
    [currentAnalyticsData, authFileMap, authMetaMap, channelByAuthIndex, sourceInfoMap, statsRows]
  );
  const accountRows = useMemo(
    () =>
      currentAnalyticsData?.account_stats
        ? buildAccountRowsFromAnalytics(
            currentAnalyticsData.account_stats,
            authMetaMap,
            authFileMap,
            sourceInfoMap,
            channelByAuthIndex
          )
        : buildAccountRows(filteredRows),
    [
      currentAnalyticsData,
      authFileMap,
      authMetaMap,
      channelByAuthIndex,
      filteredRows,
      sourceInfoMap,
    ]
  );
  const apiKeyRows = useMemo(
    () =>
      currentAnalyticsData?.api_key_stats
        ? buildApiKeyRowsFromAnalytics(
            currentAnalyticsData.api_key_stats,
            authMetaMap,
            authFileMap,
            sourceInfoMap,
            channelByAuthIndex,
            apiKeyDisplayMap
          )
        : buildApiKeyRows(filteredRows),
    [
      apiKeyDisplayMap,
      currentAnalyticsData,
      authFileMap,
      authMetaMap,
      channelByAuthIndex,
      filteredRows,
      sourceInfoMap,
    ]
  );
  const fallbackFilterOptions = useMemo<MonitoringFilterOptions>(
    () => ({
      accountRows: buildAccountRows(rangeFilteredRows),
      apiKeyRows: buildApiKeyRows(rangeFilteredRows),
      providers: uniqueOptionValues(rangeFilteredRows.map((row) => row.provider)),
      models: uniqueOptionValues(rangeFilteredRows.map((row) => row.model)),
      channels: uniqueOptionValues(rangeFilteredRows.map((row) => row.channel)),
      headerTraceIds: uniqueOptionValues(rangeFilteredRows.map((row) => row.headerTraceId)),
    }),
    [rangeFilteredRows]
  );
  const analyticsFilterOptions = currentAnalyticsData?.filter_options;
  const filterOptions = useMemo(
    () =>
      analyticsFilterOptions
        ? buildFilterOptionsFromAnalytics(
            analyticsFilterOptions,
            authMetaMap,
            authFileMap,
            sourceInfoMap,
            channelByAuthIndex,
            apiKeyDisplayMap
          )
        : fallbackFilterOptions,
    [
      apiKeyDisplayMap,
      authFileMap,
      authMetaMap,
      channelByAuthIndex,
      analyticsFilterOptions,
      fallbackFilterOptions,
      sourceInfoMap,
    ]
  );

  const computedPresentationSnapshot = useMemo<MonitoringPresentationSnapshot>(
    () => ({
      summary,
      timeline: timelineData.points,
      timelineGranularity: timelineData.granularity,
      hourlyDistribution,
      modelShareRows,
      channelRows,
      modelRows,
      failureSourceRows,
      taskBuckets,
      recentFailures,
      accountRows,
      apiKeyRows,
      filterOptions,
      filteredRows,
      eventsHasMore: displayEventsHasMore,
      eventsLoadingMore,
      eventsRetentionLimited,
      eventsTotalCount: displayEventsTotalCount,
      eventsLoadedCount,
      lastRefreshedAt: analytics.lastRefreshedAt,
    }),
    [
      analytics.lastRefreshedAt,
      accountRows,
      apiKeyRows,
      channelRows,
      displayEventsHasMore,
      displayEventsTotalCount,
      eventsLoadedCount,
      eventsLoadingMore,
      eventsRetentionLimited,
      failureSourceRows,
      filterOptions,
      filteredRows,
      hourlyDistribution,
      modelRows,
      modelShareRows,
      recentFailures,
      summary,
      taskBuckets,
      timelineData.granularity,
      timelineData.points,
    ]
  );

  // 概览聚合(analytics)与事件分页(eventsAnalytics)是两个独立请求、独立完成时机。
  // 概览类展示(summary/timeline/图表/账号-API Key 汇总卡片等)只依赖 analytics 本身，
  // 数据一到手就应该渲染，不应该被"事件分页(大数据量下明显更慢)还没追上新 scope"
  // 拖成空/旧数据——这正是曾经出现过的生产 bug：概览请求早已拿到新 scope 的真实数据，
  // 但因为把两者的 stale 状态耦合在一起判断，导致概览被一直挡在上一个 scope 的旧快照。
  // 事件明细表(filteredRows/eventsXxx)则仍然只应该看 eventsAnalytics 自己的 stale，
  // 独立 loading，不被概览请求的状态影响、也不反过来拖累概览。
  // 缓存快照仍然合并存一份完整对象（withoutMonitoringSnapshotEvents 清空其中的事件字段
  // 后落盘），只是"是否使用该缓存"这一步分别用各自的 stale 判断，两条门禁互不影响。
  const overviewDataStale = analytics.dataStale;
  const eventsDataStale = eventsAnalytics.dataStale;
  // 仍然保留一个"整体是否在转场"的合并信号，供页面级 loading 遮罩/stale 提示等场景使用
  // （这些场景关心的是"任一路数据还没追上新 scope"，不需要拆分为概览/事件两路）。
  const combinedAnalyticsDataStale = overviewDataStale || eventsDataStale;

  useEffect(() => {
    if (combinedAnalyticsDataStale) return;

    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setPresentationSnapshotStore((previous) => {
        if (
          previous.lastStableSnapshot === computedPresentationSnapshot &&
          previous.cachedSnapshots.get(eventsScopeKey) === computedPresentationSnapshot
        ) {
          return previous;
        }

        const cachedSnapshot = withoutMonitoringSnapshotEvents(computedPresentationSnapshot);
        const cachedSnapshots = new Map(previous.cachedSnapshots);
        cachedSnapshots.delete(eventsScopeKey);
        cachedSnapshots.set(eventsScopeKey, cachedSnapshot);
        while (cachedSnapshots.size > MONITORING_PRESENTATION_CACHE_LIMIT) {
          const oldestKey = cachedSnapshots.keys().next().value;
          if (oldestKey === undefined) break;
          cachedSnapshots.delete(oldestKey);
        }
        return {
          cachedSnapshots,
          lastStableSnapshot: cachedSnapshot,
        };
      });
    });
    return () => {
      cancelled = true;
    };
  }, [combinedAnalyticsDataStale, computedPresentationSnapshot, eventsScopeKey]);

  // 概览展示门禁：只由 analytics.dataStale 决定。一旦为 false，直接用本次计算结果
  // （不必等缓存快照），概览数据到手即可见；为 true 时才回退缓存/上一次稳定快照。
  const overviewPresentationResolution = useMemo(
    () =>
      resolveMonitoringPresentationSnapshot({
        computedSnapshot: computedPresentationSnapshot,
        scopeKey: eventsScopeKey,
        dataStale: overviewDataStale,
        cachedSnapshots: presentationSnapshotStore.cachedSnapshots,
        lastStableSnapshot: presentationSnapshotStore.lastStableSnapshot,
      }),
    [
      overviewDataStale,
      computedPresentationSnapshot,
      eventsScopeKey,
      presentationSnapshotStore.cachedSnapshots,
      presentationSnapshotStore.lastStableSnapshot,
    ]
  );
  // 事件表展示门禁：只由 eventsAnalytics.dataStale 决定，独立于概览请求的状态。
  const eventsPresentationResolution = useMemo(
    () =>
      resolveMonitoringPresentationSnapshot({
        computedSnapshot: computedPresentationSnapshot,
        scopeKey: eventsScopeKey,
        dataStale: eventsDataStale,
        cachedSnapshots: presentationSnapshotStore.cachedSnapshots,
        lastStableSnapshot: presentationSnapshotStore.lastStableSnapshot,
      }),
    [
      eventsDataStale,
      computedPresentationSnapshot,
      eventsScopeKey,
      presentationSnapshotStore.cachedSnapshots,
      presentationSnapshotStore.lastStableSnapshot,
    ]
  );
  // 合并展示：概览字段取 overview 门禁的结果，事件表字段取 events 门禁的结果。
  // hasPresentationSnapshot/usingSnapshotFallback 仍然用合并信号，供页面级"整体是否
  // 还在转场"判断使用（loading 遮罩、stale 提示等不区分概览/事件两路）。
  const presentationSnapshot = useMemo<MonitoringPresentationSnapshot>(
    () => ({
      ...overviewPresentationResolution.snapshot,
      filteredRows: eventsPresentationResolution.snapshot.filteredRows,
      eventsHasMore: eventsPresentationResolution.snapshot.eventsHasMore,
      eventsLoadingMore: eventsPresentationResolution.snapshot.eventsLoadingMore,
      eventsRetentionLimited: eventsPresentationResolution.snapshot.eventsRetentionLimited,
      eventsTotalCount: eventsPresentationResolution.snapshot.eventsTotalCount,
      eventsLoadedCount: eventsPresentationResolution.snapshot.eventsLoadedCount,
    }),
    [overviewPresentationResolution.snapshot, eventsPresentationResolution.snapshot]
  );
  const presentationResolution = useMemo(
    () => ({
      hasPresentationSnapshot:
        overviewPresentationResolution.hasPresentationSnapshot ||
        eventsPresentationResolution.hasPresentationSnapshot,
      usingSnapshotFallback:
        overviewPresentationResolution.usingSnapshotFallback ||
        eventsPresentationResolution.usingSnapshotFallback,
    }),
    [
      overviewPresentationResolution.hasPresentationSnapshot,
      overviewPresentationResolution.usingSnapshotFallback,
      eventsPresentationResolution.hasPresentationSnapshot,
      eventsPresentationResolution.usingSnapshotFallback,
    ]
  );

  const metadata = useMemo<MonitoringMetadata>(() => {
    const planTypes = Array.from(
      new Set(uniqueAuthMeta.map((item) => item.planType).filter((item) => item && item !== '-'))
    ).sort();

    return {
      totalAuthFiles: authFiles.length,
      activeAuthFiles: uniqueAuthMeta.filter(
        (item) => !item.disabled && !item.unavailable && item.status === 'active'
      ).length,
      unavailableAuthFiles: uniqueAuthMeta.filter((item) => item.unavailable).length,
      runtimeOnlyAuthFiles: uniqueAuthMeta.filter((item) => item.runtimeOnly).length,
      totalChannels: channels.length,
      enabledChannels: channels.filter((item) => !item.disabled).length,
      configuredModels: Array.from(new Set(channels.flatMap((item) => item.modelNames))).length,
      planTypes,
    };
  }, [authFiles.length, channels, uniqueAuthMeta]);

  const statusChips = useMemo(() => buildStatusChips(metadata), [metadata]);

  return {
    // 首屏阻塞态只看概览请求；事件分页请求独立、较慢，不应阻塞 KPI/图表先渲染。
    loading: loading || analytics.loading,
    // 错误信息合并两路请求：事件分页失败也必须让用户看见（C 项要求的"刷新失败"必须
    // 显式提示，不能静默只保留旧数据)，而不是被首屏请求的成功状态掩盖。
    error: [error, analytics.error, eventsAnalytics.error].filter(Boolean).join('；'),
    authFiles,
    channels,
    summary: presentationSnapshot.summary,
    metadata,
    statusChips,
    timeline: presentationSnapshot.timeline,
    timelineGranularity: presentationSnapshot.timelineGranularity,
    hourlyDistribution: presentationSnapshot.hourlyDistribution,
    modelShareRows: presentationSnapshot.modelShareRows,
    channelRows: presentationSnapshot.channelRows,
    modelRows: presentationSnapshot.modelRows,
    failureSourceRows: presentationSnapshot.failureSourceRows,
    taskBuckets: presentationSnapshot.taskBuckets,
    recentFailures: presentationSnapshot.recentFailures,
    accountRows: presentationSnapshot.accountRows,
    apiKeyRows: presentationSnapshot.apiKeyRows,
    filterOptions: presentationSnapshot.filterOptions,
    filteredRows: presentationSnapshot.filteredRows,
    eventsHasMore: presentationSnapshot.eventsHasMore,
    eventsLoadingMore: presentationSnapshot.eventsLoadingMore,
    eventsRetentionLimited: presentationSnapshot.eventsRetentionLimited,
    eventsTotalCount: presentationSnapshot.eventsTotalCount,
    eventsLoadedCount: presentationSnapshot.eventsLoadedCount,
    lastRefreshedAt: presentationSnapshot.lastRefreshedAt,
    isTransitioningScope: combinedAnalyticsDataStale,
    hasPresentationSnapshot: presentationResolution.hasPresentationSnapshot,
    refreshMeta,
    loadMoreEvents,
  };
}
