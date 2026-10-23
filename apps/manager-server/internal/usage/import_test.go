package usage

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"reflect"
	"strings"
	"testing"
)

const legacyUsageExportFixture = `{
  "version": 1,
  "exported_at": "2026-01-02T03:04:05Z",
  "usage": {
    "total_requests": 2,
    "success_count": 1,
    "failure_count": 1,
    "total_tokens": 66,
    "apis": {
      "POST /v1/chat/completions": {
        "models": {
          "gpt-4o": {
            "details": [
              {
                "timestamp": "2026-01-02T03:04:05Z",
                "source": "alice@example.com",
                "auth_index": "auth-1",
                "tokens": {
                  "input_tokens": 10,
                  "output_tokens": 20,
                  "cached_tokens": 3,
                  "total_tokens": 33
                },
                "failed": false,
                "latency_ms": 123
              },
              {
                "timestamp": "2026-01-02T03:05:05Z",
                "source": "sk-test-secret-value",
                "authIndex": "auth-2",
                "tokens": {
                  "inputTokens": 5,
                  "outputTokens": 6,
                  "reasoningTokens": 7,
                  "cacheTokens": 8
                },
                "failed": true
              }
            ]
          }
        }
      }
    }
  }
}`

func TestParseImportPayloadLegacyUsageExport(t *testing.T) {
	result, err := ParseImportPayload([]byte(legacyUsageExportFixture))
	if err != nil {
		t.Fatalf("parse legacy export: %v", err)
	}
	if result.Format != ImportFormatLegacyExport {
		t.Fatalf("format = %q", result.Format)
	}
	if len(result.Events) != 2 || result.Failed != 0 || result.Unsupported != 0 {
		t.Fatalf("summary = %#v", result)
	}
	if len(result.Warnings) == 0 {
		t.Fatalf("expected legacy warnings")
	}

	first := result.Events[0]
	// Endpoint must be "-", never the apis-map key. In production that key is
	// the raw inbound bearer (the client's API key); persisting it into
	// Endpoint was the bug this fixture now guards against. Method/Path are
	// still derived defensively from the key when it happens to look
	// endpoint-shaped (as this fixture's key does).
	if first.Model != "gpt-4o" || first.Endpoint != "-" {
		t.Fatalf("first event target = %#v", first)
	}
	if first.Method != "POST" || first.Path != "/v1/chat/completions" {
		t.Fatalf("first endpoint parts = %#v", first)
	}
	// The apis-map key ("POST /v1/chat/completions" in this fixture) must be
	// hashed into APIKeyHash using the exact same hashString primitive the
	// realtime path uses (event.go NormalizeRaw: APIKeyHash: hashString(apiKey)),
	// so a legacy-imported event for a given key converges with a
	// realtime-collected event for the same key onto the same APIKeyHash.
	wantAPIKeyHash := hashString("POST /v1/chat/completions")
	if first.APIKeyHash == "" || first.APIKeyHash != wantAPIKeyHash {
		t.Fatalf("first api key hash = %q, want %q", first.APIKeyHash, wantAPIKeyHash)
	}
	if first.Source != "ali***@example.com" || first.AuthIndex != "auth-1" {
		t.Fatalf("first source = %#v", first)
	}
	if first.TotalTokens != 33 || first.LatencyMS == nil || *first.LatencyMS != 123 {
		t.Fatalf("first metrics = %#v", first)
	}
	if strings.Contains(first.RawJSON, "POST /v1/chat/completions") {
		t.Fatalf("raw_json must not embed the apis-map key/endpoint label: %q", first.RawJSON)
	}
	// The legacy detail carries no request_id. The import path must leave
	// RequestID empty (byte-for-byte matching the realtime collector) so the
	// same underlying request hashes identically on both ingest paths and is
	// deduped by the event_hash unique constraint instead of double counted.
	if first.EventHash == "" || first.RequestID != "" {
		t.Fatalf("first ids = %#v", first)
	}

	second := result.Events[1]
	if second.TotalTokens != 18 || !second.Failed || second.AuthIndex != "auth-2" {
		t.Fatalf("second event = %#v", second)
	}

	again, err := ParseImportPayload([]byte(legacyUsageExportFixture))
	if err != nil {
		t.Fatalf("parse legacy export again: %v", err)
	}
	if again.Events[0].EventHash != first.EventHash || again.Events[1].EventHash != second.EventHash {
		t.Fatalf("legacy event hashes are not stable")
	}
}

func TestImportCacheAccountingUsesStructuredSemantics(t *testing.T) {
	tests := []struct {
		name        string
		payload     string
		wantMode    string
		wantInput   int64
		wantTotal   int64
		wantUncache int64
	}{
		{
			name:     "openai compat executor beats claude alias",
			payload:  `{"event_hash":"openai-compat","timestamp_ms":1,"timestamp":"2026-07-15T00:00:00Z","executor_type":"OpenAICompatExecutor","model":"claude-sonnet","tokens":{"input_tokens":100,"cache_read_tokens":20,"cache_creation_tokens":10}}`,
			wantMode: CacheInputModeIncluded, wantInput: 100, wantTotal: 100, wantUncache: 70,
		},
		{
			name:     "claude executor beats grok alias",
			payload:  `{"eventHash":"claude-grok","timestampMs":1,"timestamp":"2026-07-15T00:00:00Z","executorType":"ClaudeExecutor","model":"grok-4","tokens":{"inputTokens":100,"cacheReadTokens":20,"cacheCreationTokens":10}}`,
			wantMode: CacheInputModeSeparate, wantInput: 130, wantTotal: 130, wantUncache: 100,
		},
		{
			name:     "usage object and moonshot provider are included",
			payload:  `{"event_hash":"moonshot","timestamp_ms":1,"timestamp":"2026-07-15T00:00:00Z","provider":"moonshot","model":"claude-alias","usage":{"input_tokens":100,"cache_read_tokens":20,"cache_creation_tokens":10}}`,
			wantMode: CacheInputModeIncluded, wantInput: 100, wantTotal: 100, wantUncache: 70,
		},
		{
			name:     "nested explicit mode and total are preserved",
			payload:  `{"event_hash":"explicit","timestamp_ms":1,"timestamp":"2026-07-15T00:00:00Z","executor_type":"XAIExecutor","model":"grok-4","tokens":{"input_tokens":100,"cache_read_tokens":20,"cache_creation_tokens":10,"cache_input_mode":"separate_from_input","total_tokens":777}}`,
			wantMode: CacheInputModeSeparate, wantInput: 130, wantTotal: 777, wantUncache: 100,
		},
		{
			name:     "explicit total from preserved raw json is retained",
			payload:  `{"event_hash":"raw-explicit","timestamp_ms":1,"timestamp":"2026-07-15T00:00:00Z","executor_type":"XAIExecutor","model":"grok-4","tokens":{"input_tokens":100,"cache_read_tokens":20},"raw_json":"{\"tokens\":{\"total_tokens\":888}}"}`,
			wantMode: CacheInputModeIncluded, wantInput: 100, wantTotal: 888, wantUncache: 80,
		},
		{
			name:     "devin executor with claude alias preserves read included creation separate",
			payload:  `{"event_hash":"devin-import","timestamp_ms":1,"timestamp":"2026-07-15T00:00:00Z","executor_type":"DevinExecutor","provider":"devin","alias":"claude-fable-5-1","model":"claude-fable-5-1","tokens":{"input_tokens":229788,"cache_read_tokens":228021,"cache_creation_tokens":0,"total_tokens":231563}}`,
			wantMode: CacheInputModeReadIncludedCreationSeparate, wantInput: 229788, wantTotal: 231563, wantUncache: 1767,
		},
		{
			name:     "explicit read_included_creation_separate mode is preserved on import",
			payload:  `{"event_hash":"devin-explicit","timestamp_ms":1,"timestamp":"2026-07-15T00:00:00Z","executor_type":"ClaudeExecutor","model":"claude-3-7-sonnet","tokens":{"input_tokens":53,"cache_read_tokens":50,"cache_creation_tokens":14361,"cache_input_mode":"read_included_creation_separate","total_tokens":99999}}`,
			wantMode: CacheInputModeReadIncludedCreationSeparate, wantInput: 14414, wantTotal: 99999, wantUncache: 3,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result, err := ParseImportPayload([]byte(tt.payload))
			if err != nil {
				t.Fatalf("parse import: %v", err)
			}
			if len(result.Events) != 1 {
				t.Fatalf("events = %#v", result.Events)
			}
			event := result.Events[0]
			if event.CacheInputMode != tt.wantMode || event.NormalizedTotalInputTokens != tt.wantInput || event.NormalizedUncachedInputTokens != tt.wantUncache || event.TotalTokens != tt.wantTotal {
				t.Fatalf("event = %#v", event)
			}
			if tt.wantTotal == 777 {
				hints := RawCacheAccountingHintsFromJSON(event.RawJSON)
				if hints.ExplicitMode != CacheInputModeSeparate || !hints.HasExplicitTotal || hints.ExplicitTotal != 777 {
					t.Fatalf("preserved hints = %#v raw=%s", hints, event.RawJSON)
				}
			}
		})
	}
}

func TestParseImportPayloadRejectsLegacySummaryWithoutDetails(t *testing.T) {
	payload := `{
	  "usage": {
	    "total_requests": 1,
	    "apis": {
	      "GET /v1/models": {
	        "models": {
	          "gpt-4o": {
	            "requests": 1
	          }
	        }
	      }
	    }
	  }
	}`
	result, err := ParseImportPayload([]byte(payload))
	if !errors.Is(err, ErrLegacyUsageNoDetails) {
		t.Fatalf("err = %v, result = %#v", err, result)
	}
	if result.Format != ImportFormatLegacyExport || result.Unsupported != 1 {
		t.Fatalf("summary = %#v", result)
	}
}

func TestParseImportPayloadPreservesExportedEventHash(t *testing.T) {
	payload := `{
	  "request_id": "req-1",
	  "event_hash": "stable-hash",
	  "timestamp_ms": 1760000000000,
	  "timestamp": "2025-10-09T08:53:20Z",
	  "model": "gpt-4o",
	  "endpoint": "POST /v1/chat/completions",
	  "source": "m:sk-t...alue",
	  "source_hash": "source-hash",
	  "api_key_hash": "key-hash",
	  "input_tokens": 1,
	  "output_tokens": 2,
	  "total_tokens": 3,
	  "created_at_ms": 1760000000001
	}`
	result, err := ParseImportPayload([]byte(payload))
	if err != nil {
		t.Fatalf("parse exported event: %v", err)
	}
	if result.Format != ImportFormatJSONL || len(result.Events) != 1 {
		t.Fatalf("result = %#v", result)
	}
	event := result.Events[0]
	if event.EventHash != "stable-hash" || event.SourceHash != "source-hash" || event.APIKeyHash != "key-hash" {
		t.Fatalf("event hashes = %#v", event)
	}
}

func TestParseImportPayloadIgnoresNonFiniteOptionalPercentages(t *testing.T) {
	for _, value := range []string{"NaN", "Inf", "+Inf", "-Inf"} {
		t.Run(value, func(t *testing.T) {
			payload := []byte(`{"event_hash":"finite-percentage","timestamp_ms":1,"timestamp":"1970-01-01T00:00:00.001Z","model":"gpt-test","header_quota_used_percent":"` + value + `"}`)
			result, err := ParseImportPayload(payload)
			if err != nil || len(result.Events) != 1 {
				t.Fatalf("parse optional percentage: %#v, %v", result, err)
			}
			if _, err := json.Marshal(result.Events[0]); err != nil {
				t.Fatalf("imported event is not JSON-serializable: %v", err)
			}
			if result.Events[0].HeaderQuotaUsedPercent != nil {
				t.Fatalf("non-finite optional percentage was retained: %v", result.Events[0].HeaderQuotaUsedPercent)
			}
		})
	}
}

func TestParseImportPayloadRejectsUnsupportedArchiveSchemaVersion(t *testing.T) {
	payload := `{
	  "_cpamp_archive_schema_version": 2,
	  "_cpamp_archive_event_id": 1,
	  "event_hash": "future-archive-record",
	  "timestamp_ms": 1760000000000,
	  "timestamp": "2025-10-09T08:53:20Z",
	  "model": "gpt-4o"
	}`
	result, err := ParseImportPayload([]byte(payload))
	if !errors.Is(err, ErrUnsupportedArchiveSchema) {
		t.Fatalf("error = %v, result = %#v", err, result)
	}
	if result.Format != ImportFormatJSONL || result.Failed != 1 || len(result.Events) != 0 {
		t.Fatalf("result = %#v", result)
	}

	consumed := 0
	streamed, streamErr := StreamImportPayload(bytes.NewReader([]byte(payload)), 1, func(events []Event) error {
		consumed += len(events)
		return nil
	})
	if !errors.Is(streamErr, ErrUnsupportedArchiveSchema) {
		t.Fatalf("stream error = %v, result = %#v", streamErr, streamed)
	}
	if streamed.Format != ImportFormatJSONL || streamed.Failed != 1 || streamed.Total != 0 || consumed != 0 {
		t.Fatalf("stream result = %#v, consumed = %d", streamed, consumed)
	}
}

