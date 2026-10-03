// snapshot-preview 只运行本地完整客户端；所有统计由正式路由在隔离 SQLite 中计算。
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/collector"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/config"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/httpapi"
	sqliterepo "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/repository/sqlite"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/bootstrap"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/managerconfig"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/usage"
)

// 公开的本地预览口令，绝不能用于生产。
const localAdminKey = "local-snapshot-preview"

type manifest struct {
	CapturedAt    string            `json:"captured_at"`
	FromMS        int64             `json:"from_ms"`
	ToMS          int64             `json:"to_ms"`
	SourceTotal   int               `json:"source_total"`
	Exported      int               `json:"exported"`
	Complete      bool              `json:"complete"`
	SyntheticRows int               `json:"synthetic_rows"`
	EventsSHA256  string            `json:"events_sha256"`
	FileSHA256    map[string]string `json:"file_sha256"`
}

type preview struct {
	handler  http.Handler
	db       *store.Store
	core     *httptest.Server
	dir      string
	manifest manifest
}

// 只接受脱敏账号元数据；未知字段（包括令牌、邮箱）直接拒绝。
type snapshotAccounts struct {
	Files []struct {
		Name            string `json:"name"`
		AuthIndex       string `json:"auth_index"`
		Note            string `json:"note"`
		Provider        string `json:"provider"`
		Type            string `json:"type"`
		Disabled        bool   `json:"disabled"`
		AccountSettings struct {
			Fast *bool `json:"fast"`
		} `json:"account_settings"`
	} `json:"files"`
}

func main() {
	input := flag.String("snapshot", "", "脱敏快照目录（manifest.json、events.jsonl、auth-files.json）")
	panel := flag.String("panel", "", "正式 production dist/index.html；不改写 HTML")
	listen := flag.String("listen", "127.0.0.1:19527", "仅 loopback IP 的监听地址")
	flag.Parse()
	if err := validateListen(*listen); err != nil {
		log.Fatal(err)
	}
	if *input == "" || *panel == "" {
		flag.Usage()
		os.Exit(2)
	}
	// 保留 *http.Transport 类型，现有服务 Clone 后仍继承相同出站限制。
	http.DefaultTransport = loopbackTransport()
	p, err := newPreview(context.Background(), *input, *panel)
	if err != nil {
		log.Fatal(err)
	}
	defer p.close()
	server := &http.Server{Addr: *listen, Handler: p.handler, ReadHeaderTimeout: 5 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	log.Printf("本地快照客户端 http://%s/management.html；记录=%d；截止=%s；本地登录口令=%s", *listen, p.manifest.Exported, p.manifest.CapturedAt, localAdminKey)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Print(err)
	}
}

func validateListen(address string) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() {
		return errors.New("preview must bind to a loopback IP")
	}
	return nil
}

func loopbackTransport() *http.Transport {
	return &http.Transport{Proxy: nil, DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		host, _, err := net.SplitHostPort(address)
		// 拒绝域名，避免 DNS 重绑定及代理环境变量绕过。
		if err != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() {
			return nil, errors.New("snapshot preview blocks non-loopback egress")
		}
		return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, network, address)
	}, TLSHandshakeTimeout: 5 * time.Second, ResponseHeaderTimeout: 30 * time.Second}
}

