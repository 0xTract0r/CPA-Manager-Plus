package usage

import (
	"fmt"
	"math"
	"testing"
)

func fastTestPtr[T any](v T) *T { return &v }
func fastTestEvent(i int, model, tier string, tps int64) Event {
	enabled := tier == "priority"
	return Event{EventHash: fmt.Sprint(i), RequestID: fmt.Sprint(i), TimestampMS: int64(i+1) * 10000, Provider: "codex", Model: "alias", ResolvedModel: model, ReasoningEffort: "high", InputTokens: 20000, OutputTokens: 1000, ReasoningTokens: 0, CachedTokens: 18000, LatencyMS: fastTestPtr(int64(1000000/tps + 1000)), Telemetry: &Telemetry{Version: 2, AttemptID: fmt.Sprint(i), FastContext: &FastContext{SchemaVersion: 1, UpstreamRequestServiceTier: tier, ServerFastEnabled: &enabled, TierSource: "account", RequestKind: "serving"}, FirstVisibleContentMS: fastTestPtr(int64(1000)), LastVisibleContentMS: fastTestPtr(int64(1000000/tps + 1000)), VisibleContentEvents: fastTestPtr(int64(20)), VisibleContentObserved: true, OutputReasoningSubset: true, StreamCompleted: fastTestPtr(true)}}
}
func TestFastImpactModelsCohortsQuantilesAndMissing(t *testing.T) {
	var events []Event
	// 构造相反模型构成：每个模型均快一倍，混合汇总会得到错误结论。
	for i := 0; i < 25; i++ {
		events = append(events, fastTestEvent(i, "A", "default", 100), fastTestEvent(100+i, "B", "priority", 20))
	}
	for i := 0; i < 5; i++ {
		events = append(events, fastTestEvent(200+i, "A", "priority", 200), fastTestEvent(300+i, "B", "default", 10))
	}
	r := BuildFastImpact(events, 1, 9999999, FastImpactOptions{})
	if len(r.Models) != 2 || r.Scanned != 60 {
		t.Fatalf("result=%+v", r)
	}
	for _, m := range r.Models {
		if m.ChangePct == nil || math.Abs(*m.ChangePct-100) > 1e-9 || m.Status != "preliminary" {
			t.Fatalf("model=%+v", m)
		}
	}
	metric := fastMetric([]float64{10, 20, 30, 40})
	if *metric.P50 != 25 || *metric.P25 != 10 || *metric.P75 != 30 {
		t.Fatalf("quantiles=%+v", metric)
	}
	a, b := fastTestEvent(1, "C", "default", 20), fastTestEvent(2, "C", "priority", 40)
	r = BuildFastImpact([]Event{a, b}, 1, 999999, FastImpactOptions{})
	if r.Models[0].Status != "insufficient_samples" || r.Models[0].ChangePct != nil {
		t.Fatal("low sample fabricated change")
	}
	a.Telemetry = nil
	b.Telemetry.Version = 1
	b.Telemetry.FastContext = nil
	r = BuildFastImpact([]Event{a, b}, 1, 999999, FastImpactOptions{})
	if r.Models[0].Status != "upgrade_required" || r.Models[0].Tiers["unknown"].Attempts != 2 {
		t.Fatal("legacy guessed tier")
	}
}
func TestFastImpactInvalidMetricsAndLoadMismatch(t *testing.T) {
	a, b := fastTestEvent(1, "A", "default", 20), fastTestEvent(2, "A", "priority", 40)
	b.ReasoningEffort = "low"
	r := BuildFastImpact([]Event{a, b}, 1, 999999, FastImpactOptions{})
	if r.Models[0].Status != "load_mismatch" {
		t.Fatal(r.Models[0].Status)
	}
	b.ReasoningEffort = "high"
	b.OutputTokens = 0
	a.Telemetry.OutputReasoningSubset = false
	r = BuildFastImpact([]Event{a, b}, 1, 999999, FastImpactOptions{})
	if r.Models[0].Tiers["priority"].Empty != 1 || r.Models[0].Tiers["default"].Excluded["unknown_token_split"] != 1 || r.Models[0].ChangePct != nil {
		t.Fatal("bad samples included")
	}
}
func TestFastImpactObservedLatestTransition(t *testing.T) {
	var events []Event
	for i := 0; i < 20; i++ {
		tier := "default"
		if i >= 5 && i < 10 || i >= 15 {
			tier = "priority"
		}
		e := fastTestEvent(i, "A", tier, 1000)
		e.LatencyMS = fastTestPtr(int64(1))
		events = append(events, e)
	}
	r := BuildFastImpact(events, 1, 250000, FastImpactOptions{Mode: "transition"})
	tr := r.Models[0].Transition
	if tr == nil || tr.FromMS != 150000 || tr.ToMS != 160000 || tr.BeforeFromMS < 110000 || tr.AfterToMS-tr.ToMS != tr.FromMS-tr.BeforeFromMS {
		t.Fatalf("transition=%+v", tr)
	}
	for _, e := range r.Models[0].Observations {
		if e.StartedAtMS >= tr.FromMS && e.StartedAtMS < tr.ToMS {
			t.Fatal("uncertain interval included")
		}
	}
}
