import { useEffect } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useMonitoringAnalytics,
  type UseMonitoringAnalyticsParams,
  type UseMonitoringAnalyticsReturn,
} from '@/features/monitoring/hooks/useMonitoringAnalytics';
import type { MonitoringAnalyticsSummary } from '@/services/api/usageService';
import { useUsageAnalytics } from './useUsageAnalytics';

vi.mock('@/features/monitoring/hooks/useMonitoringAnalytics', () => ({
  useMonitoringAnalytics: vi.fn(),
}));

vi.mock('@/features/monitoring/hooks/useUsageData', () => ({
  useUsageData: () => ({ apiKeyAliases: [], loadApiKeyAliases: vi.fn() }),
}));

vi.mock('@/features/monitoring/services/monitoringMetaService', () => ({
  loadMonitoringMetaPayload: () => Promise.resolve({ authFiles: [], channels: [] }),
}));

vi.mock('@/stores', () => ({
  useConfigStore: (selector: (state: { config: null }) => unknown) => selector({ config: null }),
}));

const useMonitoringAnalyticsMock = vi.mocked(useMonitoringAnalytics);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const emptyAnalyticsResponse = {
  generated_at_ms: 1,
  granularity: 'hour',
};

const fullSummary: MonitoringAnalyticsSummary = {
  total_calls: 0,
  success_calls: 0,
  failure_calls: 0,
  success_rate: 0,
  input_tokens: 0,
  output_tokens: 0,
  cached_tokens: 0,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
  reasoning_tokens: 0,
  total_tokens: 0,
  total_cost: 0,
  average_cost_per_call: 0,
  average_latency_ms: null,
  p95_latency_ms: null,
  p95_ttft_ms: null,
  zero_token_calls: 0,
  rpm_30m: 0,
  tpm_30m: 0,
  avg_daily_requests: 0,
  avg_daily_tokens: 0,
  approx_tasks: 0,
  approx_task_failures: 0,
  approx_task_success_rate: 0,
  zero_token_models: [],
};

