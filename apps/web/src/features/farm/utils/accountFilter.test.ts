import { describe, expect, it } from 'vitest';

import {
  isNormalFarmAccountRow,
  matchesFarmAccountFilter,
  type FarmAccountFilterRow,
} from './accountFilter';

// 测试用例基线行；各用例按需覆写字段。
const baseRow: FarmAccountFilterRow = {
  note: 'AC04',
  account: 'acct1@example.com',
  name: 'claude-acct1@example.com.json',
  authState: 'healthy',
  farmBound: true,
};

describe('matchesFarmAccountFilter', () => {
  // --- 认证态维度 ---
  it("authState='all' + 空关键词 → 恒命中", () => {
    expect(matchesFarmAccountFilter(baseRow, { authState: 'all', query: '' })).toBe(true);
  });

  it('认证态精确匹配命中', () => {
    expect(
      matchesFarmAccountFilter(baseRow, { authState: 'healthy', query: '' })
    ).toBe(true);
  });

  it('认证态不匹配被过滤', () => {
    expect(
      matchesFarmAccountFilter(baseRow, { authState: 'needs_reauth', query: '' })
    ).toBe(false);
  });

  it('隔离态行只在选中 auto_quarantined 时命中', () => {
    const row: FarmAccountFilterRow = { ...baseRow, authState: 'auto_quarantined' };
    expect(matchesFarmAccountFilter(row, { authState: 'auto_quarantined', query: '' })).toBe(true);
    expect(matchesFarmAccountFilter(row, { authState: 'healthy', query: '' })).toBe(false);
    expect(matchesFarmAccountFilter(row, { authState: 'all', query: '' })).toBe(true);
  });

  // --- 关键词维度 ---
  it('关键词命中 note（大小写不敏感）', () => {
    expect(matchesFarmAccountFilter(baseRow, { authState: 'all', query: 'ac04' })).toBe(true);
    expect(matchesFarmAccountFilter(baseRow, { authState: 'all', query: 'AC' })).toBe(true);
  });

  it('关键词命中 account 邮箱子串', () => {
    expect(
      matchesFarmAccountFilter(baseRow, { authState: 'all', query: 'acct1@' })
    ).toBe(true);
  });

  it('关键词命中 name 文件名子串', () => {
    expect(matchesFarmAccountFilter(baseRow, { authState: 'all', query: '.json' })).toBe(true);
  });

  it('关键词无匹配 → 过滤', () => {
    expect(
      matchesFarmAccountFilter(baseRow, { authState: 'all', query: 'zzz-not-present' })
    ).toBe(false);
  });

  it('纯空白关键词等同空串（不收窄）', () => {
    expect(matchesFarmAccountFilter(baseRow, { authState: 'all', query: '   ' })).toBe(true);
  });

  it('关键词去首尾空白后再匹配', () => {
    expect(matchesFarmAccountFilter(baseRow, { authState: 'all', query: '  AC04  ' })).toBe(true);
  });

  // --- note/account 缺失时的兜底 ---
  it('note/account 缺失时仍能按 name 命中', () => {
    const row: FarmAccountFilterRow = {
      name: 'claude-lonely.json',
      authState: 'unknown',
    };
    expect(matchesFarmAccountFilter(row, { authState: 'all', query: 'lonely' })).toBe(true);
    expect(matchesFarmAccountFilter(row, { authState: 'all', query: 'AC04' })).toBe(false);
  });

  // --- 组合（与关系）关键回归护栏 ---
  it('认证态命中但关键词不命中 → 过滤（两维是「与」）', () => {
    expect(
      matchesFarmAccountFilter(baseRow, { authState: 'healthy', query: 'zzz' })
    ).toBe(false);
  });

  it('关键词命中但认证态不命中 → 过滤（两维是「与」）', () => {
    expect(
      matchesFarmAccountFilter(baseRow, { authState: 'needs_reauth', query: 'AC04' })
    ).toBe(false);
  });

  it('两维同时命中 → 命中', () => {
    expect(
      matchesFarmAccountFilter(baseRow, { authState: 'healthy', query: 'AC04' })
    ).toBe(true);
  });

  // --- 'normal' 复合筛选（= 绑定 + 健康）关键回归护栏（用户点4）---
  it("'normal'：绑定 + healthy → 命中", () => {
    expect(matchesFarmAccountFilter(baseRow, { authState: 'normal', query: '' })).toBe(true);
  });

  it("'normal'：unprovisioned（未绑定）→ 过滤", () => {
    const row: FarmAccountFilterRow = { ...baseRow, authState: 'unprovisioned', farmBound: false };
    expect(matchesFarmAccountFilter(row, { authState: 'normal', query: '' })).toBe(false);
  });

  it("'normal'：逐一排除 needs_reauth/auto_quarantined/operator_disabled/unknown", () => {
    for (const state of [
      'needs_reauth',
      'auto_quarantined',
      'operator_disabled',
      'unknown',
    ] as const) {
      const row: FarmAccountFilterRow = { ...baseRow, authState: state };
      expect(matchesFarmAccountFilter(row, { authState: 'normal', query: '' })).toBe(false);
    }
  });

  it("'normal'：healthy 但 farmBound=false → 过滤（防御后端口径不一致）", () => {
    const row: FarmAccountFilterRow = { ...baseRow, authState: 'healthy', farmBound: false };
    expect(matchesFarmAccountFilter(row, { authState: 'normal', query: '' })).toBe(false);
  });

  it("'normal' + 关键词：两维「与」——正常但关键词不命中 → 过滤", () => {
    expect(matchesFarmAccountFilter(baseRow, { authState: 'normal', query: 'zzz' })).toBe(false);
    expect(matchesFarmAccountFilter(baseRow, { authState: 'normal', query: 'AC04' })).toBe(true);
  });

  it('isNormalFarmAccountRow：healthy 且未显式 unbound 视为正常（healthy 已隐含绑定）', () => {
    expect(isNormalFarmAccountRow({ authState: 'healthy' })).toBe(true);
    expect(isNormalFarmAccountRow({ authState: 'healthy', farmBound: true })).toBe(true);
    expect(isNormalFarmAccountRow({ authState: 'healthy', farmBound: false })).toBe(false);
    expect(isNormalFarmAccountRow({ authState: 'unprovisioned', farmBound: false })).toBe(false);
    expect(isNormalFarmAccountRow({ authState: 'unknown' })).toBe(false);
  });
});
