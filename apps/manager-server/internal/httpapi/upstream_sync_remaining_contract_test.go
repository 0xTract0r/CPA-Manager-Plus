package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/model"
	accountactionsvc "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/accountaction"
	quotasnapshotsvc "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/quotasnapshot"
	usagesvc "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/usage"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/testutil"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/usage"
)

func TestUpstreamSyncContractImportSessionDelete(t *testing.T) {
	handler, db := newCompatHandler(t, testutil.NewConfig(t), nil)
	root := "/v0/management/usage/import-sessions"
	create := func(name string) usagesvc.ImportSession {
		rr := upstreamContractRequest(t, handler, http.MethodPost, root, `{"filename":"`+name+`","size_bytes":8}`, testutil.AdminKey, http.StatusCreated, "new upload session")
		var s usagesvc.ImportSession
		testutil.DecodeJSON(t, rr, &s)
		return s
	}
	target := create("cancel.jsonl")
	other := create("keep.jsonl")
	for _, s := range []usagesvc.ImportSession{target, other} {
		upstreamContractRequest(t, handler, http.MethodPut, root+"/"+s.ID+"/chunk?offset=0", "abcd", testutil.AdminKey, http.StatusOK, "partial upload exists before cancellation")
	}
	read := func(id string) usagesvc.ImportSession {
		rr := upstreamContractRequest(t, handler, http.MethodGet, root+"/"+id, "", testutil.AdminKey, http.StatusOK, "session status remains queryable")
		var s usagesvc.ImportSession
		testutil.DecodeJSON(t, rr, &s)
		return s
	}
	if _, err := db.InsertEvents(context.Background(), []usage.Event{compatEvent("keep-real-event", 1)}); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"", "wrong-key"} {
		upstreamContractRequest(t, handler, http.MethodDelete, root+"/"+target.ID, "", key, http.StatusUnauthorized, "unauthorized cancellation rejected")
		state := read(target.ID)
		if state.Status != usagesvc.ImportSessionStatusUploading || state.ReceivedBytes != 4 {
			t.Fatalf("unauthorized changed target=%#v", state)
		}
	}
	missing := strings.Repeat("f", 32)
	rr := upstreamContractRequest(t, handler, http.MethodDelete, root+"/"+missing, "", testutil.AdminKey, http.StatusNotFound, "missing session error code")
	if !strings.Contains(rr.Body.String(), `"code":"usage_import_session_not_found"`) {
		t.Fatalf("missing=%s", rr.Body.String())
	}
	cancel := upstreamContractRequest(t, handler, http.MethodDelete, root+"/"+target.ID, "", testutil.AdminKey, http.StatusOK, "uploading session transitions to cancelled")
	var cancelled usagesvc.ImportSession
	testutil.DecodeJSON(t, cancel, &cancelled)
	if cancelled.ID != target.ID || cancelled.Status != usagesvc.ImportSessionStatusCancelled {
		t.Fatalf("cancelled=%#v", cancelled)
	}
	if state := read(target.ID); state.Status != usagesvc.ImportSessionStatusCancelled {
		t.Fatalf("persisted cancel=%#v", state)
	}
	preserved := read(other.ID)
	digest := sha256.Sum256([]byte("abcd"))
	if preserved.Status != usagesvc.ImportSessionStatusUploading || preserved.ReceivedBytes != 4 || preserved.ReceivedPrefixSHA256 != hex.EncodeToString(digest[:]) {
		t.Fatalf("other upload changed=%#v", preserved)
	}
	usageRR := upstreamContractRequest(t, handler, http.MethodGet, "/v0/management/usage", "", testutil.AdminKey, http.StatusOK, "upload cancellation preserves imported raw event")
	if !strings.Contains(usageRR.Body.String(), `"total_requests":1`) {
		t.Fatalf("usage=%s", usageRR.Body.String())
	}
}

