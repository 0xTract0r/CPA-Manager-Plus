import React from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';
import type { AuthFileItem, CodexQuotaState } from '@/types';
import type { UsageHeaderSnapshot } from '@/services/api/usageService';
import type { CoreQuotaSnapshotEntry } from '@/services/api/quotaSnapshots';
import { buildObservedCodexQuotaStateFromCoreSnapshot } from '@/utils/quota/coreQuotaSnapshots';
import styles from '@/features/quota/QuotaPage.module.scss';
import zhCN from '@/i18n/locales/zh-CN.json';
import en from '@/i18n/locales/en.json';
import type { QuotaRenderHelpers } from './QuotaCard';
import {
  CLAUDE_CONFIG,
  CODEX_CONFIG,
  buildObservedCodexQuotaState,
  formatCodexCreditsBalance,
  getSortedCodexResetCreditExpiries,
  preferFresherCodexCredits,
  resolveQuotaDisplayState,
} from './quotaConfigs';

type TestQuotaState = {
  status: 'idle' | 'loading' | 'success' | 'error';
  errorStatus?: number;
  fetchedAtMs?: number;
  observedAtMs?: number;
  observedFromUsageHeaders?: boolean;
  windows?: unknown[];
};

describe('getSortedCodexResetCreditExpiries', () => {
  it('filters expired or invalid reset credits and sorts by expiry time', () => {
    const expiries = getSortedCodexResetCreditExpiries(
      [
        {
          id: 'late',
          status: 'available',
          grantedAt: '2026-06-29T00:00:00Z',
          expiresAt: '2026-07-19T00:42:09Z',
        },
        {
          id: 'expired',
          status: 'available',
          grantedAt: '2026-06-29T00:00:00Z',
          expiresAt: '2026-07-17T08:31:33Z',
        },
        {
          id: 'invalid',
          status: 'available',
          grantedAt: '2026-06-29T00:00:00Z',
          expiresAt: 'not-a-date',
        },
        {
          id: 'early',
          status: 'available',
          grantedAt: '2026-06-29T00:00:00Z',
          expiresAt: '2026-07-18T08:31:33Z',
        },
      ],
      new Date('2026-07-18T00:00:00Z').getTime()
    );

    expect(expiries.map((item) => item.id)).toEqual(['early', 'late']);
    expect(expiries.map((item) => item.expiresAtMs)).toEqual([
      new Date('2026-07-18T08:31:33Z').getTime(),
      new Date('2026-07-19T00:42:09Z').getTime(),
    ]);
  });
});

describe('CLAUDE_CONFIG', () => {
  it('marks a successful upstream refresh as direct and records its refresh time', () => {
    const before = Date.now();
    const state = CLAUDE_CONFIG.buildSuccessState({ windows: [], planType: null });
    const after = Date.now();

    expect(state.source).toBe('direct');
    expect(state.nextRefreshAt).toBeNull();
    expect(Date.parse(state.lastRefreshedAt || '')).toBeGreaterThanOrEqual(before);
    expect(Date.parse(state.lastRefreshedAt || '')).toBeLessThanOrEqual(after);
  });
});

