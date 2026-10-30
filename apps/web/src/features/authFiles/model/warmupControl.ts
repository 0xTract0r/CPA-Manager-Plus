import type {
  AccountWarmupControl,
  AccountSpeedProfile,
  AuthFileAccountSchedulingPatchRequest,
} from '@/types/authFile';

export const SPEED_PROFILES: AccountSpeedProfile[] = ['low', 'medium', 'high', 'extreme'];
export interface WarmupControlDraft {
  speed: AccountSpeedProfile | null;
  mode: 'auto' | 'days' | 'mature';
  days: string;
}
export function warmupControlDraft(control?: AccountWarmupControl | null): WarmupControlDraft {
  return {
    speed: control?.speed_profile ?? null,
    mode:
      control?.warmup_mode === 'mature'
        ? 'mature'
        : control?.warmup_period_days != null
          ? 'days'
          : 'auto',
    days: String(control?.warmup_period_days ?? control?.effective_period_days ?? ''),
  };
}
export function warmupControlPatch(
  control: AccountWarmupControl,
  draft: WarmupControlDraft
): Pick<
  AuthFileAccountSchedulingPatchRequest,
  'speed_profile' | 'warmup_mode' | 'warmup_period_days'
> {
  const initial = warmupControlDraft(control);
  if (
    draft.mode === 'days' &&
    (!draft.days.trim() ||
      !Number.isSafeInteger(Number(draft.days)) ||
      Number(draft.days) < 1 ||
      Number(draft.days) > 365)
  )
    throw new Error('period');
  const period =
    draft.mode === 'days'
      ? Number(draft.days)
      : draft.mode === 'mature' || control.warmup_mode === 'mature'
        ? control.warmup_period_days
        : null;
  const mode = draft.mode === 'mature' ? 'mature' : 'auto';
  return {
    ...(draft.speed !== initial.speed && draft.speed !== null
      ? { speed_profile: draft.speed }
      : {}),
    ...(mode !== control.warmup_mode ? { warmup_mode: mode } : {}),
    ...(period !== control.warmup_period_days ? { warmup_period_days: period } : {}),
  };
}
