import { describe, expect, it } from 'vitest';

import {
  FARM_PROBE_CADENCE_SCOPE,
  FARM_USAGE_SCOPE,
  deriveUsageAccountIdentity,
  summarizeFarmUsage,
} from './usagePanel';
import type { FarmUsageItem } from '@/types/farm';

// 构造一条最小合法用量明细；各用例只覆盖自己关心的字段。
function makeItem(overrides: Partial<FarmUsageItem> = {}): FarmUsageItem {
  return {
    container_id: 'c1',
    account_id: 'claude-a@example.com.json',
    account_email: 'a@example.com',
    env: 'test',
    auth_index: 0,
    tokens: { input: 0, output: 0, cache_read: 0, reasoning: 0, total: 0, billable: 0 },
    cost_usd: 0,
    requests: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// scope 常量必须与后端 dto.go usageScope/probeCadenceScope 逐字一致——两个
// 时钟的口径区分靠这两个字符串，写错会让「口径徽标」误标。
// ---------------------------------------------------------------------------
describe('farm usage scope 常量', () => {
  it('账号累计口径 = cpa_account_cumulative', () => {
    expect(FARM_USAGE_SCOPE).toBe('cpa_account_cumulative');
  });
  it('探针节奏口径 = farm_probe_cadence', () => {
    expect(FARM_PROBE_CADENCE_SCOPE).toBe('farm_probe_cadence');
  });
  it('两个口径互不相同（不可相加/替代的前提）', () => {
    expect(FARM_USAGE_SCOPE).not.toBe(FARM_PROBE_CADENCE_SCOPE);
  });
});

// ---------------------------------------------------------------------------
// summarizeFarmUsage：账号 API 累计用量时钟读数的真实求和 + 去重。
// ---------------------------------------------------------------------------
describe('summarizeFarmUsage', () => {
  it('空数组 → isEmpty 且所有计数为 0（C7 ① 结构性缺席触发条件）', () => {
    const s = summarizeFarmUsage([]);
    expect(s).toEqual({
      accountCount: 0,
      containerCount: 0,
      totalRequests: 0,
      totalTokens: 0,
      totalCostUsd: 0,
      isEmpty: true,
    });
  });

  it('多行求和请求/Token/费用，account 与 container 分别去重', () => {
    const items = [
      makeItem({
        container_id: 'c1',
        account_id: 'acct-A',
        requests: 100,
        cost_usd: 1.5,
        tokens: { input: 0, output: 0, cache_read: 0, reasoning: 0, total: 1000, billable: 0 },
      }),
      // 同账号不同容器：account 去重后仍 1，container 增到 2。
      makeItem({
        container_id: 'c2',
        account_id: 'acct-A',
        requests: 50,
        cost_usd: 0.25,
        tokens: { input: 0, output: 0, cache_read: 0, reasoning: 0, total: 500, billable: 0 },
      }),
      makeItem({
        container_id: 'c3',
        account_id: 'acct-B',
        requests: 7,
        cost_usd: 0.1,
        tokens: { input: 0, output: 0, cache_read: 0, reasoning: 0, total: 3, billable: 0 },
      }),
    ];
    const s = summarizeFarmUsage(items);
    expect(s.accountCount).toBe(2);
    expect(s.containerCount).toBe(3);
    expect(s.totalRequests).toBe(157);
    expect(s.totalTokens).toBe(1503);
    expect(s.totalCostUsd).toBeCloseTo(1.85, 10);
    expect(s.isEmpty).toBe(false);
  });

  it('account_id 缺失时账号去重回退到 account_email', () => {
    const items = [
      makeItem({ account_id: '', account_email: 'x@example.com' }),
      makeItem({ account_id: '   ', account_email: 'x@example.com' }),
    ];
    // 两行同一邮箱 → 去重为 1 个账号。
    expect(summarizeFarmUsage(items).accountCount).toBe(1);
  });

  it('非有限数值（NaN/undefined）按 0 跳过，不污染求和', () => {
    const items = [
      makeItem({ requests: Number.NaN, cost_usd: 2 }),
      // requests 缺省（Partial 允许 undefined）→ 覆盖默认 0，测防御性按 0 计。
      makeItem({ requests: undefined, cost_usd: 3 }),
    ];
    const s = summarizeFarmUsage(items);
    expect(s.totalRequests).toBe(0);
    expect(s.totalCostUsd).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// deriveUsageAccountIdentity：备注优先 + 邮箱去重回退（C6 备注展示）。
// ---------------------------------------------------------------------------
describe('deriveUsageAccountIdentity', () => {
  it('有备注 → note 优先，hasNote=true，account_id/email 保留', () => {
    const id = deriveUsageAccountIdentity({
      account_id: 'claude-a@example.com.json',
      account_email: 'a@example.com',
      account_note: '农场容器 c1 专用',
    });
    expect(id).toEqual({
      note: '农场容器 c1 专用',
      accountId: 'claude-a@example.com.json',
      email: 'a@example.com',
      hasNote: true,
    });
  });

  it('无备注 → note 缺失，hasNote=false（回退旧口径 account_id + email）', () => {
    const id = deriveUsageAccountIdentity({
      account_id: 'acct-A',
      account_email: 'a@example.com',
      account_note: undefined,
    });
    expect(id.note).toBeUndefined();
    expect(id.hasNote).toBe(false);
    expect(id.accountId).toBe('acct-A');
    expect(id.email).toBe('a@example.com');
  });

  it('空白备注按无备注处理，不渲染空 chip', () => {
    const id = deriveUsageAccountIdentity({
      account_id: 'acct-A',
      account_email: 'a@example.com',
      account_note: '   ',
    });
    expect(id.hasNote).toBe(false);
    expect(id.note).toBeUndefined();
  });

  it('email 与 account_id 相同（邮箱兜底路径）时去重，email 不重复渲染', () => {
    const id = deriveUsageAccountIdentity({
      account_id: 'a@example.com',
      account_email: 'a@example.com',
      account_note: undefined,
    });
    expect(id.accountId).toBe('a@example.com');
    expect(id.email).toBeUndefined();
  });

  it('email 为空串时归一为缺失', () => {
    const id = deriveUsageAccountIdentity({
      account_id: 'acct-A',
      account_email: '',
      account_note: 'AC04',
    });
    expect(id.email).toBeUndefined();
    expect(id.note).toBe('AC04');
  });
});