describe('resolveQuotaDisplayState', () => {
  it('keeps a newer manual quota refresh over an older header snapshot', () => {
    const activeQuota: TestQuotaState = {
      status: 'success',
      fetchedAtMs: 2_000,
      windows: [],
    };
    const observedQuota: TestQuotaState = {
      status: 'success',
      observedAtMs: 1_000,
      observedFromUsageHeaders: true,
      windows: [],
    };

    expect(resolveQuotaDisplayState(activeQuota, observedQuota)).toBe(activeQuota);
  });

  it('merges a newer header snapshot into the manual quota refresh', () => {
    const activeQuota: TestQuotaState = {
      status: 'success',
      fetchedAtMs: 1_000,
      windows: [
        {
          id: 'manual',
          label: 'Manual window',
          usedPercent: 10,
          resetLabel: '06/30 12:00',
        },
      ],
    };
    const observedQuota: TestQuotaState = {
      status: 'success',
      observedAtMs: 2_000,
      observedFromUsageHeaders: true,
      windows: [
        {
          id: 'observed',
          label: 'Observed window',
          usedPercent: 20,
          resetLabel: '07/01 12:00',
        },
      ],
    };

    const result = resolveQuotaDisplayState(activeQuota, observedQuota);

    expect(result).not.toBe(activeQuota);
    expect(result).not.toBe(observedQuota);
    expect(result).toMatchObject({
      status: 'success',
      fetchedAtMs: 1_000,
      observedAtMs: 2_000,
      windows: [
        { id: 'manual', usedPercent: 10 },
        { id: 'observed', usedPercent: 20 },
      ],
    });
  });

  it('keeps API-only Codex quota data when merging newer header snapshots', () => {
    const activeQuota: CodexQuotaState = {
      status: 'success',
      fetchedAtMs: 1_000,
      planType: 'plus',
      windows: [
        {
          id: 'five-hour',
          label: '5-hour limit',
          labelKey: 'codex_quota.primary_window',
          usedPercent: 10,
          resetLabel: '06/30 12:00',
          limitWindowSeconds: 18_000,
        },
        {
          id: 'spark-five-hour-0',
          label: 'Spark 5-hour limit',
          labelKey: 'codex_quota.additional_primary_window',
          labelParams: { name: 'spark' },
          usedPercent: 30,
          resetLabel: '07/01 01:00',
          limitWindowSeconds: 18_000,
        },
      ],
      rateLimitResetCreditsAvailableCount: 2,
      rateLimitResetCredits: [
        {
          id: 'credit-1',
          status: 'available',
          grantedAt: '2026-06-29T00:00:00Z',
          expiresAt: '2026-07-19T00:42:09Z',
        },
      ],
      rateLimitResetCreditsError: null,
    };
    const observedQuota: CodexQuotaState = {
      status: 'success',
      observedFromUsageHeaders: true,
      observedResetCreditsUnknown: true,
      observedAtMs: 2_000,
      planType: 'free',
      windows: [
        {
          id: 'five-hour',
          label: '5-hour limit',
          labelKey: 'codex_quota.primary_window',
          usedPercent: 80,
          resetLabel: '07/01 02:00',
          limitWindowSeconds: null,
        },
        {
          id: 'weekly',
          label: 'Weekly limit',
          labelKey: 'codex_quota.secondary_window',
          usedPercent: 40,
          resetLabel: '07/07 02:00',
          limitWindowSeconds: 604_800,
        },
      ],
    };

    const result = resolveQuotaDisplayState(activeQuota, observedQuota) as CodexQuotaState;

    expect(result.planType).toBe('free');
    expect(result.observedAtMs).toBe(2_000);
    expect(result.observedFromUsageHeaders).toBe(true);
    expect(result.observedResetCreditsUnknown).toBeUndefined();
    expect(result.rateLimitResetCreditsAvailableCount).toBe(2);
    expect(result.rateLimitResetCredits).toHaveLength(1);
    expect(result.windows.map((window) => window.id)).toEqual([
      'five-hour',
      'spark-five-hour-0',
      'weekly',
    ]);
    expect(result.windows[0]).toMatchObject({
      id: 'five-hour',
      usedPercent: 80,
      resetLabel: '07/01 02:00',
      limitWindowSeconds: 18_000,
    });
    expect(result.windows[1]).toMatchObject({
      id: 'spark-five-hour-0',
      usedPercent: 30,
      resetLabel: '07/01 01:00',
    });
  });

  it('keeps 401 quota errors so reauth controls stay visible', () => {
    const activeQuota: TestQuotaState = {
      status: 'error',
      errorStatus: 401,
    };
    const observedQuota: TestQuotaState = {
      status: 'success',
      observedAtMs: 2_000,
    };

    expect(resolveQuotaDisplayState(activeQuota, observedQuota)).toBe(activeQuota);
  });

  it('keeps manual refresh failures over older header snapshots', () => {
    const activeQuota: CodexQuotaState = {
      status: 'error',
      error: 'refresh failed',
      errorStatus: 502,
      failedAtMs: 2_000,
      planType: 'plus',
      windows: [
        {
          id: 'five-hour',
          label: '5-hour limit',
          usedPercent: 10,
          resetLabel: '06/30 12:00',
          limitWindowSeconds: 18_000,
        },
      ],
      rateLimitResetCreditsAvailableCount: 2,
    };
    const observedQuota: CodexQuotaState = {
      status: 'success',
      observedFromUsageHeaders: true,
      observedAtMs: 1_000,
      planType: 'free',
      windows: [
        {
          id: 'five-hour',
          label: '5-hour limit',
          usedPercent: 80,
          resetLabel: '07/01 02:00',
          limitWindowSeconds: null,
        },
      ],
    };

    expect(resolveQuotaDisplayState(activeQuota, observedQuota)).toBe(activeQuota);
  });

  it('recovers manual refresh failures with newer header snapshots without dropping API-only fields', () => {
    const activeQuota: CodexQuotaState = {
      status: 'error',
      error: 'refresh failed',
      errorStatus: 502,
      failedAtMs: 1_000,
      fetchedAtMs: 500,
      planType: 'plus',
      windows: [
        {
          id: 'five-hour',
          label: '5-hour limit',
          labelKey: 'codex_quota.primary_window',
          usedPercent: 10,
          resetLabel: '06/30 12:00',
          limitWindowSeconds: 18_000,
        },
        {
          id: 'spark-five-hour-0',
          label: 'Spark 5-hour limit',
          labelKey: 'codex_quota.additional_primary_window',
          labelParams: { name: 'spark' },
          usedPercent: 30,
          resetLabel: '07/01 01:00',
          limitWindowSeconds: 18_000,
        },
      ],
      rateLimitResetCreditsAvailableCount: 2,
      rateLimitResetCredits: [
        {
          id: 'credit-1',
          status: 'available',
          grantedAt: '2026-06-29T00:00:00Z',
          expiresAt: '2026-07-19T00:42:09Z',
        },
      ],
      rateLimitResetCreditsError: null,
    };
    const observedQuota: CodexQuotaState = {
      status: 'success',
      observedFromUsageHeaders: true,
      observedResetCreditsUnknown: true,
      observedAtMs: 2_000,
      planType: 'free',
      windows: [
        {
          id: 'five-hour',
          label: '5-hour limit',
          labelKey: 'codex_quota.primary_window',
          usedPercent: 80,
          resetLabel: '07/01 02:00',
          limitWindowSeconds: null,
        },
      ],
    };

    const result = resolveQuotaDisplayState(activeQuota, observedQuota) as CodexQuotaState;

    expect(result.status).toBe('success');
    expect(result.error).toBeUndefined();
    expect(result.errorStatus).toBeUndefined();
    expect(result.failedAtMs).toBeUndefined();
    expect(result.observedFromUsageHeaders).toBe(true);
    expect(result.rateLimitResetCreditsAvailableCount).toBe(2);
    expect(result.rateLimitResetCredits).toHaveLength(1);
    expect(result.windows.map((window) => window.id)).toEqual(['five-hour', 'spark-five-hour-0']);
    expect(result.windows[0]).toMatchObject({
      id: 'five-hour',
      usedPercent: 80,
      resetLabel: '07/01 02:00',
      limitWindowSeconds: 18_000,
    });
    expect(result.windows[1]).toMatchObject({
      id: 'spark-five-hour-0',
      usedPercent: 30,
      resetLabel: '07/01 01:00',
    });
  });
});

