import { describe, expect, it } from 'vitest';
import {
  buildAccountRows,
  buildApiKeyRows,
  buildApiKeyDisplayMap,
  buildMonitoringEventsScopeKey,
  buildMonitoringAuthMetaMap,
  buildMonitoringSummary,
  buildRangeFilteredRows,
  buildScopeFilteredRows,
  mergeMonitoringEventsPageItems,
  resolveMonitoringDisplayEventItems,
  resolveMonitoringPresentationSnapshot,
  withoutMonitoringSnapshotEvents,
  type MonitoringEventRow,
  type MonitoringPresentationSnapshot,
} from './useMonitoringData';
import {
  buildAccountRowsFromAnalytics,
  buildApiKeyRowsFromAnalytics,
} from '../model/analyticsAdapters';
import type { MonitoringAnalyticsEventRow } from '@/services/api/usageService';
import { buildSourceInfoMap } from '@/utils/sourceResolver';
import { sha256Hex } from '@/utils/apiKeyHash';
import type { AuthFileItem } from '@/types';

const createMonitoringEventRow = (
  overrides: Partial<MonitoringEventRow> = {}
): MonitoringEventRow => ({
  id: overrides.id ?? 'row-1',
  timestamp: overrides.timestamp ?? '2026-05-09T01:12:43.000Z',
  timestampMs: overrides.timestampMs ?? Date.parse('2026-05-09T01:12:43.000Z'),
  dayKey: overrides.dayKey ?? '2026-05-09',
  hourLabel: overrides.hourLabel ?? '01:00',
  model: overrides.model ?? 'gpt-4.1',
  resolvedModel: overrides.resolvedModel,
  endpoint: overrides.endpoint ?? '/v1/chat/completions',
  endpointMethod: overrides.endpointMethod ?? 'POST',
  endpointPath: overrides.endpointPath ?? '/v1/chat/completions',
  sourceKey: overrides.sourceKey ?? 'source:alpha',
  source: overrides.source ?? 'alpha.json',
  sourceMasked: overrides.sourceMasked ?? 'a***',
  account: overrides.account ?? 'amount-myth-resend@duck.com',
  accountMasked: overrides.accountMasked ?? 'amo***@duck.com',
  authIndex: overrides.authIndex ?? 'auth-123456',
  authIndexMasked: overrides.authIndexMasked ?? 'auth...3456',
  authLabel: overrides.authLabel ?? 'alpha.json',
  projectId: overrides.projectId ?? 'project-alpha',
  apiKeyHash: overrides.apiKeyHash ?? 'api-key-hash',
  apiKeyLabel: overrides.apiKeyLabel ?? 'ak********sh',
  apiKeyMasked: overrides.apiKeyMasked ?? 'ak********sh',
  provider: overrides.provider ?? 'codex',
  planType: overrides.planType ?? 'pro',
  channel: overrides.channel ?? 'codex',
  channelHost: overrides.channelHost ?? 'example.com',
  channelDisabled: overrides.channelDisabled ?? false,
  failed: overrides.failed ?? false,
  statsIncluded: overrides.statsIncluded ?? true,
  latencyMs: overrides.latencyMs ?? 1200,
  ttftMs: overrides.ttftMs ?? 200,
  tokensPerSecond: overrides.tokensPerSecond ?? 5,
  inputTokens: overrides.inputTokens ?? 10,
  outputTokens: overrides.outputTokens ?? 5,
  reasoningTokens: overrides.reasoningTokens ?? 0,
  cachedTokens: overrides.cachedTokens ?? 3,
  cacheReadTokens: overrides.cacheReadTokens ?? 0,
  cacheCreationTokens: overrides.cacheCreationTokens ?? 0,
  totalTokens: overrides.totalTokens ?? 18,
  totalCost: overrides.totalCost ?? 0.12,
  taskKey: overrides.taskKey ?? 'task-1',
  searchText: overrides.searchText ?? 'amount myth resend',
});

