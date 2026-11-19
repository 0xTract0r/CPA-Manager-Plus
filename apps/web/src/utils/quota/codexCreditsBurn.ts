/**
 * Codex 积分消耗与「够不够用」预测（纯函数，无副作用）。
 *
 * 上游只给当前余额，不给积分总额，所以不算「已用百分比」，而是：
 * - 起点：首个「未用满 → 已用满」跳变点的余额；找不到跳变（含首点已用满）就用首点并标「近 N 小时」；
 * - 已用 = 起点余额 − 当前余额 + 期间真实充值量；上升 ≤ max(100, 余额 1%) 视为并发抖动忽略；
 * - 速率 = rateFrom 前最后一点余额到当前的消耗 ÷ 墙钟小时（rateFrom = max(起点, 现在 − 24h)）；
 *   不足 1 小时或变化点 < 3 时不给速率与预测；
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
 * 充值阈值：上升幅度 > max(100, 当前余额的 1%) 才算真实充值。序列按请求开始时间排序、余额
 * 在响应时取得，并发请求会产生小幅假上升（生产实测 57870.39 → 57875.03），这类上升视为噪声。
 */
const RECHARGE_MIN_ABS = 100;
const RECHARGE_MIN_RATIO = 0.01;

const isRecharge = (previousBalance: number, nextBalance: number): boolean =>
  nextBalance - previousBalance > Math.max(RECHARGE_MIN_ABS, nextBalance * RECHARGE_MIN_RATIO);

/** (fromIndex, toIndex] 区间内真实充值量之和（小幅抖动不计）。 */
const sumRecharges = (
  points: CodexCreditsBalancePoint[],
  fromIndex: number,
  toIndex: number
): number => {
  let total = 0;
  for (let index = fromIndex + 1; index <= toIndex; index += 1) {
    const rise = points[index].balance - points[index - 1].balance;
    if (isRecharge(points[index - 1].balance, points[index].balance)) total += rise;
  }
  return total;
};

