package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/config"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/managerconfig"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/monitoring"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
)

func snapshotFiles(t *testing.T) (string, string) {
	t.Helper()
	dir := t.TempDir()
	event := `{"event_hash":"one","request_id":"one","timestamp_ms":1790900000000,"model":"gpt-6-astra","auth_index":"snapshot-account","auth_provider_snapshot":"codex","input_tokens":1000,"output_tokens":600,"reasoning_tokens":100,"latency_ms":10000,"telemetry":{"version":2,"attempt_id":"one","started_at_ms":1790900000000,"ended_at_ms":1790900010000,"first_visible_content_ms":1000,"last_visible_content_ms":9000,"visible_content_events":2,"visible_content_observed":true,"output_reasoning_subset":true,"stream_completed":true,"fast_context":{"schema_version":1,"upstream_request_service_tier":"priority","server_fast_enabled":true,"tier_source":"account","request_kind":"serving"}}}` + "\n"
	hash := sha256.Sum256([]byte(event))
	prices := `{"prices":{"gpt-6-astra":{"prompt":2,"completion":10,"cache":0.2,"cacheRead":0.2,"promptConfigured":true,"completionConfigured":true,"cacheReadConfigured":true,"updatedAtMs":1790890000000,"syncedAtMs":1790880000000}}}`
	priceHash := sha256.Sum256([]byte(prices))
	auth := `{"files":[{"auth_index":"snapshot-account","provider":"codex"}]}`
	authHash := sha256.Sum256([]byte(auth))
	m := manifest{Exported: 1, SourceTotal: 1, Complete: true, EventsSHA256: hex.EncodeToString(hash[:]), FileSHA256: map[string]string{"model-prices.json": hex.EncodeToString(priceHash[:]), "auth-files.json": hex.EncodeToString(authHash[:])}}
	data, _ := json.Marshal(m)
	for name, value := range map[string]string{"events.jsonl": event, "manifest.json": string(data), "model-prices.json": prices, "auth-files.json": auth, "index.html": "<!doctype html><title>same-production-panel</title>"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
	}
	return dir, filepath.Join(dir, "index.html")
}

func TestRejectUnsafeAuthAndDoNotExposeExtraManifestFields(t *testing.T) {
	for _, updateHash := range []bool{false, true} {
		dir, panel := snapshotFiles(t)
		auth := []byte(`{"files":[{"auth_index":"snapshot-account","access_token":"not-a-real-secret"}]}`)
		_ = os.WriteFile(filepath.Join(dir, "auth-files.json"), auth, 0600)
		if updateHash {
			data, _ := os.ReadFile(filepath.Join(dir, "manifest.json"))
			var m manifest
			_ = json.Unmarshal(data, &m)
			h := sha256.Sum256(auth)
			m.FileSHA256["auth-files.json"] = hex.EncodeToString(h[:])
			data, _ = json.Marshal(m)
			_ = os.WriteFile(filepath.Join(dir, "manifest.json"), data, 0600)
		}
		if p, err := newPreview(context.Background(), dir, panel); err == nil {
			p.close()
			t.Fatal("unsafe or changed auth was accepted")
		}
	}
	dir, panel := snapshotFiles(t)
	data, _ := os.ReadFile(filepath.Join(dir, "manifest.json"))
	var raw map[string]any
	_ = json.Unmarshal(data, &raw)
	raw["access_token"] = "not-a-real-secret"
	data, _ = json.Marshal(raw)
	_ = os.WriteFile(filepath.Join(dir, "manifest.json"), data, 0600)
	p, err := newPreview(context.Background(), dir, panel)
	if err != nil {
		t.Fatal(err)
	}
	defer p.close()
	w := httptest.NewRecorder()
	p.handler.ServeHTTP(w, httptest.NewRequest("GET", "/snapshot-manifest", nil))
	if strings.Contains(w.Body.String(), "access_token") || strings.Contains(w.Body.String(), "not-a-real-secret") {
		t.Fatal("raw manifest field leaked")
	}
}

