// 统一时间范围计算模块。
//
// 背景:监控页(features/monitoring/model/range.ts::getRangeBounds)和分析页
// (features/usage-analytics/usageAnalyticsModel.ts::getUsageRangeBounds)各自维护
// 一套 range 计算,口径不一致(例如 7d/14d/30d 在监控页是"自然日锚定",在分析页是
// "纯滚动 N*24h")。本模块抽出统一、可测试的时间范围计算,后续两个页面应迁移到
// 这里的实现,不再各写一套。
//
// nowMs 由调用方传入,约定取 lastRefreshedAt(数据刷新时间戳)而非 Date.now(),
// 以保证同一次渲染内所有时间计算基于同一个锚点、可测试、可重放。

export type TimeRangePreset =
  | '1h'
  | '3h'
  | '24h'
  | 'today'
  | 'yesterday'
  | '7d'
  | '14d'
  | '30d'
  | 'all'
  | 'custom';

export type TimeRangeCustomRange = {
  startMs: number;
  endMs: number;
};

export type TimeRangeBounds = {
  fromMs: number;
  toMs: number;
};

export type GetRangeBoundsInput = {
  preset: TimeRangePreset;
  nowMs: number;
  customRange?: TimeRangeCustomRange | null;
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** 本地时区当天零点(00:00:00.000)对应的时间戳。 */
export const startOfLocalDayMs = (timestampMs: number): number => {
  const date = new Date(timestampMs);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

const isValidCustomRange = (
  range: TimeRangeCustomRange | null | undefined
): range is TimeRangeCustomRange =>
  Boolean(
    range &&
      Number.isFinite(range.startMs) &&
      Number.isFinite(range.endMs) &&
      range.startMs <= range.endMs
  );

/**
 * 计算给定 preset 的时间范围边界。
 *
 * 语义:
 * - 相对滚动档('1h'/'3h'/'24h'/'7d'/'14d'/'30d'):[nowMs - N, nowMs]。
 * - 'today':[本地零点, nowMs]。
 * - 'yesterday':[昨天本地零点, 今天本地零点]。
 * - 'all':兜底大范围,[负无穷, nowMs]。
 * - 'custom':使用调用方传入的 customRange;缺失或非法时返回 null。
 */
export const getRangeBounds = ({
  preset,
  nowMs,
  customRange,
}: GetRangeBoundsInput): TimeRangeBounds | null => {
  if (preset === 'custom') {
    return isValidCustomRange(customRange)
      ? { fromMs: customRange.startMs, toMs: customRange.endMs }
      : null;
  }

  switch (preset) {
    case '1h':
      return { fromMs: nowMs - HOUR_MS, toMs: nowMs };
    case '3h':
      return { fromMs: nowMs - 3 * HOUR_MS, toMs: nowMs };
    case '24h':
      return { fromMs: nowMs - DAY_MS, toMs: nowMs };
    case '7d':
      return { fromMs: nowMs - 7 * DAY_MS, toMs: nowMs };
    case '14d':
      return { fromMs: nowMs - 14 * DAY_MS, toMs: nowMs };
    case '30d':
      return { fromMs: nowMs - 30 * DAY_MS, toMs: nowMs };
    case 'today':
      return { fromMs: startOfLocalDayMs(nowMs), toMs: nowMs };
    case 'yesterday': {
      const todayStart = startOfLocalDayMs(nowMs);
      return { fromMs: todayStart - DAY_MS, toMs: todayStart };
    }
    case 'all':
    default:
      return { fromMs: Number.NEGATIVE_INFINITY, toMs: nowMs };
  }
};
