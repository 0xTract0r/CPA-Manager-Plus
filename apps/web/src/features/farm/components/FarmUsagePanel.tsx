import { useMemo } from 'react';
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
import {
  FARM_PROBE_CADENCE_SCOPE,
  FARM_USAGE_SCOPE,
  deriveUsageAccountIdentity,
  summarizeFarmUsage,
} from '../utils/usagePanel';
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
export function FarmUsagePanel({ hideHeading = false }: { hideHeading?: boolean } = {}) {
  const { t } = useTranslation();
  const { items, note, loading, error, reload } = useFarmUsage();

  // 账号 API 累计用量「时钟」读数（C6 右钟）：对 items 真实求和 + 去重，
  // 供双时钟卡展示聚合读数与 C7 ① 结构性缺席空态判定。
  const summary = useMemo(() => summarizeFarmUsage(items), [items]);

  return (
    <div className={styles.panel} data-testid="farm-usage-panel">
      {/* hideHeading：作为独立整页（FarmUsagePage）承载时，标题由页头 h1 提供，
          这里隐藏面板内重复标题，仅保留刷新动作。 */}
      <div className={styles.header}>
        {hideHeading ? <span /> : <div className={styles.title}>{t('farm.usage.detailTitle')}</div>}
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

      {/* C6 双时钟卡：探针保活节奏（机器·抖动·到达间隔）vs 账号 API 累计用量
          （业务·自 CPA 重启累计·含探针外真实流量）两钟并列，各带 scope 徽标，
          横幅明说两者口径独立、不可相加/替代（sorrygml40「一绑定就163次」把账号
          累计请求数误当探针触发次数的正名）。左钟在本面板层无逐容器读数，用中性
          chip 指向容器详情（不裸横杠假装有值）；右钟展示对 items 的真实聚合。 */}
      <div className={styles.clockCard} data-testid="farm-usage-dual-clock">
        <div className={styles.clockCardHeader}>
          <IconInfo size={14} />
          <span>{t('farm.usage.clockCardTitle', { defaultValue: '两个时钟：口径独立，不可相加 / 替代' })}</span>
        </div>
        <p className={styles.clockBanner} data-testid="farm-usage-clock-banner">
          {t('farm.usage.clockBanner', {
            defaultValue:
              '探针保活节奏与账号 API 累计用量是两个完全独立的口径：一个数「机器保活探针多久到达一次」，一个数「账号在 CPA 侧累计消费了多少」。两者不能相加，也不能互相替代。',
          })}
        </p>
        <div className={styles.clockGrid}>
          {/* 左钟：探针保活节奏 */}
          <div className={styles.clock} data-testid="farm-usage-probe-clock">
            <div className={styles.clockTitle}>
              {t('farm.usage.probeClockTitle', { defaultValue: '探针保活节奏' })}
            </div>
            <span
              className={styles.scopeBadge}
              data-scope={FARM_PROBE_CADENCE_SCOPE}
              data-testid="farm-usage-probe-clock-scope"
            >
              {t('farm.usage.probeClockScopeBadge', {
                defaultValue: '口径：探针到达间隔（farm_probe_cadence）',
              })}
            </span>
            <p className={styles.clockDesc}>
              {t('farm.usage.probeClockDesc', {
                defaultValue:
                  '机器节奏：保活探针相邻两次到达的间隔（inter-arrival），带随机抖动，衡量「多久心跳一次」，不是业务调用量。',
              })}
            </p>
            <div className={styles.clockChips}>
              {/* C7 ② 机制性不存在：唤醒时刻随机抖动，本就不存在「精确的下次时刻」，
                  保留抖动徽标语义。 */}
              <span className={styles.jitterChip} data-testid="farm-usage-probe-clock-jitter">
                {t('farm.usage.probeClockJitterChip', { defaultValue: '随机抖动 · 无精确下次时刻' })}
              </span>
              {/* C7 ③ 待实现/非本层占位：本面板不逐容器拉探针间隔，用中性 chip 指路，
                  不用裸横杠假装此处有读数。 */}
              <span className={styles.neutralChip} data-testid="farm-usage-probe-clock-reading">
                {t('farm.usage.probeClockReadingChip', { defaultValue: '逐容器到达间隔见「容器详情」' })}
              </span>
            </div>
          </div>

          {/* 右钟：账号 API 累计用量 */}
          <div className={styles.clock} data-testid="farm-usage-account-clock">
            <div className={styles.clockTitle}>
              {t('farm.usage.accountClockTitle', { defaultValue: '账号 API 累计用量' })}
            </div>
            <span
              className={styles.scopeBadge}
              data-scope={FARM_USAGE_SCOPE}
              data-testid="farm-usage-account-clock-scope"
            >
              {t('farm.usage.accountClockScopeBadge', {
                defaultValue: '口径：账号 CPA 累计（cpa_account_cumulative）',
              })}
            </span>
            <p className={styles.clockDesc}>
              {t('farm.usage.accountClockDesc', {
                defaultValue:
                  '业务轴：账号在 CPA 侧的累计用量，自 CPA 上次重启起累计，含探针之外的真实业务流量。',
              })}
            </p>
            {summary.isEmpty ? (
              // C7 ① 结构性缺席：暂无任何账号累计读数 → 中性 chip 指向下方空态卡的
              // 解锁条件，不裸横杠。
              <span className={styles.neutralChip} data-testid="farm-usage-account-clock-empty">
                {t('farm.usage.accountClockEmpty', {
                  defaultValue: '暂无账号累计用量（解锁条件见下方空态说明）',
                })}
              </span>
            ) : (
              <dl className={styles.clockReadings} data-testid="farm-usage-account-clock-readings">
                <div className={styles.clockReadingRow}>
                  <dt>{t('farm.usage.accountClockRequests', { defaultValue: '累计请求' })}</dt>
                  <dd className={styles.mono}>{summary.totalRequests.toLocaleString()}</dd>
                </div>
                <div className={styles.clockReadingRow}>
                  <dt>{t('farm.usage.accountClockTokens', { defaultValue: '累计 Token' })}</dt>
                  <dd className={styles.mono}>{summary.totalTokens.toLocaleString()}</dd>
                </div>
                <div className={styles.clockReadingRow}>
                  <dt>{t('farm.usage.accountClockCost', { defaultValue: '累计费用（USD）' })}</dt>
                  <dd className={styles.mono}>{formatCostUsd(summary.totalCostUsd)}</dd>
                </div>
                <div className={styles.clockReadingRow}>
                  <dt>{t('farm.usage.accountClockCoverage', { defaultValue: '覆盖范围' })}</dt>
                  <dd className={styles.mono}>
                    {t('farm.usage.accountClockCoverageValue', {
                      defaultValue: '{{accounts}} 账号 / {{containers}} 容器',
                      accounts: summary.accountCount,
                      containers: summary.containerCount,
                    })}
                  </dd>
                </div>
              </dl>
            )}
          </div>
        </div>
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
        // C7 ① 结构性缺席：空态不裸横杠，给显式空态卡 + 一句解锁条件（该 env 需有
        // 健康容器绑定账号、且账号自 CPA 上次重启后产生过请求），说明「为什么空、
        // 怎么才会有数据」，而非只写「暂无用量数据」。
        empty={{
          title: t('farm.usage.empty'),
          description: t('farm.usage.emptyUnlock', {
            defaultValue:
              '解锁条件：该环境需有健康容器绑定账号，且账号自 CPA 上次重启后产生过请求；满足后此处会按账号/容器列出累计用量。当前测试端可能尚无健康容器或账号未产生流量。',
          }),
          testId: 'farm-usage-empty',
        }}
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
            {items.map((item) => {
              // C6 备注展示：运营者只记备注/别名不记邮箱，主行优先展示 account_note，
              // 缺备注时回退旧口径（account_id + email）。
              const identity = deriveUsageAccountIdentity(item);
              return (
              <TableRow
                key={`${item.container_id}-${item.account_id}-${item.env}-${item.auth_index}`}
                data-testid={`farm-usage-row-${item.container_id}-${item.account_id}`}
              >
                <TableCell data-label={t('farm.accounts.column_name')}>
                  <div className={styles.accountCell}>
                    {identity.hasNote ? (
                      <span
                        className={styles.noteBadge}
                        title={t('farm.usage.noteBadgeTitle', { defaultValue: '账号备注 / 别名' })}
                        data-testid={`farm-usage-note-${item.container_id}-${item.account_id}`}
                      >
                        {identity.note}
                      </span>
                    ) : null}
                    <span className={identity.hasNote ? styles.accountIdSub : undefined}>
                      {identity.accountId}
                    </span>
                    {identity.email ? (
                      <span className={styles.accountEmail}>{identity.email}</span>
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
              );
            })}
          </TableBody>
        </Table>
      </AsyncPanel>
    </div>
  );
}
