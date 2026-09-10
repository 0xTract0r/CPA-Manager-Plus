import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AsyncPanel } from '@/components/ui/AsyncPanel';
import { Button } from '@/components/ui/Button';
import { IconMoon } from '@/components/ui/icons';
import { formatFileSize } from '@/utils/format';
import { formatDateTimeUtc8 } from '@/utils/datetime';
import { useTimezone } from '@/hooks/useTimezone';
import type { StatusBadgeVariant } from '../utils/health';
import { useFarmStandbySummary } from '../hooks/useFarmStandbySummary';
import type { FarmEnv } from '@/types/farm';
import styles from './FarmStandbySummaryPanel.module.scss';

// 计数徽标着色：>0 用 warning（提醒人工清理），=0 用 muted（无需处理，不刷绿误导成“健康指标”）。
function countTone(count: number): StatusBadgeVariant {
  return count > 0 ? 'warning' : 'muted';
}

/**
 * farm-account-standby-control R4：累积清理看板（消费 GET /api/farm/standby-summary?env=）。
 *
 * 目的=提醒人工清理、防遗忘堆积：把三类沉积量聚合成一屏——
 *  ① 停用超 N 天的账号（可展开列表：备注/账号 + 停用起始时刻）；
 *  ② 待机中的容器数（可展开列表：容器 id/备注 + 待机起始时刻）；
 *  ③ 已退役但未回收的卷数 + 占盘。
 *
 * 诚实边界：各 count=0 + 空 items 视为“无需清理”正向空态，不报错、不伪造待办；
 * 时间戳缺失显 '—' 不臆造；disk_bytes 走全站 formatFileSize。env 按农场页既有约定
 * 取 'test'（本部署编排器只服务 test）。
 */