describe('CODEX_CONFIG credits balance row', () => {
  const t = ((key: string) => key) as TFunction;
  const helpers: QuotaRenderHelpers = {
    styles,
    QuotaProgressBar: ({ percent }) =>
      React.createElement('div', { 'data-progress': percent ?? 'none' }),
  };
  const weeklyWindow = (usedPercent: number | null) => ({
    id: 'weekly',
    label: 'Weekly limit',
    labelKey: 'codex_quota.secondary_window',
    usedPercent,
    resetLabel: '11/20 08:00',
    limitWindowSeconds: 604_800,
  });
  const renderCodex = (quota: CodexQuotaState) =>
    renderToStaticMarkup(
      React.createElement(
        React.Fragment,
        null,
        CODEX_CONFIG.renderQuotaItems(quota, t, helpers) as ReactNode
      )
    );

  it('formats the floored balance with thousands separators', () => {
    expect(formatCodexCreditsBalance(59897.480385, 'en-US')).toBe('59,897');
    expect(formatCodexCreditsBalance(1234567.9, 'en-US')).toBe('1,234,567');
  });

  it('renders the balance and the in-use hint when a window is exhausted', () => {
    const html = renderCodex({
      status: 'success',
      planType: 'pro',
      windows: [weeklyWindow(100)],
      creditsBalance: '59897.4803850000',
      creditsHasCredits: true,
      creditsUnlimited: false,
    });

    expect(html).toContain('data-testid="codex-credits-summary"');
    expect(html).toContain('codex_quota.credits_balance_label');
    expect(html).toMatch(/data-testid="codex-credits-balance">59[,.\u00a0\u202f]?897</);
    expect(html).toContain('data-testid="codex-credits-in-use-hint"');
    expect(html).toContain('codex_quota.credits_in_use_hint');
    // 积分行排在额度窗口之后
    expect(html.indexOf('codex_quota.secondary_window')).toBeLessThan(
      html.indexOf('codex-credits-summary')
    );
  });

  it('renders the balance without the hint while quota windows still have room', () => {
    const html = renderCodex({
      status: 'success',
      windows: [weeklyWindow(42)],
      creditsBalance: '18.4',
      creditsHasCredits: true,
    });

    expect(html).toContain('data-testid="codex-credits-balance">18<');
    expect(html).not.toContain('codex-credits-in-use-hint');
  });

  it('does not flag credits usage when only the code review window is exhausted', () => {
    const html = renderCodex({
      status: 'success',
      windows: [
        {
          id: 'five-hour',
          label: '5-hour limit',
          labelKey: 'codex_quota.primary_window',
          usedPercent: 40,
          resetLabel: '11/14 04:56',
          limitWindowSeconds: 18_000,
        },
        weeklyWindow(60),
        {
          id: 'code-review-five-hour',
          label: 'Code review 5-hour limit',
          labelKey: 'codex_quota.code_review_primary_window',
          usedPercent: 100,
          resetLabel: '11/14 04:38',
          limitWindowSeconds: 18_000,
        },
      ],
      creditsBalance: '59897.4803850000',
      creditsHasCredits: true,
      creditsUnlimited: false,
    });

    expect(html).toContain('data-testid="codex-credits-summary"');
    expect(html).toMatch(/data-testid="codex-credits-balance">59[,.\u00a0\u202f]?897</);
    expect(html).not.toContain('codex-credits-in-use-hint');
  });

  it('does not flag credits usage when only an additional limit window is exhausted', () => {
    const html = renderCodex({
      status: 'success',
      windows: [
        weeklyWindow(10),
        {
          id: 'spark-weekly-0',
          label: 'Spark weekly limit',
          labelKey: 'codex_quota.additional_secondary_window',
          labelParams: { name: 'spark' },
          usedPercent: 100,
          resetLabel: '11/20 08:00',
          limitWindowSeconds: 604_800,
        },
      ],
      creditsBalance: '120',
      creditsHasCredits: true,
    });

    expect(html).toContain('data-testid="codex-credits-summary"');
    expect(html).not.toContain('codex-credits-in-use-hint');
  });

  it('flags credits usage when a main window is exhausted alongside code review', () => {
    const weeklyFull = renderCodex({
      status: 'success',
      windows: [
        weeklyWindow(100),
        {
          id: 'code-review-five-hour',
          label: 'Code review 5-hour limit',
          labelKey: 'codex_quota.code_review_primary_window',
          usedPercent: 20,
          resetLabel: '11/14 04:38',
          limitWindowSeconds: 18_000,
        },
      ],
      creditsBalance: '59897.48',
      creditsHasCredits: true,
    });
    expect(weeklyFull).toContain('data-testid="codex-credits-in-use-hint"');

    const fiveHourFull = renderCodex({
      status: 'success',
      windows: [
        {
          id: 'five-hour',
          label: '5-hour limit',
          labelKey: 'codex_quota.primary_window',
          usedPercent: 100,
          resetLabel: '11/14 04:56',
          limitWindowSeconds: 18_000,
        },
        weeklyWindow(30),
      ],
      creditsBalance: '59897.48',
      creditsHasCredits: true,
    });
    expect(fiveHourFull).toContain('data-testid="codex-credits-in-use-hint"');
  });

  it('renders unlimited credits only together with has_credits=true', () => {
    const html = renderCodex({
      status: 'success',
      windows: [weeklyWindow(100)],
      creditsHasCredits: true,
      creditsUnlimited: true,
    });

    expect(html).toContain('codex_quota.credits_balance_unlimited');
    expect(html).toContain('codex-credits-in-use-hint');

    const notEligible = renderCodex({
      status: 'success',
      windows: [weeklyWindow(100)],
      creditsHasCredits: false,
      creditsUnlimited: true,
    });
    expect(notEligible).not.toContain('codex-credits');
  });

  it('renders <1 for a balance between 0 and 1', () => {
    const html = renderCodex({
      status: 'success',
      windows: [weeklyWindow(100)],
      creditsBalance: '0.4',
      creditsHasCredits: true,
      creditsUnlimited: false,
    });

    expect(html).toContain('data-testid="codex-credits-balance">&lt;1<');
    expect(html).toContain('codex-credits-in-use-hint');
  });

  it('keeps the legacy card markup unchanged without credits or with has_credits=false', () => {
    const base: CodexQuotaState = { status: 'success', windows: [weeklyWindow(100)] };
    const legacyHtml = renderCodex(base);

    expect(legacyHtml).not.toContain('codex-credits');
    expect(
      renderCodex({
        ...base,
        creditsBalance: '59897.48',
        creditsHasCredits: false,
        creditsUnlimited: false,
      })
    ).toBe(legacyHtml);
    expect(
      renderCodex({
        ...base,
        creditsBalance: '0',
        creditsHasCredits: true,
        creditsUnlimited: false,
      })
    ).toBe(legacyHtml);
  });

  it('carries api-call credits through buildSuccessState and omits them when absent', () => {
    const file = { name: 'codex.json', type: 'codex', authIndex: 'auth-1' };
    const withCredits = CODEX_CONFIG.buildSuccessState(
      {
        planType: 'pro',
        windows: [],
        subscriptionActiveUntil: null,
        rateLimitResetCreditsAvailableCount: null,
        rateLimitResetCredits: [],
        rateLimitResetCreditsError: null,
        creditsBalance: '59897.4803850000',
        creditsHasCredits: true,
        creditsUnlimited: false,
      },
      file
    );
    expect(withCredits).toMatchObject({
      creditsBalance: '59897.4803850000',
      creditsHasCredits: true,
      creditsUnlimited: false,
    });

    const withoutCredits = CODEX_CONFIG.buildSuccessState(
      {
        planType: 'pro',
        windows: [],
        subscriptionActiveUntil: null,
        rateLimitResetCreditsAvailableCount: null,
        rateLimitResetCredits: [],
        rateLimitResetCreditsError: null,
      },
      file
    );
    expect(withoutCredits).not.toHaveProperty('creditsBalance');
    expect(withoutCredits).not.toHaveProperty('creditsHasCredits');
  });
});

