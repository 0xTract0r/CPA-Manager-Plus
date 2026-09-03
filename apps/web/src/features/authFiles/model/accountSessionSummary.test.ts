import { describe, expect, it } from 'vitest';
import {
  deriveAccountSessionSummary,
  deriveSubscriptionTierBadge,
} from './accountSessionSummary';

describe('deriveAccountSessionSummary', () => {
  it('returns unavailable when adaptive_scheduling is undefined (core version skew)', () => {
    expect(deriveAccountSessionSummary(undefined)).toEqual({
      status: 'unavailable',
      total: 0,
      active: 0,
      closed: 0,
    });
  });

  it('returns unavailable when adaptive_scheduling is explicitly null', () => {
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
  it('returns null for non-claude/codex providers even when adaptive_scheduling is present', () => {
    expect(deriveSubscriptionTierBadge('qwen', { subscription_tier: 'unknown' })).toBeNull();
  });

  it('returns null when adaptive_scheduling is missing entirely (data-source unavailable, not "confirmed unknown")', () => {
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
