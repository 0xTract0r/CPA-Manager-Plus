import { describe, expect, it } from 'vitest';
import {
  deriveAccountSessionSummary,
  deriveAccountWarmupBadge,
  deriveSubscriptionTierBadge,
} from './accountSessionSummary';

describe('deriveAccountSessionSummary', () => {
  it('returns unavailable when account_scheduling is undefined (core version skew)', () => {
    expect(deriveAccountSessionSummary(undefined)).toEqual({
      status: 'unavailable',
      total: 0,
      active: 0,
      closed: 0,
    });
  });

  it('returns unavailable when account_scheduling is explicitly null', () => {
    expect(deriveAccountSessionSummary(null)).toEqual({
      status: 'unavailable',
      total: 0,
      active: 0,
      closed: 0,
    });
  });

  it('returns empty (not a raw 0) when sessions_total is exactly 0', () => {
    const result = deriveAccountSessionSummary({
      subscription_tier: 'pro',
      sessions_total: 0,
      sessions_active: 0,
      sessions_closed: 0,
    });
    expect(result.status).toBe('empty');
    expect(result.total).toBe(0);
  });

  it('returns ok with the raw counts when sessions_total > 0', () => {
    const result = deriveAccountSessionSummary({
      sessions_total: 5,
      sessions_active: 2,
      sessions_closed: 3,
    });
    expect(result).toEqual({ status: 'ok', total: 5, active: 2, closed: 3 });
  });

  it('defends against non-numeric / negative fields instead of rendering NaN or negatives', () => {
    const result = deriveAccountSessionSummary({
      sessions_total: 'not-a-number' as unknown as number,
      sessions_active: -3,
      sessions_closed: Number.NaN,
    });
    expect(result).toEqual({ status: 'empty', total: 0, active: 0, closed: 0 });
  });

  it('floors fractional counts defensively', () => {
    const result = deriveAccountSessionSummary({
      sessions_total: 4.9,
      sessions_active: 1.1,
      sessions_closed: 3.9,
    });
    expect(result).toEqual({ status: 'ok', total: 4, active: 1, closed: 3 });
  });
});

describe('deriveSubscriptionTierBadge', () => {
  it('returns null for non-claude/codex providers even when account_scheduling is present', () => {
    expect(deriveSubscriptionTierBadge('qwen', { subscription_tier: 'unknown' })).toBeNull();
  });

  it('returns null when account_scheduling is missing entirely (data-source unavailable, not "confirmed unknown")', () => {
    expect(deriveSubscriptionTierBadge('claude', undefined)).toBeNull();
    expect(deriveSubscriptionTierBadge('claude', null)).toBeNull();
  });

  it('resolves known Claude tiers case-insensitively', () => {
    expect(deriveSubscriptionTierBadge('claude', { subscription_tier: 'max_20x' })).toEqual({
      tier: 'max_20x',
      known: true,
    });
    expect(deriveSubscriptionTierBadge('claude', { subscription_tier: 'MAX_5X' })).toEqual({
      tier: 'max_5x',
      known: true,
    });
    expect(deriveSubscriptionTierBadge('claude', { subscription_tier: 'pro' })).toEqual({
      tier: 'pro',
      known: true,
    });
  });

  it('resolves known Codex tiers', () => {
    expect(deriveSubscriptionTierBadge('codex', { subscription_tier: 'plus' })).toEqual({
      tier: 'plus',
      known: true,
    });
    expect(deriveSubscriptionTierBadge('codex', { subscription_tier: 'pro' })).toEqual({
      tier: 'pro',
      known: true,
    });
  });

  it('explicitly surfaces "unknown" — never guesses — for an unrecognized or missing tier string', () => {
    expect(deriveSubscriptionTierBadge('claude', { subscription_tier: 'unknown' })).toEqual({
      tier: 'unknown',
      known: false,
    });
    expect(deriveSubscriptionTierBadge('claude', { subscription_tier: '' })).toEqual({
      tier: 'unknown',
      known: false,
    });
    expect(deriveSubscriptionTierBadge('claude', {})).toEqual({ tier: 'unknown', known: false });
    // Codex tier string read by Claude (or vice versa) must not be cross-matched.
    expect(deriveSubscriptionTierBadge('claude', { subscription_tier: 'plus' })).toEqual({
      tier: 'unknown',
      known: false,
    });
  });
});

describe('deriveAccountWarmupBadge', () => {
  it('returns null when account_scheduling is missing entirely (data-source unavailable)', () => {
    expect(deriveAccountWarmupBadge(undefined)).toBeNull();
    expect(deriveAccountWarmupBadge(null)).toBeNull();
  });

  it('returns null when the warmup sub-projection is absent (older core / version skew)', () => {
    expect(deriveAccountWarmupBadge({ subscription_tier: 'max_5x' })).toBeNull();
  });

  it('returns null for a mature account (past the warm-up curve)', () => {
    expect(
      deriveAccountWarmupBadge({
        warmup: { stage: 'mature', mature: true, age_days: 90 },
      })
    ).toBeNull();
  });

  it('returns null when mature is not an explicit boolean false (never guesses "warming")', () => {
    // mature undefined / non-boolean => not determinable => no warm-up badge.
    expect(deriveAccountWarmupBadge({ warmup: { stage: 'cold' } })).toBeNull();
    expect(
      deriveAccountWarmupBadge({
        warmup: { stage: 'cold', mature: 'no' as unknown as boolean },
      })
    ).toBeNull();
  });

  it('flags "warming" only when core explicitly reports mature === false, carrying stage + age', () => {
    expect(
      deriveAccountWarmupBadge({
        warmup: { stage: 'cold', mature: false, age_days: 2 },
      })
    ).toEqual({ warming: true, stage: 'cold', ageDays: 2 });
  });

  it('floors fractional ages and defends against non-numeric / missing age_days (null, not NaN)', () => {
    expect(
      deriveAccountWarmupBadge({ warmup: { stage: 'ramp-1', mature: false, age_days: 3.9 } })
    ).toEqual({ warming: true, stage: 'ramp-1', ageDays: 3 });
    expect(deriveAccountWarmupBadge({ warmup: { mature: false } })).toEqual({
      warming: true,
      stage: '',
      ageDays: null,
    });
    expect(
      deriveAccountWarmupBadge({
        warmup: { stage: 'cold', mature: false, age_days: Number.NaN },
      })
    ).toEqual({ warming: true, stage: 'cold', ageDays: null });
  });
});