func TestParseImportPayloadPreservesArchiveDerivedAndFlattenedFields(t *testing.T) {
	payload := `{
	  "_cpamp_archive_schema_version": 1,
	  "_cpamp_archive_event_id": 7,
	  "event_hash": "archive-preserve-fields",
	  "timestamp_ms": 1760000000000,
	  "timestamp": "2025-10-09T08:53:20Z",
	  "provider": "codex",
	  "executor_type": "CodexExecutor",
	  "model": "gpt-5.6-sol",
	  "service_tier": "archived-effective",
	  "request_service_tier": "",
	  "response_service_tier": "archived-response",
	  "cache_input_mode": "included_in_input",
	  "input_tokens": 100,
	  "output_tokens": 20,
	  "reasoning_tokens": 3,
	  "cached_tokens": 40,
	  "cache_tokens": 0,
	  "cache_read_tokens": 30,
	  "cache_creation_tokens": 10,
	  "tokens": {
	    "input_tokens": 999,
	    "output_tokens": 999,
	    "reasoning_tokens": 999,
	    "cached_tokens": 999,
	    "cache_tokens": 999,
	    "cache_read_tokens": 999,
	    "cache_creation_tokens": 999,
	    "total_tokens": 999
	  },
	  "normalized_uncached_input_tokens": 11,
	  "normalized_total_input_tokens": 222,
	  "normalized_cache_read_tokens": 33,
	  "normalized_cache_creation_tokens": 44,
	  "total_tokens": 333,
	  "header_quota_recover_at_ms": 1760000010000,
	  "header_quota_used_percent": 87.5,
	  "header_quota_plan_type": "archive-plan",
	  "header_error_kind": "archive-kind",
	  "header_error_code": "archive-code",
	  "header_trace_id": "archive-trace",
	  "failed": 0,
	  "fail_status_code": 0,
	  "fail_summary": "  archived summary  ",
	  "fail_body": "  archived body  ",
	  "raw_json": "  {\"archive\":true}  ",
	  "response_metadata": {
	    "quota": {"recover_at_ms": 999, "used_percent": 1, "plan_type": "metadata-plan"},
	    "errors": {"kind": "metadata-kind", "code": "metadata-code"},
	    "trace": {"primary_trace_id": "metadata-trace"}
	  },
	  "response_metadata_json": " {\"quota\":{\"recover_at_ms\":999,\"used_percent\":1,\"plan_type\":\"metadata-plan\"},\"errors\":{\"kind\":\"metadata-kind\",\"code\":\"metadata-code\"},\"trace\":{\"primary_trace_id\":\"metadata-trace\"},\"future_extension\":{\"value\":\"preserve-me\"}} ",
	  "created_at_ms": 1760000000001
	}`
	result, err := ParseImportPayload([]byte(payload))
	if err != nil {
		t.Fatalf("parse archive record: %v", err)
	}
	if result.Format != ImportFormatJSONL || len(result.Events) != 1 {
		t.Fatalf("result = %#v", result)
	}
	event := result.Events[0]
	if !event.PreserveArchiveDerivedFields ||
		event.InputTokens != 100 ||
		event.OutputTokens != 20 ||
		event.ReasoningTokens != 3 ||
		event.CachedTokens != 40 ||
		event.CacheTokens != 0 ||
		event.CacheReadTokens != 30 ||
		event.CacheCreationTokens != 10 ||
		event.CacheInputMode != CacheInputModeIncluded ||
		event.NormalizedUncachedInputTokens != 11 ||
		event.NormalizedTotalInputTokens != 222 ||
		event.NormalizedCacheReadTokens != 33 ||
		event.NormalizedCacheCreationTokens != 44 ||
		event.TotalTokens != 333 ||
		event.ServiceTier != "archived-effective" ||
		event.RequestServiceTier != "" ||
		event.ResponseServiceTier != "archived-response" {
		t.Fatalf("archive derived fields = %#v", event)
	}
	if event.HeaderQuotaRecoverAtMS != 1760000010000 || event.HeaderQuotaUsedPercent == nil ||
		*event.HeaderQuotaUsedPercent != 87.5 || event.HeaderQuotaPlanType != "archive-plan" ||
		event.HeaderErrorKind != "archive-kind" || event.HeaderErrorCode != "archive-code" ||
		event.HeaderTraceID != "archive-trace" {
		t.Fatalf("archive flattened headers = %#v", event)
	}
	const metadataJSON = ` {"quota":{"recover_at_ms":999,"used_percent":1,"plan_type":"metadata-plan"},"errors":{"kind":"metadata-kind","code":"metadata-code"},"trace":{"primary_trace_id":"metadata-trace"},"future_extension":{"value":"preserve-me"}} `
	if event.ResponseMetadata == nil || event.ResponseMetadataJSON != metadataJSON {
		t.Fatalf("archive response metadata = %#v raw=%q", event.ResponseMetadata, event.ResponseMetadataJSON)
	}
	if event.FailSummary != "  archived summary  " || event.FailBody != "  archived body  " ||
		event.RawJSON != `  {"archive":true}  ` {
		t.Fatalf("archive opaque fields = summary=%q body=%q raw=%q", event.FailSummary, event.FailBody, event.RawJSON)
	}
}

func TestParseImportPayloadRestoresArchiveMetadataCompatibilityCases(t *testing.T) {
	t.Run("legacy v1 without raw metadata JSON", func(t *testing.T) {
		record := minimalArchiveImportRecord("archive-legacy-metadata")
		record["response_metadata"] = map[string]any{
			"trace": map[string]any{"primary_trace_id": "legacy-metadata-trace"},
		}
		record["header_trace_id"] = "stored-flat-trace"
		payload, err := json.Marshal(record)
		if err != nil {
			t.Fatalf("marshal legacy archive record: %v", err)
		}
		result, err := ParseImportPayload(payload)
		if err != nil {
			t.Fatalf("parse legacy archive record: %v", err)
		}
		if len(result.Events) != 1 {
			t.Fatalf("result = %#v", result)
		}
		event := result.Events[0]
		if event.ResponseMetadataJSON != `{"trace":{"primary_trace_id":"legacy-metadata-trace"}}` ||
			event.HeaderTraceID != "stored-flat-trace" {
			t.Fatalf("legacy archive metadata = raw=%q flat=%q", event.ResponseMetadataJSON, event.HeaderTraceID)
		}
	})

	t.Run("empty raw metadata JSON sentinel", func(t *testing.T) {
		record := minimalArchiveImportRecord("archive-empty-metadata")
		record["response_metadata_json"] = ""
		payload, err := json.Marshal(record)
		if err != nil {
			t.Fatalf("marshal empty metadata archive record: %v", err)
		}
		result, err := ParseImportPayload(payload)
		if err != nil {
			t.Fatalf("parse empty metadata archive record: %v", err)
		}
		if len(result.Events) != 1 || result.Events[0].ResponseMetadata != nil || result.Events[0].ResponseMetadataJSON != "" {
			t.Fatalf("empty archive metadata result = %#v", result)
		}
	})
}

func minimalArchiveImportRecord(eventHash string) map[string]any {
	return map[string]any{
		"_cpamp_archive_schema_version":    ArchiveSchemaVersion,
		"_cpamp_archive_event_id":          int64(1),
		"event_hash":                       eventHash,
		"timestamp_ms":                     int64(1760000000000),
		"timestamp":                        "2025-10-09T08:53:20Z",
		"model":                            "gpt-4o",
		"input_tokens":                     int64(1),
		"output_tokens":                    int64(0),
		"reasoning_tokens":                 int64(0),
		"cached_tokens":                    int64(0),
		"cache_tokens":                     int64(0),
		"cache_read_tokens":                int64(0),
		"cache_creation_tokens":            int64(0),
		"normalized_uncached_input_tokens": int64(1),
		"normalized_total_input_tokens":    int64(1),
		"normalized_cache_read_tokens":     int64(0),
		"normalized_cache_creation_tokens": int64(0),
		"total_tokens":                     int64(1),
		"cache_input_mode":                 CacheInputModeIncluded,
		"failed":                           int64(0),
		"fail_status_code":                 int64(0),
		"fail_summary":                     "",
		"fail_body":                        "",
		"raw_json":                         "",
		"header_quota_recover_at_ms":       int64(0),
		"header_quota_used_percent":        nil,
		"created_at_ms":                    int64(1760000000001),
	}
}

func TestParseImportPayloadRejectsInvalidArchiveRecord(t *testing.T) {
	validDerivedFields := `
		  "_cpamp_archive_event_id": 1,
		  "input_tokens": 1,
		  "output_tokens": 0,
		  "reasoning_tokens": 0,
		  "cached_tokens": 0,
		  "cache_tokens": 0,
		  "cache_read_tokens": 0,
		  "cache_creation_tokens": 0,
		  "failed": 0,
		  "fail_status_code": 0,
		  "fail_summary": "",
		  "fail_body": "",
		  "raw_json": "",
		  "created_at_ms": 1760000000001,
		  "cache_input_mode": "included_in_input",
	  "normalized_uncached_input_tokens": 1,
	  "normalized_total_input_tokens": 1,
	  "normalized_cache_read_tokens": 0,
	  "normalized_cache_creation_tokens": 0,
	  "total_tokens": 1,
	  "header_quota_recover_at_ms": 0,
	  "header_quota_used_percent": null`
	tests := []struct {
		name    string
		payload string
	}{
		{
			name: "missing event hash",
			payload: `{
			  "_cpamp_archive_schema_version": 1,
			  "timestamp_ms": 1760000000000,
			  "timestamp": "2025-10-09T08:53:20Z",
			  "model": "gpt-4o",` + validDerivedFields + `
			}`,
		},
		{
			name: "missing normalized total",
			payload: `{
			  "_cpamp_archive_schema_version": 1,
			  "event_hash": "archive-missing-normalized-total",
			  "timestamp_ms": 1760000000000,
			  "timestamp": "2025-10-09T08:53:20Z",
			  "model": "gpt-4o",
			  "cache_input_mode": "included_in_input",
			  "normalized_uncached_input_tokens": 1,
			  "normalized_cache_read_tokens": 0,
			  "normalized_cache_creation_tokens": 0,
			  "total_tokens": 1,
			  "header_quota_recover_at_ms": 0,
			  "header_quota_used_percent": null
			}`,
		},
		{
			name: "invalid cache mode",
			payload: `{
			  "_cpamp_archive_schema_version": 1,
			  "event_hash": "archive-invalid-cache-mode",
			  "timestamp_ms": 1760000000000,
			  "timestamp": "2025-10-09T08:53:20Z",
			  "model": "gpt-4o",
			  "cache_input_mode": "future-mode",
			  "normalized_uncached_input_tokens": 1,
			  "normalized_total_input_tokens": 1,
			  "normalized_cache_read_tokens": 0,
			  "normalized_cache_creation_tokens": 0,
			  "total_tokens": 1,
			  "header_quota_recover_at_ms": 0,
			  "header_quota_used_percent": null
			}`,
		},
		{
			name: "missing input tokens",
			payload: `{
			  "_cpamp_archive_schema_version": 1,
			  "_cpamp_archive_event_id": 1,
			  "event_hash": "archive-missing-input-tokens",
			  "timestamp_ms": 1760000000000,
			  "timestamp": "2025-10-09T08:53:20Z",
			  "model": "gpt-4o",
			  "output_tokens": 0,
			  "reasoning_tokens": 0,
			  "cached_tokens": 0,
			  "cache_tokens": 0,
			  "cache_read_tokens": 0,
			  "cache_creation_tokens": 0,
			  "failed": 0,
			  "fail_status_code": 0,
			  "fail_summary": "",
			  "fail_body": "",
			  "raw_json": "",
			  "created_at_ms": 1760000000001,
			  "cache_input_mode": "included_in_input",
			  "normalized_uncached_input_tokens": 1,
			  "normalized_total_input_tokens": 1,
			  "normalized_cache_read_tokens": 0,
			  "normalized_cache_creation_tokens": 0,
			  "total_tokens": 1,
			  "header_quota_recover_at_ms": 0,
			  "header_quota_used_percent": null
			}`,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result, err := ParseImportPayload([]byte(tt.payload))
			if !errors.Is(err, ErrInvalidArchiveRecord) {
				t.Fatalf("error = %v, result = %#v", err, result)
			}
			if result.Format != ImportFormatJSONL || result.Failed != 1 || len(result.Events) != 0 {
				t.Fatalf("result = %#v", result)
			}
		})
	}
}

func TestParseImportPayloadJSONLCountsBadLines(t *testing.T) {
	payload := `{"timestamp":"2026-01-02T03:04:05Z","model":"gpt-4o","endpoint":"GET /v1/models","tokens":{"input_tokens":1}}
not-json`
	result, err := ParseImportPayload([]byte(payload))
	if err != nil {
		t.Fatalf("parse jsonl: %v", err)
	}
	if result.Format != ImportFormatJSONL || len(result.Events) != 1 || result.Failed != 1 {
		t.Fatalf("result = %#v", result)
	}
}

func TestStreamImportPayloadBatchesJSONLAndCountsBadLines(t *testing.T) {
	var payload strings.Builder
	for index := 0; index < 600; index++ {
		_, _ = fmt.Fprintf(&payload, `{"event_hash":"stream-%d","timestamp_ms":%d,"timestamp":"2026-01-02T03:04:05Z","model":"gpt-4o","endpoint":"GET /v1/models"}`+"\n", index, index+1)
		if index == 300 {
			payload.WriteString("not-json\n")
		}
	}

	var batchSizes []int
	result, err := StreamImportPayload(strings.NewReader(payload.String()), 256, func(events []Event) error {
		batchSizes = append(batchSizes, len(events))
		return nil
	})
	if err != nil {
		t.Fatalf("stream import: %v", err)
	}
	if result.Format != ImportFormatJSONL || result.Total != 600 || result.Failed != 1 {
		t.Fatalf("result = %#v", result)
	}
	if !reflect.DeepEqual(batchSizes, []int{256, 256, 88}) {
		t.Fatalf("batch sizes = %#v", batchSizes)
	}
}

