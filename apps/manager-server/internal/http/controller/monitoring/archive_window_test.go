package monitoring

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/app"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/config"
	sqliterepo "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/repository/sqlite"
	adminauthsvc "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/adminauth"
	monitoringsvc "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/monitoring"
	usagesvc "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/usage"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/testutil"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/usage"
)

func TestAccountWindowUsageArchiveSources(t *testing.T) {
	ctx := context.Background()
	raw, err := sqliterepo.Open(filepath.Join(t.TempDir(), "usage.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	st := store.New(raw)
	t.Cleanup(func() { _ = st.Close() })
	testutil.EnsureAdminCredential(t, st)
	svc := usagesvc.New(st, usagesvc.WithArchive(usagesvc.ArchiveConfig{
		Directory: filepath.Join(t.TempDir(), "archives"), SegmentEventLimit: 1, DeleteBatchSize: 1, AggregateReadsEnabled: true,
	}))
	const day int64 = 86400000
	events := make([]usage.Event, 2)
	for i := range events {
		ts := day + int64(i+1)*1000
		events[i] = usage.Event{
			EventHash:   fmt.Sprintf("%x", sha256.Sum256([]byte(fmt.Sprint(i)))),
			TimestampMS: ts, Timestamp: time.UnixMilli(ts).UTC().Format(time.RFC3339Nano), CreatedAtMS: ts,
			Provider: "claude", AuthProviderSnapshot: "claude", AuthFileSnapshot: "fixture.json",
			Source: "fixture.json", AccountSnapshot: "fixture@example.invalid", AuthIndex: "auth-1",
			Model: "fixture-model", InputTokens: 10, OutputTokens: 5, TotalTokens: 15,
		}
	}
	if _, err := st.InsertEvents(ctx, events); err != nil {
		t.Fatal(err)
	}
	h := &Handler{App: &app.Context{
		AdminAuthService: adminauthsvc.New(config.Config{}, st), MonitoringService: monitoringsvc.New(st),
	}}
	check := func(label string, from, to int64, wantStatus int, wantCalls int64, withFile bool) {
		t.Helper()
		window := monitoringsvc.AccountWindowUsageTarget{
			RowKey: "fixture", WindowKey: "5h", FromMS: from, ToMS: to, AuthProviderSnapshot: "claude",
			AccountSnapshot: "fixture@example.invalid", AuthIndex: "auth-1", Source: "fixture.json",
			ModelScope: monitoringsvc.AccountWindowModelScope{Kind: "all", Key: "all", Complete: true},
		}
		if withFile {
			window.AuthFileSnapshot = "fixture.json"
		}
		body, err := json.Marshal(monitoringsvc.AccountWindowUsageRequest{Windows: []monitoringsvc.AccountWindowUsageTarget{window}})
		if err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest(http.MethodPost, "/v0/management/monitoring/account-window-usage", bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+testutil.AdminKey)
		rec := httptest.NewRecorder()
		h.Handle(rec, req)
		if rec.Code != wantStatus {
			t.Errorf("%s: HTTP %d, want %d, body=%s", label, rec.Code, wantStatus, rec.Body)
			return
		}
		if wantStatus == http.StatusOK {
			var result monitoringsvc.AccountWindowUsageResponse
			if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil || len(result.Items) != 1 || result.Items[0].TotalRequests != wantCalls {
				t.Errorf("%s: want %d calls, body=%s, err=%v", label, wantCalls, rec.Body, err)
				return
			}
		}
		t.Logf("%s: HTTP %d, body=%s", label, rec.Code, rec.Body)
	}
	check("no archive", day+900, day+1100, 200, 1, true)
	prepareArchiveWindow(t, ctx, st)
	created, err := svc.CreateArchive(ctx, day+1500)
	if err != nil {
		t.Fatal(err)
	}
	id := created.Run.ID
	if _, err := svc.ResumeArchive(ctx, id); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.VerifyArchive(ctx, id); err != nil {
		t.Fatal(err)
	}
	if result, err := svc.DeleteArchive(ctx, id); err != nil || result.Run.DeletedEventCount != 1 {
		t.Fatalf("archive delete: %v, %v", result.Run.DeletedEventCount, err)
	}
	check("intact projection", day+900, day+1100, 200, 1, true)
	check("full day without daily-compatible key", day, 2*day, 200, 2, false)
	if _, err := raw.ExecContext(ctx, "delete from usage_monitoring_event_projection_v1 where timestamp_ms = ?", day+1000); err != nil {
		t.Fatal(err)
	}
	check("full day still served by daily", day, 2*day, 200, 2, true)
	check("partial missing projection", day+900, day+1100, 422, 0, true)
	check("full day needs projection without daily-compatible key", day, 2*day, 422, 0, false)
	check("cross-day missing edge", day-500, day+1100, 422, 0, true)
	check("empty range outside deleted events", day+1200, day+1400, 200, 0, true)
	if _, err := raw.ExecContext(ctx, "update usage_monitoring_rollup_state set schema_version = 0 where rollup_name = 'projection_v1'"); err != nil {
		t.Fatal(err)
	}
	check("unavailable projection cannot fall back to incomplete raw", day+900, day+1100, 422, 0, true)
	check("full day served by daily with unavailable projection", day, 2*day, 200, 2, true)
}

func prepareArchiveWindow(t *testing.T, ctx context.Context, st *store.Store) {
	t.Helper()
	now := time.Now().UnixMilli()
	if result, err := st.CatchUpUsageHourlyAggregate(ctx, 32, now); err != nil || result.Pending {
		t.Fatalf("hourly catch-up: %+v, %v", result, err)
	}
	if result, err := st.CatchUpUsagePricing(ctx, 32, now); err != nil || result.Pending {
		t.Fatalf("pricing catch-up: %+v, %v", result, err)
	}
	if result, err := st.CatchUpAccountHistoryRollups(ctx, 32, now); err != nil || result.Pending {
		t.Fatalf("account history catch-up: %+v, %v", result, err)
	}
	for _, catchUp := range []func(context.Context, int, int64) (store.UsageMonitoringCatchUpResult, error){
		st.CatchUpUsageMonitoringStats, st.CatchUpUsageMonitoringMetadata, st.CatchUpUsageMonitoringProjection, st.CatchUpCodexLegacyIdentityEvidence,
	} {
		for {
			result, err := catchUp(ctx, 32, now)
			if err != nil {
				t.Fatal(err)
			}
			if !result.Pending {
				break
			}
		}
	}
}
