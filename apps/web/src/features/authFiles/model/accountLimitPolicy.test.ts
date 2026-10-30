import { describe, expect, it } from 'vitest';
import type { AccountLimitPolicy } from '@/types';
import {
  LIMIT_FIELDS,
  limitDraft,
  limitPatch,
  validLimitConstraints,
  presetLimitDraft,
} from './accountLimitPolicy';
const policy = (): AccountLimitPolicy => ({
  fields: Object.fromEntries(
    LIMIT_FIELDS.map((name) => [
      name,
      {
        baseline: 5,
        fixed: null,
        temporary: null,
        effective: 5,
        source: 'baseline',
        min: 1,
        max: 20,
      },
    ])
  ) as AccountLimitPolicy['fields'],
  temporary_status: 'none',
  temporary_issued_at: null,
  temporary_expires_at: null,
  temporary_end_reason: null,
  restricted_reasons: [],
});
describe('account limit patches', () => {
  it('sends only changed fields and preserves explicit equal-to-baseline overrides', () => {
    const p = policy();
    const draft = limitDraft(p);
    draft.rpm.mode = 'fixed';
    expect(limitPatch(p, draft, 15)).toEqual({ limit_overrides: { rpm: 5 } });
  });
  it('inherit removes both fixed and temporary for one field, preserving other temporary values', () => {
    const p = policy();
    p.temporary_status = 'active';
    p.fields.rpm.fixed = 7;
    p.fields.rpm.temporary = 10;
    p.fields.concurrency.temporary = 2;
    const draft = limitDraft(p);
    draft.rpm.mode = 'inherit';
    expect(limitPatch(p, draft, 15)).toEqual({
      limit_overrides: { rpm: null },
      temporary_limits: { duration_minutes: 15, overrides: { concurrency: 2 } },
    });
  });
  it('clears the temporary layer only when its last item is removed', () => {
    const p = policy();
    p.temporary_status = 'active';
    p.fields.rpm.temporary = 10;
    const draft = limitDraft(p);
    draft.rpm.mode = 'inherit';
    expect(limitPatch(p, draft, 15).temporary_limits).toBeNull();
  });
  it.each(['', 'Infinity', 'NaN', '1.5', '0', '21'])('rejects invalid input %s', (value) => {
    const p = policy();
    const draft = limitDraft(p);
    draft.rpm = { mode: 'fixed', value };
    expect(() => limitPatch(p, draft, 15)).toThrow();
  });
  it('fails closed without backend constraints', () => {
    const p = policy();
    p.fields.rpm.max = null;
    expect(validLimitConstraints(p)).toBe(false);
    expect(() => limitPatch(p, limitDraft(p), 15)).toThrow();
  });
});

describe('scenario recommendations', () => {
  const warming = () => {
    const p = policy();
    for (const [key, value] of Object.entries({
      rpm: 5,
      concurrency: 1,
      request_capacity: 8,
      max_active_bindings: 1,
    })) {
      const f = p.fields[key as keyof typeof p.fields];
      f.baseline = value;
      f.effective = value;
    }
    return p;
  };
  it('adds an independent session slot without raising sending speed or capacity', () => {
    const p = warming();
    expect(limitPatch(p, presetLimitDraft(p, 'agents')!, 15)).toEqual({
      temporary_limits: { duration_minutes: 15, overrides: { max_active_bindings: 2 } },
    });
  });
  it('offers a bounded parallel starting point and a fixed alternative', () => {
    const p = warming();
    expect(limitPatch(p, presetLimitDraft(p, 'parallel')!, 5)).toEqual({
      temporary_limits: {
        duration_minutes: 5,
        overrides: { concurrency: 2, max_active_bindings: 4 },
      },
    });
    expect(limitPatch(p, presetLimitDraft(p, 'parallel', 'fixed')!, 15)).toEqual({
      limit_overrides: { concurrency: 2, max_active_bindings: 4 },
    });
  });
  it('keeps higher existing settings and unrelated fixed limits', () => {
    const p = warming();
    p.fields.max_active_bindings.fixed = 6;
    p.fields.max_active_bindings.effective = 6;
    p.fields.rpm.fixed = 3;
    p.fields.rpm.effective = 3;
    const draft = presetLimitDraft(p, 'agents')!;
    expect(draft.max_active_bindings).toEqual({ mode: 'fixed', value: '6' });
    expect(draft.rpm).toEqual({ mode: 'fixed', value: '3' });
    expect(limitPatch(p, draft, 15)).toEqual({});
  });
  it('restores automatic limits by clearing both layers rather than copying today’s baseline', () => {
    const p = warming();
    p.temporary_status = 'active';
    p.fields.rpm.fixed = 7;
    p.fields.concurrency.temporary = 2;
    const patch = limitPatch(p, presetLimitDraft(p, 'baseline')!, 15);
    expect(patch.limit_overrides).toEqual({ rpm: null, concurrency: null });
    expect(patch.temporary_limits).toBeNull();
  });
  it('does not silently clamp unsupported recommendations or bypass health restrictions', () => {
    const p = warming();
    p.fields.concurrency.max = 1;
    expect(presetLimitDraft(p, 'parallel')).toBeNull();
    expect(presetLimitDraft(p, 'agents')).not.toBeNull();
    p.restricted_reasons = ['health'];
    expect(presetLimitDraft(p, 'agents')).toBeNull();
    expect(presetLimitDraft(p, 'baseline')).not.toBeNull();
    p.fields.rpm.max = null;
    expect(presetLimitDraft(p, 'baseline')).toBeNull();
  });
});
