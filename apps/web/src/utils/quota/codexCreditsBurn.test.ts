import { describe, expect, it } from 'vitest';
import {
  classifyCodexCreditsBurn,
  computeCodexCreditsBurnForecast,
  formatCodexCreditsCompact,
  formatCodexCreditsRate,
  normalizeCodexCreditsPoints,
  type CodexCreditsBalancePoint,
  type CodexCreditsHistory,
} from './codexCreditsBurn';

const HOUR = 60 * 60 * 1000;
const at = (iso: string) => new Date(iso).getTime();
const point = (iso: string, balance: number, quotaExhausted = true): CodexCreditsBalancePoint => ({
  timestampMs: at(iso),
  balance,
  quotaExhausted,
});
const history = (
  points: CodexCreditsBalancePoint[],
  quotaResetAtMs: number | null = at('2026-11-19T05:18:00+08:00')
): CodexCreditsHistory => ({ points, quotaResetAtMs, windowStartMs: null, unlimited: false });

// 生产真实形态：周额度 11-14 00:35 用满（余额 59,897），到 17:35 余额 56,677。
const productionPoints = [
  point('2026-11-13T22:00:00+08:00', 59897, false),
  point('2026-11-14T00:35:00+08:00', 59897),
  point('2026-11-14T02:00:00+08:00', 59513),
  point('2026-11-14T04:00:00+08:00', 58719),
  point('2026-11-14T08:00:00+08:00', 58175),
  point('2026-11-14T12:00:00+08:00', 57707),
  point('2026-11-14T16:00:00+08:00', 56812),
  point('2026-11-14T17:35:00+08:00', 56677),
];
const productionNow = at('2026-11-14T17:35:00+08:00');

