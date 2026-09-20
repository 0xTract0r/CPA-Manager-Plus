import { useTranslation } from 'react-i18next';
import type { SubscriptionTierBadge } from '../model/accountSessionSummary';
import styles from '../AuthFilesPage.module.scss';

const labels: Record<string, string> = {
  pro: 'Pro',
  max_5x: 'Max 5x',
  max_20x: 'Max 20x',
  unknown: 'Unknown',
};
const paths: Record<string, string> = {
  pro: 'm12 2 2.7 7.3L22 12l-7.3 2.7L12 22l-2.7-7.3L2 12l7.3-2.7Z',
  max_5x: 'm3 8 4-5h10l4 5-9 13ZM3 8h18M7 3l5 18 5-18',
  max_20x: 'm3 6 5 5 4-7 4 7 5-5-2 13H5ZM5 22h14',
};

export function ClaudeTierBadge({
  badge,
  fileName,
}: {
  badge: SubscriptionTierBadge;
  fileName?: string;
}) {
  const { t } = useTranslation();
  const label = t(`auth_files.subscription_tier_badge_${badge.tier}`, {
    defaultValue: labels[badge.tier],
  });
  return (
    <span
      className={`${styles.claudeTierValue} ${badge.known ? styles.claudeTierValueKnown : styles.claudeTierValueUnknown}`}
      data-tier={badge.tier}
      data-testid={fileName ? `auth-file-tier-badge-${fileName}` : undefined}
      title={t('auth_files.subscription_tier_badge_title', {
        tier: label,
        defaultValue: 'Subscription tier: {{tier}}',
      })}
    >
      {paths[badge.tier] && (
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d={paths[badge.tier]} />
        </svg>
      )}
      {label}
    </span>
  );
}
