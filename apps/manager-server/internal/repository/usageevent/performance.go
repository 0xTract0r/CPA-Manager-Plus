package usageevent

import (
	"context"
	"database/sql"
	"fmt"
	"math"
	"sort"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/usage"
)

type PerformanceMetric struct {
	Samples  int64    `json:"samples"`
	Eligible int64    `json:"eligible"`
	Mean     *float64 `json:"mean"`
	P10      *float64 `json:"p10"`
	P50      *float64 `json:"p50"`
	P95      *float64 `json:"p95"`
	P99      *float64 `json:"p99"`
}
type PerformanceGroup struct {
	Model                   string            `json:"model,omitempty"`
	AccountKey              string            `json:"account_key,omitempty"`
	Provider                string            `json:"provider,omitempty"`
	BucketMS                int64             `json:"bucket_ms,omitempty"`
	TotalCalls              int64             `json:"total_calls"`
	SuccessCalls            int64             `json:"success_calls"`
	FailureCalls            int64             `json:"failure_calls"`
	RateLimitedCalls        int64             `json:"rate_limited_calls"`
	TimeoutCalls            int64             `json:"timeout_calls"`
	CancelledCalls          int64             `json:"cancelled_calls"`
	LatencyMS               PerformanceMetric `json:"latency_ms"`
	TTFBMS                  PerformanceMetric `json:"ttfb_ms"`
	TotalTPS                PerformanceMetric `json:"total_tps"`
	InputTokens             int64             `json:"input_tokens"`
	OutputTokens            int64             `json:"output_tokens"`
	TotalTokens             int64             `json:"total_tokens"`
	CachedTokens            int64             `json:"cached_tokens"`
	EstimatedCost           float64           `json:"estimated_cost"`
	RequestsPerMinute       float64           `json:"requests_per_minute"`
	OutputTokensPerSecond   float64           `json:"output_tokens_per_second"`
	ObservedPeakConcurrency int64             `json:"observed_peak_concurrency"`
	ConcurrencySamples      int64             `json:"concurrency_samples"`
	TelemetrySamples        int64             `json:"telemetry_samples"`
	LinkedRequests          int64             `json:"linked_requests"`
	ObservedAttempts        int64             `json:"observed_attempts"`
	RetriedRequests         int64             `json:"retried_requests"`
}
type Performance struct {
	Summary      PerformanceGroup   `json:"summary"`
	Models       []PerformanceGroup `json:"models"`
	Accounts     []PerformanceGroup `json:"accounts"`
	Timeline     []PerformanceGroup `json:"timeline"`
	WindowFromMS int64              `json:"window_from_ms"`
	WindowToMS   int64              `json:"window_to_ms"`
	CoverageNote string             `json:"coverage_note"`
}

// PerformanceEvent 仅供内部定价回调，避免 repository 依赖 service。
type PerformanceEvent struct {
	Model, ResolvedModel, ServiceTier                                             string
	InputTokens, OutputTokens, CachedTokens, CacheReadTokens, CacheCreationTokens int64
}
type performanceAccumulator struct {
	PerformanceGroup
	latency, ttfb, tps []float64
	intervals          map[string][2]int64
	requests           map[string]map[string]bool
}

