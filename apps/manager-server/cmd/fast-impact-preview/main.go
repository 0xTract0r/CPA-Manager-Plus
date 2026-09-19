// 本地只读预览：生产 CSV 仅含已脱敏的指标；合成样本使用独立账号。
package main

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/monitoring"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/usage"
)

func ptr[T any](v T) *T { return &v }
func main() {
	address := flag.String("listen", "127.0.0.1:19428", "loopback listen address")
	input := flag.String("production-csv", "", "sanitized production speed-samples.csv")
	flag.Parse()
	host, _, err := net.SplitHostPort(*address)
	if err != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() {
		log.Fatal("preview must bind to a loopback IP")
	}
	f, err := os.Open(*input)
	if err != nil {
		log.Fatal(err)
	}
	records, err := csv.NewReader(f).ReadAll()
	f.Close()
	if err != nil || len(records) < 2 {
		log.Fatal("invalid production CSV")
	}
	columns := map[string]int{}
	for i, v := range records[0] {
		columns[v] = i
	}
	text := func(row []string, key string) string {
		if i, ok := columns[key]; ok && i < len(row) {
			return row[i]
		}
		return ""
	}
	num := func(row []string, key string) int64 { v, _ := strconv.ParseInt(text(row, key), 10, 64); return v }
	var events []usage.Event
	var minMS, maxMS int64
	for i, row := range records[1:] {
		start, end := num(row, "started_at_ms"), num(row, "ended_at_ms")
		if minMS == 0 || start < minMS {
			minMS = start
		}
		maxMS = max(maxMS, end)
		id := fmt.Sprintf("production-%03d", i+1)
		e := usage.Event{EventHash: id, RequestID: id, TimestampMS: start, Timestamp: time.UnixMilli(start).UTC().Format(time.RFC3339Nano), Provider: "codex", AuthIndex: "preview-production", AuthFileSnapshot: "production-samples.json", AccountSnapshot: "生产留存样本（脱敏）", Model: text(row, "model"), ResolvedModel: text(row, "model"), InputTokens: num(row, "input_tokens"), OutputTokens: num(row, "output_tokens"), ReasoningTokens: num(row, "reasoning_tokens"), CachedTokens: num(row, "cached_tokens"), LatencyMS: ptr(num(row, "latency_ms")), Failed: strings.EqualFold(text(row, "failed"), "true"), Telemetry: &usage.Telemetry{Version: 1, AttemptID: id, StartedAtMS: start, EndedAtMS: end, Transport: text(row, "transport"), ObservationKind: text(row, "observation_kind")}}
		if text(row, "first_body_ms") != "" {
			e.Telemetry.FirstBodyMS = ptr(num(row, "first_body_ms"))
		}
		if text(row, "stream_completed") != "" {
			e.Telemetry.StreamCompleted = ptr(strings.EqualFold(text(row, "stream_completed"), "true"))
		}
		e.TotalTokens = e.InputTokens + e.OutputTokens
		events = append(events, e)
	}
	productionCount := len(events)
	for modelIndex, model := range []string{"gpt-6-astra", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"} {
		for tierIndex, tier := range []string{"default", "priority"} {
			n := 24
			if modelIndex == 2 && tierIndex == 0 {
				n = 0
			}
			if modelIndex == 2 && tierIndex == 1 {
				n = 7
			}
			if modelIndex == 3 {
				n = 4
			}
			for i := 0; i < n; i++ {
				id := fmt.Sprintf("synthetic-%d-%d-%02d", modelIndex, tierIndex, i)
				start := minMS + int64(tierIndex)*((maxMS-minMS)/2) + int64(i)*15000
				speed := int64(32 + i%5)
				if tierIndex == 1 {
					speed = speed * 140 / 100
					if modelIndex == 1 {
						speed = speed * 55 / 100
					}
				}
				span := 500000 / speed
				latency := span + 2000
				enabled := tierIndex == 1
				events = append(events, usage.Event{EventHash: id, RequestID: id, TimestampMS: start, Timestamp: time.UnixMilli(start).UTC().Format(time.RFC3339Nano), Provider: "codex", AuthIndex: "preview-synthetic", AuthFileSnapshot: "synthetic-samples.json", AccountSnapshot: "合成验收样本（非生产）", Model: model, ResolvedModel: model, ReasoningEffort: "high", InputTokens: 160000, CachedTokens: 150000, OutputTokens: 600, ReasoningTokens: 100, TotalTokens: 160600, LatencyMS: &latency, Telemetry: &usage.Telemetry{Version: 2, AttemptID: id, StartedAtMS: start, EndedAtMS: start + latency, Transport: "websocket", ObservationKind: "protocol_content_events", FastContext: &usage.FastContext{SchemaVersion: 1, ClientServiceTier: "default", UpstreamRequestServiceTier: tier, ServerFastEnabled: &enabled, TierSource: map[bool]string{false: "default", true: "account"}[enabled], RequestKind: "serving"}, VisibleContentObserved: true, OutputReasoningSubset: true, FirstBodyMS: ptr(int64(400)), FirstVisibleContentMS: ptr(int64(2000)), LastVisibleContentMS: ptr(latency), VisibleContentEvents: ptr(int64(80)), StreamCompleted: ptr(true)}})
			}
		}
	}
	dir, err := os.MkdirTemp("", "cpamp-fast-preview-")
	if err != nil {
		log.Fatal(err)
	}
	defer os.RemoveAll(dir)
	db, err := store.Open(filepath.Join(dir, "usage.sqlite"))
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()
	if _, err = db.InsertEvents(context.Background(), events); err != nil {
		log.Fatal(err)
	}
	svc := monitoring.New(db)
	mux := http.NewServeMux()
	mux.HandleFunc("/analytics", func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" {
			u, err := url.Parse(origin)
			if err != nil || (u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost") {
				http.Error(w, "loopback origin required", 403)
				return
			}
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Headers", "content-type")
			w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(204)
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "POST required", 405)
			return
		}
		var req monitoring.Request
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 65536)).Decode(&req); err != nil {
			http.Error(w, "invalid JSON", 400)
			return
		}
		result, err := svc.Analytics(r.Context(), req)
		if err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(result)
	})
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"production_samples": productionCount, "synthetic_samples": len(events) - productionCount, "from_ms": minMS - 1, "to_ms": maxMS + 1})
	})
	log.Printf("Local preview %s: production=%d synthetic=%d, from_ms=%d to_ms=%d", *address, productionCount, len(events)-productionCount, minMS-1, maxMS+1)
	log.Fatal(http.ListenAndServe(*address, mux))
}
