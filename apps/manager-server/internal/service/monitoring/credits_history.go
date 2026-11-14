package monitoring

import (
	"context"
	"encoding/json"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
)

const (
	defaultCreditsHistoryDays      = 7
	maxCreditsHistoryDays          = 14
	defaultCreditsHistoryMaxPoints = 200
	maxCreditsHistoryMaxPoints     = 500
	// 扫描行数硬上限：按时间倒序截断，保留最新数据，防止超大库一次读太多行。
	maxCreditsHistoryRows = 200_000
	dayMS                 = int64(24 * 60 * 60 * 1000)
)

// CreditsHistoryRequest：Days 为回溯上限（默认 7，最大 14），MaxPoints 为每个账号
// 返回点数上限（默认 200，最大 500）；NowMS 仅供测试注入，HTTP 层不暴露。
type CreditsHistoryRequest struct {
	Days      int
	MaxPoints int
	NowMS     int64
}

type CreditsHistoryResponse struct {
	GeneratedAtMS int64                `json:"generated_at_ms"`
	FromMS        int64                `json:"from_ms"`
	ToMS          int64                `json:"to_ms"`
	Truncated     bool                 `json:"truncated"`
	Items         []CreditsHistoryItem `json:"items"`
}

// CreditsHistoryItem 是单个账号的积分余额时间序列。WindowStartMS 为当前长周期
// （周 / 月）主窗口的开始时间，拿不到时为 0，序列退化为 Days 天回溯；
// QuotaResetAtMS 为最新观测里「已用满」主窗口的最晚重置时间，没有用满的主窗口时为 0。
type CreditsHistoryItem struct {
	AccountKey       string                `json:"account_key"`
	AuthFileSnapshot string                `json:"auth_file_snapshot,omitempty"`
	AuthIndex        string                `json:"auth_index,omitempty"`
	AccountSnapshot  string                `json:"account_snapshot,omitempty"`
	SourceHash       string                `json:"source_hash,omitempty"`
	Provider         string                `json:"provider,omitempty"`
	WindowStartMS    int64                 `json:"window_start_ms"`
	QuotaResetAtMS   int64                 `json:"quota_reset_at_ms"`
	Unlimited        bool                  `json:"unlimited"`
	LastSeenMS       int64                 `json:"last_seen_ms"`
	Points           []CreditsBalancePoint `json:"points"`
}

// CreditsBalancePoint：QuotaExhausted 表示该次观测时 primary / secondary 任一主窗口已用满（≥100%）。
type CreditsBalancePoint struct {
	TimestampMS    int64   `json:"timestamp_ms"`
	Balance        float64 `json:"balance"`
	QuotaExhausted bool    `json:"quota_exhausted"`
}

// creditsHeaderMetadata 只声明需要的字段，避免把整份 ResponseHeaderMetadata 反序列化。
type creditsHeaderMetadata struct {
	Quota *struct {
		CreditsBalance    string               `json:"credits_balance"`
		CreditsHasCredits *bool                `json:"credits_has_credits"`
		CreditsUnlimited  *bool                `json:"credits_unlimited"`
		Primary           *creditsHeaderWindow `json:"primary"`
		Secondary         *creditsHeaderWindow `json:"secondary"`
	} `json:"quota"`
}

type creditsHeaderWindow struct {
	UsedPercent   *float64 `json:"used_percent"`
	ResetAtMS     int64    `json:"reset_at_ms"`
	WindowMinutes *float64 `json:"window_minutes"`
}

type creditsObservation struct {
	timestampMS    int64
	id             int64
	balance        float64
	exhausted      bool
	unlimited      bool
	windowStartMS  int64
	quotaResetAtMS int64
}

type creditsAccount struct {
	item         CreditsHistoryItem
	observations []creditsObservation
}

