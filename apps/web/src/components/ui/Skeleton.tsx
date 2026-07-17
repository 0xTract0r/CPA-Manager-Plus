import type { CSSProperties } from 'react';
import styles from './Skeleton.module.scss';

interface SkeletonProps {
  /** 宽度，number 按 px 处理，也可传 CSS 长度字符串（如 '100%'） */
  width?: number | string;
  /** 高度，number 按 px 处理，也可传 CSS 长度字符串 */
  height?: number | string;
  className?: string;
  /** 是否使用圆角，默认 true */
  rounded?: boolean;
}

/**
 * 首屏占位骨架块：灰色背景 + 轻微 shimmer 动画。
 * 不含任何交互或副作用，仅用于渲染前的布局占位。
 */
export function Skeleton({ width, height, className = '', rounded = true }: SkeletonProps) {
  const style: CSSProperties = {
    width,
    height,
  };

  return (
    <div
      className={`${styles.skeleton}${rounded ? ` ${styles.rounded}` : ''}${className ? ` ${className}` : ''}`}
      style={style}
      aria-hidden="true"
    />
  );
}
