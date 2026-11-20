package monitoring

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
)

func TestAccountFocusLimitsExpiryAndRestart(t *testing.T) {
	s := &Service{}
	origin := store.AnalyticsFilter{FromMS: 1, ToMS: 200, IncludeFailed: true}
	issue := func(key string) *accountFocusBuilder {
		b := s.newAccountFocus(origin, true, false)
		b.collect(key, focusMember{"codex", "account", "label", "credential", "hash"})
		return b
	}
	rows := []AccountStatRow{{ID: "row"}}
	issue("row").attach(rows)
	token := rows[0].AccountFocusID
	issue("row").attach(rows)
	if token == "" || rows[0].AccountFocusID != token || len(s.focus.entries) != 1 {
		t.Fatal("unchanged list did not reuse its token")
	}
	if _, err := new(accountFocusCache).resolve(token); !errors.Is(err, ErrAccountFocusExpired) {
		t.Fatal("restart accepted old token")
	}
	el := s.focus.entries[token]
	entry := el.Value.(focusSnapshot)
	entry.expires = time.Now().Add(-time.Second)
	el.Value = entry
	if _, err := s.focus.resolve(token); !errors.Is(err, ErrAccountFocusExpired) {
		t.Fatal("expired token accepted")
	}
	for _, kind := range []string{"ambiguous", "member-limit", "archived"} {
		b := s.newAccountFocus(origin, true, kind == "archived")
		same := focusMember{"codex", "account", "label", "credential", "hash"}
		b.collect("row", same)
		switch kind {
		case "ambiguous":
			b.collect("other", same)
		case "member-limit":
			for i := 0; i < maxFocusRowMembers; i++ {
				b.collect("row", focusMember{fmt.Sprint(i), "", "", "", ""})
			}
		}
		b.attach(rows)
		if _, err := s.focus.resolve(rows[0].AccountFocusID); !errors.Is(err, ErrAccountFocusUnavailable) {
			t.Fatalf("%s was not refused", kind)
		}
	}
}
