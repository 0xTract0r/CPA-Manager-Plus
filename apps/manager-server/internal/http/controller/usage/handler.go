package usage

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/app"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/http/middleware"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/http/response"
	usagesvc "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/usage"
)

const maxUsageImportBytes int64 = 64 * 1024 * 1024

type Handler struct {
	App *app.Context
}

func (h *Handler) Handle(w http.ResponseWriter, r *http.Request) {
	if !middleware.AuthorizePanel(w, r, h.App.AdminAuthService) {
		return
	}
	switch r.Method {
	case http.MethodGet:
		if strings.HasSuffix(r.URL.Path, "/export") {
			h.Export(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		writer := &countingWriter{writer: w}
		err := h.App.UsageService.WriteCompatibleUsage(r.Context(), writer, h.App.Config.QueryLimit)
		if err != nil {
			if writer.written == 0 {
				response.Error(w, http.StatusInternalServerError, err)
			} else {
				log.Printf("usage compatible stream failed after %d bytes: %v", writer.written, err)
			}
			return
		}
	case http.MethodPost:
		if strings.HasSuffix(r.URL.Path, "/import") {
			h.Import(w, r)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/sync") {
			h.Sync(w, r)
			return
		}
		response.MethodNotAllowed(w)
	default:
		response.MethodNotAllowed(w)
	}
}

func (h *Handler) Export(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Content-Disposition", `attachment; filename="usage-events.jsonl"`)
	writer := &countingWriter{writer: w}
	if err := h.App.UsageService.WriteExport(r.Context(), writer, h.App.Config.QueryLimit); err != nil {
		if writer.written == 0 {
			w.Header().Del("Content-Disposition")
			response.Error(w, http.StatusInternalServerError, err)
		} else {
			log.Printf("usage export stream failed after %d bytes: %v", writer.written, err)
		}
	}
}

type countingWriter struct {
	writer  io.Writer
	written int64
}

func (w *countingWriter) Write(data []byte) (int, error) {
	written, err := w.writer.Write(data)
	w.written += int64(written)
	return written, err
}

func (h *Handler) Import(w http.ResponseWriter, r *http.Request) {
	if r.ContentLength > maxUsageImportBytes {
		response.Error(w, http.StatusRequestEntityTooLarge, errors.New("http: request body too large"))
		return
	}
	body := http.MaxBytesReader(w, r.Body, maxUsageImportBytes)
	result, parsed, err := h.App.UsageService.Import(r.Context(), body)
	if err != nil {
		var maxBytesErr *http.MaxBytesError
		if errors.As(err, &maxBytesErr) {
			response.Error(w, http.StatusRequestEntityTooLarge, err)
			return
		}
		var persistenceErr *usagesvc.ImportPersistenceError
		if errors.As(err, &persistenceErr) || result.Added+result.Skipped > 0 {
			response.Error(w, http.StatusInternalServerError, err)
			return
		}
		if parsed == nil {
			response.Error(w, http.StatusBadRequest, err)
			return
		}
		response.JSON(w, http.StatusBadRequest, map[string]any{
			"error":       err.Error(),
			"format":      parsed.Format,
			"failed":      parsed.Failed,
			"unsupported": parsed.Unsupported,
			"warnings":    parsed.Warnings,
		})
		return
	}
	response.JSON(w, http.StatusOK, result)
}

// syncRequestBody is the optional JSON body accepted by Sync to resume a
// windowed sync from a previous page's cursor. Both fields are also accepted
// as query parameters (?since=...&limit=...) for simple/manual triggering;
// the JSON body takes precedence when both are present.
type syncRequestBody struct {
	Since string `json:"since"`
	Limit int    `json:"limit"`
}

// Sync pulls a single page of the usage export snapshot from the configured
// CPA core instance and imports it into the manager-server's own
// usage_events store. Without since/limit it pulls the first page (not the
// full history); callers that need the complete history must keep calling
// Sync with since=<previous response's nextSince> until hasMore is false.
func (h *Handler) Sync(w http.ResponseWriter, r *http.Request) {
	opts, err := parseSyncOptions(w, r)
	if err != nil {
		response.Error(w, http.StatusBadRequest, err)
		return
	}
	result, err := h.App.UsageService.SyncFromCore(r.Context(), opts)
	if err != nil {
		response.Error(w, response.UsageSyncErrorStatus(err), err)
		return
	}
	response.JSON(w, http.StatusOK, result)
}

func parseSyncOptions(w http.ResponseWriter, r *http.Request) (usagesvc.SyncOptions, error) {
	opts := usagesvc.SyncOptions{
		Since: strings.TrimSpace(r.URL.Query().Get("since")),
	}
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		limit, err := strconv.Atoi(raw)
		if err != nil || limit < 0 {
			return opts, errors.New("limit must be a non-negative integer")
		}
		opts.Limit = limit
	}

	// A JSON body is optional: manual/no-arg triggers (existing frontend
	// behavior, curl, etc.) send no body at all. Only override query params
	// when a body is actually present and non-empty.
	if r.ContentLength > 0 {
		body := http.MaxBytesReader(w, r.Body, 64*1024)
		defer body.Close()
		data, err := io.ReadAll(body)
		if err != nil {
			return opts, err
		}
		data = bytes.TrimSpace(data)
		if len(data) > 0 {
			var parsed syncRequestBody
			if err := json.Unmarshal(data, &parsed); err != nil {
				return opts, fmt.Errorf("invalid sync request body: %w", err)
			}
			if since := strings.TrimSpace(parsed.Since); since != "" {
				opts.Since = since
			}
			if parsed.Limit > 0 {
				opts.Limit = parsed.Limit
			}
		}
	}
	return opts, nil
}
