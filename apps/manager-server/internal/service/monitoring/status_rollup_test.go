package monitoring

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	sqliterepo "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/repository/sqlite"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/repository/usagepricing"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/usage"
)

func TestAnalyticsStatusRollupKeepsMixedGroupsSeparate(t *testing.T) {
	for _, successFirst := range []bool{true, false} {
		t.Run(fmt.Sprintf("successFirst=%t", successFirst), func(t *testing.T) {
			db := newMonitoringTestStore(t)
			ctx := context.Background()
			const day = int64(24 * time.Hour / time.Millisecond)
			from := int64(20671) * day
			events := []usage.Event{
				monitoringEvent("status-one", from+1000, "gpt-test", "test", "test", !successFirst, 2, 3, 0, 0, 5, nil),
				monitoringEvent("status-two", from+2000, "gpt-test", "test", "test", successFirst, 2, 3, 0, 0, 5, nil),
				monitoringEvent("status-three", from+3000, "gpt-test", "test", "test", false, 2, 3, 0, 0, 5, nil),
			}
			if _, err := db.InsertEvents(ctx, events); err != nil {
				t.Fatal(err)
			}
			catchUpMonitoringArchiveDeleteReadiness(t, ctx, db)
			assertAnalyticsStatusRollup(t, db, from, from+day)
		})
	}
}

func assertAnalyticsStatusRollup(t *testing.T, db *store.Store, from, to int64) {
	t.Helper()
	ctx := context.Background()
	includeFailed := false
	for _, test := range []struct {
		name    string
		filters Filters
		success int64
		failed  int64
	}{
		{"all", Filters{}, 2, 1},
		{"success", Filters{IncludeFailed: &includeFailed}, 2, 0},
		{"failure", Filters{FailedOnly: true}, 0, 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			service := New(db)
			req := Request{FromMS: from, ToMS: to, Filters: test.filters, Include: Include{Summary: true}}
			result, err := service.Analytics(ctx, req)
			if err != nil || result.Summary == nil {
				t.Fatalf("summary error: %v", err)
			}
			if result.Summary.SuccessCalls != test.success || result.Summary.FailureCalls != test.failed || result.Summary.TotalCalls != test.success+test.failed {
				t.Errorf("summary calls: total=%d success=%d failure=%d", result.Summary.TotalCalls, result.Summary.SuccessCalls, result.Summary.FailureCalls)
			}
			req.Include.EventsPage = &EventsPage{Limit: 1}
			pageOnly := req
			pageOnly.Include.Summary = false
			detail, err := service.Analytics(ctx, pageOnly)
			if err != nil || detail.Events == nil || detail.Events.TotalCount != test.success+test.failed {
				t.Errorf("detail-only count does not match: %v", err)
			}
			var success, failed int64
			for page := 0; page < 4; page++ {
				result, err := service.Analytics(ctx, req)
				if err != nil || result.Summary == nil || result.Events == nil {
					t.Fatalf("page error: %v", err)
				}
				if result.Summary.TotalCalls != test.success+test.failed || result.Events.TotalCount != test.success+test.failed {
					t.Errorf("page %d: summary=%d count=%d want=%d", page+1, result.Summary.TotalCalls, result.Events.TotalCount, test.success+test.failed)
				}
				for _, item := range result.Events.Items {
					if item.Failed {
						failed++
					} else {
						success++
					}
				}
				if !result.Events.HasMore {
					break
				}
				req.Include.EventsPage.BeforeMS = &result.Events.NextBeforeMS
				req.Include.EventsPage.BeforeID = &result.Events.NextBeforeID
			}
			if success != test.success || failed != test.failed {
				t.Errorf("page rows: success=%d failure=%d", success, failed)
			}
		})
	}
}

func TestAnalyticsStatusRollupRebuildsLegacyRowsOnReopen(t *testing.T) {
	ctx := context.Background()
	const day = int64(24 * time.Hour / time.Millisecond)
	from := int64(20671) * day
	path := filepath.Join(t.TempDir(), "usage.sqlite")
	raw, err := sqliterepo.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	db := store.New(raw)
	events := []usage.Event{
		monitoringEvent("status-one", from+1000, "gpt-test", "test", "test", false, 2, 3, 0, 0, 5, nil),
		monitoringEvent("status-two", from+2000, "gpt-test", "test", "test", true, 2, 3, 0, 0, 5, nil),
		monitoringEvent("status-three", from+3000, "gpt-test", "test", "test", false, 2, 3, 0, 0, 5, nil),
	}
	if _, err := db.InsertEvents(ctx, events); err != nil {
		t.Fatal(err)
	}
	catchUpMonitoringArchiveDeleteReadiness(t, ctx, db)
	legacyRevision, err := usagepricing.StructureRevision(ctx, raw)
	if err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"usage_monitoring_account_daily_rollups_v1", "usage_monitoring_api_key_daily_rollups_v1"} {
		if _, err := raw.Exec("delete from " + table + " where failed = 1"); err != nil {
			t.Fatal(err)
		}
		if _, err := raw.Exec("update "+table+" set calls = 3, structure_revision = ?", legacyRevision); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := raw.Exec("update usage_monitoring_rollup_state set structure_revision = ? where rollup_name = 'stats_v1'", legacyRevision); err != nil {
		t.Fatal(err)
	}
	if err := raw.Close(); err != nil {
		t.Fatal(err)
	}

	db, err = store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	t.Run("projection before rebuild", func(t *testing.T) {
		assertAnalyticsStatusRollup(t, db, from, from+day)
	})
	result, err := db.CatchUpUsageMonitoringStats(ctx, 1, time.Now().UnixMilli())
	if err != nil || !result.Rebuilt || !result.Pending {
		t.Fatalf("first rebuild batch: %#v, %v", result, err)
	}
	t.Run("partial rebuild", func(t *testing.T) {
		assertAnalyticsStatusRollup(t, db, from, from+day)
	})
	catchUpMonitoringArchiveDeleteReadiness(t, ctx, db)
	t.Run("rebuilt", func(t *testing.T) {
		assertAnalyticsStatusRollup(t, db, from, from+day)
	})
}