func TestImportBatcherFlushesByRetainedBytes(t *testing.T) {
	largeRawJSON := strings.Repeat("x", 9*1024*1024)
	var batchSizes []int
	batcher := &importBatcher{
		batchSize: 256,
		batch:     make([]Event, 0, 256),
		consume: func(events []Event) error {
			batchSizes = append(batchSizes, len(events))
			return nil
		},
	}
	for index := 0; index < 4; index++ {
		if err := batcher.add(Event{EventHash: fmt.Sprintf("large-%d", index), RawJSON: largeRawJSON}); err != nil {
			t.Fatalf("add large event %d: %v", index, err)
		}
	}
	if err := batcher.flush(); err != nil {
		t.Fatalf("flush final batch: %v", err)
	}
	if !reflect.DeepEqual(batchSizes, []int{3, 1}) || batcher.total != 4 || batcher.batchBytes != 0 {
		t.Fatalf("batch sizes=%#v total=%d bytes=%d", batchSizes, batcher.total, batcher.batchBytes)
	}
}

func TestStreamImportPayloadEnforcesJSONLRecordLimit(t *testing.T) {
	buildRecord := func(size int) []byte {
		t.Helper()
		// Exercise the wire-record limit independently of credential sanitization:
		// megabytes of malformed raw_json otherwise dominate race-instrumented runs.
		prefix := []byte(`{"event_hash":"record-limit","timestamp_ms":1,"timestamp":"2026-01-02T03:04:05Z","model":"gpt-4o","padding":"`)
		suffix := []byte(`"}`)
		if size < len(prefix)+len(suffix) {
			t.Fatalf("record size %d is too small", size)
		}
		record := make([]byte, 0, size)
		record = append(record, prefix...)
		record = append(record, bytes.Repeat([]byte{'x'}, size-len(prefix)-len(suffix))...)
		record = append(record, suffix...)
		return record
	}

	t.Run("accepts exact limit", func(t *testing.T) {
		payload := append(buildRecord(MaxJSONLRecordBytes), '\n')
		consumed := 0
		result, err := StreamImportPayload(bytes.NewReader(payload), 1, func(events []Event) error {
			consumed += len(events)
			return nil
		})
		if err != nil {
			t.Fatalf("stream exact-limit record: %v", err)
		}
		if result.Total != 1 || consumed != 1 {
			t.Fatalf("exact-limit result=%#v consumed=%d", result, consumed)
		}
	})

	t.Run("accepts exact limit after first record", func(t *testing.T) {
		first := []byte(`{"event_hash":"record-first","timestamp_ms":1,"timestamp":"2026-01-02T03:04:05Z","model":"gpt-4o"}`)
		payload := make([]byte, 0, len(first)+1+MaxJSONLRecordBytes+1)
		payload = append(payload, first...)
		payload = append(payload, '\n')
		payload = append(payload, buildRecord(MaxJSONLRecordBytes)...)
		payload = append(payload, '\n')
		consumed := 0
		result, err := StreamImportPayload(bytes.NewReader(payload), 1, func(events []Event) error {
			consumed += len(events)
			return nil
		})
		if err != nil {
			t.Fatalf("stream later exact-limit record: %v", err)
		}
		if result.Total != 2 || consumed != 2 {
			t.Fatalf("later exact-limit result=%#v consumed=%d", result, consumed)
		}
	})

	t.Run("accepts exact limit with CRLF", func(t *testing.T) {
		payload := append(buildRecord(MaxJSONLRecordBytes), '\r', '\n')
		result, err := StreamImportPayload(bytes.NewReader(payload), 1, func([]Event) error { return nil })
		if err != nil {
			t.Fatalf("stream exact-limit CRLF record: %v", err)
		}
		if result.Total != 1 {
			t.Fatalf("exact-limit CRLF result = %#v", result)
		}
	})

	t.Run("accepts exact limit after blank line", func(t *testing.T) {
		payload := append([]byte{'\n'}, buildRecord(MaxJSONLRecordBytes)...)
		payload = append(payload, '\n')
		result, err := StreamImportPayload(bytes.NewReader(payload), 1, func([]Event) error { return nil })
		if err != nil {
			t.Fatalf("stream exact-limit record after blank line: %v", err)
		}
		if result.Total != 1 {
			t.Fatalf("blank-line exact-limit result = %#v", result)
		}
	})

	for _, test := range []struct {
		name    string
		payload func() []byte
	}{
		{
			name: "leading space",
			payload: func() []byte {
				payload := append([]byte{' '}, buildRecord(MaxJSONLRecordBytes)...)
				return append(payload, '\n')
			},
		},
		{
			name: "trailing space",
			payload: func() []byte {
				payload := append(buildRecord(MaxJSONLRecordBytes), ' ')
				return append(payload, '\n')
			},
		},
		{
			name: "trailing carriage return without LF",
			payload: func() []byte {
				return append(buildRecord(MaxJSONLRecordBytes), '\r')
			},
		},
	} {
		t.Run("rejects exact object plus "+test.name, func(t *testing.T) {
			result, err := StreamImportPayload(bytes.NewReader(test.payload()), 1, func([]Event) error {
				t.Fatal("oversized whitespace record reached consumer")
				return nil
			})
			if !errors.Is(err, ErrJSONLRecordTooLarge) {
				t.Fatalf("whitespace record error = %v", err)
			}
			if result.Total != 0 {
				t.Fatalf("whitespace record result = %#v", result)
			}
		})
	}

	for _, test := range []struct {
		name    string
		payload func() []byte
	}{
		{
			name: "leading space",
			payload: func() []byte {
				payload := append([]byte{' '}, buildRecord(MaxJSONLRecordBytes-1)...)
				return append(payload, '\n')
			},
		},
		{
			name: "trailing space with CRLF",
			payload: func() []byte {
				payload := append(buildRecord(MaxJSONLRecordBytes-1), ' ', '\r')
				return append(payload, '\n')
			},
		},
		{
			name: "trailing carriage return without LF",
			payload: func() []byte {
				return append(buildRecord(MaxJSONLRecordBytes-1), '\r')
			},
		},
	} {
		t.Run("accepts full limit including "+test.name, func(t *testing.T) {
			result, err := StreamImportPayload(bytes.NewReader(test.payload()), 1, func([]Event) error { return nil })
			if err != nil {
				t.Fatalf("stream whitespace boundary record: %v", err)
			}
			if result.Total != 1 {
				t.Fatalf("whitespace boundary result = %#v", result)
			}
		})
	}

	t.Run("rejects later exact-limit record plus bare CR", func(t *testing.T) {
		first := []byte(`{"event_hash":"record-first","timestamp_ms":1,"timestamp":"2026-01-02T03:04:05Z","model":"gpt-4o"}`)
		payload := append(append(append([]byte(nil), first...), '\n'), buildRecord(MaxJSONLRecordBytes)...)
		payload = append(payload, '\r')
		consumed := 0
		result, err := StreamImportPayload(bytes.NewReader(payload), 1, func(events []Event) error {
			consumed += len(events)
			return nil
		})
		if !errors.Is(err, ErrJSONLRecordTooLarge) {
			t.Fatalf("later bare-CR record error = %v", err)
		}
		if result.Total != 1 || consumed != 1 {
			t.Fatalf("later bare-CR result=%#v consumed=%d", result, consumed)
		}
	})

	t.Run("rejects first record over limit", func(t *testing.T) {
		payload := append(buildRecord(MaxJSONLRecordBytes+1), '\n')
		result, err := StreamImportPayload(bytes.NewReader(payload), 1, func([]Event) error {
			t.Fatal("oversized record reached consumer")
			return nil
		})
		if !errors.Is(err, ErrJSONLRecordTooLarge) {
			t.Fatalf("oversized record error = %v", err)
		}
		if result.Total != 0 {
			t.Fatalf("oversized record result = %#v", result)
		}
	})

	t.Run("rejects first record over limit from non-seekable reader", func(t *testing.T) {
		pipeReader, pipeWriter := io.Pipe()
		writeDone := make(chan error, 1)
		go func() {
			_, writeErr := pipeWriter.Write(append(buildRecord(MaxJSONLRecordBytes+1), '\n'))
			writeDone <- errors.Join(writeErr, pipeWriter.Close())
		}()
		result, err := StreamImportPayload(pipeReader, 1, func([]Event) error {
			t.Error("oversized non-seekable record reached consumer")
			return nil
		})
		_ = pipeReader.Close()
		writeErr := <-writeDone
		if writeErr != nil && !errors.Is(writeErr, io.ErrClosedPipe) {
			t.Fatalf("write non-seekable record: %v", writeErr)
		}
		if !errors.Is(err, ErrJSONLRecordTooLarge) {
			t.Fatalf("non-seekable oversized record error = %v", err)
		}
		if result.Total != 0 {
			t.Fatalf("non-seekable oversized record result = %#v", result)
		}
	})

	for _, test := range []struct {
		name       string
		terminator string
	}{
		{name: "with LF", terminator: "\n"},
		{name: "without newline"},
	} {
		t.Run("rejects later record over limit "+test.name, func(t *testing.T) {
			first := []byte(`{"event_hash":"record-first","timestamp_ms":1,"timestamp":"2026-01-02T03:04:05Z","model":"gpt-4o"}`)
			payload := make([]byte, 0, len(first)+1+MaxJSONLRecordBytes+2)
			payload = append(payload, first...)
			payload = append(payload, '\n')
			payload = append(payload, buildRecord(MaxJSONLRecordBytes+1)...)
			payload = append(payload, test.terminator...)
			consumed := 0
			result, err := StreamImportPayload(bytes.NewReader(payload), 1, func(events []Event) error {
				consumed += len(events)
				return nil
			})
			if !errors.Is(err, ErrJSONLRecordTooLarge) {
				t.Fatalf("later oversized record error = %v", err)
			}
			if result.Total != 1 || consumed != 1 {
				t.Fatalf("later oversized result=%#v consumed=%d", result, consumed)
			}
		})
	}

	t.Run("parse rejects later record over limit", func(t *testing.T) {
		first := []byte(`{"event_hash":"record-first","timestamp_ms":1,"timestamp":"2026-01-02T03:04:05Z","model":"gpt-4o"}`)
		payload := append(append(append([]byte(nil), first...), '\n'), buildRecord(MaxJSONLRecordBytes+1)...)
		result, err := ParseImportPayload(payload)
		if !errors.Is(err, ErrJSONLRecordTooLarge) {
			t.Fatalf("parse later oversized record error = %v", err)
		}
		if len(result.Events) != 1 {
			t.Fatalf("parse later oversized result = %#v", result)
		}
	})

	t.Run("rejects oversized top-level array item", func(t *testing.T) {
		payload := append([]byte{'['}, buildRecord(MaxJSONLRecordBytes+1)...)
		payload = append(payload, ']')
		result, err := StreamImportPayload(bytes.NewReader(payload), 1, func([]Event) error {
			t.Fatal("oversized array item reached consumer")
			return nil
		})
		if !errors.Is(err, ErrJSONLRecordTooLarge) {
			t.Fatalf("oversized array item error = %v", err)
		}
		if result.Total != 0 {
			t.Fatalf("oversized array item result = %#v", result)
		}
	})

	t.Run("stops decoding far-oversized top-level array item", func(t *testing.T) {
		record := buildRecord(MaxJSONLRecordBytes + 2*boundedJSONDecoderReadBytes + 1)
		payload := append([]byte{'['}, record...)
		payload = append(payload, ']')
		reader := bytes.NewReader(payload)
		result, err := StreamImportPayload(reader, 1, func([]Event) error {
			t.Fatal("far-oversized array item reached consumer")
			return nil
		})
		if !errors.Is(err, ErrJSONLRecordTooLarge) {
			t.Fatalf("far-oversized array item error = %v", err)
		}
		if result.Total != 0 || reader.Len() == 0 {
			t.Fatalf("far-oversized array result=%#v unread=%d", result, reader.Len())
		}
	})

	t.Run("accepts exact-limit top-level array item", func(t *testing.T) {
		payload := append([]byte{'['}, buildRecord(MaxJSONLRecordBytes)...)
		payload = append(payload, ']')
		consumed := 0
		result, err := StreamImportPayload(bytes.NewReader(payload), 1, func(events []Event) error {
			consumed += len(events)
			return nil
		})
		if err != nil {
			t.Fatalf("exact-limit array item error = %v", err)
		}
		if result.Total != 1 || consumed != 1 {
			t.Fatalf("exact-limit array item result=%#v consumed=%d", result, consumed)
		}
	})
}

