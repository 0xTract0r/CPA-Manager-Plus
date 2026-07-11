package usage

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	collectorpkg "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/collector"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/config"
	collectorsvc "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/collector"
	managerconfigsvc "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/managerconfig"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/testutil"
	usageparser "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/usage"
)

const syncTestManagementKey = "management-key"

func newSyncTestService(t *testing.T, db *store.Store, upstreamURL string) *Service {
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
	manager := collectorpkg.NewManager(cfg, db)
	collectorService := collectorsvc.New(manager)
	managerConfigService := managerconfigsvc.New(cfg, db, collectorService)

	if upstreamURL != "" {
		if err := db.SaveManagerConfig(context.Background(), store.ManagerConfig{
			CPAConnection: store.ManagerCPAConnectionConfig{
				CPABaseURL:    upstreamURL,
				ManagementKey: syncTestManagementKey,
			},
		}); err != nil {
			t.Fatalf("save manager config: %v", err)
		}
	}
	return New(db, managerConfigService)
}

func TestSyncFromCoreReturnsErrorWhenConnectionNotConfigured(t *testing.T) {
	cfg := testutil.NewConfig(t)
	db := testutil.NewStore(t, cfg)
	svc := newSyncTestService(t, db, "")

	_, err := svc.SyncFromCore(context.Background())
	if !errors.Is(err, ErrCoreConnectionNotConfigured) {
		t.Fatalf("err = %v, want ErrCoreConnectionNotConfigured", err)
	}
}

func TestSyncFromCoreImportsLegacyExportSnapshot(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v0/management/usage/export" || r.Method != http.MethodGet {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Authorization") != "Bearer "+syncTestManagementKey {
			http.Error(w, "forbidden", http.StatusForbidden)
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
									{
										"timestamp": "2026-01-01T00:00:00Z",
										"input_tokens": 10,
										"output_tokens": 5
									},
									{
										"timestamp": "2026-01-01T00:01:00Z",
										"input_tokens": 20,
										"output_tokens": 8
									}
								]
							}
						}
					}
				}
			}
		}`))
	}))
	t.Cleanup(upstream.Close)

	cfg := testutil.NewConfig(t)
	db := testutil.NewStore(t, cfg)
	svc := newSyncTestService(t, db, upstream.URL)

	result, err := svc.SyncFromCore(context.Background())
	if err != nil {
		t.Fatalf("sync from core: %v", err)
	}
	if result.NoHistoricalData {
		t.Fatalf("result.NoHistoricalData = true, want false: %#v", result)
	}
	if result.Format != usageparser.ImportFormatLegacyExport {
		t.Fatalf("result.Format = %q, want %q", result.Format, usageparser.ImportFormatLegacyExport)
	}
	if result.Added != 2 {
		t.Fatalf("result.Added = %d, want 2 (result=%#v)", result.Added, result)
	}

	events, _, err := db.Counts(context.Background())
	if err != nil {
		t.Fatalf("counts: %v", err)
	}
	if events != 2 {
		t.Fatalf("events = %d, want 2", events)
	}

	// Running sync again should dedupe via event_hash and add nothing new.
	result2, err := svc.SyncFromCore(context.Background())
	if err != nil {
		t.Fatalf("sync from core (second run): %v", err)
	}
	if result2.Added != 0 || result2.Skipped != 2 {
		t.Fatalf("second sync result = %#v, want added=0 skipped=2", result2)
	}
}

func TestSyncFromCoreReportsNoHistoricalDataWhenExportHasNoDetails(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v0/management/usage/export" || r.Method != http.MethodGet {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"version": 2,
			"exported_at": "2026-01-01T00:00:00Z",
			"usage": {
				"total_requests": 0,
				"apis": {}
			}
		}`))
	}))
	t.Cleanup(upstream.Close)

	cfg := testutil.NewConfig(t)
	db := testutil.NewStore(t, cfg)
	svc := newSyncTestService(t, db, upstream.URL)

	result, err := svc.SyncFromCore(context.Background())
	if err != nil {
		t.Fatalf("sync from core: %v", err)
	}
	if !result.NoHistoricalData {
		t.Fatalf("result.NoHistoricalData = false, want true: %#v", result)
	}
	if result.Added != 0 {
		t.Fatalf("result.Added = %d, want 0", result.Added)
	}
}

func TestSyncFromCoreReturnsBadGatewayWrappedErrorWhenExportRequestFails(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	t.Cleanup(upstream.Close)

	cfg := testutil.NewConfig(t)
	db := testutil.NewStore(t, cfg)
	svc := newSyncTestService(t, db, upstream.URL)

	_, err := svc.SyncFromCore(context.Background())
	if err == nil {
		t.Fatal("expected error when core export request fails")
	}
}
