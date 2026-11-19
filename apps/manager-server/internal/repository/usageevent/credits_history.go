package usageevent

import (
	"context"
	"database/sql"
	"encoding/json"
	"math"
	"strconv"
	"strings"
)

// CreditsBalanceRow 是积分余额时间序列的一行：扫描时就从 response_metadata_json 解析出
// 需要的小字段，原始 JSON 不保留，避免整批大字符串常驻内存。
type CreditsBalanceRow struct {
	ID               int64
	TimestampMS      int64
	AuthFileSnapshot string
	AuthIndex        string
	AccountSnapshot  string
	SourceHash       string
	Provider         string
	Balance          float64
	Unlimited        bool
	Primary          *CreditsQuotaWindow
	Secondary        *CreditsQuotaWindow
}

// CreditsQuotaWindow 只保留主窗口的用量、重置时间与时长。
type CreditsQuotaWindow struct {
	UsedPercent   *float64 `json:"used_percent"`
	ResetAtMS     int64    `json:"reset_at_ms"`
	WindowMinutes *float64 `json:"window_minutes"`
}

type creditsMetadataJSON struct {
	Quota *struct {
		CreditsBalance    string              `json:"credits_balance"`
		CreditsHasCredits *bool               `json:"credits_has_credits"`
		CreditsUnlimited  *bool               `json:"credits_unlimited"`
		Primary           *CreditsQuotaWindow `json:"primary"`
		Secondary         *CreditsQuotaWindow `json:"secondary"`
	} `json:"quota"`
}

// CreditsBalanceRows 只读扫描 [sinceMS, untilMS] 内带积分余额的请求头元数据。
// 先用 timestamp 索引限定时间范围，再用 like '%credits_balance%' 预过滤；按时间倒序最多扫
// limit 行（截断时保留最新数据），在 rows.Next 里逐行解析成小结构体。
// 第二个返回值表示是否触达扫描上限。
func (r *repository) CreditsBalanceRows(ctx context.Context, sinceMS int64, untilMS int64, limit int) ([]CreditsBalanceRow, bool, error) {
	if limit <= 0 || untilMS < sinceMS {
		return nil, false, nil
	}
	rows, err := r.db.QueryContext(ctx, `select
	id,
	timestamp_ms,
	coalesce(auth_file_snapshot, ''),
	coalesce(auth_index, ''),
	coalesce(account_snapshot, ''),
	coalesce(source_hash, ''),
	coalesce(nullif(auth_provider_snapshot, ''), provider, ''),
	response_metadata_json
from usage_events
where timestamp_ms >= ?
	and timestamp_ms <= ?
	and response_metadata_json like '%credits_balance%'
order by timestamp_ms desc, id desc
limit ?`, sinceMS, untilMS, limit)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()

	items := make([]CreditsBalanceRow, 0, 256)
	scanned := 0
	for rows.Next() {
		scanned++
		var item CreditsBalanceRow
		var raw sql.RawBytes
		if err := rows.Scan(
			&item.ID,
			&item.TimestampMS,
			&item.AuthFileSnapshot,
			&item.AuthIndex,
			&item.AccountSnapshot,
			&item.SourceHash,
			&item.Provider,
			&raw,
		); err != nil {
			return nil, false, err
		}
		if !parseCreditsMetadata(raw, &item) {
			continue
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	return items, scanned >= limit, nil
}

// parseCreditsMetadata 解析积分余额与主窗口；has_credits=false、余额非法时丢弃该行。
func parseCreditsMetadata(raw []byte, item *CreditsBalanceRow) bool {
	if len(raw) == 0 {
		return false
	}
	var metadata creditsMetadataJSON
	if err := json.Unmarshal(raw, &metadata); err != nil || metadata.Quota == nil {
		return false
	}
	quota := metadata.Quota
	if quota.CreditsHasCredits != nil && !*quota.CreditsHasCredits {
		return false
	}
	balance, err := strconv.ParseFloat(strings.TrimSpace(quota.CreditsBalance), 64)
	if err != nil || math.IsNaN(balance) || math.IsInf(balance, 0) || balance < 0 {
		return false
	}
	item.Balance = balance
	item.Unlimited = quota.CreditsUnlimited != nil && *quota.CreditsUnlimited
	item.Primary = quota.Primary
	item.Secondary = quota.Secondary
	return true
}
