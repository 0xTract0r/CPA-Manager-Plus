package pricing

import (
	"math"
	"testing"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/model"
)

func TestCostForModelSeparatesCachedInputTokens(t *testing.T) {
	prices := map[string]model.ModelPrice{
		"gpt-cached": {Prompt: 2, Completion: 4, Cache: 1},
	}

	cost := CostForModel("gpt-cached", ModelTokens{
		InputTokens:  1_000_000,
		OutputTokens: 500_000,
		CachedTokens: 250_000,
	}, prices)

	if math.Abs(cost-3.75) > 0.000001 {
		t.Fatalf("cost = %v, want 3.75", cost)
	}
}

func TestCostForModelDoesNotCreateNegativePromptCost(t *testing.T) {
	prices := map[string]model.ModelPrice{
		"gpt-cached": {Prompt: 10, Cache: 1},
	}

	cost := CostForModel("gpt-cached", ModelTokens{
		InputTokens:  100_000,
		CachedTokens: 250_000,
	}, prices)

	if math.Abs(cost-0.25) > 0.000001 {
		t.Fatalf("cost = %v, want 0.25", cost)
	}
}

func TestCostForModelPricesFineGrainedCacheOutsideInput(t *testing.T) {
	prices := map[string]model.ModelPrice{
		"claude-cached": {Prompt: 2, Completion: 4, Cache: 1, CacheRead: 1, CacheCreation: 3},
	}

	// InputTokens as reported by the ingest pipeline includes the fine-grained
	// cache_read/cache_creation buckets. Here 2_600_000 = 500_000 uncached +
	// 2_000_000 cache_read + 100_000 cache_creation. Cost must charge the 500_000
	// uncached prompt at the full rate and each cache bucket exactly once.
	cost := CostForModel("claude-cached", ModelTokens{
		InputTokens:         2_600_000,
		OutputTokens:        250_000,
		CachedTokens:        0,
		CacheReadTokens:     2_000_000,
		CacheCreationTokens: 100_000,
	}, prices)

	// 0.5M*2 + 0.25M*4 + 2M*1 + 0.1M*3 = 1 + 1 + 2 + 0.3 = 4.3
	if math.Abs(cost-4.3) > 0.000001 {
		t.Fatalf("cost = %v, want 4.3", cost)
	}
}

func TestCostForModelPricesResidualCompatCachedWithFineGrainedCache(t *testing.T) {
	prices := map[string]model.ModelPrice{
		"mixed-cache": {Prompt: 2, Completion: 4, Cache: 1, CacheRead: 0.5, CacheCreation: 3},
	}

	// InputTokens (1_400_000) includes residual compat cached (100_000),
	// cache_read (200_000) and cache_creation (100_000); the remaining
	// 1_000_000 is uncached prompt.
	cost := CostForModel("mixed-cache", ModelTokens{
		InputTokens:         1_400_000,
		CachedTokens:        100_000,
		CacheReadTokens:     200_000,
		CacheCreationTokens: 100_000,
	}, prices)

	// 1M*2 + 0.1M*1 + 0.2M*0.5 + 0.1M*3 = 2 + 0.1 + 0.1 + 0.3 = 2.5
	if math.Abs(cost-2.5) > 0.000001 {
		t.Fatalf("cost = %v, want 2.5", cost)
	}
}

// TestCostForModelDoesNotDoubleCountCacheRead pins the gpt-5.5 billing bug:
// InputTokens reported by CPA includes the cache_read portion. The old formula
// charged the whole input at the full prompt rate AND charged cache_read again
// at the discounted rate, roughly 4x-ing real cost in the dashboard. The fix
// subtracts cache_read (and cache_creation) from input first so each token is
// billed exactly once.
func TestCostForModelDoesNotDoubleCountCacheRead(t *testing.T) {
	// gpt-5.5 official rates (per 1M): prompt 1.25, completion 10,
	// cache read 0.125 (10% of prompt).
	prices := map[string]model.ModelPrice{
		"gpt-5.5": {Prompt: 1.25, Completion: 10, Cache: 0.125, CacheRead: 0.125, CacheReadConfigured: true},
	}

	// Real ingest shape: input_tokens (1_000_000) already contains the
	// cache_read tokens (800_000); only 200_000 are uncached prompt.
	withCacheRead := CostForModel("gpt-5.5", ModelTokens{
		InputTokens:     1_000_000,
		OutputTokens:    50_000,
		CacheReadTokens: 800_000,
	}, prices)

	// Correct: 0.2M*1.25 + 0.05M*10 + 0.8M*0.125 = 0.25 + 0.5 + 0.1 = 0.85.
	// The old double-counting formula returned 1.85 (0.8M charged at both the
	// full 1.25 rate inside input and again at 0.125).
	if math.Abs(withCacheRead-0.85) > 0.000001 {
		t.Fatalf("cost with cache_read = %v, want 0.85 (double-count would be 1.85)", withCacheRead)
	}

	// Explicit non-double-count check: with cache_read = 0, the same 200_000
	// uncached prompt (input dropped to what remains after cache is removed)
	// plus output must equal the withCacheRead cost minus exactly the discounted
	// cache_read charge, never the full-rate charge.
	noCacheRead := CostForModel("gpt-5.5", ModelTokens{
		InputTokens:  200_000,
		OutputTokens: 50_000,
	}, prices)
	if math.Abs(noCacheRead-0.75) > 0.000001 {
		t.Fatalf("cost without cache_read = %v, want 0.75", noCacheRead)
	}

	// The only delta between the two must be the cache_read tokens priced once
	// at the discounted cache-read rate: 800_000 * 0.125 / 1e6 = 0.1.
	delta := withCacheRead - noCacheRead
	if math.Abs(delta-0.1) > 0.000001 {
		t.Fatalf("cache_read delta = %v, want 0.1 (discounted rate only, no full-rate double charge)", delta)
	}
}

