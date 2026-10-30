import type {
  AuthFileAccountScheduling as Scheduling,
  AuthFileAccountSchedulingPatchRequest as Patch,
  AuthFileAccountSchedulingTierOverride,
  AccountLimitField,
} from '@/types/authFile';
import {
  LIMIT_FIELDS,
  limitDraft,
  limitPatch,
  validLimitValue,
  type LimitDraft,
} from './accountLimitPolicy';
import {
  warmupControlDraft,
  warmupControlPatch,
  validWarmupPeriod,
  type WarmupControlDraft,
} from './warmupControl';

export interface SchedulingDraft {
  warmup: WarmupControlDraft;
  source: 'preset' | 'custom';
  limits: LimitDraft;
  duration: 5 | 15 | 30;
  periodSource: 'inherit' | 'custom';
  tier: 'auto' | AuthFileAccountSchedulingTierOverride;
  rate: string;
  anchor: string;
}
export function localDateInput(value?: string | null): string {
  if (!value) return '';
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function schedulingDraft(view: Scheduling): SchedulingDraft {
  const policy = view.limit_policy;
  const medium = view.warmup_control?.profiles.find((profile) => profile.id === 'medium');
  const hasOverrides = Object.values(policy?.fields ?? {}).some(
    (field) => field.fixed != null || field.temporary != null
  );
  const isBaseline =
    !hasOverrides &&
    medium != null &&
    view.effective_limits?.rpm === medium.rpm &&
    view.effective_limits?.concurrency === medium.concurrency &&
    view.effective_limits?.daily_budget === medium.daily_budget &&
    (view.effective_limits?.pacing_applies === false ||
      (policy?.fields.request_capacity.effective === medium.request_capacity &&
        policy?.fields.max_active_bindings.effective === medium.max_active_bindings));
  const minutes =
    policy?.temporary_issued_at && policy.temporary_expires_at
      ? (Date.parse(policy.temporary_expires_at) - Date.parse(policy.temporary_issued_at)) / 60000
      : 15;
  return {
    warmup: warmupControlDraft(view.warmup_control),
    source: view.warmup_control?.speed_profile || isBaseline ? 'preset' : 'custom',
    limits: limitDraft(policy),
    duration: minutes === 5 || minutes === 30 ? minutes : 15,
    periodSource: view.warmup_control?.warmup_period_days == null ? 'inherit' : 'custom',
    tier:
      view.tier_source === 'override' &&
      ['max_20x', 'max_5x', 'pro'].includes(view.subscription_tier || '')
        ? (view.subscription_tier as AuthFileAccountSchedulingTierOverride)
        : 'auto',
    rate: typeof view.rate_scale === 'number' ? String(view.rate_scale) : '',
    anchor: localDateInput(view.first_production_at),
  };
}
function validRate(value: string) {
  return !value.trim() || (Number.isFinite(Number(value)) && Number(value) > 0);
}
function anchorError(value: string, now: number) {
  if (!value.trim()) return undefined;
  const date = new Date(value).getTime();
  return !Number.isFinite(date) ? 'invalid' : date > now ? 'future' : undefined;
}
/** 与PATCH共用输入校验，供控件关联局部错误。 */
export function schedulingFieldErrors(view: Scheduling, draft: SchedulingDraft, now = Date.now()) {
  const errors: Partial<Record<AccountLimitField | 'period' | 'rate' | 'anchor', string>> = {};
  if (
    draft.warmup.mode !== 'mature' &&
    draft.periodSource === 'custom' &&
    !validWarmupPeriod(draft.warmup.days)
  )
    errors.period = 'range';
  if (draft.source === 'custom') {
    for (const name of LIMIT_FIELDS)
      if (view.limit_policy && !validLimitValue(view.limit_policy, name, draft.limits[name]))
        errors[name] = 'range';
    if (draft.rate !== schedulingDraft(view).rate && !validRate(draft.rate)) errors.rate = 'rate';
  }
  if (draft.anchor !== localDateInput(view.first_production_at))
    errors.anchor = anchorError(draft.anchor, now);
  return errors;
}
/** 只发显式差异；同一个body供无写入预览及原子保存复用。 */
export function schedulingPatch(
  view: Scheduling,
  draft: SchedulingDraft,
  now = Date.now()
): Omit<Patch, 'name' | 'auth_index'> {
  if (!view.warmup_control || !view.limit_policy) throw new Error('unsupported');
  const initial = schedulingDraft(view);
  const warmup = {
    ...draft.warmup,
    mode:
      draft.warmup.mode === 'mature'
        ? ('mature' as const)
        : draft.periodSource === 'custom'
          ? ('days' as const)
          : ('auto' as const),
    speed: draft.source === 'preset' ? draft.warmup.speed : null,
  };
  if (draft.source === 'preset' && !warmup.speed && initial.source !== 'preset')
    throw new Error('speed');
  const patch: Omit<Patch, 'name' | 'auth_index'> = warmupControlPatch(view.warmup_control, warmup);
  if (warmup.mode !== 'mature') {
    const period = draft.periodSource === 'inherit' ? null : Number(draft.warmup.days);
    if (period !== view.warmup_control.warmup_period_days) patch.warmup_period_days = period;
  }
  if (draft.source === 'preset') {
    // 非空档位由服务端清旧覆盖；这里连null数字字段也不混发。
    if (draft.source !== initial.source) patch.speed_profile = warmup.speed;
  } else {
    if (view.warmup_control.speed_profile !== null) patch.speed_profile = null;
    Object.assign(patch, limitPatch(view.limit_policy, draft.limits, draft.duration));
    if (
      draft.duration !== initial.duration &&
      Object.values(draft.limits).some((field) => field.mode === 'temporary')
    ) {
      patch.temporary_limits = {
        duration_minutes: draft.duration,
        overrides: Object.fromEntries(
          Object.entries(draft.limits)
            .filter(([, field]) => field.mode === 'temporary')
            .map(([name, field]) => [name, Number(field.value)])
        ),
      };
    }
    if (draft.rate !== initial.rate) {
      const rate = draft.rate.trim() ? Number(draft.rate) : null;
      if (!validRate(draft.rate)) throw new Error('rate');
      patch.rate_scale = rate;
    }
  }
  if (draft.tier !== initial.tier) patch.tier_override = draft.tier === 'auto' ? null : draft.tier;
  if (draft.anchor !== initial.anchor) {
    if (!draft.anchor.trim()) patch.first_production_at = null;
    else {
      const date = new Date(draft.anchor);
      if (anchorError(draft.anchor, now)) throw new Error('anchor');
      patch.first_production_at = date.toISOString();
    }
  }
  return patch;
}
