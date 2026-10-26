package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/config"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/managerconfig"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
)

func accountSettingsIdentityRequest(t *testing.T, selector string, withIdentity bool) *http.Request {
	t.Helper()
	req := httptest.NewRequest(http.MethodPatch, "/v0/management/auth-files/account-settings", strings.NewReader(`{"name":"`+selector+`","note":"changed","proxy_url":"socks5://synthetic.example:1080"}`))
	req.Header.Set("Content-Type", "application/json")
	if withIdentity {
		req.Header.Set(authFileMutationIdentityHeader, url.QueryEscape(`[{"name":"account.json","runtimeId":"runtime-1","authIndex":"auth-1","provider":"claude","accountId":"account-1"}]`))
	}
	return req
}

func accountSettingsProxy(t *testing.T, upstream string) *Service {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "usage.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	if err = st.SaveSetup(context.Background(), store.Setup{CPAUpstreamURL: upstream, ManagementKey: "captured-management-key"}); err != nil {
		t.Fatal(err)
	}
	return New(managerconfig.New(config.Config{}, st, nil), st)
}

func runAccountSettingsProxy(service *Service, req *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	service.ProxyManagement(rec, req, func(w http.ResponseWriter, status int, err error) { http.Error(w, err.Error(), status) })
	return rec
}

func TestAccountSettingsProxyVerifiesIdentityAndRewritesSelector(t *testing.T) {
	for _, tc := range []struct {
		name, runtime, account, selector string
		identity                         bool
		status                           int
	}{
		{"valid physical selector", "runtime-1", "account-1", "account.json", true, 200},
		{"valid runtime selector", "runtime-1", "account-1", "runtime-1", true, 200},
		{"same name replaced account", "runtime-1", "replacement", "account.json", true, 409},
		{"same index replaced runtime", "runtime-new", "account-1", "runtime-1", true, 404},
		{"unrelated selector", "runtime-1", "account-1", "unrelated.json", true, 409},
		{"legacy still writable", "runtime-1", "account-1", "account.json", false, 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			forwarded := 0
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer captured-management-key" {
					t.Error("request lost saved connection credential")
				}
				if r.Method == http.MethodGet {
					_ = json.NewEncoder(w).Encode([]map[string]any{{"id": tc.runtime, "name": "account.json", "auth_index": "auth-1", "provider": "claude", "account_id": tc.account}})
					return
				}
				forwarded++
				if r.URL.Path != "/v0/management/auth-files/account-settings" {
					t.Errorf("path=%s", r.URL.Path)
				}
				if r.Header.Get(authFileMutationIdentityHeader) != "" {
					t.Error("private identity header leaked to core")
				}
				var body map[string]any
				_ = json.NewDecoder(r.Body).Decode(&body)
				want := tc.selector
				if tc.identity {
					want = "runtime-1"
				}
				if body["name"] != want || body["note"] != "changed" || body["proxy_url"] != "socks5://synthetic.example:1080" {
					t.Errorf("body=%v", body)
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok"})
			}))
			defer upstream.Close()
			rec := runAccountSettingsProxy(accountSettingsProxy(t, upstream.URL), accountSettingsIdentityRequest(t, tc.selector, tc.identity))
			if rec.Code != tc.status {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			want := 0
			if tc.status == 200 {
				want = 1
			}
			if forwarded != want {
				t.Fatalf("forwarded=%d want=%d", forwarded, want)
			}
		})
	}
}

func TestAccountSettingsProxyCoordinatesAndReleasesAfterFailure(t *testing.T) {
	for _, failFirst := range []bool{false, true} {
		t.Run(map[bool]string{false: "rechecks replacement after first write", true: "unlocks after upstream failure"}[failFirst], func(t *testing.T) {
			firstStarted := make(chan struct{})
			releaseFirst := make(chan struct{})
			var mu sync.Mutex
			calls := 0
			account := "account-1"
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodGet {
					mu.Lock()
					value := account
					mu.Unlock()
					_ = json.NewEncoder(w).Encode([]map[string]any{{"id": "runtime-1", "name": "account.json", "auth_index": "auth-1", "provider": "claude", "account_id": value}})
					return
				}
				mu.Lock()
				calls++
				call := calls
				mu.Unlock()
				if call == 1 {
					close(firstStarted)
					<-releaseFirst
					if failFirst {
						http.Error(w, "write failed", 500)
						return
					}
					mu.Lock()
					account = "replacement"
					mu.Unlock()
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok"})
			}))
			defer upstream.Close()
			service := accountSettingsProxy(t, upstream.URL)
			run := func() <-chan *httptest.ResponseRecorder {
				done := make(chan *httptest.ResponseRecorder, 1)
				go func() {
					done <- runAccountSettingsProxy(service, accountSettingsIdentityRequest(t, "account.json", true))
				}()
				return done
			}
			first := run()
			<-firstStarted
			second := run()
			select {
			case result := <-second:
				close(releaseFirst)
				t.Fatalf("second bypassed held coordinator: %d", result.Code)
			case <-time.After(60 * time.Millisecond):
			}
			close(releaseFirst)
			a, b := <-first, <-second
			wantA, wantB := 200, 409
			if failFirst {
				wantA, wantB = 500, 200
			}
			if a.Code != wantA || b.Code != wantB {
				t.Fatalf("statuses=%d,%d bodies=%s/%s", a.Code, b.Code, a.Body.String(), b.Body.String())
			}
			mu.Lock()
			defer mu.Unlock()
			wantCalls := 1
			if failFirst {
				wantCalls = 2
			}
			if calls != wantCalls {
				t.Fatalf("upstream writes=%d want=%d", calls, wantCalls)
			}
		})
	}
}
