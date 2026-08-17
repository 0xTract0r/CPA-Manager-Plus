package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/managerconfig"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
)

type Service struct {
	managerConfigService *managerconfig.Service
	farmOrchestratorURL  string
	farmOrchestratorKey  string
}

const cpaPluginResourcePrefix = "/v0/resource/plugins"
const cpaManagementPrefix = "/v0/management"
const codexInviteOriginHeader = "X-Codex-Invite-Origin"
const managementOriginJSONField = "management_origin"

var cpaBuiltinManagementPathHeads = map[string]struct{}{
	"account-action-candidates": {},
	"accounts":                  {},
	"api-call":                  {},
	"api-key-aliases":           {},
	"api-key-usage":             {},
	"auth-files":                {},
	"codex-inspection":          {},
	"config":                    {},
	"dashboard":                 {},
	"model-prices":              {},
	"monitoring":                {},
	"plugin-store":              {},
	"plugins":                   {},
	"reload":                    {},
	"usage":                     {},
	"usage-statistics-enabled":  {},
}

func New(managerConfigService *managerconfig.Service, farmOrchestratorURL string, farmOrchestratorKey string) *Service {
	return &Service{
		managerConfigService: managerConfigService,
		farmOrchestratorURL:  farmOrchestratorURL,
		farmOrchestratorKey:  farmOrchestratorKey,
	}
}

func (s *Service) ProxyManagement(w http.ResponseWriter, r *http.Request, writeError func(http.ResponseWriter, int, error)) {
	s.proxyWithSavedManagementKey(w, r, writeError)
}

func (s *Service) ProxyPluginManagement(w http.ResponseWriter, r *http.Request, writeError func(http.ResponseWriter, int, error)) {
	if !IsCPAPluginManagementPath(r.URL.Path) {
		writeError(w, http.StatusNotFound, errors.New("proxy path must be a CPA plugin management path"))
		return
	}
	s.proxyToSavedSetup(w, r, writeError, true, true)
}

func (s *Service) ProxyPluginManagementWithCallerAuth(w http.ResponseWriter, r *http.Request, writeError func(http.ResponseWriter, int, error)) {
	if !IsCPAPluginManagementPath(r.URL.Path) {
		writeError(w, http.StatusNotFound, errors.New("proxy path must be a CPA plugin management path"))
		return
	}
	s.proxyToSavedSetup(w, r, writeError, false, true)
}

func (s *Service) ProxyPluginResource(w http.ResponseWriter, r *http.Request, writeError func(http.ResponseWriter, int, error)) {
	if !IsCPAPluginResourcePath(r.URL.Path) {
		writeError(w, http.StatusNotFound, errors.New("proxy path must be under /v0/resource/plugins/"))
		return
	}
	s.proxyToSavedSetup(w, r, writeError, true, true)
}

func (s *Service) ProxyPluginResourceWithCallerAuth(w http.ResponseWriter, r *http.Request, writeError func(http.ResponseWriter, int, error)) {
	if !IsCPAPluginResourcePath(r.URL.Path) {
		writeError(w, http.StatusNotFound, errors.New("proxy path must be under /v0/resource/plugins/"))
		return
	}
	s.proxyToSavedSetup(w, r, writeError, false, true)
}

func (s *Service) proxyWithSavedManagementKey(w http.ResponseWriter, r *http.Request, writeError func(http.ResponseWriter, int, error)) {
	if !isManagementPath(r.URL.Path) {
		writeError(w, http.StatusNotFound, errors.New("proxy path must be under /v0/management/"))
		return
	}
	s.proxyToSavedSetup(w, r, writeError, true, false)
}

func (s *Service) proxyToSavedSetup(w http.ResponseWriter, r *http.Request, writeError func(http.ResponseWriter, int, error), useSavedManagementKey bool, rewritePluginOrigin bool) {
	setup, ok, err := s.resolveSetup(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if !ok {
		writeError(w, http.StatusPreconditionRequired, errors.New("usage service is not configured"))
		return
	}
	target, err := url.Parse(setup.CPAUpstreamURL)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if rewritePluginOrigin {
		if err := rewritePluginManagementOriginBody(r, target); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	originalDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		originalDirector(req)
		req.URL.Scheme = target.Scheme
		req.URL.Host = target.Host
		req.Host = target.Host
		if useSavedManagementKey {
			req.Header.Set("Authorization", "Bearer "+setup.ManagementKey)
		}
		if rewritePluginOrigin {
			rewriteCodexInviteOrigin(req.Header, target)
		}
	}
	proxy.ModifyResponse = stripUpstreamCORSHeadersResponse
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, err error) {
		writeError(w, http.StatusBadGateway, err)
	}
	proxy.ServeHTTP(w, r)
}