export function FarmStandbySummaryPanel({ env = 'test' }: { env?: FarmEnv } = {}) {
  const { t, i18n } = useTranslation();
  // 订阅全局时区：切换时区时重渲染，内部 formatDateTimeUtc8 同步刷新。
  useTimezone();
  const { summary, loading, error, reload } = useFarmStandbySummary(env);
  const [expandDisabled, setExpandDisabled] = useState(false);
  const [expandStandby, setExpandStandby] = useState(false);

  const disabled = summary?.disabled_accounts;
  const standby = summary?.standby_containers;
  const retiredVolumes = summary?.retired_volumes;

  const disabledCount = disabled?.count ?? 0;
  const standbyCount = standby?.count ?? 0;
  const retiredVolumeCount = retiredVolumes?.count ?? 0;
  const thresholdDays = disabled?.threshold_days ?? 0;

  const fmtTime = (value?: string) =>
    value ? formatDateTimeUtc8(value, i18n.language) : '—';

  const nothingToClean =
    !loading && !error && disabledCount === 0 && standbyCount === 0 && retiredVolumeCount === 0;

  return (
    <section
      className={styles.panel}
      data-testid="farm-standby-summary-panel"
      aria-label={t('farm.standbySummary.title', { defaultValue: '清理待办' })}
    >
      <div className={styles.header}>
        <div className={styles.titleWrap}>
          <IconMoon size={16} aria-hidden="true" />
          <h2 className={styles.title}>
            {t('farm.standbySummary.title', { defaultValue: '清理待办' })}
          </h2>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => reload()}
          data-testid="farm-standby-summary-refresh"
        >
          {t('common.refresh')}
        </Button>
      </div>

      <AsyncPanel
        loading={loading}
        error={error}
        loadingLabel={t('common.loading')}
        loadingTestId="farm-standby-summary-loading"
        errorTestId="farm-standby-summary-error"
      >
        <div className={styles.body}>
          <p className={styles.caption}>
            {t('farm.standbySummary.caption', {
              defaultValue: '以下为农场累积待清理项，定期人工处理可避免温容器/退役卷无声堆积。',
            })}
          </p>

          <div className={styles.metrics} data-testid="farm-standby-summary-metrics">
            {/* ① 停用超 N 天账号 */}
            <div className={styles.metric} data-testid="farm-standby-summary-disabled">
              <span className={styles.metricLabel}>
                {t('farm.standbySummary.disabledLabel', {
                  days: thresholdDays,
                  defaultValue: '停用超 {{days}} 天账号',
                })}
              </span>
              <span
                className={`status-badge ${countTone(disabledCount)} ${styles.metricValue}`}
                data-count={disabledCount}
              >
                {disabledCount}
              </span>
            </div>

            {/* ② 待机容器 */}
            <div className={styles.metric} data-testid="farm-standby-summary-standby">
              <span className={styles.metricLabel}>
                {t('farm.standbySummary.standbyLabel', { defaultValue: '待机容器' })}
              </span>
              <span
                className={`status-badge ${countTone(standbyCount)} ${styles.metricValue}`}
                data-count={standbyCount}
              >
                {standbyCount}
              </span>
            </div>

            {/* ③ 退役卷 + 占盘 */}
            <div className={styles.metric} data-testid="farm-standby-summary-retired-volumes">
              <span className={styles.metricLabel}>
                {t('farm.standbySummary.retiredVolumesLabel', { defaultValue: '未回收退役卷' })}
              </span>
              <span
                className={`status-badge ${countTone(retiredVolumeCount)} ${styles.metricValue}`}
                data-count={retiredVolumeCount}
              >
                {retiredVolumeCount}
              </span>
              <span className={styles.metricNote}>
                {t('farm.standbySummary.diskUsage', {
                  size: formatFileSize(retiredVolumes?.disk_bytes ?? 0),
                  defaultValue: '占盘 {{size}}',
                })}
              </span>
            </div>
          </div>

          {nothingToClean ? (
            <p className={styles.clean} data-testid="farm-standby-summary-clean">
              {t('farm.standbySummary.nothingToClean', {
                defaultValue: '暂无需要清理的累积项。',
              })}
            </p>
          ) : null}

          {/* 停用超 N 天账号：可展开列表 */}
          {disabledCount > 0 && disabled?.items?.length ? (
            <div className={styles.section}>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setExpandDisabled((open) => !open)}
                aria-expanded={expandDisabled}
                data-testid="farm-standby-summary-disabled-toggle"
              >
                {expandDisabled
                  ? t('farm.standbySummary.collapse', { defaultValue: '收起' })
                  : t('farm.standbySummary.expandDisabled', {
                      count: disabledCount,
                      defaultValue: '展开 {{count}} 个停用账号',
                    })}
              </Button>
              {expandDisabled ? (
                <ul className={styles.list} data-testid="farm-standby-summary-disabled-list">
                  {disabled.items.map((item) => (
                    <li key={item.account_id} className={styles.row}>
                      <span className={styles.rowPrimary} title={item.account_id}>
                        {item.note || item.account_id}
                      </span>
                      <span className={styles.rowMeta}>
                        {t('farm.standbySummary.disabledSince', {
                          at: fmtTime(item.disabled_since),
                          defaultValue: '停用于 {{at}}',
                        })}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          {/* 待机容器：可展开列表 */}
          {standbyCount > 0 && standby?.items?.length ? (
            <div className={styles.section}>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setExpandStandby((open) => !open)}
                aria-expanded={expandStandby}
                data-testid="farm-standby-summary-standby-toggle"
              >
                {expandStandby
                  ? t('farm.standbySummary.collapse', { defaultValue: '收起' })
                  : t('farm.standbySummary.expandStandby', {
                      count: standbyCount,
                      defaultValue: '展开 {{count}} 个待机容器',
                    })}
              </Button>
              {expandStandby ? (
                <ul className={styles.list} data-testid="farm-standby-summary-standby-list">
                  {standby.items.map((item) => (
                    <li key={item.container_id} className={styles.row}>
                      <span className={styles.rowPrimary} title={item.container_id}>
                        {item.note || item.account_id || item.container_id}
                      </span>
                      <span className={styles.rowMeta}>
                        {t('farm.standbySummary.standbySince', {
                          at: fmtTime(item.standby_since),
                          defaultValue: '待机于 {{at}}',
                        })}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
      </AsyncPanel>
    </section>
  );
}
