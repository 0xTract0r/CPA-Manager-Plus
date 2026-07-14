package worker

import (
	"context"
	"errors"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/model"
	usagesvc "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/usage"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/usage"
)

// fakeCatchUpSyncer stands in for *usagesvc.Service in tests: instead of
// hitting a real CPA core /usage/export endpoint, each call inserts a
// caller-supplied batch of events directly into the same store the worker
// reads its cursor from, mirroring SyncFromCore's real behavior (import +
// event_hash dedup) closely enough to exercise the worker's scheduling,
// cursor persistence, and idempotency without any HTTP dependency.
type fakeCatchUpSyncer struct {
	store *store.Store

	mu      sync.Mutex
	calls   []usagesvc.SyncOptions
	pages   []fakeCatchUpPage
	callIdx int
}

type fakeCatchUpPage struct {
	events    []usage.Event
	hasMore   bool
	nextSince string
	err       error
}

func (f *fakeCatchUpSyncer) SyncFromCore(ctx context.Context, opts usagesvc.SyncOptions) (usagesvc.SyncFromCoreResult, error) {
	f.mu.Lock()
	f.calls = append(f.calls, opts)
	idx := f.callIdx
	if idx < len(f.pages) {
		f.callIdx++
	}
	f.mu.Unlock()

	if idx >= len(f.pages) {
		return usagesvc.SyncFromCoreResult{NoHistoricalData: true}, nil
	}
	page := f.pages[idx]
	if page.err != nil {
		return usagesvc.SyncFromCoreResult{}, page.err
	}
	result, err := f.store.InsertEvents(ctx, page.events)
	if err != nil {
		return usagesvc.SyncFromCoreResult{}, err
	}
	return usagesvc.SyncFromCoreResult{
		ImportResult: usagesvc.ImportResult{Added: result.Inserted, Skipped: result.Skipped, Total: len(page.events)},
		HasMore:      page.hasMore,
		NextSince:    page.nextSince,
	}, nil
}

func (f *fakeCatchUpSyncer) Calls() []usagesvc.SyncOptions {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]usagesvc.SyncOptions, len(f.calls))
	copy(out, f.calls)
	return out
}

func newCatchUpTestStore(t *testing.T) *store.Store {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "usage.sqlite"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func testCatchUpEvent(hash string, timestampMS int64) usage.Event {
	return usage.Event{
		EventHash:    hash,
		TimestampMS:  timestampMS,
		Timestamp:    time.UnixMilli(timestampMS).UTC().Format(time.RFC3339Nano),
		Model:        "gpt-a",
		Endpoint:     "POST /v1/chat/completions",
		Method:       "POST",
		Path:         "/v1/chat/completions",
		InputTokens:  1,
		OutputTokens: 1,
		TotalTokens:  2,
		CreatedAtMS:  timestampMS,
	}
}

// TestUsageCatchUpWorkerTimerTriggersSyncFromCore verifies requirement (1):
// the periodic timer (via Start, which fires an immediate first run) invokes
// SyncFromCore and the resulting events land in the store.
func TestUsageCatchUpWorkerTimerTriggersSyncFromCore(t *testing.T) {
	db := newCatchUpTestStore(t)
	syncer := &fakeCatchUpSyncer{
		store: db,
		pages: []fakeCatchUpPage{
			{events: []usage.Event{testCatchUpEvent("catchup-timer-1", 1_800_000_000_000)}},
		},
	}
	worker := NewUsageCatchUpWorker(db, syncer, time.Hour)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	worker.Start(ctx)

	deadline := time.Now().Add(2 * time.Second)
	for {
		events, _, err := db.Counts(ctx)
		if err != nil {
			t.Fatalf("counts: %v", err)
		}
		if events == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("timer-triggered sync did not insert event in time")
		}
		time.Sleep(5 * time.Millisecond)
	}

	if len(syncer.Calls()) == 0 {
		t.Fatal("SyncFromCore was never called")
	}
}

