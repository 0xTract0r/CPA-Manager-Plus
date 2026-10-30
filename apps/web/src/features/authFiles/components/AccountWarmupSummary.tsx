import { useEffect, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { AuthFileAccountScheduling } from '@/types';
import { useConfigStore } from '@/stores/useConfigStore';
import { formatDateTime } from '@/utils/format';
import {
  deriveWarmupProgress,
  nonnegative,
  parseWarmupCurve,
  quotaWindowSummaries,
} from '../model/warmupPolicySummary';
import styles from './AccountSchedulingPanel.module.scss';

export function AccountWarmupSummary({
  view,
  compact = false,
  action,
}: {
  view?: AuthFileAccountScheduling | null;
  compact?: boolean;
  action?: ReactNode;
}) {
  const { t } = useTranslation();
  const k = (name: string, options?: Record<string, unknown>) =>
    t('auth_files.pacing.' + name, options);
  const raw = useConfigStore((state) => state.config?.raw?.['account-scheduling']);
  const fetchConfig = useConfigStore((state) => state.fetchConfig);
  useEffect(() => {
    if (typeof window !== 'undefined') void fetchConfig().catch(() => {});
  }, [fetchConfig]);
  const curve = parseWarmupCurve(raw);
  const progress = deriveWarmupProgress(view, curve);
  const tokens = nonnegative(view?.effective_limits?.token_daily_budget);
  const requests =
    nonnegative(view?.warmup_traffic_pacing?.daily_request_budget) ??
    nonnegative(view?.effective_limits?.daily_budget);
  const budget = (value: number | null) =>
    value === null ? k('unknown') : value === 0 ? k('local_limit_off') : value.toLocaleString();
  const windows = quotaWindowSummaries(view);
  const title =
    view?.warmup_control?.manual_mature && view?.warmup?.mature !== true
      ? k('manual_mature_restricted')
      : view?.warmup?.mature === true
        ? k('warmup_mature')
        : progress.age === null
          ? k('warmup_no_anchor')
          : progress.total === null
            ? k('warmup_age_only', { age: progress.age })
            : k('warmup_age_total', { age: progress.age, total: progress.total });
  if (compact)
    return (
      <div className={styles.compactSummary} data-testid="account-scheduling-summary">
        <span>
          <strong>🌱 {title}</strong> · {view?.warmup?.stage || k('unknown')}
        </span>
        {action}
      </div>
    );
  return (
    <details
      className={styles.warmupSummary}
      data-testid="warmup-policy-summary"
      aria-label={k('warmup_budget_title')}
    >
      <summary className={styles.summaryHeading}>
        <strong>🌱 {title}</strong>
        <span>{k('progress_protection_details')} ▾</span>
      </summary>
      {progress.percent !== null && (
        <div
          className={styles.warmupTrack}
          role="progressbar"
          aria-label={k('warmup_progress')}
          aria-valuenow={Math.min(progress.age ?? 0, progress.total ?? 0)}
          aria-valuemax={progress.total ?? 0}
          aria-valuemin={0}
        >
          <span style={{ width: progress.percent + '%' }} />
        </div>
      )}
      <p className={styles.summaryHint}>
        {progress.total !== null
          ? k('warmup_period_note', { days: progress.total })
          : progress.unbounded
            ? k('warmup_unbounded')
            : k('warmup_curve_unknown')}
        {progress.expectedAt && view?.warmup?.mature === false && (
          <span> {k('warmup_expected', { time: formatDateTime(progress.expectedAt) })}</span>
        )}
      </p>
      <dl className={styles.budgetGrid}>
        <div>
          <dt>{k('daily_request_protection')}</dt>
          <dd data-testid="warmup-request-budget">
            {budget(requests)}
            {requests !== null && requests > 0 && <small>{k('per_rolling_day')}</small>}
          </dd>
        </div>
        <div>
          <dt>{k('daily_token_protection')}</dt>
          <dd data-testid="warmup-token-budget" data-enabled={tokens !== null && tokens > 0}>
            {budget(tokens)}
            {tokens !== null && tokens > 0 && <small>{k('tokens_per_rolling_day')}</small>}
          </dd>
        </div>
      </dl>
      <p className={styles.summaryHint}>{k('token_local_note')}</p>
      <p className={styles.percentGap} data-testid="subscription-percent-gap">
        <strong>{k('subscription_daily_gap')}</strong> {k('subscription_daily_gap_note')}
      </p>
      <details className={styles.policyExplanation}>
        <summary>{k('stage_quota_details')}</summary>
        {curve && view?.warmup_control?.warmup_period_days == null && (
          <ol className={styles.stageList}>
            {curve.map((stage) => (
              <li key={stage.name} data-current={stage.name === view?.warmup?.stage}>
                <strong>{stage.name}</strong>
                <span>
                  {stage.end
                    ? k('stage_days', { from: stage.start, to: stage.end })
                    : k('stage_open_end', { from: stage.start })}
                </span>
                <span>
                  {stage.requests === null
                    ? k('unknown')
                    : stage.requests === 0
                      ? k('local_limit_off')
                      : k('stage_requests', { count: stage.requests })}
                </span>
              </li>
            ))}
          </ol>
        )}
        <p>{k('stage_schedule_note')}</p>
        <div className={styles.quotaWindowRow}>
          {windows.map((window) => (
            <span key={window.key}>
              {k('window_' + window.key)}：
              <strong>
                {window.percent === null
                  ? k('unknown')
                  : window.percent.toLocaleString(undefined, { maximumFractionDigits: 1 }) + '%'}
              </strong>
            </span>
          ))}
        </div>
        <p>{k('subscription_weight_note')}</p>
      </details>
    </details>
  );
}
