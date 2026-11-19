import { useTranslation } from 'react-i18next';
import type { AuthFileWarmupTrafficPacing } from '@/types';
import { pacingRateSummary } from '../model/warmupPacing';
import styles from './WarmupPacing.module.scss';

export function PacingRateExplanation({
  snapshot,
  compact = false,
}: {
  snapshot?: AuthFileWarmupTrafficPacing | null;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const k = (name: string, options?: Record<string, unknown>) =>
    t('auth_files.pacing.' + name, options);
  const rate = pacingRateSummary(snapshot);
  if (rate.hourly === null) return null;
  const number = (value: number | null, digits = 2) =>
    value === null ? '—' : value.toLocaleString(undefined, { maximumFractionDigits: digits });
  const duration = (seconds: number | null) => {
    if (seconds === null) return k('unknown');
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const rest = seconds % 60;
    return k(hours ? 'rate_time_hms' : minutes ? 'rate_time_ms' : 'rate_time_s', {
      hours,
      minutes,
      seconds: rest,
    });
  };
  return (
    <div
      className={styles.rateExplanation}
      data-testid={compact ? 'pacing-rate-settings' : 'pacing-rate-detail'}
    >
      <p>
        <strong>
          {k('rate_refill_summary', {
            perMinute: number(rate.perMinute, 3),
            hourly: number(rate.hourly),
            interval: duration(rate.secondsPerCredit),
          })}
        </strong>
      </p>
      <p>{k('rate_peak_note', { rpm: number(rate.peakRPM), capacity: number(rate.capacity) })}</p>
      <div className={styles.admissionRules}>
        <span>{k('rate_new_threshold', { threshold: number(rate.threshold) })}</span>
        <span>{k('rate_continuation_threshold')}</span>
      </div>
      <p>{k('rate_single_debit')}</p>
      {compact ? (
        <p>{k('rate_presets_note')}</p>
      ) : (
        <>
          {rate.emptyToNewSessionSeconds !== null && (
            <p>
              {k('rate_empty_estimate', {
                threshold: number(rate.threshold),
                duration: duration(rate.emptyToNewSessionSeconds),
              })}
            </p>
          )}
        </>
      )}
    </div>
  );
}
