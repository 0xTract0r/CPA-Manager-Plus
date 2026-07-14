package usage

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

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

	_, err := svc.SyncFromCore(context.Background(), SyncOptions{})
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

	result, err := svc.SyncFromCore(context.Background(), SyncOptions{})
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
	if result.HasMore {
		t.Fatalf("result.HasMore = true, want false (single unwindowed batch): %#v", result)
	}

	events, _, err := db.Counts(context.Background())
	if err != nil {
		t.Fatalf("counts: %v", err)
	}
	if events != 2 {
		t.Fatalf("events = %d, want 2", events)
	}

	// Running sync again should dedupe via event_hash and add nothing new.
	result2, err := svc.SyncFromCore(context.Background(), SyncOptions{})
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

	result, err := svc.SyncFromCore(context.Background(), SyncOptions{})
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

	_, err := svc.SyncFromCore(context.Background(), SyncOptions{})
	if err == nil {
		t.Fatal("expected error when core export request fails")
	}
}

// TestSyncFromCoreDefaultsToFirstBatchLimit verifies SyncFromCore requests
// defaultSyncBatchLimit when the caller does not specify Limit, and that
// since/limit are forwarded as query parameters to core's /usage/export.
func TestSyncFromCoreDefaultsToFirstBatchLimit(t *testing.T) {
	var gotSince, gotLimit string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotSince = r.URL.Query().Get("since")
		gotLimit = r.URL.Query().Get("limit")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"version": 2,
			"exported_at": "2026-01-01T00:00:00Z",
			"usage": {"apis": {}}
		}`))
	}))
	t.Cleanup(upstream.Close)

	cfg := testutil.NewConfig(t)
	db := testutil.NewStore(t, cfg)
	svc := newSyncTestService(t, db, upstream.URL)

	if _, err := svc.SyncFromCore(context.Background(), SyncOptions{}); err != nil {
		t.Fatalf("sync from core: %v", err)
	}
	if gotSince != "" {
		t.Fatalf("since query param = %q, want empty for first page", gotSince)
	}
	if gotLimit != "5000" {
		t.Fatalf("limit query param = %q, want 5000 (defaultSyncBatchLimit)", gotLimit)
	}
}

// TestSyncFromCoreCursorLoopPullsAllPagesWithoutGapsOrDuplicates simulates a
// mock core /usage/export that windows by since/limit across three pages and
// verifies a client-side "keep calling with Since=NextSince until HasMore is
// false" loop pulls every event exactly once, in order.
func TestSyncFromCoreCursorLoopPullsAllPagesWithoutGapsOrDuplicates(t *testing.T) {
	// Three timestamps far enough apart that RFC3339 second precision cannot
	// collide, one event per page, limit=1 forces pagination across all three.
	timestamps := []string{
		"2026-01-01T00:00:00Z",
		"2026-01-01T00:01:00Z",
		"2026-01-01T00:02:00Z",
	}

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		since := r.URL.Query().Get("since")
		limit := r.URL.Query().Get("limit")
		if limit != "1" {
			t.Errorf("mock core got limit=%q, want 1", limit)
		}

		var sinceTime time.Time
		if since != "" {
			parsed, err := time.Parse(time.RFC3339Nano, since)
			if err != nil {
				t.Errorf("mock core got unparsable since=%q: %v", since, err)
			}
			sinceTime = parsed
		}

		// Find the first timestamp strictly after `since` (core's semantics).
		var page []string
		var hasMore bool
		var nextSince string
		for i, ts := range timestamps {
			parsed, _ := time.Parse(time.RFC3339, ts)
			if !parsed.After(sinceTime) {
				continue
			}
			page = []string{ts}
			hasMore = i < len(timestamps)-1
			nextSince = ts
			break
		}

		details := ""
		for i, ts := range page {
			if i > 0 {
				details += ","
			}
			details += fmt.Sprintf(`{"timestamp":%q,"input_tokens":1,"output_tokens":1}`, ts)
		}

		w.Header().Set("Content-Type", "application/json")
		body := fmt.Sprintf(`{
			"version": 2,
			"exported_at": "2026-01-01T00:00:00Z",
			"usage": {
				"apis": {
					"POST /v1/chat/completions": {
						"models": {
							"gpt-test": {"details": [%s]}
						}
					}
				}
			},
			"has_more": %v,
			"next_since": %q
		}`, details, hasMore, nextSince)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(upstream.Close)

	cfg := testutil.NewConfig(t)
	db := testutil.NewStore(t, cfg)
	svc := newSyncTestService(t, db, upstream.URL)

	var since string
	var totalAdded int
	pages := 0
	for {
		pages++
		if pages > len(timestamps)+1 {
			t.Fatalf("cursor loop did not terminate after %d pages", pages)
		}
		result, err := svc.SyncFromCore(context.Background(), SyncOptions{Since: since, Limit: 1})
		if err != nil {
			t.Fatalf("sync from core (page %d): %v", pages, err)
		}
		totalAdded += result.Added
		if !result.HasMore {
			break
		}
		if result.NextSince == "" {
			t.Fatalf("result.HasMore = true but NextSince is empty: %#v", result)
		}
		since = result.NextSince
	}

	if pages != len(timestamps) {
		t.Fatalf("pages = %d, want %d (one event per page)", pages, len(timestamps))
	}
	if totalAdded != len(timestamps) {
		t.Fatalf("totalAdded = %d, want %d", totalAdded, len(timestamps))
	}

	events, _, err := db.Counts(context.Background())
	if err != nil {
		t.Fatalf("counts: %v", err)
	}
	if events != int64(len(timestamps)) {
		t.Fatalf("events = %d, want %d (no gaps, no duplicates)", events, len(timestamps))
	}
}
