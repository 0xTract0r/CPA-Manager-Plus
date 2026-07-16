import { useEffect } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiKeyAlias } from '@/services/api/usageService';
import type { ModelPrice } from '@/utils/usage';

// 复现 bug：切换监控范围（比如换时间窗口/筛选条件）后，概览聚合请求(analytics)
// 很快就拿到新 scope 的真实数据(summary.total_calls > 0)，但事件明细分页请求
// (eventsAnalytics) 在生产大数据量(22.7万行)下仍然很慢，长时间 dataStale=true。
//
// 期望：概览统计(summary/timeline/等)只要 analytics 本身不 stale 就应该展示新 scope
// 的真实数据；不该因为 eventsAnalytics 还没追上新 scope，就一直把界面钉在上一个
// scope 的旧快照(lastStableSnapshot)上，让人以为“明明后端有数据，页面却是空/旧的”。
//
// 用一个可变的 mock 状态模拟“先在 scope A 稳定下来，再切到 scope B”的真实时序：
// mock 的 useMonitoringAnalytics 按 include 形状区分概览请求 vs 事件请求，并读取
// 一个可在测试里改写的可变状态对象，配合 rerender 驱动 usage 变化触发 scope 切换。
interface MutableAnalyticsMockState {
  scope: 'A' | 'B';
  overviewDataStaleForB: boolean;
  eventsDataStaleForB: boolean;
}

const mockState: MutableAnalyticsMockState = {
  scope: 'A',
  overviewDataStaleForB: false,
  eventsDataStaleForB: true,
};

const buildOverviewData = (totalCalls: number) => ({
  summary: {
    total_calls: totalCalls,
    success_calls: totalCalls - 100,
    failure_calls: 100,
    success_rate: (totalCalls - 100) / totalCalls,
    input_tokens: 1_000_000,
    output_tokens: 500_000,
    cached_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    reasoning_tokens: 0,
    total_tokens: 1_500_000,
    total_cost: 123.45,
    average_latency_ms: 1_200,
    zero_token_calls: 0,
    rpm_30m: 10,
    tpm_30m: 1000,
    avg_daily_requests: 1000,
  },
  granularity: 'day',
});

vi.mock('../services/monitoringMetaService', () => ({
  loadMonitoringMetaPayload: vi.fn(async () => ({
    authFiles: [],
    channels: [],
    error: '',
  })),
}));

// 重要：mock 返回值里的 data / lastRefreshedAt / refresh 必须是稳定引用（模块级常量或
// mockState 上缓存的对象），不能在每次调用里 new 一个 Date 或字面量对象。useMonitoringData
// 内部的 computedPresentationSnapshot 用 useMemo 依赖 analytics.lastRefreshedAt 等字段；
// 如果这里每次渲染都返回新引用，会让该 useMemo 每次都判定"变化"，进而让下游同步快照的
// useEffect 每次渲染都触发 setState，形成与本测试要验证的 bug 无关的无限重渲染循环
// （曾经在这个测试文件的早期版本上实测复现过，必须避免）。
const STABLE_REFRESH = vi.fn();
const SCOPE_A_LAST_REFRESHED_AT = new Date(1_768_759_000_000);
const SCOPE_B_LAST_REFRESHED_AT = new Date(1_768_760_000_000);
const SCOPE_A_EVENTS_DATA = { events: { items: [], total_count: 0, has_more: false } };
const SCOPE_A_OVERVIEW_DATA = buildOverviewData(50_000);
const SCOPE_B_OVERVIEW_DATA = buildOverviewData(227_000);

