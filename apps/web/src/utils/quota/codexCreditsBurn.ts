/**
 * Codex 积分消耗与「够不够用」预测（纯函数，无副作用）。
 *
 * 上游只给当前余额，不给积分总额，所以不算「已用百分比」，而是：
 * - 起点：序列里首个「主窗口已用满 + 有积分」点的余额；判断不了就用首点并标「近 N 小时」；
 * - 已用 = 起点余额 − 当前余额；余额上升（充值）时以上升后的值为新起点，已用不为负；
 * - 速率 = 最近 24 小时消耗 ÷ 实际经过小时数；不足 1 小时或变化点 < 3 时不给速率与预测；
 * - 预测 = 速率 × 距主窗口重置剩余小时；进度 = 预测 ÷ 当前余额（上限 100%），
 *   < 70% 够用、70%~100% 偏紧、> 100% 可能不够（并给出预计用完时间）。
 */

export type CodexCreditsBalancePoint = {
  timestampMs: number;
  balance: number;
  quotaExhausted: boolean;
};

export type CodexCreditsHistory = {
  points: CodexCreditsBalancePoint[];
  /** 已用满主窗口的重置时间（ms），未知为 null。 */
  quotaResetAtMs: number | null;
  windowStartMs: number | null;
  unlimited: boolean;
};

export type CodexCreditsBurnLevel = 'ok' | 'tight' | 'short';

export type CodexCreditsBurnForecast = {
  /** 起点是否是「额度用完那一刻」；false 时 UI 显示「近 N 小时」。 */
  startIsExhaustion: boolean;
  startMs: number;
  startBalance: number;
  currentBalance: number;
  /** 起点到最新点经过的整小时数（≥1，向上取整），用于「近 N 小时」文案。 */
  sinceHours: number;
  used: number;
  /** 每小时消耗；数据不足时为 null（此时不显示速率与预测）。 */
  ratePerHour: number | null;
  /** 到重置预计再用；无速率或无重置时间时为 null。 */
  projected: number | null;
  /** 预测 ÷ 当前余额 × 100，封顶 100；null 同上。 */
  percent: number | null;
  level: CodexCreditsBurnLevel | null;
  /** 仅「可能不够」时给出：按当前速率余额耗尽的时间。 */
  runOutAtMs: number | null;
};

const HOUR_MS = 60 * 60 * 1000;
const RATE_WINDOW_MS = 24 * HOUR_MS;
const MIN_RATE_SPAN_MS = HOUR_MS;
const MIN_RATE_CHANGE_POINTS = 3;
export const CODEX_CREDITS_BURN_TIGHT_PERCENT = 70;

const readFinite = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

/** 把后端 `{timestamp_ms, balance, quota_exhausted}` 规范成正序、去非法值的点列。 */
export const normalizeCodexCreditsPoints = (raw: unknown): CodexCreditsBalancePoint[] => {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const record = item as Record<string, unknown>;
      const timestampMs = readFinite(record.timestamp_ms ?? record.timestampMs);
      const balance = readFinite(record.balance);
      if (timestampMs === null || timestampMs <= 0 || balance === null || balance < 0) return null;
      return {
        timestampMs,
        balance,
        quotaExhausted: record.quota_exhausted === true || record.quotaExhausted === true,
      };
    })
    .filter((point): point is CodexCreditsBalancePoint => point !== null)
    .sort((left, right) => left.timestampMs - right.timestampMs);
};

/**
 * 累计消耗：逐段只累加下降量；余额上升（充值）视为新起点，不产生负消耗。
 * 返回值即「起点余额 − 当前余额」在无充值时的结果。
 */
const sumConsumption = (points: CodexCreditsBalancePoint[]): number => {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    const drop = points[index - 1].balance - points[index].balance;
    if (drop > 0) total += drop;
  }
  return total;
};

/** 自 startIndex 起最后一次余额上升（充值）的位置；没有上升则返回 startIndex。 */
const lastRechargeIndex = (points: CodexCreditsBalancePoint[], startIndex: number): number => {
  let result = startIndex;
  for (let index = startIndex + 1; index < points.length; index += 1) {
    if (points[index].balance > points[index - 1].balance) result = index;
  }
  return result;
};

export const classifyCodexCreditsBurn = (percentUncapped: number): CodexCreditsBurnLevel => {
  if (percentUncapped > 100) return 'short';
  if (percentUncapped >= CODEX_CREDITS_BURN_TIGHT_PERCENT) return 'tight';
  return 'ok';
};