// upstreamCORSResponseHeaders 是上游 core 可能自带的 CORS 响应头。
// manager-server 自身的 CORS 策略统一由 middleware.WriteCORS 在更外层
// 直接写入 http.ResponseWriter；这里剥离的是反向代理拿到的**上游**响应头
// (httputil.ReverseProxy 用 Header().Add 合并响应头，若不剥离会和中间件
// 已写入的头叠加成重复值，浏览器拒绝多值 CORS 头)。
// Vary 头一般保留，不在剥离范围内。
var upstreamCORSResponseHeaders = []string{
	"Access-Control-Allow-Origin",
	"Access-Control-Allow-Methods",
	"Access-Control-Allow-Headers",
	"Access-Control-Allow-Credentials",
	"Access-Control-Expose-Headers",
	"Access-Control-Max-Age",
}

// stripUpstreamCORSHeaders 从响应头中删除所有上游 CORS 相关头。
// http.Header.Del 对 header name 做规范化，大小写不敏感。
func stripUpstreamCORSHeaders(header http.Header) {
	for _, name := range upstreamCORSResponseHeaders {
		header.Del(name)
	}
}

// stripUpstreamCORSHeadersResponse 是 httputil.ReverseProxy.ModifyResponse
// 的实现，在响应从上游读回、但尚未写入客户端 ResponseWriter 之前，剥离
// 上游自带的 CORS 头，避免与 manager-server 中间件的 CORS 头重复叠加。
func stripUpstreamCORSHeadersResponse(resp *http.Response) error {
	if resp == nil {
		return nil
	}
	stripUpstreamCORSHeaders(resp.Header)
	return nil
}

func rewriteCodexInviteOrigin(header http.Header, target *url.URL) {
	if header == nil || target == nil || header.Get(codexInviteOriginHeader) == "" {
		return
	}
	origin := target.Scheme + "://" + target.Host
	if origin == "://" {
		return
	}
	header.Set(codexInviteOriginHeader, origin)
}

func rewritePluginManagementOriginBody(r *http.Request, target *url.URL) error {
	if r == nil || r.Body == nil || target == nil || !isJSONContentType(r.Header.Get("Content-Type")) {
		return nil
	}
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		return err
	}
	if errClose := r.Body.Close(); errClose != nil {
		return errClose
	}
	restoreBody := func(body []byte) {
		r.Body = io.NopCloser(bytes.NewReader(body))
		r.ContentLength = int64(len(body))
		bodyCopy := append([]byte(nil), body...)
		r.GetBody = func() (io.ReadCloser, error) {
			return io.NopCloser(bytes.NewReader(bodyCopy)), nil
		}
	}
	if len(bytes.TrimSpace(raw)) == 0 {
		restoreBody(raw)
		return nil
	}

	var payload map[string]json.RawMessage
	if errUnmarshal := json.Unmarshal(raw, &payload); errUnmarshal != nil {
		restoreBody(raw)
		return nil
	}
	if _, ok := payload[managementOriginJSONField]; !ok {
		restoreBody(raw)
		return nil
	}
	origin := target.Scheme + "://" + target.Host
	if origin == "://" {
		restoreBody(raw)
		return nil
	}
	encodedOrigin, errMarshal := json.Marshal(origin)
	if errMarshal != nil {
		restoreBody(raw)
		return errMarshal
	}
	payload[managementOriginJSONField] = encodedOrigin
	next, errMarshal := json.Marshal(payload)
	if errMarshal != nil {
		restoreBody(raw)
		return errMarshal
	}
	restoreBody(next)
	return nil
}

