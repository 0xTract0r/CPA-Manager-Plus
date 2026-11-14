package usageevent

import (
	"context"
)

// CreditsBalanceRow 是积分余额时间序列的原始行：只取账号身份列与
// response_metadata_json，由 service 层做最小化 JSON 解析与去重降采样。
type CreditsBalanceRow struct {
	ID                   int64
	TimestampMS          int64
	AuthFileSnapshot     string
	AuthIndex            string
	AccountSnapshot      string
	SourceHash           string
	Provider             string
	ResponseMetadataJSON string
}

// CreditsBalanceRows 只读扫描 [sinceMS, untilMS] 内带积分余额的请求头元数据。
// 先用 timestamp 索引限定时间范围，再用 like '%credits_balance%' 预过滤，避免对
// 每一行都做 JSON 解析；按时间倒序取最多 limit 行，保证截断时保留的是最新数据。
func (r *repository) CreditsBalanceRows(ctx context.Context, sinceMS int64, untilMS int64, limit int) ([]CreditsBalanceRow, error) {
	if limit <= 0 || untilMS < sinceMS {
		return nil, nil
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
		return nil, err
	}
	defer rows.Close()

	items := make([]CreditsBalanceRow, 0, 256)
	for rows.Next() {
		var item CreditsBalanceRow
		if err := rows.Scan(
			&item.ID,
			&item.TimestampMS,
			&item.AuthFileSnapshot,
			&item.AuthIndex,
			&item.AccountSnapshot,
			&item.SourceHash,
			&item.Provider,
			&item.ResponseMetadataJSON,
		); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}