export const computeCodexCreditsBurnForecast = (
  history: CodexCreditsHistory | null | undefined,
  options: { nowMs?: number; currentBalance?: number | null } = {}
): CodexCreditsBurnForecast | null => {
  if (!history || history.unlimited) return null;
  const nowMs = options.nowMs ?? Date.now();
  const points = history.points.filter((point) => point.timestampMs <= nowMs);
  if (points.length === 0) return null;

  // 卡片上的当前余额可能比序列最新点更新（core 快照择新）：只在它比最新点低 ≥1 时追加，
  // 视为更新鲜的消耗；更高的外部余额不当作充值（避免精度差异把起点重置），交给后端序列体现。
  const latest = points[points.length - 1];
  const externalBalance = options.currentBalance ?? null;
  const series =
    externalBalance !== null &&
    Number.isFinite(externalBalance) &&
    externalBalance >= 0 &&
    latest.balance - externalBalance >= 1
      ? [
          ...points,
          {
            timestampMs: Math.max(latest.timestampMs, nowMs),
            balance: externalBalance,
            quotaExhausted: latest.quotaExhausted,
          },
        ]
      : points;

  const exhaustionIndex = series.findIndex((point) => point.quotaExhausted);
  const startIsExhaustion = exhaustionIndex >= 0;
  const baseIndex = startIsExhaustion ? exhaustionIndex : 0;
  const startIndex = lastRechargeIndex(series, baseIndex);
  const segment = series.slice(startIndex);
  const start = segment[0];
  const end = segment[segment.length - 1];
  const used = Math.max(0, sumConsumption(segment));
  const currentBalance = end.balance;
  const sinceHours = Math.max(1, Math.ceil((end.timestampMs - start.timestampMs) / HOUR_MS));

  const base: CodexCreditsBurnForecast = {
    startIsExhaustion: startIsExhaustion && startIndex === baseIndex,
    startMs: start.timestampMs,
    startBalance: start.balance,
    currentBalance,
    sinceHours,
    used,
    ratePerHour: null,
    projected: null,
    percent: null,
    level: null,
    runOutAtMs: null,
  };

  // 速率：最近 24 小时（不早于起点）内的消耗 ÷ 实际经过小时数。
  const rateFromMs = Math.max(start.timestampMs, end.timestampMs - RATE_WINDOW_MS);
  const ratePoints = segment.filter((point) => point.timestampMs >= rateFromMs);
  const rateSpanMs =
    ratePoints.length > 0 ? end.timestampMs - ratePoints[0].timestampMs : 0;
  const changePoints = ratePoints.filter(
    (point, index) => index === 0 || point.balance !== ratePoints[index - 1].balance
  ).length;
  if (rateSpanMs < MIN_RATE_SPAN_MS || changePoints < MIN_RATE_CHANGE_POINTS) return base;

  const ratePerHour = sumConsumption(ratePoints) / (rateSpanMs / HOUR_MS);
  base.ratePerHour = ratePerHour;

  const resetAtMs = history.quotaResetAtMs;
  if (resetAtMs === null || !Number.isFinite(resetAtMs) || resetAtMs <= nowMs) return base;
  const remainingHours = (resetAtMs - nowMs) / HOUR_MS;
  const projected = ratePerHour * remainingHours;
  base.projected = projected;

  if (currentBalance <= 0) {
    base.percent = 100;
    base.level = projected > 0 ? 'short' : 'ok';
    base.runOutAtMs = projected > 0 ? nowMs : null;
    return base;
  }
  const percentUncapped = (projected / currentBalance) * 100;
  base.percent = Math.min(100, percentUncapped);
  base.level = classifyCodexCreditsBurn(percentUncapped);
  if (base.level === 'short' && ratePerHour > 0) {
    base.runOutAtMs = nowMs + (currentBalance / ratePerHour) * HOUR_MS;
  }
  return base;
};

/**
 * 紧凑数字：中文（简/繁）≥1 万用「万/萬」，其余语言 ≥1 万用 k / тыс. 等（Intl compact）；
 * 小于 1 万时取整加千分位。
 */
export const formatCodexCreditsCompact = (value: number, locale?: string): string => {
  const safe = Number.isFinite(value) ? Math.max(0, value) : 0;
  const resolvedLocale = locale?.trim() || undefined;
  if (safe < 10_000) {
    return Math.round(safe).toLocaleString(resolvedLocale);
  }
  return new Intl.NumberFormat(resolvedLocale, {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(safe);
};

/** 每小时速率：≥10 取整加千分位，<10 保留 1 位小数。 */
export const formatCodexCreditsRate = (value: number, locale?: string): string => {
  const safe = Number.isFinite(value) ? Math.max(0, value) : 0;
  const resolvedLocale = locale?.trim() || undefined;
  if (safe >= 10) return Math.round(safe).toLocaleString(resolvedLocale);
  return safe.toLocaleString(resolvedLocale, { maximumFractionDigits: 1 });
};
