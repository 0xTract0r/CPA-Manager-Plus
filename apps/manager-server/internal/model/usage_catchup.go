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
