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
import { buildCodexQuotaWindowInfos, CODEX_SPARK_MODEL_ID } from '@/utils/quota/codexQuota';
import {
  ANTIGRAVITY_CONFIG,
  buildObservedCodexQuotaState,
  buildQuotaFailureState,
  CLAUDE_CONFIG,
  CODEX_CONFIG,
  DEVIN_CONFIG,
  getCodexQuotaStoreKey,
  KIMI_CONFIG,
  formatCodexCreditsBalance,
  getSortedCodexResetCreditExpiries,
  preferFresherCodexCredits,
  resolveQuotaDisplayState,
  XAI_CONFIG,
} from './quotaConfigs';

describe('getCodexQuotaStoreKey', () => {
  it('preserves indexed keys and separates same-file rows without auth indexes', () => {
    expect(
      getCodexQuotaStoreKey({
        name: 'shared.json',
        type: 'codex',
        authIndex: 'auth-1',
      })
    ).toBe('shared.json::auth-1');

    const first = getCodexQuotaStoreKey({
      id: 'runtime-1',
      name: 'shared.json',
      type: 'codex',
      account_id: 'account-1',
    });
    const second = getCodexQuotaStoreKey({
      id: 'runtime-2',
      name: 'shared.json',
      type: 'codex',
      account: 'second@example.com',
    });

    expect(first).not.toBe(second);
  });

  it('uses the same credential identity contract for every quota provider', () => {
    const file = {
      name: 'shared.json',
      provider: 'claude',
      authIndex: 'auth-1',
    };
    const configs = [
      CLAUDE_CONFIG,
      ANTIGRAVITY_CONFIG,
      CODEX_CONFIG,
      DEVIN_CONFIG,
      KIMI_CONFIG,
      XAI_CONFIG,
    ];

    configs.forEach((config) => {
      expect(config.getStoreKey?.(file)).toBe('shared.json::auth-1');
      expect(config.buildLoadingState(file)).toMatchObject({
        authFileKey: 'shared.json::auth-1',
        authFileName: 'shared.json',
        authIndex: 'auth-1',
        authFileIdentityVerified: true,
      });
    });
  });

  it('populates resetCreditsEvidenceAtMs from fetched data in buildSuccessState', () => {
    const successState = CODEX_CONFIG.buildSuccessState(
      {
        planType: 'plus',
        windows: [],
        observedAtMs: 1_000,
        quotaInventoryObserved: true,
        subscriptionActiveUntil: null,
        rateLimitResetCreditsAvailableCount: 2,
        rateLimitResetCredits: [],
        rateLimitResetCreditsError: null,
        resetCreditsEvidenceAtMs: 1_500,
      },
      { name: 'codex.json', type: 'codex', authIndex: 'auth-1' }
    );

    expect(successState.resetCreditsEvidenceAtMs).toBe(1_500);
    expect(successState.rateLimitResetCreditsAvailableCount).toBe(2);
    expect(successState.fetchedAtMs).toBe(1_000);
  });

  describe('full refresh state regression with count-only reset evidence', () => {
    const file = { name: 'codex.json', type: 'codex', authIndex: 'auth-1' };
    const creditA = { id: 'A', status: 'available', grantedAt: '', expiresAt: '2026-10-01' };
    const creditB = { id: 'B', status: 'available', grantedAt: '', expiresAt: '2026-10-02' };

    it('preserves trusted details and old detail timestamp when full refresh receives same count without credits', () => {
      const currentState: CodexQuotaState = {
        status: 'success',
        windows: [],
        rateLimitResetCreditsAvailableCount: 2,
        rateLimitResetCredits: [creditA, creditB],
        rateLimitResetCreditsError: null,
        resetCreditsCountEvidenceAtMs: 1_000,
        resetCreditsDetailEvidenceAtMs: 1_000,
        resetCreditsDetailStale: false,
      };

      const incomingData = {
        planType: 'plus',
        windows: [],
        quotaInventoryObserved: true,
        subscriptionActiveUntil: null,
        rateLimitResetCreditsAvailableCount: 2,
        rateLimitResetCredits: [],
        rateLimitResetCreditsError: null,
        resetCreditsEvidenceAtMs: 2_000,
        resetCreditsCountEvidenceAtMs: 2_000,
        resetCreditsDetailEvidenceAtMs: null,
        observedAtMs: 2_000,
      };

      const nextState = CODEX_CONFIG.buildSuccessState(incomingData, file, currentState);

      expect(nextState.rateLimitResetCreditsAvailableCount).toBe(2);
      expect(nextState.resetCreditsCountEvidenceAtMs).toBe(2_000);
      expect(nextState.rateLimitResetCredits).toEqual([creditA, creditB]);
      expect(nextState.resetCreditsDetailEvidenceAtMs).toBe(1_000);
      expect(nextState.resetCreditsDetailStale).toBe(false);
    });

    it('marks detail stale and clears display credits when full refresh receives changed count without credits', () => {
      const currentState: CodexQuotaState = {
        status: 'success',
        windows: [],
        rateLimitResetCreditsAvailableCount: 2,
        rateLimitResetCredits: [creditA, creditB],
        rateLimitResetCreditsError: null,
        resetCreditsCountEvidenceAtMs: 1_000,
        resetCreditsDetailEvidenceAtMs: 1_000,
        resetCreditsDetailStale: false,
      };

      const incomingData = {
        planType: 'plus',
        windows: [],
        quotaInventoryObserved: true,
        subscriptionActiveUntil: null,
        rateLimitResetCreditsAvailableCount: 1,
        rateLimitResetCredits: [],
        rateLimitResetCreditsError: null,
        resetCreditsEvidenceAtMs: 2_000,
        resetCreditsCountEvidenceAtMs: 2_000,
        resetCreditsDetailEvidenceAtMs: null,
        observedAtMs: 2_000,
      };

      const nextState = CODEX_CONFIG.buildSuccessState(incomingData, file, currentState);

      expect(nextState.rateLimitResetCreditsAvailableCount).toBe(1);
      expect(nextState.resetCreditsCountEvidenceAtMs).toBe(2_000);
      expect(nextState.rateLimitResetCredits).toEqual([]);
      expect(nextState.resetCreditsDetailEvidenceAtMs).toBe(1_000);
      expect(nextState.resetCreditsDetailStale).toBe(true);
    });

    it('clears credits and detail evidence when full refresh receives count=0 without credits', () => {
      const currentState: CodexQuotaState = {
        status: 'success',
        windows: [],
        rateLimitResetCreditsAvailableCount: 2,
        rateLimitResetCredits: [creditA, creditB],
        rateLimitResetCreditsError: null,
        resetCreditsCountEvidenceAtMs: 1_000,
        resetCreditsDetailEvidenceAtMs: 1_000,
        resetCreditsDetailStale: false,
      };

      const incomingData = {
        planType: 'plus',
        windows: [],
        quotaInventoryObserved: true,
        subscriptionActiveUntil: null,
        rateLimitResetCreditsAvailableCount: 0,
        rateLimitResetCredits: [],
        rateLimitResetCreditsError: null,
        resetCreditsEvidenceAtMs: 2_000,
        resetCreditsCountEvidenceAtMs: 2_000,
        resetCreditsDetailEvidenceAtMs: null,
        observedAtMs: 2_000,
      };

      const nextState = CODEX_CONFIG.buildSuccessState(incomingData, file, currentState);

      expect(nextState.rateLimitResetCreditsAvailableCount).toBe(0);
      expect(nextState.resetCreditsCountEvidenceAtMs).toBe(2_000);
      expect(nextState.rateLimitResetCredits).toEqual([]);
      expect(nextState.resetCreditsDetailEvidenceAtMs).toBeNull();
      expect(nextState.resetCreditsDetailStale).toBe(false);
    });

    it('authoritatively clears conflicting credits when full detail receives available_count=0 with credits', () => {
      const currentState: CodexQuotaState = {
        status: 'success',
        windows: [],
        rateLimitResetCreditsAvailableCount: 1,
        rateLimitResetCredits: [creditA],
        rateLimitResetCreditsError: null,
        resetCreditsCountEvidenceAtMs: 1_000,
        resetCreditsDetailEvidenceAtMs: 1_000,
        resetCreditsDetailStale: false,
      };

      const incomingData = {
        planType: 'plus',
        windows: [],
        quotaInventoryObserved: true,
        subscriptionActiveUntil: null,
        rateLimitResetCreditsAvailableCount: 0,
        rateLimitResetCredits: [creditA],
        rateLimitResetCreditsError: null,
        resetCreditsEvidenceAtMs: 2_000,
        resetCreditsCountEvidenceAtMs: 2_000,
        resetCreditsDetailEvidenceAtMs: 2_000,
        observedAtMs: 2_000,
      };

      const nextState = CODEX_CONFIG.buildSuccessState(incomingData, file, currentState);

      expect(nextState.rateLimitResetCreditsAvailableCount).toBe(0);
      expect(nextState.resetCreditsCountEvidenceAtMs).toBe(2_000);
      expect(nextState.rateLimitResetCredits).toEqual([]);
      expect(nextState.resetCreditsDetailEvidenceAtMs).toBe(2_000);
      expect(nextState.resetCreditsDetailStale).toBe(false);
    });
  });
});