func TestStreamImportPayloadStreamsTopLevelArray(t *testing.T) {
	var payload strings.Builder
	payload.WriteByte('[')
	for index := 0; index < 300; index++ {
		if index > 0 {
			payload.WriteByte(',')
		}
		_, _ = fmt.Fprintf(&payload, `{"event_hash":"array-%d","timestamp_ms":%d,"timestamp":"2026-01-02T03:04:05Z","model":"gpt-4o","endpoint":"GET /v1/models"}`, index, index+1)
	}
	payload.WriteByte(']')

	var batchSizes []int
	result, err := StreamImportPayload(strings.NewReader(payload.String()), 256, func(events []Event) error {
		batchSizes = append(batchSizes, len(events))
		return nil
	})
	if err != nil {
		t.Fatalf("stream import array: %v", err)
	}
	if result.Total != 300 || result.Failed != 0 || !reflect.DeepEqual(batchSizes, []int{256, 44}) {
		t.Fatalf("result = %#v batches = %#v", result, batchSizes)
	}
}

func TestStreamImportPayloadKeepsCompletedBatchesOnLaterConsumerError(t *testing.T) {
	payload := strings.Repeat(`{"timestamp":"2026-01-02T03:04:05Z","model":"gpt-4o","endpoint":"GET /v1/models"}`+"\n", 600)
	completed := 0
	batchCalls := 0
	result, err := StreamImportPayload(strings.NewReader(payload), 256, func(events []Event) error {
		batchCalls++
		if batchCalls == 2 {
			return errors.New("insert failed")
		}
		completed += len(events)
		return nil
	})
	if err == nil || err.Error() != "insert failed" {
		t.Fatalf("error = %v", err)
	}
	if completed != 256 || result.Total != 512 {
		t.Fatalf("completed = %d result = %#v", completed, result)
	}
}

func TestStreamImportPayloadLegacyMatchesExistingParser(t *testing.T) {
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal([]byte(legacyUsageExportFixture), &envelope); err != nil {
		t.Fatalf("decode wrapped fixture: %v", err)
	}
	directFixture := string(envelope["usage"])
	partialFixture := `{
	  "apis": {
	    "bad endpoint": 1,
	    "missing models": {},
	    "GET /v1/models": {
	      "models": {
	        "bad model": 1,
	        "empty details": {"details": []},
	        "gpt-test": {
	          "details": [
	            null,
	            {"source": "missing timestamp"},
	            {"timestamp": "2026-01-02T03:04:05Z", "tokens": {"input_tokens": 1}}
	          ]
	        }
	      }
	    }
	  }
	}`

	for _, test := range []struct {
		name    string
		payload string
	}{
		{name: "wrapped export", payload: legacyUsageExportFixture},
		{name: "direct payload", payload: directFixture},
		{name: "partial records", payload: partialFixture},
		{
			name: "numeric spelling preserves legacy identity",
			payload: `{"apis":{"POST /v1/chat/completions":{"models":{"gpt-test":{"details":[{
			  "timestamp":"2026-01-02T03:04:05Z", "legacy_metric":123.0, "legacy_score":1e2,
			  "tokens":{"input_tokens":100,"output_tokens":20,"total_tokens":120}
			}]}}}}}`,
		},
		{
			name: "integer precision preserves values and identity",
			payload: `{"apis":{"POST /v1/chat/completions":{"models":{"gpt-test":{"details":[{
			  "timestamp":"2026-01-02T03:04:05Z", "request_id":9007199254740993,
			  "tokens":{"input_tokens":9007199254740993,"total_tokens":9007199254740993}
			}]}}}}}`,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			parsed, err := ParseImportPayload([]byte(test.payload))
			if err != nil {
				t.Fatalf("parse legacy payload: %v", err)
			}
			var streamedEvents []Event
			streamed, err := StreamImportPayload(bytes.NewReader([]byte(test.payload)), 1, func(events []Event) error {
				streamedEvents = append(streamedEvents, events...)
				return nil
			})
			if err != nil {
				t.Fatalf("stream legacy payload: %v", err)
			}
			if streamed.Format != parsed.Format || streamed.Total != len(parsed.Events) ||
				streamed.Failed != parsed.Failed || streamed.Unsupported != parsed.Unsupported ||
				!reflect.DeepEqual(streamed.Warnings, parsed.Warnings) {
				t.Fatalf("streamed = %#v parsed = %#v", streamed, parsed)
			}
			if len(streamedEvents) != len(parsed.Events) {
				t.Fatalf("streamed events = %d parsed events = %d", len(streamedEvents), len(parsed.Events))
			}
			for index := range parsed.Events {
				want := parsed.Events[index]
				got := streamedEvents[index]
				want.CreatedAtMS = 0
				got.CreatedAtMS = 0
				if !reflect.DeepEqual(got, want) {
					t.Fatalf("event %d differs\nstreamed: %#v\nparsed:   %#v", index, got, want)
				}
			}
		})
	}
}

func TestStreamImportPayloadLegacyDeliversBatchesBeforeSecondPassEOF(t *testing.T) {
	payload := buildLargeLegacyStreamFixture(600, 1024)
	reader := &trackingReadSeeker{Reader: bytes.NewReader([]byte(payload)), pass: 1}
	consumerErr := errors.New("insert failed")
	batchCalls := 0
	firstBatchPass := 0
	firstBatchPosition := int64(0)
	result, err := StreamImportPayload(reader, 256, func(events []Event) error {
		batchCalls++
		if batchCalls == 1 {
			firstBatchPass = reader.pass
			firstBatchPosition = reader.position
		}
		if batchCalls == 2 {
			return consumerErr
		}
		return nil
	})
	if !errors.Is(err, consumerErr) {
		t.Fatalf("error = %v, want %v", err, consumerErr)
	}
	if result.Format != ImportFormatLegacyExport || result.Total != 512 || batchCalls != 2 {
		t.Fatalf("result = %#v batch calls = %d", result, batchCalls)
	}
	if firstBatchPass != 2 {
		t.Fatalf("first batch pass = %d, want second pass", firstBatchPass)
	}
	if firstBatchPosition <= 0 || firstBatchPosition >= int64(len(payload)) {
		t.Fatalf("first batch position = %d payload size = %d", firstBatchPosition, len(payload))
	}
}

func TestStreamImportPayloadKeepsLargeLegacyObjectsCompatibleOnNonSeekableReaders(t *testing.T) {
	payload := buildLargeLegacyStreamFixture(1_100, 10_000)
	if len(payload) <= MaxJSONLRecordBytes {
		t.Fatalf("legacy fixture size=%d, want greater than %d", len(payload), MaxJSONLRecordBytes)
	}
	reader := nonSeekableImportReader{Reader: strings.NewReader(payload)}
	consumed := 0
	result, err := StreamImportPayload(reader, 256, func(events []Event) error {
		consumed += len(events)
		return nil
	})
	if err != nil {
		t.Fatalf("stream large non-seekable legacy payload: %v", err)
	}
	if result.Format != ImportFormatLegacyExport || result.Total != 1_100 || consumed != 1_100 {
		t.Fatalf("result=%#v consumed=%d", result, consumed)
	}
}

func TestStreamImportPayloadRejectsOversizedLegacyDetail(t *testing.T) {
	payload := buildLargeLegacyStreamFixture(1, MaxJSONLRecordBytes)
	result, err := StreamImportPayload(bytes.NewReader([]byte(payload)), 1, func([]Event) error {
		t.Fatal("oversized legacy detail reached consumer")
		return nil
	})
	if !errors.Is(err, ErrJSONLRecordTooLarge) {
		t.Fatalf("oversized legacy detail error = %v", err)
	}
	if result.Total != 0 {
		t.Fatalf("oversized legacy detail result = %#v", result)
	}
}

func TestInspectLegacyStreamShapeRejectsUnboundedStructuralMetadata(t *testing.T) {
	payload := `{"usage":{"apis":{"endpoint-a":{"models":{"model-a":{"details":[]}}},"endpoint-b":{"models":{"model-b":{"details":[]}}}}}}`
	tests := []struct {
		name   string
		limits legacyStreamShapeLimits
	}{
		{
			name:   "key count",
			limits: legacyStreamShapeLimits{maxKeys: 3, maxKeyBytes: 1024},
		},
		{
			name:   "key bytes",
			limits: legacyStreamShapeLimits{maxKeys: 100, maxKeyBytes: 20},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			shape, err := inspectLegacyStreamShapeWithLimits(strings.NewReader(payload), test.limits)
			if !errors.Is(err, ErrLegacyShapeTooLarge) {
				t.Fatalf("error = %v, shape = %#v", err, shape)
			}
		})
	}
}

func TestCaptureJSONObjectWithLimitsSpoolsNestedObjectAndRemovesFile(t *testing.T) {
	tempDir := t.TempDir()
	object := `{"outer":{"message":"closing } and opening { with escaped quote \" still inside","items":[{"ok":true}]}}`
	reader := bufio.NewReaderSize(strings.NewReader(object+"\nnext"), 16)
	captured, err := captureJSONObjectWithLimits(reader, jsonObjectCaptureLimits{
		memoryBytes: 16,
		maxBytes:    1024,
		tempDir:     tempDir,
	})
	if err != nil {
		t.Fatalf("capture object: %v", err)
	}
	if captured.file == nil {
		t.Fatal("expected captured object to use a temporary file")
	}
	path := captured.file.Name()
	if captured.Size() != int64(len(object)) {
		t.Fatalf("captured size = %d, want %d", captured.Size(), len(object))
	}
	replay, err := captured.Reader()
	if err != nil {
		t.Fatalf("open captured reader: %v", err)
	}
	got, err := io.ReadAll(replay)
	if err != nil {
		t.Fatalf("read captured object: %v", err)
	}
	if string(got) != object {
		t.Fatalf("captured object = %q, want %q", got, object)
	}
	remaining, err := io.ReadAll(reader)
	if err != nil {
		t.Fatalf("read remaining input: %v", err)
	}
	if string(remaining) != "\nnext" {
		t.Fatalf("remaining input = %q", remaining)
	}
	if err := captured.Close(); err != nil {
		t.Fatalf("close captured object: %v", err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("temporary file still exists or stat failed: %v", err)
	}
	if err := captured.Close(); err != nil {
		t.Fatalf("close captured object again: %v", err)
	}
}

func TestCaptureJSONObjectWithLimitsCleansTemporaryFileOnFailure(t *testing.T) {
	tests := []struct {
		name    string
		payload string
		wantErr error
	}{
		{
			name:    "object exceeds maximum",
			payload: `{"payload":"` + strings.Repeat("x", 64) + `"}`,
			wantErr: ErrImportObjectTooLarge,
		},
		{
			name:    "object ends before closing delimiter",
			payload: `{"payload":"` + strings.Repeat("x", 32),
			wantErr: io.ErrUnexpectedEOF,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			tempDir := t.TempDir()
			captured, err := captureJSONObjectWithLimits(
				bufio.NewReaderSize(strings.NewReader(test.payload), 16),
				jsonObjectCaptureLimits{memoryBytes: 8, maxBytes: 48, tempDir: tempDir},
			)
			if !errors.Is(err, test.wantErr) {
				t.Fatalf("capture error = %v, want %v", err, test.wantErr)
			}
			if captured != nil {
				t.Fatalf("captured object = %#v, want nil", captured)
			}
			entries, readErr := os.ReadDir(tempDir)
			if readErr != nil {
				t.Fatalf("read temporary directory: %v", readErr)
			}
			if len(entries) != 0 {
				t.Fatalf("temporary directory contains %d entries after failure", len(entries))
			}
		})
	}
}

func TestStreamImportPayloadKeepsExportedEventPrecedenceOverNestedUsage(t *testing.T) {
	payload := `{
	  "event_hash": "exported-event",
	  "timestamp_ms": 1,
	  "timestamp": "2026-01-02T03:04:05Z",
	  "model": "gpt-test",
	  "usage": {
	    "apis": {
	      "GET /v1/models": {
	        "models": {
	          "legacy-model": {
	            "details": [{"timestamp": "2026-01-02T03:04:05Z"}]
	          }
	        }
	      }
	    }
	  }
	}`
	var events []Event
	result, err := StreamImportPayload(bytes.NewReader([]byte(payload)), 256, func(batch []Event) error {
		events = append(events, batch...)
		return nil
	})
	if err != nil {
		t.Fatalf("stream exported event: %v", err)
	}
	if result.Format != ImportFormatJSONL || result.Total != 1 || len(events) != 1 ||
		events[0].EventHash != "exported-event" || events[0].Model != "gpt-test" {
		t.Fatalf("result = %#v events = %#v", result, events)
	}
}

func TestStreamImportPayloadKeepsUsageFieldPrecedenceOverDirectAPIs(t *testing.T) {
	payload := `{
	  "usage": {"total_requests": 1},
	  "apis": {
	    "GET /v1/models": {
	      "models": {
	        "gpt-test": {
	          "details": [{"timestamp": "2026-01-02T03:04:05Z"}]
	        }
	      }
	    }
	  }
	}`
	result, err := StreamImportPayload(bytes.NewReader([]byte(payload)), 256, func([]Event) error { return nil })
	if !errors.Is(err, ErrLegacyUsageNoDetails) {
		t.Fatalf("error = %v result = %#v", err, result)
	}
	if result.Format != ImportFormatLegacyExport || result.Total != 0 || result.Unsupported != 1 {
		t.Fatalf("result = %#v", result)
	}
}

type trackingReadSeeker struct {
	*bytes.Reader
	pass     int
	position int64
}

type nonSeekableImportReader struct {
	io.Reader
}

func (r *trackingReadSeeker) Read(buffer []byte) (int, error) {
	read, err := r.Reader.Read(buffer)
	r.position += int64(read)
	return read, err
}

