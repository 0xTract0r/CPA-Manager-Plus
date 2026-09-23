export type FastMetric = {
  samples: number;
  p25: number | null;
  p50: number | null;
  p75: number | null;
};
export type FastTier = {
  attempts: number;
  failed: number;
  cancelled: number;
  empty: number;
  visible_tps: FastMetric;
  end_to_end_tps: FastMetric;
  first_visible_ms: FastMetric;
  first_body_ms: FastMetric;
  excluded: Record<string, number>;
  sources: Record<string, number>;
};
export type FastCohort = {
  key: string;
  effort: string;
  input_bucket: string;
  cache_bucket: string;
  default: FastTier;
  priority: FastTier;
  change_pct: number | null;
  status: string;
};
export type FastModel = {
  query_model: string;
  model_resolution: 'resolved' | 'unresolved';
  model: string;
  attempts: number;
  tiers: Record<string, FastTier>;
  cohorts: FastCohort[];
  selected_cohort: string;
  change_pct: number | null;
  status: string;
  coverage: number;
  excluded: Record<string, number>;
  transition?: {
    source: string;
    from_ms: number;
    to_ms: number;
    before_from_ms: number;
    after_to_ms: number;
    enabled: boolean;
  };
  observations: {
    request_id: string;
    started_at_ms: number;
    tier: string;
    failed: boolean;
    output_tokens: number;
  }[];
  observations_truncated: boolean;
};
export type FastImpactOptions = {
  mode?: 'tier' | 'transition';
  metric?: 'visible_tps' | 'end_to_end_tps';
  anchor_ms?: number;
  window_ms?: number;
};
export type FastImpact = {
  version: number;
  metric_definition: string;
  from_ms: number;
  to_ms: number;
  mode: string;
  metric: string;
  scanned: number;
  matched: number;
  complete: boolean;
  tier_coverage?: {
    default_attempts: number;
    priority_attempts: number;
    flex_attempts: number;
    unknown_attempts: number;
    known_from_ms?: number;
    known_to_ms?: number;
  };
  models: FastModel[];
};
