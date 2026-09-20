import { useTranslation } from 'react-i18next';
import { Modal } from '@/components/ui/Modal';
import type { AuthFileItem } from '@/types';
import { formatDateTime } from '@/utils/format';
import { resolveAuthProvider } from '@/utils/quota';
import {
  deriveAccountWarmupBadge,
  deriveSubscriptionTierBadge,
} from '../model/accountSessionSummary';
import {
  PACING_BLOCKERS,
  PACING_REASONS,
  pacingBalanceLevel,
  displayPacingBalance,
  pacingNumber,
  pacingStatus,
} from '../model/warmupPacing';
import { getAuthFileSelectionKey } from '../model/authFilesPageModel';
import { ClaudeTierBadge } from './ClaudeTierBadge';
import styles from './WarmupPacing.module.scss';

const key = (name: string) => `auth_files.pacing.${name}`;
const displayNumber = (value: unknown) => {
  const number = pacingNumber(value);
  return number === null ? '—' : String(Math.round(number * 100) / 100);
};

export function WarmupPacingButton({
  file,
  onOpen,
}: {
  file: AuthFileItem;
  onOpen: (fileKey: string) => void;
}) {
  const { t } = useTranslation();
  const snapshot = file.account_scheduling?.warmup_traffic_pacing;
  const status = pacingStatus(snapshot);
  const level = pacingBalanceLevel(snapshot);
  const label =
    status === 'active'
      ? `${displayPacingBalance(snapshot?.request_balance)}/${displayNumber(snapshot?.request_capacity)}`
      : t(key(`status_${status}`));
  return (
    <button
      type="button"
      className={styles.entry}
      data-level={level}
      data-testid={`auth-file-pacing-${file.name}`}
      data-auth-file-key={encodeURIComponent(getAuthFileSelectionKey(file))}
      aria-haspopup="dialog"
      aria-label={t(key('open'))}
      title={t(key(status === 'active' ? `balance_${level}` : `status_${status}`))}
      onClick={() => onOpen(getAuthFileSelectionKey(file))}
    >
      {t(key('label'))} {label}
      <span aria-hidden="true">›</span>
    </button>
  );
}

