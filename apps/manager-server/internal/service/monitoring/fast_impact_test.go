package monitoring

import (
	"context"
	"fmt"
	"testing"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/usage"
)

func TestFastImpactFullScopeAndRicherImport(t *testing.T) {
	db := newMonitoringTestStore(t)
	ctx := context.Background()
	from := int64(1778000000000)
	lat := int64(10000)
	yes := true
	var events []usage.Event
	for i := 0; i < 130; i++ {
		e := monitoringEvent(fmt.Sprint(i), from+int64(i), "alias", "account", "source", false, 1000, 200, 0, 0, 1200, &lat)
		e.Provider = "codex"
		e.AuthIndex = "account"
		e.ResolvedModel = "actual-model"
		e.Telemetry = &usage.Telemetry{Version: 1, AttemptID: fmt.Sprint(i), FirstBodyMS: &lat}
		events = append(events, e)
	}
	if _, err := db.InsertEvents(ctx, events); err != nil {
		t.Fatal(err)
	}
	req := Request{FromMS: from, ToMS: from + 1000, Filters: Filters{AuthIndices: []string{"account"}, IncludeFailed: &yes}, Include: Include{FastImpact: true, EventsPage: &EventsPage{Limit: 1}}}
	a, err := New(db).Analytics(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	req.Include.EventsPage.Limit = 120
	b, err := New(db).Analytics(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	if a.FastImpact.Scanned != 130 || b.FastImpact.Scanned != 130 || len(b.FastImpact.Models) != 1 || b.FastImpact.Models[0].Model != "actual-model" {
		t.Fatalf("scope=%+v", b.FastImpact)
	}
	richer := events[0]
	richer.Telemetry = &usage.Telemetry{Version: 2, AttemptID: "0", FastContext: &usage.FastContext{SchemaVersion: 1, UpstreamRequestServiceTier: "priority", TierSource: "account", RequestKind: "serving"}}
	n, err := db.InsertEvents(ctx, []usage.Event{richer})
	if err != nil || n.Inserted != 0 {
		t.Fatalf("reimport=%+v %v", n, err)
	}
	if _, err = db.InsertEvents(ctx, events[:1]); err != nil {
		t.Fatal(err)
	}
	b, err = New(db).Analytics(ctx, req)
	if err != nil || b.FastImpact.Scanned != 130 || b.FastImpact.Models[0].Tiers["priority"].Attempts != 1 {
		t.Fatalf("richer lost=%+v %v", b.FastImpact, err)
	}
	for _, indices := range [][]string{nil, {"a", "b"}} {
		req.Filters.AuthIndices = indices
		if _, err = New(db).Analytics(ctx, req); err == nil {
			t.Fatal("invalid accounts accepted")
		}
	}
	req.Filters.AuthIndices = []string{"account"}
	req.Filters.Providers = []string{"claude"}
	if _, err = New(db).Analytics(ctx, req); err == nil {
		t.Fatal("provider conflict accepted")
	}
}

func TestFastImpactResolvedRequestDrilldown(t *testing.T) {
	db := newMonitoringTestStore(t)
	ctx := context.Background()
	from := int64(1778000000000)
	lat := int64(1000)
	e := monitoringEvent("resolved", from+1, "requested-alias", "account", "source", false, 100, 200, 0, 0, 300, &lat)
	e.AuthIndex = "exact-account"
	e.ResolvedModel = "gpt-6-astra"
	e.Provider = "codex"
	e.RequestID = "exact-request"
	if _, err := db.InsertEvents(ctx, []usage.Event{e}); err != nil {
		t.Fatal(err)
	}
	r, err := New(db).Analytics(ctx, Request{FromMS: from, ToMS: from + 10000, Filters: Filters{AuthIndices: []string{"exact-account"}, ResolvedModels: []string{"gpt-6-astra"}, RequestIDs: []string{"exact-request"}}, Include: Include{EventsPage: &EventsPage{Limit: 10}}})
	if err != nil || r.Events == nil || len(r.Events.Items) != 1 {
		t.Fatalf("exact drilldown=%+v %v", r.Events, err)
	}
}
