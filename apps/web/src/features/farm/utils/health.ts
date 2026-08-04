/**
 * 农场健康语义色 + 阈值单一真源（telemetry-farm-observability P0-7 决策6
 * 「前端基建」）。此前 90/70 阈值只在 FarmResourcePanel.pctVariant 本地硬编码
 * 一处；这里收敛成共享常量，供 <HealthPill>（P0-8 起接入）与既有
 * status-badge 着色路径（FarmResourcePanel 资源水位）共用同一套判定，避免
 * 未来新增面板各自重定义一份阈值导致口径漂移。
 *
 * 语义色本身（--health-ok/warn/err/idle）已提升为 themes.scss CSS 自定义
 * 属性，供 <HealthPill> 直接消费；此文件只承载"数值 -> 四态"的判定逻辑与
 * 到既有 status-badge className（success/warning/error/muted）的桥接，避免
 * CSS token 里再重复放运行时用不上的纯数字阈值。
 */

import type { FarmAccountStateView } from '@/types/farm';

/** 与 --health-ok/warn/err/idle 一一对应的健康四态。 */
export type FarmHealthVariant = 'ok' | 'warn' | 'err' | 'idle';

/** 资源水位分级阈值：>=90% 视为紧急（err），>=70% 视为需要关注（warn）。 */
export const FARM_HEALTH_PCT_ERR_THRESHOLD = 90;
export const FARM_HEALTH_PCT_WARN_THRESHOLD = 70;

/** 数值型水位（如 CPU/内存百分比）按阈值映射到健康四态。 */
export function pctToFarmHealthVariant(pct: number | undefined): FarmHealthVariant {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return 'idle';
  if (pct >= FARM_HEALTH_PCT_ERR_THRESHOLD) return 'err';
  if (pct >= FARM_HEALTH_PCT_WARN_THRESHOLD) return 'warn';
  return 'ok';
}

/**
 * 24h keepalive 成功率阈值（P0-9 表格增强列）。与资源水位阈值方向相反——
 * 成功率越高越好，不能直接复用 pctToFarmHealthVariant（那是「越高越差」的
 * 资源占用语义）。>=95% 健康、>=80% 需要关注、否则紧急；无样本回退 idle
 * （既不是"健康"也不是"故障"，是"没数据"）。
 */
export const FARM_SUCCESS_RATE_ERR_THRESHOLD = 0.8;
export const FARM_SUCCESS_RATE_WARN_THRESHOLD = 0.95;

export function successRateToFarmHealthVariant(rate: number | undefined): FarmHealthVariant {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return 'idle';
  if (rate < FARM_SUCCESS_RATE_ERR_THRESHOLD) return 'err';
  if (rate < FARM_SUCCESS_RATE_WARN_THRESHOLD) return 'warn';
  return 'ok';
}

/**
 * health_reason 字面值 → 健康四态（供 <HealthPill> 消费，design.md 决策4
 * 「P0-1 假降级修复：health_reason 明示」）。字面值来源见
 * services/farm-orchestrator/internal/httpapi/observability.go
 * computeHealthReason/knownFiringReasonsPriority 与 containerView.Status 本身
 * （某些 reason 探测不到时诚实回退到 status 字面值，见该文件注释）。
 *
 * - ok：健康。
 * - keepalive_stale_ok：P0-1 附带发现——最近保活全成功但已超过
 *   MaxKeepaliveInterval，是「陈旧但仍健康」的软信号，故意映射 warn 而非
 *   ok/err，提醒 operator 关注但不误判为故障。
 * - keepalive_recent_failures / keepalive_stale / no_keepalive_data：
 *   degraded 的具体成因，映射 warn（已经在 degraded 状态列本身标了警示色，
 *   这里是"为什么"而非"多严重"）。
 * - container_exited_or_missing：down 的成因，映射 err。
 * - not_started / container_transient_state / retired /
 *   docker_missing_orphaned：非故障的生命周期占位态，映射 idle。
 * - account_state_unknown / account_state_stale / account_state_not_wired
 *   （FO2「假绿修复：健康两平面」CombineHealth 收敛结果，farmrunner/
 *   health.go CombineHealthReason* 常量）：账号认证态平面 unknown/not_wired
 *   时，容器运行态原判 running 会被 fail-closed 封顶为 degraded，这三个
 *   reason 就是「为什么被封顶」——与 keepalive_* 系列同属「degraded 的具体
 *   成因」，同样映射 warn（本列已经是 degraded 状态色，这里只是解释原因）。
 * - 其余未知值（含 computeHealthReason 探测不到时回退的 status 字面值，如
 *   直接是 'degraded'/'down'）按字面值本身兜底判断，避免整列失去信号。
 */
const HEALTH_REASON_VARIANT: Record<string, FarmHealthVariant> = {
  ok: 'ok',
  keepalive_stale_ok: 'warn',
  keepalive_recent_failures: 'warn',
  keepalive_stale: 'warn',
  no_keepalive_data: 'warn',
  container_exited_or_missing: 'err',
  not_started: 'idle',
  container_transient_state: 'idle',
  retired: 'idle',
  docker_missing_orphaned: 'idle',
  account_state_unknown: 'warn',
  account_state_stale: 'warn',
  account_state_not_wired: 'warn',
};

/**
 * device_id 对齐（容器→账号方向：container_synced/drift/unknown，见
 * types/farm.ts FarmContainerView.device_id_alignment 注释）→ status-badge
 * className。供 FarmContainerTable（表格列）与 FarmContainerDetail（详情卡）
 * 共用同一份映射，不各自重复内联三元表达式。
 */
const DEVICE_ALIGNMENT_BADGE_VARIANT: Record<string, StatusBadgeVariant> = {
  container_synced: 'success',
  drift: 'warning',
  unknown: 'muted',
};