// TestUsageCatchUpWorkerIdempotentAcrossRuns verifies requirement (2):
// running catchUp twice over pages that (re)supply the same event_hash does
// not double-count -- the store's dedup makes a second identical sync a
// no-op for totals, and the cursor still advances so we don't spin forever.
func TestUsageCatchUpWorkerIdempotentAcrossRuns(t *testing.T) {
	db := newCatchUpTestStore(t)
	sharedEvent := testCatchUpEvent("catchup-idempotent-1", 1_800_000_000_000)
	syncer := &fakeCatchUpSyncer{
		store: db,
		pages: []fakeCatchUpPage{
			{events: []usage.Event{sharedEvent}},
		},
	}
	worker := NewUsageCatchUpWorker(db, syncer, time.Hour)
	ctx := context.Background()

	if pending := worker.catchUp(ctx); pending {
		t.Fatal("catchUp() = true, want false on first pass (no HasMore)")
	}
	events, _, err := db.Counts(ctx)
	if err != nil {
		t.Fatalf("counts: %v", err)
	}
	if events != 1 {
		t.Fatalf("events after first catchUp = %d, want 1", events)
	}

	// Re-supply the same event on a second call (simulating an overlapping
	// window pulled again after a restart); cursor persistence means the
	// worker would normally ask for a later since, but even if the same page
	// were replayed, InsertEvents' event_hash dedup must keep the count at 1.
	syncer.mu.Lock()
	syncer.callIdx = 0
	syncer.mu.Unlock()
	if pending := worker.catchUp(ctx); pending {
		t.Fatal("catchUp() = true, want false on second pass")
	}
	events, _, err = db.Counts(ctx)
	if err != nil {
		t.Fatalf("counts: %v", err)
	}
	if events != 1 {
		t.Fatalf("events after second catchUp = %d, want 1 (no duplicate insert)", events)
	}
}

// TestUsageCatchUpWorkerResumesFromPersistedCursor verifies the cursor is
// saved after a successful sync and the next catchUp call resumes from it
// instead of the initial lookback window.
func TestUsageCatchUpWorkerResumesFromPersistedCursor(t *testing.T) {
	db := newCatchUpTestStore(t)
	syncer := &fakeCatchUpSyncer{
		store: db,
		pages: []fakeCatchUpPage{
			{events: []usage.Event{testCatchUpEvent("catchup-cursor-1", 1_800_000_000_000)}, hasMore: true, nextSince: "2026-01-01T00:00:00Z"},
			{events: []usage.Event{testCatchUpEvent("catchup-cursor-2", 1_800_000_001_000)}},
		},
	}
	worker := NewUsageCatchUpWorker(db, syncer, time.Hour)
	// Cap at one page per catchUp() call so this test can observe the
	// mid-backlog cursor checkpoint and the resuming second call, instead of
	// draining both pages in a single invocation.
	worker.maxPages = 1
	ctx := context.Background()

	if pending := worker.catchUp(ctx); !pending {
		t.Fatal("catchUp() = false, want true after first page (HasMore=true)")
	}
	cursor, ok, err := db.LoadUsageCatchUpCursor(ctx)
	if err != nil {
		t.Fatalf("load cursor: %v", err)
	}
	if !ok || cursor.Since != "2026-01-01T00:00:00Z" {
		t.Fatalf("cursor after first page = %#v", cursor)
	}

	// The first-ever call has no persisted cursor, so it resumes from the
	// bounded initial lookback window (a non-empty RFC3339Nano timestamp),
	// not an empty Since.
	calls := syncer.Calls()
	if len(calls) != 1 || calls[0].Since == "" {
		t.Fatalf("unexpected calls after first pass: %#v", calls)
	}

	if pending := worker.catchUp(ctx); pending {
		t.Fatal("catchUp() = true, want false after second page (HasMore=false)")
	}
	calls = syncer.Calls()
	if len(calls) != 2 || calls[1].Since != "2026-01-01T00:00:00Z" {
		t.Fatalf("second call did not resume from persisted cursor: %#v", calls)
	}
}

