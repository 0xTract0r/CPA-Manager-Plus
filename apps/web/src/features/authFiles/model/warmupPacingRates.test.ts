import { describe, expect, it } from 'vitest';
import type { AuthFileWarmupTrafficPacing } from '@/types';
import { pacingRateSummary } from './warmupPacing';
const snapshot = (overrides: Partial<AuthFileWarmupTrafficPacing> = {}) =>
  ({
    status: 'active',
    rpm_limit: 5,
    refill_per_hour: 500 / 24,
    min_admission_requests: 4,
    request_capacity: 8,
    ...overrides,
  }) as AuthFileWarmupTrafficPacing;
describe('peak versus refill rate', () => {
  it('converts the full precision 500/day refill, rounding wait estimates upward', () => {
    const rate = pacingRateSummary(snapshot());
    expect(rate.hourly).toBeCloseTo(20.83333333);
    expect(rate.perMinute).toBeCloseTo(0.34722222);
    expect(rate.secondsPerCredit).toBe(173);
    expect(rate.emptyToNewSessionSeconds).toBe(692);
    expect(rate.peakRPM).toBe(5);
  });
  it('does not increase replenishment when the burst RPM or capacity is raised', () => {
    const base = pacingRateSummary(snapshot());
    const larger = pacingRateSummary(snapshot({ rpm_limit: 10, request_capacity: 12 }));
    expect(larger.perMinute).toBe(base.perMinute);
    expect(larger.secondsPerCredit).toBe(base.secondsPerCredit);
    expect(larger.peakRPM).toBe(10);
  });
  it('uses the actual refill and admission threshold instead of hard-coded 500 or 4', () => {
    const rate = pacingRateSummary(
      snapshot({ refill_per_hour: 200 / 24, min_admission_requests: 6 })
    );
    expect(rate.secondsPerCredit).toBe(432);
    expect(rate.emptyToNewSessionSeconds).toBe(2592);
  });
  it('supports threshold one without inventing a larger reserve', () => {
    const rate = pacingRateSummary(snapshot({ min_admission_requests: 1 }));
    expect(rate.emptyToNewSessionSeconds).toBe(rate.secondsPerCredit);
  });
  it.each([null, undefined, 0, NaN, Infinity])(
    'does not advertise a refill duration for %s',
    (hourly) => {
      const rate = pacingRateSummary(snapshot({ refill_per_hour: hourly }));
      expect(rate.hourly).toBeNull();
      expect(rate.secondsPerCredit).toBeNull();
    }
  );
  it('does not present a disabled snapshot as an active refill source', () => {
    expect(pacingRateSummary(snapshot({ status: 'disabled' })).perMinute).toBeNull();
  });
});