export function deviceAlignmentToBadgeVariant(alignment: string | undefined): StatusBadgeVariant {
  if (!alignment) return 'muted';
  return DEVICE_ALIGNMENT_BADGE_VARIANT[alignment] ?? 'muted';
}

export function healthReasonToFarmHealthVariant(reason: string | undefined): FarmHealthVariant {
  if (!reason) return 'idle';
  if (reason in HEALTH_REASON_VARIANT) return HEALTH_REASON_VARIANT[reason];
  // 回退：探测不到具体 reason 时 computeHealthReason 会直接给 status 字面值
  // （如 'degraded'/'down'），status 本身也可能被当作 reason 传进来。
  if (reason === 'down') return 'err';
  if (reason === 'degraded' || reason === 'orphaned') return 'warn';
  return 'idle';
}

/** 既有 status-badge 全局样式只认 success/warning/error/muted 四个 className。 */
export type StatusBadgeVariant = 'success' | 'warning' | 'error' | 'muted';

const HEALTH_TO_BADGE_VARIANT: Record<FarmHealthVariant, StatusBadgeVariant> = {
  ok: 'success',
  warn: 'warning',
  err: 'error',
  idle: 'muted',
};

export function farmHealthVariantToBadgeVariant(variant: FarmHealthVariant): StatusBadgeVariant {
  return HEALTH_TO_BADGE_VARIANT[variant];
}

// 注：FarmHealthVariant 与 <HealthPill> 的 HealthPillStatus 字面量集合逐字相同
// （'ok'|'warn'|'err'|'idle'），FarmContainerTable/FarmContainerDetail（P0-9）
// 可以直接把 FarmHealthVariant 值传给 HealthPill 的 status prop，不需要额外的
// 类型断言或桥接函数。

/** 数值水位直接映射到既有 status-badge className，桥接旧调用点（不改变视觉输出）。 */
export function pctToFarmHealthBadgeVariant(pct: number | undefined): StatusBadgeVariant {
  return farmHealthVariantToBadgeVariant(pctToFarmHealthVariant(pct));
}

// ---------------------------------------------------------------------------
// P7「状态栏两维徽标」：账号认证态平面（用户②）
// ---------------------------------------------------------------------------

/**
 * 账号态快照陈旧门槛，对齐后端 farmrunner.AccountStateStaleThreshold（3×
 * DefaultAccountStatePollInterval=3×5min=15min，见 services/farm-orchestrator/
 * internal/farmrunner/health.go）。前端只用它给 GET /api/farm/account-state
 * 的 observed_at 补「陈旧标记」；账号认证态本身的 alive/dead/unknown 判定
 * 优先信 FarmContainerView.account_auth_status（后端已经用同一个门槛算好，
 * 见 decideAccountAuthPlane 顶部注释），这里独立维护一份只是为了在前端也能
 * 展示「这条快照是否还新鲜」，两处判断口径必须保持一致，未来后端阈值调整需
 * 手工同步到这里。
 */
export const ACCOUNT_STATE_STALE_THRESHOLD_MS = 15 * 60 * 1000;

/** 账号认证态平面判定结果三态，逐字对应 farmrunner.AccountAuth* 常量。 */
export type FarmAccountAuthStatus = 'alive' | 'dead' | 'unknown';

/** 账号认证态平面 dead 时的具体原因，逐字对应 farmrunner.AccountAuthReason* 常量。 */
export const FARM_ACCOUNT_AUTH_REASONS = [
  'account_disabled',
  'account_auto_quarantined',
  'account_token_dead',
] as const;
export type FarmAccountAuthReason = (typeof FARM_ACCOUNT_AUTH_REASONS)[number];

/** account_auth_status 字面值 → HealthPill 四态：alive→ok、dead→err。
 * unknown（含未绑定、从未采集、账号态存储未装配等一切"无法确认"的情形）→
 * idle——design.md P7 决策「账号态 unknown 显示 unknown，既不默认绿也不默认
 * 红」，idle 是本设计系统里唯一"中性、非健康非故障"的语义色，不能借用 warn
 * （warn 意味着"已确认需要关注"，unknown 是"根本不知道"，两者不是同一件事）。 */
export function accountAuthStatusToHealthPillStatus(
  status: string | undefined
): FarmHealthVariant {
  if (status === 'alive') return 'ok';
  if (status === 'dead') return 'err';
  return 'idle';
}

/**
 * 用绑定表 account_id 的三种形态兜底查找该账号的认证态快照（原形/去 .json
 * 后缀/补 .json 后缀），对齐后端 farmrunner.AccountStateIndex.Lookup 同款
 * 兜底思路（两处独立实现，任一方修改匹配逻辑需要手工同步到另一处，见后端
 * 该函数文档同款取舍说明）。
 */
export function findAccountStateForAccount(
  states: FarmAccountStateView[],
  accountID: string
): FarmAccountStateView | undefined {
  const base = accountID.endsWith('.json') ? accountID.slice(0, -'.json'.length) : accountID;
  const candidates = [accountID, base, `${base}.json`];
  for (const candidate of candidates) {
    const found = states.find((s) => s.account_id === candidate);
    if (found) return found;
  }
  return undefined;
}

/** observed_at 是否已超过陈旧门槛（含缺失快照——缺失同样视为"不可信"）。 */
export function isAccountStateStale(
  observedAt: string | undefined,
  now: Date = new Date()
): boolean {
  if (!observedAt) return true;
  const observedMs = new Date(observedAt).getTime();
  if (!Number.isFinite(observedMs)) return true;
  return now.getTime() - observedMs > ACCOUNT_STATE_STALE_THRESHOLD_MS;
}
