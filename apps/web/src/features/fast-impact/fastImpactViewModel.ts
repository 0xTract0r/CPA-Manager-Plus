import type { FastImpact, FastMetric, FastModel, FastTier } from './types';

export const selectFastImpactPair = (model: FastModel) => {
  const cohort = model.cohorts.find((candidate) => candidate.key === model.selected_cohort);
  return {
    defaultTier: cohort?.default || model.tiers.default,
    priorityTier: cohort?.priority || model.tiers.priority,
    cohort,
  };
};

// 首页数值、条形、样本量和变化必须来自同一组请求。
export function buildFastModelComparison(model: FastModel) {
  const pair = selectFastImpactPair(model);
  const a = pair.defaultTier.end_to_end_tps;
  const b = pair.priorityTier.end_to_end_tps;
  const hasBoth = a.samples > 0 && b.samples > 0 && a.p50 != null && b.p50 != null;
  const matched = Boolean(pair.cohort && hasBoth && pair.cohort.status !== 'low_comparability');
  const minimumSamples = Math.min(a.samples, b.samples);
  const change = matched && minimumSamples >= 5 ? pair.cohort?.change_pct ?? null : null;
  let reason = 'timing_gap';
  if (model.tiers.default.attempts + model.tiers.priority.attempts === 0) reason = 'legacy_gap';
  else if (model.tiers.priority.attempts === 0) reason = 'priority_gap';
  else if (model.tiers.default.attempts === 0) reason = 'default_gap';
  else if (pair.cohort?.status === 'low_comparability') reason = 'load_information_gap';
  else if (!pair.cohort && hasBoth) reason = 'load_gap';
  else if (matched && minimumSamples < 5) reason = 'small_sample';
  else if (matched && change == null) reason = 'load_gap';
  return { ...pair, a, b, matched, change, reason, preliminary: minimumSamples < 20 };
}

const metricFor = (tier: FastTier, metric: 'visible_tps' | 'end_to_end_tps'): FastMetric =>
  tier[metric];

export function buildFastImpactViewModel(
  data: FastImpact,
  metric: 'visible_tps' | 'end_to_end_tps'
) {
  const fallbackCoverage = data.models.reduce(
    (result, model) => ({
      defaultAttempts: result.defaultAttempts + (model.tiers.default?.attempts || 0),
      priorityAttempts: result.priorityAttempts + (model.tiers.priority?.attempts || 0),
      flexAttempts: result.flexAttempts + (model.tiers.flex?.attempts || 0),
      unknownAttempts: result.unknownAttempts + (model.tiers.unknown?.attempts || 0),
    }),
    { defaultAttempts: 0, priorityAttempts: 0, flexAttempts: 0, unknownAttempts: 0 }
  );
  const coverage = data.tier_coverage;
  const defaultAttempts = coverage?.default_attempts ?? fallbackCoverage.defaultAttempts;
  const priorityAttempts = coverage?.priority_attempts ?? fallbackCoverage.priorityAttempts;
  const flexAttempts = coverage?.flex_attempts ?? fallbackCoverage.flexAttempts;
  const unknownAttempts = coverage?.unknown_attempts ?? fallbackCoverage.unknownAttempts;
  const knownAttempts = defaultAttempts + priorityAttempts + flexAttempts;
  const totalAttempts = knownAttempts + unknownAttempts;
  const rows = data.models.map((model) => {
    const pair = selectFastImpactPair(model);
    return {
      model,
      ...pair,
      defaultMetric: metricFor(pair.defaultTier, metric),
      priorityMetric: metricFor(pair.priorityTier, metric),
    };
  });
  const comparableRows = rows.filter(
    (row) => row.cohort != null && row.defaultMetric.samples > 0 && row.priorityMetric.samples > 0
  );
  const metricDefaultSamples = data.models.reduce(
    (sum, model) => sum + metricFor(model.tiers.default, metric).samples,
    0
  );
  const metricPrioritySamples = data.models.reduce(
    (sum, model) => sum + metricFor(model.tiers.priority, metric).samples,
    0
  );
  const e2eDefaultSamples = data.models.reduce(
    (sum, model) => sum + model.tiers.default.end_to_end_tps.samples,
    0
  );
  const e2ePrioritySamples = data.models.reduce(
    (sum, model) => sum + model.tiers.priority.end_to_end_tps.samples,
    0
  );
  return {
    rows,
    comparableRows,
    defaultAttempts,
    priorityAttempts,
    flexAttempts,
    unknownAttempts,
    knownAttempts,
    totalAttempts,
    knownPercent: totalAttempts > 0 ? (knownAttempts / totalAttempts) * 100 : 0,
    knownFromMS: coverage?.known_from_ms,
    knownToMS: coverage?.known_to_ms,
    metricDefaultSamples,
    metricPrioritySamples,
    e2eDefaultSamples,
    e2ePrioritySamples,
  };
}
