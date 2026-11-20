package monitoring

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/app"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/config"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/security"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/adminauth"
	svc "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/monitoring"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/usage"
)

const focusStart int64 = 1778000000000
const focusKey = "test_account_focus"

func accountFocusHandler(t *testing.T, events []usage.Event) *Handler {
	t.Helper()
	return accountFocusHandlerWithStore(t, newHandlerTestStore(t), events)
}

func accountFocusHandlerWithStore(t *testing.T, db *store.Store, events []usage.Event) *Handler {
	t.Helper()
	ctx := context.Background()
	cred, err := security.NewAdminCredential(focusKey, "test")
	if err != nil {
		t.Fatal(err)
	}
	if err := db.SaveAdminCredential(ctx, cred); err != nil {
		t.Fatal(err)
	}
	if _, err := db.InsertEvents(ctx, events); err != nil {
		t.Fatal(err)
	}
	for {
		state, err := db.CatchUpUsageMonitoringProjection(ctx, 500, time.Now().UnixMilli())
		if err != nil {
			t.Fatal(err)
		}
		if !state.Pending {
			break
		}
	}
	return &Handler{App: &app.Context{AdminAuthService: adminauth.New(config.Config{}, db), MonitoringService: svc.New(db, true)}}
}
func postAccountFocus(t testing.TB, h *Handler, req svc.Request, key string, want int) svc.Response {
	t.Helper()
	b, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodPost, "/v0/management/monitoring/analytics", bytes.NewReader(b))
	if key != "" {
		r.Header.Set("Authorization", "Bearer "+key)
	}
	rec := httptest.NewRecorder()
	h.Handle(rec, r)
	if rec.Code != want {
		t.Fatalf("status %d want %d: %s", rec.Code, want, rec.Body.String())
	}
	var resp svc.Response
	if want == 200 {
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatal(err)
		}
	}
	return resp
}
func TestAccountFocusHTTPMatchesIssuedRow(t *testing.T) {
	rows := []struct{ id, index, provider, account, label, model string }{
		{"tc", "triple", "codex", "same@fixture.invalid", "tri-C", "a"}, {"tg", "triple", "claude", "same@fixture.invalid", "tri-G", "a"}, {"tu", "triple", "unknown", "same@fixture.invalid", "tri-U", "a"},
		{"lf", "lu", "codex", "left@fixture.invalid", "L", "a"}, {"lm", "lu", "unknown", "le***", "L", "b"}, {"ls", "shared", "codex", "left@fixture.invalid", "L", "a"},
		{"rf", "ru", "codex", "right@fixture.invalid", "R", "a"}, {"rm", "ru", "unknown", "ri***", "R", "b"}, {"rs", "shared", "codex", "right@fixture.invalid", "R", "a"},
	}
	events := make([]usage.Event, 0, len(rows))
	for i, row := range rows {
		ts := focusStart + int64(i+1)
		events = append(events, usage.Event{RequestID: row.id, EventHash: fmt.Sprintf("%064x", i+1), TimestampMS: ts, Timestamp: time.UnixMilli(ts).UTC().Format(time.RFC3339Nano), Model: row.model, AuthIndex: row.index, AccountSnapshot: row.account, AuthProviderSnapshot: row.provider, AuthLabelSnapshot: row.label})
	}
	h := accountFocusHandler(t, events)
	req := svc.Request{FromMS: focusStart, ToMS: focusStart + 1000, Include: svc.Include{AccountStats: true, FilterSelectors: true}}
	old := postAccountFocus(t, h, req, focusKey, 200)
	for _, r := range old.AccountStats {
		if r.AccountFocusID != "" {
			t.Fatal("unrequested token")
		}
	}
	// 原客户端发送的宽索引和账号交集仍维持旧行为；精确成员只由新字段启用。
	for _, legacy := range []struct {
		filters svc.Filters
		want    int64
	}{
		{svc.Filters{AuthIndices: []string{"triple"}}, 3},
		{svc.Filters{Accounts: []string{"left@fixture.invalid"}, AuthIndices: []string{"lu", "shared"}}, 2},
	} {
		probe := req
		probe.Filters = legacy.filters
		probe.Include = svc.Include{EventsPage: &svc.EventsPage{Limit: 50}}
		page := postAccountFocus(t, h, probe, focusKey, 200)
		if page.Events.TotalCount != legacy.want {
			t.Fatalf("legacy filters changed: got %d want %d", page.Events.TotalCount, legacy.want)
		}
	}
	req.Include.AccountFocus = true
	list := postAccountFocus(t, h, req, focusKey, 200)
	expected := map[string][]string{"tri-C": {"tc"}, "tri-G": {"tg"}, "tri-U": {"tu"}, "L": {"lf", "lm", "ls"}, "R": {"rf", "rm", "rs"}}
	for _, group := range [][]svc.AccountStatRow{list.AccountStats, list.FilterOptions.AccountStats} {
		if len(group) != 5 {
			t.Fatalf("groups=%d", len(group))
		}
		for _, row := range group {
			t.Run(row.AuthLabelSnapshot, func(t *testing.T) {
				tok := row.AccountFocusID
				if tok == "" || strings.Contains(tok, "fixture") || strings.Contains(tok, "triple") {
					t.Fatalf("unexpected token %q", tok)
				}
				q := svc.Request{FromMS: req.FromMS, ToMS: req.ToMS, Filters: svc.Filters{AccountFocusID: tok}, Include: svc.Include{Summary: true, SummaryProfile: "compact", EventsPage: &svc.EventsPage{Limit: 50}}}
				got := postAccountFocus(t, h, q, focusKey, 200)
				ids := []string{}
				for _, e := range got.Events.Items {
					ids = append(ids, e.RequestID)
				}
				slices.Sort(ids)
				want := expected[row.AuthLabelSnapshot]
				if !slices.Equal(ids, want) || got.Summary.TotalCalls != int64(len(want)) || got.Events.TotalCount != int64(len(want)) {
					t.Fatalf("got %v sum=%d count=%d want %v", ids, got.Summary.TotalCalls, got.Events.TotalCount, want)
				}
				if row.AuthLabelSnapshot == "L" {
					q.Include.EventsPage.Limit = 1
					page := postAccountFocus(t, h, q, focusKey, 200)
					if len(page.Events.Items) != 1 || !page.Events.HasMore || page.Events.TotalCount != 3 {
						t.Fatalf("incorrect page %#v", page.Events)
					}
					cursor := page.Events.Items[0]
					q.Include.EventsPage.BeforeMS = &page.Events.NextBeforeMS
					q.Include.EventsPage.BeforeID = &page.Events.NextBeforeID
					page2 := postAccountFocus(t, h, q, focusKey, 200)
					if len(page2.Events.Items) != 1 || page2.Events.Items[0].RequestID == cursor.RequestID || page2.Events.TotalCount != 3 {
						t.Fatal("bad continuation")
					}
					q.Include.EventsPage = &svc.EventsPage{Limit: 50}
					q.Filters.Models = []string{"b"}
					scoped := postAccountFocus(t, h, q, focusKey, 200)
					if scoped.Events.TotalCount != 1 || scoped.Events.Items[0].RequestID != "lm" {
						t.Fatalf("model intersection=%#v", scoped.Events)
					}
					q.Filters.Models = []string{"missing"}
					empty := postAccountFocus(t, h, q, focusKey, 200)
					if empty.Events.TotalCount != 0 || empty.Summary.TotalCalls != 0 {
						t.Fatal("empty intersection widened")
					}
					q.Filters.Models = nil
					q.FromMS = focusStart + 5
					q.ToMS = focusStart + 6
					timed := postAccountFocus(t, h, q, focusKey, 200)
					if timed.Events.TotalCount != 1 || timed.Events.Items[0].RequestID != "lm" {
						t.Fatal("narrowed time scope mismatch")
					}
					q.FromMS = focusStart + 1
					q.ToMS = focusStart + 1001
					moving := postAccountFocus(t, h, q, focusKey, 200)
					if moving.Events.TotalCount != 3 {
						t.Fatalf("moving relative window changed membership: %#v", moving.Events)
					}
					q.FromMS = focusStart + 1000
					q.ToMS = focusStart + 2000
					if disjoint := postAccountFocus(t, h, q, focusKey, 200); disjoint.Events.TotalCount != 0 {
						t.Fatal("disjoint window widened")
					}
					postAccountFocus(t, h, q, "", 401)
				}
			})
		}
	}
	q := svc.Request{FromMS: req.FromMS, ToMS: req.ToMS, Include: svc.Include{Summary: true}, Filters: svc.Filters{AccountFocusID: "af1.not-present"}}
	postAccountFocus(t, h, q, focusKey, 409)
	q.Filters.AccountFocusID = strings.Repeat("x", 129)
	postAccountFocus(t, h, q, focusKey, 422)
	wide := req
	wide.FromMS = 1
	wide.ToMS = 9999999999999
	wideList := postAccountFocus(t, h, wide, focusKey, 200)
	q = wide
	q.FromMS = focusStart
	q.ToMS = focusStart + 1000
	q.Filters = svc.Filters{AccountFocusID: wideList.AccountStats[0].AccountFocusID}
	q.Include = svc.Include{EventsPage: &svc.EventsPage{Limit: 50}}
	if r := postAccountFocus(t, h, q, focusKey, 200); r.Events.TotalCount != wideList.AccountStats[0].Calls {
		t.Fatal("all-history focus lost members")
	}
	req.Include.FilterSelectors = false
	req.Filters.Models = []string{"a"}
	filtered := postAccountFocus(t, h, req, focusKey, 200)
	for _, row := range filtered.AccountStats {
		if row.AuthLabelSnapshot == "L" {
			q.Filters = svc.Filters{AccountFocusID: row.AccountFocusID}
			q.Include.EventsPage = &svc.EventsPage{Limit: 50}
			r := postAccountFocus(t, h, q, focusKey, 200)
			if r.Events.TotalCount != 2 {
				t.Fatal("lost originating list filter", r.Events.TotalCount)
			}
			break
		}
	}
}

