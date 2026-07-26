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

  it('surfaces reauth_required as an error state with 401 when surfaceReauthAndError is on', () => {
    const entry: CoreQuotaSnapshotEntry = {
      name: 'codex.json',
      provider: 'codex',
      status: 'reauth_required',
      error: 'credential unauthorized',
      // 即便仍带上次成功快照，reauth 状态也应优先展示（不回落到陈旧额度）。
      snapshot: {
        usage: { rate_limit: { primary_window: { used_percent: 10, reset_at: 1_800_000_000 } } },
      },
    };

    const state = buildObservedCodexQuotaStateFromCoreSnapshot(
      authFile({ name: 'codex.json' }),
      entry,
      t,
      { surfaceReauthAndError: true }
    );

    expect(state).toMatchObject({
      status: 'error',
      errorStatus: 401,
      error: 'credential unauthorized',
    });
    expect(state?.windows).toHaveLength(0);
  });

  it('surfaces a generic error (no usable usage) as an error state without a 401 code when surfaceReauthAndError is on', () => {
    const entry: CoreQuotaSnapshotEntry = {
      name: 'codex.json',
      provider: 'codex',
      status: 'error',
      error: 'timeout',
    };

    const state = buildObservedCodexQuotaStateFromCoreSnapshot(
      authFile({ name: 'codex.json' }),
      entry,
      t,
      { surfaceReauthAndError: true }
    );

    expect(state?.status).toBe('error');
    expect(state?.errorStatus).toBeUndefined();
    expect(state?.error).toBe('timeout');
    expect(state?.windows).toHaveLength(0);
  });

  it('falls back to the stale snapshot quota for a generic error when last-good usage is present (surfaceReauthAndError on)', () => {
    const entry: CoreQuotaSnapshotEntry = {
      name: 'codex.json',
      provider: 'codex',
      status: 'error',
      error: 'timeout',
      last_refreshed_at: '2026-01-01T00:00:00Z',
      // 后台探测瞬时超时（status=error）但仍带上次成功快照：应回落展示陈旧额度，
      // 而不是把可用的 last-good usage 丢成「加载失败」。
      snapshot: {
        usage: { rate_limit: { primary_window: { used_percent: 33, reset_at: 1_800_000_000 } } },
      },
    };

    const state = buildObservedCodexQuotaStateFromCoreSnapshot(
      authFile({ name: 'codex.json' }),
      entry,
      t,
      { surfaceReauthAndError: true }
    );

    expect(state?.status).toBe('success');
    expect(state?.errorStatus).toBeUndefined();
    expect(state?.observedAtMs).toBe(new Date('2026-01-01T00:00:00Z').getTime());
    expect(state?.windows).toHaveLength(1);
    expect(state?.windows?.[0]).toMatchObject({ usedPercent: 33 });
  });

  it('keeps the account-files behavior for reauth_required when the option is off (shows stale quota)', () => {
    const entry: CoreQuotaSnapshotEntry = {
      name: 'codex.json',
      provider: 'codex',
      status: 'reauth_required',
      error: 'credential unauthorized',
      last_refreshed_at: '2026-01-01T00:00:00Z',
      snapshot: {
        usage: { rate_limit: { primary_window: { used_percent: 10, reset_at: 1_800_000_000 } } },
      },
    };

    const state = buildObservedCodexQuotaStateFromCoreSnapshot(
      authFile({ name: 'codex.json' }),
      entry,
      t
    );

    expect(state?.status).toBe('success');
    expect(state?.windows).toHaveLength(1);
  });

  it('returns undefined for reauth_required with no snapshot when the option is off', () => {
    const entry: CoreQuotaSnapshotEntry = {
      name: 'codex.json',
      provider: 'codex',
      status: 'reauth_required',
      error: 'credential unauthorized',
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

  it('surfaces reauth_required as an error state with 401 when surfaceReauthAndError is on', () => {
    const entry: CoreQuotaSnapshotEntry = {
      name: 'claude.json',
      provider: 'claude',
      status: 'reauth_required',
      error: 'credential unauthorized',
      snapshot: {
        usage: { five_hour: { utilization: 55, resets_at: '2026-01-02T00:00:00Z' } },
      },
    };

    const state = buildObservedClaudeQuotaStateFromCoreSnapshot(
      authFile({ name: 'claude.json' }),
      entry,
      t,
      { surfaceReauthAndError: true }
    );

    expect(state).toMatchObject({
      status: 'error',
      errorStatus: 401,
      error: 'credential unauthorized',
    });
    expect(state?.windows).toHaveLength(0);
  });

  it('surfaces a generic error (no usable usage) as an error state without a 401 code when surfaceReauthAndError is on', () => {
    const entry: CoreQuotaSnapshotEntry = {
      name: 'claude.json',
      provider: 'claude',
      status: 'error',
      error: 'timeout',
    };

    const state = buildObservedClaudeQuotaStateFromCoreSnapshot(
      authFile({ name: 'claude.json' }),
      entry,
      t,
      { surfaceReauthAndError: true }
    );

    expect(state?.status).toBe('error');
    expect(state?.errorStatus).toBeUndefined();
    expect(state?.error).toBe('timeout');
    expect(state?.windows).toHaveLength(0);
  });

  it('falls back to the stale snapshot quota for a generic error when last-good usage is present (surfaceReauthAndError on)', () => {
    const entry: CoreQuotaSnapshotEntry = {
      name: 'claude.json',
      provider: 'claude',
      status: 'error',
      error: 'timeout',
      // 后台刷新失败（status=error）但仍带上次成功快照：应回落展示陈旧额度，
      // 而不是把可用的 last-good usage 丢成「加载失败」。
      snapshot: {
        usage: { five_hour: { utilization: 55, resets_at: '2026-01-02T00:00:00Z' } },
      },
    };

    const state = buildObservedClaudeQuotaStateFromCoreSnapshot(
      authFile({ name: 'claude.json' }),
      entry,
      t,
      { surfaceReauthAndError: true }
    );

    expect(state?.status).toBe('success');
    expect(state?.errorStatus).toBeUndefined();
    expect(state?.windows).toHaveLength(1);
    expect(state?.windows?.[0]).toMatchObject({ id: 'five-hour', usedPercent: 55 });
  });

  it('keeps the account-files behavior for reauth_required when the option is off (shows stale quota)', () => {
    const entry: CoreQuotaSnapshotEntry = {
      name: 'claude.json',
      provider: 'claude',
      status: 'reauth_required',
      error: 'credential unauthorized',
      snapshot: {
        usage: { five_hour: { utilization: 55, resets_at: '2026-01-02T00:00:00Z' } },
      },
    };

    const state = buildObservedClaudeQuotaStateFromCoreSnapshot(
      authFile({ name: 'claude.json' }),
      entry,
      t
    );

    expect(state?.status).toBe('success');
    expect(state?.windows).toHaveLength(1);
  });
});
