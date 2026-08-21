import { formatDayAxisUtc8, getUtc8Parts } from '@/utils/datetime';
import { getRangeBounds as getSharedRangeBounds } from '@/shared/model/timeRange';
import type { MonitoringCustomTimeRange, MonitoringTimeRange } from './types';

export const padNumber = (value: number) => String(value).padStart(2, '0');

// 图表按「天」分桶的 key，走全局时区（默认 UTC+8），使分桶/日轴标签与全站展示一致，
// 不再跟随浏览器本地时区。格式仍为 `YYYY-MM-DD`（formatDayAxisUtc8 用 en-CA 保证顺序）。
export const buildLocalDayKey = (timestampMs: number) =>
  formatDayAxisUtc8(timestampMs) || '';

// 小时轴标签 `HH:00`，走全局时区（默认 UTC+8），替换手工 getHours（读浏览器本地时区）。
export const buildHourLabel = (timestampMs: number) => {
  const parts = getUtc8Parts(timestampMs);
  return `${parts ? parts.hour : '00'}:00`;
};

export const buildDayLabel = (dayKey: string) => dayKey.slice(5).replace('-', '/');

const isValidCustomTimeRange = (
  range: MonitoringCustomTimeRange | null | undefined
): range is MonitoringCustomTimeRange =>
  Boolean(
    range &&
      Number.isFinite(range.startMs) &&
      Number.isFinite(range.endMs) &&
      range.startMs <= range.endMs
  );

// 委托给 shared/model/timeRange 统一计算，本函数只负责把监控页的 startMs/endMs
// 命名习惯适配到共享模块的 fromMs/toMs。相对滚动档(1h/3h/24h/7d/14d/30d)在共享
// 模块里是纯滚动语义([nowMs - N, nowMs])；监控页多日档此前是"自然日锚定"，
// 迁移后与分析页对齐为滚动语义——这是本次改造的预期行为变化，不是回归。
export const getRangeBounds = (
  range: MonitoringTimeRange,
  nowMs: number,
  customRange?: MonitoringCustomTimeRange | null
) => {
  const bounds = getSharedRangeBounds({ preset: range, nowMs, customRange });
  if (!bounds) return null;
  return { startMs: bounds.fromMs, endMs: bounds.toMs };
};

export const shouldUseHourlyTimeline = (
  range: MonitoringTimeRange,
  customRange?: MonitoringCustomTimeRange | null
) =>
  range === '1h' ||
  range === '3h' ||
  range === '24h' ||
  range === 'today' ||
  range === 'yesterday' ||
  (range === 'custom' &&
    isValidCustomTimeRange(customRange) &&
    buildLocalDayKey(customRange.startMs) === buildLocalDayKey(customRange.endMs));
