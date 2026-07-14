package monitoring

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/app"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/config"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/security"
	adminauthsvc "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/adminauth"
	monitoringsvc "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/monitoring"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
)

func TestHandleAccountHistoryRejectsUnknownTargetFields(t *testing.T) {
	st := newHandlerTestStore(t)
	const adminKey = "cpamp_test_key"
	credential, err := security.NewAdminCredential(adminKey, "test")
	if err != nil {
		t.Fatalf("create admin credential: %v", err)
	}
	if err := st.SaveAdminCredential(context.Background(), credential); err != nil {
		t.Fatalf("save admin credential: %v", err)
	}
	handler := &Handler{App: &app.Context{
		AdminAuthService:  adminauthsvc.New(config.Config{}, st),
		MonitoringService: monitoringsvc.New(st),
	}}
	req := httptest.NewRequest(
		http.MethodPost,
		"/v0/management/monitoring/account-history",
		bytes.NewBufferString(`{"accounts":[{"source_hash":"source-only"}]}`),
	)
	req.Header.Set("Authorization", "Bearer "+adminKey)
	recorder := httptest.NewRecorder()

	handler.Handle(recorder, req)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d body = %s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), "source_hash") {
		t.Fatalf("body = %s", recorder.Body.String())
	}
}

// TestAnalyticsErrorStatusDoesNotReportContextCancelAs500 guards the fix for
// a real production 500: a wide time range ("all time" / from_ms=1) on a
// large usage_events table can take longer to aggregate than a reverse
// proxy or browser fetch timeout allows. When that happens the caller
// disconnects, the request context is canceled mid-query, and the store
// returns a wrapped context.Canceled/context.DeadlineExceeded error. That is
// an expected "the caller stopped waiting" outcome, not a server crash, and
// must not be reported as a generic 500.
func TestAnalyticsErrorStatusDoesNotReportContextCancelAs500(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want int
	}{
		{
			name: "context canceled while querying",
			err:  fmt.Errorf("query usage_events: %w", context.Canceled),
			want: 499,
		},
		{
			name: "context deadline exceeded while querying",
			err:  fmt.Errorf("query usage_events: %w", context.DeadlineExceeded),
			want: http.StatusGatewayTimeout,
		},
		{
			name: "genuine server error stays 500",
			err:  errors.New("sqlite: disk I/O error"),
			want: http.StatusInternalServerError,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := analyticsErrorStatus(tt.err); got != tt.want {
				t.Fatalf("analyticsErrorStatus(%v) = %d, want %d", tt.err, got, tt.want)
			}
		})
	}
}

// TestHandleAnalyticsReportsClientClosedRequestNotServerError reproduces the
// end-to-end path: a client disconnects (context canceled) while the wide
// time range analytics query is still running. Before the fix, the handler
// mapped this to 500; it must now report 499 so operators/dashboards don't
// mistake an abandoned slow query for a server crash.
func TestHandleAnalyticsReportsClientClosedRequestNotServerError(t *testing.T) {
	st := newHandlerTestStore(t)
	const adminKey = "cpamp_test_key"
	credential, err := security.NewAdminCredential(adminKey, "test")
	if err != nil {
		t.Fatalf("create admin credential: %v", err)
	}
	if err := st.SaveAdminCredential(context.Background(), credential); err != nil {
		t.Fatalf("save admin credential: %v", err)
	}
	handler := &Handler{App: &app.Context{
		AdminAuthService:  adminauthsvc.New(config.Config{}, st),
		MonitoringService: monitoringsvc.New(st),
	}}

	body := `{"from_ms":1,"to_ms":9999999999999,"include":{"summary":true}}`
	req := httptest.NewRequest(http.MethodPost, "/v0/management/monitoring/analytics", bytes.NewBufferString(body))
	req.Header.Set("Authorization", "Bearer "+adminKey)

	// Simulate a client/proxy that has already given up: the request context
	// is canceled before the handler even starts the (still valid) query.
	ctx, cancel := context.WithCancel(req.Context())
	cancel()
	req = req.WithContext(ctx)

	recorder := httptest.NewRecorder()
	handler.Handle(recorder, req)

	if recorder.Code != 499 {
		t.Fatalf("status = %d body = %s, want 499", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), "request_canceled") {
		t.Fatalf("body = %s, want request_canceled code", recorder.Body.String())
	}
}

func newHandlerTestStore(t testing.TB) *store.Store {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "usage.sqlite"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() {
		_ = st.Close()
	})
	return st
}
