import { describe, expect, it } from 'vitest';
import type { MonitoringAnalyticsEventRow } from '@/services/api/usageService';
import {
  computeAccountSpeedMetrics,
  computeMetricDelta,
  median,
  normalizeServiceTier,
} from './accountSpeedMetrics';

const makeRow = (overrides: Partial<MonitoringAnalyticsEventRow>): MonitoringAnalyticsEventRow => ({
  event_hash: overrides.event_hash ?? 'hash',
  timestamp_ms: overrides.timestamp_ms ?? 0,
  model: overrides.model ?? 'gpt-5',
  endpoint: overrides.endpoint ?? 'responses',
  method: overrides.method ?? 'POST',
  path: overrides.path ?? '/v1/responses',
  auth_index: overrides.auth_index ?? '1',
  source: overrides.source ?? 'src',
  source_hash: overrides.source_hash ?? 'srchash',
  api_key_hash: overrides.api_key_hash ?? 'keyhash',
  account_snapshot: overrides.account_snapshot ?? 'acct',
  auth_label_snapshot: overrides.auth_label_snapshot ?? 'label',
  auth_provider_snapshot: overrides.auth_provider_snapshot ?? 'codex',
  input_tokens: overrides.input_tokens ?? 0,
  output_tokens: overrides.output_tokens ?? 0,
  cached_tokens: overrides.cached_tokens ?? 0,
  cache_read_tokens: overrides.cache_read_tokens ?? 0,
  cache_creation_tokens: overrides.cache_creation_tokens ?? 0,
  reasoning_tokens: overrides.reasoning_tokens ?? 0,
  total_tokens: overrides.total_tokens ?? 0,
  latency_ms: overrides.latency_ms ?? null,
  ttft_ms: overrides.ttft_ms,
  failed: overrides.failed ?? false,
  service_tier: overrides.service_tier,
});

describe('median', () => {
  it('returns null for empty arrays', () => {
    expect(median([])).toBeNull();
  });
  it('averages the two middle values for even-length arrays', () => {
    expect(median([10, 20, 30, 40])).toBe(25);
  });
  it('returns the middle value for odd-length arrays and is order independent', () => {
    expect(median([30, 10, 20])).toBe(20);
  });
});

describe('normalizeServiceTier', () => {
  it('maps empty/undefined to default and lowercases', () => {
    expect(normalizeServiceTier(undefined)).toBe('default');
    expect(normalizeServiceTier('')).toBe('default');
    expect(normalizeServiceTier(' Priority ')).toBe('priority');
  });
});

describe('computeMetricDelta', () => {
  it('returns all-null (no NaN) when either value is missing or default is zero', () => {
    expect(computeMetricDelta(null, 100, { lowerIsBetter: true })).toEqual({
      pctChange: null,
      ratio: null,
      improved: null,
    });
    expect(computeMetricDelta(100, undefined, { lowerIsBetter: true })).toEqual({
      pctChange: null,
      ratio: null,
      improved: null,
    });
    // 除零保护：default=0 不产出 Infinity/NaN
    expect(computeMetricDelta(50, 0, { lowerIsBetter: false })).toEqual({
      pctChange: null,
      ratio: null,
      improved: null,
    });
  });

  it('treats lower-is-better metrics (TTFT/latency) as improved when fast is smaller', () => {
    // fast=460ms vs default=1000ms → -54%，更快
    const delta = computeMetricDelta(460, 1000, { lowerIsBetter: true });
    expect(delta.pctChange).toBeCloseTo(-54, 5);
    expect(delta.ratio).toBeCloseTo(0.46, 5);
    expect(delta.improved).toBe(true);
  });

  it('treats higher-is-better metrics (TPS) as improved when fast is larger', () => {
    // fast=84 vs default=54 → +55.5%，更高
    const delta = computeMetricDelta(84, 54, { lowerIsBetter: false });
    expect(delta.pctChange).toBeCloseTo(55.5556, 3);
    expect(delta.improved).toBe(true);
  });

  it('marks not-improved when direction is wrong', () => {
    expect(computeMetricDelta(1200, 1000, { lowerIsBetter: true }).improved).toBe(false);
    expect(computeMetricDelta(40, 54, { lowerIsBetter: false }).improved).toBe(false);
  });
});

