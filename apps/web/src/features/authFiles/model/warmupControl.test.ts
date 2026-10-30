import { describe, expect, it } from 'vitest';
import type { AccountWarmupControl } from '@/types/authFile';
import { warmupControlDraft, warmupControlPatch } from './warmupControl';
const control: AccountWarmupControl = {
  speed_profile: null,
  warmup_mode: 'auto',
  warmup_period_days: null,
  effective_period_days: 60,
  source: 'legacy',
  manual_mature: false,
  profiles: [],
};
describe('account speed and warm-up draft', () => {
  it('preserves custom legacy accounts without guessing medium or silently saving', () => {
    const draft = warmupControlDraft(control);
    expect(draft.speed).toBeNull();
    expect(warmupControlPatch(control, draft)).toEqual({});
  });
  it('saves speed and period together without legacy numeric fields', () => {
    expect(warmupControlPatch(control, { speed: 'high', mode: 'days', days: '30' })).toEqual({
      speed_profile: 'high',
      warmup_period_days: 30,
    });
  });
  it.each(['', '0', '366', '1.5', 'NaN'])('rejects invalid period %s', (days) => {
    expect(() => warmupControlPatch(control, { speed: null, mode: 'days', days })).toThrow(
      'period'
    );
  });
  it('marks mature and restores automatic without modifying the production anchor', () => {
    expect(warmupControlPatch(control, { speed: null, mode: 'mature', days: '60' })).toEqual({
      warmup_mode: 'mature',
    });
    const manual: AccountWarmupControl = {
      ...control,
      warmup_mode: 'mature',
      manual_mature: true,
      warmup_period_days: 30,
    };
    expect(warmupControlPatch(manual, { speed: null, mode: 'auto', days: '30' })).toEqual({
      warmup_mode: 'auto',
    });
  });
});