vi.mock('./useMonitoringAnalytics', () => ({
  // 用 include 形状区分两个并行调用：
  // - 概览请求 include.summary === true，且不含 events_page
  // - 事件分页请求 include.events_page 存在
  useMonitoringAnalytics: (params: {
    dataScopeKey?: string;
    include?: { summary?: boolean; events_page?: unknown };
  }) => {
    const isEventsRequest = Boolean(params.include?.events_page);
    const scope = mockState.scope;

    if (isEventsRequest) {
      if (scope === 'A') {
        // scope A 已经稳定：事件分页也落地了。
        return {
          enabled: true,
          loading: false,
          error: '',
          data: SCOPE_A_EVENTS_DATA,
          dataStale: false,
          lastRefreshedAt: SCOPE_A_LAST_REFRESHED_AT,
          serviceBase: 'http://manager.local',
          unavailableReason: '',
          refresh: STABLE_REFRESH,
        };
      }
      // scope B：事件分页请求仍在追赶新 scope（大数据量下很慢），dataStale 由测试控制。
      return {
        enabled: true,
        loading: true,
        error: '',
        data: null,
        dataStale: mockState.eventsDataStaleForB,
        lastRefreshedAt: null,
        serviceBase: 'http://manager.local',
        unavailableReason: '',
        refresh: STABLE_REFRESH,
      };
    }

    // 概览聚合请求
    if (scope === 'A') {
      return {
        enabled: true,
        loading: false,
        error: '',
        data: SCOPE_A_OVERVIEW_DATA,
        dataStale: false,
        lastRefreshedAt: SCOPE_A_LAST_REFRESHED_AT,
        serviceBase: 'http://manager.local',
        unavailableReason: '',
        refresh: STABLE_REFRESH,
      };
    }
    // scope B：概览请求已经很快拿到了新 scope 的真实数据。
    return {
      enabled: true,
      loading: false,
      error: '',
      data: SCOPE_B_OVERVIEW_DATA,
      dataStale: mockState.overviewDataStaleForB,
      lastRefreshedAt: SCOPE_B_LAST_REFRESHED_AT,
      serviceBase: 'http://manager.local',
      unavailableReason: '',
      refresh: STABLE_REFRESH,
    };
  },
}));

import { useMonitoringData } from './useMonitoringData';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const EMPTY_MODEL_PRICES: Record<string, ModelPrice> = {};
const EMPTY_API_KEY_ALIASES: ApiKeyAlias[] = [];
const ALL_SCOPE_FILTERS = {
  account: 'all',
  provider: 'all',
  model: 'all',
  channel: 'all',
  apiKeyHash: 'all',
  status: 'all',
} as const;

describe('useMonitoringData overview presentation vs events staleness', () => {
  let renderer: ReactTestRenderer | null = null;

  afterEach(() => {
    renderer?.unmount();
    renderer = null;
    mockState.scope = 'A';
    mockState.overviewDataStaleForB = false;
    mockState.eventsDataStaleForB = true;
  });

  it('renders new-scope overview summary once analytics resolves even while the events page request is still catching up', async () => {
    let latest: ReturnType<typeof useMonitoringData> | null = null;

    function Harness({ searchQuery }: { searchQuery: string }) {
      const result = useMonitoringData({
        config: null,
        modelPrices: EMPTY_MODEL_PRICES,
        apiKeyAliases: EMPTY_API_KEY_ALIASES,
        timeRange: 'today',
        customTimeRange: null,
        searchQuery,
        searchApiKeyHash: '',
        scopeFilters: ALL_SCOPE_FILTERS,
      });
      // 在 effect 里而不是渲染期间回写 latest：渲染期间给外部变量赋值是副作用，
      // 会触发 react-hooks/globals 的 purity 校验；放进 effect 是合法的副作用位置。
      useEffect(() => {
        latest = result;
      });
      return null;
    }

    // 1) 先在 scope A 稳定下来：概览与事件请求都已落地，产生一份 lastStableSnapshot。
    await act(async () => {
      renderer = create(<Harness searchQuery="scope-a" />);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(latest!.summary.totalCalls).toBe(50_000);

    // 2) 切换 scope（改变 searchQuery 触发 eventsScopeKey 变化）：概览请求很快
    // 拿到了新 scope(227000 条)的真实数据，但事件分页请求仍在追赶、dataStale=true。
    mockState.scope = 'B';
    await act(async () => {
      renderer!.update(<Harness searchQuery="scope-b" />);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    // 根因断言：概览数据(analytics)本身已经不 stale、已经是新 scope 的真实数据，
    // 页面理应展示 227000。但修复前 combinedAnalyticsDataStale 把 analytics 和
    // eventsAnalytics 的 stale 状态耦合在一起，只要事件分页请求还没追上新 scope，
    // 就会一直回退到上一个 scope(A)的 lastStableSnapshot，导致概览错误地停留在
    // 旧 scope 的 50000，而不是新 scope 已经到手的 227000。
    expect(latest!.summary.totalCalls).toBe(227_000);
  });
});
