package usage

import (
	"math"
	"sort"
	"strings"
)

type FastContext struct {
	SchemaVersion              int    `json:"schema_version"`
	ClientServiceTier          string `json:"client_service_tier,omitempty"`
	UpstreamRequestServiceTier string `json:"upstream_request_service_tier"`
	ServerFastEnabled          *bool  `json:"server_fast_enabled,omitempty"`
	TierSource                 string `json:"tier_source"`
	RequestKind                string `json:"request_kind"`
}
type FastImpactOptions struct {
	Mode     string `json:"mode"`
	Metric   string `json:"metric"`
	AnchorMS int64  `json:"anchor_ms,omitempty"`
	WindowMS int64  `json:"window_ms,omitempty"`
}
type FastMetric struct {
	Samples int      `json:"samples"`
	P25     *float64 `json:"p25"`
	P50     *float64 `json:"p50"`
	P75     *float64 `json:"p75"`
}
type FastTier struct {
	Attempts       int            `json:"attempts"`
	Failed         int            `json:"failed"`
	Cancelled      int            `json:"cancelled"`
	Empty          int            `json:"empty"`
	VisibleTPS     FastMetric     `json:"visible_tps"`
	EndToEndTPS    FastMetric     `json:"end_to_end_tps"`
	FirstVisibleMS FastMetric     `json:"first_visible_ms"`
	FirstBodyMS    FastMetric     `json:"first_body_ms"`
	Excluded       map[string]int `json:"excluded"`
	Sources        map[string]int `json:"sources"`
	values         [4][]float64
}
type FastCohort struct {
	Key         string   `json:"key"`
	Effort      string   `json:"effort"`
	InputBucket string   `json:"input_bucket"`
	CacheBucket string   `json:"cache_bucket"`
	Default     FastTier `json:"default"`
	Priority    FastTier `json:"priority"`
	ChangePct   *float64 `json:"change_pct"`
	Status      string   `json:"status"`
}
type FastTransition struct {
	Source       string `json:"source"`
	FromMS       int64  `json:"from_ms"`
	ToMS         int64  `json:"to_ms"`
	BeforeFromMS int64  `json:"before_from_ms"`
	AfterToMS    int64  `json:"after_to_ms"`
	Enabled      bool   `json:"enabled"`
}
type FastObservation struct {
	RequestID    string `json:"request_id"`
	StartedAtMS  int64  `json:"started_at_ms"`
	Tier         string `json:"tier"`
	Failed       bool   `json:"failed"`
	OutputTokens int64  `json:"output_tokens"`
}
type FastModel struct {
	Model                 string               `json:"model"`
	Attempts              int                  `json:"attempts"`
	Tiers                 map[string]*FastTier `json:"tiers"`
	Cohorts               []*FastCohort        `json:"cohorts"`
	SelectedCohort        string               `json:"selected_cohort"`
	ChangePct             *float64             `json:"change_pct"`
	Status                string               `json:"status"`
	Coverage              float64              `json:"coverage"`
	Excluded              map[string]int       `json:"excluded"`
	Transition            *FastTransition      `json:"transition,omitempty"`
	Observations          []FastObservation    `json:"observations"`
	ObservationsTruncated bool                 `json:"observations_truncated"`
}
type FastImpact struct {
	Version          int          `json:"version"`
	MetricDefinition string       `json:"metric_definition"`
	FromMS           int64        `json:"from_ms"`
	ToMS             int64        `json:"to_ms"`
	Mode             string       `json:"mode"`
	Metric           string       `json:"metric"`
	Scanned          int          `json:"scanned"`
	Matched          int          `json:"matched"`
	Complete         bool         `json:"complete"`
	Models           []*FastModel `json:"models"`
}

