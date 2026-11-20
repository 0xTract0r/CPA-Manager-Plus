package monitoring

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/usage"
)

const creditsTestHour = int64(60 * 60 * 1000)

func creditsEvent(hash string, timestampMS int64, authFile string, authIndex string, headers map[string]any) usage.Event {
	return usage.Event{
		EventHash:        testCanonicalHash(hash),
		TimestampMS:      timestampMS,
		Timestamp:        time.UnixMilli(timestampMS).UTC().Format(time.RFC3339Nano),
		Model:            "gpt-5",
		Endpoint:         "POST /v1/responses",
		Method:           "POST",
		Path:             "/v1/responses",
		Provider:         "codex",
		AuthIndex:        authIndex,
		AuthFileSnapshot: authFile,
		AccountSnapshot:  "pro@example.com",
		CreatedAtMS:      timestampMS,
		ResponseMetadata: usage.ParseResponseHeaderMetadata(headers, time.UnixMilli(timestampMS)),
	}
}

func creditsHeaders(balance string, weeklyUsed string, weeklyResetMS int64) map[string]any {
	return map[string]any{
		"x-codex-credits-balance":          []any{balance},
		"x-codex-credits-has-credits":      []any{"true"},
		"x-codex-credits-unlimited":        []any{"false"},
		"x-codex-primary-used-percent":     []any{"20"},
		"x-codex-primary-window-minutes":   []any{"300"},
		"x-codex-secondary-used-percent":   []any{weeklyUsed},
		"x-codex-secondary-window-minutes": []any{"10080"},
		"x-codex-secondary-reset-at":       []any{fmt.Sprintf("%d", weeklyResetMS/1000)},
	}
}

func TestCreditsHistoryDedupesAndTrimsToWeeklyWindow(t *testing.T) {
	db := newMonitoringTestStore(t)
	ctx := context.Background()
	nowMS := int64(1_789_000_000_000)
	// 周窗口 4 天后重置 → 窗口开始于 3 天前；4 天前的旧点应被裁掉。
	weeklyResetMS := nowMS + 4*24*creditsTestHour
	windowStartMS := weeklyResetMS - 7*24*creditsTestHour

	events := []usage.Event{
		creditsEvent("old-window", windowStartMS-2*creditsTestHour, "codex-pro.json", "auth-1", creditsHeaders("70000", "10", weeklyResetMS-7*24*creditsTestHour)),
		creditsEvent("before-full", nowMS-20*creditsTestHour, "codex-pro.json", "auth-1", creditsHeaders("59897.48", "99", weeklyResetMS)),
		creditsEvent("full-1", nowMS-15*creditsTestHour, "codex-pro.json", "auth-1", creditsHeaders("59897.48", "100", weeklyResetMS)),
		creditsEvent("dup", nowMS-14*creditsTestHour, "codex-pro.json", "auth-1", creditsHeaders("59897.48", "100", weeklyResetMS)),
		creditsEvent("drop-1", nowMS-10*creditsTestHour, "codex-pro.json", "auth-1", creditsHeaders("58719", "100", weeklyResetMS)),
		creditsEvent("drop-2", nowMS-2*creditsTestHour, "codex-pro.json", "auth-1", creditsHeaders("56677", "100", weeklyResetMS)),
		creditsEvent("latest-same", nowMS-1*creditsTestHour, "codex-pro.json", "auth-1", creditsHeaders("56677", "100", weeklyResetMS)),
		// 没有积分信号的请求不应进入序列。
		creditsEvent("no-credits", nowMS-30*60*1000, "codex-pro.json", "auth-1", map[string]any{"x-codex-primary-used-percent": []any{"20"}}),
		// has_credits=false 的账号整体被忽略。
		creditsEvent("other-no-credits", nowMS-3*creditsTestHour, "codex-free.json", "auth-2", map[string]any{
			"x-codex-credits-balance":     []any{"0"},
			"x-codex-credits-has-credits": []any{"false"},
		}),
	}
	if _, err := db.InsertEvents(ctx, events); err != nil {
		t.Fatalf("insert events: %v", err)
	}

	resp, err := New(db).CreditsHistory(ctx, CreditsHistoryRequest{NowMS: nowMS})
	if err != nil {
		t.Fatalf("credits history: %v", err)
	}
	if resp.FromMS != nowMS-7*24*creditsTestHour || resp.ToMS != nowMS || resp.Truncated {
		t.Fatalf("range = %d..%d truncated=%v", resp.FromMS, resp.ToMS, resp.Truncated)
	}
	if len(resp.Items) != 1 {
		t.Fatalf("items = %#v", resp.Items)
	}
	item := resp.Items[0]
	if item.AccountKey != "codex-pro.json::auth-1" || item.Provider != "codex" {
		t.Fatalf("identity = %#v", item)
	}
	if item.WindowStartMS != windowStartMS {
		t.Fatalf("window start = %d, want %d", item.WindowStartMS, windowStartMS)
	}
	if item.QuotaResetAtMS != weeklyResetMS {
		t.Fatalf("quota reset = %d, want %d", item.QuotaResetAtMS, weeklyResetMS)
	}
	if item.LastSeenMS != nowMS-creditsTestHour || item.Unlimited {
		t.Fatalf("last seen / unlimited = %d %v", item.LastSeenMS, item.Unlimited)
	}
	want := []CreditsBalancePoint{
		{TimestampMS: nowMS - 20*creditsTestHour, Balance: 59897.48, QuotaExhausted: false},
		{TimestampMS: nowMS - 15*creditsTestHour, Balance: 59897.48, QuotaExhausted: true},
		{TimestampMS: nowMS - 10*creditsTestHour, Balance: 58719, QuotaExhausted: true},
		{TimestampMS: nowMS - 2*creditsTestHour, Balance: 56677, QuotaExhausted: true},
		{TimestampMS: nowMS - 1*creditsTestHour, Balance: 56677, QuotaExhausted: true},
	}
	if len(item.Points) != len(want) {
		t.Fatalf("points = %#v", item.Points)
	}
	for index, point := range want {
		if item.Points[index] != point {
			t.Fatalf("point %d = %#v, want %#v", index, item.Points[index], point)
		}
	}
}

