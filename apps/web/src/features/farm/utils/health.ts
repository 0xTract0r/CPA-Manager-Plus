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

import {
  FARM_ONWIRE_CONSISTENCY_STATES,
  FARM_TELEMETRY_ALIVE_STATES,
  FARM_TELEMETRY_SILENCE_STATES,
  type FarmAccountStateView,
  type FarmOnwireConsistencyState,
  type FarmTelemetryAliveState,
  type FarmTelemetrySilenceState,
} from '@/types/farm';

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

// ---------------------------------------------------------------------------
// P2-C2「账号态 5 态」：把后端已判定好的 account_auth_status（alive/dead/
// unknown）+ dead 具体原因（account_auth_reason）+ 账号自带权威布尔
// （auto_quarantined/disabled/reauth_url）折算成前端展示用的 5 态。
//
// **不在前端重算健康判定**：token 是否存活这件事一律信后端 account_auth_status，
// 前端从不自己判 token 活死。这里只做「展示态」派生——把后端 dead 态里被
// 归并的三个终态原因拆开、并对未绑定/未知账号回退读账号自带的权威布尔
// （auto_quarantined 是 core 侧隔离判定的唯一权威字段，disabled 是 operator
// 主动关闭的直接事实，reauth_url 由后端派生），据此给出更精确的可读态。
// ---------------------------------------------------------------------------

/**
 * 账号认证态 7 态（design.md P2 用户点2 + 点4「未绑定容器=异常态」，另加冷启动
 * 过渡态 initializing）：
 * - healthy：已认证健康（后端 account_auth_status='alive'）**且已绑定容器**——
 *   用户拍板：只有「绑定 + 健康」才算正常。
 * - initializing：**农场新号冷启动过渡态**（映射 idle 中性）。新号刚 onboard 时
 *   出口住宅代理/上游未热，头几个探测可能撞瞬时 401/403，让 core 短暂点亮 reauth
 *   信号（reauth_url / account_token_dead / 短暂 auto_quarantine）；~1-2min 首个
 *   真实请求成功即自愈。deriveAccountAuthState 在 FARM_ONBOARD_REAUTH_GRACE_MS
 *   宽限窗内把 reauth 家族态（needs_reauth / auto_quarantined）折叠成本态，避免把
 *   自愈型瞬态误显成红「凭证已失效」。**只压刚 onboard <~2min 的号**，超窗如实透红
 *   （真失效跨多次探测持续存在，短宽限窗放过它不误伤——新号刚 auth 完头 2min 真
 *   失效概率≈0）。这是纯显示层过渡态，不改任何后端 auth 判定。
 * - needs_reauth：需重新认证（凭证失效可恢复，dead+account_token_dead 或有
 *   reauth_url）。**可恢复态，映射 warn 而非 err**——它需要人处理但不是终态。
 * - auto_quarantined：已自动隔离（core 终态认证失败触发，auto_quarantined 布尔
 *   优先，映射 err 终态）。
 * - operator_disabled：operator 主动停用（disabled 布尔，映射 idle 中性——是
 *   人为意图关闭，不是故障）。
 * - unprovisioned：**未绑定容器的 Claude 账号**（farm_bound=false 且 provider=
 *   claude）。用户拍板「未绑定 = 异常态，不算正常」——账号没有容器就无法从住宅
 *   代理出站，语义是「未绑定·不可出站」，映射 err（不可用），不再回退成
 *   healthy/unknown 假绿/中性。
 * - unknown：未知/陈旧（后端 unknown 且账号无隔离/停用/reauth/未绑定信号，映射
 *   idle 中性——「根本不知道」既非健康也非故障，不默认绿也不默认红）。
 */
export const FARM_ACCOUNT_AUTH_STATES = [
  'healthy',
  'initializing',
  'needs_reauth',
  'auto_quarantined',
  'operator_disabled',
  'unprovisioned',
  'unknown',
] as const;
export type FarmAccountAuthState = (typeof FARM_ACCOUNT_AUTH_STATES)[number];

