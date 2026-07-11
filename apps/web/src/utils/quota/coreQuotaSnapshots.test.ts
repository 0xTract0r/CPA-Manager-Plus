import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';
import type { AuthFileItem } from '@/types';
import type { CoreQuotaSnapshotEntry } from '@/services/api/quotaSnapshots';
import {
  buildCoreQuotaSnapshotLookup,
  buildObservedClaudeQuotaStateFromCoreSnapshot,
  buildObservedCodexQuotaStateFromCoreSnapshot,
  getCoreQuotaSnapshotMatchForAuthFile,
  getHighConfidenceCoreQuotaSnapshotForAuthFile,
} from './coreQuotaSnapshots';

const t = ((key: string) => key) as TFunction;

const authFile = (overrides: Partial<AuthFileItem> = {}): AuthFileItem => ({
  name: 'account.json',
  ...overrides,
});

describe('buildCoreQuotaSnapshotLookup / matching', () => {
  it('matches by auth_id with high confidence, ignoring name collisions', () => {
    const entries: CoreQuotaSnapshotEntry[] = [
      { auth_id: 'auth-1', name: 'shared.json', provider: 'codex', status: 'ok' },
      { auth_id: 'auth-2', name: 'shared.json', provider: 'codex', status: 'ok' },
    ];
    const lookup = buildCoreQuotaSnapshotLookup(entries);

    const fileForAuth2 = authFile({ name: 'shared.json', auth_id: 'auth-2' });

    const match = getCoreQuotaSnapshotMatchForAuthFile(lookup, fileForAuth2);
    expect(match.confidence).toBe('high');
    expect(match.entry?.auth_id).toBe('auth-2');
  });

  it('matches by name+auth_index with high confidence when auth_id is absent', () => {
    const entries: CoreQuotaSnapshotEntry[] = [
      { name: 'shared.json', auth_index: '0', provider: 'claude', status: 'ok' },
      { name: 'shared.json', auth_index: '1', provider: 'claude', status: 'ok' },
    ];
    const lookup = buildCoreQuotaSnapshotLookup(entries);

    const file = authFile({ name: 'shared.json', authIndex: '1' });
    const match = getCoreQuotaSnapshotMatchForAuthFile(lookup, file);
    expect(match.confidence).toBe('high');
    expect(match.entry?.auth_index).toBe('1');
  });

  it('falls back to a low-confidence name-only match only when auth_index is absent', () => {
    const entries: CoreQuotaSnapshotEntry[] = [
      { name: 'solo.json', provider: 'codex', status: 'ok' },
    ];
    const lookup = buildCoreQuotaSnapshotLookup(entries);

    const file = authFile({ name: 'solo.json' });
    const match = getCoreQuotaSnapshotMatchForAuthFile(lookup, file);
    expect(match.confidence).toBe('low');
    expect(getHighConfidenceCoreQuotaSnapshotForAuthFile(lookup, file)).toBeUndefined();
  });

  it('does not use the low-confidence name-only match when the file carries an auth_index', () => {
    const entries: CoreQuotaSnapshotEntry[] = [
      { name: 'solo.json', provider: 'codex', status: 'ok' },
    ];
    const lookup = buildCoreQuotaSnapshotLookup(entries);

    const file = authFile({ name: 'solo.json', authIndex: '3' });
    const match = getCoreQuotaSnapshotMatchForAuthFile(lookup, file);
    expect(match.confidence).toBe('none');
    expect(match.entry).toBeUndefined();
  });

  it('returns none confidence when the lookup is undefined', () => {
    const match = getCoreQuotaSnapshotMatchForAuthFile(undefined, authFile());
    expect(match).toEqual({ confidence: 'none' });
  });
});

