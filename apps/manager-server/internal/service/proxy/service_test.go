package proxy

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"strings"
	"testing"
)

func TestIsManagementPath(t *testing.T) {
	tests := []struct {
		path string
		want bool
	}{
		{path: "/v0/management", want: true},
		{path: "/v0/management/", want: true},
		{path: "/v0/management/auth-files", want: true},
		{path: "/v0/management/auth-files/status", want: true},
		{path: "/v0/management/api-call", want: true},
		{path: "/v0/management/api-key-usage", want: true},
		{path: "/v0/resource/plugins", want: true},
		{path: "/v0/resource/plugins/codex-invite/invite", want: true},
		{path: "/v0/resource/plugin", want: false},
		{path: "/v0/resource/plugin-store", want: false},
		{path: "/v1/models", want: false},
		{path: "/models", want: false},
		{path: "/auth-files", want: false},
		{path: "/api-call", want: false},
		{path: "/", want: false},
		{path: "", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			if got := isManagementPath(tt.path); got != tt.want {
				t.Fatalf("isManagementPath(%q) = %v, want %v", tt.path, got, tt.want)
			}
		})
	}
}

func TestIsModelListPath(t *testing.T) {
	tests := []struct {
		path string
		want bool
	}{
		{path: "/v1/models", want: true},
		{path: "/v1/models/", want: true},
		{path: "/models", want: true},
		{path: "/models/", want: true},
		{path: "/v1/chat/completions", want: false},
		{path: "", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			if got := isModelListPath(tt.path); got != tt.want {
				t.Fatalf("isModelListPath(%q) = %v, want %v", tt.path, got, tt.want)
			}
		})
	}
}

func TestIsCPAPluginManagementPath(t *testing.T) {
	tests := []struct {
		path string
		want bool
	}{
		{path: "/v0/management/codex-invite/accounts", want: true},
		{path: "/v0/management/sample-plugin/custom/action", want: true},
		{path: "/v0/management/accounts", want: false},
		{path: "/v0/management/accounts/", want: false},
		{path: "/v0/management/config", want: false},
		{path: "/v0/management/reload", want: false},
		{path: "/v0/management/plugins/demo/custom", want: false},
		{path: "/v0/management/plugin-store/demo/install", want: false},
		{path: "/v0/management/usage", want: false},
		{path: "/v0/resource/plugins/codex-invite/invite", want: false},
		{path: "/v0/management", want: false},
		{path: "/v0/management/", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			if got := IsCPAPluginManagementPath(tt.path); got != tt.want {
				t.Fatalf("IsCPAPluginManagementPath(%q) = %v, want %v", tt.path, got, tt.want)
			}
		})
	}
}

func TestIsCPAPluginResourcePath(t *testing.T) {
	tests := []struct {
		path string
		want bool
	}{
		{path: "/v0/resource/plugins", want: true},
		{path: "/v0/resource/plugins/", want: true},
		{path: "/v0/resource/plugins/codex-invite/invite", want: true},
		{path: "/v0/resource/plugins/codex-invite/assets/app.js", want: true},
		{path: "/v0/resource/plugin", want: false},
		{path: "/v0/resource/plugin-store", want: false},
		{path: "/plugins/codex-invite/invite", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			if got := IsCPAPluginResourcePath(tt.path); got != tt.want {
				t.Fatalf("IsCPAPluginResourcePath(%q) = %v, want %v", tt.path, got, tt.want)
			}
		})
	}
}

func TestRewriteCodexInviteOrigin(t *testing.T) {
	target, err := url.Parse("http://cpa.local:8317/base")
	if err != nil {
		t.Fatalf("parse target: %v", err)
	}

	header := http.Header{}
	header.Set(codexInviteOriginHeader, "http://manager.local:18317")
	header.Set("Origin", "http://manager.local:18317")

	rewriteCodexInviteOrigin(header, target)

	if got := header.Get(codexInviteOriginHeader); got != "http://cpa.local:8317" {
		t.Fatalf("%s = %q", codexInviteOriginHeader, got)
	}
	if got := header.Get("Origin"); got != "http://manager.local:18317" {
		t.Fatalf("Origin = %q", got)
	}

	emptyHeader := http.Header{}
	rewriteCodexInviteOrigin(emptyHeader, target)
	if got := emptyHeader.Get(codexInviteOriginHeader); got != "" {
		t.Fatalf("empty %s = %q", codexInviteOriginHeader, got)
	}
}

