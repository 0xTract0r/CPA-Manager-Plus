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
