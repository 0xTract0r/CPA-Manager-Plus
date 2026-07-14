package usageevent

import (
	"context"
	"path/filepath"
	"slices"
	"testing"
	"time"

	sqliterepo "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/repository/sqlite"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/usage"
)

// TestAnalyticsWhereMaxCacheHitRateProviderAwareDenominator 直接对 repository 层
// EventsPageWithFilter/EventsCountWithFilter 校验 G2b "低命中率全量筛" 的 SQL 条件,
// 与前端 monitoringCenterPageModel.ts:computeCacheHitRate 逐字对齐:
//   - Anthropic 系(model slug 以 claude/anthropic 开头,含 provider/ 前缀形式):
//     分母 = input_tokens + cache_read_tokens + cache_creation_tokens
//   - 非 Anthropic 系(如 gpt-*): 分母 = max(input_tokens, 命中tokens) + cache_creation_tokens
//   - 分母 <= 0 的行必须被排除(命中率不可计算,对齐前端 rate === null 隐藏该行)
//   - 命中率恰好等于阈值的行不入选(阈值判定是严格小于)
func TestAnalyticsWhereMaxCacheHitRateProviderAwareDenominator(t *testing.T) {
	db, err := sqliterepo.Open(filepath.Join(t.TempDir(), "usage.sqlite"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	repo := New(db)
	base := time.Date(2026, time.February, 1, 9, 0, 0, 0, time.UTC)
	ts := func(offsetSeconds int) int64 {
		return base.Add(time.Duration(offsetSeconds) * time.Second).UnixMilli()
	}

	events := []usage.Event{
		// Anthropic 系, 低命中率: denom = 100 + 0 + 0 = 100, hit = 0 (无 cache_read, 无 cached_tokens 回退) -> rate = 0
		{
			EventHash: "claude-low", TimestampMS: ts(1), Timestamp: base.Format(time.RFC3339Nano),
			Model: "claude-3-5-sonnet", InputTokens: 100, OutputTokens: 5, TotalTokens: 105, CreatedAtMS: ts(1),
		},
		// Anthropic 系(provider/model 形式), 高命中率: denom = 100+400+0 = 500, hit = 400 -> rate = 0.8
		{
			EventHash: "claude-high", TimestampMS: ts(2), Timestamp: base.Format(time.RFC3339Nano),
			Model: "anthropic/claude-3-opus", InputTokens: 100, OutputTokens: 5, CacheReadTokens: 400, TotalTokens: 505, CreatedAtMS: ts(2),
		},
		// 非 Anthropic 系, 低命中率: denom = max(100,10)+0 = 100, hit = 10 -> rate = 0.1
		{
			EventHash: "gpt-low", TimestampMS: ts(3), Timestamp: base.Format(time.RFC3339Nano),
			Model: "gpt-5.6-sol", InputTokens: 100, OutputTokens: 5, CacheReadTokens: 10, TotalTokens: 115, CreatedAtMS: ts(3),
		},
		// 非 Anthropic 系, 高命中率: denom = max(100,90)+0 = 100, hit = 90 -> rate = 0.9
		{
			EventHash: "gpt-high", TimestampMS: ts(4), Timestamp: base.Format(time.RFC3339Nano),
			Model: "gpt-5.6-sol", InputTokens: 100, OutputTokens: 5, CacheReadTokens: 90, TotalTokens: 195, CreatedAtMS: ts(4),
		},
		// 分母为 0: input=0, 无 cache_read/cache_creation, 无命中 tokens -> 命中率不可计算, 必须排除
		{
			EventHash: "zero-denom", TimestampMS: ts(5), Timestamp: base.Format(time.RFC3339Nano),
			Model: "gpt-5.6-sol", InputTokens: 0, OutputTokens: 0, TotalTokens: 0, CreatedAtMS: ts(5),
		},
		// 边界: 非 Anthropic 系, 命中率恰好等于阈值 0.5 (denom=max(100,50)+0=100, hit=50 -> rate=0.5),
		// 阈值判定是严格小于, 恰好相等不应入选。
		{
			EventHash: "boundary-equal", TimestampMS: ts(6), Timestamp: base.Format(time.RFC3339Nano),
			Model: "gpt-5.6-sol", InputTokens: 100, OutputTokens: 5, CacheReadTokens: 50, TotalTokens: 155, CreatedAtMS: ts(6),
		},
	}
	if _, err := repo.InsertBatch(context.Background(), events); err != nil {
		t.Fatalf("insert events: %v", err)
	}

	threshold := 0.5
	filter := AnalyticsFilter{
		FromMS:          base.UnixMilli(),
		ToMS:            base.Add(time.Hour).UnixMilli(),
		MaxCacheHitRate: &threshold,
	}

	total, err := repo.EventsCountWithFilter(context.Background(), filter)
	if err != nil {
		t.Fatalf("events count: %v", err)
	}
	if total != 2 {
		t.Fatalf("events count = %d, want 2 (claude-low + gpt-low)", total)
	}

	page, err := repo.EventsPageWithFilter(context.Background(), filter, 0, 0, 50)
	if err != nil {
		t.Fatalf("events page: %v", err)
	}
	if int64(len(page.Items)) != total {
		t.Fatalf("page item count = %d, want to match total_count = %d (analyticsWhere shared by count and page)", len(page.Items), total)
	}
	gotHashes := make([]string, 0, len(page.Items))
	for _, item := range page.Items {
		gotHashes = append(gotHashes, item.EventHash)
	}
	if !slices.Contains(gotHashes, "claude-low") || !slices.Contains(gotHashes, "gpt-low") {
		t.Fatalf("expected low cache hit rate events for both providers, got %#v", gotHashes)
	}
	if slices.Contains(gotHashes, "zero-denom") {
		t.Fatalf("zero-denominator event must be excluded, got %#v", gotHashes)
	}
	if slices.Contains(gotHashes, "boundary-equal") {
		t.Fatalf("event with rate exactly at threshold must be excluded (strict less-than), got %#v", gotHashes)
	}
	if slices.Contains(gotHashes, "claude-high") || slices.Contains(gotHashes, "gpt-high") {
		t.Fatalf("high cache hit rate events must be excluded, got %#v", gotHashes)
	}
}

// TestAnalyticsWhereMaxCacheHitRateNilMeansUnfiltered 确认 MaxCacheHitRate 为 nil(默认值)
// 时不改变既有行为,不会误伤未启用该筛选的既有调用方。
func TestAnalyticsWhereMaxCacheHitRateNilMeansUnfiltered(t *testing.T) {
	db, err := sqliterepo.Open(filepath.Join(t.TempDir(), "usage.sqlite"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	repo := New(db)
	base := time.Date(2026, time.February, 2, 9, 0, 0, 0, time.UTC)
	events := []usage.Event{
		{EventHash: "a", TimestampMS: base.UnixMilli(), Timestamp: base.Format(time.RFC3339Nano), Model: "gpt-5.6-sol", InputTokens: 100, TotalTokens: 100, CreatedAtMS: base.UnixMilli()},
		{EventHash: "b", TimestampMS: base.Add(time.Second).UnixMilli(), Timestamp: base.Format(time.RFC3339Nano), Model: "claude-3-5-sonnet", InputTokens: 0, TotalTokens: 0, CreatedAtMS: base.Add(time.Second).UnixMilli()},
	}
	if _, err := repo.InsertBatch(context.Background(), events); err != nil {
		t.Fatalf("insert events: %v", err)
	}

	filter := AnalyticsFilter{FromMS: base.UnixMilli(), ToMS: base.Add(time.Hour).UnixMilli()}
	total, err := repo.EventsCountWithFilter(context.Background(), filter)
	if err != nil {
		t.Fatalf("events count: %v", err)
	}
	if total != 2 {
		t.Fatalf("events count = %d, want 2 when MaxCacheHitRate is nil (no filtering)", total)
	}
}
