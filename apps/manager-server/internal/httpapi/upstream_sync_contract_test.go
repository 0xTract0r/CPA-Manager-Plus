package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/repository/usagearchive"
	usagesvc "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/usage"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/testutil"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/usage"
)

// 每次请求记录明确的HTTP断言，方便将原始测试输出转为契约覆盖表。
func upstreamContractRequest(t *testing.T, handler http.Handler, method, path, body, key string, want int, oracle string) *httptest.ResponseRecorder {
	t.Helper()
	rr := testutil.Request(t, handler, method, path, body, key)
	t.Logf("CONTRACT\t%s\t%s\tstatus=%d;%s\tactual=%d", method, path, want, oracle, rr.Code)
	testutil.RequireStatus(t, rr, want)
	return rr
}

func TestUpstreamSyncContractArchiveActions(t *testing.T) {
	for _, async := range []bool{false, true} {
		t.Run(fmt.Sprintf("async_%t", async), func(t *testing.T) {
			cfg := testutil.NewConfig(t)
			cfg.DashboardHourlyRollupEnabled = true
			setup := &store.Setup{CPAUpstreamURL: "http://127.0.0.1:8317", ManagementKey: "management-key", Queue: "usage", PopSide: "right"}
			handler, db := newCompatHandler(t, cfg, setup)
			event := compatEvent("contract-archive", 1000)
			if _, err := db.InsertEvents(context.Background(), []usage.Event{event}); err != nil {
				t.Fatal(err)
			}
			root := "/v0/management/usage/archives"
			created := upstreamContractRequest(t, handler, http.MethodPost, root, fmt.Sprintf(`{"cutoff_timestamp_ms":%d}`, event.TimestampMS+1), testutil.AdminKey, http.StatusCreated, "one isolated event archive created")
			var status usagesvc.ArchiveStatusSummary
			testutil.DecodeJSON(t, created, &status)
			if status.Run.ID == "" || status.Run.Status != usagearchive.StatusPreviewed {
				t.Fatalf("created=%#v", status)
			}
			base := root + "/" + status.Run.ID
			for _, stage := range []struct{ action, final string }{{"resume", usagearchive.StatusArchived}, {"verify", usagearchive.StatusVerified}, {"delete", usagearchive.StatusCompleted}} {
				t.Run(stage.action, func(t *testing.T) {
					for _, key := range []string{"", "management-key"} {
						rr := upstreamContractRequest(t, handler, http.MethodPost, base+"/"+stage.action, "", key, http.StatusUnauthorized, "absent or CPA management key rejected")
						if !strings.Contains(rr.Body.String(), `"code":"invalid_admin_key"`) {
							t.Fatalf("auth=%s", rr.Body.String())
						}
					}
					upstreamContractRequest(t, handler, http.MethodGet, base+"/"+stage.action, "", testutil.AdminKey, http.StatusMethodNotAllowed, "action requires POST")
					if stage.action == "verify" {
						catchUpCompatUsageDerived(t, db)
					}
					path := base + "/" + stage.action
					want := http.StatusOK
					if async {
						path += "?wait=false"
						want = http.StatusAccepted
					}
					rr := upstreamContractRequest(t, handler, http.MethodPost, path, "", testutil.AdminKey, want, "default wait finishes action; wait=false queues with Location and Retry-After=2")
					testutil.DecodeJSON(t, rr, &status)
					if async {
						if rr.Header().Get("Location") != base || rr.Header().Get("Retry-After") != "2" {
							t.Fatalf("async headers=%v", rr.Header())
						}
						deadline := time.Now().Add(3 * time.Second)
						for time.Now().Before(deadline) {
							current := testutil.Request(t, handler, http.MethodGet, base, "", testutil.AdminKey)
							testutil.RequireStatus(t, current, http.StatusOK)
							testutil.DecodeJSON(t, current, &status)
							if status.Run.Status == stage.final {
								break
							}
							time.Sleep(10 * time.Millisecond)
						}
					}
					if status.Run.Status != stage.final {
						t.Fatalf("final stage=%#v want=%s", status.Run, stage.final)
					}
					if stage.action == "delete" && status.Run.DeletedEventCount != 1 {
						t.Fatalf("deleted count=%d", status.Run.DeletedEventCount)
					}
				})
			}
			maintenance := upstreamContractRequest(t, handler, http.MethodGet, "/v0/management/usage/maintenance", "", testutil.AdminKey, http.StatusOK, "delete removed exactly one isolated raw event")
			var state usagesvc.MaintenanceStatus
			testutil.DecodeJSON(t, maintenance, &state)
			if state.RawEventCount != 0 || state.RawDeletedEventCount != 1 {
				t.Fatalf("maintenance=%#v", state)
			}
		})
	}
}

