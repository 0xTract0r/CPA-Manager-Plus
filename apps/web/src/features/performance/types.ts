export interface PerformanceMetric {
  samples: number;
  eligible: number;
  mean: number | null;
  p10: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
}
export interface PerformanceGroup {
  total_calls: number;
  success_calls: number;
  failure_calls: number;
  rate_limited_calls: number;
  timeout_calls: number;
  cancelled_calls: number;
  latency_ms: PerformanceMetric;
  ttfb_ms: PerformanceMetric;
  total_tps: PerformanceMetric;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cached_tokens: number;
  estimated_cost: number;
  requests_per_minute: number;
  output_tokens_per_second: number;
  observed_peak_concurrency: number;
  concurrency_samples: number;
  telemetry_samples: number;
  linked_requests: number;
  observed_attempts: number;
  retried_requests: number;
}
export interface PerformanceData {
  summary: PerformanceGroup;
  models: (PerformanceGroup & { model: string })[];
  accounts: (PerformanceGroup & { account_key: string; provider: string })[];
  timeline: (PerformanceGroup & { bucket_ms: number })[];
  window_from_ms: number;
  window_to_ms: number;
  coverage_note: string;
}
export interface RequestTelemetry {
  fast_context?: {
    schema_version: number;
    client_service_tier?: string;
    upstream_request_service_tier: string;
    server_fast_enabled?: boolean;
    tier_source: 'client' | 'account' | 'both' | 'default' | 'unknown' | string;
    request_kind: 'serving' | 'prewarm' | string;
  };
  version: number;
  attempt_id: string;
  request_id?: string;
  started_at_ms: number;
  ended_at_ms: number;
  transport: string;
  observation_kind: string;
  observed_stages: string[];
  connect_ms?: number;
  tls_ms?: number;
  response_headers_ms?: number;
  first_body_ms?: number;
  first_content_ms?: number;
  last_content_ms?: number;
  max_content_gap_ms?: number;
  stall_duration_ms?: number;
  content_chunks?: number;
  stall_count?: number;
  stall_threshold_ms?: number;
  stream_completed?: boolean;
  finish_reason?: string;
  failure_kind?: string;
}