const createPresentationSnapshot = (id: string): MonitoringPresentationSnapshot => {
  const row = createMonitoringEventRow({ id });
  return {
    summary: buildMonitoringSummary([row]),
    timeline: [{ label: id, requests: 1, tokens: row.totalTokens, cost: row.totalCost }],
    timelineGranularity: 'hour',
    hourlyDistribution: [],
    modelShareRows: [],
    channelRows: [],
    modelRows: [],
    failureSourceRows: [],
    taskBuckets: [],
    recentFailures: [],
    accountRows: buildAccountRows([row]),
    apiKeyRows: buildApiKeyRows([row]),
    filterOptions: {
      accountRows: buildAccountRows([row]),
      apiKeyRows: buildApiKeyRows([row]),
      providers: [row.provider],
      models: [row.model],
      channels: [row.channel],
      headerTraceIds: [],
    },
    filteredRows: [row],
    eventsHasMore: id.includes('more'),
    eventsLoadingMore: false,
    eventsRetentionLimited: false,
    eventsTotalCount: 1,
    eventsLoadedCount: 1,
    lastRefreshedAt: new Date(1_768_759_000_000),
  };
};

describe('analytics aggregate row adapters', () => {
  const authMetaMap = buildMonitoringAuthMetaMap([
    {
      name: 'team.json',
      provider: 'codex',
      authIndex: 'auth-123456',
      path: '/tmp/auths/team.json',
      account: 'team@example.com',
      label: 'Team Account',
    },
  ]);
  const authFileMap = new Map();
  const sourceInfoMap = buildSourceInfoMap({});
  const channelByAuthIndex = new Map([
    [
      'auth-123456',
      {
        key: 'codex',
        name: 'Codex',
        baseUrl: 'https://api.openai.com',
        host: 'api.openai.com',
        disabled: false,
        authIndices: ['auth-123456'],
        modelNames: ['gpt-4.1'],
      },
    ],
  ]);

  it('builds account rows from full backend aggregates instead of event pages', () => {
    const rows = buildAccountRowsFromAnalytics(
      [
        {
          id: 'team@example.com',
          account_snapshot: 'team@example.com',
          auth_label_snapshot: 'Team Account',
          auth_provider_snapshot: 'codex',
          auth_indices: ['auth-123456'],
          sources: ['team.json'],
          source_hashes: ['source-hash'],
          calls: 3,
          success_calls: 2,
          failure_calls: 1,
          success_rate: 2 / 3,
          input_tokens: 31,
          output_tokens: 12,
          cached_tokens: 0,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
          total_tokens: 43,
          cost: 0.42,
          average_latency_ms: 1200,
          last_seen_ms: 1_768_759_000_000,
          models: [
            {
              model: 'gpt-4.1',
              calls: 3,
              success_calls: 2,
              failure_calls: 1,
              success_rate: 2 / 3,
              input_tokens: 31,
              output_tokens: 12,
              cached_tokens: 0,
              cache_read_tokens: 0,
              cache_creation_tokens: 0,
              total_tokens: 43,
              cost: 0.42,
              last_seen_ms: 1_768_759_000_000,
            },
          ],
        },
      ],
      authMetaMap,
      authFileMap,
      sourceInfoMap,
      channelByAuthIndex
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      account: 'team@example.com',
      totalCalls: 3,
      failureCalls: 1,
      totalTokens: 43,
      totalCost: 0.42,
    });
    expect(rows[0].models[0]).toMatchObject({ model: 'gpt-4.1', totalCalls: 3 });
  });

  it('builds api key rows from full backend aggregates and keeps aliases', () => {
    const rows = buildApiKeyRowsFromAnalytics(
      [
        {
          id: 'client-key-hash',
          api_key_hash: 'client-key-hash',
          account_snapshot: 'team@example.com',
          auth_label_snapshot: 'Team Account',
          auth_provider_snapshot: 'codex',
          auth_indices: ['auth-123456'],
          sources: ['team.json'],
          source_hashes: ['source-hash'],
          calls: 3,
          success_calls: 2,
          failure_calls: 1,
          success_rate: 2 / 3,
          input_tokens: 31,
          output_tokens: 12,
          cached_tokens: 0,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
          total_tokens: 43,
          cost: 0.42,
          average_latency_ms: 1200,
          last_seen_ms: 1_768_759_000_000,
          models: [],
        },
      ],
      authMetaMap,
      authFileMap,
      sourceInfoMap,
      channelByAuthIndex,
      new Map([['client-key-hash', { label: 'Team Key', masked: 'sk********ey' }]])
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      apiKeyHash: 'client-key-hash',
      apiKeyLabel: 'Team Key',
      apiKeyMasked: 'sk********ey',
      totalCalls: 3,
      failureCalls: 1,
      totalTokens: 43,
    });
  });
});

