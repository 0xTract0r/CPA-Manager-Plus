import type { PropsWithChildren, ReactNode } from 'react';
import { LoadingSpinner } from './LoadingSpinner';
import styles from './UpdatingOverlay.module.scss';

interface UpdatingOverlayProps {
  /** 是否处于更新中：true 时遮罩 children 并叠加 spinner + 文案 */
  active: boolean;
  /** 遮罩面板文案，默认「更新中」 */
  label?: ReactNode;
  className?: string;
}

/**
 * 包裹型 loading 遮罩：保留 children 原有布局尺寸，
 * active 时把 children 变暗（不可交互）并居中叠加一个小面板（spinner + 文案）。
 * active=false 时只渲染 children，不产生任何额外 DOM/布局影响。
 */
export function UpdatingOverlay({
  active,
  label = '更新中',
  className = '',
  children,
}: PropsWithChildren<UpdatingOverlayProps>) {
  if (!active) {
    return <>{children}</>;
  }

  return (
    <div className={`${styles.root}${className ? ` ${className}` : ''}`}>
      <div className={styles.content} aria-hidden="true">
        {children}
      </div>
      <div className={styles.panel} role="status" aria-live="polite">
        <LoadingSpinner size={20} />
        <span className={styles.label}>{label}</span>
      </div>
    </div>
  );
}
