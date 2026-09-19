package usageevent

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/usage"
)

func fastContextJSON(t *usage.Telemetry) any {
	if t.FastContext == nil {
		return nil
	}
	b, _ := json.Marshal(t.FastContext)
	return string(b)
}

func (r *repository) FastImpactWithFilter(ctx context.Context, filter AnalyticsFilter, options usage.FastImpactOptions) (usage.FastImpact, error) {
	if len(filter.AuthIndices) != 1 || strings.TrimSpace(filter.AuthIndices[0]) == "" {
		return usage.FastImpact{}, fmt.Errorf("fast impact requires exactly one Codex auth_index")
	}
	if options.Mode != "" && options.Mode != "tier" && options.Mode != "transition" {
		return usage.FastImpact{}, fmt.Errorf("invalid fast impact mode")
	}
	if options.Metric != "" && options.Metric != "visible_tps" && options.Metric != "end_to_end_tps" {
		return usage.FastImpact{}, fmt.Errorf("invalid fast impact metric")
	}
	if options.WindowMS < 0 || options.WindowMS > 30*60*1000 || options.AnchorMS < 0 {
		return usage.FastImpact{}, fmt.Errorf("invalid fast impact transition window")
	}
	for _, p := range filter.Providers {
		if p != "codex" {
			return usage.FastImpact{}, fmt.Errorf("fast impact supports only Codex")
		}
	}
	// 模型筛选在此分支专指实际模型，不改变其他 analytics 的请求模型语义。
	models := filter.Models
	filter.Models = nil
	where, args := analyticsWhere(filter)
	if len(models) > 0 {
		where += " and resolved_model in (" + strings.TrimRight(strings.Repeat("?,", len(models)), ",") + ")"
		for _, m := range models {
			args = append(args, m)
		}
	}
	rows, err := r.db.QueryContext(ctx, `select timestamp_ms,coalesce(request_id,''),model,coalesce(resolved_model,''),coalesce(nullif(auth_provider_snapshot,''),provider,''),coalesce(reasoning_effort,''),input_tokens,output_tokens,reasoning_tokens,cached_tokens,cache_read_tokens,latency_ms,ttft_ms,failed,coalesce(telemetry_json,'') from usage_events `+where+` order by timestamp_ms limit 100001`, args...)
	if err != nil {
		return usage.FastImpact{}, err
	}
	defer rows.Close()
	events := []usage.Event{}
	for rows.Next() {
		if len(events) >= 100000 {
			return usage.FastImpact{}, fmt.Errorf("fast impact exceeds 100000 matching events; narrow the time range")
		}
		var e usage.Event
		var raw string
		var latency, ttft sql.NullInt64
		var failed int
		if err = rows.Scan(&e.TimestampMS, &e.RequestID, &e.Model, &e.ResolvedModel, &e.Provider, &e.ReasoningEffort, &e.InputTokens, &e.OutputTokens, &e.ReasoningTokens, &e.CachedTokens, &e.CacheReadTokens, &latency, &ttft, &failed, &raw); err != nil {
			return usage.FastImpact{}, err
		}
		if e.Provider != "codex" {
			return usage.FastImpact{}, fmt.Errorf("selected account contains non-Codex or unidentified events")
		}
		if latency.Valid {
			e.LatencyMS = &latency.Int64
		}
		if ttft.Valid {
			e.TTFTMS = &ttft.Int64
		}
		e.Failed = failed != 0
		e.Telemetry = usage.TelemetryFromJSON(raw)
		events = append(events, e)
	}
	if err = rows.Err(); err != nil {
		return usage.FastImpact{}, err
	}
	if err = ctx.Err(); err != nil {
		return usage.FastImpact{}, err
	}
	return usage.BuildFastImpact(events, filter.FromMS, filter.ToMS, options), nil
}
