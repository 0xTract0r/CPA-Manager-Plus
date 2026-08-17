import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDurationMs } from '@/utils/usage';
import { formatInUtc8 } from '@/utils/format';
import { useAccountSpeedMetrics } from '@/features/authFiles/hooks/useAccountSpeedMetrics';
import {
  computeMetricDelta,
  type AccountSpeedMetricSummary,
  type MetricDelta,
} from '@/features/authFiles/model/accountSpeedMetrics';
import { computeQuotaRunway } from '@/features/authFiles/model/accountQuotaRunway';
import { detectFirstFastTransition } from '@/features/authFiles/model/accountSpeedSeries';
import { TtftTransitionSparkline } from './TtftTransitionSparkline';
import styles from './AccountFastImpactPanel.module.scss';

export interface AccountFastImpactPanelProps {
  /** 账号名（auth file name），无 authIndex 时用于 analytics accounts 过滤。 */
  accountName?: string | null;
  /** 账号 auth_index（首选精确过滤键）。 */
  authIndex?: string | number | null;
  /** 关闭时不请求也不渲染；默认 true。 */
  enabled?: boolean;
}

/** minSamples 略降到 2，让「开 fast 前后对比」更容易在样本较少时出数。 */
const FAST_IMPACT_MIN_SAMPLES = 2;

const summaryHasReading = (summary: AccountSpeedMetricSummary | null): boolean =>
  summary !== null &&
  (summary.medianTtftMs !== null ||
    summary.medianLatencyMs !== null ||
    summary.medianTps !== null);

const formatDuration = (value: number | null): string =>
  value === null ? '--' : formatDurationMs(value);

const formatTps = (value: number | null, locale: string): string => {
  if (value === null || !Number.isFinite(value) || value <= 0) return '--';
  const abs = Math.abs(value);
  const maximumFractionDigits = abs < 1 ? 2 : abs < 10 ? 1 : 0;
  try {
    return new Intl.NumberFormat(locale, { maximumFractionDigits, minimumFractionDigits: 0 }).format(
      value
    );
  } catch {
    return value.toFixed(maximumFractionDigits);
  }
};

const formatPercent = (value: number | null): string =>
  value === null || !Number.isFinite(value) ? '--' : `${Math.round(value)}%`;

const formatResetTime = (ms: number | null, locale: string): string => {
  if (ms === null || !Number.isFinite(ms)) return '--';
  return formatInUtc8(
    ms,
    { dateStyle: 'short', timeStyle: 'short', withZoneLabel: true },
    locale,
    '--'
  );
};

/** 把 delta 渲染成带方向语义的可读文案（如「−54% 更快」/「+55% 更高」）。 */
function DeltaCell({
  delta,
  lowerIsBetter,
  testId,
}: {
  delta: MetricDelta;
  lowerIsBetter: boolean;
  testId: string;
}) {
  const { t } = useTranslation();
  if (delta.pctChange === null || delta.improved === null) {
    return (
      <span className={styles.deltaNeutral} data-testid={testId} data-delta="na">
        --
      </span>
    );
  }
  const rounded = Math.round(delta.pctChange);
  const signed = rounded > 0 ? `+${rounded}%` : `${rounded}%`;
  const directionWord = lowerIsBetter
    ? delta.improved
      ? t('auth_files.account_fast_impact_faster', { defaultValue: 'faster' })
      : t('auth_files.account_fast_impact_slower', { defaultValue: 'slower' })
    : delta.improved
      ? t('auth_files.account_fast_impact_higher', { defaultValue: 'higher' })
      : t('auth_files.account_fast_impact_lower', { defaultValue: 'lower' });
  return (
    <span
      className={delta.improved ? styles.deltaGood : styles.deltaBad}
      data-testid={testId}
      data-delta={delta.improved ? 'improved' : 'regressed'}
    >
      {signed} <span className={styles.deltaWord}>{directionWord}</span>
    </span>
  );
}