func (r *trackingReadSeeker) Seek(offset int64, whence int) (int64, error) {
	position, err := r.Reader.Seek(offset, whence)
	if err != nil {
		return 0, err
	}
	r.position = position
	if whence == io.SeekStart && offset == 0 {
		r.pass++
	}
	return position, nil
}

func buildLargeLegacyStreamFixture(details int, paddingBytes int) string {
	var payload strings.Builder
	payload.WriteString(`{"usage":{"apis":{"GET /v1/models":{"models":{"gpt-test":{"details":[`)
	padding := strings.Repeat("x", paddingBytes)
	for index := 0; index < details; index++ {
		if index > 0 {
			payload.WriteByte(',')
		}
		_, _ = fmt.Fprintf(
			&payload,
			`{"timestamp":"2026-01-02T03:04:05Z","request_id":"legacy-%d","padding":%q}`,
			index,
			padding,
		)
	}
	payload.WriteString(`]}}}}}}`)
	return payload.String()
}

func TestParseImportPayloadPreservesAuthProjectIDSnapshot(t *testing.T) {
	payload := `{
	  "event_hash": "hash-project",
	  "timestamp_ms": 1760000000000,
	  "timestamp": "2025-10-09T08:53:20Z",
	  "model": "gemini-2.5",
	  "endpoint": "POST /v1/chat/completions",
	  "auth_project_id_snapshot": "vertex-project-42",
	  "input_tokens": 1,
	  "total_tokens": 1
	}`
	result, err := ParseImportPayload([]byte(payload))
	if err != nil {
		t.Fatalf("parse exported event: %v", err)
	}
	if len(result.Events) != 1 {
		t.Fatalf("result = %#v", result)
	}
	if got := result.Events[0].AuthProjectIDSnapshot; got != "vertex-project-42" {
		t.Fatalf("auth_project_id_snapshot = %q", got)
	}
}

func TestNormalizeRawReadsProjectID(t *testing.T) {
	payload := `{
	  "timestamp": "2026-05-19T10:00:00Z",
	  "model": "gemini-2.5",
	  "endpoint": "POST /v1/chat/completions",
	  "project_id": "vertex-project-42",
	  "input_tokens": 1,
	  "total_tokens": 1
	}`
	event, err := NormalizeRaw([]byte(payload))
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	if event.AuthProjectIDSnapshot != "vertex-project-42" {
		t.Fatalf("auth_project_id_snapshot = %q", event.AuthProjectIDSnapshot)
	}
}

func TestNormalizeRawReadsCPA7118UsageFields(t *testing.T) {
	payload := `{
	  "timestamp": "2026-04-25T00:00:00Z",
	  "latency_ms": 1500,
	  "ttft_ms": 450,
	  "source": "user@example.com",
	  "auth_index": "0",
	  "tokens": {
	    "input_tokens": 10,
	    "output_tokens": 20,
	    "reasoning_tokens": 3,
	    "cached_tokens": 5,
	    "cache_read_tokens": 4,
	    "cache_creation_tokens": 1,
	    "total_tokens": 33
	  },
	  "failed": true,
	  "fail": {
	    "status_code": 429,
	    "body": "rate limit exceeded"
	  },
	  "provider": "openai",
	  "model": "gpt-5.4",
	  "alias": "client-gpt",
	  "endpoint": "POST /v1/chat/completions",
	  "auth_type": "apikey",
	  "api_key": "test-key",
	  "request_id": "ctx-request-id",
	  "reasoning_effort": "medium",
	  "service_tier": "priority",
	  "executor_type": "codex",
	  "response_headers": {
	    "Retry-After": ["30"]
	  }
	}`
	event, err := NormalizeRaw([]byte(payload))
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	if event.RequestID != "ctx-request-id" || event.ReasoningEffort != "medium" ||
		event.ServiceTier != "priority" || event.ExecutorType != "codex" {
		t.Fatalf("event identity/metadata = %#v", event)
	}
	if event.InputTokens != 10 || event.OutputTokens != 20 || event.ReasoningTokens != 3 ||
		event.CachedTokens != 5 || event.CacheReadTokens != 4 || event.CacheCreationTokens != 1 ||
		event.TotalTokens != 33 {
		t.Fatalf("event tokens = %#v", event)
	}
	if !event.Failed || event.FailStatusCode != 429 ||
		!strings.Contains(event.FailBody, "rate limit exceeded") ||
		strings.Contains(event.FailBody, "Retry-After") {
		t.Fatalf("event failure = %#v", event)
	}
	if !strings.Contains(event.FailSummary, "rate limit exceeded") || strings.Contains(event.FailSummary, "Retry-After") {
		t.Fatalf("fail summary = %q", event.FailSummary)
	}
	if event.ResponseMetadata == nil || event.ResponseMetadata.Errors == nil ||
		event.ResponseMetadata.Errors.RetryAfterSeconds == nil ||
		*event.ResponseMetadata.Errors.RetryAfterSeconds != 30 {
		t.Fatalf("response metadata = %#v", event.ResponseMetadata)
	}
	if event.LatencyMS == nil || *event.LatencyMS != 1500 {
		t.Fatalf("latency = %#v", event.LatencyMS)
	}
	if event.TTFTMS == nil || *event.TTFTMS != 450 {
		t.Fatalf("ttft = %#v", event.TTFTMS)
	}

	legacyPayload := BuildPayload([]Event{event})
	api := legacyPayload.APIs["POST /v1/chat/completions"]
	if api == nil {
		t.Fatalf("missing endpoint aggregate")
	}
	modelEntry := api.Models["client-gpt"]
	if modelEntry == nil || len(modelEntry.Details) != 1 {
		t.Fatalf("model details = %#v", api.Models)
	}
	detail := modelEntry.Details[0]
	if detail.ReasoningEffort != "medium" || detail.ServiceTier != "priority" ||
		detail.ExecutorType != "codex" || detail.Tokens.CacheReadTokens != 4 ||
		detail.Tokens.CacheCreationTokens != 1 || detail.FailStatusCode != 429 ||
		detail.Tokens.CachedTokens != 0 || detail.Tokens.CacheTokens != 0 ||
		!strings.Contains(detail.FailSummary, "rate limit exceeded") ||
		strings.Contains(detail.FailSummary, "Retry-After") || detail.ResponseMetadata == nil ||
		detail.ResponseMetadata.Errors == nil || detail.TTFTMS == nil ||
		*detail.TTFTMS != 450 {
		t.Fatalf("detail = %#v", detail)
	}
}

func TestNormalizeRawKeepsSuccessfulResponseHeadersOutOfFailureFields(t *testing.T) {
	marker := strings.Repeat("large-success-header-marker-", 256)
	payload, err := json.Marshal(map[string]any{
		"timestamp": "2026-04-25T00:00:00Z",
		"source":    "user@example.com",
		"tokens": map[string]any{
			"input_tokens": 1,
			"total_tokens": 1,
		},
		"failed":   false,
		"provider": "openai",
		"model":    "gpt-5.4",
		"endpoint": "POST /v1/chat/completions",
		"response_headers": map[string]any{
			"Content-Type":                 []any{"application/json"},
			"X-CPAMP-Unindexed-Diagnostic": []any{marker},
		},
	})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}

	event, err := NormalizeRaw(payload)
	if err != nil {
		t.Fatalf("normalize successful response: %v", err)
	}
	if event.Failed || event.FailBody != "" || event.FailSummary != "" {
		t.Fatalf("successful failure fields = failed:%v body:%q summary:%q", event.Failed, event.FailBody, event.FailSummary)
	}
	if event.ResponseMetadata == nil || event.ResponseMetadata.Response == nil ||
		event.ResponseMetadata.Response.ContentType != "application/json" || event.ResponseMetadataJSON == "" {
		t.Fatalf("response metadata = %#v json=%q", event.ResponseMetadata, event.ResponseMetadataJSON)
	}
	if !strings.Contains(event.RawJSON, marker) {
		t.Fatalf("raw json did not preserve response headers")
	}
}

func TestNormalizeRawReadsAnthropicCacheUsageFields(t *testing.T) {
	payload := `{
	  "timestamp": "2026-04-25T00:00:00Z",
	  "provider": "anthropic",
	  "model": "claude-sonnet-4-5",
	  "endpoint": "POST /v1/messages",
	  "usage": {
	    "input_tokens": 100,
	    "output_tokens": 20,
	    "cached_tokens": 34,
	    "cache_creation_input_tokens": 11,
	    "cache_read_input_tokens": 23
	  }
	}`
	event, err := NormalizeRaw([]byte(payload))
	if err != nil {
		t.Fatalf("normalize anthropic payload: %v", err)
	}
	if event.InputTokens != 100 || event.OutputTokens != 20 ||
		event.CachedTokens != 34 || event.CacheReadTokens != 23 ||
		event.CacheCreationTokens != 11 || event.TotalTokens != 154 ||
		event.CacheInputMode != CacheInputModeSeparate ||
		event.NormalizedUncachedInputTokens != 100 || event.NormalizedTotalInputTokens != 134 {
		t.Fatalf("event tokens = %#v", event)
	}

	legacyPayload := BuildPayload([]Event{event})
	detail := legacyPayload.APIs["POST /v1/messages"].Models["claude-sonnet-4-5"].Details[0]
	if detail.Tokens.CachedTokens != 0 || detail.Tokens.CacheReadTokens != 23 ||
		detail.Tokens.CacheCreationTokens != 11 || detail.Tokens.TotalTokens != 154 {
		t.Fatalf("detail tokens = %#v", detail.Tokens)
	}
}

func TestNormalizeRawReadsAnthropicCacheUsageFieldsAtTopLevel(t *testing.T) {
	payload := `{
	  "timestamp": "2026-04-25T00:00:00Z",
	  "provider": "anthropic",
	  "model": "claude-opus-4-1",
	  "endpoint": "POST /v1/messages",
	  "input_tokens": 10,
	  "output_tokens": 5,
	  "cacheReadInputTokens": 7,
	  "cacheCreationInputTokens": 3
	}`
	event, err := NormalizeRaw([]byte(payload))
	if err != nil {
		t.Fatalf("normalize anthropic top-level payload: %v", err)
	}
	if event.CacheReadTokens != 7 || event.CacheCreationTokens != 3 || event.TotalTokens != 25 {
		t.Fatalf("event tokens = %#v", event)
	}
}

func TestNormalizeRawReadsCacheWriteTokenAliases(t *testing.T) {
	payload := `{
	  "timestamp": "2026-07-10T00:00:00Z",
	  "model": "gpt-5.6-sol",
	  "tokens": {
	    "input_tokens": 100,
	    "cache_write_tokens": 17
	  }
	}`

	event, err := NormalizeRaw([]byte(payload))
	if err != nil {
		t.Fatalf("normalize raw: %v", err)
	}
	if event.CacheCreationTokens != 17 {
		t.Fatalf("cache creation tokens = %d, want 17", event.CacheCreationTokens)
	}
}

func TestNormalizeRawHandlesCurrentCPAGPT56QueuePayloadWithoutCacheMode(t *testing.T) {
	payload := `{
	  "timestamp": "2026-07-10T00:00:00Z",
	  "provider": "openai",
	  "executor_type": "codex",
	  "model": "gpt-5.6-sol",
	  "service_tier": "priority",
	  "request_service_tier": "priority",
	  "response_service_tier": "default",
	  "tokens": {
	    "input_tokens": 100,
	    "output_tokens": 20,
	    "cached_tokens": 30,
	    "cache_read_tokens": 30,
	    "cache_creation_tokens": 17,
	    "total_tokens": 120
	  }
	}`

	event, err := NormalizeRaw([]byte(payload))
	if err != nil {
		t.Fatalf("normalize current CPA payload: %v", err)
	}
	if event.CacheInputMode != CacheInputModeIncluded ||
		event.NormalizedUncachedInputTokens != 53 || event.NormalizedTotalInputTokens != 100 ||
		event.NormalizedCacheReadTokens != 30 || event.NormalizedCacheCreationTokens != 17 {
		t.Fatalf("normalized cache accounting = %#v", event)
	}
	if event.RequestServiceTier != "priority" || event.ResponseServiceTier != "default" || event.ServiceTier != "priority" {
		t.Fatalf("service tiers = %q/%q/%q", event.RequestServiceTier, event.ResponseServiceTier, event.ServiceTier)
	}
}

func TestNormalizeRawPrefersRequestServiceTierForCodex(t *testing.T) {
	payload := `{
	  "timestamp": "2026-07-10T00:00:00Z",
	  "executor_type": "codex",
	  "model": "gpt-5.6-sol",
	  "service_tier": "priority",
	  "request_service_tier": "priority",
	  "response_service_tier": "default",
	  "tokens": {"input_tokens": 1, "total_tokens": 1}
	}`

	event, err := NormalizeRaw([]byte(payload))
	if err != nil {
		t.Fatalf("normalize raw: %v", err)
	}
	if event.RequestServiceTier != "priority" || event.ResponseServiceTier != "default" || event.ServiceTier != "priority" {
		t.Fatalf("service tiers = %q/%q/%q", event.RequestServiceTier, event.ResponseServiceTier, event.ServiceTier)
	}
}

