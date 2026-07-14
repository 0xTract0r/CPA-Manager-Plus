import { SummaryCard, type SummaryCardProps } from '@/features/monitoring/components/MonitoringShared';
import styles from '../MonitoringCenterPage.module.scss';

type MonitoringSummarySectionProps = {
  primaryCards: SummaryCardProps[];
  secondaryCards: SummaryCardProps[];
  scopeText?: string;
};

export function MonitoringSummarySection({
  primaryCards,
  secondaryCards,
  scopeText,
}: MonitoringSummarySectionProps) {
  const cards = [...primaryCards, ...secondaryCards];

  return (
    <section className={styles.summarySection}>
      {scopeText ? <p className={styles.summaryScopeCaption}>{scopeText}</p> : null}
      <div className={styles.summaryGrid}>
        {cards.map((card) => (
          <SummaryCard key={card.label} {...card} />
        ))}
      </div>
    </section>
  );
}