/**
 * Phase 3 容器：把 fast(priority) vs default 前后对比、配额 runway、TTFT 切换点 sparkline
 * 三块摆到账号设置弹窗 fast 开关旁（决策点）。内部只用一次 useAccountSpeedMetrics 拉取
 * 一批 events，同时喂给三块（compare 用 service_tier 分组 metrics，runway/sparkline 用同一
 * 份按 timestamp_ms 排序的 series），全程一次请求。
 *
 * 仅 codex 账号由调用方（弹窗 isCodexProvider）挂载；enabled=false / 服务不可用 / 出错时
 * 不渲染。数据不足一律优雅降级为明确文案，绝不显示 NaN/假 0。
 */
export function AccountFastImpactPanel({
  accountName,
  authIndex,
  enabled = true,
}: AccountFastImpactPanelProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n?.language || i18n?.resolvedLanguage || 'en';

  const { status, metrics, series, windowHours } = useAccountSpeedMetrics({
    accountName,
    authIndex,
    enabled,
    minSamples: FAST_IMPACT_MIN_SAMPLES,
  });

  const runway = useMemo(() => computeQuotaRunway(series), [series]);
  const transition = useMemo(() => detectFirstFastTransition(series), [series]);
  const ttftSampleCount = useMemo(
    () => series.reduce((acc, p) => (p.ttftMs !== null ? acc + 1 : acc), 0),
    [series]
  );

  // 服务不可用 / 关闭 / 出错时不占用弹窗空间（避免误导为「有数据但为 0」）。
  if (status === 'disabled' || status === 'unavailable' || status === 'error') {
    return null;
  }

  const windowLabel = t('auth_files.account_fast_impact_window', {
    hours: windowHours,
    defaultValue: 'last {{hours}}h',
  });

  const header = (
    <div className={styles.panelHeader}>
      <strong>
        {t('auth_files.account_fast_impact_title', { defaultValue: 'Fast mode impact' })}
      </strong>
      <span className={styles.panelWindow}>{windowLabel}</span>
    </div>
  );

  if (status === 'loading') {
    return (
      <div
        className={styles.panel}
        data-testid="account-fast-impact-panel"
        data-fast-impact-status="loading"
      >
        {header}
        <span className={styles.emptyLine}>
          {t('auth_files.account_fast_impact_loading', {
            defaultValue: 'Measuring fast vs default…',
          })}
        </span>
      </div>
    );
  }

  const priority = metrics?.priorityTier ?? null;
  const dflt = metrics?.defaultTier ?? null;
  const priorityHas = summaryHasReading(priority);
  const defaultHas = summaryHasReading(dflt);
  const canCompare = priorityHas && defaultHas;

  return (
    <div
      className={styles.panel}
      data-testid="account-fast-impact-panel"
      data-fast-impact-status={status}
    >
      {header}

      {/* A. fast vs default 前后对比 */}
      <section className={styles.block} data-testid="fast-compare-block">
        <div className={styles.blockTitle}>
          {t('auth_files.account_fast_impact_compare_title', { defaultValue: 'Fast vs default' })}
        </div>
        {canCompare && priority && dflt ? (
          <CompareTable priority={priority} dflt={dflt} locale={locale} />
        ) : priorityHas || defaultHas ? (
          <SingleSegmentReadings
            summary={priorityHas ? (priority as AccountSpeedMetricSummary) : (dflt as AccountSpeedMetricSummary)}
            isPriority={priorityHas}
            locale={locale}
          />
        ) : (
          <span className={styles.emptyLine} data-testid="fast-compare-none">
            {t('auth_files.account_fast_impact_compare_none', {
              defaultValue: 'Not enough data to compare fast vs default.',
            })}
          </span>
        )}
      </section>

      {/* B. 配额 runway */}
      <section className={styles.block} data-testid="fast-quota-runway">
        <div className={styles.blockTitle}>
          {t('auth_files.account_fast_impact_runway_title', { defaultValue: 'Quota runway' })}
        </div>
        {runway.status === 'ok' ? (
          <div className={styles.runwayBody} data-runway-status="ok">
            <span className={styles.runwayHeadline} data-testid="fast-quota-runway-value">
              {t('auth_files.account_fast_impact_runway_ok', {
                duration: formatDuration(runway.runwayMs),
                defaultValue: 'About {{duration}} until 100% at the current rate.',
              })}
            </span>
            <span className={styles.runwayMeta}>
              {t('auth_files.account_fast_impact_runway_used', {
                percent: formatPercent(runway.latestUsedPercent),
                defaultValue: 'Used {{percent}}',
              })}
              {runway.recoverAtMs !== null && (
                <>
                  {' · '}
                  {t('auth_files.account_fast_impact_runway_reset', {
                    time: formatResetTime(runway.recoverAtMs, locale),
                    defaultValue: 'Weekly reset: {{time}}',
                  })}
                </>
              )}
            </span>
            {runway.resetsBeforeExhaustion === true && (
              <span className={styles.runwaySafe} data-testid="fast-quota-runway-safe">
                {t('auth_files.account_fast_impact_runway_safe', {
                  defaultValue: 'Reset arrives before exhaustion — current rate is safe.',
                })}
              </span>
            )}
          </div>
        ) : (
          <div
            className={styles.runwayBody}
            data-runway-status={runway.status}
            data-testid="fast-quota-runway-degraded"
          >
            <span className={styles.emptyLine}>
              {runway.status === 'flat'
                ? t('auth_files.account_fast_impact_runway_flat', {
                    defaultValue: 'Quota usage is flat; not extrapolating a runway.',
                  })
                : runway.latestUsedPercent !== null
                  ? t('auth_files.account_fast_impact_runway_insufficient', {
                      defaultValue: 'Not enough quota-usage samples to estimate a runway.',
                    })
                  : t('auth_files.account_fast_impact_runway_no_data', {
                      defaultValue: 'No quota-usage data yet.',
                    })}
            </span>
            {runway.latestUsedPercent !== null && (
              <span className={styles.runwayMeta}>
                {t('auth_files.account_fast_impact_runway_used', {
                  percent: formatPercent(runway.latestUsedPercent),
                  defaultValue: 'Used {{percent}}',
                })}
                {runway.recoverAtMs !== null && (
                  <>
                    {' · '}
                    {t('auth_files.account_fast_impact_runway_reset', {
                      time: formatResetTime(runway.recoverAtMs, locale),
                      defaultValue: 'Weekly reset: {{time}}',
                    })}
                  </>
                )}
              </span>
            )}
          </div>
        )}
      </section>

      {/* C. TTFT 切换点 sparkline */}
      <section className={styles.block} data-testid="fast-ttft-sparkline-block">
        <div className={styles.blockTitle}>
          {t('auth_files.account_fast_impact_sparkline_title', {
            defaultValue: 'First-token trend',
          })}
        </div>
        {ttftSampleCount >= 2 ? (
          <div className={styles.sparklineBody}>
            <TtftTransitionSparkline
              series={series}
              transition={transition}
              ariaLabel={t('auth_files.account_fast_impact_sparkline_aria', {
                defaultValue:
                  'First-token latency trend over the window, with the fast switch point marked.',
              })}
              data-testid="ttft-transition-sparkline"
            />
            <span className={styles.sparklineCaption} data-testid="ttft-transition-caption">
              {transition
                ? t('auth_files.account_fast_impact_sparkline_caption_transition', {
                    defaultValue: 'Marked line = when fast turned on.',
                  })
                : t('auth_files.account_fast_impact_sparkline_caption_none', {
                    defaultValue: 'Single service tier in this window; no switch point.',
                  })}
            </span>
          </div>
        ) : (
          <span className={styles.emptyLine} data-testid="ttft-transition-insufficient">
            {t('auth_files.account_fast_impact_sparkline_insufficient', {
              defaultValue: 'Not enough first-token samples to plot.',
            })}
          </span>
        )}
      </section>
    </div>
  );
}

