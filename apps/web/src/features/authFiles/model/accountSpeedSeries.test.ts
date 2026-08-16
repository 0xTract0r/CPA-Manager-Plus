import { describe, expect, it } from 'vitest';
import type { MonitoringAnalyticsEventRow } from '@/services/api/usageService';
import {
  detectFirstFastTransition,
  extractSpeedSeries,
  type SpeedSeriesPoint,
} from './accountSpeedSeries';

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
  header_quota_used_percent: overrides.header_quota_used_percent,
  header_quota_recover_at_ms: overrides.header_quota_recover_at_ms,
});

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

describe('extractSpeedSeries', () => {
  it('returns [] for empty/nullish input without throwing', () => {
    expect(extractSpeedSeries([])).toEqual([]);
    expect(extractSpeedSeries(null)).toEqual([]);
    expect(extractSpeedSeries(undefined)).toEqual([]);
  });

  it('sorts ascending by timestamp_ms and maps priority flag + clamps used%', () => {
    const series = extractSpeedSeries([
      makeRow({ timestamp_ms: 300, service_tier: 'priority', header_quota_used_percent: 140 }),
      makeRow({ timestamp_ms: 100, service_tier: 'default', header_quota_used_percent: -5 }),
      makeRow({ timestamp_ms: 200, service_tier: 'Priority ', header_quota_used_percent: 42 }),
    ]);
    expect(series.map((p) => p.ts)).toEqual([100, 200, 300]);
    expect(series.map((p) => p.isPriority)).toEqual([false, true, true]);
    // clamp 到 [0,100]
    expect(series[0].usedPercent).toBe(0);
    expect(series[2].usedPercent).toBe(100);
    expect(series[1].usedPercent).toBe(42);
  });

  it('excludes failed events by default and keeps them under includeFailed', () => {
    const rows = [
      makeRow({ timestamp_ms: 1, failed: false }),
      makeRow({ timestamp_ms: 2, failed: true }),
    ];
    expect(extractSpeedSeries(rows)).toHaveLength(1);
    expect(extractSpeedSeries(rows, { includeFailed: true })).toHaveLength(2);
  });

  it('drops rows with non-finite timestamps and non-negative-guards ttft/latency', () => {
    const series = extractSpeedSeries([
      makeRow({ timestamp_ms: Number.NaN, ttft_ms: 100 }),
      makeRow({ timestamp_ms: 500, ttft_ms: -3, latency_ms: 900 }),
    ]);
    expect(series).toHaveLength(1);
    expect(series[0].ttftMs).toBeNull(); // 负值 → null，绝不产出负坐标
    expect(series[0].latencyMs).toBe(900);
  });
});

describe('detectFirstFastTransition', () => {
  it('returns null for empty / single-point / single-tier series', () => {
    expect(detectFirstFastTransition([])).toBeNull();
    expect(detectFirstFastTransition([point({ ts: 1, isPriority: true })])).toBeNull();
    expect(
      detectFirstFastTransition([
        point({ ts: 1, isPriority: false }),
        point({ ts: 2, isPriority: false }),
      ])
    ).toBeNull();
  });

  it('returns null when the only switch is priority→default (not a fast turn-on)', () => {
    expect(
      detectFirstFastTransition([
        point({ ts: 1, isPriority: true }),
        point({ ts: 2, isPriority: false }),
      ])
    ).toBeNull();
  });

  it('returns the first default→priority boundary among multiple switches', () => {
    const series = [
      point({ ts: 1, isPriority: false, tier: 'default' }),
      point({ ts: 2, isPriority: true, tier: 'priority' }), // first default→priority
      point({ ts: 3, isPriority: false, tier: 'default' }),
      point({ ts: 4, isPriority: true, tier: 'priority' }), // later switch, ignored
    ];
    const transition = detectFirstFastTransition(series);
    expect(transition).not.toBeNull();
    expect(transition?.index).toBe(1);
    expect(transition?.fromTier).toBe('default');
    expect(transition?.toTier).toBe('priority');
    expect(transition?.ts).toBe(2);
    expect(transition?.ratio).toBeCloseTo(1 / 3, 5);
  });
});