func TestUpstreamSyncContractImportResumeDoesNotPollute(t *testing.T) {
	handler, _ := newCompatHandler(t, testutil.NewConfig(t), nil)
	root := "/v0/management/usage/import-sessions"
	line := fmt.Sprintf(`{"event_hash":%q,"timestamp_ms":1778000001000,"timestamp":"2026-05-06T00:00:01Z","model":"gpt-test","total_tokens":5}`+"\n", canonicalCompatEventHash("contract-import"))
	created := upstreamContractRequest(t, handler, http.MethodPost, root, fmt.Sprintf(`{"filename":"contract.jsonl","size_bytes":%d}`, len(line)), testutil.AdminKey, http.StatusCreated, "isolated resumable session")
	var session usagesvc.ImportSession
	testutil.DecodeJSON(t, created, &session)
	base := root + "/" + session.ID
	split := len(line) / 2
	first := upstreamContractRequest(t, handler, http.MethodPut, base+"/chunk?offset=0", line[:split], testutil.AdminKey, http.StatusOK, "partial chunk accepted")
	testutil.DecodeJSON(t, first, &session)
	digest := sha256.Sum256([]byte(line[:split]))
	prefix := hex.EncodeToString(digest[:])
	assertPrefix := func(wantBytes int, wantHash string) {
		t.Helper()
		rr := testutil.Request(t, handler, http.MethodGet, base, "", testutil.AdminKey)
		testutil.RequireStatus(t, rr, http.StatusOK)
		testutil.DecodeJSON(t, rr, &session)
		if session.ReceivedBytes != int64(wantBytes) || session.ReceivedPrefixSHA256 != wantHash {
			t.Fatalf("session mutated: %#v", session)
		}
	}
	assertPrefix(split, prefix)
	for _, tc := range []struct {
		name, offset, header string
		lengthDelta          int
		want                 int
		code                 string
	}{
		{"wrong_offset", "0", "", 0, http.StatusConflict, "usage_import_session_conflict"},
		{"unvalidated_prefix", strconv.Itoa(split), prefix, 0, http.StatusConflict, "usage_import_session_file_mismatch"},
		{"wrong_prefix", strconv.Itoa(split), strings.Repeat("0", 64), 0, http.StatusConflict, "usage_import_session_file_mismatch"},
		{"short_body", strconv.Itoa(split), prefix, -1, http.StatusBadRequest, "usage_import_session_invalid_request"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if tc.name != "wrong_offset" && tc.name != "unvalidated_prefix" {
				upstreamContractRequest(t, handler, http.MethodPost, base+"/validate", `{"prefix_sha256":"`+prefix+`"}`, testutil.AdminKey, http.StatusOK, "persisted prefix validates")
			}
			path := base + "/chunk?offset=" + tc.offset
			req := httptest.NewRequest(http.MethodPut, path, strings.NewReader(line[split:]))
			req.Header.Set("Authorization", "Bearer "+testutil.AdminKey)
			req.Header.Set("X-Usage-Import-Prefix-SHA256", tc.header)
			// 声明长度比实际正文小一字节，触发已写临时文件的回滚路径。
			req.ContentLength += int64(tc.lengthDelta)
			rr := httptest.NewRecorder()
			handler.ServeHTTP(rr, req)
			t.Logf("CONTRACT\tPUT\t%s\tstatus=%d;code=%s;offset and SHA unchanged\tactual=%d", path, tc.want, tc.code, rr.Code)
			testutil.RequireStatus(t, rr, tc.want)
			if !strings.Contains(rr.Body.String(), `"code":"`+tc.code+`"`) {
				t.Fatalf("error=%s", rr.Body.String())
			}
			assertPrefix(split, prefix)
		})
	}
	upstreamContractRequest(t, handler, http.MethodPost, base+"/validate", `{"prefix_sha256":"`+prefix+`"}`, testutil.AdminKey, http.StatusOK, "prefix still valid after rejected writes")
	req := httptest.NewRequest(http.MethodPut, base+"/chunk?offset="+strconv.Itoa(split), strings.NewReader(line[split:]))
	req.Header.Set("Authorization", "Bearer "+testutil.AdminKey)
	req.Header.Set("X-Usage-Import-Prefix-SHA256", prefix)
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	testutil.RequireStatus(t, rr, http.StatusOK)
	full := sha256.Sum256([]byte(line))
	assertPrefix(len(line), hex.EncodeToString(full[:]))
	if session.Status != usagesvc.ImportSessionStatusReady {
		t.Fatalf("status=%s", session.Status)
	}
	t.Logf("CONTRACT\tPUT\t%s/chunk?offset=%d\tstatus=200;ready;complete SHA matches original\tactual=%d", base, split, rr.Code)
}

func TestUpstreamSyncContractUpdateInputBoundaries(t *testing.T) {
	handler := newTestHandler(t, "", false)
	for _, tc := range []struct {
		name, method, path, body string
		want                     int
	}{
		{"wrong_method", http.MethodPost, "/usage-service/updates", "", http.StatusMethodNotAllowed},
		{"apply_absent", http.MethodPost, "/usage-service/updates/apply", "", http.StatusMethodNotAllowed},
		{"trailing_slash", http.MethodGet, "/usage-service/updates/", "", http.StatusMethodNotAllowed},
		{"invalid_channel", http.MethodPut, "/usage-service/updates/channel", `{"channel_preference":"nightly"}`, http.StatusBadRequest},
		{"oversize_channel", http.MethodPut, "/usage-service/updates/channel", strings.Repeat(" ", 1025) + `{"channel_preference":"beta"}`, http.StatusBadRequest},
		{"oversize_dismiss", http.MethodPost, "/usage-service/updates/dismiss", strings.Repeat(" ", 1025) + `{"version":"v2"}`, http.StatusBadRequest},
		{"valid_channel", http.MethodPut, "/usage-service/updates/channel", `{"channel_preference":"beta"}`, http.StatusOK},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rr := upstreamContractRequest(t, handler, tc.method, tc.path, tc.body, testutil.AdminKey, tc.want, "strict method/suffix/channel and 1024-byte JSON decode limit")
			if rr.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("cache=%v", rr.Header())
			}
		})
	}
}
