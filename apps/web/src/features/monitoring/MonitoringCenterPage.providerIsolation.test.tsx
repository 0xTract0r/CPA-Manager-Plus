import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import { AccountOverviewCard } from './MonitoringCenterPage';
import {
  buildEmptyMonitoringStatusData,
  buildMonitoringAccountStatusDataMap,
} from './accountOverviewState';
import { buildAccountRows, buildScopeFilteredRows } from './model/rowBuilders';
import type { MonitoringAccountRow, MonitoringEventRow } from './hooks/useMonitoringData';
import { buildAccountRowsFromAnalytics } from './model/analyticsAdapters';
import { buildMonitoringAccountRowId } from './model/accountIdentity';
import type { MonitoringAnalyticsAccountStatRow } from '@/services/api/usageService';
import { buildSourceInfoMap } from '@/utils/sourceResolver';

// 生产热修 #80/#81 业务验收：同邮箱多提供方统计不混用；缺 provider 快照时按凭据恢复。
// 全部使用虚构账号与内存 fixture。
const t = ((key: string) => key) as TFunction;
const stamp = Date.UTC(2026, 4, 10, 12, 0, 0);
const bounds = {
  startMs: Date.UTC(2026, 4, 10, 0, 0, 0),
  endMs: Date.UTC(2026, 4, 10, 23, 59, 59),
};

const event = (overrides: Partial<MonitoringEventRow>): MonitoringEventRow =>
  ({
    id: 'event',
    timestamp: new Date(stamp).toISOString(),
    timestampMs: stamp,
    dayKey: '2026-05-10',
    hourLabel: '12:00',
    model: 'model-x',
    endpoint: '/v1/messages',
    endpointMethod: 'POST',
    endpointPath: '/v1/messages',
    sourceKey: 'source:fixture',
    source: 'fixture.json',
    sourceMasked: 'f***',
    account: 'shared@example.test',
    accountMasked: 'sha***@example.test',
    authIndex: 'auth-1',
    authIndexMasked: 'auth...1',
    authLabel: 'fixture.json',
    projectId: '',
    apiKeyHash: 'fixture-key-hash',
    apiKeyLabel: 'fx***',
    apiKeyMasked: 'fx***',
    provider: 'codex',
    planType: '',
    channel: 'default',
    channelHost: 'example.test',
    channelDisabled: false,
    failed: false,
    statsIncluded: true,
    latencyMs: 100,
    ttftMs: 10,
    tokensPerSecond: 1,
    inputTokens: 10,
    outputTokens: 5,
    reasoningTokens: 0,
    cachedTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 15,
    totalCost: 0,
    taskKey: 'task',
    searchText: 'shared',
    ...overrides,
  }) as MonitoringEventRow;

const events = [
  event({ id: 'claude-fail', provider: 'claude', authIndex: 'claude-1', failed: true }),
  event({ id: 'codex-old', provider: 'codex', authIndex: 'codex-old' }),
  event({ id: 'codex-new', provider: 'codex', authIndex: 'codex-new' }),
  // 缺少 provider 快照的历史事件：精确凭据聚焦时仍应计入 Codex
  event({ id: 'codex-missing-provider', provider: '', authIndex: 'codex-new' }),
];

const renderCard = (
  row: MonitoringAccountRow,
  statusById: ReturnType<typeof buildMonitoringAccountStatusDataMap>
) =>
  renderToStaticMarkup(
    <AccountOverviewCard
      row={row}
      authState={{ files: [], enabledState: 'enabled' }}
      hasPrices={false}
      locale="en"
      t={t}
      accountDisplayMode="full"
      isExpanded={false}
      isFocused={false}
      statusData={statusById.get(row.id) ?? buildEmptyMonitoringStatusData(bounds)}
      scopeText="Scope: fixture"
      onToggle={() => {}}
      onFocus={() => {}}
      onRefreshQuota={() => {}}
    />
  );