func TestRewritePluginManagementOriginBody(t *testing.T) {
	target, err := url.Parse("http://cpa.local:8317")
	if err != nil {
		t.Fatalf("parse target: %v", err)
	}

	req, err := http.NewRequest(
		http.MethodPost,
		"/v0/management/codex-invite/invite",
		strings.NewReader(`{"management_origin":"http://manager.local:18317","refresh":true}`),
	)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")

	if err := rewritePluginManagementOriginBody(req, target); err != nil {
		t.Fatalf("rewritePluginManagementOriginBody() error = %v", err)
	}
	raw, err := io.ReadAll(req.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	want := `{"management_origin":"http://cpa.local:8317","refresh":true}`
	if string(raw) != want {
		t.Fatalf("body = %q, want %q", raw, want)
	}
	if req.ContentLength != int64(len(want)) {
		t.Fatalf("content length = %d, want %d", req.ContentLength, len(want))
	}
}

// TestStripUpstreamCORSHeaders 断言 stripUpstreamCORSHeaders 删除全部上游
// CORS 相关头（大小写不敏感），且不动其他头（含 Vary）。
func TestStripUpstreamCORSHeaders(t *testing.T) {
	header := http.Header{}
	header.Set("Access-Control-Allow-Origin", "*")
	header.Set("Access-Control-Allow-Methods", "GET, POST")
	header.Set("Access-Control-Allow-Headers", "Content-Type")
	header.Set("Access-Control-Allow-Credentials", "true")
	header.Set("Access-Control-Expose-Headers", "X-Trace-Id")
	header.Set("Access-Control-Max-Age", "600")
	// 大小写不敏感场景：上游可能以任意大小写写入
	header.Add("access-control-allow-origin", "http://evil.example")
	header.Set("Vary", "Origin")
	header.Set("Content-Type", "application/json")

	stripUpstreamCORSHeaders(header)

	for _, name := range upstreamCORSResponseHeaders {
		if got := header.Values(name); len(got) != 0 {
			t.Fatalf("header %s not stripped, got %v", name, got)
		}
	}
	if got := header.Get("Vary"); got != "Origin" {
		t.Fatalf("Vary header should be preserved, got %q", got)
	}
	if got := header.Get("Content-Type"); got != "application/json" {
		t.Fatalf("Content-Type header should be preserved, got %q", got)
	}
}

// TestReverseProxyStripsDuplicateUpstreamCORSHeaders 是端到端场景：
// 构造一个 mock 上游 handler，像真实 core 一样自带 CORS 头返回响应；
// 用与 proxyToSavedSetup/ProxyModelList 相同的 ReverseProxy + ModifyResponse
// 组装方式转发；再模拟外层 middleware.WriteCORS 已经在 ResponseWriter 上
// 写过一份 manager-server 自己的 CORS 头。断言最终响应里 CORS 头不重复
// (每个 header name 只有一个值)，且值来自 manager-server 中间件那份，
// 上游那份被剥离。
func TestReverseProxyStripsDuplicateUpstreamCORSHeaders(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 模拟上游 core 自己也写了一份 CORS 头
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization")
		w.Header().Set("Access-Control-Allow-Credentials", "true")
		w.Header().Set("Access-Control-Expose-Headers", "X-Upstream-Trace")
		w.Header().Set("Access-Control-Max-Age", "3600")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer upstream.Close()

	target, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatalf("parse upstream url: %v", err)
	}

	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.ModifyResponse = stripUpstreamCORSHeadersResponse

	req := httptest.NewRequest(http.MethodGet, "/v0/management/dashboard", nil)
	req.Header.Set("Origin", "http://manager.local:18519")
	rec := httptest.NewRecorder()

	// 模拟外层 middleware.WithCORS 已经先在同一个 ResponseWriter 上写过
	// manager-server 自己的一份 CORS 头，时序与 router.go 一致：
	// WriteCORS(w, r) 先执行，再调用 next(w, r) 进入代理 handler。
	rec.Header().Set("Access-Control-Allow-Origin", "*")
	rec.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
	rec.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")

	proxy.ServeHTTP(rec, req)

	result := rec.Result()
	corsHeaders := []string{
		"Access-Control-Allow-Origin",
		"Access-Control-Allow-Methods",
		"Access-Control-Allow-Headers",
		"Access-Control-Allow-Credentials",
		"Access-Control-Expose-Headers",
		"Access-Control-Max-Age",
	}
	for _, name := range corsHeaders {
		values := result.Header.Values(name)
		if len(values) > 1 {
			t.Fatalf("header %s has duplicate values %v, want at most one", name, values)
		}
	}

	// manager-server 自己写的三个头必须保留且是唯一值来源。
	if got := result.Header.Get("Access-Control-Allow-Origin"); got != "*" {
		t.Fatalf("Access-Control-Allow-Origin = %q, want manager-server value %q", got, "*")
	}
	if got := result.Header.Get("Access-Control-Allow-Methods"); got != "GET, POST, PUT, PATCH, DELETE, OPTIONS" {
		t.Fatalf("Access-Control-Allow-Methods = %q, want manager-server value", got)
	}
	if got := result.Header.Get("Access-Control-Allow-Headers"); got != "Authorization, Content-Type" {
		t.Fatalf("Access-Control-Allow-Headers = %q, want manager-server value", got)
	}
	// 上游独有的两个头（manager-server 中间件未设置）必须被完全剥离，不残留上游值。
	if got := result.Header.Get("Access-Control-Allow-Credentials"); got != "" {
		t.Fatalf("Access-Control-Allow-Credentials = %q, want empty (upstream value must be stripped)", got)
	}
	if got := result.Header.Get("Access-Control-Expose-Headers"); got != "" {
		t.Fatalf("Access-Control-Expose-Headers = %q, want empty (upstream value must be stripped)", got)
	}
	if got := result.Header.Get("Access-Control-Max-Age"); got != "" {
		t.Fatalf("Access-Control-Max-Age = %q, want empty (upstream value must be stripped)", got)
	}
	// 非 CORS 头正常透传。
	if got := result.Header.Get("Content-Type"); got != "application/json" {
		t.Fatalf("Content-Type = %q, want application/json", got)
	}
}

func TestRewritePluginManagementOriginBodyLeavesOtherBodies(t *testing.T) {
	target, err := url.Parse("http://cpa.local:8317")
	if err != nil {
		t.Fatalf("parse target: %v", err)
	}

	req, err := http.NewRequest(http.MethodPost, "/v0/resource/plugins/demo", strings.NewReader(`{"refresh":true}`))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")

	if err := rewritePluginManagementOriginBody(req, target); err != nil {
		t.Fatalf("rewritePluginManagementOriginBody() error = %v", err)
	}
	raw, err := io.ReadAll(req.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	if string(raw) != `{"refresh":true}` {
		t.Fatalf("body = %q", raw)
	}
}
