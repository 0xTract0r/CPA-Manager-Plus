import { describe, expect, it } from 'vitest';
import type { MonitoringAnalyticsAccountStatRow } from '@/services/api/usageService';
import { buildSourceInfoMap } from '@/utils/sourceResolver';
import type { MonitoringEventRow } from '../hooks/useMonitoringData';
import { buildAccountRowsFromAnalytics, buildAnalyticsFilters } from './analyticsAdapters';
import { buildAccountRows, buildScopeFilteredRows } from './rowBuilders';

// 逐条照搬 hotfix-ui-acceptance/mixed/fixture.jsonl（20 条合成事件，字段与值未改动）
const FIXTURE: Array<[string, string, string, string, string, boolean]> = [
  // [request_id, auth_index, account_snapshot, auth_provider_snapshot, auth_label_snapshot, failed]
  ['mix-001', 'idx-both', 'mixed@example.invalid', 'claude', 'QA-MIX-C', true],
  ['mix-002', 'idx-both', 'mixed@example.invalid', 'claude', 'QA-MIX-C', false],
  ['mix-003', 'idx-both', 'mixed@example.invalid', 'claude', 'QA-MIX-C', false],
  ['mix-004', 'idx-both', 'mixed@example.invalid', 'codex', 'QA-MIX-G', true],
  ['mix-005', 'idx-both', 'mixed@example.invalid', 'codex', 'QA-MIX-G', false],
  ['mix-006', 'idx-both', 'mixed@example.invalid', 'codex', 'QA-MIX-G', false],
  ['mix-007', 'idx-both', 'mixed@example.invalid', 'codex', 'QA-MIX-G', false],
  ['mix-008', 'idx-both', 'mixed@example.invalid', 'codex', 'QA-MIX-G', false],
  ['mix-009', 'idx-solo', 'solo@example.invalid', 'codex', 'QA-SOLO', true],
  ['mix-010', 'idx-solo', 'solo@example.invalid', 'codex', 'QA-SOLO', false],
  ['mix-011', 'idx-solo', 'solo@example.invalid', 'codex', 'QA-SOLO', false],
  ['mix-012', 'idx-solo', 'solo@example.invalid', 'codex', 'QA-SOLO', false],
  ['mix-013', 'idx-solo', 'solo@example.invalid', 'unknown', '', true],
  ['mix-014', 'idx-solo', 'solo@example.invalid', 'unknown', '', false],
  ['mix-015', 'idx-contrast', 'known-d@example.invalid', 'codex', 'QA-KNOWN-D', true],
  ['mix-016', 'idx-contrast', 'known-d@example.invalid', 'codex', 'QA-KNOWN-D', false],
  ['mix-017', 'idx-contrast', 'known-d@example.invalid', 'codex', 'QA-KNOWN-D', false],
  ['mix-018', 'idx-contrast', 'known-d@example.invalid', 'codex', 'QA-KNOWN-D', false],
  ['mix-019', 'idx-contrast', 'other-d@example.invalid', 'unknown', 'QA-UNASSIGNED-D', true],
  ['mix-020', 'idx-contrast', 'other-d@example.invalid', 'unknown', 'QA-UNASSIGNED-D', false],
];