func TestUpstreamSyncContractAccountActions(t *testing.T) {
	for _, action := range []string{"ignore", "resolve", "enable", "auth-file"} {
		t.Run(action, func(t *testing.T) {
			var upstreamCalls, mutations atomic.Int32
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				upstreamCalls.Add(1)
				if r.Header.Get("Authorization") != "Bearer contract-management-key" {
					t.Errorf("unexpected mock authorization")
					http.Error(w, "unauthorized", 401)
					return
				}
				switch r.Method + " " + r.URL.Path {
				case "GET /v0/management/auth-files":
					_ = json.NewEncoder(w).Encode([]map[string]any{{"id": "runtime-codex-7", "name": "codex-auth.json", "auth_index": "7", "provider": "codex", "account": "user@example.com", "account_id": "acct-123", "disabled": true}})
				case "PATCH /v0/management/auth-files/status":
					var p struct {
						Name      string `json:"name"`
						AuthIndex string `json:"auth_index"`
						Disabled  bool   `json:"disabled"`
					}
					if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
						t.Error(err)
					}
					if action != "enable" || p.Name != "runtime-codex-7" || p.AuthIndex != "7" || p.Disabled {
						t.Errorf("unexpected patch=%#v action=%s", p, action)
					}
					mutations.Add(1)
					_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
				case "DELETE /v0/management/auth-files":
					if action != "auth-file" || r.URL.Query().Get("name") != "runtime-codex-7" {
						t.Errorf("unexpected delete selector=%s", r.URL.RawQuery)
					}
					mutations.Add(1)
					_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
				default:
					t.Errorf("unexpected mock request %s %s", r.Method, r.URL.Path)
					http.NotFound(w, r)
				}
			}))
			defer upstream.Close()
			setup := &store.Setup{CPAUpstreamURL: upstream.URL, ManagementKey: "contract-management-key", Queue: "usage", PopSide: "right"}
			handler, db := newCompatHandler(t, testutil.NewConfig(t), setup)
			candidate, err := db.UpsertAccountActionCandidate(context.Background(), model.AccountActionCandidateUpsert{ActionType: model.AccountActionTypeDelete, Provider: "codex", AuthFileName: "codex-auth.json", AuthIndex: "7", AccountSnapshot: "user@example.com", AccountIDSnapshot: "acct-123", Reason: "contract fixture"})
			if err != nil {
				t.Fatal(err)
			}
			root := "/v0/management/account-action-candidates"
			path := root + "/" + strconv.FormatInt(candidate.ID, 10) + "/" + action
			method := http.MethodPost
			if action == "auth-file" {
				method = http.MethodDelete
			}
			for _, key := range []string{"", "wrong-key"} {
				upstreamContractRequest(t, handler, method, path, "", key, http.StatusUnauthorized, "action requires manager admin credential")
			}
			current, ok, err := db.GetAccountActionCandidate(context.Background(), candidate.ID)
			if err != nil || !ok || current.Status != model.AccountActionStatusPending || upstreamCalls.Load() != 0 {
				t.Fatalf("unauth changed state=%#v err=%v calls=%d", current, err, upstreamCalls.Load())
			}
			upstreamContractRequest(t, handler, http.MethodGet, root, "", "", http.StatusUnauthorized, "candidate list requires authentication")
			listed := upstreamContractRequest(t, handler, http.MethodGet, root+"?status=pending&limit=1", "", testutil.AdminKey, http.StatusOK, "list contains exact candidate and pendingCount1")
			var list accountactionsvc.ListResponse
			testutil.DecodeJSON(t, listed, &list)
			if len(list.Items) != 1 || list.Items[0].ID != candidate.ID || list.PendingCount != 1 {
				t.Fatalf("list=%#v", list)
			}
			upstreamContractRequest(t, handler, http.MethodPost, root, "", testutil.AdminKey, http.StatusMethodNotAllowed, "list only GET")
			upstreamContractRequest(t, handler, http.MethodGet, path, "", testutil.AdminKey, http.StatusMethodNotAllowed, "action rejects GET")
			upstreamContractRequest(t, handler, method, root+"/0/"+action, "", testutil.AdminKey, http.StatusBadRequest, "non-positive ID400")
			upstreamContractRequest(t, handler, method, root+"/99999/"+action, "", testutil.AdminKey, http.StatusNotFound, "missing candidate404")
			changed := upstreamContractRequest(t, handler, method, path, "", testutil.AdminKey, http.StatusOK, "successful real service transition")
			var result struct {
				Item model.AccountActionCandidate `json:"item"`
			}
			testutil.DecodeJSON(t, changed, &result)
			want := model.AccountActionStatusResolved
			if action == "ignore" {
				want = model.AccountActionStatusIgnored
			}
			if action == "auth-file" {
				want = model.AccountActionStatusDeleted
			}
			persisted, ok, err := db.GetAccountActionCandidate(context.Background(), candidate.ID)
			if result.Item.ID != candidate.ID || result.Item.Status != want || err != nil || !ok || persisted.Status != want {
				t.Fatalf("response=%#v persisted=%#v err=%v", result, persisted, err)
			}
			if action == "enable" || action == "auth-file" {
				if mutations.Load() != 1 {
					t.Fatalf("mutation count=%d", mutations.Load())
				}
			} else if upstreamCalls.Load() != 0 {
				t.Fatalf("local action called upstream%d", upstreamCalls.Load())
			}
			upstreamContractRequest(t, handler, method, path, "", testutil.AdminKey, http.StatusConflict, "second action rejects nonpending candidate409")
			if action == "enable" || action == "auth-file" {
				if mutations.Load() != 1 {
					t.Fatalf("repeat mutated again=%d", mutations.Load())
				}
				// 新建不匹配身份，仅允许查询假CPA，禁止外部mutation。
				bad, err := db.UpsertAccountActionCandidate(context.Background(), model.AccountActionCandidateUpsert{ActionType: model.AccountActionTypeDelete, Provider: "codex", AuthFileName: "codex-auth.json", AuthIndex: "8", AccountSnapshot: "user@example.com", AccountIDSnapshot: "acct-123", Reason: "mismatch fixture"})
				if err != nil {
					t.Fatal(err)
				}
				upstreamContractRequest(t, handler, method, root+"/"+strconv.FormatInt(bad.ID, 10)+"/"+action, "", testutil.AdminKey, http.StatusConflict, "current CPA identity differs; no mutation")
				after, ok, err := db.GetAccountActionCandidate(context.Background(), bad.ID)
				if err != nil || !ok || after.Status != model.AccountActionStatusPending || mutations.Load() != 1 {
					t.Fatalf("conflict polluted=%#v mutations=%d err=%v", after, mutations.Load(), err)
				}
			}
		})
	}
}

