import type { AuthFileAccountScheduling, AccountLimitPolicy } from '@/types/authFile';
import { LIMIT_FIELDS } from './accountLimitPolicy';
export function editorFixture(): AuthFileAccountScheduling {
  const values = { rpm: 5, concurrency: 1, request_capacity: 8, max_active_bindings: 1 };
  return {
    first_production_at: '2026-01-02T03:04:56.789Z',
    rate_scale: 1,
    tier_source: 'auto',
    subscription_tier: 'max_5x',
    warmup: { age_days: 8, stage: 'w2', mature: false },
    effective_limits: { rpm: 5, concurrency: 1, daily_budget: 500, pacing_applies: true },
    warmup_control: {
      speed_profile: null,
      warmup_mode: 'auto',
      warmup_period_days: null,
      effective_period_days: 60,
      source: 'legacy',
      manual_mature: false,
      profiles: (['low', 'medium', 'high', 'extreme'] as const).map((id, index) => ({
        id,
        rpm: [3, 5, 8, 10][index],
        concurrency: [1, 1, 2, 2][index],
        daily_budget: [250, 500, 750, 1000][index],
        request_capacity: [4, 8, 12, 16][index],
        max_active_bindings: [1, 1, 2, 4][index],
      })),
    },
    limit_policy: {
      fields: Object.fromEntries(
        LIMIT_FIELDS.map((name) => [
          name,
          {
            baseline: values[name],
            effective: values[name],
            fixed: null,
            temporary: null,
            min: name === 'request_capacity' ? 4 : 1,
            max: 100,
            source: 'baseline',
          },
        ])
      ) as AccountLimitPolicy['fields'],
      temporary_status: 'none',
      temporary_expires_at: null,
      temporary_issued_at: null,
      temporary_end_reason: null,
      restricted_reasons: [],
    },
  };
}
