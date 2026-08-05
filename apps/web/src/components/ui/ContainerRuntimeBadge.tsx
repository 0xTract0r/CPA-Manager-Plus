import type { FarmContainerLifecycle } from '@/features/farm/utils/health';
import type { HealthPillStatus } from './HealthPill';
import styles from './ContainerRuntimeBadge.module.scss';

/**
 * 容器运行态徽标（P2-C1「双平面视觉分离」·运行时平面）。
 *
 * 与账号认证态徽标（<AccountAuthBadge>）在**形状 / 图标 / 排版**三个维度都刻意
 * 区分，让 operator 一眼分清「这是容器运行时态」而非「账号身份态」：
 *   - 形状：全圆胶囊（radius-full），不是身份平面那种方角证件卡。
 *   - 图标：领头是一个运行态「点」（实心/脉冲/空心环/停用叉），运行时监控语义，
 *     不是身份平面的盾/钥匙认证图标。
 *   - 排版：常规字重、无加宽字距，呈现「运行状态胶囊」观感。
 *
 * P2-C3：点样式随生命周期分类（running/pending/degraded/down/retired/ghost/
 * unbound）区分——pending 脉冲、retired 空心归档、ghost 空心警示环、down 实心叉，
 * 把此前被压成同一个 idle 灰点的「供给中/已退役/幽灵态」在视觉上分开。
 *
 * 底层色仍复用 --health-ok/warn/err/idle 四态 token，不新造色、不扩 a11y 债；
 * 点是纯装饰（aria-hidden），语义由可见文案 + 语义色承载，dimension 并入 aria-label。
 */

export interface ContainerRuntimeBadgeProps {
  /** 生命周期分类（从 classifyContainerLifecycle 得到），决定运行态点样式。 */
  lifecycle: FarmContainerLifecycle;
  /** 语义色四态（从 containerLifecycleToFarmHealthVariant 得到）。 */
  status: HealthPillStatus;
  /** 已翻译好的短文案（如「运行中」「幽灵态」）。 */
  label: string;
  /** 维度标识（如「容器运行态」），并入 aria-label。 */
  dimension?: string;
  /** 详情原因（如具体 health_reason），进原生 title tooltip。 */
  reason?: string;
  className?: string;
  'data-testid'?: string;
}

export function ContainerRuntimeBadge({
  lifecycle,
  status,
  label,
  dimension,
  reason,
  className,
  'data-testid': testId,
}: ContainerRuntimeBadgeProps) {
  const classes = [styles.badge, styles[status], className ?? ''].filter(Boolean).join(' ');
  const dotClasses = [styles.dot, styles[`dot_${lifecycle}`]].filter(Boolean).join(' ');
  const ariaLabel = dimension ? `${dimension}: ${label}` : undefined;

  return (
    <span
      className={classes}
      data-status={status}
      data-lifecycle={lifecycle}
      data-testid={testId}
      title={reason || undefined}
      aria-label={ariaLabel}
    >
      <span className={dotClasses} aria-hidden="true" />
      <span className={styles.label}>{label}</span>
    </span>
  );
}
