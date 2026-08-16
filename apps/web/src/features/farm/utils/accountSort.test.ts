import { describe, expect, it } from 'vitest';

import {
  AUTH_STATE_SEVERITY,
  DEVICE_ID_SOURCE_SEVERITY,
  compareFarmAccountRows,
  sortFarmAccountRows,
  type FarmAccountSortRow,
  type FarmAccountSortState,
} from './accountSort';
import { FARM_ACCOUNT_AUTH_STATES } from './health';

// 基线行工厂：各用例按需覆写。
function row(overrides: Partial<FarmAccountSortRow> = {}): FarmAccountSortRow {
  return {
    name: 'acct',
    authState: 'healthy',
    farmBound: true,
    deviceIdSource: 'container_synced',
    usage: 0,
    lastRefresh: undefined,
    ...overrides,
  };
}

const namesOf = (rows: FarmAccountSortRow[]) => rows.map((r) => r.name);

describe('AUTH_STATE_SEVERITY', () => {
  it('覆盖全部 6 态且 healthy 最低、auto_quarantined 最高', () => {
    for (const state of FARM_ACCOUNT_AUTH_STATES) {
      expect(typeof AUTH_STATE_SEVERITY[state]).toBe('number');
    }
    expect(AUTH_STATE_SEVERITY.healthy).toBeLessThan(AUTH_STATE_SEVERITY.unprovisioned);
    expect(AUTH_STATE_SEVERITY.unprovisioned).toBeLessThanOrEqual(
      AUTH_STATE_SEVERITY.auto_quarantined
    );
    // healthy 是唯一「正常」，严重度最低。
    const min = Math.min(...FARM_ACCOUNT_AUTH_STATES.map((s) => AUTH_STATE_SEVERITY[s]));
    expect(AUTH_STATE_SEVERITY.healthy).toBe(min);
  });
});

describe('sortFarmAccountRows - authState 严重度', () => {
  const rows: FarmAccountSortRow[] = [
    row({ name: 'a-healthy', authState: 'healthy' }),
    row({ name: 'b-quarantined', authState: 'auto_quarantined', farmBound: false }),
    row({ name: 'c-unprovisioned', authState: 'unprovisioned', farmBound: false }),
    row({ name: 'd-unknown', authState: 'unknown' }),
  ];

  it('desc：最严重排最前', () => {
    const sorted = sortFarmAccountRows(rows, { key: 'authState', direction: 'desc' });
    expect(sorted[0].authState).toBe('auto_quarantined');
    expect(sorted[sorted.length - 1].authState).toBe('healthy');
  });

  it('asc：最正常排最前', () => {
    const sorted = sortFarmAccountRows(rows, { key: 'authState', direction: 'asc' });
    expect(sorted[0].authState).toBe('healthy');
    expect(sorted[sorted.length - 1].authState).toBe('auto_quarantined');
  });

  it('不原地修改入参', () => {
    const before = namesOf(rows);
    sortFarmAccountRows(rows, { key: 'authState', direction: 'desc' });
    expect(namesOf(rows)).toEqual(before);
  });
});

describe('sortFarmAccountRows - name', () => {
  it('asc / desc 本地化字符串序', () => {
    const rows = [row({ name: 'Charlie' }), row({ name: 'alpha' }), row({ name: 'Bravo' })];
    expect(namesOf(sortFarmAccountRows(rows, { key: 'name', direction: 'asc' }))).toEqual([
      'alpha',
      'Bravo',
      'Charlie',
    ]);
    expect(namesOf(sortFarmAccountRows(rows, { key: 'name', direction: 'desc' }))).toEqual([
      'Charlie',
      'Bravo',
      'alpha',
    ]);
  });
});

