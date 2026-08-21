import { Link } from 'react-router-dom';
import type { TFunction } from 'i18next';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import type { MonitoringStatusTone } from '@/features/monitoring/hooks/useMonitoringData';
import type { UsageCatchUpPresentation } from '@/features/monitoring/model/usageCatchUpPresentation';
import { formatInUtc8 } from '@/utils/datetime';
import { formatCompactNumber } from '@/utils/usage';
import styles from '../MonitoringCenterPage.module.scss';

type MonitoringStatusHeaderProps = {
  showLoadingOverlay: boolean;
  monitoringUnavailable: boolean;
  monitoringUnavailableTitle: string;
  monitoringUnavailableBody: string;
  t: TFunction;
};

type MonitoringStatusSummaryProps = {
  connectionTone: MonitoringStatusTone;
  connectionLabel: string;
  lastRefreshedAt: Date | null;
  locale: string;
  scopedFailureCount: number;
  totalCalls: number;
  t: TFunction;
  /** 8.6 用量自动补齐状态展示；为 null 时不渲染（worker 尚未产出状态）。 */
  usageCatchUpStatus?: UsageCatchUpPresentation | null;
};

const shortLabel = (t: TFunction, shortKey: string, fallbackKey: string) => {
  const fallback = t(fallbackKey);
  const label = t(shortKey, { defaultValue: fallback });
  return label === shortKey ? fallback : label;
};

export function MonitoringStatusSummary({
  connectionTone,
  connectionLabel,
  lastRefreshedAt,
  locale,
  scopedFailureCount,
  totalCalls,
  t,
  usageCatchUpStatus,
}: MonitoringStatusSummaryProps) {
  const lastSyncLabel = shortLabel(t, 'monitoring.last_sync_short', 'monitoring.last_sync');
  const recentFailuresLabel = shortLabel(
    t,
    'monitoring.recent_failures_short',
    'monitoring.recent_failures'
  );
  const totalCallsLabel = shortLabel(t, 'monitoring.total_calls_short', 'monitoring.total_calls');

  return (
    // 徽章("已连接")与 meta chip 曾是 .statusBar 下两个各自独立 wrap 的兄弟容器
    // (.statusBadge 单项 + .statusMeta 内部再 wrap)，窄屏下会出现两层各自换行、
    // 徽章与 chip 错位漂移。现把徽章收作 .statusMeta 的第一个子项，让整条状态行
    // 只有一层可换行容器，徽章与其余 chip 在同一套断点/wrap 规则下一起换行对齐。
    <div className={styles.statusBar}>
      <div className={styles.statusMeta}>
        <span className={`${styles.statusBadge} ${styles[`tone${connectionTone}`]}`}>
          <span className={styles.statusDot} aria-hidden="true" />
          {connectionLabel}
        </span>
        <span title={t('monitoring.last_sync')}>
          {lastSyncLabel}:{' '}
          {lastRefreshedAt
            ? formatInUtc8(
                lastRefreshedAt,
                // #78 全站排查：走标准 timeStyle 路径统一成 24 小时 HH:mm:ss，
                // 不再用显式 hour/minute/second（那会经 locale 在 en-US 下渲染成 12 小时 AM/PM）。
                { timeStyle: 'medium' },
                locale
              )
            : '--'}
        </span>
        <span
          className={scopedFailureCount > 0 ? styles.statusMetaWarn : undefined}
          title={t('monitoring.recent_failures')}
        >
          {`${recentFailuresLabel}: ${scopedFailureCount}`}
        </span>
        <span title={t('monitoring.total_calls')}>
          {`${totalCallsLabel}: ${formatCompactNumber(totalCalls)}`}
        </span>
        {usageCatchUpStatus ? (
          <span
            className={styles[`usageCatchUpTone${capitalize(usageCatchUpStatus.tone)}`]}
            title={usageCatchUpStatus.title}
          >
            {usageCatchUpStatus.label}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function capitalize(value: string): string {
  return value.length ? value[0].toUpperCase() + value.slice(1) : value;
}

export function MonitoringStatusHeader({
  showLoadingOverlay,
  monitoringUnavailable,
  monitoringUnavailableTitle,
  monitoringUnavailableBody,
  t,
}: MonitoringStatusHeaderProps) {
  return (
    <>
      {showLoadingOverlay ? (
        <div className={styles.loadingOverlay} aria-busy="true">
          <div className={styles.loadingOverlayContent}>
            <LoadingSpinner size={28} />
            <span>{t('common.loading')}</span>
          </div>
        </div>
      ) : null}

      {monitoringUnavailable ? (
        <div className={styles.callout}>
          <strong>{monitoringUnavailableTitle}</strong>
          <span>{monitoringUnavailableBody}</span>
          <Link
            to="/config"
            className={styles.configLink}
            onClick={() => localStorage.setItem('config-management:tab', 'manager')}
          >
            {t('monitoring.open_manager_config')}
          </Link>
        </div>
      ) : null}
    </>
  );
}