func TestNormalizeRawPrefersResponseServiceTierForNonCodex(t *testing.T) {
	payload := `{
	  "timestamp": "2026-07-10T00:00:00Z",
	  "provider": "openai-compatible",
	  "model": "gpt-5.4",
	  "request_service_tier": "priority",
	  "response_service_tier": "default",
	  "tokens": {"input_tokens": 1, "total_tokens": 1}
	}`

	event, err := NormalizeRaw([]byte(payload))
	if err != nil {
		t.Fatalf("normalize raw: %v", err)
	}
	if event.RequestServiceTier != "priority" || event.ResponseServiceTier != "default" || event.ServiceTier != "default" {
		t.Fatalf("service tiers = %q/%q/%q", event.RequestServiceTier, event.ResponseServiceTier, event.ServiceTier)
	}
}

func TestCompatibleCachedTokensDoesNotDoubleCountFineGrainedCache(t *testing.T) {
	if got := CompatibleCachedTokens(5, 0, 4, 1); got != 0 {
		t.Fatalf("fully mirrored cached tokens = %d, want 0", got)
	}
	if got := CompatibleCachedTokens(10, 0, 4, 1); got != 5 {
		t.Fatalf("partial compatible cached tokens = %d, want 5", got)
	}
	if got := CompatibleCachedTokens(0, 8, 3, 0); got != 5 {
		t.Fatalf("cache_tokens compatible fallback = %d, want 5", got)
	}
}

func TestNormalizeRawFallbackTotalAvoidsIncludedCacheDuplication(t *testing.T) {
	payload := `{
	  "timestamp": "2026-04-25T00:00:00Z",
	  "source": "user@example.com",
	  "tokens": {
	    "input_tokens": 10,
	    "output_tokens": 20,
	    "reasoning_tokens": 3,
	    "cached_tokens": 10,
	    "cache_read_tokens": 4,
	    "cache_creation_tokens": 1
	  },
	  "model": "gpt-5.4",
	  "endpoint": "POST /v1/chat/completions"
	}`
	event, err := NormalizeRaw([]byte(payload))
	if err != nil {
		t.Fatalf("normalize fallback total: %v", err)
	}
	if event.TotalTokens != 33 {
		t.Fatalf("total tokens = %d, want 33", event.TotalTokens)
	}
}

func TestNormalizeRawSanitizesFailBodyForSummaryAndRawJSON(t *testing.T) {
	longBody := strings.Repeat("x", maxFailSummaryBytes+128)
	payload := `{
	  "timestamp": "2026-04-25T00:00:00Z",
	  "source": "user@example.com",
	  "tokens": {"input_tokens": 1, "total_tokens": 1},
	  "failed": true,
	  "fail": {
	    "status_code": 500,
	    "body": "Authorization: Bearer bearer-secret-12345\napi_key=sk-test-secret-value\naccess_token=access-secret\nCookie: session=secret\nalice@example.com ` + longBody + `"
	  },
	  "model": "gpt-5.4",
	  "endpoint": "POST /v1/chat/completions"
	}`
	event, err := NormalizeRaw([]byte(payload))
	if err != nil {
		t.Fatalf("normalize sensitive fail body: %v", err)
	}
	if event.FailBody == "" || !strings.Contains(event.FailBody, "sk-test-secret-value") {
		t.Fatalf("raw fail body should be preserved internally = %q", event.FailBody)
	}
	if event.FailSummary == "" || len(event.FailSummary) > maxFailSummaryBytes+3 {
		t.Fatalf("fail summary length/content = %d %q", len(event.FailSummary), event.FailSummary)
	}
	for _, secret := range []string{
		"Bearer bearer-secret-12345",
		"sk-test-secret-value",
		"access-secret",
		"session=secret",
		"alice@example.com",
	} {
		if strings.Contains(event.FailSummary, secret) {
			t.Fatalf("fail summary contains secret %q: %q", secret, event.FailSummary)
		}
		if strings.Contains(event.RawJSON, secret) {
			t.Fatalf("raw json contains secret %q: %q", secret, event.RawJSON)
		}
	}
	if !strings.Contains(event.FailSummary, "[redacted]") {
		t.Fatalf("fail summary missing redaction marker: %q", event.FailSummary)
	}
}

func TestFailSummaryRedactionPreservesDiagnosticText(t *testing.T) {
	body := `AImproved fallback AIServer down {"cookie":"session=secret","status":"401","detail":"upstream denied","retry_after":30}`
	summary := FailSummaryFromBody(body)
	for _, want := range []string{
		"AImproved fallback",
		"AIServer down",
		`"status":"401"`,
		`"detail":"upstream denied"`,
		`"retry_after":30`,
	} {
		if !strings.Contains(summary, want) {
			t.Fatalf("summary missing %q: %q", want, summary)
		}
	}
	if strings.Contains(summary, "session=secret") {
		t.Fatalf("summary leaked cookie value: %q", summary)
	}
}

func TestNormalizeRawAcceptsPre7118UsagePayload(t *testing.T) {
	payload := `{
	  "timestamp": "2026-04-25T00:00:00Z",
	  "latency_ms": 1500,
	  "source": "user@example.com",
	  "auth_index": "0",
	  "tokens": {
	    "input_tokens": 10,
	    "output_tokens": 20,
	    "reasoning_tokens": 3,
	    "cached_tokens": 5,
	    "total_tokens": 33
	  },
	  "failed": false,
	  "provider": "openai",
	  "model": "gpt-5.4",
	  "endpoint": "POST /v1/chat/completions",
	  "auth_type": "apikey",
	  "api_key": "test-key",
	  "request_id": "ctx-request-id"
	}`
	event, err := NormalizeRaw([]byte(payload))
	if err != nil {
		t.Fatalf("normalize old payload: %v", err)
	}
	if event.ReasoningEffort != "" || event.CacheReadTokens != 0 ||
		event.CacheCreationTokens != 0 || event.FailStatusCode != 0 || event.FailBody != "" ||
		event.FailSummary != "" {
		t.Fatalf("old payload defaults = %#v", event)
	}
	if event.InputTokens != 10 || event.OutputTokens != 20 || event.ReasoningTokens != 3 ||
		event.CachedTokens != 5 || event.TotalTokens != 33 {
		t.Fatalf("old payload tokens = %#v", event)
	}
}

func TestNormalizeRawSplitsAliasAndResolvedModel(t *testing.T) {
	payload := `{
	  "timestamp": "2026-05-19T10:00:00Z",
	  "model": "gpt-5.5",
	  "alias": "gpt-5.4",
	  "endpoint": "POST /v1/chat/completions",
	  "input_tokens": 1,
	  "total_tokens": 1
	}`
	event, err := NormalizeRaw([]byte(payload))
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	if event.RequestedModel != "gpt-5.4" {
		t.Fatalf("requested_model = %q, want gpt-5.4", event.RequestedModel)
	}
	if event.ResolvedModel != "gpt-5.5" {
		t.Fatalf("resolved_model = %q, want gpt-5.5", event.ResolvedModel)
	}
	if event.Model != "gpt-5.4" {
		t.Fatalf("model = %q, want gpt-5.4", event.Model)
	}
}

func TestNormalizeRawFallsBackToResolvedModelWhenAliasMissing(t *testing.T) {
	payload := `{
	  "timestamp": "2026-05-19T10:00:00Z",
	  "model": "gpt-4.1",
	  "endpoint": "POST /v1/chat/completions",
	  "input_tokens": 1,
	  "total_tokens": 1
	}`
	event, err := NormalizeRaw([]byte(payload))
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	if event.RequestedModel != "" {
		t.Fatalf("requested_model = %q, want empty", event.RequestedModel)
	}
	if event.ResolvedModel != "gpt-4.1" {
		t.Fatalf("resolved_model = %q, want gpt-4.1", event.ResolvedModel)
	}
	if event.Model != "gpt-4.1" {
		t.Fatalf("model = %q, want gpt-4.1", event.Model)
	}
}

func TestBuildPayloadExposesResolvedModelOnDetails(t *testing.T) {
	event := Event{
		Timestamp:      "2026-05-19T10:00:00Z",
		Endpoint:       "POST /v1/chat/completions",
		Model:          "gpt-5.4",
		RequestedModel: "gpt-5.4",
		ResolvedModel:  "gpt-5.5",
	}
	payload := BuildPayload([]Event{event})
	api := payload.APIs["POST /v1/chat/completions"]
	if api == nil {
		t.Fatalf("missing endpoint aggregate")
	}
	modelEntry := api.Models["gpt-5.4"]
	if modelEntry == nil {
		t.Fatalf("aggregation key should be requested model gpt-5.4, got %#v", api.Models)
	}
	if len(modelEntry.Details) != 1 || modelEntry.Details[0].ResolvedModel != "gpt-5.5" {
		t.Fatalf("detail resolved_model = %#v", modelEntry.Details)
	}
}

// legacyDetailWithoutRequestID is a fixture detail with no request_id, used
// to exercise the empty-request-id boundary shared with the realtime collector.
func legacyDetailWithoutRequestID() map[string]any {
	return map[string]any{
		"timestamp":     "2026-01-02T03:04:05Z",
		"source":        "alice@example.com",
		"auth_index":    "auth-1",
		"input_tokens":  float64(10),
		"output_tokens": float64(20),
		"failed":        false,
	}
}

// TestEventFromLegacyDetailLeavesEmptyRequestIDForImportWithoutRequestID pins
// the fix: when a legacy export detail carries no request_id, the import path
// must NOT synthesize any id. It leaves RequestID empty so that
// buildEventHash's first field is "" -- byte-for-byte identical to the
// realtime collector (NormalizeRaw), which never synthesizes an id either.
// Any synthesized non-empty id would make the two ingest paths hash the same
// underlying request differently and double count it.
func TestEventFromLegacyDetailLeavesEmptyRequestIDForImportWithoutRequestID(t *testing.T) {
	detail := legacyDetailWithoutRequestID()

	// The result must not depend on the (now-removed) traversal position or
	// on the `now` argument, both of which are excluded from the hash.
	first, err := eventFromLegacyDetail("POST /v1/chat/completions", "POST", "/v1/chat/completions", "gpt-4o", detail, 1000)
	if err != nil {
		t.Fatalf("eventFromLegacyDetail (first): %v", err)
	}
	second, err := eventFromLegacyDetail("POST /v1/chat/completions", "POST", "/v1/chat/completions", "gpt-4o", detail, 2000)
	if err != nil {
		t.Fatalf("eventFromLegacyDetail (second): %v", err)
	}

	if first.RequestID != "" {
		t.Fatalf("expected empty request id (no synthesis), got %q", first.RequestID)
	}
	if first.EventHash != second.EventHash {
		t.Fatalf("event hash changed across calls: first=%q second=%q", first.EventHash, second.EventHash)
	}
}

// TestEventFromLegacyDetailEventHashDiffersForDifferentContent ensures the
// empty-request-id hash is not degenerate: two genuinely different empty-id
// requests still get distinct EventHashes (they are not wrongly deduped).
func TestEventFromLegacyDetailEventHashDiffersForDifferentContent(t *testing.T) {
	detail := legacyDetailWithoutRequestID()
	base, err := eventFromLegacyDetail("POST /v1/chat/completions", "POST", "/v1/chat/completions", "gpt-4o", detail, 0)
	if err != nil {
		t.Fatalf("eventFromLegacyDetail (base): %v", err)
	}

	otherDetail := legacyDetailWithoutRequestID()
	otherDetail["output_tokens"] = float64(99)
	other, err := eventFromLegacyDetail("POST /v1/chat/completions", "POST", "/v1/chat/completions", "gpt-4o", otherDetail, 0)
	if err != nil {
		t.Fatalf("eventFromLegacyDetail (other): %v", err)
	}

	if base.RequestID != "" || other.RequestID != "" {
		t.Fatalf("expected empty request ids, base=%q other=%q", base.RequestID, other.RequestID)
	}
	if base.EventHash == other.EventHash {
		t.Fatalf("expected different event hashes for different content, both = %q", base.EventHash)
	}
}

// TestCrossPathEventHashMatchesWhenRequestIDEmpty is the core regression test
// for the double-counting bug: the same underlying request WITHOUT a
// request_id, ingested once through the realtime redis-queue collector
// (NormalizeRaw) and once through a legacy /usage/export import
// (eventFromLegacyDetail), must now produce the SAME EventHash. Before the
// fix the import path synthesized a "legacy:<hash>" id while the collector
// left it empty, so the two paths hashed differently and inserted two rows
// for one request (the 2236x2 double-insert observed in production).
func TestCrossPathEventHashMatchesWhenRequestIDEmpty(t *testing.T) {
	queuePayload := []byte(`{
		"model": "gpt-4o",
		"endpoint": "POST /v1/chat/completions",
		"timestamp": "2026-01-02T03:04:05Z",
		"auth_index": "auth-1",
		"source": "alice@example.com",
		"tokens": {"input_tokens": 10, "output_tokens": 20},
		"failed": false
	}`)
	queueEvent, err := NormalizeRaw(queuePayload)
	if err != nil {
		t.Fatalf("NormalizeRaw: %v", err)
	}

	legacyEvent, err := eventFromLegacyDetail("POST /v1/chat/completions", "POST", "/v1/chat/completions", "gpt-4o", legacyDetailWithoutRequestID(), 0)
	if err != nil {
		t.Fatalf("eventFromLegacyDetail: %v", err)
	}

	if queueEvent.RequestID != "" || legacyEvent.RequestID != "" {
		t.Fatalf("expected empty request ids on both paths: queue=%q legacy=%q", queueEvent.RequestID, legacyEvent.RequestID)
	}
	if queueEvent.EventHash != legacyEvent.EventHash {
		t.Fatalf(
			"event hash mismatch across paths for empty request_id (double-counting regression): queue=%q legacy=%q queueEvent=%+v legacyEvent=%+v",
			queueEvent.EventHash, legacyEvent.EventHash, queueEvent, legacyEvent,
		)
	}
}