describe('computeAccountSpeedMetrics', () => {
  it('returns an explicit insufficient-data result for empty input without NaN', () => {
    const result = computeAccountSpeedMetrics([]);
    expect(result.hasData).toBe(false);
    expect(result.totalEvents).toBe(0);
    expect(result.usedEvents).toBe(0);
    expect(result.overall.medianTtftMs).toBeNull();
    expect(result.overall.medianLatencyMs).toBeNull();
    expect(result.overall.medianTps).toBeNull();
    expect(result.priorityTier).toBeNull();
    expect(result.defaultTier).toBeNull();
  });

  it('computes median ttft/latency and generation-phase TPS with minSamples=1', () => {
    // 两个事件：
    //  A: latency 1200, ttft 200 -> 生成 1000ms, output 100 -> 100 tok/s
    //  B: latency 2200, ttft 200 -> 生成 2000ms, output 100 -> 50 tok/s
    const rows = [
      makeRow({ latency_ms: 1200, ttft_ms: 200, output_tokens: 100, service_tier: 'priority' }),
      makeRow({ latency_ms: 2200, ttft_ms: 200, output_tokens: 100, service_tier: 'default' }),
    ];
    const result = computeAccountSpeedMetrics(rows, { minSamples: 1 });
    expect(result.hasData).toBe(true);
    expect(result.overall.medianTtftMs).toBe(200);
    expect(result.overall.medianLatencyMs).toBe(1700); // (1200 + 2200) / 2
    expect(result.overall.medianTps).toBe(75); // median of [100, 50]
    expect(result.overall.tpsSamples).toBe(2);
    expect(result.usedEvents).toBe(2);
  });

  it('splits by service_tier into priority (fast) and default (non-fast) buckets', () => {
    const rows = [
      makeRow({ latency_ms: 1200, ttft_ms: 200, output_tokens: 100, service_tier: 'priority' }),
      makeRow({ latency_ms: 2200, ttft_ms: 200, output_tokens: 100, service_tier: '' }),
    ];
    const result = computeAccountSpeedMetrics(rows, { minSamples: 1 });
    expect(result.priorityTier?.medianTps).toBe(100);
    expect(result.defaultTier?.medianTps).toBe(50);
    expect(Object.keys(result.byServiceTier).sort()).toEqual(['default', 'priority']);
    expect(result.byServiceTier.priority.events).toBe(1);
    expect(result.byServiceTier.default.events).toBe(1);
  });

  it('skips TPS when ttft is missing or generation time is non-positive, but still counts latency', () => {
    const rows = [
      makeRow({ latency_ms: 1000, output_tokens: 100 }), // no ttft -> no TPS
      makeRow({ latency_ms: 500, ttft_ms: 600, output_tokens: 100 }), // ttft>latency -> no TPS
    ];
    const result = computeAccountSpeedMetrics(rows, { minSamples: 1 });
    expect(result.overall.tpsSamples).toBe(0);
    expect(result.overall.medianTps).toBeNull();
    expect(result.overall.latencySamples).toBe(2);
    expect(result.overall.medianLatencyMs).toBe(750);
  });

  it('excludes failed events by default and honors includeFailed', () => {
    const rows = [
      makeRow({ latency_ms: 1000, ttft_ms: 100, output_tokens: 90, failed: true }),
      makeRow({ latency_ms: 1200, ttft_ms: 200, output_tokens: 100, failed: false }),
    ];
    const excluded = computeAccountSpeedMetrics(rows, { minSamples: 1 });
    expect(excluded.totalEvents).toBe(2);
    expect(excluded.usedEvents).toBe(1);
    expect(excluded.overall.latencySamples).toBe(1);

    const included = computeAccountSpeedMetrics(rows, { minSamples: 1, includeFailed: true });
    expect(included.usedEvents).toBe(2);
    expect(included.overall.latencySamples).toBe(2);
  });

  it('nulls out medians below minSamples so sparse data reports insufficient', () => {
    const rows = [makeRow({ latency_ms: 1200, ttft_ms: 200, output_tokens: 100 })];
    const result = computeAccountSpeedMetrics(rows, { minSamples: 3 });
    expect(result.hasData).toBe(false);
    expect(result.overall.medianTps).toBeNull();
    expect(result.overall.tpsSamples).toBe(1); // sample counted, but below threshold
  });
});