describe('MonitoringCenterPage same-email provider isolation', () => {
  it('renders separate cards whose calls and health do not mix across providers', () => {
    const rows = buildAccountRows(events.filter((item) => item.provider));
    const statusById = buildMonitoringAccountStatusDataMap(events, bounds, rows);
    const claudeRow = rows.find((row) => row.provider === 'claude')!;
    const codexRow = rows.find((row) => row.provider === 'codex')!;

    expect(rows).toHaveLength(2);
    expect(claudeRow.id).not.toBe(codexRow.id);
    // 同提供方内凭据轮转仍合并
    expect(codexRow.authIndices).toEqual(['codex-new', 'codex-old']);
    expect(claudeRow).toMatchObject({ totalCalls: 1, failureCalls: 1 });
    expect(codexRow).toMatchObject({ totalCalls: 2, failureCalls: 0 });
    expect(statusById.get(claudeRow.id)).toMatchObject({ totalSuccess: 0, totalFailure: 1 });
    expect(statusById.get(codexRow.id)?.totalFailure).toBe(0);

    const claudeHtml = renderCard(claudeRow, statusById);
    const codexHtml = renderCard(codexRow, statusById);
    expect(claudeHtml).toContain('shared@example.test');
    expect(codexHtml).toContain('shared@example.test');
    expect(claudeHtml).not.toEqual(codexHtml);
  });

  it('focus filter keeps credential-scoped events with missing provider snapshots', () => {
    const codexRow = buildAccountRows(events.filter((item) => item.provider)).find(
      (row) => row.provider === 'codex'
    )!;
    const focused = buildScopeFilteredRows(events, { account: codexRow.filterValue }).map(
      (item) => item.id
    );
    expect(focused).toEqual(['codex-old', 'codex-new', 'codex-missing-provider']);
    // 热修生成的 provider:<p>|auth:<idx> 旧选择器仍可识别
    expect(
      buildScopeFilteredRows(events, { account: 'provider:codex|auth:codex-new' }).map(
        (item) => item.id
      )
    ).toEqual(['codex-new', 'codex-missing-provider']);
  });
});

describe('server account row ids stay opaque', () => {
  const stat = (
    overrides: Partial<MonitoringAnalyticsAccountStatRow>
  ): MonitoringAnalyticsAccountStatRow => ({
    id: '',
    account_snapshot: '',
    auth_label_snapshot: '',
    auth_provider_snapshot: '',
    auth_indices: [],
    sources: [],
    source_hashes: [],
    calls: 1,
    success_calls: 1,
    failure_calls: 0,
    success_rate: 1,
    input_tokens: 1,
    output_tokens: 1,
    cached_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    total_tokens: 2,
    cost: 0,
    average_latency_ms: null,
    last_seen_ms: 1,
    models: [],
    ...overrides,
  });
  // 虚构的服务端 opaque ID：UI 只能原样使用，不得解析或改写
  const opaque = {
    claudeEmail: 'monitoring-account:1:account:434C41554445:AAAA',
    codexEmail: 'monitoring-account:1:account:434F444558:BBBB',
    claudeHash: 'monitoring-account:1:source-hash:434C41554445:CCCC',
    codexHash: 'monitoring-account:1:source-hash:434F444558:DDDD',
  };
  const adapt = (stats: MonitoringAnalyticsAccountStatRow[]) =>
    buildAccountRowsFromAnalytics(stats, new Map(), new Map(), buildSourceInfoMap({}), new Map());

  it('passes explicit server row ids through verbatim and keeps source-hash-only history unique', () => {
    const rows = adapt([
      stat({
        id: opaque.claudeEmail,
        account_snapshot: 'shared@example.test',
        auth_provider_snapshot: 'claude',
      }),
      stat({
        id: opaque.codexEmail,
        account_snapshot: 'shared@example.test',
        auth_provider_snapshot: 'codex',
      }),
      stat({ id: opaque.claudeHash, auth_provider_snapshot: 'claude', source_hashes: ['hash-c1'] }),
      stat({ id: opaque.codexHash, auth_provider_snapshot: 'codex', source_hashes: ['hash-x1'] }),
    ]);
    expect(rows.map((row) => row.id).sort()).toEqual(Object.values(opaque).sort());
    expect(new Set(rows.map((row) => row.filterValue)).size).toBe(4);
    const byId = new Map(rows.map((row) => [row.id, row]));
    // 无 account_focus_id 的在线行：旧口径只保留在 legacyFilterValue，点击值 fail-closed
    expect(byId.get(opaque.claudeHash)?.legacyFilterValue).toBe('source:hash-c1');
    expect(byId.get(opaque.codexHash)?.legacyFilterValue).toBe('source:hash-x1');
    expect(byId.get(opaque.claudeEmail)?.legacyFilterValue).not.toBe(
      byId.get(opaque.codexEmail)?.legacyFilterValue
    );
    rows.forEach((row) => expect(row.filterValue).toMatch(/^focus-unsupported:/));
  });

  it('builds a provider-scoped source-hash id only when the server omits one', () => {
    const [row] = adapt([stat({ auth_provider_snapshot: 'codex', source_hashes: ['hash-x1'] })]);
    expect(row.id).toBe(buildMonitoringAccountRowId({ provider: 'codex', sourceHash: 'hash-x1' }));
    expect(row.id).not.toBe(
      buildMonitoringAccountRowId({ provider: 'claude', sourceHash: 'hash-x1' })
    );
    // 同 provider 的多条仅 source-hash 历史行不得塌缩为同一 ID
    const rows = adapt([
      stat({ auth_provider_snapshot: 'codex', source_hashes: ['hash-x1'] }),
      stat({ auth_provider_snapshot: 'codex', source_hashes: ['hash-x2'] }),
      stat({ auth_provider_snapshot: 'claude', source_hashes: ['hash-x1'] }),
    ]);
    expect(new Set(rows.map((item) => item.id)).size).toBe(3);
  });
});