const EVENTS: MonitoringEventRow[] = FIXTURE.map(
  ([id, authIndex, account, provider, label, failed], index) =>
    ({
      id,
      timestamp: new Date(1_795_100_000_000 + index * 1000).toISOString(),
      timestampMs: 1_795_100_000_000 + index * 1000,
      dayKey: '2026-11-18',
      hourLabel: '11:00',
      model: 'qa-text',
      endpoint: '/v1/responses',
      endpointMethod: 'POST',
      endpointPath: '/v1/responses',
      sourceKey: '',
      source: label || '-',
      sourceMasked: label || '-',
      account,
      accountIdentity: account,
      accountMasked: account,
      authIndex,
      authIndexIdentity: authIndex,
      authIndexMasked: authIndex,
      authLabel: label || '-',
      authLabelIdentity: label,
      projectId: '',
      apiKeyHash: '',
      apiKeyLabel: '',
      apiKeyMasked: '',
      provider,
      providerIdentity: provider,
      planType: '',
      channel: '',
      channelHost: '',
      channelDisabled: false,
      failed,
      statsIncluded: true,
      latencyMs: 10,
      ttftMs: 2,
      tokensPerSecond: 1,
      inputTokens: 1,
      outputTokens: 2,
      reasoningTokens: 0,
      cachedTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 3,
      totalCost: 0,
      taskKey: id,
      searchText: account,
    }) as MonitoringEventRow
);

// 照搬 mixed/handler.json 的 groups（服务端 opaque 行 ID 原值）
const group = (
  id: string,
  provider: string,
  label: string,
  account: string,
  authIndices: string[],
  calls: number
): MonitoringAnalyticsAccountStatRow => ({
  id,
  account_snapshot: account,
  auth_label_snapshot: label,
  auth_provider_snapshot: provider,
  auth_indices: authIndices,
  sources: [],
  source_hashes: [],
  calls,
  success_calls: calls - 1,
  failure_calls: 1,
  success_rate: (calls - 1) / calls,
  input_tokens: calls,
  output_tokens: calls * 2,
  cached_tokens: 0,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
  total_tokens: calls * 3,
  cost: 0,
  average_latency_ms: 10,
  last_seen_ms: 1,
  models: [],
});
const ID = {
  unassignedD:
    'monitoring-account:1:account:756E6B6E6F776E:6F746865722D64406578616D706C652E696E76616C6964',
  knownD: 'monitoring-account:1:account:636F646578:6B6E6F776E2D64406578616D706C652E696E76616C6964',
  solo: 'monitoring-account:1:account:636F646578:736F6C6F406578616D706C652E696E76616C6964',
  mixG: 'monitoring-account:1:account:636F646578:6D69786564406578616D706C652E696E76616C6964',
  mixC: 'monitoring-account:1:account:636C61756465:6D69786564406578616D706C652E696E76616C6964',
};
const GROUPS = [
  group(
    ID.unassignedD,
    'unknown',
    'QA-UNASSIGNED-D',
    'other-d@example.invalid',
    ['idx-contrast'],
    2
  ),
  group(ID.knownD, 'codex', 'QA-KNOWN-D', 'known-d@example.invalid', ['idx-contrast'], 4),
  group(ID.solo, 'codex', 'QA-SOLO', 'solo@example.invalid', ['idx-solo'], 6),
  group(ID.mixG, 'codex', 'QA-MIX-G', 'mixed@example.invalid', ['idx-both'], 5),
  group(ID.mixC, 'claude', 'QA-MIX-C', 'mixed@example.invalid', ['idx-both'], 3),
];

// 以 handler 的语义（auth_indices / accounts / providers 精确匹配）在夹具上执行网络 filters
const runHandler = (filters: {
  auth_indices?: string[];
  accounts?: string[];
  providers?: string[];
}) =>
  EVENTS.filter(
    (event) =>
      (!filters.auth_indices || filters.auth_indices.includes(event.authIndex)) &&
      (!filters.accounts || filters.accounts.includes(event.account)) &&
      (!filters.providers || filters.providers.includes(event.provider))
  ).map((event) => event.id);

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `mix-${String(from + i).padStart(3, '0')}`);

