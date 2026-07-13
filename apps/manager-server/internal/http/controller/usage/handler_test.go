package usage

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/app"
	collectorpkg "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/collector"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/config"
	collectorsvc "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/collector"
	managerconfigsvc "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/managerconfig"
	usagesvc "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/usage"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/testutil"
)

func TestImportReturnsBadRequestWhenUncommittedArrayParsingFails(t *testing.T) {
	st := testutil.NewStore(t, testutil.NewConfig(t))
	handler := &Handler{App: &app.Context{UsageService: usagesvc.New(st)}}
	req := httptest.NewRequest(http.MethodPost, "/v0/management/usage/import", strings.NewReader(`[{"event_hash":"one","timestamp_ms":1,"timestamp":"2026-01-01T00:00:00Z","model":"gpt-test"},`))
	recorder := httptest.NewRecorder()

	handler.Import(recorder, req)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d body = %s", recorder.Code, recorder.Body.String())
	}
}

func TestImportReturnsInternalServerErrorForPersistenceFailure(t *testing.T) {
	st := testutil.NewStore(t, testutil.NewConfig(t))
	if err := st.Close(); err != nil {
		t.Fatalf("close store: %v", err)
	}
	handler := &Handler{App: &app.Context{UsageService: usagesvc.New(st)}}
	req := httptest.NewRequest(http.MethodPost, "/v0/management/usage/import", strings.NewReader(`{"event_hash":"one","timestamp_ms":1,"timestamp":"2026-01-01T00:00:00Z","model":"gpt-test"}`))
	recorder := httptest.NewRecorder()

	handler.Import(recorder, req)

	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d body = %s", recorder.Code, recorder.Body.String())
	}
}

func TestImportRejectsKnownOversizedContentLengthBeforeReading(t *testing.T) {
	st := testutil.NewStore(t, testutil.NewConfig(t))
	handler := &Handler{App: &app.Context{UsageService: usagesvc.New(st)}}
	req := httptest.NewRequest(http.MethodPost, "/v0/management/usage/import", strings.NewReader("{}"))
	req.ContentLength = maxUsageImportBytes + 1
	recorder := httptest.NewRecorder()

	handler.Import(recorder, req)

	if recorder.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d body = %s", recorder.Code, recorder.Body.String())
	}
}

func newUsageSyncTestHandler(t *testing.T, st *store.Store, upstreamURL string) *Handler {
	t.Helper()
	cfg := config.Config{
		DBPath:        filepath.Join(t.TempDir(), "usage.sqlite"),
		Queue:         "usage",
		PopSide:       "right",
		BatchSize:     100,
		QueryLimit:    50000,
		CORSOrigins:   []string{"*"},
		CollectorMode: "auto",
	}
	manager := collectorpkg.NewManager(cfg, st)
	collectorService := collectorsvc.New(manager)
	managerConfigService := managerconfigsvc.New(cfg, st, collectorService)
	if upstreamURL != "" {
		if err := st.SaveManagerConfig(context.Background(), store.ManagerConfig{
			CPAConnection: store.ManagerCPAConnectionConfig{
				CPABaseURL:    upstreamURL,
				ManagementKey: "management-key",
			},
		}); err != nil {
			t.Fatalf("save manager config: %v", err)
		}
	}
	return &Handler{App: &app.Context{Config: cfg, UsageService: usagesvc.New(st, managerConfigService)}}
}

func TestSyncReturnsPreconditionFailedWhenCoreConnectionNotConfigured(t *testing.T) {
	st := testutil.NewStore(t, testutil.NewConfig(t))
	handler := newUsageSyncTestHandler(t, st, "")

	req := httptest.NewRequest(http.MethodPost, "/v0/management/usage/sync", nil)
	recorder := httptest.NewRecorder()

	handler.Sync(recorder, req)

	if recorder.Code != http.StatusPreconditionFailed {
		t.Fatalf("status = %d body = %s", recorder.Code, recorder.Body.String())
	}
}

