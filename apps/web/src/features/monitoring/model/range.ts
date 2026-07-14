import { getRangeBounds as getSharedRangeBounds } from '@/shared/model/timeRange';
import type { MonitoringCustomTimeRange, MonitoringTimeRange } from './types';

export const padNumber = (value: number) => String(value).padStart(2, '0');

export const buildLocalDayKey = (timestampMs: number) => {
  const date = new Date(timestampMs);
  return `${date.getFullYear()}-${padNumber(date.getMonth() + 1)}-${padNumber(date.getDate())}`;
};

export const buildHourLabel = (timestampMs: number) =>
  `${padNumber(new Date(timestampMs).getHours())}:00`;

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
