import { describe, expect, it } from 'vitest';
import {
  parseWarmupCurve,
  deriveWarmupProgress,
  quotaWindowSummaries,
  nonnegative,
} from './warmupPolicySummary';
const config = (end: number) => ({
  'warmup-curve': [
    { name: 'early', 'min-age-days': 0, 'max-age-days': 7, 'daily-budget': 200 },
    { name: 'late', 'min-age-days': 7, 'max-age-days': end, 'daily-budget': 500 },
  ],
});
describe('warmup policy facts', () => {
  it('uses a custom configured duration rather than a hard-coded sixty-day default', () => {
    const p = deriveWarmupProgress(
      { first_production_at: '2026-09-01T00:00:00Z', warmup: { age_days: 8 } },
      parseWarmupCurve(config(30))
    );
    expect(p.total).toBe(30);
    expect(p.age).toBe(8);
    expect(p.expectedAt).toBe('2026-10-01T00:00:00.000Z');
  });
  it('does not invent duration or maturity time when config or anchor is missing', () => {
    const p = deriveWarmupProgress({ warmup: { age_days: 11 } }, null);
    expect(p.total).toBeNull();
    expect(p.expectedAt).toBeNull();
    expect(deriveWarmupProgress({}, parseWarmupCurve(config(60))).percent).toBeNull();
  });
  it('keeps an explicitly unbounded final stage distinct from missing configuration', () => {
    const p = deriveWarmupProgress({ warmup: { age_days: 80 } }, parseWarmupCurve(config(0)));
    expect(p.unbounded).toBe(true);
    expect(p.total).toBeNull();
    expect(p.expectedAt).toBeNull();
  });
  it('rejects incomplete or discontinuous schedules', () => {
    expect(parseWarmupCurve({})).toBeNull();
    const c = config(60);
    c['warmup-curve'][1]['min-age-days'] = 8;
    expect(parseWarmupCurve(c)).toBeNull();
    expect(parseWarmupCurve(config(6))).toBeNull();
  });
  it('keeps an absent token cap unknown, distinct from the explicit disabled zero', () => {
    expect(nonnegative(undefined)).toBeNull();
    expect(nonnegative(null)).toBeNull();
    expect(nonnegative(0)).toBe(0);
    expect(nonnegative(200000)).toBe(200000);
  });
  it('uses only supplied valid subscription percentages, never treating missing data as unused', () => {
    expect(quotaWindowSummaries({ quota_utilization: null }).every((x) => x.percent === null)).toBe(
      true
    );
    expect(
      quotaWindowSummaries({
        quota_utilization: {
          windows: {
            five_hour: { utilization_percent: 38 },
            seven_day: { utilization_percent: 101 },
          },
        },
      })
    ).toEqual([
      { key: 'five_hour', percent: 38 },
      { key: 'seven_day', percent: null },
    ]);
  });
});