describe('computeCodexCreditsBurnForecast', () => {
  it('uses the exhaustion moment as start and forecasts until the weekly reset', () => {
    const forecast = computeCodexCreditsBurnForecast(history(productionPoints), {
      nowMs: productionNow,
    });

    expect(forecast).not.toBeNull();
    expect(forecast!.startIsExhaustion).toBe(true);
    expect(forecast!.startMs).toBe(at('2026-11-14T00:35:00+08:00'));
    expect(forecast!.startBalance).toBe(59897);
    expect(forecast!.currentBalance).toBe(56677);
    expect(forecast!.used).toBe(3220);
    // 实际经过 17 小时：3220 / 17 ≈ 189.4
    expect(forecast!.ratePerHour).toBeCloseTo(3220 / 17, 3);
    const remainingHours = (at('2026-11-19T05:18:00+08:00') - productionNow) / HOUR;
    expect(forecast!.projected).toBeCloseTo((3220 / 17) * remainingHours, 3);
    expect(forecast!.percent).toBeCloseTo(((3220 / 17) * remainingHours * 100) / 56677, 3);
    expect(forecast!.level).toBe('ok');
    expect(forecast!.runOutAtMs).toBeNull();
  });

  it('falls back to the first point and marks "recent N hours" when exhaustion is unknown', () => {
    const points = productionPoints.slice(1).map((item) => ({ ...item, quotaExhausted: false }));
    const forecast = computeCodexCreditsBurnForecast(history(points), { nowMs: productionNow });

    expect(forecast!.startIsExhaustion).toBe(false);
    expect(forecast!.startBalance).toBe(59897);
    expect(forecast!.sinceHours).toBe(17);
    expect(forecast!.used).toBe(3220);
  });

  it('adds real recharges back so used never goes negative', () => {
    const points = [
      point('2026-11-14T00:00:00+08:00', 1000),
      point('2026-11-14T02:00:00+08:00', 800),
      point('2026-11-14T03:00:00+08:00', 5000),
      point('2026-11-14T05:00:00+08:00', 4700),
      point('2026-11-14T07:00:00+08:00', 4500),
    ];
    const forecast = computeCodexCreditsBurnForecast(history(points), {
      nowMs: at('2026-11-14T07:00:00+08:00'),
    });

    // 首点就已用满 → 不算「额度用完后」；+4200 为真实充值：已用 = 1000 − 4500 + 4200
    expect(forecast!.startIsExhaustion).toBe(false);
    expect(forecast!.startBalance).toBe(1000);
    expect(forecast!.used).toBe(700);
    expect(forecast!.ratePerHour).toBeCloseTo(100, 6);
  });

  describe('15-hour production-like series (3,220 used)', () => {
    const now = at('2026-11-14T17:35:00+08:00');
    const base = [
      point('2026-11-14T02:00:00+08:00', 59897, false),
      point('2026-11-14T02:35:00+08:00', 59897),
      point('2026-11-14T04:00:00+08:00', 59513),
      point('2026-11-14T06:00:00+08:00', 58719),
      point('2026-11-14T10:00:00+08:00', 58175),
      point('2026-11-14T12:30:00+08:00', 57870.39),
      point('2026-11-14T14:00:00+08:00', 57707),
      point('2026-11-14T16:00:00+08:00', 56812),
      point('2026-11-14T17:35:00+08:00', 56677),
    ];

    it('ignores a small concurrent-response jitter (+5)', () => {
      const withJitter = [
        ...base.slice(0, 6),
        point('2026-11-14T12:31:00+08:00', 57875.39),
        ...base.slice(6),
      ];
      const clean = computeCodexCreditsBurnForecast(history(base), { nowMs: now });
      const jittered = computeCodexCreditsBurnForecast(history(withJitter), { nowMs: now });

      expect(clean!.used).toBeCloseTo(3220, 6);
      expect(clean!.startIsExhaustion).toBe(true);
      expect(clean!.ratePerHour).toBeCloseTo(3220 / 15, 6);
      expect(jittered).toEqual(clean);
    });

    it('recognizes a +5,000 rise as a recharge', () => {
      const recharged = [
        ...base.slice(0, 6),
        point('2026-11-14T13:00:00+08:00', 62870.39),
        point('2026-11-14T14:00:00+08:00', 62707),
        point('2026-11-14T16:00:00+08:00', 61812),
        point('2026-11-14T17:35:00+08:00', 61677),
      ];
      const forecast = computeCodexCreditsBurnForecast(history(recharged), { nowMs: now });

      expect(forecast!.currentBalance).toBe(61677);
      expect(forecast!.startBalance).toBe(59897);
      expect(forecast!.used).toBeCloseTo(3220, 6);
      expect(forecast!.ratePerHour).toBeCloseTo(3220 / 15, 6);
    });
  });

  it('uses wall-clock hours for the rate so overnight idle lowers it', () => {
    const points = [
      point('2026-11-13T23:00:00+08:00', 10000, false),
      point('2026-11-14T00:00:00+08:00', 10000),
      point('2026-11-14T03:00:00+08:00', 9400),
      point('2026-11-14T06:00:00+08:00', 8800),
      point('2026-11-14T18:00:00+08:00', 8800),
    ];
    const forecast = computeCodexCreditsBurnForecast(history(points), {
      nowMs: at('2026-11-14T18:00:00+08:00'),
    });

    // 6 小时内用 1200，之后 12 小时空闲：速率按墙钟 18 小时算，不是 1200 / 6
    expect(forecast!.used).toBe(1200);
    expect(forecast!.ratePerHour).toBeCloseTo(1200 / 18, 6);
  });

  it('labels "recent N hours" when the first point is already exhausted', () => {
    const points = productionPoints.slice(1);
    const forecast = computeCodexCreditsBurnForecast(history(points), { nowMs: productionNow });

    expect(forecast!.startIsExhaustion).toBe(false);
    expect(forecast!.sinceHours).toBe(17);
    expect(forecast!.used).toBe(3220);
  });

  it('only counts the last 24 hours for the rate', () => {
    const points = [
      point('2026-11-12T00:00:00+08:00', 10000),
      point('2026-11-13T00:00:00+08:00', 5000),
      point('2026-11-13T12:00:00+08:00', 4800),
      point('2026-11-14T00:00:00+08:00', 4600),
    ];
    const forecast = computeCodexCreditsBurnForecast(history(points), {
      nowMs: at('2026-11-14T00:00:00+08:00'),
    });

    expect(forecast!.used).toBe(5400);
    // 最近 24 小时：5000 → 4600 = 400 / 24h
    expect(forecast!.ratePerHour).toBeCloseTo(400 / 24, 6);
  });

  it('hides rate and forecast with less than 1 hour of data', () => {
    const points = [
      point('2026-11-14T10:00:00+08:00', 1000),
      point('2026-11-14T10:20:00+08:00', 990),
      point('2026-11-14T10:40:00+08:00', 980),
    ];
    const forecast = computeCodexCreditsBurnForecast(history(points), {
      nowMs: at('2026-11-14T10:40:00+08:00'),
    });

    expect(forecast!.used).toBe(20);
    expect(forecast!.ratePerHour).toBeNull();
    expect(forecast!.projected).toBeNull();
    expect(forecast!.level).toBeNull();
  });

  it('hides rate and forecast with fewer than 3 change points', () => {
    const points = [
      point('2026-11-14T00:00:00+08:00', 1000),
      point('2026-11-14T05:00:00+08:00', 900),
      point('2026-11-14T09:00:00+08:00', 900),
    ];
    const forecast = computeCodexCreditsBurnForecast(history(points), {
      nowMs: at('2026-11-14T09:00:00+08:00'),
    });

    expect(forecast!.used).toBe(100);
    expect(forecast!.ratePerHour).toBeNull();
    expect(forecast!.percent).toBeNull();
  });

  it('classifies tight and short forecasts and reports the run-out time', () => {
    const nowMs = at('2026-11-14T12:00:00+08:00');
    const points = [
      point('2026-11-14T00:00:00+08:00', 12000),
      point('2026-11-14T06:00:00+08:00', 9000),
      point('2026-11-14T12:00:00+08:00', 6000),
    ];
    // 速率 500/h；剩 10 小时 → 预测 5000 / 6000 = 83% 偏紧
    const tight = computeCodexCreditsBurnForecast(history(points, nowMs + 10 * HOUR), { nowMs });
    expect(tight!.level).toBe('tight');
    expect(tight!.percent).toBeCloseTo(83.333, 2);
    expect(tight!.runOutAtMs).toBeNull();

    // 剩 20 小时 → 预测 10000 > 6000 可能不够，12 小时后用完，进度条封顶 100
    const short = computeCodexCreditsBurnForecast(history(points, nowMs + 20 * HOUR), { nowMs });
    expect(short!.level).toBe('short');
    expect(short!.percent).toBe(100);
    expect(short!.projected).toBeCloseTo(10000, 6);
    expect(short!.runOutAtMs).toBe(nowMs + 12 * HOUR);
  });

  it('keeps rate but omits forecast when the reset time is unknown or past', () => {
    const forecast = computeCodexCreditsBurnForecast(history(productionPoints, null), {
      nowMs: productionNow,
    });
    expect(forecast!.ratePerHour).not.toBeNull();
    expect(forecast!.projected).toBeNull();

    const past = computeCodexCreditsBurnForecast(history(productionPoints, productionNow - HOUR), {
      nowMs: productionNow,
    });
    expect(past!.projected).toBeNull();
  });

  it('returns null for unlimited credits or an empty series', () => {
    expect(
      computeCodexCreditsBurnForecast({ ...history(productionPoints), unlimited: true })
    ).toBeNull();
    expect(computeCodexCreditsBurnForecast(history([]))).toBeNull();
    expect(computeCodexCreditsBurnForecast(null)).toBeNull();
  });

  it('appends a fresher card balance as the latest point', () => {
    const forecast = computeCodexCreditsBurnForecast(history(productionPoints), {
      nowMs: productionNow + HOUR,
      currentBalance: 56477,
    });
    expect(forecast!.currentBalance).toBe(56477);
    expect(forecast!.used).toBe(3420);
  });

  it('ignores a card balance that is higher or within rounding of the latest point', () => {
    const forecast = computeCodexCreditsBurnForecast(history(productionPoints), {
      nowMs: productionNow,
      currentBalance: 56677.31,
    });
    expect(forecast!.startIsExhaustion).toBe(true);
    expect(forecast!.used).toBe(3220);
  });
});