func TestSyncImportsCoreExportAndReturnsOK(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v0/management/usage/export" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"version": 2,
			"exported_at": "2026-01-01T00:00:00Z",
			"usage": {
				"apis": {
					"POST /v1/chat/completions": {
						"models": {
							"gpt-test": {
								"details": [
									{"timestamp": "2026-01-01T00:00:00Z", "input_tokens": 10, "output_tokens": 5}
								]
							}
						}
					}
				}
			}
		}`))
	}))
	t.Cleanup(upstream.Close)

	st := testutil.NewStore(t, testutil.NewConfig(t))
	handler := newUsageSyncTestHandler(t, st, upstream.URL)

	req := httptest.NewRequest(http.MethodPost, "/v0/management/usage/sync", nil)
	recorder := httptest.NewRecorder()

	handler.Sync(recorder, req)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), `"added":1`) {
		t.Fatalf("body = %s, want added=1", recorder.Body.String())
	}
}

// TestSyncForwardsQueryParamSinceAndLimitToCore verifies the HTTP handler
// parses ?since=&limit= query parameters and forwards them to core's
// /usage/export as the pagination cursor for a resumed sync call.
func TestSyncForwardsQueryParamSinceAndLimitToCore(t *testing.T) {
	var gotSince, gotLimit string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotSince = r.URL.Query().Get("since")
		gotLimit = r.URL.Query().Get("limit")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"version":2,"exported_at":"2026-01-01T00:00:00Z","usage":{"apis":{}}}`))
	}))
	t.Cleanup(upstream.Close)

	st := testutil.NewStore(t, testutil.NewConfig(t))
	handler := newUsageSyncTestHandler(t, st, upstream.URL)

	req := httptest.NewRequest(http.MethodPost, "/v0/management/usage/sync?since=2026-01-01T00:00:00Z&limit=250", nil)
	recorder := httptest.NewRecorder()

	handler.Sync(recorder, req)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", recorder.Code, recorder.Body.String())
	}
	if gotSince != "2026-01-01T00:00:00Z" {
		t.Fatalf("core got since=%q, want 2026-01-01T00:00:00Z", gotSince)
	}
	if gotLimit != "250" {
		t.Fatalf("core got limit=%q, want 250", gotLimit)
	}
}