// TestUsageCatchUpWorkerReconnectWakeTriggersCatchUp verifies requirement
// (3): waking the worker (as the collector's reconnect handler would) causes
// an out-of-cycle catchUp run even though the timer interval has not elapsed.
func TestUsageCatchUpWorkerReconnectWakeTriggersCatchUp(t *testing.T) {
	db := newCatchUpTestStore(t)
	syncer := &fakeCatchUpSyncer{
		store: db,
		pages: []fakeCatchUpPage{
			{events: []usage.Event{testCatchUpEvent("catchup-reconnect-1", 1_800_000_000_000)}},
		},
	}
	// A long interval means the periodic ticker alone would not fire within
	// the test deadline; only the reconnect-triggered Wake() should.
	worker := NewUsageCatchUpWorker(db, syncer, time.Hour)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go worker.loop(ctx)

	// Simulate the collector's reconnect callback firing after Start's
	// initial wake would already have been consumed in a real deployment;
	// here we drive it directly to isolate the reconnect trigger.
	worker.Wake()

	deadline := time.Now().Add(2 * time.Second)
	for {
		events, _, err := db.Counts(ctx)
		if err != nil {
			t.Fatalf("counts: %v", err)
		}
		if events == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("Wake() did not trigger catch-up in time")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// TestUsageCatchUpWorkerSkipsWhenSyncerNil verifies Start is a safe no-op
// when the worker is constructed without a usable syncer/store (e.g. core
// connection not configured yet), matching the tolerant behavior other
// workers in this package use.
func TestUsageCatchUpWorkerSkipsWhenSyncerNil(t *testing.T) {
	var worker *UsageCatchUpWorker
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	worker.Start(ctx) // must not panic
}

// TestUsageCatchUpWorkerSingleFlight verifies concurrent catchUp invocations
// (e.g. a Wake() racing the ticker) do not run in parallel against the store.
func TestUsageCatchUpWorkerSingleFlight(t *testing.T) {
	db := newCatchUpTestStore(t)
	var concurrent int32
	var maxConcurrent int32
	syncer := &blockingSyncer{
		before: func() {
			cur := atomic.AddInt32(&concurrent, 1)
			for {
				old := atomic.LoadInt32(&maxConcurrent)
				if cur <= old || atomic.CompareAndSwapInt32(&maxConcurrent, old, cur) {
					break
				}
			}
			time.Sleep(20 * time.Millisecond)
			atomic.AddInt32(&concurrent, -1)
		},
	}
	worker := NewUsageCatchUpWorker(db, syncer, time.Hour)
	ctx := context.Background()

	var wg sync.WaitGroup
	for i := 0; i < 5; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			worker.catchUp(ctx)
		}()
	}
	wg.Wait()

	if got := atomic.LoadInt32(&maxConcurrent); got > 1 {
		t.Fatalf("max concurrent catchUp runs = %d, want <= 1", got)
	}
}

type blockingSyncer struct {
	before func()
}

func (b *blockingSyncer) SyncFromCore(ctx context.Context, opts usagesvc.SyncOptions) (usagesvc.SyncFromCoreResult, error) {
	if b.before != nil {
		b.before()
	}
	return usagesvc.SyncFromCoreResult{NoHistoricalData: true}, nil
}

