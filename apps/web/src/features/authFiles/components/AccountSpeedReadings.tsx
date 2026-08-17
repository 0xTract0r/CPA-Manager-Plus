import { useTranslation } from 'react-i18next';
import { formatDurationMs } from '@/utils/usage';
import { useAccountSpeedMetrics } from '@/features/authFiles/hooks/useAccountSpeedMetrics';
import styles from '@/features/authFiles/AuthFilesPage.module.scss';

export interface AccountSpeedReadingsProps {
  /** 账号名（auth file name），无 authIndex 时用于 analytics accounts 过滤。 */
  accountName?: string | null;
  /** 账号 auth_index（首选精确过滤键）。 */
  authIndex?: string | number | null;
  /** 紧凑卡片模式（跟随 AuthFileCard 的 compact）。 */
  compact?: boolean;
  /** 关闭时不渲染也不请求；默认 true。 */
  enabled?: boolean;
}

const formatMedianDuration = (value: number | null): string =>
  value === null ? '--' : formatDurationMs(value);

const formatTps = (value: number | null, locale: string): string => {
  if (value === null || !Number.isFinite(value) || value <= 0) return '--';
  const abs = Math.abs(value);
  const maximumFractionDigits = abs < 1 ? 2 : abs < 10 ? 1 : 0;
  try {
    return new Intl.NumberFormat(locale, {
      maximumFractionDigits,
      minimumFractionDigits: 0,
    }).format(value);
  } catch {
    return value.toFixed(maximumFractionDigits);
  }
};

/**
 * Phase 2：账号级速度读数展示——中位首 token · 中位耗时 · TPS。
 * 数据层来自 useAccountSpeedMetrics（可复用，含 service_tier 分组，供 Phase 3 复用）。
 * Phase 2 仅展示 overall；数据不足 / 服务不可用 / 出错时降级为占位或不渲染，绝不显示 NaN。
 */
export function AccountSpeedReadings({
  accountName,
  authIndex,
  compact = false,
  enabled = true,
}: AccountSpeedReadingsProps) {
  const { t, i18n } = useTranslation();
  // 防御式取 locale：部分测试 mock 的 useTranslation 只返回 { t } 而无 i18n，直接读
  // i18n.language 会抛错；缺失时回退到 'en'，仅影响 TPS 数字千分位/小数本地化。
  const locale = i18n?.language || i18n?.resolvedLanguage || 'en';
  const { status, metrics, windowHours, sampleCount } = useAccountSpeedMetrics({
    accountName,
    authIndex,
    enabled,
  });

  // 服务不可用 / 关闭 / 出错时不占用卡片空间（避免误导为「有数据但为 0」）。
  if (status === 'disabled' || status === 'unavailable' || status === 'error') {
    return null;
  }

  const windowLabel = t('auth_files.speed_readings_window_hours', {
    hours: windowHours,
    defaultValue: 'last {{hours}}h',
  });

  const blockTitle = t('auth_files.speed_readings_block_title', {
    hours: windowHours,
    count: sampleCount,
    defaultValue:
      'Median first token, latency, and generation speed over the last {{hours}}h ({{count}} requests)',
  });

  const containerClass = `${styles.speedReadings} ${compact ? styles.speedReadingsCompact : ''}`;

  const header = (
    <div className={styles.speedReadingsHeader}>
      <span className={styles.speedReadingsLabel}>
        {t('auth_files.speed_readings_label', { defaultValue: 'Speed' })}
      </span>
      <span className={styles.speedReadingsWindow}>{windowLabel}</span>
      {sampleCount > 0 && (
        <span className={styles.speedReadingsNote}>
          {t('auth_files.speed_readings_sample_note', {
            count: sampleCount,
            defaultValue: '· {{count}} reqs',
          })}
        </span>
      )}
    </div>
  );

  if (status === 'loading') {
    return (
      <div className={containerClass} data-testid="account-speed-readings" data-account-speed-status="loading">
        {header}
        <span className={styles.speedReadingsEmpty}>
          {t('auth_files.speed_readings_loading', { defaultValue: 'Measuring…' })}
        </span>
      </div>
    );
  }

  if (status === 'insufficient' || !metrics) {
    return (
      <div
        className={containerClass}
        data-testid="account-speed-readings"
        data-account-speed-status="insufficient"
      >
        {header}
        <span className={styles.speedReadingsEmpty} data-testid="account-speed-insufficient">
          {t('auth_files.speed_readings_insufficient', { defaultValue: 'Not enough data' })}
        </span>
      </div>
    );
  }

  const { overall } = metrics;

  return (
    <div
      className={containerClass}
      data-testid="account-speed-readings"
      data-account-speed-status="ok"
      title={blockTitle}
    >
      {header}
      <div className={styles.speedReadingsGrid}>
        <div className={styles.speedReadingItem} data-testid="account-speed-ttft">
          <span className={styles.speedReadingItemLabel}>
            {t('auth_files.speed_readings_ttft_label', { defaultValue: 'First token' })}
          </span>
          <span className={styles.speedReadingItemValue}>
            {formatMedianDuration(overall.medianTtftMs)}
          </span>
        </div>
        <div className={styles.speedReadingItem} data-testid="account-speed-latency">
          <span className={styles.speedReadingItemLabel}>
            {t('auth_files.speed_readings_latency_label', { defaultValue: 'Latency' })}
          </span>
          <span className={styles.speedReadingItemValue}>
            {formatMedianDuration(overall.medianLatencyMs)}
          </span>
        </div>
        <div
          className={styles.speedReadingItem}
          data-testid="account-speed-tps"
          title={t('auth_files.speed_readings_tps_title', {
            defaultValue:
              'Tokens per second during generation (output tokens ÷ (latency − first token))',
          })}
        >
          <span className={styles.speedReadingItemLabel}>
            {t('auth_files.speed_readings_tps_label', { defaultValue: 'TPS' })}
          </span>
          <span className={styles.speedReadingItemValue}>
            {formatTps(overall.medianTps, locale)}
            <span className={styles.speedReadingUnit}>
              {t('auth_files.speed_readings_tps_unit', { defaultValue: 'tok/s' })}
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}