/** 首个「前一点未用满 → 当前点已用满」的跳变位置；首点就已用满或没有跳变时返回 -1。 */
const findExhaustionTransition = (points: CodexCreditsBalancePoint[]): number => {
  for (let index = 1; index < points.length; index += 1) {
    if (points[index].quotaExhausted && !points[index - 1].quotaExhausted) return index;
  }
  return -1;
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

  // 只有找到「未用满 → 已用满」跳变才把那一刻当作「额度用完后」的起点。
  const transitionIndex = findExhaustionTransition(series);
  const lastIndex = series.length - 1;
  const startIndex = transitionIndex >= 0 ? transitionIndex : 0;
  const start = series[startIndex];
  const end = series[lastIndex];
  const currentBalance = end.balance;
  // 已用 = 起点余额 − 当前余额 + 期间真实充值量（不逐段累加下降，避免抖动重复计数）。
  const used = Math.max(
    0,
    start.balance - currentBalance + sumRecharges(series, startIndex, lastIndex)
  );
  const sinceHours = Math.max(1, Math.ceil((end.timestampMs - start.timestampMs) / HOUR_MS));

  const base: CodexCreditsBurnForecast = {
    startIsExhaustion: transitionIndex >= 0,
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

  // 速率：rateFrom = max(起点时刻, 现在 − 24h)；分子 = rateFrom 之前（含）最后一个点的余额 −
  // 当前余额 + 期间真实充值量，分母 = 现在 − rateFrom 的墙钟时长（夜间空闲会拉低速率）。
  const rateFrom = Math.max(start.timestampMs, nowMs - RATE_WINDOW_MS);
  let anchorIndex = startIndex;
  for (let index = startIndex; index <= lastIndex; index += 1) {
    if (series[index].timestampMs <= rateFrom) anchorIndex = index;
    else break;
  }
  const rateSpanMs = nowMs - rateFrom;
  const changePoints = series
    .slice(anchorIndex)
    .filter((point, index, list) => index === 0 || point.balance !== list[index - 1].balance).length;
  if (rateSpanMs < MIN_RATE_SPAN_MS || changePoints < MIN_RATE_CHANGE_POINTS) return base;

  const rateConsumed = Math.max(
    0,
    series[anchorIndex].balance - currentBalance + sumRecharges(series, anchorIndex, lastIndex)
  );
  const ratePerHour = rateConsumed / (rateSpanMs / HOUR_MS);
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

type CreditsHistoryItemLike = {
  auth_file_snapshot?: string;
  auth_index?: string;
  quota_reset_at_ms?: number;
  window_start_ms?: number;
  unlimited?: boolean;
  points?: unknown;
};

type HistoryIndex = Map<string, CodexCreditsHistory | null>;

export type CodexCreditsHistoryLookup = {
  byFileAuthIndex: HistoryIndex;
  byFileName: HistoryIndex;
  byFoldedFileAuthIndex: HistoryIndex;
};

const fileIdentity = (value: unknown): string =>
  typeof value === 'string' && value.trim() ? value : '';

const indexIdentity = (value: unknown): string =>
  typeof value === 'number' || typeof value === 'string' ? String(value).trim() : '';

// 重复记录未必属于同一凭证。保留歧义标记，不按数组顺序取最后一条。
const addUniqueHistory = (index: HistoryIndex, key: string, history: CodexCreditsHistory) => {
  index.set(key, index.has(key) ? null : history);
};

const toCodexCreditsHistory = (item: CreditsHistoryItemLike): CodexCreditsHistory => {
  const resetAtMs = readFinite(item.quota_reset_at_ms);
  const windowStartMs = readFinite(item.window_start_ms);
  return {
    points: normalizeCodexCreditsPoints(item.points),
    quotaResetAtMs: resetAtMs !== null && resetAtMs > 0 ? resetAtMs : null,
    windowStartMs: windowStartMs !== null && windowStartMs > 0 ? windowStartMs : null,
    unlimited: item.unlimited === true,
  };
};

/**
 * 只按高置信度身份（认证文件名 + auth_index，或无 auth_index 时的文件名）匹配，
 * 与请求头快照的 high confidence 规则一致，避免把别的账号的序列挂到卡片上。
 */
export const buildCodexCreditsHistoryLookup = (
  items: CreditsHistoryItemLike[] | null | undefined
): CodexCreditsHistoryLookup => {
  const lookup: CodexCreditsHistoryLookup = {
    byFileAuthIndex: new Map(), byFileName: new Map(), byFoldedFileAuthIndex: new Map(),
  };
  (items ?? []).forEach((item) => {
    const fileName = fileIdentity(item.auth_file_snapshot);
    if (!fileName) return;
    const history = toCodexCreditsHistory(item);
    if (history.points.length === 0) return;
    const authIndex = indexIdentity(item.auth_index);
    if (authIndex) {
      addUniqueHistory(lookup.byFileAuthIndex, JSON.stringify([fileName, authIndex]), history);
      addUniqueHistory(lookup.byFoldedFileAuthIndex, JSON.stringify([fileName.toLowerCase(), authIndex]), history);
    } else {
      addUniqueHistory(lookup.byFileName, fileName, history);
    }
  });
  return lookup;
};

export const getCodexCreditsHistoryForAuthFile = (
  lookup: CodexCreditsHistoryLookup | undefined,
  file: { name?: string; authIndex?: unknown; auth_index?: unknown; 'auth-index'?: unknown }
): CodexCreditsHistory | undefined => {
  if (!lookup) return undefined;
  const fileName = fileIdentity(file.name);
  if (!fileName) return undefined;
  const rawIndex = file.auth_index ?? file.authIndex ?? file['auth-index'];
  const authIndex = indexIdentity(rawIndex);
  if (!authIndex) return lookup.byFileName.get(fileName) ?? undefined;
  const exact = lookup.byFileAuthIndex.get(JSON.stringify([fileName, authIndex]));
  if (exact !== undefined) return exact ?? undefined;
  // 旧快照偶尔与文件清单大小写不同，仅在认证索引完全相同且唯一时兼容。
  return lookup.byFoldedFileAuthIndex.get(JSON.stringify([fileName.toLowerCase(), authIndex])) ?? undefined;
};
