import { describe, expect, it } from 'vitest';
import type { MonitoringAnalyticsAccountStatRow } from '@/services/api/usageService';
import { buildSourceInfoMap } from '@/utils/sourceResolver';
import type { MonitoringEventRow } from '../hooks/useMonitoringData';
import { buildAccountRowsFromAnalytics, buildAnalyticsFilters } from './analyticsAdapters';
import { buildAccountRows, buildScopeFilteredRows } from './rowBuilders';

// 复现合版验收 fixture（35 条虚构事件，27 成功 / 8 失败）的分布与 handler 查询：
// - qa-shared Claude 3 条；Codex 21 条 = idx-active 完整快照 10 + idx-retired 3 + idx-active 缺快照 8
// - idx-ambiguous 被 3 个身份共享：qa-red(codex) 4、qa-blue(claude) 5、来源未明 a***(unknown) 2，共 11 条(8 成功 3 失败)
type Spec = {
  count: number;
  failFirst?: boolean;
  account: string;
  authIndex: string;
  provider: string;
  label: string;
};
const SPECS: Spec[] = [
  {
    count: 3,
    account: 'qa-shared@example.invalid',
    authIndex: 'idx-claude',
    provider: 'claude',
    label: 'QA-CLAUDE',
  },
  {
    count: 10,
    account: 'qa-shared@example.invalid',
    authIndex: 'idx-active',
    provider: 'codex',
    label: 'QA-CODEX',
  },
  {
    count: 3,
    account: 'qa-shared@example.invalid',
    authIndex: 'idx-retired',
    provider: 'codex',
    label: 'QA-CODEX',
  },
  { count: 6, account: 'q***@example.invalid', authIndex: 'idx-active', provider: '', label: '' },
  {
    count: 2,
    account: 'q***@example.invalid',
    authIndex: 'idx-active',
    provider: 'unknown',
    label: '',
  },
  {
    count: 4,
    account: 'qa-red@example.invalid',
    authIndex: 'idx-ambiguous',
    provider: 'codex',
    label: 'QA-RED',
  },
  {
    count: 5,
    account: 'qa-blue@example.invalid',
    authIndex: 'idx-ambiguous',
    provider: 'claude',
    label: 'QA-BLUE',
  },
  {
    count: 2,
    account: 'a***@example.invalid',
    authIndex: 'idx-ambiguous',
    provider: 'unknown',
    label: '',
  },
];

const buildFixtureEvents = (): MonitoringEventRow[] => {
  let seq = 0;
  return SPECS.flatMap((spec) =>
    Array.from({ length: spec.count }, (_, index) => {
      seq += 1;
      const id = `qa-${String(seq).padStart(3, '0')}`;
      const timestampMs = 1_795_000_000_000 + seq * 1000;
      return {
        id,
        timestamp: new Date(timestampMs).toISOString(),
        timestampMs,
        dayKey: '2026-11-18',
        hourLabel: '11:00',
        model: 'qa-text',
        endpoint: '/v1/responses',
        endpointMethod: 'POST',
        endpointPath: '/v1/responses',
        sourceKey: '',
        source: spec.label || '-',
        sourceMasked: spec.label || '-',
        account: spec.account,
        accountIdentity: spec.account,
        accountMasked: spec.account,
        authIndex: spec.authIndex,
        authIndexIdentity: spec.authIndex,
        authIndexMasked: spec.authIndex,
        authLabel: spec.label || '-',
        authLabelIdentity: spec.label,
        projectId: '',
        apiKeyHash: '',
        apiKeyLabel: '',
        apiKeyMasked: '',
        provider: spec.provider,
        providerIdentity: spec.provider,
        planType: '',
        channel: '',
        channelHost: '',
        channelDisabled: false,
        failed: index === 0,
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
        searchText: spec.account,
      } as MonitoringEventRow;
    })
  );
};

