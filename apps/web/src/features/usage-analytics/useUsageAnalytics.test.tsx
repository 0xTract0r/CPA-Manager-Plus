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

const monitoringMetaMock = vi.hoisted(() => ({
  payload: { authFiles: [] as Array<Record<string, unknown>>, channels: [] },
}));

vi.mock('@/features/monitoring/services/monitoringMetaService', () => ({
  loadMonitoringMetaPayload: () => Promise.resolve(monitoringMetaMock.payload),
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
    monitoringMetaMock.payload = { authFiles: [], channels: [] };
    useMonitoringAnalyticsMock.mockReset();
    useMonitoringAnalyticsMock.mockImplementation(resultFor);
  });

  afterEach(() => {
    renderer?.unmount();
    renderer = null;
  });

  const renderHook = async (initialEntry = '/usage-analytics') => {
    await act(async () => {
      renderer = create(
        <MemoryRouter initialEntries={[initialEntry]}>
          <Harness />
        </MemoryRouter>
      );
      await Promise.resolve();
    });
  };

  it('prefills Codex account and ignores unrelated global filters in fast analysis', async () => {
    await renderHook('/usage-analytics?tab=codexFast&auth_index=codex-a&provider=claude&status=failed&search=unrelated&model=other&from_ms=1000&to_ms=9000');
    const fast = lastParams(params => Boolean(params.include?.fast_impact));
    expect(latestResult?.activeTab).toBe('codexFast');
    expect(fast?.filters).toEqual({ auth_indices: ['codex-a'], providers: ['codex'] });
    expect(fast?.searchQuery).toBe('');
    expect(fast?.fromMs).toBe(1000);
    expect(fast?.toMs).toBe(9000);
    expect(lastParams(params => Boolean(params.include?.filter_selectors))?.fromMs).toBeNull();
    expect(latestResult?.fastFilters.model).toBe('all');
    expect(latestResult?.fastFilters.status).toBe('all');
  });

  it('requires a single Codex account and clears another provider when entering the tab', async () => {
    monitoringMetaMock.payload.authFiles = [{ name: 'claude.json', provider: 'claude', auth_index: 'claude-a' }];
    await renderHook('/usage-analytics?tab=performance&auth_index=claude-a');
    await act(async () => { latestResult?.setActiveTab('codexFast'); });
    expect(latestResult?.fastFilters.authIndex).toBe('all');
    expect(lastParams(params => params.include?.fast_impact === false)?.fromMs).toBeNull();
    await act(async () => { latestResult?.setFilters({ authIndex: 'codex-b' }); });
    expect(lastParams(params => Boolean(params.include?.fast_impact))?.filters).toEqual({ auth_indices: ['codex-b'], providers: ['codex'] });
  });

  it('keeps full-text search and adds note matches as an OR identity scope', async () => {
    monitoringMetaMock.payload = {
      authFiles: [
        {
          name: 'account.json',
          authIndex: 'auth-note',
          account: 'owner@example.test',
          note: '生产主账号',
        },
      ],
      channels: [],
    };

    await renderHook('/usage-analytics?search=生产');
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const overview = lastParams((params) => Boolean(params.include?.summary));
    const selectors = lastParams((params) => Boolean(params.include?.filter_selectors));
    expect(overview?.searchQuery).toBe('生产');
    expect(overview?.filters).toMatchObject({ search_auth_indices: ['auth-note'] });
    expect(selectors?.searchQuery).toBe('生产');
    expect(selectors?.filters).toEqual({ search_auth_indices: ['auth-note'] });
  });

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

  it('does not issue selected-key detail requests for unattributed fallback groups', async () => {
    const unattributedResponse = {
      ...emptyAnalyticsResponse,
      api_key_stats: [
        {
          id: 'unknown-client-api-key',
          api_key_hash: '',
          calls: 4,
          success_calls: 4,
          failure_calls: 0,
          success_rate: 1,
          input_tokens: 40,
          output_tokens: 10,
          cached_tokens: 0,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
          total_tokens: 50,
          cost: 0.4,
          average_latency_ms: null,
          last_seen_ms: 1,
        },
      ],
    };
    useMonitoringAnalyticsMock.mockImplementation((params) => {
      const base = resultFor(params);
      if (params.include?.summary) {
        return {
          ...base,
          data: unattributedResponse,
        };
      }
      return base;
    });

    await renderHook();

    const selectedKeyRequest = lastParams((params) => {
      const scope = JSON.parse(params.dataScopeKey ?? '{}') as Record<string, unknown>;
      return Object.prototype.hasOwnProperty.call(scope, 'selectedApiKeyHash');
    });
    expect(latestResult?.selectedApiKey?.id).toBe('unknown-client-api-key');
    expect(selectedKeyRequest?.fromMs).toBeUndefined();
    expect(selectedKeyRequest?.filters).toEqual({});
    expect(JSON.parse(selectedKeyRequest?.dataScopeKey ?? '{}')).toMatchObject({
      selectedApiKeyHash: '',
    });
  });

  it('prefers a selectable key over a higher-ranked fallback group', async () => {
    const mixedResponse = {
      ...emptyAnalyticsResponse,
      api_key_stats: [
        {
          id: 'unknown-client-api-key',
          api_key_hash: '',
          calls: 8,
          success_calls: 8,
          failure_calls: 0,
          success_rate: 1,
          input_tokens: 80,
          output_tokens: 20,
          cached_tokens: 0,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
          total_tokens: 100,
          cost: 0.8,
          average_latency_ms: null,
          last_seen_ms: 2,
        },
        {
          id: 'abcdef1234567890',
          api_key_hash: 'abcdef1234567890',
          calls: 4,
          success_calls: 4,
          failure_calls: 0,
          success_rate: 1,
          input_tokens: 40,
          output_tokens: 10,
          cached_tokens: 0,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
          total_tokens: 50,
          cost: 0.4,
          average_latency_ms: null,
          last_seen_ms: 1,
        },
      ],
    };
    useMonitoringAnalyticsMock.mockImplementation((params) => {
      const base = resultFor(params);
      return params.include?.summary ? { ...base, data: mixedResponse } : base;
    });

    await renderHook();

    const selectedKeyRequest = lastParams((params) => {
      const scope = JSON.parse(params.dataScopeKey ?? '{}') as Record<string, unknown>;
      return Object.prototype.hasOwnProperty.call(scope, 'selectedApiKeyHash');
    });
    expect(latestResult?.selectedApiKey?.apiKeyHash).toBe('abcdef1234567890');
    expect(selectedKeyRequest?.filters).toMatchObject({
      api_key_hashes: ['abcdef1234567890'],
    });
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