export function WarmupPacingModal({
  file,
  open,
  onClose,
}: {
  file: AuthFileItem | null;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const snapshot = file?.account_scheduling?.warmup_traffic_pacing;
  const status = pacingStatus(snapshot);
  const eligible = Boolean(
    file &&
    resolveAuthProvider(file) === 'claude' &&
    deriveAccountWarmupBadge(file.account_scheduling)
  );
  const active = eligible && status === 'active';
  const badge = file
    ? deriveSubscriptionTierBadge(resolveAuthProvider(file), file.account_scheduling)
    : null;
  const level = pacingBalanceLevel(active ? snapshot : null);
  const balance = active ? pacingNumber(snapshot?.request_balance) : null;
  const capacity = eligible ? pacingNumber(snapshot?.request_capacity) : null;
  const threshold = eligible ? pacingNumber(snapshot?.min_admission_requests) : null;
  const observedAt = snapshot?.observed_at;
  const validObservedAt =
    observedAt && !observedAt.startsWith('0001-') && Number.isFinite(Date.parse(observedAt));
  const reason = PACING_REASONS.find((reason) => reason === snapshot?.reason);
  const blockers =
    active && Array.isArray(snapshot?.blocking_reasons) ? snapshot.blocking_reasons : [];
  const dynamic = (value: unknown) => displayNumber(active ? value : null);
  const metric = (name: string, value: unknown, limit: unknown, hint?: string) => (
    <div className={styles.metric} data-testid={`pacing-${name}`}>
      <dt>{t(key(name))}</dt>
      <dd>
        {dynamic(value)} <span>/ {displayNumber(eligible ? limit : null)}</span>
      </dd>
      {hint && <p>{hint}</p>}
    </div>
  );
  return (
    <Modal
      open={open}
      onClose={onClose}
      width={720}
      title={
        <span className={styles.title}>
          {t(key('title'))}
          {badge && <ClaudeTierBadge badge={badge} />}
        </span>
      }
    >
      <div className={styles.detail} data-testid="warmup-pacing-detail">
        <p className={styles.updated}>
          {t(key('observed_at'))}{' '}
          <time dateTime={validObservedAt ? observedAt : undefined}>
            {validObservedAt ? formatDateTime(observedAt) : t(key('unknown'))}
          </time>{' '}
          · {t(key('snapshot_note'))}
        </p>
        <div className={styles.status} data-level={level} role="status">
          <strong>
            {!eligible
              ? t(key('unavailable'))
              : t(key(status === 'active' ? `balance_${level}` : `status_${status}`))}
          </strong>
          <p>{t(key(reason && eligible ? `reason_${reason}` : 'reason_unknown'))}</p>
        </div>
        <div className={styles.balanceHeading}>
          <div>
            <div>{t(key('balance'))}</div>
            <strong data-testid="pacing-balance">
              {displayPacingBalance(balance)} <span>/ {displayNumber(capacity)}</span>
            </strong>
          </div>
          <div className={styles.refill}>
            {t(key('refill'))}
            <strong>
              {dynamic(snapshot?.refill_per_hour)} {t(key('per_hour'))}
            </strong>
          </div>
        </div>
        {capacity !== null && capacity > 0 && balance !== null && (
          <div
            className={styles.track}
            role="progressbar"
            aria-label={t(key('balance'))}
            aria-valuemin={0}
            aria-valuemax={capacity}
            aria-valuenow={Math.min(capacity, balance)}
          >
            <div
              className={styles.fill}
              data-level={level}
              style={{ width: `${Math.min(100, (balance / capacity) * 100)}%` }}
            />
            {threshold !== null && (
              <span
                className={styles.threshold}
                style={{ left: `${Math.min(100, (threshold / capacity) * 100)}%` }}
              />
            )}
          </div>
        )}
        <div className={styles.scale}>
          <span>
            {t(key('threshold'))}: {displayNumber(threshold)}
          </span>
          <span>
            {t(key('capacity'))}: {displayNumber(capacity)}
          </span>
        </div>
        <p className={styles.eta}>
          {t(key('eta'))}:{' '}
          {active && pacingNumber(snapshot?.admission_balance_eta_seconds) !== null
            ? t(key('seconds'), { count: Math.ceil(snapshot!.admission_balance_eta_seconds!) })
            : t(key('unknown'))}
        </p>
        <h3>{t(key('limits'))}</h3>
        <dl className={styles.metrics}>
          {metric(
            'daily',
            snapshot?.rolling_24h_requests,
            snapshot?.daily_request_budget,
            t(key('daily_note'))
          )}
          {metric('rpm', snapshot?.rolling_60s_requests, snapshot?.rpm_limit)}
          {metric(
            'groups',
            snapshot?.active_binding_groups,
            snapshot?.max_active_binding_groups,
            t(key('idle'), { seconds: displayNumber(snapshot?.active_binding_idle_seconds) })
          )}
          {metric('inflight', snapshot?.inflight, snapshot?.concurrency_limit)}
        </dl>
        <p className={styles.note}>
          {t(key('pending'), { countText: dynamic(snapshot?.pending_requests) })}
        </p>
        <div className={styles.blockers}>
          <strong>{t(key('blockers'))}</strong>
          {blockers.length > 0 ? (
            <ul>
              {[...new Set(blockers)].map((blocker) => (
                <li key={blocker}>
                  {t(
                    key(
                      `blocker_${PACING_BLOCKERS.some((known) => known === blocker) ? blocker : 'unknown'}`
                    )
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p>{t(key(active ? 'no_known_blockers' : 'unknown'))}</p>
          )}
        </div>
        <p className={styles.note}>{t(key('admission_note'))}</p>
      </div>
    </Modal>
  );
}
