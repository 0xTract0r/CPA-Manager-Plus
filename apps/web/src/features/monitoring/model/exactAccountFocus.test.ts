import { describe, expect, it } from 'vitest';
import type { MonitoringAnalyticsAccountStatRow } from '@/services/api/usageService';
import { buildSourceInfoMap } from '@/utils/sourceResolver';
import type { MonitoringEventRow } from '../hooks/useMonitoringData';
import {
  ACCOUNT_FOCUS_BLOCKED_AUTH_INDEX,
  buildAccountRowsFromAnalytics,
  buildAnalyticsFilters,
  parseMonitoringAccountFilterValue,
  readMonitoringAccountFocusId,
} from './analyticsAdapters';
import {
  collectIssuedAccountFocusIds,
  resolveMonitoringAccountFocusNotice,
  resolveMonitoringAccountFocusState,
} from './monitoringAnalyticsModel';
import { buildAccountRows, buildScopeFilteredRows } from './rowBuilders';

// 全部为合成样本；focus token 刻意与 row.id 完全不同，且不可从 id/账号推导。
const stat = (
  overrides: Partial<MonitoringAnalyticsAccountStatRow> & { id: string }
): MonitoringAnalyticsAccountStatRow => ({
  account_snapshot: 'a@example.invalid',
  auth_label_snapshot: '',
  auth_provider_snapshot: 'codex',
  auth_indices: ['idx-shared'],
  sources: [],
  source_hashes: [],
  calls: 3,
  success_calls: 3,
  failure_calls: 0,
  success_rate: 1,
  input_tokens: 0,
  output_tokens: 0,
  cached_tokens: 0,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
  total_tokens: 0,
  cost: 0,
  average_latency_ms: null,
  last_seen_ms: 1,
  models: [],
  ...overrides,
});

const adapt = (rows: MonitoringAnalyticsAccountStatRow[]) =>
  buildAccountRowsFromAnalytics(rows, new Map(), new Map(), buildSourceInfoMap({}), new Map());

let seq = 0;
const ev = (o: {
  account: string;
  provider: string;
  authIndex: string;
  channel?: string;
  apiKeyHash?: string;
}): MonitoringEventRow => {
  seq += 1;
  const id = `e-${String(seq).padStart(3, '0')}`;
  return {
    id,
    timestamp: new Date(1_795_000_000_000 + seq * 1000).toISOString(),
    timestampMs: 1_795_000_000_000 + seq * 1000,
    dayKey: '2026-11-18',
    hourLabel: '11:00',
    model: 'm',
    endpoint: '/v1/responses',
    endpointMethod: 'POST',
    endpointPath: '/v1/responses',
    sourceKey: '',
    source: '-',
    sourceMasked: '-',
    account: o.account,
    accountIdentity: o.account,
    accountMasked: o.account,
    authIndex: o.authIndex,
    authIndexIdentity: o.authIndex,
    authIndexMasked: o.authIndex,
    authLabel: '-',
    projectId: '',
    apiKeyHash: o.apiKeyHash ?? '',
    apiKeyLabel: '',
    apiKeyMasked: '',
    provider: o.provider,
    providerIdentity: o.provider,
    planType: '',
    channel: o.channel ?? '',
    channelHost: '',
    channelDisabled: false,
    failed: false,
    statsIncluded: true,
    latencyMs: 1,
    ttftMs: 1,
    tokensPerSecond: 1,
    inputTokens: 1,
    outputTokens: 1,
    reasoningTokens: 0,
    cachedTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 2,
    totalCost: 0,
    taskKey: id,
    searchText: o.account,
  } as MonitoringEventRow;
};