// TestBuildEventHashRequestIDPresentByteStable locks the exact hash for a
// canonical request_id-present event. Since the dual-ingest dedup fix, a
// non-empty request_id is hashed PURELY as "req|<RequestID>" -- Endpoint,
// Timestamp, tokens and latency are deliberately excluded so the realtime
// collector and the /usage/export importer collapse to a single row even when
// those fields diverge across paths. This golden freezes that layout.
func TestBuildEventHashRequestIDPresentByteStable(t *testing.T) {
	latency := int64(123)
	event := Event{
		RequestID:    "req-123",
		Timestamp:    "2026-01-01T00:00:00Z",
		Endpoint:     "POST /v1/chat/completions",
		Model:        "gpt-4o",
		AuthIndex:    "0",
		SourceHash:   "sourcehash",
		InputTokens:  10,
		OutputTokens: 5,
		Failed:       false,
		LatencyMS:    &latency,
	}
	got := buildEventHash(event)
	if got == "" {
		t.Fatal("empty hash")
	}
	// Golden is the sha256 of the request-id-only key. If the request_id
	// namespace prefix or the pure-id keying ever drifts, this fails.
	// Layout: "req|" + RequestID
	goldenInput := "req|req-123"
	sum := sha256.Sum256([]byte(goldenInput))
	want := hex.EncodeToString(sum[:])
	if got != want {
		t.Fatalf("buildEventHash drifted from frozen request-id layout: got=%q want=%q input=%q", got, want, goldenInput)
	}

	// Regression guard: fields that legitimately diverge across the two ingest
	// paths (Endpoint, Timestamp, tokens, latency) must NOT change the hash of a
	// request_id-present event. Otherwise the same request double-inserts again.
	other := event
	other.Endpoint = "quotio-local-abc123"
	other.Timestamp = "2026-01-01T00:00:00.500Z"
	other.InputTokens = 999
	other.LatencyMS = nil
	if buildEventHash(other) != got {
		t.Fatalf("request-id hash must ignore endpoint/timestamp/token divergence: got=%q other=%q", got, buildEventHash(other))
	}
}

// TestEventFromLegacyDetailUsesRealRequestIDWhenPresent verifies that a
// request_id present on the legacy detail (core's newer /usage/export
// includes it) is used as-is instead of the content-digest fallback.
func TestEventFromLegacyDetailUsesRealRequestIDWhenPresent(t *testing.T) {
	detail := legacyDetailWithoutRequestID()
	detail["request_id"] = "real-request-id-123"
	event, err := eventFromLegacyDetail("POST /v1/chat/completions", "POST", "/v1/chat/completions", "gpt-4o", detail, 0)
	if err != nil {
		t.Fatalf("eventFromLegacyDetail: %v", err)
	}
	if event.RequestID != "real-request-id-123" {
		t.Fatalf("request id = %q, want real-request-id-123", event.RequestID)
	}
}

// TestCrossPathEventHashMatchesWhenRequestIDPresent is the key regression
// test for the double-counting bug: the same underlying request, once
// ingested through the redis-queue collector (NormalizeRaw) and once through
// a legacy /usage/export import (eventFromLegacyDetail), must produce the
// same EventHash when both carry the same real request_id -- otherwise the
// two paths insert two separate rows for one request.
func TestCrossPathEventHashMatchesWhenRequestIDPresent(t *testing.T) {
	queuePayload := []byte(`{
		"provider": "anthropic",
		"executor_type": "claude",
		"model": "gpt-test",
		"alias": "gpt-test",
		"endpoint": "POST /v1/chat/completions",
		"auth_type": "oauth",
		"api_key": "key-abc",
		"request_id": "req-123",
		"timestamp": "2026-01-01T00:00:00Z",
		"auth_index": "0",
		"source": "user@example.com",
		"tokens": {"input_tokens": 10, "output_tokens": 5},
		"failed": false
	}`)
	queueEvent, err := NormalizeRaw(queuePayload)
	if err != nil {
		t.Fatalf("NormalizeRaw: %v", err)
	}

	legacyDetail := map[string]any{
		"timestamp":     "2026-01-01T00:00:00Z",
		"input_tokens":  float64(10),
		"output_tokens": float64(5),
		"request_id":    "req-123",
		"auth_index":    "0",
		"source":        "user@example.com",
		"api_key":       "key-abc",
		"auth_type":     "oauth",
	}
	legacyEvent, err := eventFromLegacyDetail("POST /v1/chat/completions", "POST", "/v1/chat/completions", "gpt-test", legacyDetail, 0)
	if err != nil {
		t.Fatalf("eventFromLegacyDetail: %v", err)
	}

	if queueEvent.RequestID != legacyEvent.RequestID {
		t.Fatalf("request id mismatch: queue=%q legacy=%q", queueEvent.RequestID, legacyEvent.RequestID)
	}
	if queueEvent.EventHash != legacyEvent.EventHash {
		t.Fatalf(
			"event hash mismatch across paths (double-counting regression): queue=%q legacy=%q queueEvent=%+v legacyEvent=%+v",
			queueEvent.EventHash, legacyEvent.EventHash, queueEvent, legacyEvent,
		)
	}
}

// TestDualIngestSameRequestNotDoubleCounted reproduces the exact production
// double-count: one request ingested by the realtime redis-queue collector
// (endpoint "POST /v1/messages", full fields) and later re-ingested by the
// /usage/export importer, whose apis-map key is the inbound bearer
// "quotio-local-<UUID>", NOT the HTTP endpoint (that key is hashed into
// APIKeyHash and the importer's persisted Endpoint ends up as the "-"
// sentinel, deliberately never equal to path A's real HTTP endpoint). Both
// carry the SAME request_id. Since event_hash is the sole insert-dedup key
// (`insert or ignore` on the UNIQUE column), the two events must produce the
// SAME event_hash so only one row survives and its tokens are counted once.
// Before the fix, Endpoint was part of the hash, the two paths diverged, and
// the request was double-counted (2236x2 in production).
func TestDualIngestSameRequestNotDoubleCounted(t *testing.T) {
	const totalTokens = int64(30) // 10 input + 20 output

	// Path A: realtime collector, real HTTP endpoint.
	richPayload := []byte(`{
		"request_id": "req-dual-1",
		"model": "claude-sonnet-4",
		"endpoint": "POST /v1/messages",
		"timestamp": "2026-07-16T10:00:00Z",
		"auth_index": "0",
		"source": "alice@example.com",
		"tokens": {"input_tokens": 10, "output_tokens": 20},
		"failed": false
	}`)
	richEvent, err := NormalizeRaw(richPayload)
	if err != nil {
		t.Fatalf("NormalizeRaw: %v", err)
	}

	// Path B: /usage/export importer. In production the apis-map key is the
	// inbound bearer "quotio-local-<UUID>"; the importer persists Endpoint as
	// "-" (never the raw key) -- deliberately different from path A's real
	// "POST /v1/messages". Same request_id, same tokens.
	legacyDetail := map[string]any{
		"request_id":    "req-dual-1",
		"timestamp":     "2026-07-16T10:00:00Z",
		"input_tokens":  float64(10),
		"output_tokens": float64(20),
		"auth_index":    "0",
		"source":        "alice@example.com",
	}
	legacyEvent, err := eventFromLegacyDetail(
		"quotio-local-1f2e3d4c-aaaa-bbbb-cccc-000000000000", // apis-map key = inbound bearer
		"", "", // parseEndpoint yields empty method/path for a non-HTTP key
		"claude-sonnet-4", legacyDetail, 0,
	)
	if err != nil {
		t.Fatalf("eventFromLegacyDetail: %v", err)
	}

	// The two paths must NOT have converged their Endpoint (this is what makes
	// the test faithful to production; a fix that only worked when endpoints
	// matched would be useless).
	if richEvent.Endpoint == legacyEvent.Endpoint {
		t.Fatalf("test setup invalid: endpoints unexpectedly equal (%q); production divergence not exercised", richEvent.Endpoint)
	}
	if richEvent.EventHash != legacyEvent.EventHash {
		t.Fatalf(
			"same request_id but different event_hash -> double count: rich=%q legacy=%q (endpoints rich=%q legacy=%q)",
			richEvent.EventHash, legacyEvent.EventHash, richEvent.Endpoint, legacyEvent.Endpoint,
		)
	}

	// Simulate the DB's `insert or ignore` on the UNIQUE event_hash: dedup by
	// hash, sum tokens over surviving rows. Must be exactly one row, one count.
	byHash := map[string]Event{}
	byHash[richEvent.EventHash] = richEvent
	byHash[legacyEvent.EventHash] = legacyEvent
	if len(byHash) != 1 {
		t.Fatalf("expected 1 surviving row after dedup, got %d", len(byHash))
	}
	var sum int64
	for _, ev := range byHash {
		sum += ev.TotalTokens
	}
	if sum != totalTokens {
		t.Fatalf("tokens double-counted: sum=%d want=%d", sum, totalTokens)
	}
}

// TestOrphanLegacyRowPreserved is the safety guard for the pre-2026-07-13
// quotio-local rows that have NO paired realtime row: they are the only usage
// record for that window (212,957 real rows). A legacy-only event with its own
// request_id must still be ingested -- it must not be dropped just because its
// endpoint "looks like" quotio-local, and it must never collapse into some
// other request. Its hash is keyed on its own request_id, so it is unique and
// inserted normally.
func TestOrphanLegacyRowPreserved(t *testing.T) {
	orphanDetail := map[string]any{
		"request_id":    "R2-orphan",
		"timestamp":     "2026-07-10T00:00:00Z",
		"input_tokens":  float64(100),
		"output_tokens": float64(50),
		"auth_index":    "0",
		"source":        "quotio-local-user",
	}
	orphan, err := eventFromLegacyDetail(
		"quotio-local-9999aaaa-bbbb-cccc-dddd-eeeeffff0000",
		"", "",
		"claude-sonnet-4", orphanDetail, 0,
	)
	if err != nil {
		t.Fatalf("eventFromLegacyDetail (orphan): %v", err)
	}
	if orphan.RequestID != "R2-orphan" {
		t.Fatalf("orphan request id = %q, want R2-orphan", orphan.RequestID)
	}
	if orphan.EventHash == "" {
		t.Fatal("orphan event has empty hash; it would fail the NOT NULL event_hash column and be lost")
	}
	if orphan.TotalTokens != 150 {
		t.Fatalf("orphan tokens = %d, want 150", orphan.TotalTokens)
	}

	// A DIFFERENT request (different request_id) must never share the orphan's
	// hash -- constraint (b): never merge distinct requests.
	otherDetail := map[string]any{
		"request_id":    "R3-different",
		"timestamp":     "2026-07-10T00:00:00Z",
		"input_tokens":  float64(100),
		"output_tokens": float64(50),
		"auth_index":    "0",
		"source":        "quotio-local-user",
	}
	other, err := eventFromLegacyDetail(
		"quotio-local-9999aaaa-bbbb-cccc-dddd-eeeeffff0000",
		"", "",
		"claude-sonnet-4", otherDetail, 0,
	)
	if err != nil {
		t.Fatalf("eventFromLegacyDetail (other): %v", err)
	}
	if orphan.EventHash == other.EventHash {
		t.Fatalf("distinct request_ids share a hash -> wrongful merge: %q", orphan.EventHash)
	}
}

// TestEventFromLegacyDetailHashesAPIKeyLabelIntoAPIKeyHash pins the fix for
// the API-key attribution bug: core's /usage/export apis-map key IS the
// inbound bearer (the client's literal API key) -- see
// core/internal/usage/logger_plugin.go:258 (`statsKey := record.APIKey`) and
// the eventsFromLegacyUsage doc comment. Before the fix, the import path
// looked for api_key/apiKey/key fields on the detail itself (which core's
// export never sets), so APIKeyHash was always hashString("")="" and the key
// column leaked the raw bearer via Endpoint/raw_json instead of being
// attributed. This test locks:
//  1. APIKeyHash is non-empty and equals hashString(apiKeyLabel).
//  2. Endpoint no longer carries the raw key (it is the "-" sentinel).
//  3. raw_json does not embed the raw key in plaintext.
func TestEventFromLegacyDetailHashesAPIKeyLabelIntoAPIKeyHash(t *testing.T) {
	const apiKeyLabel = "quotio-local-5bdd1234-aaaa-bbbb-cccc-000000000000"
	detail := map[string]any{
		"timestamp":     "2026-07-16T10:00:00Z",
		"request_id":    "req-attribution-1",
		"input_tokens":  float64(10),
		"output_tokens": float64(20),
		"auth_index":    "0",
		"source":        "alice@example.com",
	}

	event, err := eventFromLegacyDetail(apiKeyLabel, "", "", "claude-sonnet-4", detail, 0)
	if err != nil {
		t.Fatalf("eventFromLegacyDetail: %v", err)
	}

	wantHash := hashString(apiKeyLabel)
	if wantHash == "" {
		t.Fatal("test setup invalid: hashString(apiKeyLabel) must not be empty")
	}
	if event.APIKeyHash != wantHash {
		t.Fatalf("api_key_hash = %q, want hashString(apiKeyLabel) = %q (bug: hashing an absent detail-level api_key field instead of the apis-map key)", event.APIKeyHash, wantHash)
	}
	if event.Endpoint == apiKeyLabel {
		t.Fatalf("endpoint must not carry the raw api key label, got %q", event.Endpoint)
	}
	if event.Endpoint != "-" {
		t.Fatalf("endpoint = %q, want \"-\" sentinel", event.Endpoint)
	}
	if strings.Contains(event.RawJSON, apiKeyLabel) {
		t.Fatalf("raw_json must not embed the raw api key label in plaintext: %q", event.RawJSON)
	}
}

