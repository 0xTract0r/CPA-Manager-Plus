import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { IconChevronLeft, type IconProps } from '@/components/ui/icons';
import type { FarmSection } from './FarmSectionDrawer';
import styles from './FarmOperationCard.module.scss';

interface FarmOperationCardProps {
  section: Exclude<FarmSection, 'config' | 'alerts'>;
  icon: (props: IconProps) => ReactElement;
  title: string;
  description: string;
  expanded: boolean;
  onOpen: () => void;
}

/** 整张卡都是一个具名按钮，避免“看起来可点但实际是假入口”。 */
export function FarmOperationCard({
  section,
  icon: Icon,
  title,
  description,
  expanded,
  onOpen,
}: FarmOperationCardProps) {
  const { t } = useTranslation();

  return (
    <button
      type="button"
      className={styles.card}
      onClick={onOpen}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      data-testid={`farm-${section}-trigger`}
    >
      <span className={styles.icon} aria-hidden="true">
        <Icon size={22} />
      </span>
      <span className={styles.copy}>
        <span className={styles.title}>{title}</span>
        <span className={styles.description}>{description}</span>
      </span>
      <span className={styles.action}>
        {t('farm.ia.openSection')}
        <IconChevronLeft size={16} aria-hidden="true" />
      </span>
    </button>
  );
}