describe('classifyCodexCreditsBurn', () => {
  it('uses 70% and 100% thresholds', () => {
    expect(classifyCodexCreditsBurn(69.9)).toBe('ok');
    expect(classifyCodexCreditsBurn(70)).toBe('tight');
    expect(classifyCodexCreditsBurn(100)).toBe('tight');
    expect(classifyCodexCreditsBurn(100.1)).toBe('short');
  });
});

describe('normalizeCodexCreditsPoints', () => {
  it('sorts points and drops invalid entries', () => {
    expect(
      normalizeCodexCreditsPoints([
        { timestamp_ms: 2000, balance: 5, quota_exhausted: true },
        { timestamp_ms: 1000, balance: '7.5' },
        { timestamp_ms: 0, balance: 1 },
        { timestamp_ms: 3000, balance: -1 },
        null,
      ])
    ).toEqual([
      { timestampMs: 1000, balance: 7.5, quotaExhausted: false },
      { timestampMs: 2000, balance: 5, quotaExhausted: true },
    ]);
    expect(normalizeCodexCreditsPoints(undefined)).toEqual([]);
  });
});

describe('credits number formatting', () => {
  it('uses 万 for Chinese and k for English above ten thousand', () => {
    expect(formatCodexCreditsCompact(22617, 'zh-CN')).toBe('2.3万');
    expect(formatCodexCreditsCompact(56677, 'zh-CN')).toBe('5.7万');
    expect(formatCodexCreditsCompact(56677, 'zh-TW')).toBe('5.7萬');
    expect(formatCodexCreditsCompact(22617, 'en')).toBe('22.6K');
    expect(formatCodexCreditsCompact(3220, 'zh-CN')).toBe('3,220');
    expect(formatCodexCreditsCompact(3220, 'en')).toBe('3,220');
  });

  it('formats the hourly rate', () => {
    expect(formatCodexCreditsRate(189.41, 'en')).toBe('189');
    expect(formatCodexCreditsRate(1234.4, 'en')).toBe('1,234');
    expect(formatCodexCreditsRate(4.26, 'en')).toBe('4.3');
  });
});

