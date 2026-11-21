package usage

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/repository/usagemonitoring"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/repository/usagepricing"
)

func TestMonitoringStatusRebuildPreservesArchivedRows(t *testing.T) {
	ctx := context.Background()
	svc, st, db, _ := newRawArchiveTestService(t, 1, 1)
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := db.ExecContext(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec("insert into model_prices(model,prompt_per_1m,completion_per_1m,cache_per_1m,updated_at_ms) values('fixture-billing',2,5,1,1)")
	exec("insert into model_price_context_tiers(model,threshold_tokens) values('fixture-billing',120)")
	events := archiveTestServiceEvents(3)
	times := []int64{1000, 86401000, 86402000}
	for i := range events {
		e := &events[i]
		e.TimestampMS = times[i]
		e.Timestamp = time.UnixMilli(e.TimestampMS).UTC().Format(time.RFC3339Nano)
		e.Provider = "fixture-provider"
		e.ExecutorType = "fixture"
		e.AuthIndex = ""
		e.AccountSnapshot = ""
		e.Source = fmt.Sprintf("fixture-source-%d", i)
		e.SourceHash = canonicalArchiveTestHash(e.Source)
		e.APIKeyHash = canonicalArchiveTestHash(fmt.Sprintf("bucket-%d", i%2))
		e.RequestedModel = "fixture-requested"
		e.ResolvedModel = "fixture-billing"
		e.InputTokens = int64(110 + i*20)
		e.OutputTokens = int64(10 + i)
		e.TotalTokens = e.InputTokens + e.OutputTokens
		e.CacheReadTokens = int64(i + 3)
		e.CacheCreationTokens = int64(i + 1)
		e.CachedTokens = 10
		e.Failed = i == 1
		l := int64(i * 80)
		if i != 1 {
			e.LatencyMS = &l
		}
	}
	insertArchiveTestEvents(t, st, events)
	catchUpUsageAggregate(t, st)
	pricingRevision, err := usagepricing.StructureRevision(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	revision := usagemonitoring.StatsStructureRevision(pricingRevision)
	tables := []string{"usage_monitoring_account_daily_rollups_v1", "usage_monitoring_api_key_daily_rollups_v1"}
	before := readArchiveTestDailyRows(t, db, tables, revision)

	// Save a raw duplicate to exercise restored rows winning over archive projection.
	exec("create table fixture_raw_backup as select * from usage_events where id = 1")
	created, err := svc.CreateArchive(ctx, 86401500)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ResumeArchive(ctx, created.Run.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.VerifyArchive(ctx, created.Run.ID); err != nil {
		t.Fatal(err)
	}
	deleted, err := svc.DeleteArchive(ctx, created.Run.ID)
	if err != nil || deleted.Run.DeletedEventCount != 2 {
		t.Fatalf("archive delete count = %d, error = %v", deleted.Run.DeletedEventCount, err)
	}
	// Reopening a legacy revision must trigger a new bounded generation.
	for _, table := range tables {
		exec("update "+table+" set structure_revision = ? where structure_revision = ?", pricingRevision, revision)
	}
	exec("update usage_monitoring_rollup_state set structure_revision = ? where rollup_name = ?", pricingRevision, usagemonitoring.StatsRollupName)
	for _, tc := range []struct {
		name string
		edit string
		undo string
	}{
		{
			name: "move covered day without changing total",
			edit: "update usage_archive_deleted_coverage_daily set utc_day = 2 where utc_day = 1",
			undo: "update usage_archive_deleted_coverage_daily set utc_day = 1 where utc_day = 2",
		},
		{
			name: "miscount days without changing total",
			edit: "update usage_archive_deleted_coverage_daily set deleted_event_count = case utc_day when 0 then 2 else 0 end",
			undo: "update usage_archive_deleted_coverage_daily set deleted_event_count = 1",
		},
		{
			name: "incorrect minimum",
			edit: "update usage_archive_deleted_coverage_daily set min_timestamp_ms = min_timestamp_ms - 1 where utc_day = 1",
			undo: "update usage_archive_deleted_coverage_daily set min_timestamp_ms = min_timestamp_ms + 1 where utc_day = 1",
		},
		{
			name: "incorrect maximum",
			edit: "update usage_archive_deleted_coverage_daily set max_timestamp_ms = max_timestamp_ms + 1 where utc_day = 1",
			undo: "update usage_archive_deleted_coverage_daily set max_timestamp_ms = max_timestamp_ms - 1 where utc_day = 1",
		},
		{
			name: "reference day missing",
			edit: "delete from usage_archive_deleted_coverage_daily where utc_day = 1",
			undo: "insert into usage_archive_deleted_coverage_daily values (1, 1, 86401000, 86401000)",
		},
		{
			name: "coverage-only empty day",
			edit: "insert into usage_archive_deleted_coverage_daily values (2, 0, 172800000, 172800000)",
			undo: "delete from usage_archive_deleted_coverage_daily where utc_day = 2",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			exec(tc.edit)
			defer exec(tc.undo)
			if _, err := st.CatchUpUsageMonitoringStats(ctx, 1, time.Now().UnixMilli()); !errors.Is(err, usagemonitoring.ErrArchivedStatsSourceUnavailable) {
				t.Fatalf("inconsistent daily coverage accepted: %v", err)
			}
			state, err := st.UsageMonitoringState(ctx, usagemonitoring.StatsRollupName)
			if err != nil || state.StructureRevision != pricingRevision || state.Status != "ready" || state.CoverageEventID != 3 {
				t.Fatalf("changed old state on daily coverage mismatch: %+v, %v", state, err)
			}
			if records := readArchiveTestDailyRows(t, db, tables, pricingRevision); !reflect.DeepEqual(records, before) {
				t.Fatal("legacy buckets changed on daily coverage mismatch")
			}
		})
	}
	exec("create table fixture_projection_backup as select * from usage_monitoring_event_projection_v1 where event_id = 2")
	exec("delete from usage_monitoring_event_projection_v1 where event_id = 2")

	if _, err := st.CatchUpUsageMonitoringStats(ctx, 1, time.Now().UnixMilli()); !errors.Is(err, usagemonitoring.ErrArchivedStatsSourceUnavailable) {
		t.Fatalf("missing projection rebuild error = %v", err)
	}
	state, err := st.UsageMonitoringState(ctx, usagemonitoring.StatsRollupName)
	if err != nil || state.StructureRevision != pricingRevision || state.CoverageEventID != 3 {
		t.Fatalf("lost old state on proof failure: %+v, %v", state, err)
	}
	if records := readArchiveTestDailyRows(t, db, tables, pricingRevision); !reflect.DeepEqual(records, before) {
		t.Fatal("legacy buckets changed on proof failure")
	}
	if err := st.UsageMonitoring.CheckArchivedStatsRead(ctx, 1, 86403000, 2); !errors.Is(err, usagemonitoring.ErrArchivedStatsSourceUnavailable) {
		t.Fatalf("incomplete fallback read error = %v", err)
	}
	exec("insert into usage_monitoring_event_projection_v1 select * from fixture_projection_backup")
	exec("update usage_monitoring_event_projection_v1 set timestamp_ms = timestamp_ms + 1 where event_id = 2")
	if _, err := st.CatchUpUsageMonitoringStats(ctx, 1, time.Now().UnixMilli()); !errors.Is(err, usagemonitoring.ErrArchivedStatsSourceUnavailable) {
		t.Fatalf("incorrect archive timestamp accepted: %v", err)
	}
	exec("update usage_monitoring_event_projection_v1 set timestamp_ms = timestamp_ms - 1 where event_id = 2")
	exec("update usage_monitoring_rollup_state set coverage_event_id = 1 where rollup_name = ?", usagemonitoring.ProjectionRollupName)
	if _, err := st.CatchUpUsageMonitoringStats(ctx, 1, time.Now().UnixMilli()); !errors.Is(err, usagemonitoring.ErrArchivedStatsSourceUnavailable) {
		t.Fatalf("uncovered archive reference accepted: %v", err)
	}
	exec("update usage_monitoring_rollup_state set coverage_event_id = 3 where rollup_name = ?", usagemonitoring.ProjectionRollupName)

	if err := st.UsageMonitoring.CheckArchivedStatsRead(ctx, 1, 86403000, 2); err != nil {
		t.Fatalf("complete projection fallback unavailable: %v", err)
	}
	exec("insert into usage_events select * from fixture_raw_backup")
	exec("update usage_monitoring_event_projection_v1 set output_tokens = output_tokens + 100 where event_id = 1")

	for i := 1; i <= 3; i++ {
		result, err := st.CatchUpUsageMonitoringStats(ctx, 1, time.Now().UnixMilli())
		if err != nil || result.Processed != 1 || result.CoverageEventID != int64(i) || result.Pending != (i < 3) {
			t.Fatalf("batch %d = %+v, %v", i, result, err)
		}
	}
	if records := readArchiveTestDailyRows(t, db, tables, revision); !reflect.DeepEqual(records, before) {
		t.Fatalf("archived and retained rows changed the daily buckets")
	}
	repeat, err := st.CatchUpUsageMonitoringStats(ctx, 1, time.Now().UnixMilli())
	if err != nil || repeat.Pending || repeat.Processed != 0 {
		t.Fatalf("idle rerun changed stats: %+v, %v", repeat, err)
	}
}

func readArchiveTestDailyRows(t *testing.T, db *sql.DB, tables []string, revision string) [][][]any {
	t.Helper()
	var records [][][]any
	for _, table := range tables {
		rows, err := db.Query("select * from "+table+" where structure_revision = ? order by bucket_ms, source", revision)
		if err != nil {
			t.Fatal(err)
		}
		columns, err := rows.Columns()
		if err != nil {
			t.Fatal(err)
		}
		var result [][]any
		tiers := make(map[int64]bool)
		for rows.Next() {
			values := make([]any, len(columns))
			destinations := make([]any, len(columns))
			for i := range values {
				destinations[i] = &values[i]
			}
			if err := rows.Scan(destinations...); err != nil {
				t.Fatal(err)
			}
			var fields []any
			for i, column := range columns {
				switch column {
				case "context_threshold_tokens":
					tiers[values[i].(int64)] = true
				case "pricing_model":
					if values[i] != "fixture-billing" {
						t.Fatal("fixture didn't exercise priced resolution")
					}
				}
				if !strings.Contains(" structure_revision updated_at_ms ", " "+column+" ") {
					fields = append(fields, values[i])
				}
			}
			result = append(result, fields)
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		rows.Close()
		if len(result) != 3 || !tiers[120] || len(tiers) != 2 {
			t.Fatalf("fixture bucket count=%d pricing tiers=%d", len(result), len(tiers))
		}
		records = append(records, result)
	}
	return records
}