// 与 handler-queries.json 中 "all".groups 相同的服务端账号聚合（行 ID 为虚构 opaque 值）
const stat = (
  id: string,
  account: string,
  provider: string,
  label: string,
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
const BACKEND_GROUPS = [
  stat('opaque-unassigned', 'a***@example.invalid', 'unknown', '', ['idx-ambiguous'], 2),
  stat('opaque-blue', 'qa-blue@example.invalid', 'claude', 'QA-BLUE', ['idx-ambiguous'], 5),
  stat('opaque-red', 'qa-red@example.invalid', 'codex', 'QA-RED', ['idx-ambiguous'], 4),
  stat(
    'opaque-codex',
    'qa-shared@example.invalid',
    'codex',
    'QA-CODEX',
    ['idx-active', 'idx-retired'],
    21
  ),
  stat('opaque-claude', 'qa-shared@example.invalid', 'claude', 'QA-CLAUDE', ['idx-claude'], 3),
];

// 用 handler-queries.json 的过滤条件在本地事件上模拟服务端精确筛选
const applyHandlerFilters = (
  events: MonitoringEventRow[],
  filters: { auth_indices?: string[]; accounts?: string[]; providers?: string[] }
) =>
  events.filter(
    (event) =>
      (!filters.auth_indices || filters.auth_indices.includes(event.authIndex)) &&
      (!filters.accounts || filters.accounts.includes(event.account)) &&
      (!filters.providers || filters.providers.includes(event.provider))
  );

describe('shared credential index focus (acceptance fixture)', () => {
  const events = buildFixtureEvents();

  it('fixture distribution matches the acceptance totals', () => {
    expect(events).toHaveLength(35);
    expect(events.filter((event) => event.failed)).toHaveLength(8);
    const ambiguous = events.filter((event) => event.authIndex === 'idx-ambiguous');
    expect(ambiguous).toHaveLength(11);
    expect(ambiguous.filter((event) => event.failed)).toHaveLength(3);
  });

  it('backend rows: detail query keeps the exact account for a shared index (4/5/2)', () => {
    const rows = buildAccountRowsFromAnalytics(
      BACKEND_GROUPS,
      new Map(),
      new Map(),
      buildSourceInfoMap({}),
      new Map()
    );
    // opaque 行 ID 原样保留
    expect(rows.map((row) => row.id).sort()).toEqual(BACKEND_GROUPS.map((row) => row.id).sort());
    const detailCount = (id: string) => {
      const row = rows.find((item) => item.id === id)!;
      const filters = buildAnalyticsFilters({ account: row.filterValue }, new Map(), []);
      return {
        filters,
        count: applyHandlerFilters(events, filters).length,
        listed: row.totalCalls,
      };
    };

    const red = detailCount('opaque-red');
    expect(red.filters).toMatchObject({
      auth_indices: ['idx-ambiguous'],
      accounts: ['qa-red@example.invalid'],
    });
    expect([red.listed, red.count]).toEqual([4, 4]);
    const blue = detailCount('opaque-blue');
    expect(blue.filters.accounts).toEqual(['qa-blue@example.invalid']);
    expect([blue.listed, blue.count]).toEqual([5, 5]);
    const unassigned = detailCount('opaque-unassigned');
    expect(unassigned.filters.accounts).toEqual(['a***@example.invalid']);
    expect([unassigned.listed, unassigned.count]).toEqual([2, 2]);

    // 无歧义凭据：仅按索引，缺快照历史仍恢复（21 / 3），不追加账号或 provider 约束
    const codex = detailCount('opaque-codex');
    expect(codex.filters.auth_indices).toEqual(['idx-active', 'idx-retired']);
    expect(codex.filters.accounts).toBeUndefined();
    expect(codex.filters.providers).toBeUndefined();
    expect([codex.listed, codex.count]).toEqual([21, 21]);
    const claude = detailCount('opaque-claude');
    expect(claude.filters.accounts).toBeUndefined();
    expect([claude.listed, claude.count]).toEqual([3, 3]);
  });

  it('local rows: list counts and detail scope agree for shared and unique indices', () => {
    const rows = buildAccountRows(events);
    const byAccount = (account: string, provider: string) =>
      rows.find((row) => row.account === account && row.provider === provider)!;
    const detail = (account: string, provider: string) => {
      const row = byAccount(account, provider);
      const scoped = buildScopeFilteredRows(events, { account: row.filterValue });
      return {
        listed: row.totalCalls,
        detail: scoped.length,
        failed: scoped.filter((event) => event.failed).length,
      };
    };

    expect(detail('qa-red@example.invalid', 'codex')).toEqual({ listed: 4, detail: 4, failed: 1 });
    expect(detail('qa-blue@example.invalid', 'claude')).toEqual({
      listed: 5,
      detail: 5,
      failed: 1,
    });
    expect(detail('a***@example.invalid', 'unknown')).toEqual({ listed: 2, detail: 2, failed: 1 });

    // 无歧义凭据：Codex 列表 13（有快照），按凭据聚焦恢复缺快照共 21
    expect(detail('qa-shared@example.invalid', 'codex')).toEqual({
      listed: 13,
      detail: 21,
      failed: 4,
    });
    expect(detail('qa-shared@example.invalid', 'claude')).toEqual({
      listed: 3,
      detail: 3,
      failed: 1,
    });
    // 同邮箱不同 provider 不合并
    expect(byAccount('qa-shared@example.invalid', 'codex').id).not.toBe(
      byAccount('qa-shared@example.invalid', 'claude').id
    );
  });
});
