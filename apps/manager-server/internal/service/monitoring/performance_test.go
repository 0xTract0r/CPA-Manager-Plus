package monitoring

import (
	"context"
	"encoding/json"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/usage"
	"math"
	"strings"
	"testing"
)

func TestPerformanceFullScopeTelemetryAndRequestFilter(t *testing.T) {
	db := newMonitoringTestStore(t)
	ctx := context.Background()
	from := int64(1778000000000)
	lat := int64(1000)
	slow := int64(2000)
	zero := int64(0)
	includeFailed := true
	if err := db.SaveModelPrices(ctx, map[string]store.ModelPrice{"model-a": {Prompt: 1, Completion: 2}}); err != nil {
		t.Fatal(err)
	}
	a := monitoringEvent("perf-a", from+1000, "model-a", "account", "source", false, 10, 100, 0, 0, 110, &lat)
	a.RequestID = "req-1"
	a.TTFTMS = &lat
	a.Telemetry = &usage.Telemetry{Version: 1, AttemptID: "attempt-a", RequestID: "req-1", StartedAtMS: from + 1000, EndedAtMS: from + 2000, Transport: "http"}
	b := monitoringEvent("perf-b", from+1100, "model-a", "account", "source", false, 20, 100, 0, 0, 120, &slow)
	b.RequestID = "req-1"
	b.Telemetry = &usage.Telemetry{Version: 1, AttemptID: "attempt-b", RequestID: "req-1", StartedAtMS: from + 1100, EndedAtMS: from + 3100, FailureKind: "timeout"}
	c := monitoringEvent("perf-c", from+1200, "model-b", "account", "source", true, 0, 0, 0, 0, 0, &zero)
	c.FailStatusCode = 429
	c.RequestID = "req-2"
	split := a
	split.EventHash = "perf-split"
	split.Model = "model-split"
	outside := a
	outside.EventHash = "perf-outside"
	outside.TimestampMS = from + 10000
	if _, err := db.InsertEvents(ctx, []usage.Event{a, b, c, split, outside}); err != nil {
		t.Fatal(err)
	}
	req := Request{FromMS: from, ToMS: from + 10000, Filters: Filters{IncludeFailed: &includeFailed}, Include: Include{Performance: true, EventsPage: &EventsPage{Limit: 1}}}
	resp, err := New(db).Analytics(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	p := resp.Performance
	if p == nil || p.Summary.TotalCalls != 4 || len(p.Models) != 3 {
		t.Fatalf("performance=%+v", p)
	}
	if p.Summary.LatencyMS.Samples != 3 || p.Summary.LatencyMS.Eligible != 4 || p.Summary.TotalTPS.Samples != 3 || p.Summary.TotalTPS.Eligible != 3 || *p.Summary.TotalTPS.P10 != 50 || *p.Summary.TotalTPS.P95 != 100 {
		t.Fatalf("metrics=%+v", p.Summary)
	}
	if p.Summary.ObservedPeakConcurrency != 2 || p.Summary.ObservedAttempts != 2 || p.Summary.LinkedRequests != 1 || p.Summary.RetriedRequests != 1 || p.Summary.RateLimitedCalls != 1 {
		t.Fatalf("association=%+v", p.Summary)
	}
	if math.Abs(p.Summary.EstimatedCost-0.00043) > 1e-12 {
		t.Fatalf("cost=%v", p.Summary.EstimatedCost)
	}
	if p.Summary.RequestsPerMinute != 24 || p.Summary.OutputTokensPerSecond != 30 {
		t.Fatalf("throughput=%+v", p.Summary)
	}
	req.Filters.RequestIDs = []string{"req-1"}
	req.Filters.Models = []string{"model-a"}
	req.Include.EventsPage.Limit = 20
	resp, err = New(db).Analytics(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Performance.Summary.TotalCalls != 2 || resp.Events.TotalCount != 2 || len(resp.Events.Items) != 2 {
		t.Fatalf("filtered=%+v", resp)
	}
	for _, item := range resp.Events.Items {
		if item.Telemetry == nil || item.Telemetry.AttemptID == "" {
			t.Fatalf("missing telemetry=%+v", item)
		}
	}
	raw, _ := json.Marshal(resp)
	if strings.Contains(string(raw), "raw_json") {
		t.Fatal("raw JSON exposed")
	}
	req.Filters.Models = []string{"missing"}
	resp, err = New(db).Analytics(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Performance.Summary.TotalTPS.Mean != nil || resp.Performance.Summary.LatencyMS.P95 != nil {
		t.Fatal("missing metrics must be null")
	}
	events, err := db.RecentEvents(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	var with int
	for _, e := range events {
		if e.Telemetry != nil {
			with++
		}
	}
	if with != 4 {
		t.Fatalf("persisted telemetry=%d", with)
	}
}

func TestPerformanceFirstResponseFromImportedTelemetry(t *testing.T) {
	db := newMonitoringTestStore(t)
	ctx := context.Background()
	from := int64(1778000000000)
	latency, firstBody, legacy := int64(10000), int64(1000), int64(500)
	a := monitoringEvent("import-first-body", from+1, "model", "account", "source", false, 10, 100, 0, 0, 110, &latency)
	a.Telemetry = &usage.Telemetry{Version: 1, AttemptID: "import-first-body", FirstBodyMS: &firstBody}
	b := a
	b.EventHash = "legacy-first-body"
	b.Telemetry = &usage.Telemetry{Version: 1, AttemptID: "legacy-first-body", FirstBodyMS: &firstBody}
	b.TTFTMS = &legacy
	if _, err := db.InsertEvents(ctx, []usage.Event{a, b}); err != nil {
		t.Fatal(err)
	}
	response, err := New(db).Analytics(ctx, Request{FromMS: from, ToMS: from + 10000, Include: Include{Performance: true}})
	if err != nil {
		t.Fatal(err)
	}
	metric := response.Performance.Summary.TTFBMS
	if metric.Samples != 2 || metric.P95 == nil || *metric.P95 != 1000 || metric.Mean == nil || *metric.Mean != 750 {
		t.Fatalf("first response fallback changed existing samples or lost telemetry: %+v", metric)
	}
}

func TestPerformanceEmptyBucketsAndNearestRank(t *testing.T) {
	db := newMonitoringTestStore(t)
	ctx := context.Background()
	from := int64(1778000400000)
	latency := int64(1000)
	// 对齐UTC整点，两个样本间留一个空桶。
	from = from / 3600000 * 3600000
	a := monitoringEvent("gap-a", from+1000, "model", "auth", "source", false, 1, 10, 0, 0, 11, &latency)
	b := monitoringEvent("gap-b", from+7201000, "model", "auth", "source", false, 1, 20, 0, 0, 21, &latency)
	if _, err := db.InsertEvents(ctx, []usage.Event{a, b}); err != nil {
		t.Fatal(err)
	}
	resp, err := New(db).Analytics(ctx, Request{FromMS: from, ToMS: from + 10800000, Include: Include{Performance: true, Granularity: "hour"}})
	if err != nil {
		t.Fatal(err)
	}
	p := resp.Performance
	if len(p.Timeline) != 3 || p.Timeline[1].TotalTPS.Mean != nil || p.Timeline[1].TotalCalls != 0 {
		t.Fatalf("gap=%+v", p.Timeline)
	}
	if *p.Summary.TotalTPS.Mean != 15 || *p.Summary.TotalTPS.P50 != 10 || *p.Summary.TotalTPS.P99 != 20 {
		t.Fatalf("rank=%+v", p.Summary.TotalTPS)
	}
	if p.Timeline[0].RequestsPerMinute != float64(1)/60 {
		t.Fatalf("bucket RPM=%v", p.Timeline[0].RequestsPerMinute)
	}
}
