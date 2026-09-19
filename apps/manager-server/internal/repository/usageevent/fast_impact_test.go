package usageevent

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	sqliterepo "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/repository/sqlite"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/usage"
)

func TestFastImpactRejectsTruncatedScopeAndCancellation(t *testing.T) {
	db, err := sqliterepo.Open(filepath.Join(t.TempDir(), "usage.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	repo := New(db)
	ctx := context.Background()
	_, err = db.ExecContext(ctx, `with recursive n(x) as (select 1 union all select x+1 from n where x<100001) insert into usage_events(event_hash,timestamp_ms,timestamp,model,provider,auth_index,created_at_ms) select 'cap-'||x,1000,'2026-01-01T00:00:00Z','model','codex','account',1000 from n`)
	if err != nil {
		t.Fatal(err)
	}
	f := AnalyticsFilter{FromMS: 1, ToMS: 2000, AuthIndices: []string{"account"}, IncludeFailed: true}
	if _, err = repo.FastImpactWithFilter(ctx, f, usage.FastImpactOptions{}); err == nil || !strings.Contains(err.Error(), "100000") {
		t.Fatalf("cap=%v", err)
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err = repo.FastImpactWithFilter(cancelled, f, usage.FastImpactOptions{}); err == nil {
		t.Fatal("cancelled query succeeded")
	}
}