export interface AccountAuthStateInput {
  /** 后端两平面判定结果（仅已绑定账号有），alive/dead/unknown。 */
  authStatus?: string;
  /** dead 态具体原因（account_disabled/account_auto_quarantined/account_token_dead）。 */
  authReason?: string;
  /** core 隔离判定唯一权威字段。 */
  autoQuarantined?: boolean;
  /** operator 主动停用（account.disabled 或 status='disabled' 皆可）。 */
  disabled?: boolean;
  /** 后端派生的重新授权入口是否存在（存在即代表可/需重新授权）。 */
  hasReauthUrl?: boolean;
  /**
   * 该账号是否已绑定农场容器（契约字段 farm_bound）。仅当显式传入 false 时才
   * 触发 unprovisioned 判定；缺省（undefined）时防御式回退旧行为（不臆造未绑定），
   * 保证后端 AG1 尚未下发该字段的过渡期不误标。
   */
  farmBound?: boolean;
  /**
   * 账号 provider（契约配套：未绑定异常态只针对 Claude，用户「只管 Claude」）。
   * 缺省时按 Claude 处理——农场当前只服务 Claude 账号，缺省不漏标未绑定异常。
   */
  provider?: string;
  /**
   * 农场容器 onboard/绑定时刻（毫秒）——冷启动 reauth 宽限门锚点。由面板从该账号
   * 已绑定容器的 `binding.bound_at ?? created_at`（经 accountTime.resolveFarmOnboardAtMs
   * 解析）派生，仅农场绑定账号有。与 `nowMs` 同时提供、且在 FARM_ONBOARD_REAUTH_GRACE_MS
   * 窗口内时，reauth 家族态（needs_reauth / auto_quarantined）折叠成中性 initializing。
   * 缺省（undefined/null）或 `nowMs` 缺省时不启用宽限门，保持旧行为（100% 向后兼容）。
   */
  onboardAtMs?: number | null;
  /**
   * 宽限判定的「当前时刻」（毫秒，来自稳定的 render 时钟，不在 render 期读 Date.now()）。
   * 缺省时不启用宽限门——宽限只在调用方显式传入时钟时才生效。
   */
  nowMs?: number;
}

/**
 * 是否 Claude provider。农场只管 Claude：provider 缺省（后端未下发）按 Claude
 * 处理，避免过渡期漏标「未绑定·不可出站」异常；显式为其它 provider 时才排除。
 */
function isClaudeProviderValue(provider: string | undefined): boolean {
  if (!provider) return true;
  const p = provider.trim().toLowerCase();
  return p === 'claude' || p === 'anthropic';
}

/**
 * 农场新号冷启动 reauth 宽限窗（毫秒）。见 FARM_ACCOUNT_AUTH_STATES 里 initializing
 * 态注释与文件底部「冷启动 reauth 宽限门」section。默认 2 分钟——覆盖住宅代理/上游
 * 冷启动 + 首个真实请求成功自愈的典型时长；改这里就改宽限口径，不要在别处散魔法数。
 */
export const FARM_ONBOARD_REAUTH_GRACE_MS = 2 * 60 * 1000;

/**
 * 「reauth 家族态」——宽限窗内需要被压成中性 initializing 的态集合。只含冷启动瞬态
 * 可能误亮的两个态：needs_reauth（reauth_url / account_token_dead 驱动）与
 * auto_quarantined（短暂终态认证失败驱动）。其余态（healthy/unprovisioned/
 * operator_disabled/unknown）与冷启动瞬态无关，宽限门一律不碰。
 */
const REAUTH_FAMILY_STATES: ReadonlySet<FarmAccountAuthState> = new Set([
  'needs_reauth',
  'auto_quarantined',
]);

