import type { ReactElement } from 'react';
import {
  IconKey,
  IconShield,
  IconCheckCircle2,
  IconX,
  IconEyeOff,
  IconInfo,
  type IconProps,
} from './icons';
import type { FarmAccountAuthState } from '@/features/farm/utils/health';
import type { HealthPillStatus } from './HealthPill';
import styles from './AccountAuthBadge.module.scss';

/**
 * 账号认证态徽标（P2-C1「双平面视觉分离」·身份平面）。
 *
 * 与容器运行态徽标（<ContainerRuntimeBadge>）在**形状 / 图标 / 排版**三个维度
 * 都刻意做区分，让 operator 一眼分清「这是账号身份认证态」而非「容器运行态」：
 *   - 形状：证件/盾牌质感——方角卡片（radius-sm）+ 左侧 3px 语义色实心竖条
 *     （像一张 ID 卡的色标），不是运行态那种全圆胶囊。
 *   - 图标：认证语义图标族（盾/证件/钥匙/停用），不是运行态的实心运行点。
 *   - 排版：字母加宽（letter-spacing）+ 稍强字重，呈现「凭证标签」观感。
 *
 * 底层色仍复用 --health-ok/warn/err/idle 四态 token（不扩 a11y 债、不新造色）。
 * 语义由「图标 + 语义色 + 可见文案」三重编码；dimension 并入 aria-label 供脱离
 * 列头单独朗读时仍带维度信息。
 */

/** 账号认证态 5 态 → 领头认证图标（图标即身份语义标识，取代文字前缀）。 */
const AUTH_STATE_ICON: Record<FarmAccountAuthState, (props: IconProps) => ReactElement> = {
  healthy: IconShield,
  needs_reauth: IconKey,
  auto_quarantined: IconX,
  operator_disabled: IconEyeOff,
  unknown: IconInfo,
};

// healthy 态额外叠一个 check 语义（盾 + 勾）在最右，强化「已认证通过」，其余态
// 只用领头图标即可。用 Record 保持穷尽，非 healthy 一律 null。
const AUTH_STATE_TRAILING_ICON: Record<
  FarmAccountAuthState,
  ((props: IconProps) => ReactElement) | null
> = {
  healthy: IconCheckCircle2,
  needs_reauth: null,
  auto_quarantined: null,
  operator_disabled: null,
  unknown: null,
};

export interface AccountAuthBadgeProps {
  /** 5 态之一，决定领头图标 + 排版语义。 */
  state: FarmAccountAuthState;
  /** 语义色四态（从 accountAuthStateToFarmHealthVariant 得到），决定色标与文字色。 */
  status: HealthPillStatus;
  /** 已翻译好的短文案（如「已认证」「需重新认证」）。 */
  label: string;
  /** 维度标识（如「账号认证态」），并入 aria-label，不占可见空间。 */
  dimension?: string;
  /** 详情原因（如具体 authReason），进原生 title tooltip。 */
  reason?: string;
  className?: string;
  'data-testid'?: string;
}

export function AccountAuthBadge({
  state,
  status,
  label,
  dimension,
  reason,
  className,
  'data-testid': testId,
}: AccountAuthBadgeProps) {
  const LeadIcon = AUTH_STATE_ICON[state];
  const TrailIcon = AUTH_STATE_TRAILING_ICON[state];
  const classes = [styles.badge, styles[status], className ?? ''].filter(Boolean).join(' ');
  const ariaLabel = dimension ? `${dimension}: ${label}` : undefined;

  return (
    <span
      className={classes}
      data-status={status}
      data-auth-state={state}
      data-testid={testId}
      title={reason || undefined}
      aria-label={ariaLabel}
    >
      <span className={styles.accent} aria-hidden="true" />
      <LeadIcon size={14} className={styles.icon} aria-hidden="true" />
      <span className={styles.label}>{label}</span>
      {TrailIcon ? <TrailIcon size={13} className={styles.trailIcon} aria-hidden="true" /> : null}
    </span>
  );
}