function CompareTable({
  priority,
  dflt,
  locale,
}: {
  priority: AccountSpeedMetricSummary;
  dflt: AccountSpeedMetricSummary;
  locale: string;
}) {
  const { t } = useTranslation();
  const ttftDelta = computeMetricDelta(priority.medianTtftMs, dflt.medianTtftMs, {
    lowerIsBetter: true,
  });
  const latencyDelta = computeMetricDelta(priority.medianLatencyMs, dflt.medianLatencyMs, {
    lowerIsBetter: true,
  });
  const tpsDelta = computeMetricDelta(priority.medianTps, dflt.medianTps, {
    lowerIsBetter: false,
  });

  return (
    <div
      className={styles.compareGrid}
      role="table"
      aria-label={t('auth_files.account_fast_impact_compare_title', {
        defaultValue: 'Fast vs default',
      })}
    >
      <div className={styles.compareHead} role="row">
        <span role="columnheader" className={styles.compareMetricHead} />
        <span role="columnheader">
          {t('auth_files.account_fast_impact_col_default', { defaultValue: 'Default' })}
        </span>
        <span role="columnheader">
          {t('auth_files.account_fast_impact_col_fast', { defaultValue: 'Fast' })}
        </span>
        <span role="columnheader">
          {t('auth_files.account_fast_impact_col_change', { defaultValue: 'Change' })}
        </span>
      </div>

      <div className={styles.compareRow} role="row" data-testid="fast-compare-ttft">
        <span role="cell" className={styles.compareMetric}>
          {t('auth_files.account_fast_impact_row_ttft', { defaultValue: 'First token' })}
        </span>
        <span role="cell">{formatDuration(dflt.medianTtftMs)}</span>
        <span role="cell" className={styles.compareFastValue}>
          {formatDuration(priority.medianTtftMs)}
        </span>
        <span role="cell">
          <DeltaCell delta={ttftDelta} lowerIsBetter testId="fast-compare-ttft-delta" />
        </span>
      </div>

      <div className={styles.compareRow} role="row" data-testid="fast-compare-latency">
        <span role="cell" className={styles.compareMetric}>
          {t('auth_files.account_fast_impact_row_latency', { defaultValue: 'Latency' })}
        </span>
        <span role="cell">{formatDuration(dflt.medianLatencyMs)}</span>
        <span role="cell" className={styles.compareFastValue}>
          {formatDuration(priority.medianLatencyMs)}
        </span>
        <span role="cell">
          <DeltaCell delta={latencyDelta} lowerIsBetter testId="fast-compare-latency-delta" />
        </span>
      </div>

      <div className={styles.compareRow} role="row" data-testid="fast-compare-tps">
        <span role="cell" className={styles.compareMetric}>
          {t('auth_files.account_fast_impact_row_tps', { defaultValue: 'TPS' })}
        </span>
        <span role="cell">{formatTps(dflt.medianTps, locale)}</span>
        <span role="cell" className={styles.compareFastValue}>
          {formatTps(priority.medianTps, locale)}
        </span>
        <span role="cell">
          <DeltaCell delta={tpsDelta} lowerIsBetter={false} testId="fast-compare-tps-delta" />
        </span>
      </div>
    </div>
  );
}