/**
 * 该账号是否处于「刚 onboard <~宽限窗」的冷启动窗口内。onboardAtMs 缺失/非法（未绑定
 * 容器、时间戳解析失败等）一律返回 false（不启用宽限门，如实透出真态）。起点晚于 now
 * （时钟漂移/时序倒挂，elapsed<0）也返回 false——宁可如实透红也不因异常时序把真失效
 * 永久压成中性。窗口是左闭右开 [0, FARM_ONBOARD_REAUTH_GRACE_MS)。
 */
export function isWithinFarmOnboardGrace(
  onboardAtMs: number | null | undefined,
  nowMs: number
): boolean {
  if (typeof onboardAtMs !== 'number' || !Number.isFinite(onboardAtMs)) return false;
  const elapsed = nowMs - onboardAtMs;
  return elapsed >= 0 && elapsed < FARM_ONBOARD_REAUTH_GRACE_MS;
}

/**
 * 派生账号认证态（不含宽限门）——真态优先级（从最终态到最不确定）：隔离 > 停用 >
 * alive(绑定) > 需重认证 > 未绑定(Claude) > 未知。
 * - auto_quarantined/disabled 用账号自带权威布尔（不依赖是否已绑定容器，故未绑定
 *   的隔离/停用账号也能被正确标注，而非一律 unprovisioned/unknown）。
 * - unprovisioned 只在 farm_bound 显式为 false 且是 Claude 时命中，且排在隔离/停用/
 *   需重认证之后——这些更具体/更可操作的异常原因优先展示。alive 只可能来自已绑定
 *   容器的 account_auth_status，故 alive 分支天然不会与未绑定并存（保留旧
 *   「alive 优先于需重认证」不变量，兼容既有用例）。
 */
function deriveBaseAccountAuthState(input: AccountAuthStateInput): FarmAccountAuthState {
  if (input.autoQuarantined) return 'auto_quarantined';
  if (input.disabled) return 'operator_disabled';
  if (input.authStatus === 'alive') return 'healthy';
  // 后端明确 dead 且原因是 token 失效，或后端给了 reauth 入口 → 需重新认证。
  if (input.authReason === 'account_token_dead' || input.hasReauthUrl) return 'needs_reauth';
  // dead 但原因不明（理论上已被上面的隔离/停用/token 三分支覆盖）也按需重认证兜底，
  // 避免把一个后端确证 dead 的账号误显示成 unknown。
  if (input.authStatus === 'dead') return 'needs_reauth';
  // 未绑定容器的 Claude 账号：不可出站，异常态（用户拍板「绑定 + 健康才算正常」）。
  if (input.farmBound === false && isClaudeProviderValue(input.provider)) return 'unprovisioned';
  return 'unknown';
}

/**
 * 派生账号认证态 + 冷启动 reauth 宽限门（belt-and-suspenders，纯显示层）。
 *
 * 先按 deriveBaseAccountAuthState 算真态；再判宽限门——**仅当**调用方显式传了
 * `nowMs`、基础真态属于 REAUTH_FAMILY_STATES（needs_reauth / auto_quarantined）、
 * 且 `onboardAtMs` 落在 [now-宽限窗, now] 内时，把真态折叠成中性 `initializing`
 * （展示「初始化中」而非红「凭证已失效」）。
 *
 * 关键边界（对齐硬约束「不放宽超过宽限窗的真失效」）：
 * - 宽限只对「刚 onboard <~2min」的号生效；`onboardAtMs` 缺失/超窗 → 原样返回真态。
 * - 未传 `nowMs`（如既有单信号单测、非农场调用点）→ 完全不启用宽限门，100% 向后兼容。
 * - 只折叠 reauth 家族两态；healthy/unprovisioned/operator_disabled/unknown 不受影响。
 */
export function deriveAccountAuthState(input: AccountAuthStateInput): FarmAccountAuthState {
  const base = deriveBaseAccountAuthState(input);
  if (
    input.nowMs != null &&
    REAUTH_FAMILY_STATES.has(base) &&
    isWithinFarmOnboardGrace(input.onboardAtMs, input.nowMs)
  ) {
    return 'initializing';
  }
  return base;
}

