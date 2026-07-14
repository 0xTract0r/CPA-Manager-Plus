import { describe, expect, it } from 'vitest';
import { getRangeBounds, startOfLocalDayMs } from './timeRange';

// 固定锚点:2026-05-19 10:30:00(本地时区),避免测试受运行环境时区/系统时钟影响。
const NOW_MS = new Date(2026, 4, 19, 10, 30, 0, 0).getTime();
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

describe('getRangeBounds', () => {
  it('1h 是滚动窗口 nowMs - 1h', () => {
    const bounds = getRangeBounds({ preset: '1h', nowMs: NOW_MS });
    expect(bounds).toEqual({ fromMs: NOW_MS - HOUR_MS, toMs: NOW_MS });
  });

  it('3h 是滚动窗口 nowMs - 3h', () => {
    const bounds = getRangeBounds({ preset: '3h', nowMs: NOW_MS });
    expect(bounds).toEqual({ fromMs: NOW_MS - 3 * HOUR_MS, toMs: NOW_MS });
  });

  it('24h 是滚动窗口 nowMs - 24h', () => {
    const bounds = getRangeBounds({ preset: '24h', nowMs: NOW_MS });
    expect(bounds).toEqual({ fromMs: NOW_MS - DAY_MS, toMs: NOW_MS });
  });

  it('7d 是滚动窗口 nowMs - 7*24h', () => {
    const bounds = getRangeBounds({ preset: '7d', nowMs: NOW_MS });
    expect(bounds).toEqual({ fromMs: NOW_MS - 7 * DAY_MS, toMs: NOW_MS });
  });

  it('14d 是滚动窗口 nowMs - 14*24h', () => {
    const bounds = getRangeBounds({ preset: '14d', nowMs: NOW_MS });
    expect(bounds).toEqual({ fromMs: NOW_MS - 14 * DAY_MS, toMs: NOW_MS });
  });

  it('30d 是滚动窗口 nowMs - 30*24h', () => {
    const bounds = getRangeBounds({ preset: '30d', nowMs: NOW_MS });
    expect(bounds).toEqual({ fromMs: NOW_MS - 30 * DAY_MS, toMs: NOW_MS });
  });

  it('today 是本地零点到 nowMs', () => {
    const bounds = getRangeBounds({ preset: 'today', nowMs: NOW_MS });
    const expectedStart = new Date(2026, 4, 19, 0, 0, 0, 0).getTime();
    expect(bounds).toEqual({ fromMs: expectedStart, toMs: NOW_MS });
  });

  it('yesterday 是昨天本地零点到今天本地零点', () => {
    const bounds = getRangeBounds({ preset: 'yesterday', nowMs: NOW_MS });
    const todayStart = new Date(2026, 4, 19, 0, 0, 0, 0).getTime();
    const yesterdayStart = new Date(2026, 4, 18, 0, 0, 0, 0).getTime();
    expect(bounds).toEqual({ fromMs: yesterdayStart, toMs: todayStart });
  });

  it('all 兜底为负无穷到 nowMs', () => {
    const bounds = getRangeBounds({ preset: 'all', nowMs: NOW_MS });
    expect(bounds).toEqual({ fromMs: Number.NEGATIVE_INFINITY, toMs: NOW_MS });
  });

  it('custom 使用传入的 customRange', () => {
    const customRange = { startMs: NOW_MS - 5000, endMs: NOW_MS - 1000 };
    const bounds = getRangeBounds({ preset: 'custom', nowMs: NOW_MS, customRange });
    expect(bounds).toEqual({ fromMs: customRange.startMs, toMs: customRange.endMs });
  });

  it('custom 缺失时返回 null', () => {
    const bounds = getRangeBounds({ preset: 'custom', nowMs: NOW_MS, customRange: null });
    expect(bounds).toBeNull();
  });

  it('custom 非法(start > end)时返回 null', () => {
    const customRange = { startMs: NOW_MS, endMs: NOW_MS - 1000 };
    const bounds = getRangeBounds({ preset: 'custom', nowMs: NOW_MS, customRange });
    expect(bounds).toBeNull();
  });

  it('custom 非法(非有限数)时返回 null', () => {
    const customRange = { startMs: Number.NaN, endMs: NOW_MS };
    const bounds = getRangeBounds({ preset: 'custom', nowMs: NOW_MS, customRange });
    expect(bounds).toBeNull();
  });

  it('未知 preset 兜底走 all 分支', () => {
    const bounds = getRangeBounds({
      preset: 'unknown' as unknown as 'all',
      nowMs: NOW_MS,
    });
    expect(bounds).toEqual({ fromMs: Number.NEGATIVE_INFINITY, toMs: NOW_MS });
  });
});

describe('startOfLocalDayMs', () => {
  it('返回本地时区当天零点', () => {
    const result = startOfLocalDayMs(NOW_MS);
    expect(result).toBe(new Date(2026, 4, 19, 0, 0, 0, 0).getTime());
  });

  it('跨日边界:传入零点前一毫秒应回退到前一天零点', () => {
    const beforeMidnight = new Date(2026, 4, 19, 0, 0, 0, 0).getTime() - 1;
    const result = startOfLocalDayMs(beforeMidnight);
    expect(result).toBe(new Date(2026, 4, 18, 0, 0, 0, 0).getTime());
  });
});
