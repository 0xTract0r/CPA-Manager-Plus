import { describe, expect, it } from 'vitest';
import { computeQuotaRunway } from './accountQuotaRunway';
import type { SpeedSeriesPoint } from './accountSpeedSeries';

const point = (overrides: Partial<SpeedSeriesPoint>): SpeedSeriesPoint => ({
  ts: overrides.ts ?? 0,
  ttftMs: overrides.ttftMs ?? null,
  latencyMs: overrides.latencyMs ?? null,
  tier: overrides.tier ?? 'default',
  isPriority: overrides.isPriority ?? false,
  usedPercent: overrides.usedPercent ?? null,
  recoverAtMs: overrides.recoverAtMs ?? null,
  failed: overrides.failed ?? false,
});

const HOUR = 3_600_000;

describe('computeQuotaRunway', () => {
  it('degrades to insufficient (no NaN) with fewer than 2 used% samples', () => {
    const result = computeQuotaRunway([
      point({ ts: 0, usedPercent: 40, recoverAtMs: 10 * HOUR }),
      point({ ts: HOUR, usedPercent: null }), // no used% → not a sample
    ]);
    expect(result.status).toBe('insufficient');
    expect(result.sampleCount).toBe(1);
    expect(result.runwayMs).toBeNull();
    expect(result.exhaustAtMs).toBeNull();
    // 仍回当前 used% + 重置时刻供降级展示
    expect(result.latestUsedPercent).toBe(40);
    expect(result.recoverAtMs).toBe(10 * HOUR);
  });

  it('degrades to flat when used% has no upward trend', () => {
    const result = computeQuotaRunway([
      point({ ts: 0, usedPercent: 50 }),
      point({ ts: HOUR, usedPercent: 50 }),
      point({ ts: 2 * HOUR, usedPercent: 49 }), // 下降/平坦
    ]);
    expect(result.status).toBe('flat');
    expect(result.runwayMs).toBeNull();
    expect(result.latestUsedPercent).toBe(49);
  });

  it('degrades to flat when all samples share one timestamp (no rate estimable)', () => {
    const result = computeQuotaRunway([
      point({ ts: 5 * HOUR, usedPercent: 20 }),
      point({ ts: 5 * HOUR, usedPercent: 60 }),
    ]);
    expect(result.status).toBe('flat');
    expect(result.runwayMs).toBeNull();
  });

  it('extrapolates a runway from an upward used% trend', () => {
    // 每小时 +10%，从 40% 起：到 100% 还剩 60% → 6 小时
    const result = computeQuotaRunway([
      point({ ts: 0, usedPercent: 20 }),
      point({ ts: HOUR, usedPercent: 30 }),
      point({ ts: 2 * HOUR, usedPercent: 40 }),
    ]);
    expect(result.status).toBe('ok');
    expect(result.slopePctPerMs).toBeGreaterThan(0);
    expect(result.runwayMs).toBeCloseTo(6 * HOUR, -3);
    expect(result.exhaustAtMs).toBeCloseTo(2 * HOUR + 6 * HOUR, -3);
    expect(result.resetsBeforeExhaustion).toBeNull(); // 无 recoverAtMs
  });

  it('flags resetsBeforeExhaustion=true when the weekly reset precedes projected exhaustion', () => {
    // 上升趋势耗尽约在 8h 后，但周窗 3h 后就重置 → 当前速率安全
    const result = computeQuotaRunway([
      point({ ts: 0, usedPercent: 20, recoverAtMs: 3 * HOUR }),
      point({ ts: HOUR, usedPercent: 30, recoverAtMs: 3 * HOUR }),
      point({ ts: 2 * HOUR, usedPercent: 40, recoverAtMs: 3 * HOUR }),
    ]);
    expect(result.status).toBe('ok');
    expect(result.recoverAtMs).toBe(3 * HOUR);
    expect(result.exhaustAtMs).toBeGreaterThan(3 * HOUR);
    expect(result.resetsBeforeExhaustion).toBe(true);
  });

  it('flags resetsBeforeExhaustion=false when exhaustion precedes the reset', () => {
    // 陡峭上升：约 1h 内耗尽，但重置要 50h 后 → 不安全
    const result = computeQuotaRunway([
      point({ ts: 0, usedPercent: 10, recoverAtMs: 50 * HOUR }),
      point({ ts: HOUR, usedPercent: 60, recoverAtMs: 50 * HOUR }),
    ]);
    expect(result.status).toBe('ok');
    expect(result.resetsBeforeExhaustion).toBe(false);
  });
});