/** 7 态 → HealthPill 四态色（healthy=ok / initializing=idle / needs_reauth=warn /
 * auto_quarantined=err / operator_disabled=idle / unprovisioned=err / unknown=idle）。
 * initializing=idle 是冷启动过渡态的中性色（既非健康绿也非故障红，见 initializing 态
 * 注释）；unprovisioned 映射 err 与「未绑定·不可出站」红警口径一致。 */
const ACCOUNT_AUTH_STATE_VARIANT: Record<FarmAccountAuthState, FarmHealthVariant> = {
  healthy: 'ok',
  initializing: 'idle',
  needs_reauth: 'warn',
  auto_quarantined: 'err',
  operator_disabled: 'idle',
  unprovisioned: 'err',
  unknown: 'idle',
};

export function accountAuthStateToFarmHealthVariant(
  state: FarmAccountAuthState
): FarmHealthVariant {
  return ACCOUNT_AUTH_STATE_VARIANT[state];
}

// ---------------------------------------------------------------------------
// P2-C3「容器态补 pending/退役/幽灵区分」：容器运行态生命周期分类。旧
// CONTAINER_HEALTH_STATUS 把 created/starting/retired 都压成 idle、
// orphaned 与 degraded 同为 warn，视觉上无法区分「供给中」「已退役归档」
// 「幽灵态待收敛」三种性质完全不同的态。这里把 store.Status 字面值折算成更细
// 的生命周期分类，供 <ContainerRuntimeBadge> 的运行态点样式区分。
// ---------------------------------------------------------------------------

/**
 * 容器运行态生命周期分类：
 * - running：进程健康运行（ok）。
 * - pending：created/starting，容器进程正在起（供给/启动中，非故障）。
 * - degraded：异常降级但进程仍在（warn）。
 * - down：已停止/退出（err）。
 * - retired：软删归档终态（idle 中性，非故障）。
 * - ghost：orphaned 幽灵态，注册表在但容器/绑定异常，待 operator 收敛（warn）。
 * - unbound：账号未接入农场，无容器（idle 中性）。
 */
export const FARM_CONTAINER_LIFECYCLES = [
  'running',
  'pending',
  'degraded',
  'down',
  'retired',
  'ghost',
  'unbound',
] as const;
export type FarmContainerLifecycle = (typeof FARM_CONTAINER_LIFECYCLES)[number];

const CONTAINER_LIFECYCLE_BY_STATUS: Record<string, FarmContainerLifecycle> = {
  running: 'running',
  created: 'pending',
  starting: 'pending',
  degraded: 'degraded',
  down: 'down',
  retired: 'retired',
  orphaned: 'ghost',
};

/** 容器状态字面值 → 生命周期分类；undefined（未绑定）→ unbound，未知值 → pending 兜底。 */
export function classifyContainerLifecycle(status: string | undefined): FarmContainerLifecycle {
  if (!status) return 'unbound';
  return CONTAINER_LIFECYCLE_BY_STATUS[status] ?? 'pending';
}

/** 生命周期分类 → HealthPill 四态色（用于运行态徽标的语义色）。 */
const CONTAINER_LIFECYCLE_VARIANT: Record<FarmContainerLifecycle, FarmHealthVariant> = {
  running: 'ok',
  pending: 'idle',
  degraded: 'warn',
  down: 'err',
  retired: 'idle',
  ghost: 'warn',
  unbound: 'idle',
};

export function containerLifecycleToFarmHealthVariant(
  lifecycle: FarmContainerLifecycle
): FarmHealthVariant {
  return CONTAINER_LIFECYCLE_VARIANT[lifecycle];
}

// ---------------------------------------------------------------------------
// P2-C3「provisioning_state join」：自动供给派生态 → 展示语义色。pending_* 是
// 「正在排队供给、正常等待」而非故障，用 warn（需要关注但非错误）；eligible/
// provisioned 是中性/正向信息，用 idle/ok。
// ---------------------------------------------------------------------------