describe('buildAccountRows', () => {
  it('keeps raw auth indices for account-level auth file linking', () => {
    const rows = buildAccountRows([
      createMonitoringEventRow(),
      createMonitoringEventRow({
        id: 'row-2',
        timestampMs: Date.parse('2026-05-09T02:12:43.000Z'),
        authIndex: 'auth-999999',
        authIndexMasked: 'auth...9999',
        sourceKey: 'source:beta',
      }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].authIndices).toEqual(['auth-123456', 'auth-999999']);
    expect(rows[0].sourceKeys).toEqual(['source:alpha', 'source:beta']);
  });
});

describe('buildMonitoringAuthMetaMap', () => {
  it('maps legacy auth indices to current auth metadata', () => {
    const authFiles: AuthFileItem[] = [
      {
        name: 'alice.json',
        provider: 'codex',
        authIndex: 'current-auth-index',
        path: '/tmp/auths/alice.json',
        account: 'alice@example.com',
      },
    ];

    const map = buildMonitoringAuthMetaMap(authFiles);

    expect(map.get('current-auth-index')?.account).toBe('alice@example.com');
    expect(map.get('6bf749cb7db0e15c')?.account).toBe('alice@example.com');
  });
});

describe('buildApiKeyDisplayMap', () => {
  it('prefers stored aliases while preserving masked configured keys', () => {
    const apiKey = 'sk-alias-test-key';
    const apiKeyHash = sha256Hex(apiKey);
    const map = buildApiKeyDisplayMap([apiKey], [{ apiKeyHash, alias: 'Team A', updatedAtMs: 1 }]);

    expect(map.get(apiKeyHash)?.label).toBe('Team A');
    expect(map.get(apiKeyHash)?.masked).toMatch(/^sk/);
  });

  it('masks key-like aliases before display', () => {
    const apiKey = 'sk-alias-test-key';
    const apiKeyHash = sha256Hex(apiKey);
    const map = buildApiKeyDisplayMap(
      [apiKey],
      [{ apiKeyHash, alias: 'sk-proj-secret-value-123456', updatedAtMs: 1 }]
    );

    expect(map.get(apiKeyHash)?.label).toMatch(/^sk/);
    expect(map.get(apiKeyHash)?.label).toContain('**');
    expect(map.get(apiKeyHash)?.label).not.toContain('secret-value');
  });
});

describe('buildApiKeyRows', () => {
  it('groups usage by client api key and aggregates model spend', () => {
    const rows = buildApiKeyRows([
      createMonitoringEventRow({
        id: 'row-1',
        apiKeyHash: 'hash-a',
        apiKeyLabel: 'Team A',
        apiKeyMasked: 'sk********aa',
        model: 'gpt-4.1',
        totalTokens: 18,
        totalCost: 0.12,
      }),
      createMonitoringEventRow({
        id: 'row-2',
        apiKeyHash: 'hash-a',
        apiKeyLabel: 'Team A',
        apiKeyMasked: 'sk********aa',
        model: 'gpt-4.1',
        failed: true,
        totalTokens: 7,
        totalCost: 0.03,
      }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      apiKeyHash: 'hash-a',
      apiKeyLabel: 'Team A',
      totalCalls: 2,
      successCalls: 1,
      failureCalls: 1,
      totalTokens: 25,
      totalCost: 0.15,
    });
    expect(rows[0].models[0]).toMatchObject({
      model: 'gpt-4.1',
      totalCalls: 2,
      failureCalls: 1,
    });
  });

  it('keeps unknown client keys separated by source and channel', () => {
    const rows = buildApiKeyRows([
      createMonitoringEventRow({
        id: 'unknown-1',
        apiKeyHash: '',
        apiKeyLabel: '-',
        apiKeyMasked: '-',
        sourceKey: 'source:a',
        authIndex: 'auth-a',
        channel: 'channel-a',
      }),
      createMonitoringEventRow({
        id: 'unknown-2',
        apiKeyHash: '',
        apiKeyLabel: '-',
        apiKeyMasked: '-',
        sourceKey: 'source:b',
        authIndex: 'auth-b',
        channel: 'channel-b',
      }),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.isUnknown)).toBe(true);
  });
});

describe('buildRangeFilteredRows', () => {
  it('matches a raw api key search through its hash without breaking text search', () => {
    const rows = [
      createMonitoringEventRow({
        id: 'hash-a',
        apiKeyHash: 'hash-a',
        searchText: 'hash-a team a',
      }),
      createMonitoringEventRow({
        id: 'hash-b',
        apiKeyHash: 'hash-b',
        searchText: 'hash-b team b',
      }),
    ];

    expect(buildRangeFilteredRows(rows, 'all', null, 'team b', '').map((row) => row.id)).toEqual([
      'hash-b',
    ]);
    expect(
      buildRangeFilteredRows(rows, 'all', null, 'unmatched raw key', 'hash-a').map((row) => row.id)
    ).toEqual(['hash-a']);
  });
});

describe('buildScopeFilteredRows', () => {
  it('applies failed-only status filtering to realtime rows locally', () => {
    const rows = [
      createMonitoringEventRow({ id: 'success-row', failed: false }),
      createMonitoringEventRow({ id: 'failed-row', failed: true }),
    ];

    expect(buildScopeFilteredRows(rows, { status: 'failed' }).map((row) => row.id)).toEqual([
      'failed-row',
    ]);
  });

  it('matches account focus against account and fallback display fields', () => {
    const rows = [
      createMonitoringEventRow({
        id: 'alice-row',
        account: 'alice@example.com',
        authLabel: 'Alice Auth',
      }),
      createMonitoringEventRow({
        id: 'legacy-row',
        account: '',
        authLabel: 'Legacy Auth',
        source: 'legacy-source',
      }),
      createMonitoringEventRow({
        id: 'bob-row',
        account: 'bob@example.com',
        authLabel: 'Bob Auth',
      }),
    ];

    expect(
      buildScopeFilteredRows(rows, { account: 'alice@example.com' }).map((row) => row.id)
    ).toEqual(['alice-row']);
    expect(buildScopeFilteredRows(rows, { account: 'Legacy Auth' }).map((row) => row.id)).toEqual([
      'legacy-row',
    ]);
  });

  it('applies latency and cache drilldown filters to realtime rows locally', () => {
    const rows = [
      createMonitoringEventRow({
        id: 'fast-cache-hit',
        latencyMs: 2_000,
        cachedTokens: 5,
      }),
      createMonitoringEventRow({
        id: 'slow-cache-hit',
        latencyMs: 12_000,
        cacheReadTokens: 3,
      }),
      createMonitoringEventRow({
        id: 'slow-cache-miss',
        latencyMs: 15_000,
        cachedTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      }),
      createMonitoringEventRow({
        id: 'unknown-latency',
        latencyMs: null,
      }),
    ];

    expect(buildScopeFilteredRows(rows, { minLatencyMs: 10_000 }).map((row) => row.id)).toEqual([
      'slow-cache-hit',
      'slow-cache-miss',
    ]);
    expect(buildScopeFilteredRows(rows, { cacheStatus: 'hit' }).map((row) => row.id)).toEqual([
      'fast-cache-hit',
      'slow-cache-hit',
      'unknown-latency',
    ]);
    expect(
      buildScopeFilteredRows(rows, { minLatencyMs: 10_000, cacheStatus: 'miss' }).map(
        (row) => row.id
      )
    ).toEqual(['slow-cache-miss']);
  });
});

describe('buildMonitoringEventsScopeKey', () => {
  it('keeps moving ranges stable when only the end time changes', () => {
    const first = buildMonitoringEventsScopeKey(
      'today',
      { startMs: 1_768_755_200_000, endMs: 1_768_759_000_000 },
      '',
      '',
      {},
      'hour'
    );
    const second = buildMonitoringEventsScopeKey(
      'today',
      { startMs: 1_768_755_200_000, endMs: 1_768_759_005_000 },
      '',
      '',
      {},
      'hour'
    );

    expect(second).toBe(first);
  });

  // 复现根因(a)：滚动档(24h 等)每 30s 自动刷新会让 startMs 前移 ~30000ms。
  // scopeKey 必须保持不变，否则 eventsDataStale 会被误翻 true、事件表回退到被清空的快照。
  it('keeps rolling-window ranges stable when the drifting start time moves forward', () => {
    const nowMs = 1_768_759_000_000;
    const DAY_MS = 24 * 60 * 60 * 1000;
    // 第一次刷新：[now - 24h, now]
    const first = buildMonitoringEventsScopeKey(
      '24h',
      { startMs: nowMs - DAY_MS, endMs: nowMs },
      '',
      '',
      {},
      'hour'
    );
    // 30s 后自动刷新：startMs 与 endMs 各前移 30000ms（滚动窗漂移）
    const driftedNowMs = nowMs + 30_000;
    const second = buildMonitoringEventsScopeKey(
      '24h',
      { startMs: driftedNowMs - DAY_MS, endMs: driftedNowMs },
      '',
      '',
      {},
      'hour'
    );

    expect(second).toBe(first);
  });

  // 防回归：切换档位(24h → 7d)时 scopeKey 仍必须变化，触发正常 stale/refetch。
  it('changes the scope key when the preset changes', () => {
    const nowMs = 1_768_759_000_000;
    const DAY_MS = 24 * 60 * 60 * 1000;
    const twentyFourHour = buildMonitoringEventsScopeKey(
      '24h',
      { startMs: nowMs - DAY_MS, endMs: nowMs },
      '',
      '',
      {},
      'hour'
    );
    const sevenDay = buildMonitoringEventsScopeKey(
      '7d',
      { startMs: nowMs - 7 * DAY_MS, endMs: nowMs },
      '',
      '',
      {},
      'day'
    );

    expect(sevenDay).not.toBe(twentyFourHour);
  });

  it('keeps custom ranges tied to the explicit end time', () => {
    const first = buildMonitoringEventsScopeKey(
      'custom',
      { startMs: 1_768_755_200_000, endMs: 1_768_759_000_000 },
      '',
      '',
      {},
      'hour'
    );
    const second = buildMonitoringEventsScopeKey(
      'custom',
      { startMs: 1_768_755_200_000, endMs: 1_768_759_005_000 },
      '',
      '',
      {},
      'hour'
    );

    expect(second).not.toBe(first);
  });
});

describe('mergeMonitoringEventsPageItems', () => {
  const createAnalyticsEvent = (
    eventHash: string,
    timestampMs: number
  ): MonitoringAnalyticsEventRow => ({
    event_hash: eventHash,
    timestamp_ms: timestampMs,
    model: 'gpt-4.1',
    endpoint: 'POST /v1/chat/completions',
    method: 'POST',
    path: '/v1/chat/completions',
    auth_index: 'auth-1',
    source: 'source-1',
    source_hash: 'source-hash-1',
    api_key_hash: 'api-key-hash-1',
    account_snapshot: 'alice@example.com',
    auth_label_snapshot: 'alice.json',
    auth_provider_snapshot: 'codex',
    input_tokens: 10,
    output_tokens: 5,
    cached_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    reasoning_tokens: 0,
    total_tokens: 15,
    latency_ms: 1200,
    ttft_ms: 200,
    failed: false,
  });

  it('merges root refresh results without dropping previously rendered events', () => {
    const previous = [
      createAnalyticsEvent('event-2', 1_768_759_001_000),
      createAnalyticsEvent('event-1', 1_768_759_000_000),
    ];
    const nextPage = [
      createAnalyticsEvent('event-3', 1_768_759_002_000),
      createAnalyticsEvent('event-2', 1_768_759_001_000),
    ];

    expect(
      mergeMonitoringEventsPageItems(previous, nextPage, null).map((item) => item.event_hash)
    ).toEqual(['event-3', 'event-2', 'event-1']);
  });

  it('keeps only the newest 2000 deduplicated events', () => {
    const previous = Array.from({ length: 2_000 }, (_, index) =>
      createAnalyticsEvent(`old-${index}`, 10_000 - index)
    );
    const nextPage = Array.from({ length: 500 }, (_, index) =>
      createAnalyticsEvent(`new-${index}`, 20_000 - index)
    );

    const merged = mergeMonitoringEventsPageItems(previous, nextPage, null);
    expect(merged).toHaveLength(2_000);
    expect(merged[0]?.event_hash).toBe('new-0');
    expect(merged[499]?.event_hash).toBe('new-499');
    expect(merged[merged.length - 1]?.event_hash).toBe('old-1499');
  });
});

describe('withoutMonitoringSnapshotEvents', () => {
  it('keeps aggregate presentation data without retaining event rows', () => {
    const snapshot = createPresentationSnapshot('cached');
    const cached = withoutMonitoringSnapshotEvents(snapshot);

    expect(cached.summary).toBe(snapshot.summary);
    expect(cached.filteredRows).toEqual([]);
    expect(cached.eventsLoadedCount).toBe(0);
    expect(cached.eventsTotalCount).toBe(0);
    expect(cached.eventsHasMore).toBe(false);
  });
});

describe('resolveMonitoringDisplayEventItems', () => {
  const createAnalyticsEvent = (
    eventHash: string,
    timestampMs: number
  ): MonitoringAnalyticsEventRow => ({
    event_hash: eventHash,
    timestamp_ms: timestampMs,
    model: 'gpt-4.1',
    endpoint: 'POST /v1/chat/completions',
    method: 'POST',
    path: '/v1/chat/completions',
    auth_index: 'auth-1',
    source: 'source-1',
    source_hash: 'source-hash-1',
    api_key_hash: 'api-key-hash-1',
    account_snapshot: 'alice@example.com',
    auth_label_snapshot: 'alice.json',
    auth_provider_snapshot: 'codex',
    input_tokens: 10,
    output_tokens: 5,
    cached_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    reasoning_tokens: 0,
    total_tokens: 15,
    latency_ms: 1200,
    ttft_ms: 200,
    failed: false,
  });

  it('reuses persisted page items while the analytics response has no new event page', () => {
    const eventsPageItems = [createAnalyticsEvent('event-1', 1_768_759_000_000)];

    const first = resolveMonitoringDisplayEventItems({
      analyticsData: null,
      currentPageItems: null,
      eventsPageItems,
      eventsBeforeMs: null,
      dataStale: false,
    });
    const second = resolveMonitoringDisplayEventItems({
      analyticsData: null,
      currentPageItems: null,
      eventsPageItems,
      eventsBeforeMs: null,
      dataStale: false,
    });

    expect(first).toBe(eventsPageItems);
    expect(second).toBe(eventsPageItems);
  });

  it('keeps stale transitions on existing page items without creating a new array', () => {
    const eventsPageItems = [createAnalyticsEvent('event-1', 1_768_759_000_000)];
    const analyticsItems = [createAnalyticsEvent('event-2', 1_768_759_001_000)];

    expect(
      resolveMonitoringDisplayEventItems({
        analyticsData: { events: { items: analyticsItems } },
        currentPageItems: analyticsItems,
        eventsPageItems,
        eventsBeforeMs: null,
        dataStale: true,
      })
    ).toBe(eventsPageItems);
  });

  it('reuses persisted page items after the same analytics page has been absorbed', () => {
    const analyticsItems = [
      createAnalyticsEvent('event-2', 1_768_759_001_000),
      createAnalyticsEvent('event-1', 1_768_759_000_000),
    ];
    const eventsPageItems = [
      createAnalyticsEvent('event-2', 1_768_759_001_000),
      createAnalyticsEvent('event-1', 1_768_759_000_000),
    ];

    expect(
      resolveMonitoringDisplayEventItems({
        analyticsData: { events: { items: analyticsItems } },
        currentPageItems: analyticsItems,
        eventsPageItems,
        eventsBeforeMs: null,
        dataStale: false,
      })
    ).toBe(eventsPageItems);
  });
});

describe('resolveMonitoringPresentationSnapshot', () => {
  it('keeps the last stable presentation while a new uncached scope is loading', () => {
    const computed = createPresentationSnapshot('computed-empty-transition');
    const stable = createPresentationSnapshot('stable-all');
    const result = resolveMonitoringPresentationSnapshot({
      computedSnapshot: computed,
      scopeKey: 'failed',
      dataStale: true,
      cachedSnapshots: new Map(),
      lastStableSnapshot: stable,
    });

    expect(result.snapshot).toBe(stable);
    expect(result.hasPresentationSnapshot).toBe(true);
    expect(result.usingSnapshotFallback).toBe(true);
  });

  it('prefers a cached target scope presentation over the last stable scope', () => {
    const computed = createPresentationSnapshot('computed-transition');
    const stable = createPresentationSnapshot('stable-all');
    const cachedFailed = createPresentationSnapshot('cached-failed');
    const result = resolveMonitoringPresentationSnapshot({
      computedSnapshot: computed,
      scopeKey: 'failed',
      dataStale: true,
      cachedSnapshots: new Map([['failed', cachedFailed]]),
      lastStableSnapshot: stable,
    });

    expect(result.snapshot).toBe(cachedFailed);
    expect(result.hasPresentationSnapshot).toBe(true);
    expect(result.usingSnapshotFallback).toBe(true);
  });

  it('returns the computed presentation for fresh data', () => {
    const computed = createPresentationSnapshot('computed-fresh');
    const stable = createPresentationSnapshot('stable-all');
    const result = resolveMonitoringPresentationSnapshot({
      computedSnapshot: computed,
      scopeKey: 'all',
      dataStale: false,
      cachedSnapshots: new Map([['all', stable]]),
      lastStableSnapshot: stable,
    });

    expect(result.snapshot).toBe(computed);
    expect(result.hasPresentationSnapshot).toBe(true);
    expect(result.usingSnapshotFallback).toBe(false);
  });
});

// 端到端复现"实时事件表 30s 自动刷新闪屏"根因：滚动档 startMs 漂移 → scopeKey 变 →
// eventsDataStale 翻 true → 事件表回退到被 withoutMonitoringSnapshotEvents 清空事件的缓存
// 快照(filteredRows=[]) → 某一帧渲染 0 行 → 整表重挂载。
//
// 关键：eventsDataStale 的真实定义(见 useMonitoringAnalytics)是
//   Boolean(dataScopeKey && data && dataScopeStateKey !== activeDataScopeKey)
// 即"上次成功落盘用的 scopeKey" !== "当前 scopeKey"。scopeKey 稳定 → 不 stale → 用 computed。
describe('monitoring realtime table stability across 30s auto-refresh', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const REFRESH_INTERVAL_MS = 30_000;

  // 模拟 useMonitoringAnalytics.dataStale 判定：已落盘 scope !== 当前 scope 即 stale。
  const computeEventsDataStale = (persistedScopeKey: string, currentScopeKey: string) =>
    persistedScopeKey !== currentScopeKey;

  it('never resolves the realtime table to an empty frame during same-preset background refresh', () => {
    const baseNowMs = 1_768_759_000_000;
    const buildScopeAt = (nowMs: number) =>
      buildMonitoringEventsScopeKey(
        '24h',
        { startMs: nowMs - DAY_MS, endMs: nowMs },
        '',
        '',
        {},
        'hour'
      );

    // 首屏成功落盘：scopeKey 记为 persistedScopeKey，缓存快照按落盘规则清空事件字段。
    const persistedScopeKey = buildScopeAt(baseNowMs);
    const firstComputed = createPresentationSnapshot('first-fresh-rows');
    expect(firstComputed.filteredRows.length).toBeGreaterThan(0);
    const cachedSnapshots = new Map([
      [persistedScopeKey, withoutMonitoringSnapshotEvents(firstComputed)],
    ]);
    const lastStableSnapshot = withoutMonitoringSnapshotEvents(firstComputed);

    // 30s 后台自动刷新（同 24h 档，请求真实发生一帧）：新 nowMs 漂移，但 scopeKey 必须稳定。
    const refreshedNowMs = baseNowMs + REFRESH_INTERVAL_MS;
    const currentScopeKey = buildScopeAt(refreshedNowMs);
    expect(currentScopeKey).toBe(persistedScopeKey);

    // 刷新拿到新数据前的这一帧：computed 仍带真实行；stale 由稳定 scope 决定，应为 false。
    const refreshingComputed = createPresentationSnapshot('refreshing-rows');
    const eventsDataStale = computeEventsDataStale(persistedScopeKey, currentScopeKey);
    expect(eventsDataStale).toBe(false);

    const resolution = resolveMonitoringPresentationSnapshot({
      computedSnapshot: refreshingComputed,
      scopeKey: currentScopeKey,
      dataStale: eventsDataStale,
      cachedSnapshots,
      lastStableSnapshot,
    });

    // 根因断言：解析出的事件行全程非空、从不为 []（未修复前 scopeKey 会变 → stale=true →
    // 回退到清空事件的缓存快照 → filteredRows=[]，此断言会红）。
    expect(resolution.snapshot.filteredRows).not.toEqual([]);
    expect(resolution.snapshot.filteredRows.length).toBeGreaterThan(0);
    expect(resolution.usingSnapshotFallback).toBe(false);
  });

  // 数据新鲜度守卫：稳定 scopeKey 下拿到"新数据"时，解析结果必须更新为新数据（不冻结旧数据）。
  it('updates the realtime rows to newly fetched data under a stable scope key', () => {
    const baseNowMs = 1_768_759_000_000;
    const persistedScopeKey = buildMonitoringEventsScopeKey(
      '24h',
      { startMs: baseNowMs - DAY_MS, endMs: baseNowMs },
      '',
      '',
      {},
      'hour'
    );

    // 上一轮稳定快照的行（旧数据），落盘时事件被清空。
    const previousComputed = createPresentationSnapshot('previous-rows');
    const cachedSnapshots = new Map([
      [persistedScopeKey, withoutMonitoringSnapshotEvents(previousComputed)],
    ]);
    const lastStableSnapshot = withoutMonitoringSnapshotEvents(previousComputed);

    // 30s 后自动刷新拿到新数据：scopeKey 稳定，computed 带新行。
    const refreshedNowMs = baseNowMs + REFRESH_INTERVAL_MS;
    const currentScopeKey = buildMonitoringEventsScopeKey(
      '24h',
      { startMs: refreshedNowMs - DAY_MS, endMs: refreshedNowMs },
      '',
      '',
      {},
      'hour'
    );
    expect(currentScopeKey).toBe(persistedScopeKey);

    const newComputed = createPresentationSnapshot('new-fetched-rows');
    const eventsDataStale = computeEventsDataStale(persistedScopeKey, currentScopeKey);

    const resolution = resolveMonitoringPresentationSnapshot({
      computedSnapshot: newComputed,
      scopeKey: currentScopeKey,
      dataStale: eventsDataStale,
      cachedSnapshots,
      lastStableSnapshot,
    });

    // 必须解析为本次新数据(newComputed)，而非上一轮旧行/清空快照。
    expect(resolution.snapshot).toBe(newComputed);
    expect(resolution.snapshot.filteredRows[0]?.id).toBe('new-fetched-rows');
  });
});