type TestQuotaState = {
  status: 'idle' | 'loading' | 'success' | 'error';
  errorStatus?: number;
  fetchedAtMs?: number;
  observedAtMs?: number;
  observedFromUsageHeaders?: boolean;
  windows?: unknown[];
};

type FailureTestState = {
  status: 'success' | 'error';
  fetchedAtMs?: number;
  windows?: Array<{ id: string; usedPercent: number }>;
  error?: string;
  lastError?: string;
  errorStatus?: number;
  failedAtMs?: number;
};

describe('buildQuotaFailureState', () => {
  it('lets providers preserve the last successful quota while recording refresh failure', () => {
    const activeState: FailureTestState = {
      status: 'success' as const,
      fetchedAtMs: 1_000,
      windows: [{ id: 'weekly', usedPercent: 25 }],
    };
    const result = buildQuotaFailureState<FailureTestState, unknown>(
      {
        buildErrorState: (message: string, status?: number) => ({
          status: 'error' as const,
          error: message,
          errorStatus: status,
        }),
        buildFailureState: (message, status, _file, previous, failedAtMs) => ({
          ...previous,
          status: 'success' as const,
          lastError: message,
          errorStatus: status,
          failedAtMs,
        }),
      },
      'temporary failure',
      503,
      { name: 'codex.json', type: 'codex' },
      activeState,
      2_000
    );

    expect(result).toEqual({
      ...activeState,
      lastError: 'temporary failure',
      errorStatus: 503,
      failedAtMs: 2_000,
    });
  });
});

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
    const state = CLAUDE_CONFIG.buildSuccessState({
      windows: [],
      planType: null,
      quotaInventoryObserved: true,
    });
    const after = Date.now();

    expect(state.source).toBe('direct');
    expect(state.nextRefreshAt).toBeNull();
    expect(Date.parse(state.lastRefreshedAt || '')).toBeGreaterThanOrEqual(before);
    expect(Date.parse(state.lastRefreshedAt || '')).toBeLessThanOrEqual(after);
  });
});

