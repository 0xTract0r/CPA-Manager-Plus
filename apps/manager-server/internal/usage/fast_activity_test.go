package usage

import "testing"

func TestFastActivityPreservesFullCountsAndEmptyBuckets(t *testing.T) {
	var rows []Event
	for i := 0; i < 240; i++ {
		e := fastTestEvent(i, "A", "priority", 40)
		e.TimestampMS = int64(i%2)*60000 + 1
		if i%2 == 0 {
			e.Telemetry.FastContext.UpstreamRequestServiceTier = "default"
		}
		rows = append(rows, e)
	}
	unknown := fastTestEvent(1000, "A", "default", 20)
	unknown.TimestampMS = 70000
	unknown.Telemetry = nil
	rows = append(rows, unknown)
	flex := fastTestEvent(1001, "A", "flex", 20)
	flex.TimestampMS = 71000
	rows = append(rows, flex)
	prewarm := fastTestEvent(1002, "A", "priority", 20)
	prewarm.TimestampMS = 72000
	prewarm.Telemetry.FastContext.RequestKind = "prewarm"
	rows = append(rows, prewarm)
	r := BuildFastImpact(rows, 0, 120000, FastImpactOptions{})
	if len(r.Activity) != 120 {
		t.Fatalf("bucket count=%d", len(r.Activity))
	}
	var defaults, priorities, unknowns, flexes, empty int
	for _, b := range r.Activity {
		defaults += b.DefaultAttempts
		priorities += b.PriorityAttempts
		unknowns += b.UnknownAttempts
		flexes += b.FlexAttempts
		if b.DefaultAttempts+b.PriorityAttempts+b.UnknownAttempts+b.FlexAttempts == 0 {
			empty++
		}
	}
	if defaults != 120 || priorities != 120 || unknowns != 1 || flexes != 1 || empty == 0 {
		t.Fatalf("counts %d/%d/%d/%d empty=%d", defaults, priorities, unknowns, flexes, empty)
	}
	if len(r.Models[0].Observations) != 40 || !r.Models[0].ObservationsTruncated {
		t.Fatal("expected truncated detail independent of full activity")
	}
}

func TestFastActivityHalfOpenRangeAndSmallWindow(t *testing.T) {
	rows := []Event{}
	for _, ms := range []int64{9, 10, 11, 12, 13} {
		e := fastTestEvent(int(ms), "A", "default", 20)
		e.TimestampMS = ms
		rows = append(rows, e)
	}
	b := buildFastActivity(rows, 10, 13)
	if len(b) > 3 || b[0].FromMS != 10 || b[len(b)-1].ToMS != 13 {
		t.Fatalf("buckets=%+v", b)
	}
	n := 0
	for _, v := range b {
		n += v.DefaultAttempts
	}
	if n != 3 {
		t.Fatalf("half open count %d", n)
	}
	if buildFastActivity(rows, 10, 10) != nil {
		t.Fatal("invalid range")
	}
}
