import { parseCoreQuotaTimestamp } from '@/services/api/quotaSnapshots';

/**
 * #50 / R5-1 账号时间字段的零时间兜底 + 存活时长派生（纯函数，供组件在格式化前调用）。
 *
 * 背景：core / 编排器把「从未设置」的时间字段透传为 Go 零值
 * `0001-01-01T00:00:00Z`。这个值非空、且能被 `Date.parse` 解析成一个合法（但
 * 荒谬）的时刻，所以普通的 `value ? ... : '—'` 空值判断拦不住它——直接格式化会
 * 渲染成「0001年1月1日」，用它当存活起算点还会算出几千年的荒谬时长。本仓库因此
 * 出过生产事故，usage 冒烟门禁也明确拒收 `0001-01-01` / `1/1/1` 这类零时间。
 *
 * 这里统一复用 `parseCoreQuotaTimestamp`（同拦 `/^0001-01-01/` 与
 * `getUTCFullYear() <= 1`），把注册 / 创建 / 首登 / 封禁 / 失效起算路径上的零时间
 * 一律归 null，由调用方渲染成 '—'；存活起算/终止时刻为零时间时按缺失处理。
 *
 * R5-1 存活口径修正（AC11）：
 *  - 创建展示优先真实注册时间 `account_registered_at`（Wave1 起编排器透传的
 *    Anthropic 真实注册时刻），缺失才降级到 `created_at`（core 装载近似值）；
 *    降级时 `createdAtIsFallback=true`，供 UI 标注「装载近似·非真实注册」。
 *  - 存活「起点」= 首次登录 `first_identity_at`（缺失时降级到创建展示时刻，
 *    避免完全无法计算）；「终点」优先真实封禁 `refresh_disabled_at`，其次隔离
 *    精确失效时刻 `quarantined_at`（仅 auto_quarantined），都缺失才退回 now。
 *    修复点：needs_reauth 死号此前无 `quarantined_at` → 终点一路退回 now、存活
 *    数字一直往上累加；现在只要有真实封禁时刻就钉死终点，不再虚涨。
 */
export interface FarmAccountTimeInput {
  /**
   * 账号真实注册时刻（`account_registered_at`，Anthropic profile 注册时间，
   * Wave1 起编排器透传）。作为「创建」列的首选展示值。
   */
  registeredAt?: string | null;
  /**
   * 账号创建时刻（core 首次装载近似值，非真实注册时间）。真实注册时刻缺失时的
   * 降级展示来源。
   */
  createdAt?: string | null;
  /** 首次登录时刻（runtime_identity.current.created_at）。存活起算点。 */
  firstIdentityAt?: string | null;
  /**
   * 真实封禁时刻（`refresh_disabled_at`，账号级）。存活终点的首选值——有值即钉死
   * 终点，不再退回 now 虚涨。缺失（未封禁或后端未投影）时按无终点处理。
   */
  bannedAt?: string | null;
  /**
   * 精确失效时刻兜底。仅 `auto_quarantined` 账号有（`quarantined_at`）；调用方按
   * 认证态 gate 后传入。作为封禁时刻缺失时的次选终点，`needs_reauth` 等无精确
   * 失效时刻的态传空即可。
   */
  failureAt?: string | null;
  /**
   * 账号是否处于失效态（`auto_quarantined` / `needs_reauth`）。决定在拿不到任何
   * 精确终点（封禁/失效时刻）时是否把按 now 估算的存活标注为「估算」。
   */
  impaired: boolean;
  /** 存活「当前时刻」时钟（毫秒）；由稳定的 render 时钟提供，避免 render 期读 Date.now()。 */
  nowMs: number;
}

export interface FarmAccountTimeLabels {
  /**
   * 「创建」列展示时刻：优先真实注册时间，缺失降级到 `created_at`（零时间/无效
   * → null，调用方渲染成 '—'）。
   */
  createdAtDate: Date | null;
  /**
   * `createdAtDate` 是否来自 `created_at` 降级（真实注册时间缺失）。true 时 UI
   * 应标注这是 core 装载近似值、非 Anthropic 真实注册时间。
   */
  createdAtIsFallback: boolean;
  /** 真实封禁时刻（`refresh_disabled_at`，零时间/无效 → null，调用方渲染成 '—'）。 */
  bannedAtDate: Date | null;
  /** 首次登录时刻（零时间/无效 → null，调用方渲染成 '—'）。 */
  firstIdentityDate: Date | null;
  /** 存活时长（毫秒）；起算时刻缺失/为零时间或时序倒挂时为 null（渲染成 '—'）。 */
  aliveMs: number | null;
  /** 失效号但拿不到任何精确终点，按 now 估算，需要在 UI 上标注。 */
  aliveEstimated: boolean;
}

export function deriveFarmAccountTimeLabels(input: FarmAccountTimeInput): FarmAccountTimeLabels {
  const { registeredAt, createdAt, firstIdentityAt, bannedAt, failureAt, impaired, nowMs } = input;

  const registeredAtDate = parseCoreQuotaTimestamp(registeredAt);
  const createdAtRawDate = parseCoreQuotaTimestamp(createdAt);
  // 「创建」列展示优先真实注册时间；缺失才降级到 core 装载近似值 created_at。
  const createdAtDate = registeredAtDate ?? createdAtRawDate;
  const createdAtIsFallback = registeredAtDate == null && createdAtRawDate != null;

  const firstIdentityDate = parseCoreQuotaTimestamp(firstIdentityAt);
  const bannedAtDate = parseCoreQuotaTimestamp(bannedAt);
  const failureDate = impaired ? parseCoreQuotaTimestamp(failureAt) : null;

  // 存活终点优先级：真实封禁时刻 > 隔离精确失效时刻 > now（无精确终点时估算）。
  const preciseEndDate = bannedAtDate ?? failureDate;
  // 存活起点：首次登录优先；缺失时降级到创建展示时刻（避免完全无法计算）。
  const startDate = firstIdentityDate ?? createdAtDate;

  let aliveMs: number | null = null;
  let aliveEstimated = false;
  if (startDate) {
    const startMs = startDate.getTime();
    const endMs = preciseEndDate ? preciseEndDate.getTime() : nowMs;
    if (endMs >= startMs) {
      aliveMs = endMs - startMs;
      // 失效号但拿不到任何精确终点（封禁/失效时刻均缺）→ 按 now 估算，需标注。
      aliveEstimated = impaired && !preciseEndDate;
    }
  }

  return {
    createdAtDate,
    createdAtIsFallback,
    bannedAtDate,
    firstIdentityDate,
    aliveMs,
    aliveEstimated,
  };
}
