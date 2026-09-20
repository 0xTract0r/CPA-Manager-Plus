import type { AuthFileWarmupTrafficPacing } from '@/types';

export const pacingNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

export const pacingStatus = (snapshot?: AuthFileWarmupTrafficPacing | null) =>
  snapshot &&
  ['active', 'disabled', 'uninitialized', 'error', 'not_applicable'].includes(snapshot.status)
    ? snapshot.status
    : 'unknown';

export function pacingBalanceLevel(snapshot?: AuthFileWarmupTrafficPacing | null) {
  if (pacingStatus(snapshot) !== 'active') return 'unknown';
  const balance = pacingNumber(snapshot?.request_balance);
  const threshold = pacingNumber(snapshot?.min_admission_requests);
  if (balance === null) return 'unknown';
  if (balance < 1) return 'empty';
  if (threshold === null) return 'unknown';
  return balance < threshold ? 'low' : 'ready';
}

export const PACING_REASONS = [
  'observed',
  'config_disabled',
  'policy_disabled',
  'home_mode',
  'non_adaptive',
  'account_ineligible',
  'mature',
  'ledger_missing',
  'manager_unavailable',
  'state_unavailable',
  'invalid_state',
  'invalid_clock',
] as const;
export const PACING_BLOCKERS = [
  'request_balance',
  'daily_budget',
  'rpm',
  'active_groups',
  'concurrency',
  'unknown_token_history',
  'token_budget',
] as const;

/** 余额向下保留两位，避免展示数值先于实际余额跨过接入门槛。 */
export const displayPacingBalance = (value: unknown): string => {
  const number = pacingNumber(value);
  if (number === null) return '—';
  // 十进制移位避免 2.55 * 100 的二进制误差被截成 2.54。
  const [coefficient, exponent = '0'] = String(number).split('e');
  const shifted = Number(`${coefficient}e${Number(exponent) + 2}`);
  return String(Number.isFinite(shifted) ? Math.floor(shifted) / 100 : number);
};
