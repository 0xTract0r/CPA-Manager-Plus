import { describe, expect, it } from 'vitest';
import {
  OVERVIEW_MIN_REFRESH_INTERVAL_MS,
  advanceOverviewClock,
  createOverviewClock,
  shouldAdvanceOverviewClock,
} from './overviewRefreshGate';

describe('shouldAdvanceOverviewClock', () => {
  it('blocks same-window background ticks that arrive sooner than the minimum interval', () => {
    const base = 1_768_759_000_000;
    // 同窗后台连续 tick，间隔 <30s（5s 档：0/5/10/15/20/25s）都不应放行概览时钟前移。
    for (const elapsed of [0, 5_000, 10_000, 15_000, 20_000, 25_000, 29_999]) {
      expect(
        shouldAdvanceOverviewClock({ nowMs: base + elapsed, lastAdvanceAtMs: base })
      ).toBe(false);
    }
  });

  it('opens the gate once at least the minimum interval has elapsed', () => {
    const base = 1_768_759_000_000;
    expect(
      shouldAdvanceOverviewClock({
        nowMs: base + OVERVIEW_MIN_REFRESH_INTERVAL_MS,
        lastAdvanceAtMs: base,
      })
    ).toBe(true);
    expect(
      shouldAdvanceOverviewClock({ nowMs: base + 45_000, lastAdvanceAtMs: base })
    ).toBe(true);
  });

  it('always advances when forced, regardless of elapsed time (manual / forced refresh)', () => {
    const base = 1_768_759_000_000;
    expect(
      shouldAdvanceOverviewClock({ nowMs: base + 1_000, lastAdvanceAtMs: base, force: true })
    ).toBe(true);
    expect(shouldAdvanceOverviewClock({ nowMs: base, lastAdvanceAtMs: base, force: true })).toBe(
      true
    );
  });

  it('honors a custom minimum interval', () => {
    const base = 1_768_759_000_000;
    expect(
      shouldAdvanceOverviewClock({ nowMs: base + 6_000, lastAdvanceAtMs: base, minIntervalMs: 5_000 })
    ).toBe(true);
    expect(
      shouldAdvanceOverviewClock({ nowMs: base + 4_000, lastAdvanceAtMs: base, minIntervalMs: 5_000 })
    ).toBe(false);
  });
});

describe('advanceOverviewClock', () => {
  it('keeps the exact previous reference when the gate is closed (no request-param churn → no refetch)', () => {
    const base = 1_768_759_000_000;
    const previous = createOverviewClock(base);
    // 5s 与 25s 后的同窗后台 tick 都被门挡住：返回原引用，概览请求参数不变，不触发重拉。
    expect(advanceOverviewClock(previous, { nowMs: base + 5_000 })).toBe(previous);
    expect(advanceOverviewClock(previous, { nowMs: base + 25_000 })).toBe(previous);
  });

  it('advances to the new instant once the interval elapses, resetting the gate baseline', () => {
    const base = 1_768_759_000_000;
    const previous = createOverviewClock(base);
    const next = advanceOverviewClock(previous, { nowMs: base + 30_000 });
    expect(next).not.toBe(previous);
    expect(next).toEqual({ nowMs: base + 30_000, lastAdvanceAtMs: base + 30_000 });
  });

  it('advances immediately when forced even within the interval (manual / forced refresh)', () => {
    const base = 1_768_759_000_000;
    const previous = createOverviewClock(base);
    const next = advanceOverviewClock(previous, { nowMs: base + 2_000, force: true });
    expect(next).toEqual({ nowMs: base + 2_000, lastAdvanceAtMs: base + 2_000 });
  });

  it('spaces consecutive forced/gated advances by at least the interval after an advance', () => {
    const base = 1_768_759_000_000;
    let clock = createOverviewClock(base);
    // 手动刷新（force）在 t+2s 前移。
    clock = advanceOverviewClock(clock, { nowMs: base + 2_000, force: true });
    // 其后的同窗后台 tick 仍以最近一次前移为基准计时：t+10s（距 t+2s 仅 8s）被挡。
    expect(advanceOverviewClock(clock, { nowMs: base + 10_000 })).toBe(clock);
    // t+33s（距 t+2s 已 31s ≥ 30s）放行。
    expect(advanceOverviewClock(clock, { nowMs: base + 33_000 })).not.toBe(clock);
  });
});
