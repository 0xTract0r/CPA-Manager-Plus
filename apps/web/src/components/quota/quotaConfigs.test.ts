import React from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';
import type { CodexQuotaState } from '@/types';
import styles from '@/features/quota/QuotaPage.module.scss';
import type { QuotaRenderHelpers } from './QuotaCard';
import {
  CLAUDE_CONFIG,
  CODEX_CONFIG,
  formatCodexCreditsBalance,
  getSortedCodexResetCreditExpiries,
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

  it('renders unlimited credits', () => {
    const html = renderCodex({
      status: 'success',
      windows: [weeklyWindow(100)],
      creditsUnlimited: true,
    });

    expect(html).toContain('codex_quota.credits_balance_unlimited');
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
