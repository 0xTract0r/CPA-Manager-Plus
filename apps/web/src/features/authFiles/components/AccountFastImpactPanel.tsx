import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { isDemoMode, prefixRouteBase } from '@/features/demo/demoMode';
import styles from './AccountFastImpactPanel.module.scss';

export interface AccountFastImpactPanelProps {
  accountName?: string | null;
  authIndex?: string | number | null;
  enabled?: boolean;
}

export function AccountFastImpactPanel({ authIndex, enabled = true }: AccountFastImpactPanelProps) {
  const { t } = useTranslation();
  if (!enabled) return null;
  const params = new URLSearchParams({ tab: 'performance', view: 'fast', provider: 'codex' });
  if (authIndex != null && String(authIndex).trim()) params.set('auth_index', String(authIndex));
  const path = isDemoMode() ? prefixRouteBase('/usage-analytics') : '/usage-analytics';
  return (
    <div className={styles.panel} data-testid="account-fast-impact-panel">
      <strong>{t('fast_impact.title')}</strong>
      <p>{t('fast_impact.account_hint')}</p>
      <Link to={`${path}?${params}`}>{t('fast_impact.open_analysis')}</Link>
    </div>
  );
}