func newPreview(ctx context.Context, snapshotDir, panelPath string) (_ *preview, err error) {
	panel, err := os.Stat(panelPath)
	if err != nil || panel.IsDir() {
		return nil, errors.New("--panel must point to an existing production HTML file")
	}
	manifestBytes, err := os.ReadFile(filepath.Join(snapshotDir, "manifest.json"))
	if err != nil {
		return nil, err
	}
	var m manifest
	if err = json.Unmarshal(manifestBytes, &m); err != nil {
		return nil, err
	}
	if !m.Complete || m.SyntheticRows != 0 || m.Exported <= 0 || m.SourceTotal != m.Exported || len(m.EventsSHA256) != 64 {
		return nil, errors.New("snapshot manifest must describe complete, non-synthetic source records")
	}
	authBytes, err := os.ReadFile(filepath.Join(snapshotDir, "auth-files.json"))
	if err != nil || !json.Valid(authBytes) {
		return nil, errors.New("invalid auth-files snapshot")
	}
	authHash := sha256.Sum256(authBytes)
	if hex.EncodeToString(authHash[:]) != strings.ToLower(m.FileSHA256["auth-files.json"]) {
		return nil, errors.New("auth-files snapshot SHA256 differs from manifest")
	}
	var accounts snapshotAccounts
	decoder := json.NewDecoder(bytes.NewReader(authBytes))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&accounts); err != nil {
		return nil, errors.New("auth-files snapshot contains unsupported fields")
	}
	authBytes, _ = json.Marshal(accounts)
	dir, err := os.MkdirTemp("", "cpamp-snapshot-")
	if err != nil {
		return nil, err
	}
	p := &preview{dir: dir, manifest: m}
	defer func() {
		if err != nil {
			p.close()
		}
	}()
	database, err := sqliterepo.Open(filepath.Join(dir, "usage.sqlite"))
	if err != nil {
		return nil, err
	}
	p.db = store.New(database)
	if err = importPrices(ctx, p.db, database, snapshotDir, m); err != nil {
		return nil, err
	}
	models, err := importSnapshot(ctx, p.db, filepath.Join(snapshotDir, "events.jsonl"), m)
	if err != nil {
		return nil, err
	}
	p.core = httptest.NewServer(coreMetadata(authBytes, models))
	cfg := config.Config{HTTPAddr: "127.0.0.1:19527", DataDir: dir, DBPath: filepath.Join(dir, "usage.sqlite"), PanelPath: panelPath, AdminKey: localAdminKey, CPAUpstreamURL: p.core.URL, ManagementKey: localAdminKey, QueryLimit: 50000, PollInterval: time.Second}
	if _, err = bootstrap.Run(ctx, cfg, p.db, true); err != nil {
		return nil, err
	}
	managerCfg := managerconfig.New(cfg, p.db, nil).DefaultManagerConfig()
	// 正式前端用此能力开关显示历史用量；预览进程从不启动采集 worker。
	managerCfg.Collector.Enabled = managerconfig.BoolPtr(true)
	managerCfg.CodexInspection.Enabled = managerconfig.BoolPtr(false)
	if err = p.db.SaveManagerConfig(ctx, managerCfg); err != nil {
		return nil, err
	}
	// NewManager 构造函数不启动 goroutine；不调用任何 collector/automation/inspection worker。
	server := httpapi.New(cfg, p.db, collector.NewManager(cfg, p.db))
	resolved, _, _, err := server.AppContext().ManagerConfigService.ResolveManagerConfigWithSource(ctx)
	if err != nil {
		return nil, err
	}
	if !managerconfig.ManagerCollectorEnabled(resolved) {
		return nil, errors.New("historical usage capability must remain visible")
	}
	// 不回放任意原始manifest字段，只公开经过选择的快照描述。
	publicManifest, _ := json.Marshal(map[string]any{"captured_at": m.CapturedAt, "from_ms": m.FromMS, "to_ms": m.ToMS, "exported": m.Exported, "complete": m.Complete, "synthetic_rows": m.SyntheticRows, "events_sha256": m.EventsSHA256})
	metadata := coreMetadata(authBytes, models)
	application := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/models" {
			metadata.ServeHTTP(w, r)
			return
		}
		server.Handler().ServeHTTP(w, r)
	})
	p.handler = readOnly(application, publicManifest)
	return p, nil
}

func (p *preview) close() {
	if p.core != nil {
		p.core.Close()
	}
	if p.db != nil {
		_ = p.db.Close()
	}
	if p.dir != "" {
		_ = os.RemoveAll(p.dir)
	}
}

