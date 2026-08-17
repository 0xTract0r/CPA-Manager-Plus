package proxy

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/app"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/config"
	adminauthsvc "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/adminauth"
	proxysvc "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/proxy"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/testutil"
)

const farmProxyTestKey = "farm-orch-secret-key"

type observedFarmRequest struct {
	path          string
	authorization string
}

// newFakeOrchestrator 起一个假农场编排器：记录每个到达的请求(路径 + Authorization)，
// 并像真实上游一样自带 CORS 头返回，用来验证 manager-server 会剥离上游 CORS。
func newFakeOrchestrator(t *testing.T) (*httptest.Server, func() []observedFarmRequest) {
	t.Helper()
	var mu sync.Mutex
	var observed []observedFarmRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		observed = append(observed, observedFarmRequest{
			path:          r.URL.Path,
			authorization: r.Header.Get("Authorization"),
		})
		mu.Unlock()
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Credentials", "true")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"nodes":[]}`))
	}))
	t.Cleanup(server.Close)
	snapshot := func() []observedFarmRequest {
		mu.Lock()
		defer mu.Unlock()
		out := make([]observedFarmRequest, len(observed))
		copy(out, observed)
		return out
	}
	return server, snapshot
}

// newFarmHandler 组装一个带真实 cpamp admin 鉴权的 proxy 控制器。store 里已由
// testutil 注入 testutil.AdminKey 对应的 admin credential；ProxyFarm 不使用
// managerConfigService，故传 nil。
func newFarmHandler(t *testing.T, orchestratorURL string, farmKey string) *Handler {
	t.Helper()
	st := testutil.NewStore(t, testutil.NewConfig(t))
	return &Handler{App: &app.Context{
		AdminAuthService: adminauthsvc.New(config.Config{}, st),
		ProxyService:     proxysvc.New(nil, orchestratorURL, farmKey),
	}}
}

// TestFarmRejectsInvalidAdminKey 断言：调用方没有有效 cpamp admin key 时返回 401，
// 且假农场编排器完全不被访问(鉴权在代理之前，请求绝不透传)。
func TestFarmRejectsInvalidAdminKey(t *testing.T) {
	cases := []struct {
		name string
		auth string
	}{
		{name: "missing authorization", auth: ""},
		{name: "wrong admin key", auth: "Bearer not-the-admin-key"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			orchestrator, requests := newFakeOrchestrator(t)
			handler := newFarmHandler(t, orchestrator.URL, farmProxyTestKey)

			req := httptest.NewRequest(http.MethodGet, "/api/farm/nodes", nil)
			if tc.auth != "" {
				req.Header.Set("Authorization", tc.auth)
			}
			rec := httptest.NewRecorder()
			handler.Farm(rec, req)

			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d, want 401, body = %s", rec.Code, rec.Body.String())
			}
			if got := requests(); len(got) != 0 {
				t.Fatalf("orchestrator received %d requests, want 0 (unauthorized caller must be blocked before proxy)", len(got))
			}
		})
	}
}

// TestFarmProxiesWithInjectedFarmKey 断言：调用方带有效 cpamp admin key 时请求被
// 代理到假农场编排器，且上游收到的 Authorization 是服务端注入的 farm key，而不是
// 调用方自己的 admin key；路径不被 rewrite。
func TestFarmProxiesWithInjectedFarmKey(t *testing.T) {
	orchestrator, requests := newFakeOrchestrator(t)
	handler := newFarmHandler(t, orchestrator.URL, farmProxyTestKey)

	req := httptest.NewRequest(http.MethodGet, "/api/farm/nodes", nil)
	req.Header.Set("Authorization", "Bearer "+testutil.AdminKey)
	rec := httptest.NewRecorder()
	handler.Farm(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body = %s", rec.Code, rec.Body.String())
	}
	got := requests()
	if len(got) != 1 {
		t.Fatalf("orchestrator received %d requests, want 1", len(got))
	}
	if got[0].path != "/api/farm/nodes" {
		t.Fatalf("orchestrator path = %q, want /api/farm/nodes (path must not be rewritten)", got[0].path)
	}
	if got[0].authorization != "Bearer "+farmProxyTestKey {
		t.Fatalf("orchestrator Authorization = %q, want %q (server-injected farm key)", got[0].authorization, "Bearer "+farmProxyTestKey)
	}
	if got[0].authorization == "Bearer "+testutil.AdminKey {
		t.Fatalf("orchestrator received caller admin key; farm proxy must never forward caller credential")
	}

	body, err := io.ReadAll(rec.Result().Body)
	if err != nil {
		t.Fatalf("read proxied body: %v", err)
	}
	if !strings.Contains(string(body), "nodes") {
		t.Fatalf("proxied body = %q, want upstream payload", string(body))
	}
}

// TestFarmStripsUpstreamCORSHeaders 断言：上游农场编排器自带的 CORS 头在回给
// 调用方之前被剥离，避免和 manager-server 中间件的 CORS 头重复叠加。
func TestFarmStripsUpstreamCORSHeaders(t *testing.T) {
	orchestrator, _ := newFakeOrchestrator(t)
	handler := newFarmHandler(t, orchestrator.URL, farmProxyTestKey)

	req := httptest.NewRequest(http.MethodGet, "/api/farm/nodes", nil)
	req.Header.Set("Authorization", "Bearer "+testutil.AdminKey)
	rec := httptest.NewRecorder()
	handler.Farm(rec, req)

	result := rec.Result()
	if got := result.Header.Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("Access-Control-Allow-Origin = %q, want empty (upstream CORS must be stripped)", got)
	}
	if got := result.Header.Get("Access-Control-Allow-Credentials"); got != "" {
		t.Fatalf("Access-Control-Allow-Credentials = %q, want empty (upstream CORS must be stripped)", got)
	}
}

// TestFarmReturns503WhenNotConfigured 断言：未配置农场编排器地址时(FARM_ORCH_URL
// 为空)，已鉴权调用方拿到 503 而不是 panic。
func TestFarmReturns503WhenNotConfigured(t *testing.T) {
	handler := newFarmHandler(t, "", "")

	req := httptest.NewRequest(http.MethodGet, "/api/farm/nodes", nil)
	req.Header.Set("Authorization", "Bearer "+testutil.AdminKey)
	rec := httptest.NewRecorder()
	handler.Farm(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503, body = %s", rec.Code, rec.Body.String())
	}
}