describe('mixed shared-index focus (acceptance mixed/fixture.jsonl, 20 events)', () => {
  const backendRows = buildAccountRowsFromAnalytics(
    GROUPS,
    new Map(),
    new Map(),
    buildSourceInfoMap({}),
    new Map()
  );
  const backend = (id: string) => {
    const row = backendRows.find((item) => item.id === id)!;
    // 旧 Manager 行（无 token）点击后 fail-closed；此处校验旧口径计算本身（仅兼容旧链接）
    expect(row.filterValue).toMatch(/^focus-unsupported:/);
    const filters = buildAnalyticsFilters({ account: row.legacyFilterValue }, new Map(), []);
    return { row, filters, hits: runHandler(filters) };
  };

  it('keeps opaque server row ids verbatim and never sends them as accounts', () => {
    expect(backendRows.map((row) => row.id).sort()).toEqual(Object.values(ID).sort());
    Object.values(ID).forEach((id) => {
      const { filters } = backend(id);
      expect(JSON.stringify(filters)).not.toContain('monitoring-account:');
    });
    // 原症状：只传 accounts+index 时 idx-both 两行都是 8
    expect(
      runHandler({ auth_indices: ['idx-both'], accounts: ['mixed@example.invalid'] })
    ).toHaveLength(8);
  });

  it('analytics rows: network filters carry exact account/provider only when needed', () => {
    const mixC = backend(ID.mixC);
    expect(mixC.filters).toEqual({
      auth_indices: ['idx-both'],
      accounts: ['mixed@example.invalid'],
      providers: ['claude'],
    });
    expect(mixC.hits).toEqual(range(1, 3));
    const mixG = backend(ID.mixG);
    expect(mixG.filters).toEqual({
      auth_indices: ['idx-both'],
      accounts: ['mixed@example.invalid'],
      providers: ['codex'],
    });
    expect(mixG.hits).toEqual(range(4, 8));

    // 同名同索引仅一个已知 provider：不加 provider，6 条（含 2 条 unknown）
    const solo = backend(ID.solo);
    expect(solo.filters).toEqual({ auth_indices: ['idx-solo'] });
    expect(solo.hits).toEqual(range(9, 14));

    // 同索引不同原名：各带原始 accounts，4 / 2
    const knownD = backend(ID.knownD);
    expect(knownD.filters).toEqual({
      auth_indices: ['idx-contrast'],
      accounts: ['known-d@example.invalid'],
    });
    expect(knownD.hits).toEqual(range(15, 18));
    const unassignedD = backend(ID.unassignedD);
    expect(unassignedD.filters).toEqual({
      auth_indices: ['idx-contrast'],
      accounts: ['other-d@example.invalid'],
    });
    expect(unassignedD.hits).toEqual(range(19, 20));
  });

  it('local events: list rows and detail scope use the same constraints', () => {
    const rows = buildAccountRows(EVENTS);
    const detail = (account: string, provider: string) => {
      const row = rows.find((item) => item.account === account && item.provider === provider)!;
      const scoped = buildScopeFilteredRows(EVENTS, { account: row.filterValue }).map((e) => e.id);
      const network = runHandler(
        buildAnalyticsFilters({ account: row.filterValue }, new Map(), [])
      );
      return { listed: row.totalCalls, scoped, network };
    };

    expect(detail('mixed@example.invalid', 'claude')).toEqual({
      listed: 3,
      scoped: range(1, 3),
      network: range(1, 3),
    });
    expect(detail('mixed@example.invalid', 'codex')).toEqual({
      listed: 5,
      scoped: range(4, 8),
      network: range(4, 8),
    });
    // 唯一完整凭据快照恢复同组的两条旧记录，列表与详情均为六条。
    expect(detail('solo@example.invalid', 'codex')).toEqual({
      listed: 6,
      scoped: range(9, 14),
      network: range(9, 14),
    });
    expect(rows.filter((row) => row.account === 'solo@example.invalid')).toHaveLength(1);
    expect(detail('known-d@example.invalid', 'codex')).toEqual({
      listed: 4,
      scoped: range(15, 18),
      network: range(15, 18),
    });
    expect(detail('other-d@example.invalid', 'unknown')).toEqual({
      listed: 2,
      scoped: range(19, 20),
      network: range(19, 20),
    });
  });
});