func TestServiceTierMultiplier(t *testing.T) {
	tests := []struct {
		name        string
		model       string
		serviceTier string
		want        float64
	}{
		{name: "gpt-5.4 default", model: "gpt-5.4", serviceTier: "default", want: 1},
		{name: "gpt-5.6 priority", model: "gpt-5.6-sol", serviceTier: "priority", want: 2},
		{name: "namespaced gpt-5.6 fast", model: "openai/gpt-5.6-terra", serviceTier: "fast", want: 2},
		{name: "gpt-5.4 priority", model: "gpt-5.4", serviceTier: "priority", want: 2},
		{name: "gpt-5.4 fast", model: "gpt-5.4", serviceTier: "fast", want: 2},
		{name: "gpt-5.4 mini priority", model: "gpt-5.4-mini", serviceTier: "priority", want: 2},
		{name: "gpt-5.5 priority", model: "gpt-5.5", serviceTier: "priority", want: 2.5},
		{name: "gpt-5.3 codex priority", model: "gpt-5.3-codex", serviceTier: "priority", want: 2},
		{name: "unknown tier", model: "gpt-5.4", serviceTier: "accelerated", want: 1},
		{name: "unknown priority model", model: "gpt-unknown", serviceTier: "priority", want: 1},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ServiceTierMultiplier(tt.model, tt.serviceTier)
			if got != tt.want {
				t.Fatalf("ServiceTierMultiplier(%q, %q) = %v, want %v", tt.model, tt.serviceTier, got, tt.want)
			}
		})
	}
}

func TestCostForGPT56UsesOfficialFallbackPrice(t *testing.T) {
	cost := CostForModel("openai/gpt-5.6-sol", ModelTokens{
		InputTokens:         1_000_000,
		OutputTokens:        100_000,
		CachedTokens:        100_000,
		CacheReadTokens:     200_000,
		CacheCreationTokens: 100_000,
	}, nil)

	if math.Abs(cost-6.775) > 0.000001 {
		t.Fatalf("fallback cost = %v, want 6.775", cost)
	}
}

func TestCostForGPT56PrefersConfiguredBasePrice(t *testing.T) {
	prices := map[string]model.ModelPrice{
		"gpt-5.6-sol": {Prompt: 9, Completion: 18},
	}

	cost := CostForModel("gpt-5.6-sol", ModelTokens{InputTokens: 1_000_000}, prices)
	if math.Abs(cost-9) > 0.000001 {
		t.Fatalf("configured cost = %v, want 9", cost)
	}
}

func TestCostForGPT56AppliesLongContextMultipliers(t *testing.T) {
	tokens := ModelTokens{
		InputTokens:             1_000_000,
		OutputTokens:            100_000,
		CacheReadTokens:         200_000,
		CacheCreationTokens:     100_000,
		LongInputTokens:         1_000_000,
		LongOutputTokens:        100_000,
		LongCacheReadTokens:     200_000,
		LongCacheCreationTokens: 100_000,
	}

	cost := CostForModel("gpt-5.6-sol", tokens, nil)
	if math.Abs(cost-12.95) > 0.000001 {
		t.Fatalf("long-context cost = %v, want 12.95", cost)
	}
}

func TestCostForGPT56KeepsExactly272KAtStandardRates(t *testing.T) {
	cost := CostForModel("gpt-5.6-luna", ModelTokens{
		InputTokens:  272_000,
		OutputTokens: 100_000,
	}, nil)

	if math.Abs(cost-0.872) > 0.000001 {
		t.Fatalf("272K cost = %v, want 0.872", cost)
	}
}

func TestCostForGPT56UsesPromptRatiosWhenCachePricesAreMissing(t *testing.T) {
	prices := map[string]model.ModelPrice{
		"gpt-5.6-terra": {Prompt: 10, Completion: 20, Cache: 10},
	}
	cost := CostForModelWithServiceTier("gpt-5.6-terra", "priority", ModelTokens{
		InputTokens:         1_000_000,
		CacheReadTokens:     200_000,
		CacheCreationTokens: 100_000,
	}, prices)

	if math.Abs(cost-16.9) > 0.000001 {
		t.Fatalf("priority fallback-ratio cost = %v, want 16.9", cost)
	}
}

