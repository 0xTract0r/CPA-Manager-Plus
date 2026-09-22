import { describe, expect, it } from 'vitest';
import type { FastImpact, FastMetric, FastTier } from './types';
import { buildFastImpactViewModel } from './fastImpactViewModel';

const metric = (samples: number, p50: number | null = null): FastMetric => ({
  samples,
  p25: p50,
  p50,
  p75: p50,
});
const tier = (attempts: number, visibleSamples = 0, e2eSamples = 0): FastTier => ({
  attempts,
  failed: 0,
  cancelled: 0,
  empty: 0,
  visible_tps: metric(visibleSamples, visibleSamples ? 42 : null),
  end_to_end_tps: metric(e2eSamples, e2eSamples ? 21 : null),
  first_visible_ms: metric(0),
  first_body_ms: metric(0),
  excluded: {},
  sources: {},
});
const data = (): FastImpact => ({
  version: 1,
  metric_definition: '',
  from_ms: 1,
  to_ms: 2,
  mode: 'tier',
  metric: 'visible_tps',
  scanned: 23_978,
  matched: 23_978,
  complete: true,
  tier_coverage: {
    default_attempts: 532,
    priority_attempts: 0,
    flex_attempts: 0,
    unknown_attempts: 23_446,
    known_from_ms: 100,
    known_to_ms: 200,
  },
  models: [
    {
      query_model: 'gpt-6-astra',
      model_resolution: 'resolved',
      model: 'gpt-6-astra',
      attempts: 9_256,
      tiers: {
        default: tier(433, 0, 375),
        priority: tier(0),
        flex: tier(0),
        unknown: tier(8_823),
      },
      cohorts: [],
      selected_cohort: '',
      change_pct: null,
      status: 'missing_baseline',
      coverage: 0,
      excluded: {},
      observations: [],
      observations_truncated: false,
    },
  ],
});

describe('buildFastImpactViewModel', () => {
  it('explains legacy unknown coverage and one-sided current data', () => {
    const result = buildFastImpactViewModel(data(), 'visible_tps');
    expect(result.knownAttempts).toBe(532);
    expect(result.unknownAttempts).toBe(23_446);
    expect(result.knownPercent).toBeCloseTo(2.2187, 3);
    expect(result.comparableRows).toHaveLength(0);
    expect(result.metricDefaultSamples).toBe(0);
    expect(result.e2eDefaultSamples).toBe(375);
  });

  it('uses the selected common cohort for the comparison chart', () => {
    const value = data();
    value.models[0].cohorts = [
      {
        key: 'high|<32k|<50%',
        effort: 'high',
        input_bucket: '<32k',
        cache_bucket: '<50%',
        default: tier(10, 8, 8),
        priority: tier(9, 7, 7),
        change_pct: 50,
        status: 'observed',
      },
    ];
    value.models[0].selected_cohort = 'high|<32k|<50%';
    const result = buildFastImpactViewModel(value, 'visible_tps');
    expect(result.comparableRows).toHaveLength(1);
    expect(result.comparableRows[0].defaultMetric.p50).toBe(42);
    expect(result.comparableRows[0].priorityMetric.samples).toBe(7);
  });
});
