package model

// UsageCatchUpCursor persists the pagination cursor for the background usage
// catch-up worker (see internal/worker.UsageCatchUpWorker), so that a
// restarted manager-server resumes rolling-window sync from where it left
// off instead of always re-pulling a fixed lookback window.
type UsageCatchUpCursor struct {
	// Since is the last SyncFromCoreResult.NextSince (or the last completed
	// page's watermark) to resume core's /usage/export since= pagination
	// from. Empty means no successful sync has completed yet.
	Since string `json:"since"`
	// UpdatedAtMS is when this cursor was last advanced.
	UpdatedAtMS int64 `json:"updatedAtMs"`
}

// UsageCatchUpRunStatus records the outcome of the most recent background
// usage catch-up worker run (see internal/worker.UsageCatchUpWorker), so the
// admin panel can surface something more useful than silence when the worker
// succeeds, fails, or finds nothing to do.
type UsageCatchUpRunStatus struct {
	// LastRunAtMS is when the most recent run finished (unix millis).
	LastRunAtMS int64 `json:"lastRunAtMs"`
	// LastAdded is the number of usage_events rows newly inserted by the most
	// recent run (0 for error/skipped/nodata runs).
	LastAdded int `json:"lastAdded"`
	// LastStatus is one of "ok", "error", "skipped", "nodata".
	LastStatus string `json:"lastStatus"`
	// LastError is a short error message when LastStatus == "error"; empty
	// otherwise.
	LastError string `json:"lastError,omitempty"`
	// TotalAdded is the cumulative number of usage_events rows this worker
	// has ever inserted across all runs since this status record began being
	// tracked.
	TotalAdded int64 `json:"totalAdded"`
	// Trigger is what caused the most recent run: "timer" (periodic
	// schedule) or "reconnect" (collector reconnect wake).
	Trigger string `json:"trigger"`
}

// Usage catch-up run status values for UsageCatchUpRunStatus.LastStatus.
const (
	UsageCatchUpStatusOK      = "ok"
	UsageCatchUpStatusError   = "error"
	UsageCatchUpStatusSkipped = "skipped"
	UsageCatchUpStatusNoData  = "nodata"
)

// Usage catch-up run trigger values for UsageCatchUpRunStatus.Trigger.
const (
	UsageCatchUpTriggerTimer     = "timer"
	UsageCatchUpTriggerReconnect = "reconnect"
)