// TestEventFromLegacyDetailAPIKeyHashMatchesRealtimePathForSameKey is the
// core cross-path regression test for the attribution bug: the SAME API key,
// once observed by the realtime redis-queue collector (NormalizeRaw, which
// reads api_key/apiKey/key straight off the request payload) and once
// recovered from a legacy /usage/export catch-up import (eventFromLegacyDetail,
// which must hash the apis-map key), must produce the SAME APIKeyHash so
// usage for one client key is not split into two attribution buckets.
func TestEventFromLegacyDetailAPIKeyHashMatchesRealtimePathForSameKey(t *testing.T) {
	const apiKey = "quotio-local-5bdd1234-aaaa-bbbb-cccc-000000000000"

	queuePayload := []byte(`{
		"model": "claude-sonnet-4",
		"endpoint": "POST /v1/messages",
		"timestamp": "2026-07-16T10:00:00Z",
		"auth_index": "0",
		"source": "alice@example.com",
		"api_key": "` + apiKey + `",
		"tokens": {"input_tokens": 10, "output_tokens": 20},
		"failed": false
	}`)
	queueEvent, err := NormalizeRaw(queuePayload)
	if err != nil {
		t.Fatalf("NormalizeRaw: %v", err)
	}
	if queueEvent.APIKeyHash == "" {
		t.Fatal("test setup invalid: realtime path produced empty api_key_hash")
	}

	legacyDetail := map[string]any{
		"timestamp":     "2026-07-16T10:05:00Z",
		"input_tokens":  float64(5),
		"output_tokens": float64(7),
		"auth_index":    "0",
		"source":        "alice@example.com",
	}
	legacyEvent, err := eventFromLegacyDetail(apiKey, "", "", "claude-sonnet-4", legacyDetail, 0)
	if err != nil {
		t.Fatalf("eventFromLegacyDetail: %v", err)
	}

	if legacyEvent.APIKeyHash != queueEvent.APIKeyHash {
		t.Fatalf(
			"api_key_hash mismatch across paths for the same key (attribution regression): realtime=%q legacy=%q",
			queueEvent.APIKeyHash, legacyEvent.APIKeyHash,
		)
	}
}
func TestBuildPayloadGroupsReasoningSuffixesByAnalyticsModel(t *testing.T) {
	payload := BuildPayload([]Event{
		{Model: "deepseek-v4-flash(low)", AnalyticsModel: "stale-model", ReasoningEffort: "low", TotalTokens: 1},
		{Model: "deepseek-v4-flash(max)", ReasoningEffort: "max", TotalTokens: 1},
		{Model: "custom-model(region-us)", TotalTokens: 1},
	})
	api := payload.APIs["-"]
	if api == nil || len(api.Models) != 2 {
		t.Fatalf("models = %#v", api)
	}
	canonical := api.Models["deepseek-v4-flash"]
	if canonical == nil || len(canonical.Details) != 2 {
		t.Fatalf("canonical details = %#v", canonical)
	}
	if canonical.Details[0].RequestedModel != "deepseek-v4-flash(low)" || canonical.Details[1].RequestedModel != "deepseek-v4-flash(max)" {
		t.Fatalf("requested models = %#v", canonical.Details)
	}
	if api.Models["custom-model(region-us)"] == nil {
		t.Fatalf("unknown suffix alias was removed: %#v", api.Models)
	}
}

func TestCompatiblePayloadUsesRequestedModelWhenAggregateKeyDiffers(t *testing.T) {
	result, err := ParseImportPayload([]byte(`{
		"apis": {
			"POST /v1/chat/completions": {
				"models": {
					"deepseek-v4-flash": {
						"details": [{
							"timestamp": "2026-08-12T10:00:00Z",
							"requested_model": "deepseek-v4-flash(max)",
							"tokens": {"total_tokens": 1},
							"failed": false
						}]
					}
				}
			}
		}
	}`))
	if err != nil {
		t.Fatalf("parse compatible payload: %v", err)
	}
	if len(result.Events) != 1 {
		t.Fatalf("imported events = %d, want 1", len(result.Events))
	}
	event := result.Events[0]
	if event.Model != "deepseek-v4-flash(max)" || event.RequestedModel != "deepseek-v4-flash(max)" {
		t.Fatalf("requested identity = model:%q requested:%q", event.Model, event.RequestedModel)
	}
	if event.AnalyticsModel != "deepseek-v4-flash" {
		t.Fatalf("analytics model = %q, want deepseek-v4-flash", event.AnalyticsModel)
	}
	legacyHashEvent := event
	legacyHashEvent.Model = "deepseek-v4-flash"
	// fork 的历史身份在脱敏前以 apis-map key 计算，落库后不保留该原文。
	legacyHashEvent.Endpoint = "POST /v1/chat/completions"
	if event.Endpoint != "-" {
		t.Fatalf("persisted endpoint must be redacted: %q", event.Endpoint)
	}
	if want := buildEventHash(legacyHashEvent); event.EventHash != want {
		t.Fatalf("event hash = %q, want legacy-compatible %q", event.EventHash, want)
	}
}

func TestCompatiblePayloadRoundTripPreservesReasoningSuffixModel(t *testing.T) {
	original := Event{
		Timestamp:       "2026-08-12T10:00:00Z",
		TimestampMS:     1_755_000_000_000,
		Endpoint:        "POST /v1/chat/completions",
		Model:           "deepseek-v4-flash(max)",
		ReasoningEffort: "max",
		TotalTokens:     1,
	}
	payload, err := json.Marshal(BuildPayload([]Event{original}))
	if err != nil {
		t.Fatalf("marshal compatible payload: %v", err)
	}

	result, err := ParseImportPayload(payload)
	if err != nil {
		t.Fatalf("parse compatible payload: %v", err)
	}
	if len(result.Events) != 1 {
		t.Fatalf("imported events = %d, want 1", len(result.Events))
	}
	imported := result.Events[0]
	if imported.Model != original.Model {
		t.Fatalf("model = %q, want %q", imported.Model, original.Model)
	}
	if imported.AnalyticsModel != "deepseek-v4-flash" {
		t.Fatalf("analytics model = %q, want deepseek-v4-flash", imported.AnalyticsModel)
	}
	if imported.RequestedModel != original.Model {
		t.Fatalf("requested model = %q, want %q", imported.RequestedModel, original.Model)
	}
}

func TestCompatiblePayloadPrefersExplicitRequestedModelForAudit(t *testing.T) {
	original := Event{
		Timestamp:       "2026-08-12T10:00:00Z",
		TimestampMS:     1_755_000_000_000,
		Endpoint:        "POST /v1/chat/completions",
		Model:           "stored-display-model",
		RequestedModel:  "deepseek-v4-flash(max)",
		ResolvedModel:   "deepseek-v4-flash",
		ReasoningEffort: "max",
		TotalTokens:     1,
	}
	payload := BuildPayload([]Event{original})
	model := payload.APIs[original.Endpoint].Models["deepseek-v4-flash"]
	if model == nil || len(model.Details) != 1 {
		t.Fatalf("canonical model aggregate = %#v", payload.APIs[original.Endpoint].Models)
	}
	detail := model.Details[0]
	if detail.RequestedModel != original.RequestedModel {
		t.Fatalf("requested model = %q, want %q", detail.RequestedModel, original.RequestedModel)
	}
}

func TestParseImportPayloadRoundTripsRequestMetadataFields(t *testing.T) {
	gen := true
	stream := false
	original := Event{
		Timestamp:         "2026-08-12T10:00:00Z",
		TimestampMS:       1_755_000_000_000,
		Endpoint:          "POST /v1/chat/completions",
		Model:             "gpt-4o",
		RequestedModel:    "gpt-4o",
		ResolvedModel:     "gpt-4o-2024-08-06",
		ResponseModel:     "gpt-4o-mini",
		SessionID:         "session-xyz",
		ParentSessionID:   "parent-session-abc",
		AccessTokenSHA256: "sha256-token-12345",
		Generate:          &gen,
		Stream:            &stream,
		TotalTokens:       1,
	}

	payload, err := json.Marshal(BuildPayload([]Event{original}))
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}

	result, err := ParseImportPayload(payload)
	if err != nil {
		t.Fatalf("parse import payload: %v", err)
	}
	if len(result.Events) != 1 {
		t.Fatalf("imported events = %d, want 1", len(result.Events))
	}
	imported := result.Events[0]
	if imported.ResponseModel != original.ResponseModel {
		t.Errorf("ResponseModel = %q, want %q", imported.ResponseModel, original.ResponseModel)
	}
	if imported.SessionID != original.SessionID {
		t.Errorf("SessionID = %q, want %q", imported.SessionID, original.SessionID)
	}
	if imported.ParentSessionID != original.ParentSessionID {
		t.Errorf("ParentSessionID = %q, want %q", imported.ParentSessionID, original.ParentSessionID)
	}
	if imported.AccessTokenSHA256 != original.AccessTokenSHA256 {
		t.Errorf("AccessTokenSHA256 = %q, want %q", imported.AccessTokenSHA256, original.AccessTokenSHA256)
	}
	if imported.Generate == nil || *imported.Generate != true {
		t.Errorf("Generate = %v, want true", imported.Generate)
	}
	if imported.Stream == nil || *imported.Stream != false {
		t.Errorf("Stream = %v, want false", imported.Stream)
	}
}

func TestParseImportPayloadJSONLRoundTripsFalseBooleans(t *testing.T) {
	gen := false
	stream := false
	original := Event{
		Timestamp:         "2026-08-12T10:00:00Z",
		TimestampMS:       1_755_000_000_000,
		Endpoint:          "POST /v1/chat/completions",
		Model:             "gpt-4o",
		RequestedModel:    "gpt-4o",
		ResolvedModel:     "gpt-4o-2024-08-06",
		ResponseModel:     "gpt-4o-mini",
		SessionID:         "sess-test-false",
		ParentSessionID:   "parent-sess-false",
		AccessTokenSHA256: "sha256-test-hash",
		Generate:          &gen,
		Stream:            &stream,
		TotalTokens:       1,
	}

	line, err := json.Marshal(original)
	if err != nil {
		t.Fatalf("marshal original event: %v", err)
	}

	result, err := ParseImportPayload(line)
	if err != nil {
		t.Fatalf("parse JSONL import payload: %v", err)
	}
	if result.Format != ImportFormatJSONL || len(result.Events) != 1 {
		t.Fatalf("result format=%q, count=%d", result.Format, len(result.Events))
	}
	imported := result.Events[0]
	if imported.Generate == nil {
		t.Fatal("Generate is nil, want explicit false")
	}
	if *imported.Generate != false {
		t.Fatalf("Generate = %v, want false", *imported.Generate)
	}
	if imported.Stream == nil {
		t.Fatal("Stream is nil, want explicit false")
	}
	if *imported.Stream != false {
		t.Fatalf("Stream = %v, want false", *imported.Stream)
	}
	if imported.ResponseModel != original.ResponseModel ||
		imported.SessionID != original.SessionID ||
		imported.ParentSessionID != original.ParentSessionID ||
		imported.AccessTokenSHA256 != original.AccessTokenSHA256 {
		t.Fatalf("imported fields mismatch: %+v", imported)
	}
}

func TestArchiveDerivedFieldsAcceptsReadIncludedCreationSeparate(t *testing.T) {
	record := map[string]any{
		"cache_input_mode":                 CacheInputModeReadIncludedCreationSeparate,
		"normalized_uncached_input_tokens": json.Number("100"),
		"normalized_total_input_tokens":    json.Number("125"),
		"normalized_cache_read_tokens":     json.Number("20"),
		"normalized_cache_creation_tokens": json.Number("5"),
		"total_tokens":                     json.Number("135"),
		"header_quota_recover_at_ms":       json.Number("0"),
		"header_quota_used_percent":        nil,
	}
	accounting, totalTokens, _, _, err := archiveDerivedFieldsFromRecord(record)
	if err != nil {
		t.Fatalf("archive derived fields: %v", err)
	}
	if accounting.Mode != CacheInputModeReadIncludedCreationSeparate ||
		accounting.UncachedInputTokens != 100 ||
		accounting.TotalInputTokens != 125 ||
		accounting.CacheReadTokens != 20 ||
		accounting.CacheCreationTokens != 5 ||
		totalTokens != 135 {
		t.Fatalf("archive accounting = %+v total=%d", accounting, totalTokens)
	}

	event := Event{
		PreserveArchiveDerivedFields:  true,
		CacheInputMode:                accounting.Mode,
		NormalizedUncachedInputTokens: accounting.UncachedInputTokens,
		NormalizedTotalInputTokens:    accounting.TotalInputTokens,
		NormalizedCacheReadTokens:     accounting.CacheReadTokens,
		NormalizedCacheCreationTokens: accounting.CacheCreationTokens,
		TotalTokens:                   totalTokens,
	}
	if err := ValidateArchiveDerivedFields(event); err != nil {
		t.Fatalf("validate mixed archive accounting: %v", err)
	}
}