describe('quota window remaining percent label', () => {
  // 用真实 locale 文案做插值，断言渲染文本里明确写出「剩余」，避免「0%」被读成「已用 0%」。
  const makeT = (locale: Record<string, unknown>) =>
    ((key: string, params?: Record<string, unknown>) => {
      const value = key
        .split('.')
        .reduce<unknown>(
          (node, part) =>
            node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
          locale
        );
      if (typeof value !== 'string') return key;
      return value.replace(/\{\{(\w+)\}\}/g, (_match, name: string) =>
        String(params?.[name] ?? '')
      );
    }) as unknown as TFunction;
  const helpers: QuotaRenderHelpers = {
    styles,
    QuotaProgressBar: () => React.createElement('div'),
  };
  const render = (node: unknown) =>
    renderToStaticMarkup(React.createElement(React.Fragment, null, node as ReactNode));
  const codexQuota: CodexQuotaState = {
    status: 'success',
    windows: [
      {
        id: 'five-hour',
        label: '5-hour limit',
        labelKey: 'codex_quota.primary_window',
        usedPercent: 37.4,
        resetLabel: '11/14 04:56',
        limitWindowSeconds: 18_000,
      },
      {
        id: 'weekly',
        label: 'Weekly limit',
        labelKey: 'codex_quota.secondary_window',
        usedPercent: 100,
        resetLabel: '11/16 22:58',
        limitWindowSeconds: 604_800,
      },
      {
        id: 'code-review-five-hour',
        label: 'Code review 5-hour limit',
        labelKey: 'codex_quota.code_review_primary_window',
        usedPercent: null,
        resetLabel: '-',
        limitWindowSeconds: 18_000,
      },
    ],
  };

  it('labels Codex window percent as remaining and highlights depleted windows', () => {
    const html = render(CODEX_CONFIG.renderQuotaItems(codexQuota, makeT(zhCN), helpers));

    expect(html).toContain('剩余 63%');
    expect(html).toContain('剩余 0%');
    expect(html).not.toMatch(/>\s*0%\s*</);
    // 剩余为 0 的那一格使用 danger 修饰类，其他窗口不使用
    const depletedSpans = html.match(new RegExp(styles.quotaPercentDepleted, 'g')) ?? [];
    expect(depletedSpans).toHaveLength(1);
    expect(html).toMatch(
      new RegExp(`class="${styles.quotaPercent} ${styles.quotaPercentDepleted}"[^>]*>剩余 0%<`)
    );
    // 未知剩余仍显示占位
    expect(html).toContain('>--<');
  });

  it('only marks windows depleted when unrounded remaining is <= 0', () => {
    const html = render(
      CODEX_CONFIG.renderQuotaItems(
        {
          status: 'success',
          windows: [
            {
              id: 'weekly',
              label: 'Weekly limit',
              labelKey: 'codex_quota.secondary_window',
              usedPercent: 99.6,
              resetLabel: '11/16 22:58',
              limitWindowSeconds: 604_800,
            },
          ],
        },
        makeT(zhCN),
        helpers
      )
    );

    // 99.6% 已用 → 剩余 0.4%，取整显示「剩余 0%」，但未用尽，不标红（与「已用完」提示同口径）
    expect(html).toContain('剩余 0%');
    expect(html).not.toContain(styles.quotaPercentDepleted);
  });

  it('uses the English remaining label', () => {
    const html = render(CODEX_CONFIG.renderQuotaItems(codexQuota, makeT(en), helpers));

    expect(html).toContain('63% left');
    expect(html).toContain('0% left');
  });

  it('labels Claude window percent as remaining', () => {
    const html = render(
      CLAUDE_CONFIG.renderQuotaItems(
        {
          status: 'success',
          windows: [
            {
              id: 'five-hour',
              label: '5-hour limit',
              labelKey: 'claude_quota.five_hour',
              usedPercent: 100,
              resetLabel: '11/14 04:56',
            },
          ],
        },
        makeT(zhCN),
        helpers
      )
    );

    expect(html).toContain('剩余 0%');
    expect(html).toContain(styles.quotaPercentDepleted);
  });
});