// TestUsageCatchUpWorkerRecordsOKStatusWithTimerTrigger verifies a
// successful run persists a UsageCatchUpRunStatus with lastStatus="ok",
// the correct lastAdded/totalAdded counts, and trigger="timer" for a
// non-Wake()-triggered run.
func TestUsageCatchUpWorkerRecordsOKStatusWithTimerTrigger(t *testing.T) {
	db := newCatchUpTestStore(t)
	syncer := &fakeCatchUpSyncer{
		store: db,
		pages: []fakeCatchUpPage{
			{events: []usage.Event{testCatchUpEvent("catchup-status-ok-1", 1_800_000_000_000)}},
		},
	}
	worker := NewUsageCatchUpWorker(db, syncer, time.Hour)
	ctx := context.Background()

	if pending := worker.catchUp(ctx); pending {
		t.Fatal("catchUp() = true, want false")
	}

	status, ok, err := db.LoadUsageCatchUpStatus(ctx)
	if err != nil {
		t.Fatalf("load status: %v", err)
	}
	if !ok {
		t.Fatal("status not found after successful run")
	}
	if status.LastStatus != model.UsageCatchUpStatusOK {
		t.Fatalf("lastStatus = %q, want %q", status.LastStatus, model.UsageCatchUpStatusOK)
	}
	if status.LastAdded != 1 {
		t.Fatalf("lastAdded = %d, want 1", status.LastAdded)
	}
	if status.TotalAdded != 1 {
		t.Fatalf("totalAdded = %d, want 1", status.TotalAdded)
	}
	if status.Trigger != model.UsageCatchUpTriggerTimer {
		t.Fatalf("trigger = %q, want %q", status.Trigger, model.UsageCatchUpTriggerTimer)
	}
	if status.LastRunAtMS == 0 {
		t.Fatal("lastRunAtMs = 0, want nonzero")
	}
}

// TestUsageCatchUpWorkerRecordsReconnectTrigger verifies a run triggered via
// Wake() (simulating a collector reconnect) is recorded with
// trigger="reconnect" instead of "timer".
func TestUsageCatchUpWorkerRecordsReconnectTrigger(t *testing.T) {
	db := newCatchUpTestStore(t)
	syncer := &fakeCatchUpSyncer{
		store: db,
		pages: []fakeCatchUpPage{
			{events: []usage.Event{testCatchUpEvent("catchup-status-reconnect-1", 1_800_000_000_000)}},
		},
	}
	worker := NewUsageCatchUpWorker(db, syncer, time.Hour)
	ctx := context.Background()

	worker.Wake()
	if pending := worker.catchUp(ctx); pending {
		t.Fatal("catchUp() = true, want false")
	}

	status, ok, err := db.LoadUsageCatchUpStatus(ctx)
	if err != nil {
		t.Fatalf("load status: %v", err)
	}
	if !ok {
		t.Fatal("status not found after successful run")
	}
	if status.Trigger != model.UsageCatchUpTriggerReconnect {
		t.Fatalf("trigger = %q, want %q", status.Trigger, model.UsageCatchUpTriggerReconnect)
	}
}

// TestUsageCatchUpWorkerRecordsErrorStatus verifies a sync failure (other
// than ErrCoreConnectionNotConfigured) is recorded as lastStatus="error"
// with a non-empty lastError, and does not advance totalAdded.
func TestUsageCatchUpWorkerRecordsErrorStatus(t *testing.T) {
	db := newCatchUpTestStore(t)
	syncer := &fakeCatchUpSyncer{
		store: db,
		pages: []fakeCatchUpPage{
			{err: errors.New("boom: core unreachable")},
		},
	}
	worker := NewUsageCatchUpWorker(db, syncer, time.Hour)
	ctx := context.Background()

	if pending := worker.catchUp(ctx); pending {
		t.Fatal("catchUp() = true, want false")
	}

	status, ok, err := db.LoadUsageCatchUpStatus(ctx)
	if err != nil {
		t.Fatalf("load status: %v", err)
	}
	if !ok {
		t.Fatal("status not found after failed run")
	}
	if status.LastStatus != model.UsageCatchUpStatusError {
		t.Fatalf("lastStatus = %q, want %q", status.LastStatus, model.UsageCatchUpStatusError)
	}
	if status.LastError == "" {
		t.Fatal("lastError = \"\", want non-empty error message")
	}
	if status.TotalAdded != 0 {
		t.Fatalf("totalAdded = %d, want 0", status.TotalAdded)
	}
}