function SingleSegmentReadings({
  summary,
  isPriority,
  locale,
}: {
  summary: AccountSpeedMetricSummary;
  isPriority: boolean;
  locale: string;
}) {
  const { t } = useTranslation();
  return (
    <div className={styles.singleSegment} data-testid="fast-compare-single-segment">
      <span className={styles.emptyLine}>
        {t('auth_files.account_fast_impact_compare_one_segment', {
          defaultValue: 'The other segment has no data yet, cannot compare.',
        })}
      </span>
      <div className={styles.singleSegmentReadings}>
        <span className={styles.singleSegmentTag}>
          {isPriority
            ? t('auth_files.account_fast_impact_col_fast', { defaultValue: 'Fast' })
            : t('auth_files.account_fast_impact_col_default', { defaultValue: 'Default' })}
        </span>
        <span>
          {t('auth_files.account_fast_impact_row_ttft', { defaultValue: 'First token' })}:{' '}
          {formatDuration(summary.medianTtftMs)}
        </span>
        <span>
          {t('auth_files.account_fast_impact_row_latency', { defaultValue: 'Latency' })}:{' '}
          {formatDuration(summary.medianLatencyMs)}
        </span>
        <span>
          {t('auth_files.account_fast_impact_row_tps', { defaultValue: 'TPS' })}:{' '}
          {formatTps(summary.medianTps, locale)}
        </span>
      </div>
    </div>
  );
}
