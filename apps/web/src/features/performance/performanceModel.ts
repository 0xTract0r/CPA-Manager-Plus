import type { PerformanceGroup, PerformanceMetric } from './types';
export const THRESHOLD_KEY = 'cpamp.performance.thresholds.v1';
export interface PerformanceThresholds {
  latencySeconds: number;
  minTps: number;
  minSamples: number;
}
export const DEFAULT_THRESHOLDS: PerformanceThresholds = {
  latencySeconds: 60,
  minTps: 10,
  minSamples: 30,
};
export function normalizeThresholds(value: unknown): PerformanceThresholds {
  const candidate = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const valid = (key: keyof PerformanceThresholds, max: number) => {
    const number = Number(candidate[key]);
    return Number.isFinite(number) && number > 0 && number <= max
      ? number
      : DEFAULT_THRESHOLDS[key];
  };
  return {
    latencySeconds: valid('latencySeconds', 3600),
    minTps: valid('minTps', 100000),
    minSamples: Math.ceil(valid('minSamples', 1000000)),
  };
}
export function readThresholds(): PerformanceThresholds {
  try {
    return normalizeThresholds(JSON.parse(localStorage.getItem(THRESHOLD_KEY) || 'null'));
  } catch {
    return { ...DEFAULT_THRESHOLDS };
  }
}
export function performanceStatus(
  group: PerformanceGroup,
  thresholds: PerformanceThresholds
): 'insufficient' | 'slow' | 'healthy' {
  if (
    group.latency_ms.samples < thresholds.minSamples ||
    group.total_tps.samples < thresholds.minSamples
  )
    return 'insufficient';
  return (group.latency_ms.p95 !== null &&
    group.latency_ms.p95 > thresholds.latencySeconds * 1000) ||
    (group.total_tps.p10 !== null && group.total_tps.p10 < thresholds.minTps)
    ? 'slow'
    : 'healthy';
}
export const coverage = (metric: PerformanceMetric) => `${metric.samples} / ${metric.eligible}`;
export const metricNumber = (value: number | null | undefined, digits = 1) =>
  value == null || !Number.isFinite(value)
    ? '—'
    : value.toLocaleString(undefined, { maximumFractionDigits: digits });
export const milliseconds = (value: number | null | undefined) =>
  value == null ? '—' : `${metricNumber(value / 1000, 2)} s`;