describe('preferFresherCodexCredits', () => {
  const t = ((key: string) => key) as TFunction;
  const file: AuthFileItem = { name: 'codex-pro.json', type: 'codex', authIndex: 'auth-1' };
  const headerSnapshot = (timestampMs: number, balance: string): UsageHeaderSnapshot => ({
    event_hash: 'event-credits',
    timestamp_ms: timestampMs,
    response_metadata: {
      quota: {
        plan_type: 'pro',
        credits_has_credits: true,
        credits_unlimited: false,
        credits_balance: balance,
        primary: { used_percent: 12, window_minutes: 300 },
        secondary: { used_percent: 100, window_minutes: 10_080 },
      },
    },
  });
  const coreEntry = (
    refreshedAt: string,
    credits: Record<string, unknown>
  ): CoreQuotaSnapshotEntry => ({
    name: 'codex-pro.json',
    auth_index: 'auth-1',
    provider: 'codex',
    status: 'ok',
    plan_type: 'pro',
    last_refreshed_at: refreshedAt,
    snapshot: {
      usage: {
        plan_type: 'pro',
        rate_limit: { primary_window: { used_percent: 30, limit_window_seconds: 18_000 } },
        credits,
      },
    },
  });
  const resolve = (header: CodexQuotaState | undefined, core: CodexQuotaState | undefined) =>
    preferFresherCodexCredits(header ?? core, header, core);

  it('uses core snapshot credits when the core snapshot is newer than the header snapshot', () => {
    const header = buildObservedCodexQuotaState(
      file,
      headerSnapshot(Date.parse('2026-11-01T00:00:00Z'), '90000.0'),
      t
    );
    const core = buildObservedCodexQuotaStateFromCoreSnapshot(
      file,
      coreEntry('2026-11-13T00:00:00Z', {
        has_credits: true,
        unlimited: false,
        balance: '59897.4803850000',
      }),
      t
    );

    const result = resolve(header, core);

    expect(result).toMatchObject({
      creditsBalance: '59897.4803850000',
      creditsHasCredits: true,
      creditsUnlimited: false,
    });
    // 非积分字段仍来自请求头观测（原选择逻辑不变）
    expect(result?.observedAtMs).toBe(header?.observedAtMs);
    expect(result?.windows).toEqual(header?.windows);
  });

  it('keeps header credits when the header snapshot is newer', () => {
    const header = buildObservedCodexQuotaState(
      file,
      headerSnapshot(Date.parse('2026-11-13T06:00:00Z'), '59000.5'),
      t
    );
    const core = buildObservedCodexQuotaStateFromCoreSnapshot(
      file,
      coreEntry('2026-11-13T00:00:00Z', { has_credits: true, unlimited: false, balance: '60000' }),
      t
    );

    expect(resolve(header, core)).toBe(header);
  });

  it('switches to core credits that report no credits left', () => {
    const header = buildObservedCodexQuotaState(
      file,
      headerSnapshot(Date.parse('2026-11-01T00:00:00Z'), '120.0'),
      t
    );
    const core = buildObservedCodexQuotaStateFromCoreSnapshot(
      file,
      coreEntry('2026-11-13T00:00:00Z', { has_credits: false, unlimited: false, balance: '0' }),
      t
    );

    expect(resolve(header, core)).toMatchObject({
      creditsBalance: '0',
      creditsHasCredits: false,
    });
  });

  it('leaves the observed state untouched when one side lacks credits or timestamps', () => {
    const header = buildObservedCodexQuotaState(
      file,
      headerSnapshot(Date.parse('2026-11-01T00:00:00Z'), '120.0'),
      t
    );
    const coreWithoutCredits = buildObservedCodexQuotaStateFromCoreSnapshot(
      file,
      { ...coreEntry('2026-11-13T00:00:00Z', {}), snapshot: { usage: { plan_type: 'pro' } } },
      t
    );
    expect(resolve(header, coreWithoutCredits)).toBe(header);

    const coreWithoutTime = buildObservedCodexQuotaStateFromCoreSnapshot(
      file,
      { ...coreEntry('', { has_credits: true, balance: '1' }), last_refreshed_at: undefined },
      t
    );
    expect(resolve(header, coreWithoutTime)).toBe(header);

    const onlyCore = buildObservedCodexQuotaStateFromCoreSnapshot(
      file,
      coreEntry('2026-11-13T00:00:00Z', { has_credits: true, balance: '5' }),
      t
    );
    expect(resolve(undefined, onlyCore)).toBe(onlyCore);
  });
});
