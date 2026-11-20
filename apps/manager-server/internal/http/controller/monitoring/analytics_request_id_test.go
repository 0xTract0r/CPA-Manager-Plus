package monitoring

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/app"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/config"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/security"
	adminauth "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/adminauth"
	monitoring "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/monitoring"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/usage"
)

func TestHandleAnalyticsRequestIDWithReadyProjection(t *testing.T) {
	db := newHandlerTestStore(t)
	ctx := context.Background()
	const key = "cpamp_test_key"
	cred, err := security.NewAdminCredential(key, "test")
	if err != nil {
		t.Fatal(err)
	}
	if err := db.SaveAdminCredential(ctx, cred); err != nil {
		t.Fatal(err)
	}
	const base = int64(1778000000000)
	for i, id := range []string{"wanted", "other"} {
		ts := base + int64(i) + 1
		e := usage.Event{EventHash: fmt.Sprintf("%064x", i+1), RequestID: id, Model: "m", TimestampMS: ts, Timestamp: time.UnixMilli(ts).UTC().Format(time.RFC3339Nano)}
		if _, err := db.InsertEvents(ctx, []usage.Event{e}); err != nil {
			t.Fatal(err)
		}
	}
	for {
		state, err := db.CatchUpUsageMonitoringProjection(ctx, 100, base+1000)
		if err != nil {
			t.Fatal(err)
		}
		if !state.Pending {
			break
		}
	}
	h := Handler{App: &app.Context{AdminAuthService: adminauth.New(config.Config{}, db), MonitoringService: monitoring.New(db, true)}}
	body := fmt.Sprintf(`{"from_ms":%d,"to_ms":%d,"filters":{"models":["m"],"request_ids":["wanted"]},"include":{"summary":true,"events_page":{"limit":10}}}`, base, base+1000)
	req := httptest.NewRequest(http.MethodPost, "/v0/management/monitoring/analytics", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+key)
	rec := httptest.NewRecorder()
	h.Handle(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, %s", rec.Code, rec.Body.String())
	}
	var resp monitoring.Response
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Events == nil || resp.Summary == nil {
		t.Fatalf("missing events/summary: %s", rec.Body.String())
	}
	ids := []string{}
	for _, event := range resp.Events.Items {
		ids = append(ids, event.RequestID)
	}
	if resp.Summary.TotalCalls != 1 || resp.Events.TotalCount != 1 || len(ids) != 1 || ids[0] != "wanted" {
		t.Fatalf("summary=%d, total_count=%d, request IDs=%v; want only wanted", resp.Summary.TotalCalls, resp.Events.TotalCount, ids)
	}
}
