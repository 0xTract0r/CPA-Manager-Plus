import type {
  AccountLimitField,
  AccountLimitPolicy,
  AuthFileAccountSchedulingPatchRequest,
} from '@/types';
export const LIMIT_FIELDS: AccountLimitField[] = [
  'rpm',
  'concurrency',
  'request_capacity',
  'max_active_bindings',
];
export type LimitDraft = Record<
  AccountLimitField,
  { mode: 'inherit' | 'fixed' | 'temporary'; value: string }
>;
export type LimitPreset = 'baseline' | 'agents' | 'parallel';

/** 场景建议只调整接入位置/并发，保留发送速度、容量和日预算。 */
export function presetLimitDraft(
  policy: AccountLimitPolicy,
  preset: LimitPreset,
  mode: 'temporary' | 'fixed' = 'temporary'
): LimitDraft | null {
  if (!validLimitConstraints(policy)) return null;
  const draft = limitDraft(policy);
  if (preset === 'baseline') {
    for (const name of LIMIT_FIELDS) {
      draft[name] = { mode: 'inherit', value: String(policy.fields[name].baseline ?? '') };
    }
    return draft;
  }
  // 工程范围不是安全推荐；健康降档时不提供一键上调。
  if (
    policy.restricted_reasons.length ||
    LIMIT_FIELDS.some((name) => policy.fields[name].source === 'restricted')
  )
    return null;
  const floors =
    preset === 'agents'
      ? { max_active_bindings: 2, concurrency: 1 }
      : { max_active_bindings: 4, concurrency: 2 };
  for (const name of ['max_active_bindings', 'concurrency'] as const) {
    const field = policy.fields[name];
    const current = Number(draft[name].value);
    if (!draft[name].value.trim() || !Number.isSafeInteger(current) || current <= 0) return null;
    if (current >= floors[name]) continue;
    const value = Math.max(floors[name], field.min!);
    if (value > field.max!) return null;
    draft[name] = { mode, value: String(value) };
  }
  return draft;
}
export function limitDraft(policy?: AccountLimitPolicy | null): LimitDraft {
  return Object.fromEntries(
    LIMIT_FIELDS.map((name) => {
      const field = policy?.fields?.[name];
      const temporary = policy?.temporary_status === 'active' ? field?.temporary : null;
      return [
        name,
        {
          mode: temporary != null ? 'temporary' : field?.fixed != null ? 'fixed' : 'inherit',
          value: String(temporary ?? field?.fixed ?? field?.effective ?? field?.baseline ?? ''),
        },
      ];
    })
  ) as LimitDraft;
}
export function validLimitConstraints(policy?: AccountLimitPolicy | null) {
  return LIMIT_FIELDS.every((name) => {
    const field = policy?.fields?.[name];
    return (
      field &&
      Number.isSafeInteger(field.min) &&
      Number.isSafeInteger(field.max) &&
      field.min! > 0 &&
      field.max! >= field.min!
    );
  });
}
export function limitPatch(
  policy: AccountLimitPolicy,
  draft: LimitDraft,
  duration: 5 | 15 | 30
): Pick<AuthFileAccountSchedulingPatchRequest, 'limit_overrides' | 'temporary_limits'> {
  if (!validLimitConstraints(policy)) throw new Error('constraints');
  const initial = limitDraft(policy);
  const fixed: Partial<Record<AccountLimitField, number | null>> = {};
  const temporary: Partial<Record<AccountLimitField, number>> = {};
  let tempChanged = false;
  for (const name of LIMIT_FIELDS) {
    const field = policy.fields[name];
    const item = draft[name];
    const value = Number(item.value);
    if (
      item.mode !== 'inherit' &&
      (!item.value.trim() ||
        !Number.isSafeInteger(value) ||
        value < field.min! ||
        value > field.max!)
    )
      throw new Error('range');
    const changed =
      item.mode !== initial[name].mode ||
      (item.mode !== 'inherit' && Number(initial[name].value) !== value);
    if (item.mode === 'temporary') temporary[name] = value;
    if (!changed) continue;
    if (item.mode === 'inherit') {
      fixed[name] = null;
    }
    if (item.mode === 'fixed') fixed[name] = value;
    if (item.mode === 'temporary' || initial[name].mode === 'temporary') tempChanged = true;
  }
  return {
    ...(Object.keys(fixed).length ? { limit_overrides: fixed } : {}),
    ...(tempChanged
      ? {
          temporary_limits: Object.keys(temporary).length
            ? { duration_minutes: duration, overrides: temporary }
            : null,
        }
      : {}),
  };
}
