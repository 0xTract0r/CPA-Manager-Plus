import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { isDemoMode, prefixRouteBase } from '@/features/demo/demoMode';
import styles from './AccountFastImpactPanel.module.scss';

export interface AccountFastImpactPanelProps {
  accountName?: string | null;
  authIndex?: string | number | null;
  enabled?: boolean;
  onOpenAnalysis?: () => void;
}

export function AccountFastImpactPanel({ authIndex, enabled = true, onOpenAnalysis }: AccountFastImpactPanelProps) {
  const { t } = useTranslation();
  if (!enabled || authIndex == null || !String(authIndex).trim()) return null;
  const params = new URLSearchParams({ tab: 'codexFast' });
  if (authIndex != null && String(authIndex).trim()) params.set('auth_index', String(authIndex));
  // 本地固定样本入口保留采样日期；正式包不会进入此分支。
  if (import.meta.env.DEV && import.meta.env.VITE_FAST_IMPACT_PREVIEW_URL && String(authIndex).startsWith('preview-')) {
    params.set('from_ms', '1789741617856'); params.set('to_ms', '1789743906579');
  }
  const path = isDemoMode() ? prefixRouteBase('/usage-analytics') : '/usage-analytics';
  return (
    <div className={styles.panel} data-testid="account-fast-impact-panel">
      <div><strong>{t('fast_impact.title')}</strong><p>{t('fast_impact.account_hint')}</p></div>
      <Link to={`${path}?${params}`} onClick={onOpenAnalysis}>{t('fast_impact.open_analysis')} →</Link>
    </div>
  );
}