describe('useUsageAnalytics request orchestration', () => {
  let renderer: ReactTestRenderer | null = null;
  let latestResult: ReturnType<typeof useUsageAnalytics> | null = null;
  let selectorError = '';
  const mainRefresh = vi.fn();
  const selectorRefresh = vi.fn();
  const auxiliaryRefresh = vi.fn();

  const resultFor = (params: UseMonitoringAnalyticsParams): UseMonitoringAnalyticsReturn => {
    const selectors = Boolean(params.include?.filter_selectors);
    const main = Boolean(params.include?.summary);
    return {
      enabled: Boolean(params.fromMs && params.toMs),
      loading: false,
      error: selectors ? selectorError : '',
      data: selectors
        ? selectorError
          ? null
          : {
              ...emptyAnalyticsResponse,
              filter_options: {
                models: ['gpt-a'],
                api_key_hashes: ['key-a'],
                providers: ['codex'],
                auth_files: ['account.json'],
              },
            }
        : main
          ? emptyAnalyticsResponse
          : null,
      dataStale: false,
      lastRefreshedAt: null,
      serviceBase: 'http://manager.local',
      unavailableReason: '',
      refresh: selectors ? selectorRefresh : main ? mainRefresh : auxiliaryRefresh,
    };
  };

  const lastParams = (predicate: (params: UseMonitoringAnalyticsParams) => boolean) => {
    const calls = useMonitoringAnalyticsMock.mock.calls.map(([params]) => params).filter(predicate);
    return calls[calls.length - 1];
  };

  function Harness() {
    const result = useUsageAnalytics();
    useEffect(() => {
      latestResult = result;
    }, [result]);
    return null;
  }

  beforeEach(() => {
    selectorError = '';
    latestResult = null;
    mainRefresh.mockReset();
    selectorRefresh.mockReset();
    auxiliaryRefresh.mockReset();
    useMonitoringAnalyticsMock.mockReset();
    useMonitoringAnalyticsMock.mockImplementation(resultFor);
  });

  afterEach(() => {
    renderer?.unmount();
    renderer = null;
  });

  const renderHook = async () => {
    await act(async () => {
      renderer = create(
        <MemoryRouter initialEntries={['/usage-analytics']}>
          <Harness />
        </MemoryRouter>
      );
      await Promise.resolve();
    });
  };

  it('uses a tab-scoped main request and a tab-independent selector request', async () => {
    await renderHook();

    const overview = lastParams((params) => Boolean(params.include?.summary));
    const selectors = lastParams((params) => Boolean(params.include?.filter_selectors));
    expect(overview?.include).toEqual({
      summary: true,
      summary_comparison: true,
      timeline: true,
      model_stats: true,
      channel_share: true,
      api_key_stats: true,
      anomaly_points: true,
      granularity: 'hour',
    });
    expect(JSON.parse(overview?.dataScopeKey ?? '{}')).toMatchObject({ activeTab: 'overview' });
    expect(selectors?.include).toEqual({ filter_options: true, filter_selectors: true });
    expect(JSON.parse(selectors?.dataScopeKey ?? '{}')).not.toHaveProperty('activeTab');
    expect(latestResult?.filterOptions).toMatchObject({
      models: ['gpt-a'],
      api_key_hashes: ['key-a'],
    });

    const selectorScope = selectors?.dataScopeKey;
    await act(async () => {
      latestResult?.setActiveTab('heatmap');
    });

    const heatmap = lastParams((params) => Boolean(params.include?.summary));
    const selectorsAfterTab = lastParams((params) => Boolean(params.include?.filter_selectors));
    expect(heatmap?.include).toEqual({
      summary: true,
      heatmap: true,
      granularity: 'hour',
    });
    expect(JSON.parse(heatmap?.dataScopeKey ?? '{}')).toMatchObject({ activeTab: 'heatmap' });
    expect(selectorsAfterTab?.dataScopeKey).toBe(selectorScope);
  });

  it('does not couple selector failures to the main page error and refreshes both requests', async () => {
    selectorError = 'selector failed';
    await renderHook();

    expect(latestResult?.error).toBe('');
    expect(latestResult?.filterOptions).toBeUndefined();

    act(() => {
      latestResult?.refresh();
    });
    expect(mainRefresh).toHaveBeenCalledTimes(1);
    expect(selectorRefresh).toHaveBeenCalledTimes(1);
  });

  it('falls back to the last successful data while the main request is stale, instead of flashing empty', async () => {
    const populatedResponse = {
      ...emptyAnalyticsResponse,
      summary: { ...fullSummary, total_calls: 42, total_tokens: 4200 },
    };

    // 第一次渲染：主请求已经成功返回过数据。
    useMonitoringAnalyticsMock.mockImplementation((params) => {
      const base = resultFor(params);
      if (params.include?.summary) {
        return { ...base, loading: false, dataStale: false, data: populatedResponse };
      }
      return base;
    });
    await renderHook();
    expect(latestResult?.summary.requestCount).toBe(42);
    expect(latestResult?.isFirstLoad).toBe(false);
    expect(latestResult?.isUpdating).toBe(false);

    // 第二次渲染：切筛选/时间范围触发 dataStale=true（旧数据还在，但 scope 已经变了）。
    useMonitoringAnalyticsMock.mockImplementation((params) => {
      const base = resultFor(params);
      if (params.include?.summary) {
        return { ...base, loading: true, dataStale: true, data: populatedResponse };
      }
      return base;
    });
    await act(async () => {
      latestResult?.setFilters({ searchQuery: 'changed' });
      await Promise.resolve();
    });

    // 底层闪烁修复的核心断言：dataStale 期间摘要必须仍是上一次成功值，不能塌陷成 0/null。
    expect(latestResult?.summary.requestCount).toBe(42);
    expect(latestResult?.isFirstLoad).toBe(false);
    expect(latestResult?.isUpdating).toBe(true);
  });

  it('reports isFirstLoad only before any successful data has ever arrived', async () => {
    useMonitoringAnalyticsMock.mockImplementation((params) => {
      const base = resultFor(params);
      if (params.include?.summary) {
        return { ...base, loading: true, dataStale: false, data: null };
      }
      return base;
    });
    await renderHook();

    expect(latestResult?.isFirstLoad).toBe(true);
    expect(latestResult?.isUpdating).toBe(false);
    expect(latestResult?.summary.requestCount).toBe(0);
  });
});