describe('exact account focus: server contract (account_focus_id)', () => {
  const OPAQUE = 'fz.9Q|x:Ab/+==';
  const rows = adapt([
    stat({ id: 'row-7', account_focus_id: OPAQUE }),
    stat({ id: 'row-8', account_snapshot: 'b@example.invalid', auth_indices: ['idx-b'] }),
  ]);
  const focusRow = rows.find((row) => row.id === 'row-7')!;
  const legacyRow = rows.find((row) => row.id === 'row-8')!;

  it('uses the returned token verbatim, never the row id', () => {
    expect(OPAQUE).not.toBe(focusRow.id);
    expect(readMonitoringAccountFocusId(focusRow.filterValue)).toBe(OPAQUE);
    expect(focusRow.filterValue).not.toContain('row-7');
    // focus token 不被解释为账号/索引
    expect(parseMonitoringAccountFilterValue(focusRow.filterValue)).toEqual({
      accounts: [],
      authIndices: [],
      sourceHashes: [],
      apiKeyHashes: [],
    });
  });

  it('sends only account_focus_id once confirmed, without guessed accounts/auth_indices/providers', () => {
    const filters = buildAnalyticsFilters({ account: focusRow.filterValue }, new Map(), [], {
      acceptedFocusId: OPAQUE,
    });
    expect(filters).toEqual({ account_focus_id: OPAQUE });
  });

  it('keeps independently chosen API key / channel / provider filters alongside the token', () => {
    const filters = buildAnalyticsFilters(
      {
        account: focusRow.filterValue,
        apiKeyHash: 'ABCDEF',
        channel: 'chan-x',
        provider: 'codex',
        model: 'gpt-x',
      },
      new Map(),
      [],
      { acceptedFocusId: OPAQUE }
    );
    expect(filters.account_focus_id).toBe(OPAQUE);
    expect(filters.api_key_hashes).toEqual(['abcdef']);
    expect(filters.models).toEqual(['gpt-x']);
    expect(filters.providers).toEqual(['codex', 'chan-x']);
    expect(filters.accounts).toBeUndefined();
    expect(filters.auth_indices).toBeUndefined();
    expect(filters.credential_ids).toBeUndefined();
  });

  it('red: rows without the field (old Manager) fail closed instead of a wide legacy query', () => {
    expect(readMonitoringAccountFocusId(legacyRow.filterValue)).toBe('');
    expect(legacyRow.filterValue).toMatch(/^focus-unsupported:/);
    expect(legacyRow.legacyFilterValue).toBe('auth:idx-b');
    const filters = buildAnalyticsFilters({ account: legacyRow.filterValue }, new Map(), [], {
      acceptedFocusId: OPAQUE,
    });
    expect(filters.account_focus_id).toBeUndefined();
    expect(filters.accounts).toBeUndefined();
    expect(filters.providers).toBeUndefined();
    expect(filters.auth_indices).toEqual([ACCOUNT_FOCUS_BLOCKED_AUTH_INDEX]);
    // 旧 URL 原样兼容
    expect(
      buildAnalyticsFilters({ account: 'provider:codex|auth:idx-b' }, new Map(), []).auth_indices
    ).toEqual(['idx-b']);
  });

  it('red: a copied focus link on an old/expired server is blocked, never widened to the full set', () => {
    for (const accepted of [undefined, '', 'some-other-token']) {
      const filters = buildAnalyticsFilters(
        { account: focusRow.filterValue, apiKeyHash: 'abc' },
        new Map(),
        [],
        { acceptedFocusId: accepted }
      );
      expect(filters.account_focus_id).toBeUndefined();
      expect(filters.accounts).toBeUndefined();
      expect(filters.credential_ids).toBeUndefined();
      expect(filters.auth_indices).toEqual([ACCOUNT_FOCUS_BLOCKED_AUTH_INDEX]);
      expect(filters.api_key_hashes).toEqual(['abc']);
    }
    // 本地事件同样为空集而非全量
    const events = [
      ev({ account: 'a@example.invalid', provider: 'codex', authIndex: 'idx-shared' }),
    ];
    expect(buildScopeFilteredRows(events, { account: focusRow.filterValue })).toEqual([]);
    expect(
      buildScopeFilteredRows(events, { account: focusRow.filterValue }, { acceptedFocusId: OPAQUE })
    ).toHaveLength(1);
  });

  it('capability state: pending while loading, unavailable for old/stale/rejected, active only when issued', () => {
    const issued = collectIssuedAccountFocusIds(
      [{ account_focus_id: OPAQUE }, { account_focus_id: '  ' }, {}],
      undefined
    );
    expect(Array.from(issued)).toEqual([OPAQUE]);
    const base = { focusId: OPAQUE, issuedIds: new Set<string>(), rejected: false };
    expect(resolveMonitoringAccountFocusState({ ...base, optionsSettled: false })).toBe('pending');
    expect(resolveMonitoringAccountFocusState({ ...base, optionsSettled: true })).toBe(
      'unavailable'
    );
    expect(
      resolveMonitoringAccountFocusState({ ...base, issuedIds: issued, optionsSettled: true })
    ).toBe('active');
    expect(
      resolveMonitoringAccountFocusState({
        ...base,
        issuedIds: issued,
        optionsSettled: true,
        rejected: true,
      })
    ).toBe('unavailable');
    expect(
      resolveMonitoringAccountFocusState({ ...base, focusId: '', optionsSettled: false })
    ).toBe('none');
    const t = (key: string) => key;
    expect(resolveMonitoringAccountFocusNotice('pending', t)).toBe(
      'monitoring.account_focus_pending'
    );
    expect(resolveMonitoringAccountFocusNotice('unavailable', t)).toBe(
      'monitoring.account_focus_unavailable'
    );
    expect(resolveMonitoringAccountFocusNotice('none', t)).toBeNull();
    expect(resolveMonitoringAccountFocusNotice('active', t)).toBeNull();
  });
});

