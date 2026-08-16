import type { ReactElement } from 'react';
import { IconAlertTriangle, IconCheckCircle2, IconTimer, IconX, type IconProps } from './icons';
import styles from './HealthPill.module.scss';

/**
 * 农场健康维度四态，一一对应 themes.scss 的 --health-ok/warn/err/idle token
 * （design.md 决策6）。ok=健康、warn=需要关注、err=故障/紧急、idle=中性/
 * 未知（如 disabled、无数据），不是"异常"。
 */
export type HealthPillStatus = 'ok' | 'warn' | 'err' | 'idle';

const STATUS_ICON: Record<HealthPillStatus, (props: IconProps) => ReactElement> = {
  ok: IconCheckCircle2,
  warn: IconAlertTriangle,
  err: IconX,
  idle: IconTimer,
};

export interface HealthPillProps {
  /** 四态之一，决定图标 + 语义色（--health-ok/warn/err/idle）。 */
  status: HealthPillStatus;
  /** 已翻译好的短文案（如"运行中"/"降级"/"离线"），可见展示，与图标+色一起构成 a11y 三重编码。 */
  label: string;
  /**
   * 维度标识（如"账号健康"/"容器健康"）。design.md 决策6："图标即维度标识，
   * 取代文字前缀"——正常情况下维度由外部上下文（如表格列头）承载，不在
   * pill 内重复可见展示；但 pill 脱离该上下文单独朗读时（屏幕阅读器/无
   * 列头场景），仍需要维度信息，因此并入 aria-label（"账号健康: 运行中"）
   * 而不占用可见空间，不与图标视觉设计冲突。
   */
  dimension?: string;
  /** 不对称提示/详情原因（如 health_reason），进 tooltip；用原生 title 承载，当前设计系统未提供独立 Tooltip 组件。 */
  reason?: string;
  className?: string;
  'data-testid'?: string;
}

/**
 * 状态徽标：16px 图标 + 短文案 + 语义色。供 P0-8 状态栏双列（账号健康 /
 * 容器健康两列）消费；本切片只交付组件本身与占位测试，接入点留给 P0-8。
 */
export function HealthPill({
  status,
  label,
  dimension,
  reason,
  className,
  'data-testid': testId,
}: HealthPillProps) {
  const Icon = STATUS_ICON[status];
  const classes = [styles.pill, styles[status], className ?? ''].filter(Boolean).join(' ');
  const ariaLabel = dimension ? `${dimension}: ${label}` : undefined;

  return (
    <span
      className={classes}
      data-status={status}
      data-testid={testId}
      title={reason || undefined}
      aria-label={ariaLabel}
    >
      <Icon size={16} />
      <span className={styles.label}>{label}</span>
    </span>
  );
}
