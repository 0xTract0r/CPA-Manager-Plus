package usagemonitoring

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/usageidentity"
)

var ErrArchivedStatsSourceUnavailable = errors.New("monitoring stats cannot be rebuilt from verified archived usage; restore the missing source records")

func latestArchivedStatsID(ctx context.Context, tx *sql.Tx) (int64, error) {
	var id int64
	err := tx.QueryRowContext(ctx, "select coalesce(max(raw_event_id), 0) from usage_archive_event_refs where raw_deleted_at_ms is not null").Scan(&id)
	return id, err
}

func validateStatsArchiveRevision(ctx context.Context, tx *sql.Tx, maxArchivedID int64) error {
	// The archive writer and historical backfill both use the UTC epoch-day
	// quotient, and accumulate exact counts and timestamp extrema per day.
	var missingCoverage, missingRefs bool
	var refs, distinctIDs int64
	if err := tx.QueryRowContext(ctx, `with refs_by_day as (
		select timestamp_ms / ? as utc_day, count(*) as deleted_event_count,
			min(timestamp_ms) as min_timestamp_ms, max(timestamp_ms) as max_timestamp_ms
		from usage_archive_event_refs where raw_deleted_at_ms is not null
		group by timestamp_ms / ?
	)
	select
		exists(
			select * from refs_by_day
			except select utc_day, deleted_event_count, min_timestamp_ms, max_timestamp_ms
			from usage_archive_deleted_coverage_daily
		),
		exists(
			select utc_day, deleted_event_count, min_timestamp_ms, max_timestamp_ms
			from usage_archive_deleted_coverage_daily
			except select * from refs_by_day
		),
		count(*), count(distinct raw_event_id)
	from usage_archive_event_refs where raw_deleted_at_ms is not null`, dayMS, dayMS).
		Scan(&missingCoverage, &missingRefs, &refs, &distinctIDs); err != nil {
		return err
	}
	if missingCoverage || missingRefs || refs != distinctIDs {
		return fmt.Errorf("%w: UTC daily deleted-event coverage and archive references disagree", ErrArchivedStatsSourceUnavailable)
	}
	if refs == 0 {
		return nil
	}
	return validateArchivedStatsRefs(ctx, tx, "r.raw_event_id <= ?", false, maxArchivedID)
}

func validateArchivedStatsRefs(ctx context.Context, tx *sql.Tx, scope string, requireProjection bool, args ...any) error {
	// Real raw data wins. Otherwise require a verified segment, a projection row
	// with the same ID and timestamp, and a matching current projection watermark.
	var missing bool
	query := `select exists(select 1
		from usage_archive_event_refs r
		left join usage_archive_segments s on s.run_id = r.run_id and s.sequence = r.segment_sequence
		left join usage_events e on e.id = r.raw_event_id
		left join usage_monitoring_event_projection_v1 p
			on p.event_id = r.raw_event_id and p.timestamp_ms = r.timestamp_ms
		left join usage_monitoring_rollup_state ps on ps.rollup_name = 'projection_v1'
		where r.raw_deleted_at_ms is not null and (` + scope + `) and (
			r.raw_event_id <= 0
			or (e.id is not null and (e.timestamp_ms != r.timestamp_ms or e.event_hash != r.event_hash))
			or ((e.id is null or ?) and (
				s.verified_at_ms is null or s.status != 'verified'
				or r.raw_event_id < s.first_event_id or r.raw_event_id > s.last_event_id
				or r.timestamp_ms < s.min_timestamp_ms or r.timestamp_ms > s.max_timestamp_ms
				or p.event_id is null or ps.rollup_name is null
				or ps.schema_version != ? or ps.structure_revision != ?
				or ps.status not in ('ready','catching_up') or ps.coverage_event_id < r.raw_event_id
			))
		))`
	if err := tx.QueryRowContext(ctx, query, append(args, requireProjection, SchemaVersion, usageidentity.MonitoringProjectionStructureRevision())...).Scan(&missing); err != nil {
		return err
	}
	if missing {
		return fmt.Errorf("%w: archived references lack corresponding raw or verified projection rows", ErrArchivedStatsSourceUnavailable)
	}
	return nil
}

func archivedStatsEventIDsThrough(ctx context.Context, tx *sql.Tx, afterID, throughID int64, limit int) ([]int64, error) {
	rows, err := tx.QueryContext(ctx, `with live as (
		select id from usage_events where id > ? and id <= ? order by id limit ?
	), archived as (
		select distinct raw_event_id as id from usage_archive_event_refs
		where raw_deleted_at_ms is not null and raw_event_id > ? and raw_event_id <= ?
		order by raw_event_id limit ?
	)
	select id from live union select id from archived order by id limit ?`,
		afterID, throughID, limit, afterID, throughID, limit, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := make([]int64, 0, limit)
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

const statsArchiveColumns = `timestamp_ms, model, requested_model, resolved_model,
	normalized_total_input_tokens, input_tokens, cached_tokens, cache_tokens, cache_read_tokens,
	cache_creation_tokens, auth_provider_snapshot, provider, auth_project_id_snapshot,
	account_snapshot, auth_label_snapshot, auth_account_id_snapshot, auth_index, source,
	source_hash, auth_file_snapshot, api_key_hash, executor_type, service_tier, failed,
	output_tokens, reasoning_tokens, total_tokens, latency_ms`

func statsBatchSource(afterID, throughID int64, archived bool) (string, string, []any) {
	if !archived {
		return "usage_events", "e.id > ? and e.id <= ?", []any{afterID, throughID}
	}
	source := `(select id, ` + statsArchiveColumns + ` from usage_events where id > ? and id <= ?
		union all select p.event_id as id, ` + statsArchiveColumns + `
		from usage_monitoring_event_projection_v1 p
		where p.event_id > ? and p.event_id <= ?
			and not exists(select 1 from usage_events e where e.id = p.event_id)
			and exists(select 1 from usage_archive_event_refs r
				where r.raw_deleted_at_ms is not null and r.raw_event_id = p.event_id and r.timestamp_ms = p.timestamp_ms))`
	return source, "1 = 1", []any{afterID, throughID, afterID, throughID}
}

func (r *repository) CheckArchivedStatsRead(ctx context.Context, fromMS, toMS, count int64) error {
	tx, err := r.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return err
	}
	defer tx.Rollback()
	state, _, available, err := statsReadState(ctx, tx)
	if err != nil {
		return err
	}
	if available && (state.Status == "ready" || state.Status == "catching_up") {
		return nil
	}
	var refs int64
	if err := tx.QueryRowContext(ctx, `select count(*) from usage_archive_event_refs
		where timestamp_ms >= ? and timestamp_ms < ? and raw_deleted_at_ms is not null`, fromMS, toMS).Scan(&refs); err != nil {
		return err
	}
	if refs != count {
		return fmt.Errorf("%w: deleted-event coverage and archive references disagree", ErrArchivedStatsSourceUnavailable)
	}
	return validateArchivedStatsRefs(ctx, tx, "r.timestamp_ms >= ? and r.timestamp_ms < ?", true, fromMS, toMS)
}
