import { describe, expect, it } from 'vitest';
import type { MonitoringAnalyticsEventRow } from '@/services/api/usageService';
import {
  buildMonitoringAccountFilterValue,
  buildUsageDetailsFromAnalyticsEvents,
} from './analyticsAdapters';
import { buildEventRows } from './eventRows';
import { buildRangeFilteredRows, buildScopeFilteredRows } from './rowBuilders';

const meta = {
  authIndex: 'member',
  provider: 'current',
  account: 'fixture@example.invalid',
  label: 'Fixture',
  status: 'active',
  disabled: false,
  unavailable: false,
  runtimeOnly: false,
  planType: '',
  updatedAt: '',
};
const modelRows = (configured: boolean, marked?: boolean, provider: string | null = 'legacy') => {
  const timestamp = Date.now() - 10_000;
  const items = [1, 2].map(
    (n) =>
      ({
        event_hash: `page-event-${n}`,
        timestamp_ms: timestamp,
        auth_index: 'member',
        auth_provider_snapshot: provider,
        source: n === 1 ? '' : null,
        model: `fixture-${n}`,
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
        failed: false,
        attribution_filtered: marked,
      }) as MonitoringAnalyticsEventRow
  );
  const owners = new Map();
  if (configured) owners.set('member', { name: 'configured-channel' });
  return buildEventRows(
    buildUsageDetailsFromAnalyticsEvents(items),
    new Map([['member', meta]]),
    new Map(),
    { byAuthIndex: new Map(), bySource: new Map(), byIdentityKey: new Map() },
    owners,
    {},
    new Map()
  );
};

describe('server-confirmed attribution for monitoring cursor pages', () => {
  it.each([
    [false, 'legacy', 'current'],
    [false, 'legacy', 'legacy'],
    [true, 'legacy', 'configured-channel'],
    [true, null, 'configured-channel'],
  ] as const)('keeps both confirmed pages, configured=%s snapshot=%s channel=%s', (configured, snapshot, channel) => {
    const rows = modelRows(configured, true, snapshot);
    const scope = {
      provider: 'legacy',
      channel,
      account: buildMonitoringAccountFilterValue({ authIndices: ['member'] }),
    };
    expect(rows[0].provider).toBe('current');
    expect(buildScopeFilteredRows(rows.slice(0, 1), scope, { useServerAttribution: true })).toHaveLength(1);
    expect(buildScopeFilteredRows(rows, scope, { useServerAttribution: true })).toHaveLength(2);
    const other = { ...scope, account: buildMonitoringAccountFilterValue({ authIndices: ['another'] }) };
    expect(buildScopeFilteredRows(rows, other, { useServerAttribution: true })).toHaveLength(0);
    expect(buildRangeFilteredRows(rows, 'all', null, 'fixture-2')).toHaveLength(1);
  });

  it('uses local/display filters for data without confirmation and stale marked data', () => {
    const scope = { provider: 'legacy', channel: 'current' };
    expect(buildScopeFilteredRows(modelRows(false), scope, { useServerAttribution: true })).toHaveLength(0);
    expect(buildScopeFilteredRows(modelRows(false, true), scope)).toHaveLength(0);
    expect(buildScopeFilteredRows(modelRows(false, false), { ...scope, provider: 'current' })).toHaveLength(2);
    const mixed = [modelRows(false, true)[0], modelRows(false)[1]];
    expect(buildScopeFilteredRows(mixed, scope, { useServerAttribution: true })).toEqual([mixed[0]]);
  });
});