const PROVISIONING_STATE_VARIANT: Record<string, FarmHealthVariant> = {
  eligible: 'idle',
  pending_no_proxy: 'warn',
  pending_capacity_exhausted: 'warn',
  provisioned: 'ok',
};

export function provisioningStateToFarmHealthVariant(
  state: string | undefined
): FarmHealthVariant {
  if (!state) return 'idle';
  return PROVISIONING_STATE_VARIANT[state] ?? 'idle';
}

// ---------------------------------------------------------------------------
// TR8「农场纳管开关 + 出站平台标识 + 遥测存活展示」：账号级治理/出站展示态
// 纯函数。三个函数都只做"已有契约字段 -> 展示态"的映射，不重新判定/不臆造
// 新的健康逻辑；farm_enrolled / telemetry_alive 目前后端投影尚未完全落地
// （见 types/farm.ts FarmAccountEntry 同名字段注释），因此每个函数都必须在
// 缺失/未知输入下给出安全、非崩溃的中性回退。
// ---------------------------------------------------------------------------

/**
 * 纳管态 → status-badge 变体。只处理「字段已存在」时如何着色，存在性判断
 * （是否渲染这枚徽标）留给调用方——后端尚未投影 farm_enrolled 时应整体不
 * 渲染，而不是把 undefined 强制当 false 显示"未纳管"（那是臆造）。
 */
export function farmEnrolledToBadgeVariant(enrolled: boolean): StatusBadgeVariant {
  return enrolled ? 'success' : 'muted';
}

/**
 * 出站平台标识（design.md 决策：农场号出站 Linux 对齐容器遥测，普通号出站
 * Mac）。唯一权威输入是既有契约字段 farm_bound——不读 device_id_source 或
 * 其它信号重算，避免出现"平台标识"和"device_id 来源徽标"两处口径打架。
 * farm_bound 缺省（undefined，理论上不应发生，恒有值字段）按未绑定的普通号
 * 处理，不假造已绑定。
 */
export type FarmOutboundPlatform = 'linux' | 'mac';

export function farmBoundToOutboundPlatform(farmBound: boolean | undefined): FarmOutboundPlatform {
  return farmBound === true ? 'linux' : 'mac';
}

const TELEMETRY_ALIVE_STATE_SET: ReadonlySet<string> = new Set(FARM_TELEMETRY_ALIVE_STATES);

/**
 * 归一化 telemetry_alive 原始值到三态枚举内：非三态之一的任何输入（含
 * undefined——采集平面 TR6 尚未落地或编排器还没透传这个字段时的当前实际
 * 情况——以及后端未来可能出现的未知字面值）一律回退 unknown，绝不误判成
 * alive/silent，也绝不因缺字段而抛错/崩溃。
 */
export function normalizeFarmTelemetryAliveState(
  value: string | undefined
): FarmTelemetryAliveState {
  if (value && TELEMETRY_ALIVE_STATE_SET.has(value)) {
    return value as FarmTelemetryAliveState;
  }
  return 'unknown';
}

/** telemetry_alive 三态 → status-badge 变体：alive=success（遥测在报）/
 * silent=warning（曾采集到过，近期静默，值得关注）/unknown=muted（中性，
 * 不是故障，只是还不知道）。 */
export function telemetryAliveStateToBadgeVariant(
  state: FarmTelemetryAliveState
): StatusBadgeVariant {
  if (state === 'alive') return 'success';
  if (state === 'silent') return 'warning';
  return 'muted';
}

const TELEMETRY_SILENCE_STATE_SET: ReadonlySet<string> = new Set(FARM_TELEMETRY_SILENCE_STATES);

