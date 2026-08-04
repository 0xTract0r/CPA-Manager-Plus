import { useTranslation } from 'react-i18next';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/Table';
import { Button } from '@/components/ui/Button';
import { AsyncPanel } from '@/components/ui/AsyncPanel';
import { IconInfo } from '@/components/ui/icons';
import { formatUsd } from '@/utils/usage';
import { useFarmUsage } from '../hooks/useFarmUsage';
import styles from './FarmUsagePanel.module.scss';

function formatTokenTotal(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return value.toLocaleString();
}

// formatUsd 固定两位小数，费用极小（< $0.01）时会被四舍五入抹成 "$0.00"，
// 掩盖"真实非零"的用量；这里对小额费用改用更高精度展示，大额沿用既有格式。
function formatCostUsd(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  if (value === 0) return formatUsd(0);
  if (Math.abs(value) < 0.01) {
    const trimmed = value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
    return `$${trimmed}`;
  }
  return formatUsd(value);
}

/**
 * Token 用量明细（每账号/容器）：消费 GET /api/farm/usage（编排器聚合 CPA
 * GET /v0/management/usage?include_details=true 的 details[]，只保留农场
 * 绑定账号）。note 固定携带口径说明（自 CPA 上次重启起、内存态、不持久），
 * 原样展示在表格上方，不另造措辞。
 */
export function FarmUsagePanel() {
  const { t } = useTranslation();
  const { items, note, loading, error, reload } = useFarmUsage();

  return (
    <div className={styles.panel} data-testid="farm-usage-panel">
      <div className={styles.header}>
        <div className={styles.title}>{t('farm.usage.detailTitle')}</div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => reload()}
          data-testid="farm-usage-refresh"
        >
          {t('common.refresh')}
        </Button>
      </div>
      {/* 用量口径正名（Q2）：/api/farm/usage 透传的是 CPA 账号级累计计数
          （note 固定说明"自上次 CPA 重启起、内存态"），既包含账号入农场前的
          真实历史 serving，也不等同于农场探针保活心跳次数——两者是完全独立的
          口径。原样展示 note（design.md 决策13）之外，额外加一条正名说明，
          避免运营者把这里的数字读成"绑定容器后新增的调用量"。 */}
      <div className={styles.attributionNotice} data-testid="farm-usage-attribution-notice">
        <div className={styles.attributionNoticeHeader}>
          <IconInfo size={14} />
          <span>{t('farm.usage.attributionTitle')}</span>
        </div>
        <p className={styles.attributionNoticeBody}>{t('farm.usage.attributionBody')}</p>
      </div>

      {note ? (
        <p className={styles.note} data-testid="farm-usage-note">
          {t('farm.usage.sinceNote', { defaultValue: note })}
        </p>
      ) : null}

      <AsyncPanel
        loading={loading}
        error={error}
        isEmpty={items.length === 0}
        loadingLabel={t('common.loading')}
        loadingTestId="farm-usage-loading"
        errorTestId="farm-usage-error"
        empty={{ title: t('farm.usage.empty'), testId: 'farm-usage-empty' }}
      >
        <Table data-testid="farm-usage-table">
          <TableHeader>
            <TableRow>
              <TableHead>{t('farm.accounts.column_name')}</TableHead>
              <TableHead>{t('farm.bind_modal.env_label')}</TableHead>
              <TableHead>{t('farm.containers.column_device')}</TableHead>
              <TableHead alignRight>{t('farm.usage.columnInput')}</TableHead>
              <TableHead alignRight>{t('farm.usage.columnOutput')}</TableHead>
              <TableHead alignRight>{t('farm.usage.columnCacheRead')}</TableHead>
              <TableHead alignRight>{t('farm.usage.columnReasoning')}</TableHead>
              <TableHead alignRight>{t('farm.usage.columnTokens')}</TableHead>
              <TableHead alignRight>{t('farm.usage.columnBillable')}</TableHead>
              <TableHead alignRight>{t('farm.usage.columnCost')}</TableHead>
              <TableHead alignRight title={t('farm.usage.columnRequestsHint')}>
                {t('farm.usage.columnRequests')}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <TableRow
                key={`${item.container_id}-${item.account_id}-${item.env}-${item.auth_index}`}
                data-testid={`farm-usage-row-${item.container_id}-${item.account_id}`}
              >
                <TableCell data-label={t('farm.accounts.column_name')}>
                  <div className={styles.accountCell}>
                    <span>{item.account_id}</span>
                    {item.account_email ? (
                      <span className={styles.accountEmail}>{item.account_email}</span>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell data-label={t('farm.bind_modal.env_label')}>
                  <span className={styles.chip}>
                    {t(`farm.env.${item.env}`, { defaultValue: item.env })}
                  </span>
                </TableCell>
                <TableCell data-label={t('farm.containers.column_device')}>
                  <span className={styles.mono}>{item.container_id}</span>
                </TableCell>
                <TableCell alignRight data-label={t('farm.usage.columnInput')}>
                  <span className={styles.mono}>{formatTokenTotal(item.tokens.input)}</span>
                </TableCell>
                <TableCell alignRight data-label={t('farm.usage.columnOutput')}>
                  <span className={styles.mono}>{formatTokenTotal(item.tokens.output)}</span>
                </TableCell>
                <TableCell alignRight data-label={t('farm.usage.columnCacheRead')}>
                  <span className={styles.mono}>{formatTokenTotal(item.tokens.cache_read)}</span>
                </TableCell>
                <TableCell alignRight data-label={t('farm.usage.columnReasoning')}>
                  <span className={styles.mono}>{formatTokenTotal(item.tokens.reasoning)}</span>
                </TableCell>
                <TableCell alignRight data-label={t('farm.usage.columnTokens')}>
                  <span className={styles.mono}>{formatTokenTotal(item.tokens.total)}</span>
                </TableCell>
                <TableCell alignRight data-label={t('farm.usage.columnBillable')}>
                  <span className={styles.mono}>{formatTokenTotal(item.tokens.billable)}</span>
                </TableCell>
                <TableCell alignRight data-label={t('farm.usage.columnCost')}>
                  <span className={styles.mono}>{formatCostUsd(item.cost_usd)}</span>
                </TableCell>
                <TableCell alignRight data-label={t('farm.usage.columnRequests')}>
                  <span className={styles.mono}>{formatTokenTotal(item.requests)}</span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </AsyncPanel>
    </div>
  );
}