// TestUsageCatchUpWorkerRecordsSkippedStatusWhenCoreNotConfigured verifies
// ErrCoreConnectionNotConfigured (an expected, non-noisy condition during
// initial setup) is recorded as lastStatus="skipped" rather than "error".
func TestUsageCatchUpWorkerRecordsSkippedStatusWhenCoreNotConfigured(t *testing.T) {
	db := newCatchUpTestStore(t)
	syncer := &fakeCatchUpSyncer{
		store: db,
		pages: []fakeCatchUpPage{
			{err: usagesvc.ErrCoreConnectionNotConfigured},
		},
	}
	worker := NewUsageCatchUpWorker(db, syncer, time.Hour)
	ctx := context.Background()

	if pending := worker.catchUp(ctx); pending {
		t.Fatal("catchUp() = true, want false")
	}

	status, ok, err := db.LoadUsageCatchUpStatus(ctx)
	if err != nil {
		t.Fatalf("load status: %v", err)
	}
	if !ok {
		t.Fatal("status not found after skipped run")
	}
	if status.LastStatus != model.UsageCatchUpStatusSkipped {
		t.Fatalf("lastStatus = %q, want %q", status.LastStatus, model.UsageCatchUpStatusSkipped)
	}
}

// TestUsageCatchUpWorkerRecordsNoDataStatus verifies core reporting no
// historical data (e.g. UsageStatisticsEnabled=false on core) is recorded as
// lastStatus="nodata".
func TestUsageCatchUpWorkerRecordsNoDataStatus(t *testing.T) {
	db := newCatchUpTestStore(t)
	syncer := &fakeCatchUpSyncer{store: db, pages: []fakeCatchUpPage{}}
	worker := NewUsageCatchUpWorker(db, syncer, time.Hour)
	ctx := context.Background()

	if pending := worker.catchUp(ctx); pending {
		t.Fatal("catchUp() = true, want false")
	}

	status, ok, err := db.LoadUsageCatchUpStatus(ctx)
	if err != nil {
		t.Fatalf("load status: %v", err)
	}
	if !ok {
		t.Fatal("status not found after nodata run")
	}
	if status.LastStatus != model.UsageCatchUpStatusNoData {
		t.Fatalf("lastStatus = %q, want %q", status.LastStatus, model.UsageCatchUpStatusNoData)
	}
}

// TestUsageCatchUpWorkerAccumulatesTotalAddedAcrossRuns verifies
// TotalAdded is cumulative across multiple successful runs rather than being
// reset to the latest run's LastAdded.
func TestUsageCatchUpWorkerAccumulatesTotalAddedAcrossRuns(t *testing.T) {
	db := newCatchUpTestStore(t)
	syncer := &fakeCatchUpSyncer{
		store: db,
		pages: []fakeCatchUpPage{
			{events: []usage.Event{testCatchUpEvent("catchup-total-1", 1_800_000_000_000)}, hasMore: true, nextSince: "2026-01-01T00:00:00Z"},
			{events: []usage.Event{testCatchUpEvent("catchup-total-2", 1_800_000_001_000)}},
		},
	}
	worker := NewUsageCatchUpWorker(db, syncer, time.Hour)
	worker.maxPages = 1
	ctx := context.Background()

	if pending := worker.catchUp(ctx); !pending {
		t.Fatal("catchUp() = false, want true after first page (HasMore=true)")
	}
	if pending := worker.catchUp(ctx); pending {
		t.Fatal("catchUp() = true, want false after second page")
	}

	status, ok, err := db.LoadUsageCatchUpStatus(ctx)
	if err != nil {
		t.Fatalf("load status: %v", err)
	}
	if !ok {
		t.Fatal("status not found")
	}
	if status.TotalAdded != 2 {
		t.Fatalf("totalAdded = %d, want 2 (1 from each page/run)", status.TotalAdded)
	}
}
