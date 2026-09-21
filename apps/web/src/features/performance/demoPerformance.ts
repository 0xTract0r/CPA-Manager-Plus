import type {
  MonitoringAnalyticsEventRow,
  MonitoringAnalyticsRequest,
} from '@/services/api/usageService';
import type { PerformanceData, PerformanceGroup, PerformanceMetric } from './types';

// 仅从 demoFixtures 引用；生产构建通过现有 demo isolation 剔除。
export function withDemoTelemetry(
  event: MonitoringAnalyticsEventRow,
  index: number
): MonitoringAnalyticsEventRow {
  if (index % 7 === 6) return event;
  // 较旧失败尝试与前一条较新成功事件关联，演示换尝试后的成功。
  if (index % 173 === 2)
    event = {
      ...event,
      request_id: `demo-request-${String(index).padStart(3, '0')}`,
      failed: true,
      fail_status_code: 429,
      fail_summary: 'Mock retry before successful attempt',
    };
  const stalled = index % 5 === 2 && !event.model.includes('haiku');
  const duration = Math.max(event.latency_ms || 1000, stalled ? 18000 : 1000);
  const firstBody = event.ttft_ms || Math.min(170, duration / 2);
  const isCodex = event.auth_provider_snapshot === 'codex';
  const clientRequestedFast = isCodex && index % 4 === 1;
  return {
    ...event,
    service_tier: clientRequestedFast ? 'priority' : event.service_tier,
    latency_ms: duration,
    telemetry: {
      version: 1,
      attempt_id: `mock-attempt-${index}`,
      request_id: event.request_id,
      started_at_ms: event.timestamp_ms,
      ended_at_ms: event.timestamp_ms + duration,
      transport: 'http',
      observation_kind: 'http_sse',
      observed_stages: ['response_headers', 'first_body', 'content'],
      connect_ms: 40,
      tls_ms: 70,
      response_headers_ms: Math.max(0, firstBody - 20),
      first_body_ms: firstBody,
      first_content_ms: Math.min(firstBody + 30, duration - 10),
      last_content_ms: duration - 10,
      content_chunks: 45,
      max_content_gap_ms: stalled ? 8000 : 120,
      stall_count: stalled ? 1 : 0,
      stall_duration_ms: stalled ? 8000 : 0,
      stall_threshold_ms: 1000,
      stream_completed: !event.failed,
      failure_kind: event.failed ? 'upstream_error' : undefined,
      fast_context: isCodex
        ? clientRequestedFast
          ? {
              schema_version: 1,
              client_service_tier: 'priority',
              upstream_request_service_tier: 'default',
              server_fast_enabled: false,
              tier_source: 'default',
              request_kind: 'serving',
            }
          : {
              schema_version: 1,
              client_service_tier: event.service_tier || 'auto',
              upstream_request_service_tier: 'priority',
              server_fast_enabled: true,
              tier_source: 'account',
              request_kind: 'serving',
            }
        : undefined,
    },
  };
}
function metric(values: number[], eligible: number): PerformanceMetric {
  values.sort((a, b) => a - b);
  const percentile = (p: number) =>
    values.length ? values[Math.max(0, Math.ceil(values.length * p) - 1)] : null;
  return {
    samples: values.length,
    eligible,
    mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
    p10: percentile(0.1),
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
  };
}
function group(events: MonitoringAnalyticsEventRow[], durationMs: number): PerformanceGroup {
  const sum = (key: 'input_tokens' | 'output_tokens' | 'total_tokens' | 'cached_tokens') =>
    events.reduce((acc, event) => acc + event[key], 0);
  const successful = events.filter((event) => !event.failed);
  const valid = (key: 'latency_ms' | 'ttft_ms') =>
    events
      .map((event) => event[key])
      .filter((value): value is number => typeof value === 'number' && value > 0);
  const requests = new Map<string, Set<string>>();
  const intervals = new Map<string, [number, number]>();
  for (const event of events)
    if (event.telemetry) {
      const value = event.telemetry;
      intervals.set(value.attempt_id, [value.started_at_ms, value.ended_at_ms]);
      if (value.request_id) {
        const ids = requests.get(value.request_id) || new Set<string>();
        ids.add(value.attempt_id);
        requests.set(value.request_id, ids);
      }
    }
  const points = [...intervals.values()]
    .flatMap(([start, end]) => [
      [start, 1],
      [end, -1],
    ])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let current = 0,
    peak = 0;
  for (const point of points) {
    current += point[1];
    peak = Math.max(peak, current);
  }
  return {
    total_calls: events.length,
    success_calls: successful.length,
    failure_calls: events.length - successful.length,
    rate_limited_calls: events.filter((event) => event.fail_status_code === 429).length,
    timeout_calls: events.filter((event) => event.fail_summary?.toLowerCase().includes('timeout'))
      .length,
    cancelled_calls: 0,
    latency_ms: metric(valid('latency_ms'), events.length),
    ttfb_ms: metric(valid('ttft_ms'), events.length),
    total_tps: metric(
      successful
        .filter((event) => event.output_tokens > 0 && (event.latency_ms || 0) > 0)
        .map((event) => (event.output_tokens * 1000) / event.latency_ms!),
      successful.length
    ),
    input_tokens: sum('input_tokens'),
    output_tokens: sum('output_tokens'),
    total_tokens: sum('total_tokens'),
    cached_tokens: sum('cached_tokens'),
    estimated_cost: sum('input_tokens') * 0.000002 + sum('output_tokens') * 0.000008,
    requests_per_minute: (events.length * 60000) / Math.max(1, durationMs),
    output_tokens_per_second: (sum('output_tokens') * 1000) / Math.max(1, durationMs),
    concurrency_samples: intervals.size,
    observed_peak_concurrency: peak,
    telemetry_samples: events.filter((event) => event.telemetry).length,
    linked_requests: requests.size,
    observed_attempts: intervals.size,
    retried_requests: [...requests.values()].filter((value) => value.size > 1).length,
  };
}
export function demoPerformance(
  events: MonitoringAnalyticsEventRow[],
  request: MonitoringAnalyticsRequest
): PerformanceData {
  const filters = request.filters;
  const filtered = events.filter(
    (event) =>
      event.timestamp_ms >= request.from_ms &&
      event.timestamp_ms < request.to_ms &&
      (!filters?.models?.length || filters.models.includes(event.model)) &&
      (!filters?.providers?.length || filters.providers.includes(event.auth_provider_snapshot)) &&
      (!filters?.api_key_hashes?.length || filters.api_key_hashes.includes(event.api_key_hash)) &&
      (!filters?.auth_files?.length ||
        filters.auth_files.includes(event.auth_file_snapshot || '')) &&
      (!filters?.failed_only || event.failed) &&
      (filters?.include_failed !== false || !event.failed) &&
      (!filters?.min_latency_ms || (event.latency_ms || 0) >= filters.min_latency_ms) &&
      (!filters?.cache_status ||
        filters.cache_status === 'all' ||
        (filters.cache_status === 'hit' ? event.cached_tokens > 0 : event.cached_tokens === 0))
  );
  const duration = request.to_ms - request.from_ms;
  const grouped = (key: (event: MonitoringAnalyticsEventRow) => string) => {
    const groups = new Map<string, MonitoringAnalyticsEventRow[]>();
    for (const event of filtered) {
      const name = key(event);
      groups.set(name, [...(groups.get(name) || []), event]);
    }
    return groups;
  };
  const bucketSize = request.include?.granularity === 'day' ? 86400000 : 3600000;
  const timeline = [];
  for (
    let bucket = Math.floor(request.from_ms / bucketSize) * bucketSize;
    bucket < request.to_ms;
    bucket += bucketSize
  ) {
    const start = Math.max(bucket, request.from_ms),
      end = Math.min(bucket + bucketSize, request.to_ms);
    timeline.push({
      ...group(
        filtered.filter((event) => event.timestamp_ms >= start && event.timestamp_ms < end),
        end - start
      ),
      bucket_ms: bucket,
    });
  }
  return {
    summary: group(filtered, duration),
    models: [...grouped((event) => event.model)].map(([model, rows]) => ({
      ...group(rows, duration),
      model,
    })),
    accounts: [...grouped((event) => `${event.auth_provider_snapshot}|${event.auth_index}`)].map(
      ([, rows]) => ({
        ...group(rows, duration),
        account_key: rows[0].auth_index,
        provider: rows[0].auth_provider_snapshot,
      })
    ),
    timeline,
    window_from_ms: request.from_ms,
    window_to_ms: request.to_ms,
    coverage_note: 'mock',
  };
}