// CreditsHistory 只读返回各账号积分余额时间序列：读 usage_events.response_metadata_json，
// 不写库、不加表。序列以当前长周期主窗口开始时间裁剪（拿不到则回溯 Days 天），
// 按「余额变化 / 用满状态变化」去重，再均匀降采样到 MaxPoints 以内（保留首尾与首个用满点）。
func (s *Service) CreditsHistory(ctx context.Context, req CreditsHistoryRequest) (CreditsHistoryResponse, error) {
	days := req.Days
	if days <= 0 {
		days = defaultCreditsHistoryDays
	}
	if days > maxCreditsHistoryDays {
		days = maxCreditsHistoryDays
	}
	maxPoints := req.MaxPoints
	if maxPoints <= 0 {
		maxPoints = defaultCreditsHistoryMaxPoints
	}
	if maxPoints > maxCreditsHistoryMaxPoints {
		maxPoints = maxCreditsHistoryMaxPoints
	}
	if maxPoints < 3 {
		maxPoints = 3
	}
	nowMS := req.NowMS
	if nowMS <= 0 {
		nowMS = time.Now().UnixMilli()
	}
	fromMS := nowMS - int64(days)*dayMS

	rows, err := s.store.CreditsBalanceRows(ctx, fromMS, nowMS, maxCreditsHistoryRows)
	if err != nil {
		return CreditsHistoryResponse{}, err
	}

	accounts := map[string]*creditsAccount{}
	order := make([]string, 0)
	for _, row := range rows {
		observation, ok := parseCreditsObservation(row)
		if !ok {
			continue
		}
		key := creditsAccountKey(row)
		if key == "" {
			continue
		}
		account, exists := accounts[key]
		if !exists {
			// rows 按时间倒序，首次出现的就是该账号最新一行，身份列取它。
			account = &creditsAccount{item: CreditsHistoryItem{
				AccountKey:       key,
				AuthFileSnapshot: row.AuthFileSnapshot,
				AuthIndex:        row.AuthIndex,
				AccountSnapshot:  row.AccountSnapshot,
				SourceHash:       row.SourceHash,
				Provider:         row.Provider,
			}}
			accounts[key] = account
			order = append(order, key)
		}
		account.observations = append(account.observations, observation)
	}

	items := make([]CreditsHistoryItem, 0, len(order))
	for _, key := range order {
		account := accounts[key]
		observations := account.observations
		// 转为时间正序，便于去重与降采样。
		sort.SliceStable(observations, func(i, j int) bool {
			if observations[i].timestampMS != observations[j].timestampMS {
				return observations[i].timestampMS < observations[j].timestampMS
			}
			return observations[i].id < observations[j].id
		})
		latest := observations[len(observations)-1]
		item := account.item
		item.Unlimited = latest.unlimited
		item.LastSeenMS = latest.timestampMS
		item.QuotaResetAtMS = latest.quotaResetAtMS
		if latest.windowStartMS > fromMS && latest.windowStartMS <= nowMS {
			item.WindowStartMS = latest.windowStartMS
		}
		points := dedupeCreditsObservations(observations, item.WindowStartMS)
		item.Points = downsampleCreditsPoints(points, maxPoints)
		if len(item.Points) == 0 {
			continue
		}
		items = append(items, item)
	}

	return CreditsHistoryResponse{
		GeneratedAtMS: nowMS,
		FromMS:        fromMS,
		ToMS:          nowMS,
		Truncated:     len(rows) >= maxCreditsHistoryRows,
		Items:         items,
	}, nil
}

// creditsAccountKey 与 LatestHeaderSnapshots 的 snapshot_key 规则保持一致，
// 前端据此把序列与请求头快照对到同一账号。
func creditsAccountKey(row store.CreditsBalanceRow) string {
	switch {
	case row.AuthFileSnapshot != "" && row.AuthIndex != "":
		return row.AuthFileSnapshot + "::" + row.AuthIndex
	case row.AuthFileSnapshot != "":
		return "file::" + row.AuthFileSnapshot
	case row.AuthIndex != "":
		return "auth::" + row.AuthIndex
	case row.AccountSnapshot != "":
		return "account::" + strings.ToLower(row.AccountSnapshot)
	case row.SourceHash != "":
		return "source::" + row.SourceHash
	default:
		return ""
	}
}