// TestSyncJSONBodyOverridesQueryParams verifies a JSON request body
// {"since":...,"limit":...} takes precedence over query parameters when both
// are present.
func TestSyncJSONBodyOverridesQueryParams(t *testing.T) {
	var gotSince, gotLimit string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotSince = r.URL.Query().Get("since")
		gotLimit = r.URL.Query().Get("limit")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"version":2,"exported_at":"2026-01-01T00:00:00Z","usage":{"apis":{}}}`))
	}))
	t.Cleanup(upstream.Close)

	st := testutil.NewStore(t, testutil.NewConfig(t))
	handler := newUsageSyncTestHandler(t, st, upstream.URL)

	req := httptest.NewRequest(
		http.MethodPost,
		"/v0/management/usage/sync?since=2020-01-01T00:00:00Z&limit=1",
		strings.NewReader(`{"since":"2026-02-02T00:00:00Z","limit":777}`),
	)
	req.ContentLength = int64(len(`{"since":"2026-02-02T00:00:00Z","limit":777}`))
	recorder := httptest.NewRecorder()

	handler.Sync(recorder, req)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", recorder.Code, recorder.Body.String())
	}
	if gotSince != "2026-02-02T00:00:00Z" {
		t.Fatalf("core got since=%q, want body value to win", gotSince)
	}
	if gotLimit != "777" {
		t.Fatalf("core got limit=%q, want body value to win", gotLimit)
	}
}

// TestSyncRejectsInvalidLimitQueryParam verifies a malformed limit query
// param is rejected with 400 before any core request is made.
func TestSyncRejectsInvalidLimitQueryParam(t *testing.T) {
	st := testutil.NewStore(t, testutil.NewConfig(t))
	handler := newUsageSyncTestHandler(t, st, "")

	req := httptest.NewRequest(http.MethodPost, "/v0/management/usage/sync?limit=not-a-number", nil)
	recorder := httptest.NewRecorder()

	handler.Sync(recorder, req)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d body = %s", recorder.Code, recorder.Body.String())
	}
}

// TestCatchUpStatusReturnsNotFoundWhenNoRunYet verifies the endpoint reports
// found=false (not an error) when the background catch-up worker has not
// completed a run yet, e.g. right after a fresh install.
func TestCatchUpStatusReturnsNotFoundWhenNoRunYet(t *testing.T) {
	st := testutil.NewStore(t, testutil.NewConfig(t))
	handler := &Handler{App: &app.Context{Store: st, UsageService: usagesvc.New(st)}}

	req := httptest.NewRequest(http.MethodGet, "/v0/management/usage/catchup-status", nil)
	recorder := httptest.NewRecorder()

	handler.CatchUpStatus(recorder, req)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), `"found":false`) {
		t.Fatalf("body = %s, want found=false", recorder.Body.String())
	}
}

// TestCatchUpStatusReturnsPersistedStatus verifies the endpoint surfaces a
// previously persisted worker run status.
func TestCatchUpStatusReturnsPersistedStatus(t *testing.T) {
	st := testutil.NewStore(t, testutil.NewConfig(t))
	if err := st.SaveUsageCatchUpStatus(context.Background(), store.UsageCatchUpRunStatus{
		LastRunAtMS: 1_800_000_000_000,
		LastAdded:   7,
		LastStatus:  "ok",
		TotalAdded:  42,
		Trigger:     "timer",
	}); err != nil {
		t.Fatalf("save status: %v", err)
	}
	handler := &Handler{App: &app.Context{Store: st, UsageService: usagesvc.New(st)}}

	req := httptest.NewRequest(http.MethodGet, "/v0/management/usage/catchup-status", nil)
	recorder := httptest.NewRecorder()

	handler.CatchUpStatus(recorder, req)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", recorder.Code, recorder.Body.String())
	}
	body := recorder.Body.String()
	if !strings.Contains(body, `"found":true`) {
		t.Fatalf("body = %s, want found=true", body)
	}
	if !strings.Contains(body, `"lastAdded":7`) || !strings.Contains(body, `"totalAdded":42`) {
		t.Fatalf("body = %s, want lastAdded=7 and totalAdded=42", body)
	}
}

// TestSyncResponseIncludesHasMoreAndNextSinceCursor verifies the HTTP
// response surfaces core's pagination cursors so the frontend can drive a
// resumable sync loop.
func TestSyncResponseIncludesHasMoreAndNextSinceCursor(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"version": 2,
			"exported_at": "2026-01-01T00:00:00Z",
			"usage": {
				"apis": {
					"POST /v1/chat/completions": {
						"models": {
							"gpt-test": {
								"details": [{"timestamp": "2026-01-01T00:00:00Z", "input_tokens": 10, "output_tokens": 5}]
							}
						}
					}
				}
			},
			"has_more": true,
			"next_since": "2026-01-01T00:00:00.000000001Z"
		}`))
	}))
	t.Cleanup(upstream.Close)

	st := testutil.NewStore(t, testutil.NewConfig(t))
	handler := newUsageSyncTestHandler(t, st, upstream.URL)

	req := httptest.NewRequest(http.MethodPost, "/v0/management/usage/sync", nil)
	recorder := httptest.NewRecorder()

	handler.Sync(recorder, req)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", recorder.Code, recorder.Body.String())
	}
	body := recorder.Body.String()
	if !strings.Contains(body, `"hasMore":true`) {
		t.Fatalf("body = %s, want hasMore=true", body)
	}
	if !strings.Contains(body, `"nextSince":"2026-01-01T00:00:00.000000001Z"`) {
		t.Fatalf("body = %s, want nextSince cursor", body)
	}
}