describe('sortFarmAccountRows - bind（绑定态）', () => {
  it('desc：已绑定排前', () => {
    const rows = [
      row({ name: 'unbound', farmBound: false }),
      row({ name: 'bound', farmBound: true }),
    ];
    expect(namesOf(sortFarmAccountRows(rows, { key: 'bind', direction: 'desc' }))).toEqual([
      'bound',
      'unbound',
    ]);
  });
});

describe('sortFarmAccountRows - usage（用量）', () => {
  it('desc：用量高排前', () => {
    const rows = [
      row({ name: 'low', usage: 3 }),
      row({ name: 'high', usage: 99 }),
      row({ name: 'mid', usage: 50 }),
    ];
    expect(namesOf(sortFarmAccountRows(rows, { key: 'usage', direction: 'desc' }))).toEqual([
      'high',
      'mid',
      'low',
    ]);
  });
});

describe('sortFarmAccountRows - deviceIdSource', () => {
  it('严重度序：drift 最偏离排最后（asc）', () => {
    const rows = [
      row({ name: 'drift', deviceIdSource: 'drift' }),
      row({ name: 'synced', deviceIdSource: 'container_synced' }),
      row({ name: 'synthetic', deviceIdSource: 'synthetic' }),
    ];
    const sorted = sortFarmAccountRows(rows, { key: 'deviceIdSource', direction: 'asc' });
    expect(sorted[0].deviceIdSource).toBe('container_synced');
    expect(sorted[sorted.length - 1].deviceIdSource).toBe('drift');
    expect(DEVICE_ID_SOURCE_SEVERITY.container_synced).toBeLessThan(DEVICE_ID_SOURCE_SEVERITY.drift);
  });

  it('deviceIdSource 缺省排最前（asc，视作最低严重度 -1）', () => {
    const rows = [
      row({ name: 'has', deviceIdSource: 'synthetic' }),
      row({ name: 'missing', deviceIdSource: undefined }),
    ];
    expect(namesOf(sortFarmAccountRows(rows, { key: 'deviceIdSource', direction: 'asc' }))).toEqual([
      'missing',
      'has',
    ]);
  });
});

describe('sortFarmAccountRows - lastRefresh', () => {
  it('desc：最近的排前，缺失恒排最后（方向无关）', () => {
    const rows = [
      row({ name: 'old', lastRefresh: '2026-01-01T00:00:00Z' }),
      row({ name: 'new', lastRefresh: '2026-08-01T00:00:00Z' }),
      row({ name: 'never', lastRefresh: undefined }),
    ];
    const desc = namesOf(sortFarmAccountRows(rows, { key: 'lastRefresh', direction: 'desc' }));
    expect(desc[0]).toBe('new');
    expect(desc[desc.length - 1]).toBe('never');
    const asc = namesOf(sortFarmAccountRows(rows, { key: 'lastRefresh', direction: 'asc' }));
    // 缺失恒排最后，即使升序也不跑到最前。
    expect(asc[asc.length - 1]).toBe('never');
    expect(asc[0]).toBe('old');
  });
});

describe('稳定 tiebreak', () => {
  it('同主键时按名称升序稳定排列（desc 主键不翻转 tiebreak）', () => {
    const sort: FarmAccountSortState = { key: 'authState', direction: 'desc' };
    const rows = [
      row({ name: 'zeta', authState: 'healthy' }),
      row({ name: 'alpha', authState: 'healthy' }),
      row({ name: 'mike', authState: 'healthy' }),
    ];
    expect(namesOf(sortFarmAccountRows(rows, sort))).toEqual(['alpha', 'mike', 'zeta']);
  });

  it('compareFarmAccountRows：完全同键返回名称序', () => {
    const a = row({ name: 'a', authState: 'healthy' });
    const b = row({ name: 'b', authState: 'healthy' });
    expect(compareFarmAccountRows(a, b, { key: 'authState', direction: 'desc' })).toBeLessThan(0);
    expect(compareFarmAccountRows(a, b, { key: 'authState', direction: 'asc' })).toBeLessThan(0);
  });
});
