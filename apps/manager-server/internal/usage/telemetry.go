package usage

import "encoding/json"

// Telemetry 仅透传明确允许的观测字段，不暴露任意上游正文。
type Telemetry struct {
	FastContext            *FastContext `json:"fast_context,omitempty"`
	FirstVisibleContentMS  *int64       `json:"first_visible_content_ms,omitempty"`
	LastVisibleContentMS   *int64       `json:"last_visible_content_ms,omitempty"`
	VisibleContentEvents   *int64       `json:"visible_content_events,omitempty"`
	VisibleContentObserved bool         `json:"visible_content_observed,omitempty"`
	OutputReasoningSubset  bool         `json:"output_reasoning_subset,omitempty"`
	Version                int          `json:"version,omitempty"`
	AttemptID              string       `json:"attempt_id,omitempty"`
	RequestID              string       `json:"request_id,omitempty"`
	StartedAtMS            int64        `json:"started_at_ms,omitempty"`
	EndedAtMS              int64        `json:"ended_at_ms,omitempty"`
	Transport              string       `json:"transport,omitempty"`
	ObservationKind        string       `json:"observation_kind,omitempty"`
	ObservedStages         []string     `json:"observed_stages,omitempty"`
	ConnectMS              *int64       `json:"connect_ms,omitempty"`
	TLSMS                  *int64       `json:"tls_ms,omitempty"`
	ResponseHeadersMS      *int64       `json:"response_headers_ms,omitempty"`
	FirstBodyMS            *int64       `json:"first_body_ms,omitempty"`
	FirstContentMS         *int64       `json:"first_content_ms,omitempty"`
	LastContentMS          *int64       `json:"last_content_ms,omitempty"`
	MaxContentGapMS        *int64       `json:"max_content_gap_ms,omitempty"`
	StallDurationMS        *int64       `json:"stall_duration_ms,omitempty"`
	ContentChunks          *int64       `json:"content_chunks,omitempty"`
	StallCount             *int64       `json:"stall_count,omitempty"`
	StallThresholdMS       *int64       `json:"stall_threshold_ms,omitempty"`
	StreamCompleted        *bool        `json:"stream_completed,omitempty"`
	FinishReason           string       `json:"finish_reason,omitempty"`
	FailureKind            string       `json:"failure_kind,omitempty"`
}

func TelemetryFromJSON(raw string) *Telemetry {
	if len(raw) > 16384 {
		return nil
	}
	var t Telemetry
	if json.Unmarshal([]byte(raw), &t) != nil || (t.Version != 1 && t.Version != 2) || t.AttemptID == "" || len(t.AttemptID) > 256 || len(t.RequestID) > 256 {
		return nil
	}
	if t.StartedAtMS < 0 || t.EndedAtMS < 0 || (t.EndedAtMS > 0 && t.StartedAtMS > t.EndedAtMS) || len(t.Transport) > 32 || len(t.ObservationKind) > 64 || len(t.FinishReason) > 128 || len(t.FailureKind) > 64 || len(t.ObservedStages) > 32 {
		return nil
	}
	for _, stage := range t.ObservedStages {
		if len(stage) > 64 {
			return nil
		}
	}
	for _, value := range []*int64{t.FirstVisibleContentMS, t.LastVisibleContentMS, t.VisibleContentEvents, t.ConnectMS, t.TLSMS, t.ResponseHeadersMS, t.FirstBodyMS, t.FirstContentMS, t.LastContentMS, t.MaxContentGapMS, t.StallDurationMS, t.ContentChunks, t.StallCount, t.StallThresholdMS} {
		if value != nil && *value < 0 {
			return nil
		}
	}
	if f := t.FastContext; f != nil {
		switch f.UpstreamRequestServiceTier {
		case "auto", "default", "priority", "flex":
		default:
			f.UpstreamRequestServiceTier = "unknown"
		}
		switch f.TierSource {
		case "client", "account", "both", "default":
		default:
			f.TierSource = "unknown"
		}

		if f.SchemaVersion != 1 || len(f.ClientServiceTier) > 32 || len(f.UpstreamRequestServiceTier) > 32 || len(f.TierSource) > 32 || (f.RequestKind != "serving" && f.RequestKind != "prewarm") {
			t.FastContext = nil
		}
	}
	return &t
}
func TelemetryFromRecord(record map[string]any) *Telemetry {
	b, err := json.Marshal(record["telemetry"])
	if err != nil {
		return nil
	}
	return TelemetryFromJSON(string(b))
}
func TelemetryJSON(t *Telemetry) string {
	if t == nil {
		return ""
	}
	b, err := json.Marshal(t)
	if err != nil {
		return ""
	}
	return string(b)
}