describe('resolveQuotaDisplayState', () => {
  it('uses observed headers when a Codex success response did not identify a quota inventory', () => {
    const activeQuota: CodexQuotaState = {
      status: 'success',
      fetchedAtMs: 2_000,
      quotaInventoryObserved: false,
      planType: 'plus',
      windows: [],
    };
    const observedQuota: CodexQuotaState = {
      status: 'success',
      observedAtMs: 1_000,
      observedFromUsageHeaders: true,
      windows: [
        {
          id: 'five-hour',
          label: '5-hour limit',
          usedPercent: 25,
          resetLabel: '07/01 12:00',
        },
      ],
    };

    const result = resolveQuotaDisplayState(activeQuota, observedQuota) as CodexQuotaState;

    expect(result).toMatchObject({
      status: 'success',
      fetchedAtMs: 2_000,
      observedAtMs: 1_000,
      observedFromUsageHeaders: true,
      planType: 'plus',
      windows: [{ id: 'five-hour', usedPercent: 25 }],
    });
  });

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

  it('keeps a manual Codex inventory when its timestamp equals the Header snapshot', () => {
    const activeQuota: CodexQuotaState = {
      status: 'success',
      fetchedAtMs: 2_000,
      quotaInventoryObserved: true,
      windows: [
        {
          id: 'weekly',
          label: 'Weekly limit',
          usedPercent: 20,
          resetLabel: '07/07 12:00',
        },
      ],
    };
    const observedQuota: CodexQuotaState = {
      status: 'success',
      observedAtMs: 2_000,
      observedFromUsageHeaders: true,
      windows: [
        {
          id: 'weekly',
          label: 'Weekly limit',
          usedPercent: 80,
          resetLabel: '07/07 13:00',
        },
      ],
    };

    expect(resolveQuotaDisplayState(activeQuota, observedQuota)).toBe(activeQuota);
  });

  it('does not append older Header-only windows to a newer complete manual inventory', () => {
    const activeQuota: CodexQuotaState = {
      status: 'success',
      fetchedAtMs: 2_000,
      quotaInventoryObserved: true,
      windows: [
        {
          id: 'weekly',
          label: 'Weekly limit',
          usedPercent: 20,
          resetLabel: '07/07 12:00',
        },
      ],
    };
    const observedQuota: CodexQuotaState = {
      status: 'success',
      observedAtMs: 1_000,
      observedFromUsageHeaders: true,
      windows: [
        {
          id: 'five-hour',
          label: '5-hour limit',
          usedPercent: 80,
          resetLabel: '07/01 13:00',
        },
      ],
    };

    const result = resolveQuotaDisplayState(activeQuota, observedQuota) as CodexQuotaState;

    expect(result).toBe(activeQuota);
    expect(result.windows.map((window) => window.id)).toEqual(['weekly']);
  });

  it('adds missing Header windows to a newer partial Codex inventory without retagging API windows', () => {
    const activeQuota: CodexQuotaState = {
      status: 'success',
      fetchedAtMs: 2_000,
      quotaInventoryObserved: false,
      planType: 'plus',
      windows: [
        {
          id: 'code-review-weekly',
          label: 'Code review weekly',
          usedPercent: 15,
          resetLabel: '07/07 12:00',
          limitWindowSeconds: 604_800,
        },
      ],
    };
    const observedQuota: CodexQuotaState = {
      status: 'success',
      observedAtMs: 1_000,
      observedFromUsageHeaders: true,
      planType: 'free',
      windows: [
        {
          id: 'five-hour',
          label: '5-hour limit',
          usedPercent: 40,
          resetLabel: '07/01 12:00',
          limitWindowSeconds: 18_000,
        },
      ],
    };

    const result = resolveQuotaDisplayState(activeQuota, observedQuota) as CodexQuotaState;

    expect(result.planType).toBe('plus');
    expect(result.windows).toMatchObject([
      {
        id: 'code-review-weekly',
        observationSource: 'api_query',
        observedAtMs: 2_000,
      },
      {
        id: 'five-hour',
        observationSource: 'response_header',
        observedAtMs: 1_000,
      },
    ]);
  });

  it('does not append a legacy Spark alias when the partial inventory already has the canonical window', () => {
    const sparkScope = {
      kind: 'models' as const,
      models: [CODEX_SPARK_MODEL_ID],
      complete: true,
    };
    const activeQuota: CodexQuotaState = {
      status: 'success',
      fetchedAtMs: 2_000,
      quotaInventoryObserved: false,
      windows: [
        {
          id: 'spark-weekly-0',
          label: 'Spark weekly',
          resetLabel: '-',
          usedPercent: 0,
          modelScope: sparkScope,
          providerWindowAliases: ['fast-coding-weekly-0'],
        },
      ],
    };
    const observedQuota: CodexQuotaState = {
      status: 'success',
      observedAtMs: 1_000,
      observedFromUsageHeaders: true,
      observedModelScope: sparkScope,
      windows: [
        {
          id: 'fast-coding-weekly-0',
          label: 'Spark weekly',
          resetLabel: '-',
          usedPercent: 0,
          modelScope: sparkScope,
        },
      ],
    };

    const result = resolveQuotaDisplayState(activeQuota, observedQuota) as CodexQuotaState;

    expect(result.windows).toHaveLength(1);
    expect(result.windows[0].id).toBe('spark-weekly-0');
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

  it('preserves quota progress provenance when a newer Header only provides metadata', () => {
    const result = resolveQuotaDisplayState(
      {
        status: 'success',
        fetchedAtMs: 1_000,
        quotaInventoryObserved: true,
        windows: [
          {
            id: 'weekly',
            label: 'Weekly limit',
            usedPercent: 50,
            resetLabel: 'cycle B',
            resetAtMs: 7_000,
            resetAccuracy: 'exact',
            limitWindowSeconds: 5,
            observedAtMs: 1_000,
            quotaProgressObservedAtMs: 1_000,
          },
        ],
      },
      {
        status: 'success',
        observedAtMs: 2_000,
        observedFromUsageHeaders: true,
        windows: [
          {
            id: 'weekly',
            label: 'Weekly limit',
            usedPercent: null,
            resetLabel: 'cycle B (header)',
            resetAtMs: 7_000,
            resetAccuracy: 'exact',
            limitWindowSeconds: 5,
            quotaProgressObservedAtMs: null,
          },
        ],
      }
    ) as CodexQuotaState;

    expect(result.windows[0]).toMatchObject({
      usedPercent: 50,
      observedAtMs: 2_000,
      quotaProgressObservedAtMs: 1_000,
      resetLabel: 'cycle B (header)',
    });
  });

  it('clears inherited quota progress after a confirmed Codex cycle rollover', () => {
    const result = resolveQuotaDisplayState(
      {
        status: 'success',
        fetchedAtMs: 1_000,
        quotaInventoryObserved: true,
        windows: [
          {
            id: 'five-hour',
            label: '5-hour limit',
            usedPercent: 95,
            resetLabel: 'cycle A-B',
            resetAtMs: 300_000,
            resetAccuracy: 'exact',
            limitWindowSeconds: 300,
            observedAtMs: 1_000,
            quotaProgressObservedAtMs: 1_000,
            modelScope: { kind: 'family', key: 'codex_main', complete: true },
          },
        ],
      },
      {
        status: 'success',
        observedAtMs: 2_000,
        observedFromUsageHeaders: true,
        windows: [
          {
            id: 'five-hour',
            label: '5-hour limit',
            usedPercent: null,
            resetLabel: 'cycle B-C',
            resetAtMs: 600_000,
            resetAccuracy: 'exact',
            limitWindowSeconds: 300,
            observationSource: 'response_header',
            modelScope: { kind: 'family', key: 'codex_main', complete: true },
          },
        ],
      }
    ) as CodexQuotaState;

    expect(result.windows[0]).toMatchObject({
      usedPercent: null,
      quotaProgressObservedAtMs: null,
      resetAtMs: 600_000,
      resetLabel: 'cycle B-C',
      limitWindowSeconds: 300,
    });
  });

  it('accepts quota progress when the new Codex cycle later reports usage', () => {
    const rollover = resolveQuotaDisplayState(
      {
        status: 'success',
        fetchedAtMs: 1_000,
        quotaInventoryObserved: true,
        windows: [
          {
            id: 'five-hour',
            label: '5-hour limit',
            usedPercent: 95,
            resetLabel: 'cycle A-B',
            resetAtMs: 300_000,
            resetAccuracy: 'exact',
            limitWindowSeconds: 300,
            observedAtMs: 1_000,
            quotaProgressObservedAtMs: 1_000,
            modelScope: { kind: 'family', key: 'codex_main', complete: true },
          },
        ],
      },
      {
        status: 'success',
        observedAtMs: 2_000,
        observedFromUsageHeaders: true,
        windows: [
          {
            id: 'five-hour',
            label: '5-hour limit',
            usedPercent: null,
            resetLabel: 'cycle B-C',
            resetAtMs: 600_000,
            resetAccuracy: 'exact',
            limitWindowSeconds: 300,
            observationSource: 'response_header',
            modelScope: { kind: 'family', key: 'codex_main', complete: true },
          },
        ],
      }
    ) as CodexQuotaState;
    const recovered = resolveQuotaDisplayState(rollover, {
      status: 'success',
      observedAtMs: 2_100,
      observedFromUsageHeaders: true,
      windows: [
        {
          id: 'five-hour',
          label: '5-hour limit',
          usedPercent: 3,
          resetLabel: 'cycle B-C',
          resetAtMs: 600_000,
          resetAccuracy: 'exact',
          limitWindowSeconds: 300,
          observationSource: 'response_header',
          modelScope: { kind: 'family', key: 'codex_main', complete: true },
        },
      ],
    }) as CodexQuotaState;

    expect(recovered.windows[0]).toMatchObject({
      usedPercent: 3,
      quotaProgressObservedAtMs: 2_100,
      resetAtMs: 600_000,
    });
  });

  it('clears inherited progress across a monthly calendar boundary variation', () => {
    const activeResetAtMs = Date.parse('2026-01-31T00:00:00Z');
    const observedResetAtMs = activeResetAtMs + 31 * 24 * 60 * 60 * 1000;
    const result = resolveQuotaDisplayState(
      {
        status: 'success',
        fetchedAtMs: 1_000,
        quotaInventoryObserved: true,
        windows: [
          {
            id: 'monthly',
            label: 'Monthly limit',
            usedPercent: 40,
            resetLabel: 'cycle A-B',
            resetAtMs: activeResetAtMs,
            resetAccuracy: 'estimated',
            limitWindowSeconds: 30 * 24 * 60 * 60,
            observedAtMs: 1_000,
            quotaProgressObservedAtMs: 1_000,
          },
        ],
      },
      {
        status: 'success',
        observedAtMs: 2_000,
        observedFromUsageHeaders: true,
        windows: [
          {
            id: 'monthly',
            label: 'Monthly limit',
            usedPercent: null,
            resetLabel: 'cycle B-C',
            resetAtMs: observedResetAtMs,
            resetAccuracy: 'estimated',
            limitWindowSeconds: 31 * 24 * 60 * 60,
            observationSource: 'response_header',
          },
        ],
      }
    ) as CodexQuotaState;

    expect(result.windows[0]).toMatchObject({
      usedPercent: null,
      quotaProgressObservedAtMs: null,
      resetAtMs: observedResetAtMs,
      limitWindowSeconds: 31 * 24 * 60 * 60,
    });
  });

  it('uses the standard window cadence when Codex duration metadata is missing', () => {
    const result = resolveQuotaDisplayState(
      {
        status: 'success',
        fetchedAtMs: 1_000,
        quotaInventoryObserved: true,
        windows: [
          {
            id: 'weekly',
            label: 'Weekly limit',
            usedPercent: 50,
            resetLabel: 'cycle A-B',
            resetAtMs: 1_000_000,
            resetAccuracy: 'estimated',
            limitWindowSeconds: null,
            observedAtMs: 1_000,
            quotaProgressObservedAtMs: 1_000,
          },
        ],
      },
      {
        status: 'success',
        observedAtMs: 2_000,
        observedFromUsageHeaders: true,
        windows: [
          {
            id: 'weekly',
            label: 'Weekly limit',
            usedPercent: null,
            resetLabel: 'cycle B-C',
            resetAtMs: 1_000_000 + 7 * 24 * 60 * 60 * 1000,
            resetAccuracy: 'estimated',
            limitWindowSeconds: null,
            observationSource: 'response_header',
          },
        ],
      }
    ) as CodexQuotaState;

    expect(result.windows[0]).toMatchObject({
      usedPercent: null,
      quotaProgressObservedAtMs: null,
    });
  });

  it('clears inherited progress for an indexed scoped window when duration metadata is missing', () => {
    const sparkScope = {
      kind: 'models' as const,
      models: [CODEX_SPARK_MODEL_ID],
      complete: true,
    };
    const activeResetAtMs = Date.parse('2026-01-05T00:00:00Z');
    const observedResetAtMs = activeResetAtMs + 7 * 24 * 60 * 60 * 1000;
    const result = resolveQuotaDisplayState(
      {
        status: 'success',
        fetchedAtMs: activeResetAtMs - 1_000,
        quotaInventoryObserved: true,
        windows: [
          {
            id: 'spark-weekly-0',
            label: 'Spark weekly limit',
            usedPercent: 80,
            resetLabel: 'cycle A-B',
            resetAtMs: activeResetAtMs,
            resetAccuracy: 'estimated',
            limitWindowSeconds: null,
            observedAtMs: activeResetAtMs - 1_000,
            quotaProgressObservedAtMs: activeResetAtMs - 1_000,
            modelScope: sparkScope,
          },
        ],
      },
      {
        status: 'success',
        observedAtMs: activeResetAtMs + 1_000,
        observedFromUsageHeaders: true,
        observedModelScope: sparkScope,
        windows: [
          {
            id: 'spark-weekly-0',
            label: 'Spark weekly limit',
            usedPercent: null,
            resetLabel: 'cycle B-C',
            resetAtMs: observedResetAtMs,
            resetAccuracy: 'estimated',
            limitWindowSeconds: null,
            observationSource: 'response_header',
            modelScope: sparkScope,
          },
        ],
      }
    ) as CodexQuotaState;

    expect(result.windows[0]).toMatchObject({
      id: 'spark-weekly-0',
      usedPercent: null,
      quotaProgressObservedAtMs: null,
      resetAtMs: observedResetAtMs,
      resetAccuracy: 'estimated',
      observedAtMs: activeResetAtMs + 1_000,
      observationSource: 'response_header',
    });
  });

  it('clears inherited progress for an adversarial feature-prefixed monthly window', () => {
    const activeObservedAtMs = Date.parse('2026-01-05T00:00:00Z');
    const observedAtMs = Date.parse('2026-02-04T00:00:00Z');
    const [builtWindow] = buildCodexQuotaWindowInfos(
      {
        plan_type: 'team',
        additional_rate_limits: [
          {
            limit_name: 'Weekly Bonus',
            rate_limit: {
              secondary_window: { used_percent: 80 },
            },
          },
        ],
      },
      { observedAtMs: activeObservedAtMs }
    );
    expect(builtWindow).toMatchObject({
      id: 'weekly-bonus-monthly-0',
      limitWindowSeconds: null,
    });

    const activeWindow = {
      ...builtWindow,
      resetLabel: 'cycle A-B',
      resetAtMs: activeObservedAtMs,
      observedAtMs: activeObservedAtMs,
      quotaProgressObservedAtMs: activeObservedAtMs,
    };
    const observedWindow = {
      ...builtWindow,
      usedPercent: null,
      resetLabel: 'cycle B-C',
      resetAtMs: observedAtMs,
      observedAtMs,
      observationSource: 'response_header' as const,
    };
    const result = resolveQuotaDisplayState(
      {
        status: 'success',
        fetchedAtMs: activeObservedAtMs,
        quotaInventoryObserved: true,
        windows: [activeWindow],
      },
      {
        status: 'success',
        observedAtMs,
        observedFromUsageHeaders: true,
        observedModelScope: builtWindow.modelScope,
        windows: [observedWindow],
      }
    ) as CodexQuotaState;

    expect(result.windows[0]).toMatchObject({
      id: 'weekly-bonus-monthly-0',
      usedPercent: null,
      quotaProgressObservedAtMs: null,
      resetAtMs: observedAtMs,
      observedAtMs,
      observationSource: 'response_header',
    });
  });

  it('clears inherited progress after a materially backward Codex boundary', () => {
    const result = resolveQuotaDisplayState(
      {
        status: 'success',
        fetchedAtMs: 1_000,
        quotaInventoryObserved: true,
        windows: [
          {
            id: 'five-hour',
            label: '5-hour limit',
            usedPercent: 75,
            resetLabel: 'later boundary',
            resetAtMs: 1_000_000,
            resetAccuracy: 'exact',
            limitWindowSeconds: 18_000,
            observedAtMs: 1_000,
            quotaProgressObservedAtMs: 1_000,
          },
        ],
      },
      {
        status: 'success',
        observedAtMs: 2_000,
        observedFromUsageHeaders: true,
        windows: [
          {
            id: 'five-hour',
            label: '5-hour limit',
            usedPercent: null,
            resetLabel: 'corrected boundary',
            resetAtMs: 900_000,
            resetAccuracy: 'estimated',
            limitWindowSeconds: 18_000,
            observationSource: 'response_header',
          },
        ],
      }
    ) as CodexQuotaState;

    expect(result.windows[0]).toMatchObject({
      usedPercent: null,
      quotaProgressObservedAtMs: null,
      resetAtMs: 900_000,
    });
  });

  it('ignores a zero-only main-window Header placeholder without creating or changing quota', () => {
    const placeholder = {
      id: 'five-hour',
      label: '5-hour limit',
      usedPercent: 0,
      resetLabel: '-',
      resetAtMs: null,
      resetAccuracy: 'unknown' as const,
      limitWindowSeconds: null,
      observationSource: 'response_header' as const,
      modelScope: { kind: 'family' as const, key: 'codex_main', complete: true },
    };
    const estimatedPlaceholder = {
      ...placeholder,
      resetLabel: 'estimated reset',
      resetAtMs: 2_500,
      resetAccuracy: 'estimated' as const,
    };
    const observedQuota: CodexQuotaState = {
      status: 'success',
      observedAtMs: 2_000,
      observedFromUsageHeaders: true,
      windows: [estimatedPlaceholder],
    };
    const result = resolveQuotaDisplayState(
      {
        status: 'success',
        fetchedAtMs: 1_000,
        quotaInventoryObserved: true,
        windows: [
          {
            ...placeholder,
            usedPercent: 40,
            observedAtMs: 1_000,
            quotaProgressObservedAtMs: 1_000,
            observationSource: 'api_query',
            resetAtMs: 300_000,
            resetAccuracy: 'exact',
            limitWindowSeconds: 300,
          },
        ],
      },
      observedQuota
    ) as CodexQuotaState;

    expect(result.windows[0]).toMatchObject({
      usedPercent: 40,
      quotaProgressObservedAtMs: 1_000,
      observedAtMs: 1_000,
    });
    expect(
      resolveQuotaDisplayState(
        { status: 'success', quotaInventoryObserved: false, windows: [] },
        observedQuota
      )
    ).toMatchObject({ windows: [] });
  });

  it('accepts a legitimate zero quota when the Header has a reliable new cycle boundary', () => {
    const result = resolveQuotaDisplayState(
      {
        status: 'success',
        fetchedAtMs: 1_000,
        quotaInventoryObserved: true,
        windows: [
          {
            id: 'five-hour',
            label: '5-hour limit',
            usedPercent: 40,
            resetLabel: 'cycle A-B',
            resetAtMs: 300_000,
            resetAccuracy: 'exact',
            limitWindowSeconds: 300,
            observedAtMs: 1_000,
            quotaProgressObservedAtMs: 1_000,
            modelScope: { kind: 'family', key: 'codex_main', complete: true },
          },
        ],
      },
      {
        status: 'success',
        observedAtMs: 2_000,
        observedFromUsageHeaders: true,
        windows: [
          {
            id: 'five-hour',
            label: '5-hour limit',
            usedPercent: 0,
            resetLabel: 'cycle B-C',
            resetAtMs: 600_000,
            resetAccuracy: 'exact',
            limitWindowSeconds: 300,
            observationSource: 'response_header',
            modelScope: { kind: 'family', key: 'codex_main', complete: true },
          },
        ],
      }
    ) as CodexQuotaState;

    expect(result.windows[0]).toMatchObject({
      usedPercent: 0,
      quotaProgressObservedAtMs: 2_000,
      resetAtMs: 600_000,
    });
  });

  it('advances quota progress provenance when a Header provides new progress', () => {
    const result = resolveQuotaDisplayState(
      {
        status: 'success',
        fetchedAtMs: 1_000,
        quotaInventoryObserved: true,
        windows: [
          {
            id: 'weekly',
            label: 'Weekly limit',
            usedPercent: 50,
            resetLabel: '07/07 12:00',
            observedAtMs: 1_000,
            quotaProgressObservedAtMs: 1_000,
          },
        ],
      },
      {
        status: 'success',
        observedAtMs: 2_000,
        observedFromUsageHeaders: true,
        windows: [
          {
            id: 'weekly',
            label: 'Weekly limit',
            usedPercent: 60,
            resetLabel: '07/08 12:00',
          },
        ],
      }
    ) as CodexQuotaState;

    expect(result.windows[0]).toMatchObject({
      usedPercent: 60,
      observedAtMs: 2_000,
      quotaProgressObservedAtMs: 2_000,
    });
  });

  it('does not retain an older reset timestamp behind a newer reset label', () => {
    const activeQuota: CodexQuotaState = {
      status: 'success',
      fetchedAtMs: 1_000,
      windows: [
        {
          id: 'five-hour',
          label: '5-hour limit',
          usedPercent: 10,
          resetLabel: '2026-07-01T01:00:00Z',
          resetAtMs: Date.parse('2026-07-01T01:00:00Z'),
          resetAccuracy: 'exact',
        },
      ],
    };
    const observedQuota: CodexQuotaState = {
      status: 'success',
      observedAtMs: 2_000,
      observedFromUsageHeaders: true,
      windows: [
        {
          id: 'five-hour',
          label: '5-hour limit',
          usedPercent: 80,
          resetLabel: 'resets after the next request window',
          resetAtMs: null,
          resetAccuracy: 'unknown',
        },
      ],
    };

    const result = resolveQuotaDisplayState(activeQuota, observedQuota) as CodexQuotaState;

    expect(result.windows[0]).toMatchObject({
      resetLabel: 'resets after the next request window',
      resetAtMs: null,
      resetAccuracy: 'unknown',
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

  it('does not let scoped Header scalars replace account-wide Codex state', () => {
    const activeQuota: CodexQuotaState = {
      status: 'success',
      fetchedAtMs: 1_000,
      activeLimit: 'main',
      windows: [
        {
          id: 'weekly',
          label: 'Weekly limit',
          usedPercent: 36,
          resetLabel: '07/07 00:00',
          modelScope: { kind: 'family', key: 'codex_main', complete: true },
        },
      ],
    };
    const sparkScope = {
      kind: 'models' as const,
      models: [CODEX_SPARK_MODEL_ID],
      complete: true,
    };
    const observedQuota: CodexQuotaState = {
      status: 'success',
      observedFromUsageHeaders: true,
      observedAtMs: 2_000,
      observedModelScope: sparkScope,
      activeLimit: 'spark',
      windows: [
        {
          id: 'spark-weekly-0',
          label: 'Spark weekly limit',
          usedPercent: 0,
          resetLabel: '07/07 00:00',
          modelScope: sparkScope,
        },
      ],
    };

    const result = resolveQuotaDisplayState(activeQuota, observedQuota) as CodexQuotaState;

    expect(result.activeLimit).toBe('main');
    expect(result.windows.map((window) => window.id)).toEqual(['weekly', 'spark-weekly-0']);
  });

  it('merges a legacy Spark window into the canonical header window instead of duplicating it', () => {
    const sparkScope = {
      kind: 'models' as const,
      models: [CODEX_SPARK_MODEL_ID],
      complete: true,
    };
    const result = resolveQuotaDisplayState(
      {
        status: 'success',
        fetchedAtMs: 1_000,
        quotaInventoryObserved: true,
        windows: [
          {
            id: 'fast-coding-weekly-0',
            usedPercent: 50,
            modelScope: sparkScope,
          },
        ],
      },
      {
        status: 'success',
        observedAtMs: 2_000,
        observedFromUsageHeaders: true,
        observedModelScope: sparkScope,
        windows: [
          {
            id: 'spark-weekly-0',
            usedPercent: 0,
            modelScope: sparkScope,
            providerWindowAliases: ['fast-coding-weekly-0'],
          },
        ],
      }
    ) as CodexQuotaState;

    expect(result.windows).toHaveLength(1);
    expect(result.windows[0]).toMatchObject({ id: 'spark-weekly-0', usedPercent: 0 });
    expect(result.windows[0].providerWindowAliases).toContain('fast-coding-weekly-0');
  });

  it('does not resolve an ambiguous secondary alias between weekly and monthly windows', () => {
    const result = resolveQuotaDisplayState(
      {
        status: 'success',
        fetchedAtMs: 1_000,
        quotaInventoryObserved: true,
        windows: [
          {
            id: 'weekly',
            usedPercent: 36,
            modelScope: { kind: 'family', key: 'codex_main', complete: true },
            providerWindowAliases: ['secondary'],
          },
          {
            id: 'monthly',
            usedPercent: 10,
            modelScope: { kind: 'family', key: 'codex_main', complete: true },
            providerWindowAliases: ['secondary'],
          },
        ],
      },
      {
        status: 'success',
        observedAtMs: 2_000,
        observedFromUsageHeaders: true,
        observedModelScope: { kind: 'family', key: 'codex_main', complete: true },
        windows: [
          {
            id: 'monthly',
            usedPercent: 45,
            modelScope: { kind: 'family', key: 'codex_main', complete: true },
            providerWindowAliases: ['secondary'],
          },
        ],
      }
    ) as CodexQuotaState;

    expect(result.windows).toEqual([
      expect.objectContaining({ id: 'weekly', usedPercent: 36 }),
      expect.objectContaining({ id: 'monthly', usedPercent: 45 }),
    ]);
  });
});

describe('Codex plan precedence', () => {
  const t = ((key: string) => key) as TFunction;

  it('uses a newer observed header plan before the credential token plan', () => {
    const state = buildObservedCodexQuotaState(
      {
        name: 'stale-plan.codex.json',
        type: 'codex',
        id_token: { plan_type: 'plus' },
      },
      {
        event_hash: 'event-1',
        timestamp_ms: 2_000,
        model: 'gpt-5.6-sol',
        header_quota_plan_type: 'free',
        header_quota_used_percent: 25,
      },
      t
    );

    expect(state?.planType).toBe('free');
  });

  it('drops an expired Header 5-hour window while retaining the active weekly window', () => {
    const nowMs = 1_800_000_000_000;
    const state = buildObservedCodexQuotaState(
      { name: 'mixed-window.codex.json', type: 'codex' },
      {
        event_hash: 'mixed-window-event',
        timestamp_ms: nowMs - 60_000,
        model: 'gpt-5.6-sol',
        response_metadata: {
          quota: {
            primary: {
              used_percent: 100,
              reset_at_ms: nowMs - 1,
              window_minutes: 300,
            },
            secondary: {
              used_percent: 40,
              reset_at_ms: nowMs + 60_000,
              window_minutes: 10_080,
            },
          },
        },
      },
      t,
      nowMs
    );

    expect(state?.windows).toMatchObject([
      {
        id: 'weekly',
        usedPercent: 40,
        observationSource: 'response_header',
        observedAtMs: nowMs - 60_000,
      },
    ]);
  });

  it('builds a Spark-scoped Header observation from an alias-resolved request', () => {
    const nowMs = 1_800_000_000_000;
    const state = buildObservedCodexQuotaState(
      { name: 'spark.codex.json', type: 'codex' },
      {
        event_hash: 'spark-alias-event',
        timestamp_ms: nowMs - 1_000,
        model: 'my-spark',
        analytics_model: 'my-spark',
        requested_model: 'my-spark',
        resolved_model: CODEX_SPARK_MODEL_ID,
        response_metadata: {
          quota: {
            primary: {
              used_percent: 0,
              reset_at_ms: nowMs + 7 * 24 * 60 * 60 * 1000,
              window_minutes: 10_080,
            },
          },
        },
      },
      t,
      nowMs
    );

    expect(state?.observedModelScope).toEqual({
      kind: 'models',
      models: [CODEX_SPARK_MODEL_ID],
      complete: true,
    });
    expect(state?.windows).toMatchObject([
      {
        id: 'spark-weekly-0',
        usedPercent: 0,
        modelScope: {
          kind: 'models',
          models: [CODEX_SPARK_MODEL_ID],
          complete: true,
        },
      },
    ]);
  });
});

describe('DEVIN_CONFIG', () => {
  it('correctly builds loading, success, and error states', () => {
    const file = { name: 'devin.json', type: 'devin', authIndex: 'd-1' };

    const loading = DEVIN_CONFIG.buildLoadingState(file);
    expect(loading).toMatchObject({
      status: 'loading',
      windows: [],
      observedAtMs: null,
      plan: null,
      planStartMs: null,
      planEndMs: null,
      authFileKey: 'devin.json::d-1',
    });

    const success = DEVIN_CONFIG.buildSuccessState(
      {
        windows: [
          { id: 'daily', remainingPercent: 50, resetAtMs: 1726000000000, periodHours: 24 },
          { id: 'weekly', remainingPercent: 80, resetAtMs: 1726500000000, periodHours: 168 },
        ],
        observedAtMs: 1726000000100,
        plan: 'Team',
        planStartMs: 1725000000000,
        planEndMs: 1727000000000,
      },
      file
    );
    expect(success).toMatchObject({
      status: 'success',
      plan: 'Team',
      planStartMs: 1725000000000,
      planEndMs: 1727000000000,
      windows: [
        { id: 'daily', remainingPercent: 50 },
        { id: 'weekly', remainingPercent: 80 },
      ],
      fetchedAtMs: 1726000000100,
      authFileKey: 'devin.json::d-1',
    });

    const error = DEVIN_CONFIG.buildErrorState('quota failed', 429, file);
    expect(error).toMatchObject({
      status: 'error',
      windows: [],
      error: 'quota failed',
      errorStatus: 429,
      authFileKey: 'devin.json::d-1',
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
        quotaInventoryObserved: false,
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
        quotaInventoryObserved: false,
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

describe('CODEX_CONFIG credits burn forecast', () => {
  const HOUR = 60 * 60 * 1000;
  // 带 i18n.language 的测试 t，让紧凑格式化按界面语言（中文「万」/ 英文 K）输出。
  const makeT = (locale: Record<string, unknown>) => {
    const language = locale === en ? 'en' : 'zh-CN';
    const translate = ((key: string, params?: Record<string, unknown>) => {
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
    }) as unknown as TFunction & { i18n?: { language: string } };
    translate.i18n = { language };
    return translate as TFunction;
  };
  const helpers: QuotaRenderHelpers = {
    styles,
    QuotaProgressBar: () => React.createElement('div'),
  };
  const render = (quota: CodexQuotaState, locale: Record<string, unknown> = zhCN) =>
    renderToStaticMarkup(
      React.createElement(
        React.Fragment,
        null,
        CODEX_CONFIG.renderQuotaItems(quota, makeT(locale), helpers) as ReactNode
      )
    );
  const weekly = (usedPercent: number) => ({
    id: 'weekly',
    label: 'Weekly limit',
    labelKey: 'codex_quota.secondary_window',
    usedPercent,
    resetLabel: '11/19 05:18',
    limitWindowSeconds: 604_800,
  });
  const nowMs = Date.now();
  const series = (balances: number[], spanHours: number, exhaustedFrom = 0) =>
    balances.map((balance, index) => ({
      timestampMs: nowMs - ((spanHours * (balances.length - 1 - index)) / (balances.length - 1)) * HOUR,
      balance,
      quotaExhausted: index >= exhaustedFrom,
    }));
  const quotaWith = (
    balances: number[],
    resetInHours: number,
    overrides: Partial<CodexQuotaState> = {}
  ): CodexQuotaState => ({
    status: 'success',
    windows: [weekly(100)],
    creditsBalance: String(balances[balances.length - 1]),
    creditsHasCredits: true,
    creditsUnlimited: false,
    creditsHistory: {
      // 首点未用满 → 下一点已用满：形成「额度用完」跳变。
      points: [
        { timestampMs: nowMs - 17 * HOUR, balance: balances[0], quotaExhausted: false },
        ...series(balances, 16),
      ],
      quotaResetAtMs: nowMs + resetInHours * HOUR,
      windowStartMs: null,
      unlimited: false,
    },
    ...overrides,
  });

  it('renders used, rate, forecast and an "enough" status below the balance row', () => {
    // 16 小时用掉 3200 → 200/小时；剩 100 小时 → 预测 2 万 / 余额 5.6 万 ≈ 36%
    const html = render(quotaWith([59200, 58400, 57600, 56800, 56000], 100));

    expect(html).toContain('data-testid="codex-credits-burn"');
    expect(html).toContain('data-level="ok"');
    expect(html).toContain('已用 3,200（额度用完后）');
    expect(html).toContain('约 200/小时');
    expect(html).toContain('到重置预计再用 ~2万 / 余额 5.6万');
    expect(html).toContain('data-testid="codex-credits-burn-percent">36%<');
    expect(html).toContain('>够用<');
    expect(html).toContain(styles.quotaBarFillHigh);
    expect(html.indexOf('codex-credits-summary')).toBeLessThan(html.indexOf('codex-credits-burn'));
  });

  it('marks tight forecasts with the warning color and short ones with a run-out time', () => {
    const tight = render(quotaWith([12000, 11000, 10000, 9000, 8000], 20));
    // 250/h × 20h = 5000 / 8000 = 63% → 够用；改 25h → 6250 / 8000 = 78% 偏紧
    expect(tight).toContain('data-level="ok"');
    const tight2 = render(quotaWith([12000, 11000, 10000, 9000, 8000], 25));
    expect(tight2).toContain('data-level="tight"');
    expect(tight2).toContain('>偏紧<');
    expect(tight2).toContain(styles.codexCreditsBurnTight);
    expect(tight2).toContain(styles.quotaBarFillMedium);

    const short = render(quotaWith([12000, 11000, 10000, 9000, 8000], 50), en);
    expect(short).toContain('data-level="short"');
    expect(short).toContain('May run out');
    expect(short).toContain('data-testid="codex-credits-burn-percent">100%<');
    expect(short).toContain('data-testid="codex-credits-burn-runout"');
    expect(short).toContain('Runs out ~');
    expect(short).toContain(styles.quotaBarFillLow);
  });

  it('labels "recent N hours" when the exhaustion moment is unknown', () => {
    const quota = quotaWith([14400, 13800, 13200, 12600, 12000], 30);
    // 去掉未用满的首点：序列首点即已用满，判断不了用满时刻 → 「近 N 小时」。
    quota.creditsHistory!.points = quota.creditsHistory!.points.slice(1);
    const html = render(quota);
    expect(html).toContain('近 16 小时已用 2,400');
    expect(html).not.toContain('额度用完后');
  });

  it('shows only the used amount when data is insufficient for a rate', () => {
    const quota = quotaWith([1000, 990], 30);
    const html = render(quota);
    expect(html).toContain('codex-credits-burn-used');
    expect(html).not.toContain('codex-credits-burn-rate');
    expect(html).not.toContain('codex-credits-burn-forecast');
    expect(html).toContain('data-level="none"');
  });

  it('hides the forecast while main windows still have room, for unlimited, or without credits', () => {
    const notFull = render(quotaWith([59200, 58400, 57600], 100, { windows: [weekly(60)] }));
    expect(notFull).toContain('codex-credits-summary');
    expect(notFull).not.toContain('codex-credits-burn');

    const unlimited = render(quotaWith([59200, 58400, 57600], 100, { creditsUnlimited: true }));
    expect(unlimited).not.toContain('codex-credits-burn');

    const noCredits = render(quotaWith([59200, 58400, 57600], 100, { creditsHasCredits: false }));
    expect(noCredits).not.toContain('codex-credits-summary');
    expect(noCredits).not.toContain('codex-credits-burn');

    const noHistory = render(quotaWith([59200, 58400, 57600], 100, { creditsHistory: null }));
    expect(noHistory).toContain('codex-credits-summary');
    expect(noHistory).not.toContain('codex-credits-burn');
  });
});
