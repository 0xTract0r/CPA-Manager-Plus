import { describe, expect, it } from 'vitest';
import type { GeminiCliParsedBucket } from '@/types';
import {
  buildAntigravityQuotaGroups,
  buildGeminiCliQuotaBuckets,
  buildKimiQuotaRows,
} from './builders';

const makeGeminiBucket = (
  overrides: Partial<GeminiCliParsedBucket> & { modelId: string }
): GeminiCliParsedBucket => ({
  tokenType: null,
  remainingFraction: null,
  remainingAmount: null,
  resetTime: undefined,
  ...overrides,
});

describe('buildGeminiCliQuotaBuckets', () => {
  it('returns an empty array for empty input', () => {
    expect(buildGeminiCliQuotaBuckets([])).toEqual([]);
  });

  it('drops ignored gemini-2.0-flash* models but keeps recognized ones', () => {
    const result = buildGeminiCliQuotaBuckets([
      makeGeminiBucket({ modelId: 'gemini-2.0-flash', remainingFraction: 0.9 }),
      makeGeminiBucket({ modelId: 'gemini-2.0-flash-exp', remainingFraction: 0.9 }),
      makeGeminiBucket({
        modelId: 'gemini-2.5-flash-lite',
        remainingFraction: 0.5,
        remainingAmount: 50,
        resetTime: '2026-07-24T10:00:00Z',
      }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'gemini-flash-lite-series',
      label: 'Gemini Flash Lite Series',
      remainingFraction: 0.5,
      remainingAmount: 50,
      resetTime: '2026-07-24T10:00:00Z',
      modelIds: ['gemini-2.5-flash-lite'],
    });
  });

  it('sorts groups by the configured group order regardless of input order', () => {
    const result = buildGeminiCliQuotaBuckets([
      makeGeminiBucket({ modelId: 'gemini-3.1-pro-preview', remainingFraction: 0.3 }),
      makeGeminiBucket({ modelId: 'gemini-2.5-flash-lite', remainingFraction: 0.5 }),
      makeGeminiBucket({ modelId: 'gemini-3-flash-preview', remainingFraction: 0.4 }),
    ]);

    expect(result.map((bucket) => bucket.id)).toEqual([
      'gemini-flash-lite-series',
      'gemini-flash-series',
      'gemini-pro-series',
    ]);
  });

  it('overrides merged group values with the preferred model bucket', () => {
    // Preferred bucket arrives AFTER a non-preferred sibling to exercise the
    // late preferred-assignment branch.
    const result = buildGeminiCliQuotaBuckets([
      makeGeminiBucket({
        modelId: 'gemini-2.5-pro',
        remainingFraction: 0.2,
        remainingAmount: 200,
        resetTime: '2026-07-24T08:00:00Z',
      }),
      makeGeminiBucket({
        modelId: 'gemini-3.1-pro-preview',
        remainingFraction: 0.9,
        remainingAmount: 900,
        resetTime: '2026-07-24T10:00:00Z',
      }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'gemini-pro-series',
      // Preferred values win even though a sibling has a lower fraction.
      remainingFraction: 0.9,
      remainingAmount: 900,
      resetTime: '2026-07-24T10:00:00Z',
    });
    expect(result[0].modelIds).toEqual(['gemini-2.5-pro', 'gemini-3.1-pro-preview']);
  });

  it('falls back to the minimum fraction/amount and earliest reset without a preferred bucket', () => {
    const result = buildGeminiCliQuotaBuckets([
      makeGeminiBucket({
        modelId: 'gemini-3-pro-preview',
        remainingFraction: 0.7,
        remainingAmount: 700,
        resetTime: '2026-07-24T09:00:00Z',
      }),
      makeGeminiBucket({
        modelId: 'gemini-2.5-pro',
        remainingFraction: 0.3,
        remainingAmount: 300,
        resetTime: '2026-07-24T06:00:00Z',
      }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'gemini-pro-series',
      remainingFraction: 0.3,
      remainingAmount: 300,
      resetTime: '2026-07-24T06:00:00Z',
    });
  });

  it('ignores null values when computing the fallback minimum', () => {
    const result = buildGeminiCliQuotaBuckets([
      makeGeminiBucket({ modelId: 'gemini-3-pro-preview', remainingFraction: null, remainingAmount: null }),
      makeGeminiBucket({
        modelId: 'gemini-2.5-pro',
        remainingFraction: 0.5,
        remainingAmount: 5000,
        resetTime: '2026-07-24T05:00:00Z',
      }),
    ]);

    expect(result[0]).toMatchObject({
      remainingFraction: 0.5,
      remainingAmount: 5000,
      resetTime: '2026-07-24T05:00:00Z',
    });
  });

  it('stays null when every merged bucket lacks a fraction/amount', () => {
    const result = buildGeminiCliQuotaBuckets([
      makeGeminiBucket({ modelId: 'gemini-3-pro-preview', remainingFraction: null, remainingAmount: null }),
      makeGeminiBucket({ modelId: 'gemini-2.5-pro', remainingFraction: null, remainingAmount: null }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].remainingFraction).toBeNull();
    expect(result[0].remainingAmount).toBeNull();
  });

  it('keeps distinct tokenType variants as separate buckets sorted by tokenType', () => {
    const result = buildGeminiCliQuotaBuckets([
      makeGeminiBucket({ modelId: 'gemini-2.5-flash-lite', tokenType: 'output', remainingFraction: 0.4 }),
      makeGeminiBucket({ modelId: 'gemini-2.5-flash-lite', tokenType: 'input', remainingFraction: 0.6 }),
    ]);

    expect(result.map((bucket) => bucket.id)).toEqual([
      'gemini-flash-lite-series-input',
      'gemini-flash-lite-series-output',
    ]);
    expect(result.map((bucket) => bucket.tokenType)).toEqual(['input', 'output']);
    expect(result.map((bucket) => bucket.remainingFraction)).toEqual([0.6, 0.4]);
  });

  it('places unknown models into their own trailing bucket', () => {
    const result = buildGeminiCliQuotaBuckets([
      makeGeminiBucket({ modelId: 'gemini-2.5-flash-lite', remainingFraction: 0.5 }),
      makeGeminiBucket({
        modelId: 'custom-unknown-model',
        remainingFraction: 0.42,
        remainingAmount: 7,
        resetTime: '2026-07-24T07:00:00Z',
      }),
    ]);

    expect(result.map((bucket) => bucket.id)).toEqual([
      'gemini-flash-lite-series',
      'custom-unknown-model',
    ]);
    expect(result[1]).toMatchObject({
      id: 'custom-unknown-model',
      label: 'custom-unknown-model',
      remainingFraction: 0.42,
      remainingAmount: 7,
      modelIds: ['custom-unknown-model'],
    });
  });

  it('deduplicates modelIds within a merged group', () => {
    const result = buildGeminiCliQuotaBuckets([
      makeGeminiBucket({ modelId: 'gemini-2.5-flash', remainingFraction: 0.7 }),
      makeGeminiBucket({ modelId: 'gemini-2.5-flash', remainingFraction: 0.3 }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].modelIds).toEqual(['gemini-2.5-flash']);
    // No preferred bucket present -> min fallback.
    expect(result[0].remainingFraction).toBe(0.3);
  });
});

describe('buildAntigravityQuotaGroups', () => {
  it('builds Antigravity groups from the real models payload shape', () => {
    const groups = buildAntigravityQuotaGroups({
      models: {
        'gemini-3.5-flash-low': {
          displayName: 'Gemini 3.5 Flash (Medium)',
          quotaInfo: {
            remainingFraction: 1,
            resetTime: '2026-06-29T02:18:21Z',
          },
          apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
          modelProvider: 'MODEL_PROVIDER_GOOGLE',
        },
        'gemini-pro-agent': {
          displayName: 'Gemini 3.1 Pro (High)',
          quotaInfo: {
            remainingFraction: 0.75,
            resetTime: '2026-06-29T02:18:21Z',
          },
          apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
          modelProvider: 'MODEL_PROVIDER_GOOGLE',
        },
        'gemini-3.1-flash-lite': {
          displayName: 'Gemini 3.1 Flash Lite',
          quotaInfo: {
            remainingFraction: 0.9,
            resetTime: '2026-06-29T02:18:21Z',
          },
          apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
          modelProvider: 'MODEL_PROVIDER_GOOGLE',
        },
        'gemini-3.1-flash-image': {
          displayName: 'Gemini 3.1 Flash Image',
          quotaInfo: {
            remainingFraction: 1,
            resetTime: '2026-06-29T02:18:21Z',
          },
          apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
          modelProvider: 'MODEL_PROVIDER_GOOGLE',
        },
        chat_20706: {
          quotaInfo: {
            remainingFraction: 1,
          },
          apiProvider: 'API_PROVIDER_INTERNAL',
          modelProvider: 'MODEL_PROVIDER_GOOGLE',
        },
        'claude-sonnet-4-6': {
          displayName: 'Claude Sonnet 4.6 (Thinking)',
          quotaInfo: {
            remainingFraction: 0.5,
            resetTime: '2026-06-24T10:32:10Z',
          },
          apiProvider: 'API_PROVIDER_ANTHROPIC_VERTEX',
          modelProvider: 'MODEL_PROVIDER_ANTHROPIC',
        },
        'gpt-oss-120b-medium': {
          displayName: 'GPT-OSS 120B (Medium)',
          quotaInfo: {
            remainingFraction: 0.6,
            resetTime: '2026-06-24T10:32:10Z',
          },
          apiProvider: 'API_PROVIDER_OPENAI_VERTEX',
          modelProvider: 'MODEL_PROVIDER_OPENAI',
        },
      },
      agentModelSorts: [
        {
          displayName: 'Recommended',
          groups: [
            {
              modelIds: [
                'gemini-3.5-flash-low',
                'gemini-pro-agent',
                'claude-sonnet-4-6',
                'gpt-oss-120b-medium',
              ],
            },
          ],
        },
      ],
      tieredModelIds: {
        flash: ['gemini-3.5-flash-low'],
        flashLite: ['gemini-3.1-flash-lite'],
        pro: ['gemini-pro-agent'],
      },
      commandModelIds: ['gemini-3.5-flash-low'],
      imageGenerationModelIds: ['gemini-3.1-flash-image'],
      tabModelIds: ['chat_20706'],
    });

    expect(groups.map((group) => group.label)).toEqual(['Claude/GPT', 'Gemini']);
    expect(groups.find((group) => group.id === 'claude-gpt')?.buckets[0]).toMatchObject({
      label: 'Claude/GPT',
      remainingFraction: 0.5,
      description: 'claude-sonnet-4-6, gpt-oss-120b-medium',
    });
    expect(groups.find((group) => group.id === 'gemini')?.buckets[0]).toMatchObject({
      label: 'Gemini',
      remainingFraction: 0.75,
    });
    expect(groups.find((group) => group.id === 'gemini')?.models).toHaveLength(4);
    expect(groups.find((group) => group.id === 'gemini')?.models).toEqual(
      expect.arrayContaining([
        'gemini-3.5-flash-low',
        'gemini-3.1-flash-lite',
        'gemini-pro-agent',
        'gemini-3.1-flash-image',
      ])
    );
    expect(groups.some((group) => group.id === 'tab-models')).toBe(false);
    expect(groups.some((group) => group.models?.includes('chat_20706'))).toBe(false);
  });
});

describe('buildKimiQuotaRows', () => {
  it('normalizes singular, plural, second, and empty duration units', () => {
    const rows = buildKimiQuotaRows({
      limits: [
        { window: { duration: 30, timeUnit: 'SECONDS' }, detail: { used: 1, limit: 10 } },
        { window: { duration: 45, timeUnit: 'SECOND' }, detail: { used: 1, limit: 10 } },
        { window: { duration: 60, timeUnit: 'MINUTES' }, detail: { used: 1, limit: 10 } },
        { window: { duration: 30, timeUnit: 'MINUTE' }, detail: { used: 1, limit: 10 } },
        { window: { duration: 6, timeUnit: 'HOURS' }, detail: { used: 1, limit: 10 } },
        { window: { duration: 1, timeUnit: 'HOUR' }, detail: { used: 1, limit: 10 } },
        { window: { duration: 7, timeUnit: 'DAYS' }, detail: { used: 1, limit: 10 } },
        { window: { duration: 1, timeUnit: 'DAY' }, detail: { used: 1, limit: 10 } },
        { window: { duration: 90, timeUnit: '' }, detail: { used: 1, limit: 10 } },
      ],
    });

    expect(rows.map((row) => row.labelParams?.duration)).toEqual([
      '30s',
      '45s',
      '1h',
      '30m',
      '6h',
      '1h',
      '7d',
      '1d',
      '90s',
    ]);
  });
});
