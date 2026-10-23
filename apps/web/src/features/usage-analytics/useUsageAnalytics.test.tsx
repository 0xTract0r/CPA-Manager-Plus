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
import type {
  MonitoringAnalyticsApiKeyStatRow,
  MonitoringAnalyticsCoverage,
  MonitoringAnalyticsResponse,
} from '@/services/api/usageService';
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

const monitoringMetaMocks = vi.hoisted(() => ({
  load: vi.fn(),
}));

vi.mock('@/features/monitoring/services/monitoringMetaService', () => ({
  loadMonitoringMetaPayload: monitoringMetaMocks.load,
}));

vi.mock('@/stores', () => ({
  useConfigStore: (selector: (state: { config: null }) => unknown) => selector({ config: null }),
}));

const useMonitoringAnalyticsMock = vi.mocked(useMonitoringAnalytics);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const archivedCoverage: MonitoringAnalyticsCoverage = {
  scope: 'time_range',
  mode: 'mixed',
  raw_complete: false,
  core_aggregate_used: true,
  raw_event_count: 4,
  raw_deleted_event_count: 2,
  min_deleted_timestamp_ms: 1,
  max_deleted_timestamp_ms: 2,
  fidelity_limitations: ['event_details_require_raw_events'],
};

const emptyAnalyticsResponse: MonitoringAnalyticsResponse = {
  generated_at_ms: 1,
  granularity: 'hour',
  coverage: archivedCoverage,
};
const HOUR_MS = 60 * 60 * 1000;

const createApiKeyStatRow = (
  overrides: Partial<MonitoringAnalyticsApiKeyStatRow> = {}
): MonitoringAnalyticsApiKeyStatRow => ({
  id: 'key-a',
  api_key_hash: 'key-a',
  calls: 6,
  success_calls: 6,
  failure_calls: 0,
  success_rate: 1,
  input_tokens: 600,
  output_tokens: 0,
  cached_tokens: 0,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
  total_tokens: 600,
  cost: 0.6,
  average_latency_ms: null,
  last_seen_ms: 1,
  ...overrides,
});

