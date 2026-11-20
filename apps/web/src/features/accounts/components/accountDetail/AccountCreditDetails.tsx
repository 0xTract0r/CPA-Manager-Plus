import { useState } from 'react';
import { useInterval } from '@/hooks/useInterval';
import { useTranslation } from 'react-i18next';
import { renderCodexCreditsBalance, renderCodexCreditsBurn } from '@/components/quota/quotaConfigs';
import {
  useCodexCreditsHistoryLookup,
  withCodexCreditsHistory,
} from '@/features/authFiles/hooks/useCodexCreditsHistoryLookup';
import type { AuthFileItem, CodexQuotaState } from '@/types';
import creditStyles from '@/features/authFiles/AuthFilesPage.module.scss';
import styles from '@/features/accounts/AccountsPage.module.scss';

interface Props {
  file: AuthFileItem;
  quota: CodexQuotaState;
  managerServiceBase: string;
  managementKey: string;
  historyAfterMs: number;
}

export function AccountCreditDetails({
  file, quota, managerServiceBase, managementKey, historyAfterMs,
}: Props) {
  const { t } = useTranslation();
  const lookup = useCodexCreditsHistoryLookup(managerServiceBase, managementKey);
  const evidence = withCodexCreditsHistory(quota, lookup, file, historyAfterMs) ?? quota;
  const [nowMs, setNowMs] = useState(() => Date.now());
  useInterval(() => setNowMs(Date.now()), 60_000);
  return (
    <section className={styles.quotaSummaryPanel} aria-label={t('codex_quota.credits_balance_label')}>
      {renderCodexCreditsBalance(evidence, evidence.windows, t, creditStyles)}
      {renderCodexCreditsBurn(evidence, evidence.windows, t, creditStyles, nowMs)}
    </section>
  );
}
