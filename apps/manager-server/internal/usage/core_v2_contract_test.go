package usage_test

import (
	"encoding/json"
	"math"
	"testing"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/model"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/pricing"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/usage"
)

// 合成样本沿用 core sdk/cliproxy/usage/accounting_test.go 与 redisqueue/plugin.go
// 的 v2 queue wire schema。core 保留原始 tokens.input_tokens，不能从字段名或模型猜包含关系。
func TestCoreV2QueueAccountingContract(t *testing.T) {
	for _, tc := range []struct {
		name, provider, executor, modelName                               string
		rawInput, rawOutput, reasoning, read, write, inputTotal, uncached int64
		mode                                                              string
		cost                                                              float64
	}{
		{"claude separate cache", "anthropic", "ClaudeExecutor", "claude-sonnet", 30, 5, 0, 7, 13, 50, 30, usage.CacheInputModeSeparate, 0.000126},
		{"openai compatibility executor overrides provider", "anthropic", "OpenAICompatExecutor", "claude-label", 100, 30, 12, 40, 10, 100, 50, usage.CacheInputModeIncluded, 0.000290},
		{"core explicit canonical proof overrides provider heuristic", "anthropic", "executorAdapter", "claude-label", 100, 30, 12, 40, 10, 100, 50, usage.CacheInputModeIncluded, 0.000290},
		{"core explicit canonical proof overrides model heuristic", "custom", "executorAdapter", "gpt-label", 30, 5, 0, 7, 13, 50, 30, usage.CacheInputModeSeparate, 0.000126},
	} {
		t.Run(tc.name, func(t *testing.T) {
			total := tc.inputTotal + tc.rawOutput
			payload := map[string]any{
				"timestamp": "2026-10-23T00:00:00Z", "request_id": tc.name,
				"provider": tc.provider, "executor_type": tc.executor, "model": tc.modelName,
				"tokens":             map[string]any{"input_tokens": tc.rawInput, "output_tokens": tc.rawOutput, "reasoning_tokens": tc.reasoning, "cached_tokens": tc.read, "cache_read_tokens": tc.read, "cache_creation_tokens": tc.write, "total_tokens": total},
				"accounting_version": 2,
				"token_breakdown": map[string]any{
					"schema_version": 2, "quality": "complete", "total_tokens": total, "unclassified_tokens": 0,
					"input":  map[string]any{"total_tokens": tc.inputTotal, "uncached_tokens": tc.uncached, "cache_read_tokens": tc.read, "cache_write_tokens": tc.write},
					"output": map[string]any{"total_tokens": tc.rawOutput, "non_reasoning_tokens": tc.rawOutput - tc.reasoning, "reasoning_tokens": tc.reasoning},
				},
				"telemetry": map[string]any{"version": 2, "attempt_id": tc.name, "fast_context": map[string]any{"schema_version": 1, "upstream_request_service_tier": "default", "tier_source": "default", "request_kind": "serving"}},
			}
			raw, err := json.Marshal(payload)
			if err != nil {
				t.Fatal(err)
			}
			event, err := usage.NormalizeRaw(raw)
			if err != nil {
				t.Fatal(err)
			}
			if event.InputTokens != tc.rawInput || event.OutputTokens != tc.rawOutput || event.TotalTokens != total {
				t.Fatalf("legacy counters changed: %+v", event)
			}
			if event.CacheInputMode != tc.mode || event.NormalizedTotalInputTokens != tc.inputTotal || event.NormalizedUncachedInputTokens != tc.uncached || event.NormalizedCacheReadTokens != tc.read || event.NormalizedCacheCreationTokens != tc.write {
				t.Fatalf("canonical accounting ignored: mode=%s normalized=%d/%d/%d/%d want=%s %d/%d/%d/%d", event.CacheInputMode, event.NormalizedTotalInputTokens, event.NormalizedUncachedInputTokens, event.NormalizedCacheReadTokens, event.NormalizedCacheCreationTokens, tc.mode, tc.inputTotal, tc.uncached, tc.read, tc.write)
			}
			if event.Telemetry == nil || event.Telemetry.AttemptID != tc.name || event.Telemetry.FastContext == nil {
				t.Fatalf("fork telemetry lost: %+v", event.Telemetry)
			}
			cost := pricing.CostForModel("fixture", pricing.ModelTokens{InputTokens: event.NormalizedTotalInputTokens, OutputTokens: event.OutputTokens, CacheReadTokens: event.NormalizedCacheReadTokens, CacheCreationTokens: event.NormalizedCacheCreationTokens}, map[string]model.ModelPrice{"fixture": {Prompt: 2, Completion: 4, CacheRead: 1, CacheReadConfigured: true, CacheCreation: 3, CacheCreationConfigured: true}})
			if math.Abs(cost-tc.cost) > 1e-12 {
				t.Fatalf("cost=%v want=%v", cost, tc.cost)
			}
			var persisted map[string]any
			if err := json.Unmarshal([]byte(event.RawJSON), &persisted); err != nil {
				t.Fatal(err)
			}
			if persisted["accounting_version"] != float64(2) || persisted["token_breakdown"] == nil {
				t.Fatal("canonical provenance was discarded")
			}
		})
	}
}

