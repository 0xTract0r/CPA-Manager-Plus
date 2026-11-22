package monitoring

import (
	"context"
	"slices"
	"testing"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/usage"
)

func TestAnalyticsAttributionScopesKeepSummaryAndCursorAligned(t *testing.T) {
	db := newMonitoringTestStore(t)
	ctx := context.Background()
	const from int64 = 1778600000000
	const retired = "retired-fixture"
	const other = "other-provider"
	const configured = "member"
	const alias = "legacy-member"
	const live = "live-other"
	makeEvent := func(id, index, provider, snapshot string, timestamp int64) usage.Event {
		event := monitoringEvent(id, timestamp, id, index, "synthetic", false, 6, 8, 0, 0, 14, nil)
		event.Provider = provider
		event.AuthProviderSnapshot = snapshot
		return event
	}
	events := []usage.Event{
		makeEvent("historical-empty-index", "", retired, "", from+10),
		makeEvent("historical-snapshot", "old", other, retired, from+10),
		makeEvent("historical-provider", "old", retired, "", from+10),
		makeEvent("belongs-to-configured-channel", configured, retired, "", from+10),
		makeEvent("known-alias-missing-snapshot", alias, "", "", from+20),
		makeEvent("known-live-provider-override", live, retired, retired, from+20),
		makeEvent("historical-snapshot-overrides-raw", "another-old", retired, other, from+20),
		makeEvent("configured-channel-other-provider", "other-member", other, "", from+20),
	}
	if _, err := db.InsertEvents(ctx, events); err != nil {
		t.Fatal(err)
	}
	historicalChannel := &store.AnalyticsChannelScope{
		AssignedAuthIndices: []string{configured, alias, live, "other-member"}, RecordedProvider: retired,
	}
	configuredIndices := []string{configured, alias, "other-member"}

	for _, tc := range []struct {
		name   string
		to     int64
		filter Filters
		want   []string
	}{
		{"legacy-provider-four", from + 15, Filters{Providers: []string{retired}},
			[]string{"belongs-to-configured-channel", "historical-empty-index", "historical-provider", "historical-snapshot"}},
		{"historical-channel-three", from + 15, Filters{Providers: []string{retired}, ChannelScope: historicalChannel},
			[]string{"historical-empty-index", "historical-provider", "historical-snapshot"}},
		{"historical-channel-without-provider", from + 30, Filters{ChannelScope: historicalChannel},
			[]string{"historical-empty-index", "historical-provider", "historical-snapshot"}},
		{"assigned-match-without-snapshot", from + 30, Filters{ChannelScope: &store.AnalyticsChannelScope{
			AuthIndices: []string{alias}, AssignedAuthIndices: []string{configured, alias, live, "other-member"}, RecordedProvider: retired,
		}}, []string{"historical-empty-index", "historical-provider", "historical-snapshot", "known-alias-missing-snapshot"}},
		{"historical-channel-precedence", from + 30, Filters{Providers: []string{retired}, ChannelScope: historicalChannel},
			[]string{"historical-empty-index", "historical-provider", "historical-snapshot"}},
		{"configured-and-recorded-provider", from + 30, Filters{Providers: []string{retired}, AuthIndices: configuredIndices},
			[]string{"belongs-to-configured-channel"}},
		{"configured-without-provider", from + 30, Filters{AuthIndices: configuredIndices},
			[]string{"belongs-to-configured-channel", "configured-channel-other-provider", "known-alias-missing-snapshot"}},
		{"account-intersection", from + 30, Filters{AuthIndices: []string{alias}},
			[]string{"known-alias-missing-snapshot"}},
		{"empty-configured-channel", from + 30, Filters{AuthIndices: []string{"__no_matching_auth_index__"}}, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			service := New(db)
			req := Request{FromMS: from, ToMS: tc.to, Filters: tc.filter, Include: Include{
				Summary: true, EventsPage: &EventsPage{Limit: 2},
			}}
			raw, err := db.AggregateWithFilter(ctx, buildFilter(req))
			if err != nil || raw.TotalCalls != int64(len(tc.want)) {
				t.Fatalf("raw aggregate = %+v, %v, want %d calls", raw, err, len(tc.want))
			}
			var got []string
			for page := range 5 {
				resp, err := service.Analytics(ctx, req)
				if err != nil {
					t.Fatal(err)
				}
				want := int64(len(tc.want))
				if page == 0 && (resp.Summary == nil || resp.Summary.TotalCalls != want) {
					t.Fatalf("summary = %+v, want %d calls", resp.Summary, want)
				}
				if resp.Events == nil || resp.Events.TotalCount != want {
					t.Fatalf("page %d count = %+v, want %d calls", page, resp.Events, want)
				}
				for _, event := range resp.Events.Items {
					got = append(got, event.Model)
				}
				if !resp.Events.HasMore {
					slices.Sort(got)
					if !slices.Equal(got, tc.want) {
						t.Fatalf("pages = %q, want %q", got, tc.want)
					}
					return
				}
				req.Include.Summary = false // Exercise the independent COUNT path on subsequent pages.
				req.Include.EventsPage.BeforeMS = &resp.Events.NextBeforeMS
				req.Include.EventsPage.BeforeID = &resp.Events.NextBeforeID
			}
			t.Fatal("pagination did not terminate")
		})
	}
}