/**
 * 归一化「遥测停摆四态」原始值到枚举内。诚实边界（farm-egress-resilience Change A
 * spec「无法确证时 SHALL 显示待确认而非臆断」）：非枚举之一的任何输入（含
 * undefined——旧编排器未透传，或后端未来出现未知字面值）一律回退 **indeterminate
 * （待确认）**，绝不回退成 active / idle_no_request 这类乐观结论——宁可显「待确认」
 * 也不臆断「正常」。
 */
export function normalizeFarmTelemetrySilenceState(
  value: string | undefined
): FarmTelemetrySilenceState {
  if (value && TELEMETRY_SILENCE_STATE_SET.has(value)) {
    return value as FarmTelemetrySilenceState;
  }
  return 'indeterminate';
}

/**
 * 「遥测停摆四态」→ status-badge 变体（语义色对齐既有 success/warning/error/muted，
 * 不新造颜色 token）：
 *  - active           → success（遥测在报，健康）
 *  - idle_no_request  → muted（停摆但探针证明网络通、benign「正常没请求」，无需处理）
 *  - proxy_dead / egress_blackhole / process_dead → error（确证的可行动故障，需处理）
 *  - indeterminate    → warning（证据不足，待人工确认——不是确证故障，也绝不当健康）
 */
export function telemetrySilenceStateToBadgeVariant(
  state: FarmTelemetrySilenceState
): StatusBadgeVariant {
  switch (state) {
    case 'active':
      return 'success';
    case 'idle_no_request':
      return 'muted';
    case 'proxy_dead':
    case 'egress_blackhole':
    case 'process_dead':
      return 'error';
    case 'indeterminate':
    default:
      return 'warning';
  }
}

// ---------------------------------------------------------------------------
// farm-onwire-deviceid-consistency 增量2 §5：三向 on-wire device_id 一致性五态
// （serving==telemetry==expected）→ 归一化 + 语义色。判定在后端（三向比对 +
// fail-closed 隔离），前端只做「已判定好的字面值 -> 展示态」映射，不重算一致性。
// ---------------------------------------------------------------------------

const ONWIRE_CONSISTENCY_STATE_SET: ReadonlySet<string> = new Set(FARM_ONWIRE_CONSISTENCY_STATES);

/**
 * 归一化三向一致性五态原始值到枚举内。诚实边界：非枚举之一的任何输入（含
 * undefined——旧编排器未透传，或后端未来出现未知字面值）一律回退 **unobserved
 * （未观测，中性）**——绝不回退成 healthy(绿) 也绝不回退成 inconsistent(红)，
 * 宁可显中性「未观测」也不臆断绿/红。与 normalizeFarmTelemetrySilenceState 同款
 * 「未知落到中性诚实态」口径。
 */
export function normalizeFarmOnwireConsistencyState(
  value: string | undefined
): FarmOnwireConsistencyState {
  if (value && ONWIRE_CONSISTENCY_STATE_SET.has(value)) {
    return value as FarmOnwireConsistencyState;
  }
  return 'unobserved';
}

/**
 * 三向一致性五态 → status-badge 变体（语义色对齐既有 success/warning/error/muted，
 * 不新造颜色 token）：
 *  - healthy           → success（三向自洽，健康 flag-on 号）
 *  - inconsistent      → error（真不一致=遥测泄漏或 serving 未落地，已 fail-closed 隔离）
 *  - pending_migration → muted（flag-off 存量号待一致化，**中性非泄漏**，绝不刷红健康号）
 *  - not_ready         → muted（flag-on 尚未钉死 on-wire，中性未就绪）
 *  - unobserved        → muted（已钉死但无遥测样本，缺独立判据，中性非绿）
 */
export function onwireConsistencyStateToBadgeVariant(
  state: FarmOnwireConsistencyState
): StatusBadgeVariant {
  switch (state) {
    case 'healthy':
      return 'success';
    case 'inconsistent':
      return 'error';
    case 'pending_migration':
    case 'not_ready':
    case 'unobserved':
    default:
      return 'muted';
  }
}