func TestCoreLegacyQueueKeepsSeparateClaudeAccounting(t *testing.T) {
	event, err := usage.NormalizeRaw([]byte(`{"timestamp":"2026-10-23T00:00:00Z","provider":"anthropic","executor_type":"ClaudeExecutor","model":"claude-sonnet","tokens":{"input_tokens":30,"output_tokens":5,"cache_read_tokens":7,"cache_creation_tokens":13,"total_tokens":55}}`))
	if err != nil {
		t.Fatal(err)
	}
	if event.InputTokens != 30 || event.NormalizedTotalInputTokens != 50 || event.NormalizedUncachedInputTokens != 30 || event.TotalTokens != 55 {
		t.Fatalf("legacy fixture regressed: %+v", event)
	}
}

// 不完整 proof 不成为权威计量：兼容旧估算但必须保留质量标记/原始输入供追溯。
func TestCoreV2InvalidProofKeepsLegacyEstimateAndProvenance(t *testing.T) {
	for _, tc := range []struct {
		name   string
		mutate func(map[string]any)
	}{
		{"unclassified", func(b map[string]any) { b["quality"] = "unclassified"; b["unclassified_tokens"] = 20 }},
		{"inconsistent", func(b map[string]any) { b["quality"] = "inconsistent" }},
		{"unsupported quality", func(b map[string]any) { b["quality"] = "exact" }},
		{"malformed bucket", func(b map[string]any) { b["input"].(map[string]any)["uncached_tokens"] = "30" }},
		{"inconsistent sum", func(b map[string]any) { b["input"].(map[string]any)["total_tokens"] = 51 }},
		{"raw counter mismatch", func(b map[string]any) {
			b["input"].(map[string]any)["cache_read_tokens"] = 8
			b["input"].(map[string]any)["uncached_tokens"] = 29
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			payload := map[string]any{
				"timestamp": "2026-10-23T00:00:00Z", "provider": "openai", "model": "gpt-label", "accounting_version": 2,
				"tokens": map[string]any{"input_tokens": 30, "output_tokens": 5, "cache_read_tokens": 7, "cache_creation_tokens": 13, "total_tokens": 55},
				"token_breakdown": map[string]any{"schema_version": 2, "quality": "complete", "total_tokens": 55, "unclassified_tokens": 0,
					"input":  map[string]any{"total_tokens": 50, "uncached_tokens": 30, "cache_read_tokens": 7, "cache_write_tokens": 13},
					"output": map[string]any{"total_tokens": 5, "non_reasoning_tokens": 5, "reasoning_tokens": 0}},
				"telemetry": map[string]any{"version": 2, "attempt_id": tc.name},
			}
			tc.mutate(payload["token_breakdown"].(map[string]any))
			raw, err := json.Marshal(payload)
			if err != nil {
				t.Fatal(err)
			}
			event, err := usage.NormalizeRaw(raw)
			if err != nil {
				t.Fatal(err)
			}
			if event.CacheInputMode != usage.CacheInputModeIncluded || event.NormalizedTotalInputTokens != 30 || event.NormalizedUncachedInputTokens != 10 || event.TotalTokens != 55 {
				t.Fatalf("invalid proof replaced legacy estimate: %+v", event)
			}
			if event.Telemetry == nil || event.Telemetry.AttemptID != tc.name {
				t.Fatal("fallback lost telemetry")
			}
			var persisted map[string]any
			if err := json.Unmarshal([]byte(event.RawJSON), &persisted); err != nil {
				t.Fatal(err)
			}
			got, _ := json.Marshal(persisted["token_breakdown"])
			want, _ := json.Marshal(payload["token_breakdown"])
			if string(got) != string(want) {
				t.Fatalf("proof provenance changed: %s != %s", got, want)
			}
		})
	}
}