func TestCreditsHistoryFallsBackToDaysWithoutWindowAndDownsamples(t *testing.T) {
	db := newMonitoringTestStore(t)
	ctx := context.Background()
	nowMS := int64(1_789_000_000_000)
	events := make([]usage.Event, 0, 400)
	for index := 0; index < 400; index++ {
		headers := map[string]any{
			"x-codex-credits-balance":     []any{fmt.Sprintf("%d", 80000-index*10)},
			"x-codex-credits-has-credits": []any{"true"},
		}
		events = append(events, creditsEvent(
			fmt.Sprintf("evt-%03d", index),
			nowMS-int64(400-index)*10*60*1000,
			"codex-plus.json",
			"auth-9",
			headers,
		))
	}
	// 超出回溯范围（8 天前）的点不应出现。
	events = append(events, creditsEvent("too-old", nowMS-8*24*creditsTestHour, "codex-plus.json", "auth-9", map[string]any{
		"x-codex-credits-balance":     []any{"99999"},
		"x-codex-credits-has-credits": []any{"true"},
	}))
	if _, err := db.InsertEvents(ctx, events); err != nil {
		t.Fatalf("insert events: %v", err)
	}

	resp, err := New(db).CreditsHistory(ctx, CreditsHistoryRequest{NowMS: nowMS, MaxPoints: 50})
	if err != nil {
		t.Fatalf("credits history: %v", err)
	}
	if len(resp.Items) != 1 {
		t.Fatalf("items = %#v", resp.Items)
	}
	points := resp.Items[0].Points
	if resp.Items[0].WindowStartMS != 0 || resp.Items[0].QuotaResetAtMS != 0 {
		t.Fatalf("window = %#v", resp.Items[0])
	}
	if len(points) > 50 || len(points) < 40 {
		t.Fatalf("downsampled len = %d", len(points))
	}
	if points[0].Balance != 80000 || points[len(points)-1].Balance != 80000-399*10 {
		t.Fatalf("first/last = %#v %#v", points[0], points[len(points)-1])
	}
	for index := 1; index < len(points); index++ {
		if points[index].TimestampMS <= points[index-1].TimestampMS {
			t.Fatalf("points not ascending at %d", index)
		}
	}
}

func TestDownsampleCreditsPointsKeepsFirstExhaustedPoint(t *testing.T) {
	points := make([]CreditsBalancePoint, 0, 100)
	for index := 0; index < 100; index++ {
		points = append(points, CreditsBalancePoint{
			TimestampMS:    int64(index),
			Balance:        float64(1000 - index),
			QuotaExhausted: index >= 37,
		})
	}
	sampled := downsampleCreditsPoints(points, 10)
	if len(sampled) > 10 {
		t.Fatalf("len = %d", len(sampled))
	}
	found := false
	for _, point := range sampled {
		if point.TimestampMS == 37 {
			found = true
		}
	}
	if !found || sampled[0].TimestampMS != 0 || sampled[len(sampled)-1].TimestampMS != 99 {
		t.Fatalf("sampled = %#v", sampled)
	}
}