describe('buildObservedCodexQuotaStateFromCoreSnapshot', () => {
  it('maps a core codex snapshot entry into an observed CodexQuotaState', () => {
    const entry: CoreQuotaSnapshotEntry = {
      auth_id: 'auth-1',
      name: 'codex.json',
      provider: 'codex',
      status: 'ok',
      plan_type: 'plus',
      last_refreshed_at: '2026-01-01T00:00:00Z',
      snapshot: {
        usage: {
          plan_type: 'plus',
          rate_limit: {
            primary_window: { used_percent: 42, reset_at: 1_800_000_000 },
          },
        },
      },
    };

    const state = buildObservedCodexQuotaStateFromCoreSnapshot(authFile({ name: 'codex.json' }), entry, t);

    expect(state).toMatchObject({
      status: 'success',
      planType: 'plus',
      observedFromUsageHeaders: true,
      observedResetCreditsUnknown: true,
    });
    expect(state?.observedAtMs).toBe(new Date('2026-01-01T00:00:00Z').getTime());
    expect(state?.windows).toHaveLength(1);
    expect(state?.windows?.[0]).toMatchObject({ usedPercent: 42 });
  });

  it('returns undefined when the entry has no usage payload', () => {
    const entry: CoreQuotaSnapshotEntry = {
      name: 'codex.json',
      provider: 'codex',
      status: 'ok',
      snapshot: {},
    };
    expect(
      buildObservedCodexQuotaStateFromCoreSnapshot(authFile({ name: 'codex.json' }), entry, t)
    ).toBeUndefined();
  });

  it('returns undefined when the entry itself is undefined', () => {
    expect(
      buildObservedCodexQuotaStateFromCoreSnapshot(authFile(), undefined, t)
    ).toBeUndefined();
  });

  it('returns undefined for an unsupported/legacy status without a usable snapshot', () => {
    const entry: CoreQuotaSnapshotEntry = {
      name: 'codex.json',
      provider: 'codex',
      status: 'refresh_disabled',
      snapshot: undefined,
    };
    expect(
      buildObservedCodexQuotaStateFromCoreSnapshot(authFile({ name: 'codex.json' }), entry, t)
    ).toBeUndefined();
  });
});

describe('buildObservedClaudeQuotaStateFromCoreSnapshot', () => {
  it('maps a core claude snapshot entry into an observed ClaudeQuotaState', () => {
    const entry: CoreQuotaSnapshotEntry = {
      auth_id: 'auth-2',
      name: 'claude.json',
      provider: 'claude',
      status: 'ok',
      plan_type: 'max',
      snapshot: {
        usage: {
          five_hour: { utilization: 55, resets_at: '2026-01-02T00:00:00Z' },
          extra_usage: {
            is_enabled: true,
            monthly_limit: 5000,
            used_credits: 1200,
            utilization: 24,
          },
        },
        profile: {
          account: { has_claude_max: true },
        },
      },
    };

    const state = buildObservedClaudeQuotaStateFromCoreSnapshot(
      authFile({ name: 'claude.json' }),
      entry,
      t
    );

    expect(state?.status).toBe('success');
    expect(state?.planType).toBe('plan_max');
    expect(state?.extraUsage).toMatchObject({ is_enabled: true, used_credits: 1200 });
    expect(state?.windows).toHaveLength(1);
    expect(state?.windows?.[0]).toMatchObject({ id: 'five-hour', usedPercent: 55 });
  });

  it('falls back to profile account flags for plan_type when entry.plan_type is absent', () => {
    const entry: CoreQuotaSnapshotEntry = {
      name: 'claude.json',
      provider: 'claude',
      status: 'ok',
      snapshot: {
        usage: { seven_day: { utilization: 10, resets_at: '2026-01-03T00:00:00Z' } },
        profile: { account: { has_claude_pro: true } },
      },
    };

    const state = buildObservedClaudeQuotaStateFromCoreSnapshot(
      authFile({ name: 'claude.json' }),
      entry,
      t
    );
    expect(state?.planType).toBe('plan_pro');
  });

  it('returns undefined when the entry has no usage payload', () => {
    const entry: CoreQuotaSnapshotEntry = {
      name: 'claude.json',
      provider: 'claude',
      status: 'ok',
      snapshot: {},
    };
    expect(
      buildObservedClaudeQuotaStateFromCoreSnapshot(authFile({ name: 'claude.json' }), entry, t)
    ).toBeUndefined();
  });

  it('returns undefined when the entry itself is undefined', () => {
    expect(
      buildObservedClaudeQuotaStateFromCoreSnapshot(authFile(), undefined, t)
    ).toBeUndefined();
  });
});