func parseCreditsObservation(row store.CreditsBalanceRow) (creditsObservation, bool) {
	var metadata creditsHeaderMetadata
	if err := json.Unmarshal([]byte(row.ResponseMetadataJSON), &metadata); err != nil || metadata.Quota == nil {
		return creditsObservation{}, false
	}
	quota := metadata.Quota
	if quota.CreditsHasCredits != nil && !*quota.CreditsHasCredits {
		return creditsObservation{}, false
	}
	balance, err := strconv.ParseFloat(strings.TrimSpace(quota.CreditsBalance), 64)
	if err != nil || math.IsNaN(balance) || math.IsInf(balance, 0) || balance < 0 {
		return creditsObservation{}, false
	}
	observation := creditsObservation{
		timestampMS: row.TimestampMS,
		id:          row.ID,
		balance:     balance,
		unlimited:   quota.CreditsUnlimited != nil && *quota.CreditsUnlimited,
	}
	var longestWindowMinutes float64
	for _, window := range []*creditsHeaderWindow{quota.Primary, quota.Secondary} {
		if window == nil {
			continue
		}
		if window.UsedPercent != nil && *window.UsedPercent >= 100 {
			observation.exhausted = true
			if window.ResetAtMS > observation.quotaResetAtMS {
				observation.quotaResetAtMS = window.ResetAtMS
			}
		}
		// 当前窗口开始时间取时长最长的主窗口（周 / 月）：reset_at − window_minutes。
		if window.WindowMinutes != nil && *window.WindowMinutes > longestWindowMinutes && window.ResetAtMS > 0 {
			longestWindowMinutes = *window.WindowMinutes
			observation.windowStartMS = window.ResetAtMS - int64(longestWindowMinutes*60*1000)
		}
	}
	return observation, true
}

// dedupeCreditsObservations 按「余额变化 / 用满状态变化」去重；最后一个观测始终保留，
// 让前端知道余额在最近一次请求时仍未变化（计算速率时要算上这段平稳期）。
func dedupeCreditsObservations(observations []creditsObservation, windowStartMS int64) []CreditsBalancePoint {
	points := make([]CreditsBalancePoint, 0, len(observations))
	for index, observation := range observations {
		if windowStartMS > 0 && observation.timestampMS < windowStartMS {
			continue
		}
		point := CreditsBalancePoint{
			TimestampMS:    observation.timestampMS,
			Balance:        observation.balance,
			QuotaExhausted: observation.exhausted,
		}
		isLast := index == len(observations)-1
		if len(points) > 0 {
			previous := points[len(points)-1]
			if previous.Balance == point.Balance && previous.QuotaExhausted == point.QuotaExhausted {
				if isLast && previous.TimestampMS != point.TimestampMS {
					points = append(points, point)
				}
				continue
			}
		}
		points = append(points, point)
	}
	return points
}

// downsampleCreditsPoints 均匀抽样到 maxPoints 以内，始终保留首点、尾点与首个用满点。
func downsampleCreditsPoints(points []CreditsBalancePoint, maxPoints int) []CreditsBalancePoint {
	if len(points) <= maxPoints {
		return points
	}
	keep := map[int]struct{}{0: {}, len(points) - 1: {}}
	for index, point := range points {
		if point.QuotaExhausted {
			keep[index] = struct{}{}
			break
		}
	}
	slots := maxPoints - len(keep)
	if slots > 0 {
		step := float64(len(points)-1) / float64(slots+1)
		for slot := 1; slot <= slots; slot++ {
			keep[int(math.Round(step*float64(slot)))] = struct{}{}
		}
	}
	indices := make([]int, 0, len(keep))
	for index := range keep {
		indices = append(indices, index)
	}
	sort.Ints(indices)
	if len(indices) > maxPoints {
		indices = append(indices[:maxPoints-1], indices[len(indices)-1])
	}
	result := make([]CreditsBalancePoint, 0, len(indices))
	for _, index := range indices {
		result = append(result, points[index])
	}
	return result
}