func isJSONContentType(value string) bool {
	contentType := strings.ToLower(strings.TrimSpace(strings.Split(value, ";")[0]))
	return contentType == "application/json" || strings.HasSuffix(contentType, "+json")
}

func (s *Service) ProxyModelList(w http.ResponseWriter, r *http.Request, writeError func(http.ResponseWriter, int, error), methodNotAllowed func(http.ResponseWriter)) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	if !isModelListPath(r.URL.Path) {
		writeError(w, http.StatusNotFound, errors.New("model list proxy path must be /v1/models"))
		return
	}
	setup, ok, err := s.resolveSetup(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if !ok {
		writeError(w, http.StatusPreconditionRequired, errors.New("usage service is not configured"))
		return
	}
	target, err := url.Parse(setup.CPAUpstreamURL)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	originalDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		originalDirector(req)
		req.URL.Scheme = target.Scheme
		req.URL.Host = target.Host
		req.Host = target.Host
	}
	proxy.ModifyResponse = stripUpstreamCORSHeadersResponse
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, err error) {
		writeError(w, http.StatusBadGateway, err)
	}
	proxy.ServeHTTP(w, r)
}

// ProxyFarm 把 /api/farm/* 反向代理到农场编排器。农场 key 只在服务端 Director
// 里注入，绝不进浏览器；调用方(cpamp admin key)鉴权由上层控制器完成，本方法
// 只负责在已鉴权前提下转发并注入 farm 凭据。
//
// 目标 URL 来自 config(farmOrchestratorURL)，若为空说明本实例未接入农场编排器，
// 直接返回 503 而非 panic。路径不做 rewrite：两端前缀都是 /api/farm/，保持
// req.URL.Path 原样透传。上游自带的 CORS 头由 ModifyResponse 剥离，避免和
// manager-server 中间件已写入的 CORS 头重复叠加。
func (s *Service) ProxyFarm(w http.ResponseWriter, r *http.Request, writeError func(http.ResponseWriter, int, error)) {
	if strings.TrimSpace(s.farmOrchestratorURL) == "" {
		writeError(w, http.StatusServiceUnavailable, errors.New("farm proxy not configured"))
		return
	}
	target, err := url.Parse(s.farmOrchestratorURL)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	originalDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		originalDirector(req)
		req.URL.Scheme = target.Scheme
		req.URL.Host = target.Host
		req.Host = target.Host
		// 先删除调用方传入的任何 Authorization(cpamp admin key)，再注入服务端
		// 持有的 farm key，防止把 cpamp 凭据透传给农场编排器，也防止 farm key
		// 被调用方伪造覆盖。
		req.Header.Del("Authorization")
		req.Header.Set("Authorization", "Bearer "+s.farmOrchestratorKey)
	}
	proxy.ModifyResponse = stripUpstreamCORSHeadersResponse
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, err error) {
		writeError(w, http.StatusBadGateway, err)
	}
	proxy.ServeHTTP(w, r)
}

func isModelListPath(path string) bool {
	cleaned := strings.TrimRight(path, "/")
	return cleaned == "/v1/models" || cleaned == "/models"
}

func isManagementPath(path string) bool {
	if isStrictManagementPath(path) {
		return true
	}
	return IsCPAPluginResourcePath(path)
}

func isStrictManagementPath(path string) bool {
	return path == "/v0/management" || strings.HasPrefix(path, "/v0/management/")
}

func IsCPAPluginManagementPath(path string) bool {
	cleaned := strings.TrimRight(path, "/")
	if !strings.HasPrefix(cleaned, cpaManagementPrefix+"/") {
		return false
	}
	rest := strings.TrimPrefix(cleaned, cpaManagementPrefix+"/")
	head, _, _ := strings.Cut(rest, "/")
	if head == "" {
		return false
	}
	_, reserved := cpaBuiltinManagementPathHeads[head]
	return !reserved
}

func IsCPAPluginResourcePath(path string) bool {
	cleaned := strings.TrimRight(path, "/")
	return cleaned == cpaPluginResourcePrefix || strings.HasPrefix(cleaned, cpaPluginResourcePrefix+"/")
}

func (s *Service) resolveSetup(ctx context.Context) (store.Setup, bool, error) {
	return s.managerConfigService.ResolveSetup(ctx)
}
