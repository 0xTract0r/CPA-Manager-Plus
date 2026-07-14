import { describe, expect, it } from 'vitest';
import { getRangeBounds, shouldUseHourlyTimeline } from './range';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const NOW_MS = Date.parse('2026-07-11T15:30:00.000Z');

describe('getRangeBounds (monitoring, delegates to shared/model/timeRange)', () => {
  it('computes rolling bounds for the new short relative presets', () => {
    expect(getRangeBounds('1h', NOW_MS)).toEqual({ startMs: NOW_MS - HOUR_MS, endMs: NOW_MS });
    expect(getRangeBounds('3h', NOW_MS)).toEqual({
      startMs: NOW_MS - 3 * HOUR_MS,
      endMs: NOW_MS,
    });
    expect(getRangeBounds('24h', NOW_MS)).toEqual({ startMs: NOW_MS - DAY_MS, endMs: NOW_MS });
  });

  it('computes rolling (not day-anchored) bounds for 7d/14d/30d after the shared-module migration', () => {
    // 迁移前 7d/14d/30d 是"自然日锚定"(今天零点 - N-1 天)；迁移共享模块后改为纯滚动
    // (nowMs - N*24h)，与分析页保持一致。这是本次改造的预期行为变化。
    expect(getRangeBounds('7d', NOW_MS)).toEqual({
      startMs: NOW_MS - 7 * DAY_MS,
      endMs: NOW_MS,
    });
    expect(getRangeBounds('14d', NOW_MS)).toEqual({
      startMs: NOW_MS - 14 * DAY_MS,
      endMs: NOW_MS,
    });
    expect(getRangeBounds('30d', NOW_MS)).toEqual({
      startMs: NOW_MS - 30 * DAY_MS,
      endMs: NOW_MS,
    });
  });

  it('computes local-midnight bounds for today/yesterday', () => {
    const todayStart = new Date(NOW_MS);
    todayStart.setHours(0, 0, 0, 0);

    expect(getRangeBounds('today', NOW_MS)).toEqual({
      startMs: todayStart.getTime(),
      endMs: NOW_MS,
    });
    expect(getRangeBounds('yesterday', NOW_MS)).toEqual({
      startMs: todayStart.getTime() - DAY_MS,
      endMs: todayStart.getTime(),
    });
  });

  it('falls back to negative infinity start for "all"', () => {
    expect(getRangeBounds('all', NOW_MS)).toEqual({
      startMs: Number.NEGATIVE_INFINITY,
      endMs: NOW_MS,
    });
  });

  it('returns custom range bounds when valid, and null when invalid/missing', () => {
    expect(getRangeBounds('custom', NOW_MS, { startMs: 1, endMs: 2 })).toEqual({
      startMs: 1,
      endMs: 2,
    });
    expect(getRangeBounds('custom', NOW_MS, null)).toBeNull();
    expect(getRangeBounds('custom', NOW_MS, { startMs: 5, endMs: 1 })).toBeNull();
  });
});

describe('shouldUseHourlyTimeline', () => {
  it('uses hourly granularity for all short relative presets and calendar-day presets', () => {
    expect(shouldUseHourlyTimeline('1h')).toBe(true);
    expect(shouldUseHourlyTimeline('3h')).toBe(true);
    expect(shouldUseHourlyTimeline('24h')).toBe(true);
    expect(shouldUseHourlyTimeline('today')).toBe(true);
    expect(shouldUseHourlyTimeline('yesterday')).toBe(true);
  });

  it('uses daily granularity for multi-day relative presets and "all"', () => {
    expect(shouldUseHourlyTimeline('7d')).toBe(false);
    expect(shouldUseHourlyTimeline('14d')).toBe(false);
    expect(shouldUseHourlyTimeline('30d')).toBe(false);
    expect(shouldUseHourlyTimeline('all')).toBe(false);
  });

  it('uses hourly granularity for a custom range confined to a single local day', () => {
    const dayStart = new Date(NOW_MS);
    dayStart.setHours(0, 0, 0, 0);
    expect(
      shouldUseHourlyTimeline('custom', { startMs: dayStart.getTime(), endMs: NOW_MS })
    ).toBe(true);
  });

  it('uses daily granularity for a custom range spanning multiple local days', () => {
    expect(shouldUseHourlyTimeline('custom', { startMs: NOW_MS - 3 * DAY_MS, endMs: NOW_MS })).toBe(
      false
    );
  });
});
