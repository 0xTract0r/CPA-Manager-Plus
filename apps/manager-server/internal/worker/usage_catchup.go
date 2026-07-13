package worker

import (
	"context"
	"errors"
	"log"
	"sync/atomic"
	"time"

	usagesvc "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/usage"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
)

const (
	// defaultUsageCatchUpInterval is used when config.Config.UsageCatchUpInterval
	// is unset (<= 0). It intentionally mirrors the documented default (10m):
	// core's /usage/export retains request-detail history in memory for the
	// life of the process (see internal/usage.RequestStatistics in core --
	// details are only ever appended, never time-evicted, and are persisted
	// wholesale to disk), so a 10-minute rolling catch-up cadence is far
	// inside that retention window and cannot itself lose data to core-side
	// expiry. The only loss vector this worker closes is cpamp's own
	// downtime versus core's 60s redisqueue TTL.
	defaultUsageCatchUpInterval = 10 * time.Minute
	// defaultUsageCatchUpLookback bounds the very first catch-up sync (no
	// persisted cursor yet, e.g. fresh install) so it does not attempt to
	// pull core's entire lifetime history in one page. Subsequent runs
	// resume from the persisted cursor regardless of this value.
	defaultUsageCatchUpLookback = 2 * time.Hour
	defaultUsageCatchUpMaxPages = 20
)

// catchUpSyncer is the subset of usage.Service used by UsageCatchUpWorker.
// It is satisfied by *usagesvc.Service; tests provide a fake implementation
// so the worker's scheduling/dedup/cursor logic can be verified without a
// real CPA core HTTP endpoint.
type catchUpSyncer interface {
	SyncFromCore(ctx context.Context, opts usagesvc.SyncOptions) (usagesvc.SyncFromCoreResult, error)
}

// UsageCatchUpWorker periodically (and on collector reconnect) pulls a
// rolling window of core's /usage/export history into the local usage_events
// store via SyncFromCore, closing the gap left by the collector's 60s
// in-memory redisqueue when cpamp itself is down or disconnected for longer
// than that. It reuses SyncFromCore's event_hash dedup, so it is safe to run
// concurrently with the realtime collector and the manual "sync history"
// action without double-counting.
type UsageCatchUpWorker struct {
	store             *store.Store
	syncer            catchUpSyncer
	wake              chan struct{}
	running           int32
	checkInterval     time.Duration
	continuationDelay time.Duration
	lookback          time.Duration
	maxPages          int
	nowFunc           func() time.Time
}

// NewUsageCatchUpWorker constructs a worker with the given poll interval.
// interval <= 0 falls back to defaultUsageCatchUpInterval.
func NewUsageCatchUpWorker(st *store.Store, syncer catchUpSyncer, interval time.Duration) *UsageCatchUpWorker {
	if interval <= 0 {
		interval = defaultUsageCatchUpInterval
	}
	return &UsageCatchUpWorker{
		store:             st,
		syncer:            syncer,
		wake:              make(chan struct{}, 1),
		checkInterval:     interval,
		continuationDelay: defaultRollupContinuationDelay,
		lookback:          defaultUsageCatchUpLookback,
		maxPages:          defaultUsageCatchUpMaxPages,
		nowFunc:           time.Now,
	}
}

// Start launches the background loop. It is a no-op (never runs) when the
// worker, store, or syncer is nil so callers can construct it unconditionally
// and gate it purely on config.Config.UsageCatchUpEnabled.
func (w *UsageCatchUpWorker) Start(ctx context.Context) {
	if w == nil || w.store == nil || w.syncer == nil {
		return
	}
	go w.loop(ctx)
	w.Wake()
}

// Wake requests an out-of-cycle catch-up run, e.g. right after the collector
// reconnects following a disconnect. It is safe to call frequently: multiple
// wakes before the run starts are coalesced into a single run.
func (w *UsageCatchUpWorker) Wake() {
	if w == nil {
		return
	}
	select {
	case w.wake <- struct{}{}:
	default:
	}
}

func (w *UsageCatchUpWorker) loop(ctx context.Context) {
	runRollupLoop(ctx, w.wake, w.checkInterval, w.continuationDelay, w.catchUp)
}

// catchUp performs one bounded pass of the rolling-window sync: it resumes
// from the persisted cursor (or a bounded initial lookback when there is
// none yet), pages through SyncFromCore while HasMore is true (capped at
// maxPages per invocation to avoid an unbounded single run), and persists the
// resulting cursor after every successful page so a crash mid-catch-up does
// not replay already-synced pages. It returns true when more pages remain
// after hitting the per-invocation page cap, asking the caller (runRollupLoop)
// to schedule a fast continuation so a large backlog drains quickly instead
// of waiting for the next full checkInterval tick.
func (w *UsageCatchUpWorker) catchUp(ctx context.Context) bool {
	if !atomic.CompareAndSwapInt32(&w.running, 0, 1) {
		return false
	}
	defer atomic.StoreInt32(&w.running, 0)

	since := w.resumeCursor(ctx)
	pending := false
	for page := 0; page < w.maxPages; page++ {
		if ctx.Err() != nil {
			return false
		}
		result, err := w.syncer.SyncFromCore(ctx, usagesvc.SyncOptions{Since: since})
		if err != nil {
			if errors.Is(err, usagesvc.ErrCoreConnectionNotConfigured) {
				// Not an error worth logging repeatedly: core connection
				// simply isn't set up yet (e.g. during initial setup).
				return false
			}
			log.Printf("[usage-catchup] sync from core failed: %v", err)
			return false
		}
		if result.NoHistoricalData {
			return false
		}
		if result.HasMore && result.NextSince != "" {
			since = result.NextSince
			w.saveCursor(ctx, since)
			pending = true
			continue
		}
		// Fully caught up: advance the watermark to "now" so the next
		// scheduled run only asks core for events since this run, instead
		// of re-scanning the whole history every cycle.
		since = w.nowFunc().UTC().Format(time.RFC3339Nano)
		w.saveCursor(ctx, since)
		return false
	}
	return pending
}

func (w *UsageCatchUpWorker) resumeCursor(ctx context.Context) string {
	cursor, ok, err := w.store.LoadUsageCatchUpCursor(ctx)
	if err != nil {
		log.Printf("[usage-catchup] load cursor: %v", err)
	}
	if ok && cursor.Since != "" {
		return cursor.Since
	}
	return w.nowFunc().Add(-w.lookback).UTC().Format(time.RFC3339Nano)
}

func (w *UsageCatchUpWorker) saveCursor(ctx context.Context, since string) {
	if err := w.store.SaveUsageCatchUpCursor(ctx, store.UsageCatchUpCursor{
		Since:       since,
		UpdatedAtMS: w.nowFunc().UnixMilli(),
	}); err != nil {
		log.Printf("[usage-catchup] save cursor: %v", err)
	}
}
