import { describe, it, expect } from 'vitest';
import {
  DEFAULT_THRESHOLDS,
  comparePerformanceValues,
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

describe('historical performance identities', () => {
  it('uses a recorded email and uniquely matching current note after an id changes', () => {
    const files = [
      {
        name: 'current.json',
        authIndex: 'current-id',
        provider: 'codex',
        email: 'team@example.com',
        note: 'Main team',
      },
    ];
    const directory = buildPerformanceAccountDirectory(files, [
      {
        auth_indices: ['old-id'],
        account_snapshot: 'team@example.com',
        auth_label_snapshot: 'Old filename',
        auth_provider_snapshot: 'codex',
      },
    ]);
    expect(
      resolvePerformanceAccount({ account_key: 'old-id', provider: 'codex' }, directory)
    ).toMatchObject({ email: 'team@example.com', note: 'Main team', historical: true });
    expect(
      resolvePerformanceAccount({ account_key: 'current-id', provider: 'codex' }, directory)
        ?.historical
    ).toBeUndefined();
  });
  it('does not invent notes or overwrite current identities with historical snapshots', () => {
    const directory = buildPerformanceAccountDirectory(
      [
        {
          name: 'current.json',
          authIndex: 'current',
          provider: 'codex',
          email: 'current@example.com',
          note: 'Current note',
        },
      ],
      [
        {
          auth_indices: ['current'],
          account_snapshot: 'other@example.com',
          auth_provider_snapshot: 'codex',
        },
        {
          auth_indices: ['removed'],
          account_snapshot: 'removed@example.com',
          auth_provider_snapshot: 'codex',
        },
        {
          auth_indices: ['ambiguous'],
          account_snapshot: 'one@example.com',
          auth_provider_snapshot: 'codex',
        },
        {
          auth_indices: ['ambiguous'],
          account_snapshot: 'two@example.com',
          auth_provider_snapshot: 'codex',
        },
      ]
    );
    expect(
      resolvePerformanceAccount({ account_key: 'current', provider: 'codex' }, directory)?.email
    ).toBe('current@example.com');
    expect(
      resolvePerformanceAccount({ account_key: 'removed', provider: 'codex' }, directory)
    ).toMatchObject({ email: 'removed@example.com', note: '', historical: true });
    expect(
      resolvePerformanceAccount({ account_key: 'ambiguous', provider: 'codex' }, directory)
    ).toBeUndefined();
  });
});

describe('performance table ordering', () => {
  it('sorts raw numbers and keeps unknown values last in both directions', () => {
    for (const descending of [false, true]) {
      const result = [null, 100, 9, 20, undefined].sort((a, b) => comparePerformanceValues(a, b, descending));
      expect(result.slice(0, 3)).toEqual(descending ? [100, 20, 9] : [9, 20, 100]);
      expect(result.slice(3)).toEqual([null, undefined]);
    }
  });
});
