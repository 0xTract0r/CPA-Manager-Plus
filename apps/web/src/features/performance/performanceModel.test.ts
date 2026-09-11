import { describe, it, expect } from 'vitest';
import {
  DEFAULT_THRESHOLDS,
  normalizeThresholds,
  performanceStatus,
  milliseconds,
  metricNumber,
  parseThresholdDraft,
  buildPerformanceAccountDirectory,
  resolvePerformanceAccount,
} from './performanceModel';
import { stableAuthIndexFromSeed } from '@/features/monitoring/legacyAuthIndexAliases';
import type { PerformanceGroup } from './types';
describe('performance thresholds and missing data', () => {
  it('rejects invalid persisted thresholds', () => {
    expect(normalizeThresholds({ latencySeconds: 0, minTps: 'NaN', minSamples: -1 })).toEqual(
      DEFAULT_THRESHOLDS
    );
    expect(normalizeThresholds({ latencySeconds: 2, minTps: 3, minSamples: 2.1 })).toEqual({
      latencySeconds: 2,
      minTps: 3,
      minSamples: 3,
    });
  });
  it('does not classify sparse models as healthy or slow', () => {
    const group = {
      latency_ms: { samples: 1, p95: 999999 },
      total_tps: { samples: 1, p10: 1 },
    } as PerformanceGroup;
    expect(performanceStatus(group, DEFAULT_THRESHOLDS)).toBe('insufficient');
    group.latency_ms.samples = 30;
    group.total_tps.samples = 30;
    expect(performanceStatus(group, DEFAULT_THRESHOLDS)).toBe('slow');
    group.latency_ms.p95 = 1000;
    group.total_tps.p10 = 20;
    expect(performanceStatus(group, DEFAULT_THRESHOLDS)).toBe('healthy');
  });
  it('keeps missing data distinct from zero', () => {
    expect(milliseconds(null)).toBe('—');
    expect(milliseconds(0)).toBe('0 s');
    expect(metricNumber(NaN)).toBe('—');
  });
});

describe('readable performance controls and accounts', () => {
  it('keeps invalid drafts invalid instead of silently applying defaults', () => {
    expect(parseThresholdDraft({ latencySeconds: '', minTps: '10', minSamples: '30' })).toBeNull();
    expect(parseThresholdDraft({ latencySeconds: '60', minTps: '0', minSamples: '30' })).toBeNull();
    expect(
      parseThresholdDraft({ latencySeconds: '60', minTps: '10', minSamples: '2.5' })
    ).toBeNull();
    expect(parseThresholdDraft({ latencySeconds: '120', minTps: '20', minSamples: '50' })).toEqual({
      latencySeconds: 120,
      minTps: 20,
      minSamples: 50,
    });
  });
  it('resolves email and note by current id, filename and legacy id', () => {
    const directory = buildPerformanceAccountDirectory([
      {
        name: 'team.json',
        authIndex: 'opaque-123',
        provider: 'codex',
        email: 'team@example.com',
        note: 'Development team',
        label: 'Team',
      },
    ]);
    for (const key of ['opaque-123', 'team.json', stableAuthIndexFromSeed('file:team.json')]) {
      expect(
        resolvePerformanceAccount({ account_key: key, provider: 'codex' }, directory)
      ).toMatchObject({ email: 'team@example.com', note: 'Development team', name: 'Team' });
    }
    expect(resolvePerformanceAccount({ account_key: 'opaque-123' }, directory)?.email).toBe(
      'team@example.com'
    );
  });
  it('does not associate ambiguous ids or the wrong provider', () => {
    const directory = buildPerformanceAccountDirectory([
      { name: 'a.json', authIndex: 'shared', provider: 'codex', email: 'a@example.com' },
      { name: 'b.json', authIndex: 'shared', provider: 'claude', email: 'b@example.com' },
    ]);
    expect(
      resolvePerformanceAccount({ account_key: 'shared', provider: 'claude' }, directory)?.email
    ).toBe('b@example.com');
    expect(resolvePerformanceAccount({ account_key: 'shared' }, directory)).toBeUndefined();
    expect(
      resolvePerformanceAccount({ account_key: 'shared', provider: 'gemini' }, directory)
    ).toBeUndefined();
    expect(resolvePerformanceAccount({ account_key: 'missing' }, directory)).toBeUndefined();
  });
});