const localHourStartMs = (timestampMs: number) => {
  const date = new Date(timestampMs);
  date.setMinutes(0, 0, 0);
  return date.getTime();
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
  let credentialTimelineError = '';
  let credentialTimelineLoading = false;
  let emptyAuxiliarySnapshot = false;
  let auxiliaryScopeStale = false;
  let apiKeyTimelineAvailable = true;
  let mainTimelineBucketCalls = 5;
  let apiKeyStats: MonitoringAnalyticsApiKeyStatRow[] = [createApiKeyStatRow()];
  const mainRefresh = vi.fn();
  const selectorRefresh = vi.fn();
  const auxiliaryRefresh = vi.fn();

  const stablePayloads = new Map<string, MonitoringAnalyticsResponse>();
  const resultFor = (params: UseMonitoringAnalyticsParams): UseMonitoringAnalyticsReturn => {
    const selectors = Boolean(params.include?.filter_selectors);
    const main = Boolean(params.include?.summary);
    const credentialTimeline = Boolean(params.include?.credential_timeline);
    const apiKeyTimeline = Boolean(params.include?.api_key_timeline);
    const mainTimelineStartMs =
      typeof params.fromMs === 'number' ? localHourStartMs(params.fromMs) : 0;
    const mainData = params.include?.credential_stats
      ? {
          ...emptyAnalyticsResponse,
          credential_stats: [
            {
              id: 'credential-a.json',
              auth_file_snapshot: 'credential-a.json',
              auth_index: 'auth-a',
              calls: 10,
              success_calls: 9,
              failure_calls: 1,
              success_rate: 0.9,
              input_tokens: 100,
              output_tokens: 50,
              cached_tokens: 0,
              cache_read_tokens: 0,
              cache_creation_tokens: 0,
              total_tokens: 150,
              cost: 1,
              average_latency_ms: 100,
              last_seen_ms: 1,
            },
          ],
        }
      : params.include?.api_key_stats
        ? {
            ...emptyAnalyticsResponse,
            timeline: [
              {
                bucket_ms: mainTimelineStartMs,
                label: '00:00',
                calls: mainTimelineBucketCalls,
                tokens: mainTimelineBucketCalls * 100,
                success: mainTimelineBucketCalls,
                failure: 0,
              },
              {
                bucket_ms: mainTimelineStartMs + 2 * HOUR_MS,
                label: '01:00',
                calls: mainTimelineBucketCalls,
                tokens: mainTimelineBucketCalls * 100,
                success: mainTimelineBucketCalls,
                failure: 0,
              },
            ],
            api_key_stats: apiKeyStats,
          }
        : emptyAnalyticsResponse;
    const result: UseMonitoringAnalyticsReturn = {
      enabled: Boolean(params.fromMs && params.toMs),
      loading: credentialTimeline ? credentialTimelineLoading : false,
      error: selectors ? selectorError : credentialTimeline ? credentialTimelineError : '',
      data:
        emptyAuxiliarySnapshot && !main && !selectors
          ? emptyAnalyticsResponse
          : selectors
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
              ? mainData
              : apiKeyTimeline && apiKeyTimelineAvailable
                ? {
                    ...emptyAnalyticsResponse,
                    api_key_timeline: [
                      {
                        api_key_hash: 'key-a',
                        bucket_ms: mainTimelineStartMs,
                        calls: 2,
                        tokens: 200,
                        success: 2,
                        failure: 0,
                      },
                      {
                        api_key_hash: 'key-a',
                        bucket_ms: mainTimelineStartMs + 2 * HOUR_MS,
                        calls: 4,
                        tokens: 400,
                        success: 4,
                        failure: 0,
                      },
                    ],
                  }
                : credentialTimeline && !credentialTimelineError && !credentialTimelineLoading
                  ? {
                      ...emptyAnalyticsResponse,
                      credential_timeline: [
                        {
                          id: 'credential-a.json',
                          auth_file_snapshot: 'credential-a.json',
                          bucket_ms: 1,
                          calls: 10,
                          tokens: 150,
                          success: 9,
                          failure: 1,
                        },
                      ],
                    }
                  : null,
      dataStale: !main && !selectors && auxiliaryScopeStale,
      lastRefreshedAt: null,
      serviceBase: 'http://manager.local',
      unavailableReason: '',
      refresh: selectors ? selectorRefresh : main ? mainRefresh : auxiliaryRefresh,
    };
    if (result.data) {
      const key = JSON.stringify(result.data);
      if (!stablePayloads.has(key)) stablePayloads.set(key, result.data);
      result.data = stablePayloads.get(key)!;
    }
    return result;
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
    stablePayloads.clear();
    selectorError = '';
    credentialTimelineError = '';
    credentialTimelineLoading = false;
    emptyAuxiliarySnapshot = false;
    auxiliaryScopeStale = false;
    apiKeyTimelineAvailable = true;
    mainTimelineBucketCalls = 5;
    apiKeyStats = [createApiKeyStatRow()];
    latestResult = null;
    mainRefresh.mockReset();
    selectorRefresh.mockReset();
    auxiliaryRefresh.mockReset();
    monitoringMetaMock.payload = { authFiles: [], channels: [] };
    monitoringMetaMocks.load
      .mockReset()
      .mockImplementation(async () => ({
        ...monitoringMetaMock.payload,
        authFilesLoaded: true,
        channelsLoaded: true,
        error: '',
      }));
    /* defaults are resolved from the fork payload adapter */
    void {
      authFiles: [],
      authFilesLoaded: true,
      channels: [],
      channelsLoaded: true,
      error: '',
    };
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
    await renderHook(
      '/usage-analytics?tab=codexFast&auth_index=codex-a&provider=claude&status=failed&search=unrelated&model=other&from_ms=1000&to_ms=9000'
    );
    const fast = lastParams((params) => Boolean(params.include?.fast_impact));
    expect(latestResult?.activeTab).toBe('codexFast');
    expect(fast?.filters).toEqual({ auth_indices: ['codex-a'], providers: ['codex'] });
    expect(fast?.searchQuery).toBe('');
    expect(fast?.fromMs).toBe(1000);
    expect(fast?.toMs).toBe(9000);
    expect(fast?.fastImpactOptions).toEqual({ mode: 'tier', metric: 'end_to_end_tps' });
    expect(lastParams((params) => Boolean(params.include?.filter_selectors))?.fromMs).toBeNull();
    expect(latestResult?.fastFilters.model).toBe('all');
    expect(latestResult?.fastFilters.status).toBe('all');
  });

  it('requires a single Codex account and clears another provider when entering the tab', async () => {
    monitoringMetaMock.payload.authFiles = [
      { name: 'claude.json', provider: 'claude', auth_index: 'claude-a' },
    ];
    await renderHook('/usage-analytics?tab=performance&auth_index=claude-a');
    await act(async () => {
      latestResult?.setActiveTab('codexFast');
    });
    expect(latestResult?.fastFilters.authIndex).toBe('all');
    expect(lastParams((params) => params.include?.fast_impact === false)?.fromMs).toBeNull();
    await act(async () => {
      latestResult?.setFilters({ authIndex: 'codex-b' });
    });
    expect(lastParams((params) => Boolean(params.include?.fast_impact))?.filters).toEqual({
      auth_indices: ['codex-b'],
      providers: ['codex'],
    });
  });

  it('scopes the Fast account to its tab and restores it only when returning', async () => {
    await renderHook('/usage-analytics?tab=codexFast&auth_index=codex-a');
    expect(lastParams((params) => Boolean(params.include?.fast_impact))?.filters).toEqual({
      auth_indices: ['codex-a'],
      providers: ['codex'],
    });

    await act(async () => {
      latestResult?.setActiveTab('models');
    });
    expect(latestResult?.activeTab).toBe('models');
    expect(latestResult?.filters.authIndex).toBeUndefined();
    expect(latestResult?.filters.provider).toBe('all');
    expect(
      lastParams((params) => Boolean(params.include?.model_stats))?.filters
    ).not.toHaveProperty('auth_indices');
    expect(
      lastParams((params) => Boolean(params.include?.model_stats))?.filters
    ).not.toHaveProperty('providers');

    await act(async () => {
      latestResult?.setActiveTab('codexFast');
    });
    expect(latestResult?.fastFilters.authIndex).toBe('codex-a');
    expect(lastParams((params) => Boolean(params.include?.fast_impact))?.filters).toEqual({
      auth_indices: ['codex-a'],
      providers: ['codex'],
    });
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
      summary_profile: 'compact',
      summary_percentiles: true,
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
    expect(latestResult?.coverage).toEqual(archivedCoverage);

    const selectorScope = selectors?.dataScopeKey;
    await act(async () => {
      latestResult?.setActiveTab('heatmap');
    });

    const heatmap = lastParams((params) => Boolean(params.include?.summary));
    const selectorsAfterTab = lastParams((params) => Boolean(params.include?.filter_selectors));
    expect(heatmap?.include).toEqual({
      summary: true,
      summary_profile: 'compact',
      heatmap: true,
      granularity: 'hour',
    });
    expect(JSON.parse(heatmap?.dataScopeKey ?? '{}')).toMatchObject({ activeTab: 'heatmap' });
    expect(selectorsAfterTab?.dataScopeKey).toBe(selectorScope);
  });

  it('fills missing buckets in the main usage timeline from the active range', async () => {
    await renderHook();

    const overview = lastParams((params) => Boolean(params.include?.summary));
    expect(typeof overview?.fromMs).toBe('number');
    const firstBucketMs = localHourStartMs(overview?.fromMs as number);

    expect(latestResult?.timeline.slice(0, 3).map((point) => point.bucketMs)).toEqual([
      firstBucketMs,
      firstBucketMs + HOUR_MS,
      firstBucketMs + 2 * HOUR_MS,
    ]);
    expect(latestResult?.timeline[1]).toMatchObject({
      requestCount: 0,
      totalTokens: 0,
      successCount: 0,
      failureCount: 0,
      averageLatencyMs: null,
      p95LatencyMs: null,
      p95TtftMs: null,
    });
  });

  it('loads exact timeline buckets for the visible client keys on overview and trends', async () => {
    await renderHook();

    const apiKeyTimeline = lastParams((params) => Boolean(params.include?.api_key_timeline));
    expect(apiKeyTimeline?.include).toEqual({ granularity: 'hour', api_key_timeline: true });
    expect(apiKeyTimeline?.filters).toMatchObject({ api_key_hashes: ['key-a'] });
    expect(JSON.parse(apiKeyTimeline?.dataScopeKey ?? '{}')).toMatchObject({
      activeTab: 'overview',
      apiKeyHashes: ['key-a'],
    });
    expect(
      latestResult?.apiKeyTrendSeries[0].points.slice(0, 3).map((point) => point.value)
    ).toEqual([2, 0, 4]);

    await act(async () => {
      latestResult?.setActiveTab('trends');
      await Promise.resolve();
    });

    const trendsTimeline = lastParams((params) => Boolean(params.include?.api_key_timeline));
    expect(JSON.parse(trendsTimeline?.dataScopeKey ?? '{}')).toMatchObject({
      activeTab: 'trends',
      apiKeyHashes: ['key-a'],
    });
  });

  it('never uses fallback API key IDs for default selections or timeline requests', async () => {
    apiKeyStats = [
      createApiKeyStatRow({
        id: 'unknown-client-api-key:missing-client-key',
        api_key_hash: '',
      }),
      createApiKeyStatRow({ id: 'real-key-row', api_key_hash: ' real-key-hash ' }),
    ];
    await renderHook();

    const overviewTimeline = lastParams((params) => Boolean(params.include?.api_key_timeline));
    expect(overviewTimeline?.filters).toMatchObject({ api_key_hashes: ['real-key-hash'] });
    expect(latestResult?.selectedApiKey?.apiKeyHash).toBe('real-key-hash');

    await act(async () => {
      latestResult?.setActiveTab('apiKeys');
      await Promise.resolve();
    });

    const selectedTimeline = lastParams(
      (params) => Boolean(params.include?.timeline) && !params.include?.summary
    );
    expect(selectedTimeline?.filters).toMatchObject({ api_key_hashes: ['real-key-hash'] });

    await act(async () => {
      latestResult?.setSelectedApiKeyHash('unknown-client-api-key:missing-client-key');
      await Promise.resolve();
    });

    const fallbackSelectionTimeline = lastParams(
      (params) => Boolean(params.include?.timeline) && !params.include?.summary
    );
    expect(fallbackSelectionTimeline?.filters).toMatchObject({ api_key_hashes: ['real-key-hash'] });
    expect(latestResult?.selectedApiKey?.apiKeyHash).toBe('real-key-hash');
  });

  it('uses only real API keys for exact trend series while keeping a leading fallback rank row', async () => {
    apiKeyStats = [
      createApiKeyStatRow({
        id: 'unknown-client-api-key:missing-client-key',
        api_key_hash: '',
        calls: 100,
        cost: 100,
      }),
      ...['key-a', 'key-b', 'key-c', 'key-d'].map((apiKeyHash, index) =>
        createApiKeyStatRow({
          id: apiKeyHash,
          api_key_hash: apiKeyHash,
          calls: 10 - index,
          cost: 10 - index,
        })
      ),
    ];

    await renderHook();

    const apiKeyTimeline = lastParams((params) => Boolean(params.include?.api_key_timeline));
    expect(latestResult?.apiKeyRows[0].id).toBe('unknown-client-api-key:missing-client-key');
    expect(apiKeyTimeline?.filters).toMatchObject({
      api_key_hashes: ['key-a', 'key-b', 'key-c', 'key-d'],
    });
    expect(latestResult?.apiKeyTrendSeries.map((series) => series.id)).toEqual([
      'key-a',
      'key-b',
      'key-c',
      'key-d',
    ]);
    expect(
      latestResult?.apiKeyTrendSeries[0].points.slice(0, 3).map((point) => point.value)
    ).toEqual([2, 0, 4]);
  });

  it('does not approximate fallback-only API key rows as trend series', async () => {
    apiKeyStats = [
      createApiKeyStatRow({
        id: 'unknown-client-api-key:missing-client-key',
        api_key_hash: '',
        calls: 100,
        cost: 100,
      }),
    ];
    apiKeyTimelineAvailable = false;

    await renderHook();

    expect(latestResult?.apiKeyRows).toHaveLength(1);
    expect(latestResult?.apiKeyRows[0].id).toBe('unknown-client-api-key:missing-client-key');
    expect(latestResult?.apiKeyTrendSeries).toEqual([]);
  });

  it('uses complete API key totals for approximate trend shares while hiding fallback rows', async () => {
    apiKeyStats = [
      createApiKeyStatRow({
        id: 'unknown-client-api-key:missing-client-key',
        api_key_hash: '',
        calls: 90,
      }),
      createApiKeyStatRow({
        id: 'real-key-row',
        api_key_hash: 'real-key-hash',
        calls: 10,
      }),
    ];
    mainTimelineBucketCalls = 50;
    apiKeyTimelineAvailable = false;

    await renderHook();

    expect(latestResult?.apiKeyRows.map((row) => row.id)).toEqual([
      'unknown-client-api-key:missing-client-key',
      'real-key-hash',
    ]);
    expect(latestResult?.apiKeyTrendSeries.map((series) => series.id)).toEqual(['real-key-hash']);
    expect(
      latestResult?.apiKeyTrendSeries[0].points.slice(0, 3).map((point) => point.value)
    ).toEqual([5, 0, 5]);
  });

  it('omits an initial fallback API key filter from analytics requests', async () => {
    await renderHook('/usage-analytics?api_key_hash=unknown-client-api-key%3Alegacy-filter');

    const main = lastParams((params) => Boolean(params.include?.summary));
    expect(main?.filters).not.toHaveProperty('api_key_hashes');
  });

  it('keeps a fallback-only aggregate visible without enabling a key timeline request', async () => {
    apiKeyStats = [
      createApiKeyStatRow({
        id: 'unknown-client-api-key:missing-client-key',
        api_key_hash: '',
      }),
    ];
    await renderHook();

    const selectedTimeline = lastParams(
      (params) => Boolean(params.include?.timeline) && !params.include?.summary
    );
    expect(latestResult?.selectedApiKey?.id).toBe('unknown-client-api-key:missing-client-key');
    expect(selectedTimeline?.fromMs).toBeUndefined();
    expect(selectedTimeline?.toMs).toBeUndefined();
    expect(selectedTimeline?.filters).not.toHaveProperty('api_key_hashes');
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

  it('loads only the selected credential timeline after the credential ranking', async () => {
    await renderHook();

    await act(async () => {
      latestResult?.setActiveTab('credentials');
      await Promise.resolve();
    });

    const credentials = lastParams((params) => Boolean(params.include?.credential_stats));
    expect(credentials?.include).toEqual({
      summary: true,
      summary_profile: 'compact',
      credential_stats: true,
      granularity: 'hour',
    });

    const timeline = lastParams((params) => Boolean(params.include?.credential_timeline));
    expect(timeline?.include).toEqual({ granularity: 'hour', credential_timeline: true });
    expect(timeline?.filters).toMatchObject({ credential_ids: ['credential-a.json'] });
    expect(JSON.parse(timeline?.dataScopeKey ?? '{}')).toMatchObject({
      activeTab: 'credentials',
      selectedCredentialID: 'credential-a.json',
    });
    expect(latestResult?.credentialTrendSeries).toHaveLength(1);
    expect(latestResult?.timeline).toEqual([]);
  });

  it('exposes selected credential timeline loading and error states', async () => {
    credentialTimelineLoading = true;
    await renderHook();

    await act(async () => {
      latestResult?.setActiveTab('credentials');
      await Promise.resolve();
    });
    expect(latestResult?.credentialTrendLoading).toBe(true);
    expect(latestResult?.credentialTrendError).toBe('');

    credentialTimelineLoading = false;
    credentialTimelineError = 'timeline failed';
    await act(async () => {
      renderer?.update(
        <MemoryRouter initialEntries={['/usage-analytics']}>
          <Harness />
        </MemoryRouter>
      );
      await Promise.resolve();
    });
    expect(latestResult?.credentialTrendLoading).toBe(false);
    expect(latestResult?.credentialTrendError).toBe('timeline failed');
    expect(latestResult?.credentialRows).toHaveLength(1);
  });

  it('retains last-good metadata when a manual metadata refresh partially fails', async () => {
    monitoringMetaMocks.load.mockResolvedValueOnce({
      authFiles: [
        {
          name: 'credential-a.json',
          auth_index: 'auth-a',
          account: 'retained@example.com',
          provider: 'codex',
        },
      ],
      authFilesLoaded: true,
      channels: [
        {
          key: 'retained:0',
          name: 'retained-channel',
          baseUrl: 'https://retained.test',
          host: 'retained.test',
          disabled: false,
          authIndices: ['auth-a'],
          modelNames: [],
        },
      ],
      channelsLoaded: true,
      error: '',
    });

    await renderHook();
    await act(async () => {
      latestResult?.setActiveTab('credentials');
      await Promise.resolve();
    });
    expect(latestResult?.credentialRows[0]).toMatchObject({
      label: 'retained@example.com',
      account: 'retained@example.com',
      provider: 'codex',
      authIndex: 'auth-a',
    });

    monitoringMetaMocks.load.mockResolvedValueOnce({
      authFiles: [],
      authFilesLoaded: false,
      channels: [],
      channelsLoaded: false,
      error: 'meta offline',
    });
    await act(async () => {
      latestResult?.refresh();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(latestResult?.credentialRows[0]).toMatchObject({
      label: 'retained@example.com',
      account: 'retained@example.com',
      provider: 'codex',
      authIndex: 'auth-a',
    });
    expect(latestResult?.error).toBe('meta offline');
  });

  it('recognizes successful empty auxiliary snapshots but rejects them after scope invalidation', async () => {
    emptyAuxiliarySnapshot = true;
    await renderHook();
    await act(async () => {
      latestResult!.setActiveTab('credentials');
    });
    expect(latestResult!.credentialTrendSeries).toEqual([]);
    expect(latestResult!.credentialTrendLoaded).toBe(true);
    expect(latestResult!.heatmapDateLoaded).toBe(true);
    credentialTimelineLoading = true;
    await act(async () => {
      latestResult!.setSelectedCredentialId('credential-a.json');
    });
    expect(latestResult!.credentialTrendLoaded).toBe(true);
    auxiliaryScopeStale = true;
    await act(async () => {
      latestResult!.setSelectedCredentialId('credential-b.json');
    });
    expect(latestResult!.credentialTrendLoaded).toBe(false);
    expect(latestResult!.heatmapDateLoaded).toBe(false);
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