func newPerformanceAccumulator() *performanceAccumulator {
	return &performanceAccumulator{intervals: map[string][2]int64{}, requests: map[string]map[string]bool{}}
}
func performanceMetric(v []float64, eligible int64) PerformanceMetric {
	m := PerformanceMetric{Samples: int64(len(v)), Eligible: eligible}
	if len(v) == 0 {
		return m
	}
	sort.Float64s(v)
	sum := 0.0
	for _, x := range v {
		sum += x
	}
	mean := sum / float64(len(v))
	m.Mean = &mean
	q := func(p float64) *float64 { x := v[int(math.Ceil(p*float64(len(v))))-1]; return &x }
	m.P10 = q(.1)
	m.P50 = q(.5)
	m.P95 = q(.95)
	m.P99 = q(.99)
	return m
}
func (a *performanceAccumulator) finish(from, to int64) PerformanceGroup {
	a.LatencyMS = performanceMetric(a.latency, a.TotalCalls)
	a.TTFBMS = performanceMetric(a.ttfb, a.TotalCalls)
	a.TotalTPS = performanceMetric(a.tps, a.SuccessCalls)
	seconds := float64(to-from) / 1000
	if seconds > 0 {
		a.RequestsPerMinute = float64(a.TotalCalls) * 60 / seconds
		a.OutputTokensPerSecond = float64(a.OutputTokens) / seconds
	}
	type edge struct{ at, delta int64 }
	edges := []edge{}
	for _, v := range a.intervals {
		start, end := max(v[0], from), min(v[1], to)
		if start >= end {
			continue
		}
		edges = append(edges, edge{start, 1}, edge{end, -1})
		a.ConcurrencySamples++
	}
	sort.Slice(edges, func(i, j int) bool {
		if edges[i].at == edges[j].at {
			return edges[i].delta < edges[j].delta
		}
		return edges[i].at < edges[j].at
	})
	var active int64
	for _, e := range edges {
		active += e.delta
		a.ObservedPeakConcurrency = max(a.ObservedPeakConcurrency, active)
	}
	a.LinkedRequests = int64(len(a.requests))
	for _, attempts := range a.requests {
		a.ObservedAttempts += int64(len(attempts))
		if len(attempts) > 1 {
			a.RetriedRequests++
		}
	}
	return a.PerformanceGroup
}
func (r *repository) PerformanceWithFilter(ctx context.Context, filter AnalyticsFilter, granularity string, location *time.Location, cost func(PerformanceEvent) float64) (Performance, error) {
	result := Performance{Models: []PerformanceGroup{}, Accounts: []PerformanceGroup{}, Timeline: []PerformanceGroup{}, WindowFromMS: filter.FromMS, WindowToMS: filter.ToMS, CoverageNote: "latency/ttfb eligible=all matching usage events; total_tps eligible=successful matching events. Samples require positive values. Calls are usage events, not logical requests. Attempt/retry counts require telemetry IDs and cover this filtered window only. Concurrency is inferred from completed event intervals, deduplicated by attempt when available; not realtime. Attempts may contain internal retries and counts are observed lower bounds. Timeline throughput uses each clipped bucket duration."}
	where, args := analyticsWhere(filter)
	rows, err := r.db.QueryContext(ctx, `select id,timestamp_ms,model,coalesce(resolved_model,''),coalesce(service_tier,''),coalesce(nullif(auth_provider_snapshot,''),provider,''),coalesce(nullif(auth_index,''),nullif(auth_file_snapshot,''),nullif(source_hash,''),'unknown'),input_tokens,output_tokens,total_tokens,`+compatCachedExpr+`,cache_read_tokens,cache_creation_tokens,latency_ms,ttft_ms,failed,coalesce(fail_status_code,0),coalesce(telemetry_json,'') from usage_events `+where, args...)
	if err != nil {
		return result, err
	}
	defer rows.Close()
	summary := newPerformanceAccumulator()
	models := map[string]*performanceAccumulator{}
	accounts := map[[2]string]*performanceAccumulator{}
	timeline := map[int64]*performanceAccumulator{}
	for rows.Next() {
		if summary.TotalCalls >= 100000 {
			return result, fmt.Errorf("performance analytics exceeds 100000 matching events; narrow the time range or filters")
		}
		var id, ts, total int64
		var e PerformanceEvent
		var provider, account, raw string
		var latency, ttfb sql.NullInt64
		var failed, status int
		if err := rows.Scan(&id, &ts, &e.Model, &e.ResolvedModel, &e.ServiceTier, &provider, &account, &e.InputTokens, &e.OutputTokens, &total, &e.CachedTokens, &e.CacheReadTokens, &e.CacheCreationTokens, &latency, &ttfb, &failed, &status, &raw); err != nil {
			return result, err
		}
		if models[e.Model] == nil {
			models[e.Model] = newPerformanceAccumulator()
			models[e.Model].Model = e.Model
		}
		key := [2]string{provider, account}
		if accounts[key] == nil {
			accounts[key] = newPerformanceAccumulator()
			accounts[key].AccountKey = account
			accounts[key].Provider = provider
		}
		bucket := resolveBucketMS(ts, granularity, location)
		if timeline[bucket] == nil {
			timeline[bucket] = newPerformanceAccumulator()
			timeline[bucket].BucketMS = bucket
		}
		telemetry := usage.TelemetryFromJSON(raw)
		eventCost := 0.0
		if cost != nil {
			eventCost = cost(e)
		}
		for _, a := range []*performanceAccumulator{summary, models[e.Model], accounts[key], timeline[bucket]} {
			a.TotalCalls++
			if failed == 0 {
				a.SuccessCalls++
			} else {
				a.FailureCalls++
			}
			if status == 429 {
				a.RateLimitedCalls++
			}
			if telemetry != nil {
				a.TelemetrySamples++
				if telemetry.FailureKind == "timeout" {
					a.TimeoutCalls++
				}
				if telemetry.FailureKind == "cancelled" {
					a.CancelledCalls++
				}
				if telemetry.RequestID != "" {
					if a.requests[telemetry.RequestID] == nil {
						a.requests[telemetry.RequestID] = map[string]bool{}
					}
					a.requests[telemetry.RequestID][telemetry.AttemptID] = true
				}
			}
			a.InputTokens += e.InputTokens
			a.OutputTokens += e.OutputTokens
			a.TotalTokens += total
			a.CachedTokens += e.CachedTokens
			a.EstimatedCost += eventCost
			if latency.Valid && latency.Int64 > 0 {
				a.latency = append(a.latency, float64(latency.Int64))
				if failed == 0 && e.OutputTokens > 0 {
					a.tps = append(a.tps, float64(e.OutputTokens)*1000/float64(latency.Int64))
				}
			}
			if ttfb.Valid && ttfb.Int64 > 0 {
				a.ttfb = append(a.ttfb, float64(ttfb.Int64))
			}
			// 仅结构化 attempt 区间可去重；旧拆账不能推断为独立并发。
			if telemetry != nil && telemetry.StartedAtMS > 0 && telemetry.EndedAtMS > telemetry.StartedAtMS {
				a.intervals[telemetry.AttemptID] = [2]int64{telemetry.StartedAtMS, telemetry.EndedAtMS}
			}
		}
	}
	if err := rows.Err(); err != nil {
		return result, err
	}
	// 空时间桶返回 null 指标，防止趋势图跨缺失窗口连线。
	if len(timeline) > 0 {
		first, last := int64(math.MaxInt64), int64(0)
		for bucket := range timeline {
			first = min(first, bucket)
			last = max(last, bucket)
		}
		if location == nil {
			location = time.UTC
		}
		for bucket := first; bucket <= last; {
			if len(timeline) >= 50000 {
				return result, fmt.Errorf("performance timeline exceeds 50000 buckets; narrow the time range")
			}
			if timeline[bucket] == nil {
				timeline[bucket] = newPerformanceAccumulator()
				timeline[bucket].BucketMS = bucket
			}
			t := time.UnixMilli(bucket).In(location)
			if granularity == "day" {
				bucket = t.AddDate(0, 0, 1).UnixMilli()
			} else {
				bucket = t.Add(time.Hour).UnixMilli()
			}
		}
	}
	result.Summary = summary.finish(filter.FromMS, filter.ToMS)
	for _, a := range models {
		result.Models = append(result.Models, a.finish(filter.FromMS, filter.ToMS))
	}
	for _, a := range accounts {
		result.Accounts = append(result.Accounts, a.finish(filter.FromMS, filter.ToMS))
	}
	for bucket, a := range timeline {
		if location == nil {
			location = time.UTC
		}
		start := time.UnixMilli(bucket).In(location)
		end := start.Add(time.Hour).UnixMilli()
		if granularity == "day" {
			end = start.AddDate(0, 0, 1).UnixMilli()
		}
		if granularity == "minute" {
			end = start.Add(time.Minute).UnixMilli()
		}
		result.Timeline = append(result.Timeline, a.finish(max(filter.FromMS, bucket), min(filter.ToMS, end)))
	}
	sort.Slice(result.Models, func(i, j int) bool { return result.Models[i].Model < result.Models[j].Model })
	sort.Slice(result.Accounts, func(i, j int) bool {
		a, b := result.Accounts[i], result.Accounts[j]
		if a.Provider == b.Provider {
			return a.AccountKey < b.AccountKey
		}
		return a.Provider < b.Provider
	})
	sort.Slice(result.Timeline, func(i, j int) bool { return result.Timeline[i].BucketMS < result.Timeline[j].BucketMS })
	return result, nil
}
