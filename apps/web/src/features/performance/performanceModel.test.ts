import { describe, it, expect } from 'vitest';
import {
  DEFAULT_THRESHOLDS,
  normalizeThresholds,
  performanceStatus,
  milliseconds,
  metricNumber,
} from './performanceModel';
import type { PerformanceGroup } from './types';
describe('performance thresholds and missing data', () => {
  it('rejects invalid persisted thresholds', () => {
    expect(normalizeThresholds({ latencySeconds: 0, minTps: 'NaN', minSamples: -1 })).toEqual(
      DEFAULT_THRESHOLDS
    );
    expect(normalizeThresholds({ latencySeconds: 2, minTps: 3, minSamples: 2.1 })).toEqual({
      latencySeconds: 2,
      minTps: 3,
      minSamples: 3,
    });
  });
  it('does not classify sparse models as healthy or slow', () => {
    const group = {
      latency_ms: { samples: 1, p95: 999999 },
      total_tps: { samples: 1, p10: 1 },
    } as PerformanceGroup;
    expect(performanceStatus(group, DEFAULT_THRESHOLDS)).toBe('insufficient');
    group.latency_ms.samples = 30;
    group.total_tps.samples = 30;
    expect(performanceStatus(group, DEFAULT_THRESHOLDS)).toBe('slow');
    group.latency_ms.p95 = 1000;
    group.total_tps.p10 = 20;
    expect(performanceStatus(group, DEFAULT_THRESHOLDS)).toBe('healthy');
  });
  it('keeps missing data distinct from zero', () => {
    expect(milliseconds(null)).toBe('—');
    expect(milliseconds(0)).toBe('0 s');
    expect(metricNumber(NaN)).toBe('—');
  });
});
