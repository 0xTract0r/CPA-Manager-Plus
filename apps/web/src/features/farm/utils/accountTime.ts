import { parseCoreQuotaTimestamp } from '@/services/api/quotaSnapshots';

/**
 * #50 账号时间字段的零时间兜底 + 存活时长派生（纯函数，供组件在格式化前调用）。
 *
 * 背景：core / 编排器把「从未设置」的时间字段透传为 Go 零值
 * `0001-01-01T00:00:00Z`。这个值非空、且能被 `Date.parse` 解析成一个合法（但
 * 荒谬）的时刻，所以普通的 `value ? ... : '—'` 空值判断拦不住它——直接格式化会
 * 渲染成「0001年1月1日」，用它当存活起算点还会算出几千年的荒谬时长。本仓库因此
 * 出过生产事故，usage 冒烟门禁也明确拒收 `0001-01-01` / `1/1/1` 这类零时间。
 *
 * 这里统一复用 `parseCoreQuotaTimestamp`（同拦 `/^0001-01-01/` 与
 * `getUTCFullYear() <= 1`），把创建 / 首登 / 失效起算路径上的零时间一律归 null，
 * 由调用方渲染成 '—'；存活起算时刻为零时间时 `aliveMs` 为 null。
 */
export interface FarmAccountTimeInput {
  /** 账号创建时刻（core 首次装载近似值）。 */
  createdAt?: string | null;
  /** 首次登录时刻（runtime_identity.current.created_at）。 */
  firstIdentityAt?: string | null;
  /**
   * 精确失效时刻。仅 `auto_quarantined` 账号有（`quarantined_at`）；调用方按
   * 认证态 gate 后传入，`needs_reauth` 等无精确失效时刻的态传空即可。
   */
  failureAt?: string | null;
  /**
   * 账号是否处于失效态（`auto_quarantined` / `needs_reauth`）。决定存活是截止到
   * 失效时刻还是 now，以及在拿不到精确失效时刻时是否标注为「估算」。
   */
  impaired: boolean;
  /** 存活「当前时刻」时钟（毫秒）；由稳定的 render 时钟提供，避免 render 期读 Date.now()。 */
  nowMs: number;
}

export interface FarmAccountTimeLabels {
  /** 创建时刻（零时间/无效 → null，调用方渲染成 '—'）。 */
  createdAtDate: Date | null;
  /** 首次登录时刻（零时间/无效 → null，调用方渲染成 '—'）。 */
  firstIdentityDate: Date | null;
  /** 存活时长（毫秒）；创建时刻缺失/为零时间或时序倒挂时为 null（渲染成 '—'）。 */
  aliveMs: number | null;
  /** 失效号但拿不到精确失效时刻，按 now 估算，需要在 UI 上标注。 */
  aliveEstimated: boolean;
}

export function deriveFarmAccountTimeLabels(input: FarmAccountTimeInput): FarmAccountTimeLabels {
  const { createdAt, firstIdentityAt, failureAt, impaired, nowMs } = input;

  const createdAtDate = parseCoreQuotaTimestamp(createdAt);
  const firstIdentityDate = parseCoreQuotaTimestamp(firstIdentityAt);
  const failureDate = impaired ? parseCoreQuotaTimestamp(failureAt) : null;

  let aliveMs: number | null = null;
  let aliveEstimated = false;
  if (createdAtDate) {
    const createdMs = createdAtDate.getTime();
    const endMs = failureDate ? failureDate.getTime() : nowMs;
    if (endMs >= createdMs) {
      aliveMs = endMs - createdMs;
      // 失效号但拿不到精确失效时刻 → 按 now 估算，需标注。
      aliveEstimated = impaired && !failureDate;
    }
  }

  return { createdAtDate, firstIdentityDate, aliveMs, aliveEstimated };
}
