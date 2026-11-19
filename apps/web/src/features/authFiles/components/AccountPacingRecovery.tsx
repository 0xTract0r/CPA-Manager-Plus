import { useTranslation } from 'react-i18next';
import type { AuthFileItem } from '@/types';
import { useWarmupPacing, pacingAccountState } from '../hooks/useWarmupPacing';
import {
  displayPacingBalance,
  pacingNumber,
  pacingStatus,
  pacingBalanceLevel,
} from '../model/warmupPacing';
import styles from './WarmupPacing.module.scss';

/** 实时读数独立于编辑草稿；轮询绝不覆写尚未提交的速度与养号选择。 */
export function AccountPacingRecovery({ file }: { file: AuthFileItem }) {
  const { t } = useTranslation();
  const k = (name: string, options?: Record<string, unknown>) =>
    t('auth_files.pacing.' + name, options);
  const live = useWarmupPacing(file, true);
  const view = live.file?.account_scheduling;
  const snapshot = view?.warmup_traffic_pacing;
  const state = pacingAccountState(live.file);
  const mature = view?.warmup?.mature === true;
  const active =
    !mature &&
    state === 'available' &&
    !live.failed &&
    !live.stale &&
    pacingStatus(snapshot) === 'active';
  const balance = active ? pacingNumber(snapshot?.request_balance) : null;
  const capacity = active ? pacingNumber(snapshot?.request_capacity) : null;
  const threshold = active ? pacingNumber(snapshot?.min_admission_requests) : null;
  const label =
    state !== 'available'
      ? k('account_' + state)
      : mature
        ? k('mature_policy_active')
        : view?.warmup_control?.manual_mature
          ? k('manual_mature_restricted')
          : live.failed
            ? k('refresh_failed')
            : live.stale
              ? k('stale')
              : !active
                ? k('status_' + pacingStatus(snapshot))
                : live.eta === null
                  ? k('countdown_paused')
                  : live.eta === 0
                    ? k(
                        balance !== null && threshold !== null && balance >= threshold
                          ? 'new_balance_confirmed'
                          : 'await_confirmation'
                      )
                    : k('compact_admission_eta', { seconds: live.eta });
  return (
    <div className={styles.recoverySummary} data-testid="account-pacing-recovery" role="status">
      <div>
        <strong>{label}</strong>
        {active && (
          <span>
            {k('balance')} {displayPacingBalance(balance)} / {capacity ?? '—'} ·{' '}
            {k('compact_threshold', { count: threshold ?? '—' })}
          </span>
        )}
      </div>
      {balance !== null && capacity !== null && capacity > 0 && (
        <div
          className={styles.recoveryTrack}
          role="progressbar"
          aria-label={k('balance')}
          aria-valuemin={0}
          aria-valuemax={capacity}
          aria-valuenow={Math.min(balance, capacity)}
        >
          <div
            className={styles.fill}
            data-level={pacingBalanceLevel(snapshot)}
            style={{ width: Math.min(100, (balance / capacity) * 100) + '%' }}
          />
        </div>
      )}
    </div>
  );
}
