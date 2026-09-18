import type { TFunction } from 'i18next';
import type { MonitoringEventRow } from '@/features/monitoring/hooks/useMonitoringData';
import type { AccountDisplayMode } from '@/features/monitoring/accountOverviewState';
import { isGenericMonitoringProviderLabel } from '@/features/monitoring/model/sourceDisplay';
import { maskAccountEmail, readEmailLike } from '@/utils/accountIdentity';

const hasReadableRealtimeValue = (value: string | null | undefined) => {
  const trimmed = String(value || '').trim();
  return Boolean(trimmed) && trimmed !== '-';
};

const firstReadable = (...values: Array<string | null | undefined>) =>
  values.find(hasReadableRealtimeValue)?.trim() || '';

export const buildRealtimeSourceDisplay = (
  row: Pick<
    MonitoringEventRow,
    | 'account'
    | 'accountMasked'
    | 'accountNote'
    | 'authLabel'
    | 'channel'
    | 'channelHost'
    | 'provider'
    | 'source'
    | 'sourceMasked'
  >,
  t: TFunction,
  accountDisplayMode: AccountDisplayMode = 'masked'
) => {
  const channel = hasReadableRealtimeValue(row.channel) ? row.channel.trim() : '';
  const provider = hasReadableRealtimeValue(row.provider) ? row.provider.trim() : '';
  const host = hasReadableRealtimeValue(row.channelHost) ? row.channelHost.trim() : '';
  const note = hasReadableRealtimeValue(row.accountNote) ? row.accountNote!.trim() : '';
  const fullAccount = firstReadable(row.account, row.authLabel, row.accountMasked);
  const maskedAccount = firstReadable(row.accountMasked, row.authLabel, row.account);
  const accountEmail = readEmailLike(fullAccount);
  const accountEmailMasked = accountEmail
    ? firstReadable(
        readEmailLike(maskedAccount) ? '' : maskedAccount,
        maskAccountEmail(accountEmail)
      )
    : '';
  const account = accountDisplayMode === 'full' ? fullAccount : maskedAccount;
  const fullSource = firstReadable(row.source, row.account, row.authLabel, row.sourceMasked);
  const maskedSource = firstReadable(
    row.sourceMasked,
    row.accountMasked,
    row.authLabel,
    row.source
  );
  const source = accountDisplayMode === 'full' ? fullSource : maskedSource;
  const primary =
    firstReadable(
      note,
      channel && !isGenericMonitoringProviderLabel(channel) ? channel : '',
      host,
      source,
      provider && !isGenericMonitoringProviderLabel(provider) ? provider : '',
      account || '',
      channel,
      provider
    ) || '-';
  const sourceEmail = readEmailLike(fullSource);
  const primaryRepresentsAccountEmail = Boolean(
    accountEmail &&
    ((sourceEmail &&
      sourceEmail.toLowerCase() === accountEmail.toLowerCase() &&
      primary === source) ||
      primary === account ||
      primary === fullAccount ||
      primary === maskedAccount)
  );
  const metaCandidate = [
    { value: provider, label: t('monitoring.filter_provider') },
    { value: host, label: t('monitoring.column_host') },
    { value: accountEmail ? '' : account, label: '' },
    { value: source, label: t('monitoring.source') },
  ].find((candidate) => candidate.value && candidate.value !== primary);
  const meta =
    metaCandidate && metaCandidate.label
      ? `${metaCandidate.label}: ${metaCandidate.value}`
      : metaCandidate?.value || '';
  const title = Array.from(
    new Set(
      [primary, meta, fullSource, maskedSource, fullAccount, maskedAccount, host, provider].filter(
        hasReadableRealtimeValue
      )
    )
  ).join(' · ');

  return {
    primary,
    meta,
    title,
    accountEmail: primaryRepresentsAccountEmail ? '' : accountEmail,
    accountEmailMasked,
  };
};