func importPrices(ctx context.Context, db *store.Store, database *sql.DB, snapshotDir string, m manifest) error {
	data, err := os.ReadFile(filepath.Join(snapshotDir, "model-prices.json"))
	if err != nil {
		return err
	}
	hash := sha256.Sum256(data)
	if hex.EncodeToString(hash[:]) != strings.ToLower(m.FileSHA256["model-prices.json"]) {
		return errors.New("model-prices snapshot SHA256 differs from manifest")
	}
	var payload struct {
		Prices map[string]store.ModelPrice `json:"prices"`
	}
	if err = json.Unmarshal(data, &payload); err != nil {
		return err
	}
	if payload.Prices == nil {
		return errors.New("model-prices snapshot must contain prices")
	}
	if err = db.SaveModelPrices(ctx, payload.Prices); err != nil {
		return err
	}
	// 正式 ReplaceAll 会写本地导入时间；快照回放恢复源时间，避免误称价格刚刚更新。
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for model, price := range payload.Prices {
		if _, err = tx.ExecContext(ctx, "update model_prices set updated_at_ms = ? where model = ?", price.UpdatedAtMS, model); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func importSnapshot(ctx context.Context, db *store.Store, path string, m manifest) ([]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	hasher := sha256.New()
	scanner := bufio.NewScanner(io.TeeReader(f, hasher))
	scanner.Buffer(make([]byte, 65536), 10*1024*1024)
	batch := make([]usage.Event, 0, 256)
	count := 0
	models := map[string]bool{}
	flush := func() error {
		if len(batch) == 0 {
			return nil
		}
		result, err := db.InsertEvents(ctx, batch)
		if err != nil {
			return err
		}
		if result.Inserted != len(batch) {
			return errors.New("snapshot contains duplicate or rejected events")
		}
		batch = batch[:0]
		return nil
	}
	for scanner.Scan() {
		if strings.TrimSpace(scanner.Text()) == "" {
			continue
		}
		var event usage.Event
		// 使用 Event 直接解码，保留 telemetry 和原始 token 计数，不走旧 CSV 重建逻辑。
		if err = json.Unmarshal(scanner.Bytes(), &event); err != nil {
			return nil, fmt.Errorf("snapshot record %d is invalid: %w", count+1, err)
		}
		if event.EventHash == "" || event.TimestampMS <= 0 {
			return nil, errors.New("snapshot event missing identity or time")
		}
		if event.Timestamp == "" {
			event.Timestamp = time.UnixMilli(event.TimestampMS).UTC().Format(time.RFC3339Nano)
		}
		models[event.Model] = true
		batch = append(batch, event)
		count++
		if len(batch) == cap(batch) {
			if err = flush(); err != nil {
				return nil, err
			}
		}
	}
	if err = scanner.Err(); err != nil {
		return nil, err
	}
	if err = flush(); err != nil {
		return nil, err
	}
	if count != m.Exported || hex.EncodeToString(hasher.Sum(nil)) != strings.ToLower(m.EventsSHA256) {
		return nil, errors.New("snapshot count or SHA256 differs from manifest")
	}
	result := make([]string, 0, len(models))
	for model := range models {
		if model != "" {
			result = append(result, model)
		}
	}
	sort.Strings(result)
	return result, nil
}

func coreMetadata(auth json.RawMessage, models []string) http.Handler {
	var accounts snapshotAccounts
	_ = json.Unmarshal(auth, &accounts)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "本地快照只读，不支持账号或配置修改"})
			return
		}
		if r.URL.Path != "/v1/models" && r.Header.Get("Authorization") != "Bearer "+localAdminKey {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}
		w.Header().Set("X-CPA-Version", "local-snapshot")
		path := strings.TrimRight(r.URL.Path, "/")
		switch path {
		case "/v0/management/config":
			writeJSON(w, 200, map[string]any{"usage-statistics-enabled": true, "proxy-url": "", "routing": map[string]string{"strategy": "round-robin"}, "api-keys": []string{}, "snapshot-preview": true})
		case "/v0/management/config.yaml":
			w.Header().Set("Content-Type", "application/yaml")
			_, _ = io.WriteString(w, "usage-statistics-enabled: true\nproxy-url: ''\nrouting:\n  strategy: round-robin\napi-keys: []\n")
		case "/v0/management/auth-files":
			writeJSON(w, 200, auth)
		case "/v0/management/auth-files/account-settings", "/v0/management/auth-files/download":
			for _, account := range accounts.Files {
				if account.Name != r.URL.Query().Get("name") {
					continue
				}
				if strings.HasSuffix(path, "/account-settings") {
					writeJSON(w, 200, map[string]any{"name": account.Name, "account_settings": map[string]any{"fast": account.AccountSettings.Fast, "note": account.Note, "disabled": account.Disabled}})
				} else {
					writeJSON(w, 200, account)
				}
				return
			}
			writeJSON(w, 404, map[string]string{"error": "snapshot account not found"})
		case "/v0/management/oauth-model-alias", "/v0/management/oauth-excluded-models":
			writeJSON(w, 200, map[string]any{strings.TrimPrefix(path, "/v0/management/"): map[string]any{}})
		case "/v0/management/openai-compatibility", "/v0/management/api-keys", "/v0/management/claude-api-key", "/v0/management/gemini-api-key", "/v0/management/codex-api-key":
			// 预览本地配置不含供应商或客户端密钥，不代表生产密钥数量。
			writeJSON(w, 200, map[string]any{strings.TrimPrefix(path, "/v0/management/"): []any{}, "snapshot_credentials_excluded": true})
		case "/v0/management/request-error-logs":
			writeJSON(w, 200, map[string]any{"files": []any{}, "snapshot_logs_excluded": true})
		case "/v0/management/latest-version":
			writeJSON(w, 200, map[string]any{"snapshot_update_check_disabled": true})
		case "/v0/management/auth-files/models", "/v1/models", "/models":
			items := make([]map[string]string, 0, len(models))
			for _, model := range models {
				items = append(items, map[string]string{"id": model, "object": "model", "owned_by": "codex"})
			}
			writeJSON(w, 200, map[string]any{"data": items, "models": items, "object": "list"})
		default:
			writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "本地快照未覆盖此模块", "code": "snapshot_not_covered"})
		}
	})
}

func readOnly(next http.Handler, manifestBytes json.RawMessage) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-CPAMP-Snapshot", "read-only")
		// 完整正式 HTML 原样返回；CSP 仅在预览进程阻止浏览器连接生产/供应商。
		w.Header().Set("Content-Security-Policy", "connect-src 'self'; form-action 'self'; base-uri 'self'")
		path := strings.TrimRight(r.URL.Path, "/")
		if path == "/snapshot-manifest" && r.Method == http.MethodGet {
			writeJSON(w, 200, manifestBytes)
			return
		}
		read := r.Method == http.MethodGet || r.Method == http.MethodHead || r.Method == http.MethodOptions
		queryPost := r.Method == http.MethodPost && (path == "/v0/management/monitoring/analytics" || path == "/v0/management/monitoring/account-history")
		if !read && !queryPost {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "本地快照只读：此操作不会执行", "code": "snapshot_read_only"})
			return
		}
		if strings.HasPrefix(path, "/api/farm") || strings.HasPrefix(path, "/v0/management/codex-inspection") || strings.HasPrefix(path, "/v0/management/account-action-candidates") || path == "/usage-service/account-processing-policy" || path == "/usage-service/quota-cooldowns" {
			writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "本地快照未包含此模块的数据", "code": "snapshot_not_covered"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