// 同一聚合函数同时用于数据库查询和脱敏预览，避免前端重写统计口径。
func BuildFastImpact(events []Event, from, to int64, options FastImpactOptions) FastImpact {
	if options.Mode == "" {
		options.Mode = "tier"
	}
	if options.Metric == "" {
		options.Metric = "visible_tps"
	}
	result := FastImpact{Version: 1, MetricDefinition: "visible-v2: (output-reasoning)*1000/(last_visible-first_visible); e2e: output*1000/latency; per-request median; quartiles nearest-rank", FromMS: from, ToMS: to, Mode: options.Mode, Metric: options.Metric, Scanned: len(events), Matched: len(events), Complete: true, Models: []*FastModel{}}
	grouped := map[string][]Event{}
	for _, e := range events {
		model := e.ResolvedModel
		if model == "" {
			model = "unresolved:" + e.Model
		}
		grouped[model] = append(grouped[model], e)
	}
	keys := make([]string, 0, len(grouped))
	for k := range grouped {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, model := range keys {
		rows := grouped[model]
		sort.SliceStable(rows, func(i, j int) bool { return fastStart(rows[i]) < fastStart(rows[j]) })
		m := &FastModel{Model: model, Tiers: map[string]*FastTier{}, Cohorts: []*FastCohort{}, Excluded: map[string]int{}, Observations: []FastObservation{}, Status: "missing_baseline"}
		for _, tier := range []string{"default", "priority", "flex", "unknown"} {
			m.Tiers[tier] = newFastTier()
		}
		if options.Mode == "transition" {
			m.Transition = observedFastTransition(rows, from, to, options)
		}
		cohorts := map[string]*FastCohort{}
		for _, e := range rows {
			m.Attempts++
			if options.Mode == "transition" && (m.Transition == nil || !insideFastTransition(e, m.Transition)) {
				m.Excluded["outside_transition"]++
				continue
			}
			tier, source, kind := fastTier(e)
			if kind == "prewarm" {
				m.Excluded["prewarm"]++
				continue
			}
			m.Tiers[tier].add(e, source)
			m.Observations = append(m.Observations, FastObservation{RequestID: e.RequestID, StartedAtMS: fastStart(e), Tier: tier, Failed: e.Failed, OutputTokens: e.OutputTokens})
			if tier != "default" && tier != "priority" {
				m.Excluded[tier+"_tier"]++
				continue
			}
			effort, input, cache := fastCohortKey(e)
			key := effort + "|" + input + "|" + cache
			c := cohorts[key]
			if c == nil {
				c = &FastCohort{Key: key, Effort: effort, InputBucket: input, CacheBucket: cache, Default: *newFastTier(), Priority: *newFastTier()}
				cohorts[key] = c
			}
			if tier == "default" {
				c.Default.add(e, source)
			} else {
				c.Priority.add(e, source)
			}
		}
		for _, t := range m.Tiers {
			t.finish()
		}
		for _, c := range cohorts {
			c.Default.finish()
			c.Priority.finish()
			c.Status, c.ChangePct = fastComparison(c, options.Metric)
			m.Cohorts = append(m.Cohorts, c)
		}
		sort.Slice(m.Cohorts, func(i, j int) bool { return m.Cohorts[i].Key < m.Cohorts[j].Key })
		best := 0
		for _, c := range m.Cohorts {
			a, b := fastSelected(c.Default, options.Metric), fastSelected(c.Priority, options.Metric)
			n := min(a.Samples, b.Samples)
			if n > best {
				best = n
				m.SelectedCohort = c.Key
				m.Status = c.Status
				m.ChangePct = c.ChangePct
				m.Coverage = float64(c.Default.Attempts+c.Priority.Attempts) / float64(max(1, m.Attempts))
			}
		}
		if best == 0 {
			a, b := m.Tiers["default"], m.Tiers["priority"]
			if a.Attempts > 0 && b.Attempts > 0 {
				m.Status = "load_mismatch"
				if fastSelected(*a, options.Metric).Samples == 0 || fastSelected(*b, options.Metric).Samples == 0 {
					m.Status = "missing_timing"
				}
			}
			if a.Attempts+b.Attempts == 0 && m.Tiers["unknown"].Attempts > 0 {
				m.Status = "upgrade_required"
			}
			if options.Mode == "transition" && m.Transition == nil {
				m.Status = "no_transition"
			}
		}
		if len(m.Observations) > 40 {
			m.Observations = m.Observations[len(m.Observations)-40:]
			m.ObservationsTruncated = true
		}
		result.Models = append(result.Models, m)
	}
	return result
}
func newFastTier() *FastTier { return &FastTier{Excluded: map[string]int{}, Sources: map[string]int{}} }
func fastStart(e Event) int64 {
	if e.Telemetry != nil && e.Telemetry.StartedAtMS > 0 {
		return e.Telemetry.StartedAtMS
	}
	return e.TimestampMS
}
func fastTier(e Event) (string, string, string) {
	if e.Telemetry == nil || e.Telemetry.FastContext == nil || e.Telemetry.FastContext.SchemaVersion != 1 {
		return "unknown", "unknown", "serving"
	}
	f := e.Telemetry.FastContext
	tier := f.UpstreamRequestServiceTier
	if tier == "auto" {
		tier = "default"
	}
	if tier != "default" && tier != "priority" && tier != "flex" {
		tier = "unknown"
	}
	return tier, f.TierSource, f.RequestKind
}
func fastCohortKey(e Event) (string, string, string) {
	effort := strings.TrimSpace(e.ReasoningEffort)
	if effort == "" {
		effort = "unknown"
	}
	input := "<32k"
	switch {
	case e.InputTokens >= 256000:
		input = ">=256k"
	case e.InputTokens >= 128000:
		input = "128-256k"
	case e.InputTokens >= 32000:
		input = "32-128k"
	}
	cache := "unknown"
	if e.InputTokens > 0 {
		ratio := float64(max(e.CachedTokens, e.CacheReadTokens)) / float64(e.InputTokens)
		switch {
		case ratio > 1 || ratio < 0:
		case ratio >= .9:
			cache = ">=90%"
		case ratio >= .5:
			cache = "50-90%"
		default:
			cache = "<50%"
		}
	}
	return effort, input, cache
}
func (t *FastTier) add(e Event, source string) {
	t.Attempts++
	t.Sources[source]++
	telemetry := e.Telemetry
	if e.Failed {
		t.Failed++
		t.Excluded["failed"]++
		if telemetry != nil && telemetry.FailureKind == "cancelled" {
			t.Cancelled++
		}
		return
	}
	if e.OutputTokens <= 0 {
		t.Empty++
		t.Excluded["empty_output"]++
		return
	}
	if telemetry != nil && telemetry.StreamCompleted != nil && !*telemetry.StreamCompleted {
		t.Excluded["incomplete"]++
		return
	}
	if e.LatencyMS != nil && *e.LatencyMS > 0 {
		t.values[1] = append(t.values[1], float64(e.OutputTokens)*1000/float64(*e.LatencyMS))
	}
	if telemetry != nil && telemetry.FirstBodyMS != nil {
		t.values[3] = append(t.values[3], float64(*telemetry.FirstBodyMS))
	} else if e.TTFTMS != nil {
		t.values[3] = append(t.values[3], float64(*e.TTFTMS))
	}
	if telemetry == nil || telemetry.Version < 2 || !telemetry.VisibleContentObserved || telemetry.StreamCompleted == nil || !*telemetry.StreamCompleted {
		t.Excluded["missing_timing"]++
		return
	}
	if telemetry.FirstVisibleContentMS != nil {
		t.values[2] = append(t.values[2], float64(*telemetry.FirstVisibleContentMS))
	}
	if !telemetry.OutputReasoningSubset || e.ReasoningTokens < 0 || e.ReasoningTokens > e.OutputTokens {
		t.Excluded["unknown_token_split"]++
		return
	}
	if e.OutputTokens-e.ReasoningTokens < 128 {
		t.Excluded["short_output"]++
		return
	}
	if telemetry.VisibleContentEvents == nil || *telemetry.VisibleContentEvents < 2 || telemetry.FirstVisibleContentMS == nil || telemetry.LastVisibleContentMS == nil || *telemetry.LastVisibleContentMS <= *telemetry.FirstVisibleContentMS || (e.LatencyMS != nil && *telemetry.LastVisibleContentMS > *e.LatencyMS) {
		t.Excluded["missing_span"]++
		return
	}
	t.values[0] = append(t.values[0], float64(e.OutputTokens-e.ReasoningTokens)*1000/float64(*telemetry.LastVisibleContentMS-*telemetry.FirstVisibleContentMS))
}
func (t *FastTier) finish() {
	t.VisibleTPS = fastMetric(t.values[0])
	t.EndToEndTPS = fastMetric(t.values[1])
	t.FirstVisibleMS = fastMetric(t.values[2])
	t.FirstBodyMS = fastMetric(t.values[3])
}
func fastMetric(values []float64) FastMetric {
	n := len(values)
	m := FastMetric{Samples: n}
	if n == 0 {
		return m
	}
	sort.Float64s(values)
	median := values[n/2]
	if n%2 == 0 {
		median = (values[n/2-1] + median) / 2
	}
	p25 := values[max(0, int(math.Ceil(float64(n)*.25))-1)]
	p75 := values[max(0, int(math.Ceil(float64(n)*.75))-1)]
	m.P50 = &median
	m.P25 = &p25
	m.P75 = &p75
	return m
}
func fastSelected(t FastTier, metric string) FastMetric {
	if metric == "end_to_end_tps" {
		return t.EndToEndTPS
	}
	return t.VisibleTPS
}
func fastComparison(c *FastCohort, metric string) (string, *float64) {
	a, b := fastSelected(c.Default, metric), fastSelected(c.Priority, metric)
	n := min(a.Samples, b.Samples)
	if n == 0 {
		return "missing_baseline", nil
	}
	if n < 5 {
		return "insufficient_samples", nil
	}
	if c.Effort == "unknown" || c.CacheBucket == "unknown" {
		return "low_comparability", nil
	}
	if a.P50 == nil || b.P50 == nil || *a.P50 <= 0 {
		return "missing_baseline", nil
	}
	v := (*b.P50 / *a.P50 - 1) * 100
	if n < 20 {
		return "preliminary", &v
	}
	return "observed", &v
}

func observedFastTransition(rows []Event, from, to int64, o FastImpactOptions) *FastTransition {
	type snapshot struct {
		at      int64
		enabled bool
	}
	var snapshots []snapshot
	for _, e := range rows {
		if e.Telemetry != nil && e.Telemetry.FastContext != nil && e.Telemetry.FastContext.RequestKind == "serving" && e.Telemetry.FastContext.ServerFastEnabled != nil {
			snapshots = append(snapshots, snapshot{fastStart(e), *e.Telemetry.FastContext.ServerFastEnabled})
		}
	}
	selected := -1
	for i := 1; i < len(snapshots); i++ {
		if snapshots[i].enabled != snapshots[i-1].enabled && (o.AnchorMS <= 0 || snapshots[i].at <= o.AnchorMS) {
			selected = i
		}
	}
	if selected < 0 {
		return nil
	}
	i := selected
	a, b := snapshots[i-1].at, snapshots[i].at
	if b <= a {
		return nil
	}
	left, right := from, to
	for j := i - 1; j > 0; j-- {
		if snapshots[j].enabled != snapshots[j-1].enabled {
			left = max(left, snapshots[j].at)
			break
		}
	}
	for j := i + 1; j < len(snapshots); j++ {
		if snapshots[j].enabled != snapshots[j-1].enabled {
			right = min(right, snapshots[j-1].at)
			break
		}
	}
	window := o.WindowMS
	if window <= 0 {
		window = 30 * 60 * 1000
	}
	window = min(window, 30*60*1000, a-left, right-b)
	if window <= 0 {
		return nil
	}
	return &FastTransition{Source: "observed", FromMS: a, ToMS: b, BeforeFromMS: a - window, AfterToMS: b + window, Enabled: snapshots[i].enabled}
}
func insideFastTransition(e Event, t *FastTransition) bool {
	start := fastStart(e)
	end := start
	if e.LatencyMS != nil {
		end += *e.LatencyMS
	}
	if e.Telemetry != nil && e.Telemetry.EndedAtMS > 0 {
		end = e.Telemetry.EndedAtMS
	}
	return (start >= t.BeforeFromMS && start < t.FromMS && end <= t.FromMS) || (start >= t.ToMS && start < t.AfterToMS && end <= t.AfterToMS)
}