func TestSnapshotPricesKeepSourceAmountsAndTimestamps(t *testing.T) {
	dir, panel := snapshotFiles(t)
	p, err := newPreview(context.Background(), dir, panel)
	if err != nil {
		t.Fatal(err)
	}
	defer p.close()
	r := httptest.NewRequest("GET", "/v0/management/model-prices", nil)
	r.Header.Set("Authorization", "Bearer "+localAdminKey)
	w := httptest.NewRecorder()
	p.handler.ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatalf("prices status %d: %s", w.Code, w.Body.String())
	}
	var data struct {
		Prices map[string]store.ModelPrice `json:"prices"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &data); err != nil {
		t.Fatal(err)
	}
	price := data.Prices["gpt-6-astra"]
	if price.Prompt != 2 || price.Completion != 10 || price.CacheRead != 0.2 || !price.PromptConfigured || price.UpdatedAtMS != 1790890000000 || price.SyncedAtMS == nil || *price.SyncedAtMS != 1790880000000 {
		t.Fatalf("snapshot price changed: %+v", price)
	}
	r = httptest.NewRequest("GET", "/v0/management/api-key-aliases", nil)
	r.Header.Set("Authorization", "Bearer "+localAdminKey)
	w = httptest.NewRecorder()
	p.handler.ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatalf("local alias empty state failed %d", w.Code)
	}
}

func TestRejectModifiedPrices(t *testing.T) {
	dir, panel := snapshotFiles(t)
	if err := os.WriteFile(filepath.Join(dir, "model-prices.json"), []byte(`{"prices":{}}`), 0600); err != nil {
		t.Fatal(err)
	}
	if p, err := newPreview(context.Background(), dir, panel); err == nil {
		p.close()
		t.Fatal("accepted modified prices")
	}
}

func TestPreviewUsesOfficialAPIAndPreservesTelemetry(t *testing.T) {
	dir, panel := snapshotFiles(t)
	p, err := newPreview(context.Background(), dir, panel)
	if err != nil {
		t.Fatal(err)
	}
	defer p.close()
	managerCfg, _, _, err := managerconfig.New(config.Config{}, p.db, nil).ResolveManagerConfigWithSource(context.Background())
	if err != nil || !managerconfig.ManagerCollectorEnabled(managerCfg) {
		t.Fatal("formal frontend must be able to display imported historical usage")
	}
	request := httptest.NewRequest("POST", "/v0/management/monitoring/analytics", strings.NewReader(`{"from_ms":1790899999000,"to_ms":1790900011000,"filters":{"providers":["codex"],"auth_indices":["snapshot-account"]},"include":{"fast_impact":true,"summary":true}}`))
	request.Header.Set("Authorization", "Bearer "+localAdminKey)
	recorder := httptest.NewRecorder()
	p.handler.ServeHTTP(recorder, request)
	if recorder.Code != 200 {
		t.Fatalf("analytics status %d: %s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), `"priority_attempts":1`) {
		t.Fatalf("real fast_context lost: %s", recorder.Body.String())
	}
	result, err := monitoring.New(p.db).Analytics(context.Background(), monitoring.Request{FromMS: 1790899999000, ToMS: 1790900011000, Include: monitoring.Include{Summary: true}})
	if err != nil {
		t.Fatal(err)
	}
	if result.Summary == nil {
		t.Fatal("official summary missing")
	}
	request = httptest.NewRequest("GET", "/management.html", nil)
	recorder = httptest.NewRecorder()
	p.handler.ServeHTTP(recorder, request)
	original, _ := os.ReadFile(panel)
	if string(original) != recorder.Body.String() {
		t.Fatal("production panel changed")
	}
	request = httptest.NewRequest("GET", "/v0/management/config", nil)
	request.Header.Set("Authorization", "Bearer "+localAdminKey)
	recorder = httptest.NewRecorder()
	p.handler.ServeHTTP(recorder, request)
	if recorder.Code != 200 {
		t.Fatalf("login config failed: %d %s", recorder.Code, recorder.Body.String())
	}
}

func TestReadOnlyRejectsWritesAndUnknownModules(t *testing.T) {
	called := false
	handler := readOnly(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true }), json.RawMessage(`{}`))
	for _, entry := range []struct {
		method, path string
		status       int
	}{{"PATCH", "/v0/management/auth-files", 403}, {"POST", "/v0/management/api-call", 403}, {"POST", "/setup", 403}, {"GET", "/api/farm/status", 501}} {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest(entry.method, entry.path, nil))
		if recorder.Code != entry.status {
			t.Fatalf("%s %s status=%d", entry.method, entry.path, recorder.Code)
		}
	}
	if called {
		t.Fatal("mutation reached official handler")
	}
}

func TestLoopbackOnly(t *testing.T) {
	for _, address := range []string{"0.0.0.0:19527", "10.1.1.201:19527", "localhost:19527"} {
		if validateListen(address) == nil {
			t.Fatalf("accepted %s", address)
		}
	}
	transport := loopbackTransport()
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport}
	for _, address := range []string{"http://10.1.1.201:18327", "https://api.openai.com", "http://localhost:19527"} {
		if _, err := client.Get(address); err == nil {
			t.Fatalf("allowed egress %s", address)
		}
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "local") }))
	defer server.Close()
	res, err := client.Get(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
}

func TestRejectModifiedSnapshot(t *testing.T) {
	dir, panel := snapshotFiles(t)
	file, err := os.OpenFile(filepath.Join(dir, "events.jsonl"), os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	file.WriteString("\n")
	file.Close()
	if p, err := newPreview(context.Background(), dir, panel); err == nil {
		p.close()
		t.Fatal("accepted changed snapshot")
	}
}