func TestAccountFocusChecksArchivedCoverageOnlyInsideIssuedRange(t *testing.T) {
	path := filepath.Join(t.TempDir(), "usage.sqlite")
	db, err := store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	const day = int64(24 * time.Hour / time.Millisecond)
	base := focusStart / day * day
	const id = "retained"
	stamp := base + day + 1
	h := accountFocusHandlerWithStore(t, db, []usage.Event{{EventHash: fmt.Sprintf("%064x", 1), RequestID: id, Model: "sample", AuthIndex: "index", AccountSnapshot: "test@example.invalid", AuthProviderSnapshot: "codex", TimestampMS: stamp, Timestamp: time.UnixMilli(stamp).UTC().Format(time.RFC3339Nano)}})
	origin := svc.Request{FromMS: base + day, ToMS: base + 2*day, NowMS: base + 3*day, Include: svc.Include{AccountStats: true, AccountFocus: true}}
	list := postAccountFocus(t, h, origin, focusKey, 200)
	if len(list.AccountStats) != 1 || list.AccountStats[0].AccountFocusID == "" {
		t.Fatal("missing issued account")
	}
	conn, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	// Use the actual archive coverage table for whole UTC days. No production DB or archive is involved.
	markDay := func(d int64) {
		t.Helper()
		_, err := conn.Exec("insert into usage_archive_deleted_coverage_daily(utc_day,deleted_event_count,min_timestamp_ms,max_timestamp_ms) values(?,1,?,?)", d/day, d+50, d+50)
		if err != nil {
			t.Fatal(err)
		}
	}
	markDay(base)
	q := origin
	q.FromMS = base
	q.Filters.AccountFocusID = list.AccountStats[0].AccountFocusID
	q.Include = svc.Include{Summary: true, SummaryComparison: true, EventsPage: &svc.EventsPage{Limit: 10}}
	t.Run("expanded", func(t *testing.T) {
		resp := postAccountFocus(t, h, q, focusKey, 200)
		if resp.Summary == nil || resp.Summary.TotalCalls != 1 || resp.Events == nil || resp.Events.TotalCount != 1 || len(resp.Events.Items) != 1 || resp.Events.Items[0].RequestID != id || resp.Coverage != nil {
			t.Fatalf("incorrect expanded result: %#v", resp)
		}
		if resp.SummaryComparison == nil || resp.SummaryComparison.FromMS != base-2*day || resp.SummaryComparison.ToMS != base {
			t.Fatalf("comparison range no longer based on requested window: %#v", resp.SummaryComparison)
		}
	})
	t.Run("disjoint", func(t *testing.T) {
		disjoint := q
		disjoint.ToMS = base + day
		resp := postAccountFocus(t, h, disjoint, focusKey, 200)
		if resp.Summary.TotalCalls != 0 || resp.Events.TotalCount != 0 || len(resp.Events.Items) != 0 || resp.Coverage != nil {
			t.Fatalf("incorrect disjoint result: %#v", resp)
		}
	})
	t.Run("unfocused", func(t *testing.T) {
		unscoped := q
		unscoped.Filters.AccountFocusID = ""
		resp := postAccountFocus(t, h, unscoped, focusKey, 200)
		if resp.Coverage == nil || resp.Coverage.RawDeletedEventCount != 1 {
			t.Fatalf("unfocused view lost deletion coverage: %#v", resp.Coverage)
		}
	})
	markDay(base + day)
	t.Run("deleted_inside", func(t *testing.T) { postAccountFocus(t, h, q, focusKey, 422) })
	t.Run("deleted_only_in_requested_comparison", func(t *testing.T) {
		after := q
		after.FromMS = base + 2*day
		after.ToMS = base + 3*day
		// 主窗口无交集；上一个同长度窗口正好落在签发日。
		postAccountFocus(t, h, after, focusKey, 422)
		after.Include.SummaryComparison = false
		resp := postAccountFocus(t, h, after, focusKey, 200)
		if resp.Summary.TotalCalls != 0 || resp.Events.TotalCount != 0 {
			t.Fatal("unrequested comparison must not affect empty main range")
		}
	})
}