func TestCostForGPT56RespectsExplicitZeroPrices(t *testing.T) {
	prices := map[string]model.ModelPrice{
		"gpt-5.6-sol": {
			PromptConfigured: true, CompletionConfigured: true, CacheReadConfigured: true, CacheCreationConfigured: true,
		},
	}
	cost := CostForModel("gpt-5.6-sol", ModelTokens{
		InputTokens:         1_000_000,
		OutputTokens:        100_000,
		CacheReadTokens:     200_000,
		CacheCreationTokens: 100_000,
	}, prices)

	if cost != 0 {
		t.Fatalf("explicit-zero cost = %v, want 0", cost)
	}
}

func TestCostForGPT56AliasPriceUsesResolvedModelBehavior(t *testing.T) {
	prices := map[string]model.ModelPrice{
		"internal-fast": {Prompt: 2, Completion: 4},
	}
	cost := CostForModelCandidatesWithServiceTier(
		[]string{"openai/gpt-5.6-luna", "internal-fast"},
		"default",
		ModelTokens{
			InputTokens:         1_000_000,
			CacheReadTokens:     200_000,
			CacheCreationTokens: 100_000,
		},
		prices,
	)

	if math.Abs(cost-1.69) > 0.000001 {
		t.Fatalf("alias cost = %v, want 1.69", cost)
	}
}

func TestCostForModelCandidatesKeepsResolvedNonGPTBehavior(t *testing.T) {
	prices := map[string]model.ModelPrice{
		"resolved-other": {Prompt: 2, Completion: 4},
	}
	cost := CostForModelCandidatesWithServiceTier(
		[]string{"resolved-other", "gpt-5.6-sol"},
		"priority",
		ModelTokens{InputTokens: 1_000_000, LongInputTokens: 1_000_000},
		prices,
	)

	if math.Abs(cost-2) > 0.000001 {
		t.Fatalf("resolved non-GPT cost = %v, want 2", cost)
	}
}

func TestCostForModelWithServiceTier(t *testing.T) {
	prices := map[string]model.ModelPrice{
		"gpt-5.4": {Prompt: 2.5, Completion: 5, Cache: 1},
	}

	tokens := ModelTokens{InputTokens: 1_000_000}
	if cost := CostForModelWithServiceTier("gpt-5.4", "default", tokens, prices); math.Abs(cost-2.5) > 0.000001 {
		t.Fatalf("default cost = %v, want 2.5", cost)
	}
	if cost := CostForModelWithServiceTier("gpt-5.4", "priority", tokens, prices); math.Abs(cost-5) > 0.000001 {
		t.Fatalf("priority cost = %v, want 5", cost)
	}
	if cost := CostForModelWithServiceTier("missing-model", "priority", tokens, prices); cost != 0 {
		t.Fatalf("missing model cost = %v, want 0", cost)
	}
}

func TestCostForModelCandidatesWithServiceTierFallsBackToRequestedModel(t *testing.T) {
	prices := map[string]model.ModelPrice{
		"gpt-5.4": {Prompt: 2.5, Completion: 5, Cache: 1},
	}

	cost := CostForModelCandidatesWithServiceTier(
		[]string{"missing-upstream", "gpt-5.4"},
		"priority",
		ModelTokens{InputTokens: 1_000_000},
		prices,
	)

	if math.Abs(cost-2.5) > 0.000001 {
		t.Fatalf("fallback cost = %v, want 2.5", cost)
	}
}

func TestCostForModelCandidatesWithServiceTierPrefersResolvedModel(t *testing.T) {
	prices := map[string]model.ModelPrice{
		"gpt-resolved": {Prompt: 1, Completion: 2, Cache: 0.5},
		"gpt-5.4":      {Prompt: 2.5, Completion: 5, Cache: 1},
	}

	cost := CostForModelCandidatesWithServiceTier(
		[]string{"gpt-resolved", "gpt-5.4"},
		"priority",
		ModelTokens{InputTokens: 1_000_000},
		prices,
	)

	if math.Abs(cost-1) > 0.000001 {
		t.Fatalf("resolved cost = %v, want 1", cost)
	}
}

func TestCostForModelWithServiceTierPreservesCacheBuckets(t *testing.T) {
	prices := map[string]model.ModelPrice{
		"gpt-5.4": {Prompt: 2, Completion: 4, Cache: 1, CacheRead: 0.5, CacheCreation: 3},
	}

	// InputTokens (1_400_000) includes cached/cache_read/cache_creation; the
	// remaining 1_000_000 is uncached prompt. Base cost 2.5, gpt-5.4 priority x2.
	cost := CostForModelWithServiceTier("gpt-5.4", "priority", ModelTokens{
		InputTokens:         1_400_000,
		CachedTokens:        100_000,
		CacheReadTokens:     200_000,
		CacheCreationTokens: 100_000,
	}, prices)

	// base = 1M*2 + 0.1M*1 + 0.2M*0.5 + 0.1M*3 = 2.5; gpt-5.4 priority x2 = 5
	if math.Abs(cost-5) > 0.000001 {
		t.Fatalf("priority cache cost = %v, want 5", cost)
	}
}
