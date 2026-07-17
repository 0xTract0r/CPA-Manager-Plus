import { Skeleton } from '@/components/ui/Skeleton';
import { UpdatingOverlay } from '@/components/ui/UpdatingOverlay';
import { SummaryCard, type SummaryCardProps } from '@/features/monitoring/components/MonitoringShared';
import styles from '../MonitoringCenterPage.module.scss';

type MonitoringSummarySectionProps = {
  primaryCards: SummaryCardProps[];
  secondaryCards: SummaryCardProps[];
  scopeText?: string;
  /** 有旧数据、正在 refetch：变暗 + 「更新中」遮罩，旧卡片内容保留在原位。 */
  updating?: boolean;
  /** 首屏还没有任何展示快照：渲染骨架占位，而不是渲染空/零值卡片。 */
  firstLoad?: boolean;
};

export function MonitoringSummarySection({
  primaryCards,
  secondaryCards,
  scopeText,
  updating = false,
  firstLoad = false,
}: MonitoringSummarySectionProps) {
  const cards = [...primaryCards, ...secondaryCards];

  return (
    <section className={styles.summarySection}>
      {scopeText ? <p className={styles.summaryScopeCaption}>{scopeText}</p> : null}
      {firstLoad ? (
        <div className={styles.summaryGrid} aria-hidden="true">
          {cards.length > 0
            ? cards.map((card, index) => (
                <Skeleton key={card.label || index} height={112} />
              ))
            : Array.from({ length: 4 }, (_, index) => <Skeleton key={index} height={112} />)}
        </div>
      ) : (
        <UpdatingOverlay active={updating} label="更新中">
          <div className={styles.summaryGrid}>
            {cards.map((card) => (
              <SummaryCard key={card.label} {...card} />
            ))}
          </div>
        </UpdatingOverlay>
      )}
    </section>
  );
}