func TestUpstreamSyncContractAccountActionRequiresSetup(t *testing.T) {
	handler, db := newCompatHandler(t, testutil.NewConfig(t), nil)
	for _, action := range []string{"enable", "auth-file"} {
		t.Run(action, func(t *testing.T) {
			item, err := db.UpsertAccountActionCandidate(context.Background(), model.AccountActionCandidateUpsert{ActionType: model.AccountActionTypeDelete, Provider: "codex", AuthFileName: action + ".json", AuthIndex: action, Reason: "unconfigured"})
			if err != nil {
				t.Fatal(err)
			}
			method := http.MethodPost
			if action == "auth-file" {
				method = http.MethodDelete
			}
			upstreamContractRequest(t, handler, method, fmt.Sprintf("/v0/management/account-action-candidates/%d/%s", item.ID, action), "", testutil.AdminKey, http.StatusPreconditionRequired, "unconfigured real service maps to428")
			state, ok, err := db.GetAccountActionCandidate(context.Background(), item.ID)
			if err != nil || !ok || state.Status != model.AccountActionStatusPending {
				t.Fatalf("unconfigured changed=%#v err=%v", state, err)
			}
		})
	}
}

func TestUpstreamSyncContractQuotaRouterPrecedesGenericProxy(t *testing.T) {
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		http.Error(w, "quota must remain local", http.StatusBadGateway)
	}))
	defer upstream.Close()
	handler, _ := newCompatHandler(t, testutil.NewConfig(t), &store.Setup{CPAUpstreamURL: upstream.URL, ManagementKey: "mock-key", Queue: "usage", PopSide: "right"})
	root := "/v0/management/quota-snapshots"
	write := `{"entries":[{"row_key":"row-1","provider":"codex","account":{"auth_file_snapshot":"codex.json","auth_index":"auth-1"},"windows":[{"provider_window_id":"five-hour","window_kind":"five_hour","window_mode":"fixed","model_scope_kind":"all","source":"api_query","observed_at_ms":1000,"boundary_accuracy":"exact","cycle_start_ms":1000,"cycle_end_ms":19000000,"duration_seconds":18999,"used_percent":20}]}]}`
	query := `{"accounts":[{"row_key":"row-1","provider":"codex","account":{"auth_file_snapshot":"codex.json","auth_index":"auth-1"}}]}`
	for _, tc := range []struct{ path, body string }{{root, write}, {root + "/query", query}} {
		upstreamContractRequest(t, handler, http.MethodPost, tc.path, tc.body, "", http.StatusUnauthorized, "local quota route rejects unauthenticated request")
	}
	upstreamContractRequest(t, handler, http.MethodPost, root, write, testutil.AdminKey, http.StatusOK, "local write through real router")
	rr := upstreamContractRequest(t, handler, http.MethodPost, root+"/query", query, testutil.AdminKey, http.StatusOK, "local query returns persisted five-hour window")
	var result quotasnapshotsvc.QueryResponse
	testutil.DecodeJSON(t, rr, &result)
	if len(result.Items) != 1 || len(result.Items[0].Windows) != 1 || result.Items[0].Windows[0].ProviderWindowID != "five-hour" {
		t.Fatalf("result=%#v", result)
	}
	upstreamContractRequest(t, handler, http.MethodPost, root+"/query", `{"accounts":[],"unexpected":true}`, testutil.AdminKey, http.StatusBadRequest, "unknown field rejected locally")
	if calls.Load() != 0 {
		t.Fatalf("local quota routes leaked to generic proxy: %d calls", calls.Load())
	}
}
