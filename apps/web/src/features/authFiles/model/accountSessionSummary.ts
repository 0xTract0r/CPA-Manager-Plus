import type { AuthFileAccountScheduling } from '@/types';

/**
 * P7（account-session-count-display）纯数据层：把 core
 * `account_scheduling.sessions_{total,active,closed}` 归一成一个三态展示模型。
 *
 * 三态含义（不是「加载中」这类异步态——sessions 数据随账号列表一次性到达，
 * 无独立请求，故不存在组件级 loading；调用方若需要"加载中"展示，应挂在页面
 * 级 files 列表的 loading 上，见 AuthFilesPage 既有 `{loading ? ... : cards}`）：
 *  - unavailable：core 未下发该投影（跨版本/过渡期部署缺失，见类型定义注释），
 *    展示上应与「已确认 0」区分，不能直接渲染成 0。
 *  - empty：投影存在但 sessions_total === 0——「确有其事的 0」，core 侧不区分
 *    「从未采集」与「采集到但确实 0 次」，UI 文案必须是「暂无会话数据」而非数字 0。
 *  - ok：sessions_total > 0，正常渲染三个计数。
 */
export type AccountSessionSummaryStatus = 'unavailable' | 'empty' | 'ok';

export interface AccountSessionSummary {
  status: AccountSessionSummaryStatus;
  total: number;
  active: number;
  closed: number;
}

/** 防御式取非负整数；非数字/NaN/负数一律归 0，绝不产出 NaN 或负数渲染。 */
const toNonNegativeInt = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return value > 0 ? Math.floor(value) : 0;
};

export const deriveAccountSessionSummary = (
  accountScheduling: AuthFileAccountScheduling | null | undefined
): AccountSessionSummary => {
  if (!accountScheduling || typeof accountScheduling !== 'object') {
    return { status: 'unavailable', total: 0, active: 0, closed: 0 };
  }
  const total = toNonNegativeInt(accountScheduling.sessions_total);
  const active = toNonNegativeInt(accountScheduling.sessions_active);
  const closed = toNonNegativeInt(accountScheduling.sessions_closed);
  return { status: total > 0 ? 'ok' : 'empty', total, active, closed };
};

// ---------------------------------------------------------------------------
// 订阅等级徽标（同一投影的 subscription_tier 字段）
// ---------------------------------------------------------------------------

/** core account_tier.go ClaudeTier.String() 的已知取值（不含 "unknown"）。 */
export const CLAUDE_SUBSCRIPTION_TIER_VALUES = ['max_20x', 'max_5x', 'pro'] as const;
/** core account_tier.go CodexTier.String() 的已知取值（不含 "unknown"）。 */
export const CODEX_SUBSCRIPTION_TIER_VALUES = ['pro', 'plus'] as const;

export type KnownSubscriptionTier =
  | (typeof CLAUDE_SUBSCRIPTION_TIER_VALUES)[number]
  | (typeof CODEX_SUBSCRIPTION_TIER_VALUES)[number];

export interface SubscriptionTierBadge {
  /** 归一化后的 tier 值；未识别到已知档位一律 'unknown'，绝不猜测。 */
  tier: KnownSubscriptionTier | 'unknown';
  /** 是否命中已知档位（false 时 UI 必须显式展示"未知"，不能隐藏或留白）。 */
  known: boolean;
}

/**
 * 只对 core 实际投影细粒度档位的 provider（claude/codex）返回徽标数据；其它
 * provider core 恒回退 "unknown"（design.md/account_tier.go default 分支），
 * 渲染一个恒定"未知"徽标没有信息量，只会刷屏，所以这些 provider 返回 null
 * （不展示徽标），行为上与"确认未知"的 claude/codex 账号区分开。
 *
 * accountScheduling 整体缺失时同样返回 null——那是"数据源不可用"（core 版本
 * 跨度），不是"已确认未知档位"，两者是不同的降级语义，不应该展示成同一个
 * "未知"徽标掩盖过去。
 */
export const deriveSubscriptionTierBadge = (
  providerKey: string,
  accountScheduling: AuthFileAccountScheduling | null | undefined
): SubscriptionTierBadge | null => {
  if (providerKey !== 'claude' && providerKey !== 'codex') return null;
  if (!accountScheduling || typeof accountScheduling !== 'object') return null;

  const raw =
    typeof accountScheduling.subscription_tier === 'string'
      ? accountScheduling.subscription_tier.trim().toLowerCase()
      : '';
  const knownValues: readonly string[] =
    providerKey === 'claude' ? CLAUDE_SUBSCRIPTION_TIER_VALUES : CODEX_SUBSCRIPTION_TIER_VALUES;

  if (knownValues.includes(raw)) {
    return { tier: raw as KnownSubscriptionTier, known: true };
  }
  return { tier: 'unknown', known: false };
};

// ---------------------------------------------------------------------------
// 养号（warm-up）标注（同一投影的 warmup 子对象）
// ---------------------------------------------------------------------------

export interface AccountWarmupBadge {
  /** 恒为 true（本函数只在「养号中」时返回对象，成熟/不可判定时返回 null）。 */
  warming: true;
  /** core 下发的当前阶段名（可能为空字符串，仅作 tooltip 展示，不参与判定）。 */
  stage: string;
  /** 账号年龄（天）；core 未锚定时为 null。 */
  ageDays: number | null;
}

/**
 * 只在 core 明确报 `warmup.mature === false`（尚在养号曲线内）时返回养号标注；
 * 其余一律返回 null 不展示：
 *  - accountScheduling / warmup 整体缺失（老 core 未投影）→ 不可判定，不标注。
 *  - `mature === true`（已成熟）→ 正常号，不标注。
 *  - `mature` 非布尔（版本漂移/脏数据）→ 不可判定，不标注（绝不臆造养号态）。
 *
 * 注意：本函数 provider-agnostic，仅做纯数据判定；是否只对 claude 展示由调用方
 * （AuthFileCard）按 provider gate 决定。
 */
export const deriveAccountWarmupBadge = (
  accountScheduling: AuthFileAccountScheduling | null | undefined
): AccountWarmupBadge | null => {
  if (!accountScheduling || typeof accountScheduling !== 'object') return null;
  const warmup = accountScheduling.warmup;
  if (!warmup || typeof warmup !== 'object') return null;
  if (warmup.mature !== false) return null;

  const stage = typeof warmup.stage === 'string' ? warmup.stage.trim() : '';
  const ageDays =
    typeof warmup.age_days === 'number' && Number.isFinite(warmup.age_days)
      ? Math.max(0, Math.floor(warmup.age_days))
      : null;
  return { warming: true, stage, ageDays };
};
