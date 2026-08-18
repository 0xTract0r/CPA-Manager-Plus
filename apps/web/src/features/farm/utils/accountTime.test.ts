import { describe, expect, it } from 'vitest';
import { deriveFarmAccountTimeLabels } from './accountTime';

/**
 * #50 回归：core / 编排器把「从未设置」的账号时间字段透传为 Go 零值
 * `0001-01-01T00:00:00Z`。这个值非空且可被 Date.parse 解析，普通空值判断拦不住，
 * 直接渲染会得到「0001年1月1日」+ 荒谬存活时长（本仓库出过生产事故、usage 冒烟
 * 门禁拒收此值）。deriveFarmAccountTimeLabels 必须把这类零时间一律归 null，
 * 让调用方渲染成 '—'。
 */
describe('deriveFarmAccountTimeLabels', () => {
  const NOW = Date.parse('2026-08-18T00:00:00Z');

  it('归零 Go 零时间输入 → 创建/首登为 null、存活无法计算（渲染成 —）', () => {
    const result = deriveFarmAccountTimeLabels({
      createdAt: '0001-01-01T00:00:00Z',
      firstIdentityAt: '0001-01-01T00:00:00Z',
      failureAt: '0001-01-01T00:00:00Z',
      impaired: false,
      nowMs: NOW,
    });

    expect(result.createdAtDate).toBeNull();
    expect(result.firstIdentityDate).toBeNull();
    // 存活起算点是零时间 → 不能算出「几千年」的荒谬时长，必须为 null。
    expect(result.aliveMs).toBeNull();
    expect(result.aliveEstimated).toBe(false);
  });

  it('归零 空/缺失输入 → 全部为 null，不抛错', () => {
    const result = deriveFarmAccountTimeLabels({
      createdAt: undefined,
      firstIdentityAt: null,
      impaired: false,
      nowMs: NOW,
    });

    expect(result.createdAtDate).toBeNull();
    expect(result.firstIdentityDate).toBeNull();
    expect(result.aliveMs).toBeNull();
  });

  it('健康号：正常时间戳 → 存活按 now 起算，无估算标注', () => {
    const created = Date.parse('2026-08-11T00:00:00Z'); // NOW - 7 天
    const result = deriveFarmAccountTimeLabels({
      createdAt: '2026-08-11T00:00:00Z',
      firstIdentityAt: '2026-08-11T00:00:00Z',
      impaired: false,
      nowMs: NOW,
    });

    expect(result.createdAtDate?.getTime()).toBe(created);
    expect(result.firstIdentityDate?.getTime()).toBe(created);
    expect(result.aliveMs).toBe(NOW - created);
    expect(result.aliveEstimated).toBe(false);
  });

  it('auto_quarantined：存活截止到精确失效时刻，不标注估算', () => {
    const created = Date.parse('2026-08-11T00:00:00Z');
    const failure = Date.parse('2026-08-15T00:00:00Z');
    const result = deriveFarmAccountTimeLabels({
      createdAt: '2026-08-11T00:00:00Z',
      failureAt: '2026-08-15T00:00:00Z',
      impaired: true,
      nowMs: NOW,
    });

    expect(result.aliveMs).toBe(failure - created);
    expect(result.aliveEstimated).toBe(false);
  });

  it('needs_reauth：失效号但无精确失效时刻 → 按 now 估算并标注', () => {
    const created = Date.parse('2026-08-11T00:00:00Z');
    const result = deriveFarmAccountTimeLabels({
      createdAt: '2026-08-11T00:00:00Z',
      failureAt: undefined,
      impaired: true,
      nowMs: NOW,
    });

    expect(result.aliveMs).toBe(NOW - created);
    expect(result.aliveEstimated).toBe(true);
  });

  it('时序倒挂（失效时刻早于创建）→ 存活为 null，不产出负时长', () => {
    const result = deriveFarmAccountTimeLabels({
      createdAt: '2026-08-15T00:00:00Z',
      failureAt: '2026-08-11T00:00:00Z',
      impaired: true,
      nowMs: NOW,
    });

    expect(result.aliveMs).toBeNull();
  });
});
