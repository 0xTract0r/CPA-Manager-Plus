import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { authFilesApi } from '@/services/api/authFiles';
import type { AuthFileAccountScheduling, AccountLimitField } from '@/types';
import {
  LIMIT_FIELDS,
  limitDraft,
  limitPatch,
  presetLimitDraft,
  validLimitConstraints,
  type LimitDraft,
  type LimitPreset,
} from '../model/accountLimitPolicy';
import {
  SPEED_PROFILES,
  composeSchedulingPatch,
  warmupControlDraft,
  warmupControlPatch,
} from '../model/warmupControl';
import { formatDateTime } from '@/utils/format';
import styles from './WarmupPacing.module.scss';
import { AccountWarmupSummary } from './AccountWarmupSummary';
import { PacingRateExplanation } from './PacingRateExplanation';

const PRESETS: { id: LimitPreset; icon: string }[] = [
  { id: 'baseline', icon: '🌱' },
  { id: 'agents', icon: '🧩' },
  { id: 'parallel', icon: '⚡' },
];

export function AccountLimitPolicyPanel({
  fileName,
  authIndex,
  initialScheduling,
  disabled,
  onApplied,
  advancedSettings,
  onStateChange,
}: {
  fileName: string;
  authIndex?: string | number | null;
  initialScheduling?: AuthFileAccountScheduling | null;
  disabled?: boolean;
  onApplied?: (view: AuthFileAccountScheduling) => void;
  advancedSettings?: ReactNode;
  onStateChange?: (state: { dirty: boolean; saving: boolean }) => void;
}) {
  const { t } = useTranslation();
  const k = (name: string, options?: Record<string, unknown>) =>
    t('auth_files.pacing.' + name, options);
  const [view, setView] = useState(initialScheduling);
  const policy = view?.limit_policy;
  const control = view?.warmup_control;
  const [warmupDraft, setWarmupDraft] = useState(() => warmupControlDraft(control));
  const [draft, setDraft] = useState(() => limitDraft(policy));
  const [selected, setSelected] = useState<LimitPreset | 'custom' | null>(null);
  const [scope, setScope] = useState<'temporary' | 'fixed'>('temporary');
  const [duration, setDuration] = useState<5 | 15 | 30>(15);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const constraints =
    validLimitConstraints(policy) && authIndex != null && String(authIndex).trim() !== '';
  const locked = disabled || saving || !constraints;
  let patch: ReturnType<typeof limitPatch> | null = null;
  try {
    if (policy) patch = limitPatch(policy, draft, duration);
  } catch {
    /* 无效高级输入保留在草稿里，同时阻止提交。 */
  }
  let controlPatch: ReturnType<typeof warmupControlPatch> | null = null;
  try {
    if (control) controlPatch = warmupControlPatch(control, warmupDraft);
  } catch {
    /* 保留无效草稿。 */
  }
  const controlInitial = warmupControlDraft(control);
  const controlChanged =
    warmupDraft.mode !== controlInitial.mode ||
    warmupDraft.speed !== controlInitial.speed ||
    (warmupDraft.mode === 'days' && warmupDraft.days !== controlInitial.days);
  const controlDirty = Boolean(controlPatch && Object.keys(controlPatch).length);
  const dirty = Boolean((patch && Object.keys(patch).length) || controlDirty);
  const initial = limitDraft(policy);
  const changed = LIMIT_FIELDS.filter(
    (name) =>
      draft[name].mode !== initial[name].mode ||
      (draft[name].mode !== 'inherit' && Number(draft[name].value) !== Number(initial[name].value))
  );
  const hasTemporary = Boolean(patch?.temporary_limits);
  const hasChanges = changed.length > 0 || controlChanged;
  useEffect(() => {
    onStateChange?.({ dirty: hasChanges, saving });
  }, [hasChanges, saving, onStateChange]);
  const target = (name: AccountLimitField) =>
    draft[name].mode === 'inherit' ? policy?.fields?.[name]?.baseline : draft[name].value;
  const choose = (id: LimitPreset, nextScope = scope) => {
    if (!policy || locked) return;
    const next = presetLimitDraft(policy, id, nextScope);
    if (next) {
      setWarmupDraft((old) => ({ ...old, speed: null }));
      setSelected(id);
      setDraft(next);
      setError(false);
    }
  };
  const setField = (name: AccountLimitField, next: Partial<LimitDraft[AccountLimitField]>) => {
    setWarmupDraft((old) => ({ ...old, speed: null }));
    setSelected('custom');
    setError(false);
    setDraft((old) => ({ ...old, [name]: { ...old[name], ...next } }));
  };
  const save = async (end = false) => {
    if (
      locked ||
      (end && hasChanges) ||
      (!end && (!patch || !dirty || (controlChanged && !controlPatch)))
    )
      return;
    setSaving(true);
    setError(false);
    try {
      const result = await authFilesApi.updateAccountScheduling({
        name: fileName,
        auth_index: String(authIndex),
        ...composeSchedulingPatch(
          end ? { temporary_limits: null } : { ...patch!, ...controlPatch }
        ),
      });
      if (!result.account_scheduling?.limit_policy) throw new Error('missing authoritative policy');
      setView(result.account_scheduling);
      setDraft(limitDraft(result.account_scheduling.limit_policy));
      setSelected(null);
      setWarmupDraft(warmupControlDraft(result.account_scheduling.warmup_control));
      onApplied?.(result.account_scheduling);
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  };
  const applyLabel =
    selected === 'baseline'
      ? k('apply_baseline')
      : hasTemporary
        ? k('apply_temporary', { count: duration })
        : k('apply_fixed');
  return (
    <section className={styles.policy} data-testid="account-limit-policy">
      <div className={styles.policyIntro}>
        <p>{k('account_only_scope')}</p>
        <AccountWarmupSummary view={view} compact />
        <details className={styles.advancedLimits} data-testid="rate-explanation-disclosure">
          <summary>{k('rate_details')}</summary>
          <PacingRateExplanation snapshot={view?.warmup_traffic_pacing} compact />
        </details>
      </div>
      <fieldset
        className={styles.speedPicker}
        disabled={locked || !control}
        data-testid="speed-profile-picker"
      >
        <legend>{k('speed_title')}</legend>
        <div className={styles.speedOptions}>
          {SPEED_PROFILES.map((id) => (
            <label key={id} data-selected={warmupDraft.speed === id}>
              <input
                type="radio"
                name={'speed-' + fileName}
                value={id}
                checked={warmupDraft.speed === id}
                disabled={locked || !control?.profiles.some((profile) => profile.id === id)}
                data-testid={'speed-profile-' + id}
                onChange={() => {
                  setWarmupDraft((old) => ({ ...old, speed: id }));
                  setDraft(limitDraft(policy));
                  setSelected(null);
                  setError(false);
                }}
              />
              <strong>{k('speed_' + id)}</strong>
              {id === 'medium' && <small>{k('suggested')}</small>}
            </label>
          ))}
        </div>
        <p>
          {!control
            ? k('control_missing')
            : warmupDraft.speed === null
              ? k('speed_custom')
              : k('speed_profile_note')}
        </p>
      </fieldset>
      <fieldset
        className={styles.scopePicker}
        disabled={locked || !control}
        data-testid="warmup-mode-picker"
      >
        <legend>{k('warmup_mode_title')}</legend>
        <div className={styles.scopeOptions}>
          {(['auto', 'days', 'mature'] as const).map((mode) => (
            <label key={mode} data-selected={warmupDraft.mode === mode}>
              <input
                type="radio"
                name={'warmup-mode-' + fileName}
                value={mode}
                checked={warmupDraft.mode === mode}
                data-testid={'warmup-mode-' + mode}
                onChange={() => setWarmupDraft((old) => ({ ...old, mode }))}
              />
              {k('warmup_mode_' + mode)}
            </label>
          ))}
        </div>
        {warmupDraft.mode === 'days' && (
          <label className={styles.duration}>
            {k('warmup_days')}
            <input
              type="number"
              min={1}
              max={365}
              step={1}
              value={warmupDraft.days}
              data-testid="warmup-period-days"
              aria-invalid={!controlPatch}
              onChange={(event) => setWarmupDraft((old) => ({ ...old, days: event.target.value }))}
            />
            <small>{k('warmup_days_range')}</small>
          </label>
        )}
        <p>{k(warmupDraft.mode === 'mature' ? 'warmup_manual_note' : 'warmup_auto_note')}</p>
      </fieldset>
      {!constraints && (
        <p className={styles.policyNotice} role="status">
          {k('constraints_missing')}
        </p>
      )}
      {!!policy?.restricted_reasons?.length && (
        <p className={styles.policyNotice} role="status">
          {k('restricted')}
        </p>
      )}
      {policy?.temporary_status === 'active' && (
        <div className={styles.activePolicy}>
          <div>
            <strong>{k('active_plan')}</strong>
            <p>{k('ends_at', { time: formatDateTime(policy.temporary_expires_at ?? '') })}</p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            disabled={locked || hasChanges}
            onClick={() => void save(true)}
          >
            {k('end_temporary')}
          </Button>
          {hasChanges && <small>{k('save_before_end')}</small>}
        </div>
      )}
      <details className={styles.advancedLimits} data-testid="limit-scenario-disclosure">
        <summary>{k('scenario_adjust')}</summary>
        <fieldset className={styles.presetList}>
          <legend>{k('choose_scenario')}</legend>
          {PRESETS.map(({ id, icon }) => {
            const suggestion = policy ? presetLimitDraft(policy, id, scope) : null;
            const usable = !locked && !!suggestion;
            const number = (name: AccountLimitField) =>
              suggestion?.[name].mode === 'inherit'
                ? policy?.fields?.[name]?.baseline
                : suggestion?.[name].value;
            return (
              <label
                className={styles.presetCard}
                data-selected={selected === id}
                data-disabled={!usable}
                key={id}
              >
                <span className={styles.presetIcon} aria-hidden="true">
                  {icon}
                </span>
                <span className={styles.presetCopy}>
                  <span className={styles.presetHeading}>
                    <strong>{k('preset_' + id)}</strong>
                    {id === 'baseline' && (
                      <span className={styles.recommendTag}>{k('recommended_daily')}</span>
                    )}
                  </span>
                  <span className={styles.presetDescription}>{k('preset_' + id + '_hint')}</span>
                  {suggestion ? (
                    <span className={styles.presetNumbers}>
                      {k('preset_numbers', {
                        groups: number('max_active_bindings'),
                        concurrency: number('concurrency'),
                      })}
                      <span> · {k('preset_rate', { rpm: number('rpm') })}</span>
                    </span>
                  ) : (
                    <span className={styles.presetDescription}>{k('preset_unavailable')}</span>
                  )}
                </span>
                <input
                  type="radio"
                  name={'limit-scenario-' + fileName}
                  value={id}
                  checked={selected === id}
                  disabled={!usable}
                  onChange={() => choose(id)}
                  aria-label={k('preset_' + id)}
                  data-testid={'limit-preset-' + id}
                />
              </label>
            );
          })}
        </fieldset>
        <p className={styles.scenarioHelp}>{k('scenario_help')}</p>
        {(selected === 'agents' || selected === 'parallel') && (
          <fieldset className={styles.scopePicker}>
            <legend>{k('choose_duration')}</legend>
            <div className={styles.scopeOptions}>
              {([5, 15, 30] as const).map((minutes) => (
                <label key={minutes} data-selected={scope === 'temporary' && duration === minutes}>
                  <input
                    type="radio"
                    name={'limit-duration-' + fileName}
                    checked={scope === 'temporary' && duration === minutes}
                    disabled={locked}
                    onChange={() => {
                      setDuration(minutes);
                      setScope('temporary');
                      choose(selected, 'temporary');
                    }}
                  />
                  {k('duration_choice', { count: minutes })}
                  {minutes === 15 && <small>{k('suggested')}</small>}
                </label>
              ))}
              <label data-selected={scope === 'fixed'}>
                <input
                  type="radio"
                  name={'limit-duration-' + fileName}
                  checked={scope === 'fixed'}
                  disabled={locked}
                  onChange={() => {
                    setScope('fixed');
                    choose(selected, 'fixed');
                  }}
                />
                {k('until_changed')}
              </label>
            </div>
            <p>{scope === 'temporary' ? k('auto_restore') : k('fixed_reminder')}</p>
          </fieldset>
        )}
      </details>
      <details className={styles.advancedLimits}>
        <summary>
          {k('advanced_limits')}
          {selected === 'custom' && <span>{k('custom_selected')}</span>}
        </summary>
        <p>{k('advanced_help')}</p>
        <dl className={styles.currentLimits}>
          {LIMIT_FIELDS.map((name) => (
            <div key={name}>
              <dt>{k('short_' + name)}</dt>
              <dd>
                {policy?.fields?.[name]?.effective ?? '—'} <span>{k('unit_' + name)}</span>
              </dd>
            </div>
          ))}
        </dl>

        {LIMIT_FIELDS.map((name) => {
          const field = policy?.fields[name];
          const item = draft[name];
          const invalid =
            item.mode !== 'inherit' &&
            (!item.value.trim() ||
              !Number.isSafeInteger(Number(item.value)) ||
              Number(item.value) < (field?.min ?? Infinity) ||
              Number(item.value) > (field?.max ?? -Infinity));
          return (
            <div className={styles.limitRow} key={name}>
              <label htmlFor={'limit-' + name}>{k('field_' + name)}</label>
              <p>{k('help_' + name)}</p>
              <div className={styles.limitControls}>
                <select
                  aria-label={k('field_' + name) + ' ' + k('mode')}
                  value={item.mode}
                  disabled={locked}
                  onChange={(event) =>
                    setField(name, {
                      mode: event.target.value as LimitDraft[AccountLimitField]['mode'],
                    })
                  }
                >
                  <option value="inherit">{k('inherit')}</option>
                  <option value="fixed">{k('fixed')}</option>
                  <option value="temporary">{k('temporary')}</option>
                </select>
                <button
                  type="button"
                  aria-label={k('decrease') + ' ' + k('field_' + name)}
                  disabled={
                    locked ||
                    item.mode === 'inherit' ||
                    Number(item.value) <= (field?.min ?? Infinity)
                  }
                  onClick={() => setField(name, { value: String(Number(item.value) - 1) })}
                >
                  −
                </button>
                <input
                  id={'limit-' + name}
                  type="number"
                  step={1}
                  min={field?.min ?? undefined}
                  max={field?.max ?? undefined}
                  value={item.value}
                  disabled={locked || item.mode === 'inherit'}
                  aria-invalid={invalid}
                  aria-describedby={'limit-hint-' + name}
                  onChange={(event) => setField(name, { value: event.target.value })}
                />
                <button
                  type="button"
                  aria-label={k('increase') + ' ' + k('field_' + name)}
                  disabled={
                    locked ||
                    item.mode === 'inherit' ||
                    Number(item.value) >= (field?.max ?? -Infinity)
                  }
                  onClick={() => setField(name, { value: String(Number(item.value) + 1) })}
                >
                  +
                </button>
              </div>
              <small
                id={'limit-hint-' + name}
                className={invalid ? styles.invalidValue : undefined}
              >
                {k('baseline')}: {field?.baseline ?? '—'} · {k('allowed_range')}:{' '}
                {field?.min ?? '—'}–{field?.max ?? '—'}
                {invalid && ' · ' + k('invalid_value')}
              </small>
            </div>
          );
        })}
        {selected === 'custom' && LIMIT_FIELDS.some((name) => draft[name].mode === 'temporary') && (
          <label className={styles.duration}>
            {k('duration')}
            <select
              aria-label={k('duration')}
              value={duration}
              disabled={locked}
              onChange={(event) => setDuration(Number(event.target.value) as 5 | 15 | 30)}
            >
              {[5, 15, 30].map((minutes) => (
                <option value={minutes} key={minutes}>
                  {minutes} {k('minutes')}
                </option>
              ))}
            </select>
          </label>
        )}
      </details>
      {advancedSettings}
      {(selected !== null || changed.length > 0) && (
        <div className={styles.planPreview} data-testid="limit-plan-preview" aria-live="polite">
          <strong>
            {dirty
              ? k('before_apply')
              : changed.length
                ? k('invalid_value')
                : selected
                  ? k('already_matches')
                  : k('choose_to_preview')}
          </strong>
          {dirty && (
            <dl>
              {changed.map((name) => (
                <div key={name}>
                  <dt>{k('short_' + name)}</dt>
                  <dd>
                    <span>{policy?.fields?.[name]?.effective ?? '—'}</span>
                    <span aria-hidden="true">→</span>
                    <strong>{target(name) ?? '—'}</strong>
                    <small>{k(draft[name].mode)}</small>
                  </dd>
                </div>
              ))}
            </dl>
          )}
          {dirty && hasTemporary && (
            <p>
              {k('temporary_preview', { count: duration })}
              {policy?.temporary_status === 'active' && ' ' + k('existing_temporary_note')}
            </p>
          )}
          {dirty && selected === 'baseline' && <p>{k('baseline_preview')}</p>}
          <p className={styles.budgetNote}>
            {k('budget_preserved', {
              budget: view?.warmup_traffic_pacing?.daily_request_budget ?? '—',
            })}
          </p>
        </div>
      )}
      {error && (
        <p role="alert" className={styles.invalidValue}>
          {k('save_failed')}
        </p>
      )}
      <div className={`${styles.actions} ${styles.policyActions}`}>
        {dirty && (
          <p className={styles.actionSummary}>
            {changed
              .map(
                (name) =>
                  `${k('short_' + name)} ${policy?.fields?.[name]?.effective ?? '—'} → ${target(name) ?? '—'}`
              )
              .join(' · ')}
          </p>
        )}
        <Button
          data-testid="apply-account-limits"
          disabled={locked || !dirty || !patch || (controlChanged && !controlPatch)}
          onClick={() => void save()}
        >
          {saving
            ? k('saving')
            : controlDirty
              ? k('save_speed_warmup')
              : dirty
                ? applyLabel
                : k('save_limits')}
        </Button>
        {hasChanges && (
          <Button
            variant="ghost"
            disabled={saving}
            onClick={() => {
              setDraft(limitDraft(policy));
              setWarmupDraft(warmupControlDraft(control));
              setSelected(null);
              setError(false);
            }}
          >
            {k('reset_draft')}
          </Button>
        )}
      </div>
    </section>
  );
}