describe('exact account focus: native local events use list group membership', () => {
  const detail = (
    events: MonitoringEventRow[],
    pick: (row: ReturnType<typeof buildAccountRows>[number]) => boolean,
    extra = {}
  ) => {
    const row = buildAccountRows(events).find(pick)!;
    return {
      listed: row.totalCalls,
      ids: buildScopeFilteredRows(events, { account: row.filterValue, ...extra }).map((e) => e.id),
    };
  };

  it('red: unknown row on an index shared by two known providers yields only itself (1)', () => {
    const events = [
      ev({ account: 'same@example.invalid', provider: 'codex', authIndex: 'idx-s' }),
      ev({ account: 'same@example.invalid', provider: 'claude', authIndex: 'idx-s' }),
      ev({ account: 'same@example.invalid', provider: 'unknown', authIndex: 'idx-s' }),
    ];
    const unknown = detail(events, (row) => row.provider === 'unknown');
    expect(unknown).toEqual({ listed: 1, ids: [events[2].id] });
    const codex = detail(events, (row) => row.provider === 'codex');
    expect(codex).toEqual({ listed: 1, ids: [events[0].id] });
  });

  it('red: account A on an exclusive and a shared index lists 3 and detail is 3/3', () => {
    // idx-own 上一条缺账号/provider 快照的历史事件：按唯一完整凭据快照归入 A（非掩码推断）
    const events = [
      ev({ account: 'A@example.invalid', provider: 'codex', authIndex: 'idx-own' }),
      ev({ account: '', provider: '', authIndex: 'idx-own' }),
      ev({ account: 'A@example.invalid', provider: 'codex', authIndex: 'idx-shared' }),
      ev({ account: 'B@example.invalid', provider: 'codex', authIndex: 'idx-shared' }),
    ];
    const a = detail(events, (row) => row.account === 'A@example.invalid');
    expect(a.listed).toBe(3);
    expect(a.ids).toEqual(events.slice(0, 3).map((e) => e.id));
    const b = detail(events, (row) => row.account === 'B@example.invalid');
    expect(b).toEqual({ listed: 1, ids: [events[3].id] });
  });

  it('independently chosen channel / API key intersect with the group without widening it', () => {
    const events = [
      ev({
        account: 'A@example.invalid',
        provider: 'codex',
        authIndex: 'idx-own',
        channel: 'c1',
        apiKeyHash: 'k1',
      }),
      ev({
        account: 'A@example.invalid',
        provider: 'codex',
        authIndex: 'idx-shared',
        channel: 'c2',
        apiKeyHash: 'k1',
      }),
      ev({
        account: 'A@example.invalid',
        provider: 'codex',
        authIndex: 'idx-shared',
        channel: 'c1',
        apiKeyHash: 'k2',
      }),
      ev({
        account: 'B@example.invalid',
        provider: 'codex',
        authIndex: 'idx-shared',
        channel: 'c1',
        apiKeyHash: 'k1',
      }),
    ];
    const pick = (row: { account: string }) => row.account === 'A@example.invalid';
    expect(detail(events, pick, { channel: 'c1' }).ids).toEqual([events[0].id, events[2].id]);
    expect(detail(events, pick, { apiKeyHash: 'k1' }).ids).toEqual([events[0].id, events[1].id]);
    expect(detail(events, pick, { channel: 'c1', apiKeyHash: 'k1' }).ids).toEqual([events[0].id]);
  });
});