describe('buildCodexCreditsHistoryLookup', () => {
  it('matches by auth file + auth index with high confidence only', async () => {
    const { buildCodexCreditsHistoryLookup, getCodexCreditsHistoryForAuthFile } = await import(
      './codexCreditsBurn'
    );
    const lookup = buildCodexCreditsHistoryLookup([
      {
        auth_file_snapshot: 'Codex-Pro.json',
        auth_index: 'auth-1',
        quota_reset_at_ms: 5000,
        points: [{ timestamp_ms: 1000, balance: 10, quota_exhausted: true }],
      },
      { auth_file_snapshot: 'legacy.json', points: [{ timestamp_ms: 1000, balance: 3 }] },
      { auth_index: 'orphan', points: [{ timestamp_ms: 1000, balance: 3 }] },
    ]);
    expect(
      getCodexCreditsHistoryForAuthFile(lookup, { name: 'codex-pro.json', authIndex: 'auth-1' })
    ).toMatchObject({ quotaResetAtMs: 5000, unlimited: false, points: [{ balance: 10 }] });
    expect(
      getCodexCreditsHistoryForAuthFile(lookup, { name: 'codex-pro.json', authIndex: 'auth-2' })
    ).toBeUndefined();
    expect(getCodexCreditsHistoryForAuthFile(lookup, { name: 'legacy.json' })?.points).toHaveLength(1);
    expect(getCodexCreditsHistoryForAuthFile(lookup, { name: 'other.json' })).toBeUndefined();
  });
});
