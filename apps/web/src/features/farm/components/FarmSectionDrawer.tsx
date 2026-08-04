import { useEffect, useRef, type PropsWithChildren, type ReactNode } from 'react';
import { Modal } from '@/components/ui/Modal';
import styles from './FarmSectionDrawer.module.scss';

export type FarmSection = 'config' | 'alerts' | 'accounts' | 'containers' | 'resources' | 'usage';

interface FarmSectionDrawerProps {
  section: FarmSection;
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  width?: number | string;
}

/**
 * 农场长内容统一右侧抽屉。交互继续复用设计系统 Modal 的滚动锁、ESC、焦点陷阱
 * 与触发点焦点恢复，只在农场范围内覆盖几何和标题关闭入口。
 */
export function FarmSectionDrawer({
  section,
  open,
  title,
  onClose,
  width = 1120,
  children,
}: PropsWithChildren<FarmSectionDrawerProps>) {
  const bodyRef = useRef<HTMLDivElement>(null);

  // Modal 已提供经过验证的关闭按钮、ESC、焦点陷阱与焦点恢复。直接给该按钮补上
  // 农场稳定 testid，而不是再渲染第二个关闭按钮，避免初始焦点落到隐藏控件。
  useEffect(() => {
    if (!open) return;
    const testId = `farm-section-drawer-close-${section}`;
    const closeButton = bodyRef.current
      ?.closest('.modal')
      ?.querySelector<HTMLButtonElement>('.modal-close-floating');
    if (!closeButton) return;
    closeButton.dataset.testid = testId;
    return () => {
      if (closeButton.dataset.testid === testId) delete closeButton.dataset.testid;
    };
  }, [open, section]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={width}
      className={styles.drawer}
      title={title}
    >
      <div
        ref={bodyRef}
        className={styles.body}
        data-testid={`farm-section-drawer-${section}`}
        data-section={section}
      >
        {children}
      </div>
    </Modal>
  );
}
