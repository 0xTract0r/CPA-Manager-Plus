import { describe, expect, it } from 'vitest';
import { editorFixture } from './schedulingEditor.test-fixture';
import { schedulingDraft, schedulingPatch } from './schedulingEditor';

describe('unified scheduling patch', () => {
  it('shows baseline legacy accounts in presets without selecting or saving medium', () => {
    const view = editorFixture(),
      draft = schedulingDraft(view);
    expect(draft.source).toBe('preset');
    expect(draft.warmup.speed).toBeNull();
    expect(schedulingPatch(view, draft)).toEqual({});
  });
  it('keeps real numeric overrides and unexplained legacy rates in custom', () => {
    const view = editorFixture();
    view.limit_policy!.fields.rpm.fixed = 7;
    expect(schedulingDraft(view).source).toBe('custom');
    view.limit_policy!.fields.rpm.fixed = null;
    view.effective_limits!.rpm = 9;
    expect(schedulingDraft(view).source).toBe('custom');
  });
  it('explicitly clears an existing preset even when no numeric fields change', () => {
    const view = editorFixture();
    view.warmup_control!.speed_profile = 'high';
    const draft = schedulingDraft(view);
    draft.source = 'custom';
    draft.warmup.speed = null;
    expect(schedulingPatch(view, draft)).toEqual({ speed_profile: null });
  });
  it.each(['fixed', 'temporary', 'rate'] as const)(
    'uses only legacy controls when changing an existing preset to custom %s',
    (kind) => {
      const view = editorFixture();
      view.warmup_control!.speed_profile = 'high';
      const draft = schedulingDraft(view);
      draft.source = 'custom';
      draft.warmup.speed = null;
      if (kind === 'rate') draft.rate = '1.25';
      else draft.limits.rpm = { mode: kind, value: '7' };
      expect(schedulingPatch(view, draft)).toEqual(
        kind === 'rate'
          ? { rate_scale: 1.25 }
          : kind === 'fixed'
            ? { limit_overrides: { rpm: 7 } }
            : { temporary_limits: { duration_minutes: 15, overrides: { rpm: 7 } } }
      );
    }
  );
  it('omits profile when clearing an old rate through custom mode', () => {
    const view = editorFixture();
    view.warmup_control!.speed_profile = 'high';
    const draft = schedulingDraft(view);
    draft.source = 'custom';
    draft.warmup.speed = null;
    draft.rate = '';
    expect(schedulingPatch(view, draft)).toEqual({ rate_scale: null });
  });
  it('never mixes preset with legacy numeric fields, including null', () => {
    const view = editorFixture();
    view.limit_policy!.fields.rpm.fixed = 8;
    const draft = schedulingDraft(view);
    draft.source = 'preset';
    draft.warmup.speed = 'high';
    draft.rate = '3';
    draft.tier = 'pro';
    expect(schedulingPatch(view, draft)).toEqual({ speed_profile: 'high', tier_override: 'pro' });
  });
  it('preserves mixed fixed and temporary fields without renewing the temporary layer', () => {
    const view = editorFixture();
    Object.assign(view.limit_policy!.fields.rpm, { fixed: 7, effective: 7, source: 'fixed' });
    Object.assign(view.limit_policy!.fields.concurrency, {
      temporary: 2,
      effective: 2,
      source: 'temporary',
    });
    Object.assign(view.limit_policy!, {
      temporary_status: 'active',
      temporary_issued_at: '2026-01-01T00:00:00Z',
      temporary_expires_at: '2026-01-01T00:30:00Z',
    });
    const draft = schedulingDraft(view);
    expect(draft.duration).toBe(30);
    draft.limits.rpm.value = '8';
    expect(schedulingPatch(view, draft)).toEqual({ limit_overrides: { rpm: 8 } });
  });
  it('resends the remaining temporary layer when one member becomes fixed', () => {
    const view = editorFixture();
    for (const [name, value] of [
      ['rpm', 7],
      ['concurrency', 2],
    ] as const)
      Object.assign(view.limit_policy!.fields[name], {
        temporary: value,
        effective: value,
        source: 'temporary',
      });
    Object.assign(view.limit_policy!, {
      temporary_status: 'active',
      temporary_issued_at: '2026-01-01T00:00:00Z',
      temporary_expires_at: '2026-01-01T00:30:00Z',
    });
    const draft = schedulingDraft(view);
    draft.limits.rpm.mode = 'fixed';
    expect(schedulingPatch(view, draft)).toEqual({
      limit_overrides: { rpm: 7 },
      temporary_limits: { duration_minutes: 30, overrides: { concurrency: 2 } },
    });
  });
  it('keeps untouched anchor seconds and milliseconds out of the request', () => {
    const view = editorFixture(),
      draft = schedulingDraft(view);
    draft.tier = 'pro';
    expect(schedulingPatch(view, draft)).toEqual({ tier_override: 'pro' });
    expect(view.first_production_at).toBe('2026-01-02T03:04:56.789Z');
  });
  it('restores auto from mature while keeping the custom period until explicitly inherited', () => {
    const view = editorFixture();
    Object.assign(view.warmup_control!, {
      warmup_mode: 'mature',
      manual_mature: true,
      warmup_period_days: 30,
    });
    const draft = schedulingDraft(view);
    draft.warmup.mode = 'auto';
    expect(schedulingPatch(view, draft)).toEqual({ warmup_mode: 'auto' });
    draft.periodSource = 'inherit';
    expect(schedulingPatch(view, draft)).toEqual({ warmup_mode: 'auto', warmup_period_days: null });
  });
  it('saves maintenance and custom limit changes in one sparse patch', () => {
    const view = editorFixture(),
      draft = schedulingDraft(view);
    draft.source = 'custom';
    draft.rate = '1.25';
    draft.tier = 'pro';
    draft.anchor = '';
    draft.limits.rpm = { mode: 'fixed', value: '6' };
    expect(schedulingPatch(view, draft)).toEqual({
      rate_scale: 1.25,
      tier_override: 'pro',
      first_production_at: null,
      limit_overrides: { rpm: 6 },
    });
  });
  it.each(['0', '366', '1.5'])('rejects invalid period %s', (days) => {
    const view = editorFixture(),
      draft = schedulingDraft(view);
    draft.warmup.mode = 'days';
    draft.periodSource = 'custom';
    draft.warmup.days = days;
    expect(() => schedulingPatch(view, draft)).toThrow('period');
  });
  it('rejects future anchors before any request', () => {
    const view = editorFixture(),
      draft = schedulingDraft(view);
    draft.anchor = '2999-01-01T00:00';
    expect(() => schedulingPatch(view, draft)).toThrow('anchor');
  });
});
