package usage

import (
	"encoding/json"
	"testing"
)

func TestTelemetryAllowlistAndAttemptIdentity(t *testing.T) {
	raw := []byte(`{"request_id":"r","timestamp":"2026-09-10T00:00:00Z","model":"resolved-a","alias":"alias","tokens":{"output_tokens":10},"telemetry":{"version":1,"attempt_id":"a","request_id":"r","transport":"http","started_at_ms":1000,"ended_at_ms":2000,"authorization":"secret-value","response_body":"secret-body"}}`)
	e, err := NormalizeRaw(raw)
	if err != nil {
		t.Fatal(err)
	}
	if e.Telemetry == nil {
		t.Fatal("telemetry missing")
	}
	safe := TelemetryJSON(e.Telemetry)
	var fields map[string]any
	if err := json.Unmarshal([]byte(safe), &fields); err != nil {
		t.Fatal(err)
	}
	if fields["authorization"] != nil || fields["response_body"] != nil {
		t.Fatal("unknown fields leaked")
	}
	split := e
	split.ResolvedModel = "resolved-b"
	if buildEventHash(e) == buildEventHash(split) {
		t.Fatal("split billing lost")
	}
	retry := e
	copyT := *e.Telemetry
	copyT.AttemptID = "b"
	retry.Telemetry = &copyT
	if buildEventHash(e) == buildEventHash(retry) {
		t.Fatal("retry lost")
	}
	otherDisplay := e
	otherDisplay.Model = "different-display"
	if buildEventHash(e) != buildEventHash(otherDisplay) {
		t.Fatal("same attempt changed hash by alias")
	}
	if TelemetryFromJSON(`{"version":3,"attempt_id":"x"}`) != nil || TelemetryFromJSON(`broken`) != nil {
		t.Fatal("invalid version accepted")
	}
}

func TestTelemetryRealtimeExportDedup(t *testing.T) {
	raw := []byte(`{"request_id":"r","timestamp":"2026-09-10T00:00:00Z","model":"resolved-a","alias":"alias","tokens":{"output_tokens":10},"telemetry":{"version":1,"attempt_id":"a","request_id":"r"}}`)
	realtime, err := NormalizeRaw(raw)
	if err != nil {
		t.Fatal(err)
	}
	var detail map[string]any
	if err := json.Unmarshal(raw, &detail); err != nil {
		t.Fatal(err)
	}
	detail["requested_model"] = "alias"
	detail["resolved_model"] = "resolved-a"
	imported, err := eventFromLegacyDetail("masked-key", "", "", "resolved-a", detail, 0)
	if err != nil {
		t.Fatal(err)
	}
	if imported.EventHash != realtime.EventHash || imported.Model != realtime.Model || imported.ResolvedModel != realtime.ResolvedModel || imported.Telemetry == nil {
		t.Fatalf("ingest paths diverged: %+v / %+v", imported, realtime)
	}
	if TelemetryFromJSON(`{"version":1,"attempt_id":"a","first_content_ms":-1}`) != nil {
		t.Fatal("negative observation accepted")
	}
}
