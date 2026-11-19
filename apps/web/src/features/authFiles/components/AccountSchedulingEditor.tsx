import { useEffect, useLayoutEffect, useRef, useState, useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { authFilesApi } from '@/services/api/authFiles';
import { useNotificationStore } from '@/stores';
import type {
  AccountLimitField,
  AuthFileAccountScheduling,
  AuthFileAccountSchedulingPreviewResponse,
} from '@/types/authFile';
import { LIMIT_FIELDS } from '../model/accountLimitPolicy';
import { SPEED_PROFILES } from '../model/warmupControl';
import {
  localDateInput,
  schedulingDraft,
  schedulingFieldErrors,
  schedulingPatch,
  type SchedulingDraft,
} from '../model/schedulingEditor';
import styles from './AccountSchedulingEditor.module.scss';

type Props = {
  fileName: string;
  authIndex?: string | number | null;
  initialScheduling?: AuthFileAccountScheduling | null;
  disabled?: boolean;
  onApplied?: (view: AuthFileAccountScheduling) => void;
  onStateChange?: (state: { dirty: boolean; saving: boolean }) => void;
};
type PreviewState = {
  key: string;
  response?: AuthFileAccountSchedulingPreviewResponse;
  error?: 'unsupported' | 'failed';
};

/** 一份草稿、一份PATCH：预览不保存，所有生效数据由服务端返回。 */
export function AccountSchedulingEditor({
  fileName,
  authIndex,
  initialScheduling,
  disabled,
  onApplied,
  onStateChange,
}: Props) {
  const { t, i18n } = useTranslation();
  const text = (key: string, options?: Record<string, unknown>) =>
    t('auth_files.scheduling_editor.' + key, options);
  const [baseline, setBaseline] = useState<AuthFileAccountScheduling>(initialScheduling || {});
  const [draft, setDraft] = useState(() => schedulingDraft(baseline));
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [retry, setRetry] = useState(0);
  const sequence = useRef(0);
  const savingRef = useRef(false);
  const notify = useNotificationStore((state) => state.showNotification);
  const showConfirmation = useNotificationStore((state) => state.showConfirmation);
  const initialDraft = schedulingDraft(baseline);
  const errors = schedulingFieldErrors(baseline, draft);
  const errorPrefix = useId();
  const errorId = (field: string) => `${errorPrefix}-${field}-error`;
  let patch: ReturnType<typeof schedulingPatch> = {};
  let invalid: string | null = null;
  try {
    patch = schedulingPatch(baseline, draft);
  } catch (error) {
    invalid = error instanceof Error ? error.message : 'invalid';
  }
  const rawChanged = JSON.stringify(draft) !== JSON.stringify(initialDraft);
  const dirty = Boolean(Object.keys(patch).length || (invalid && rawChanged));
  const identityValid = authIndex != null && String(authIndex).trim() !== '';
  const editable =
    !disabled && identityValid && !!baseline.warmup_control && !!baseline.limit_policy;
  const requestKey = JSON.stringify({
    name: fileName,
    auth_index: String(authIndex ?? ''),
    ...patch,
  });
  const currentPreview = preview?.key === requestKey ? preview : null;
  const candidate = !invalid ? currentPreview?.response?.account_scheduling : undefined;
  const current = currentPreview?.response?.current_account_scheduling || baseline;
  const ready = Boolean(candidate);
  const locked = !editable || saving;
  // 无草稿时保留最后权威保存值；有草稿时只展示匹配当前请求的候选。
  const displayed = candidate || (!dirty ? current : undefined);
  const modeMature = displayed?.warmup?.mature === true;
  const pacingOnly = displayed?.effective_limits?.pacing_applies === false;
  const profiles = displayed?.warmup_control?.profiles;
  const selectedProfile = profiles?.find((profile) => profile.id === draft.warmup.speed);
  const number = (value?: number | null) =>
    typeof value === 'number' && Number.isFinite(value)
      ? new Intl.NumberFormat(i18n.language).format(value)
      : '—';
  const budget = (value?: number | null) =>
    value === 0 ? text('no_local_budget') : text('daily', { count: value, value: number(value) });
  const modify = (update: (previous: SchedulingDraft) => SchedulingDraft) => {
    setDraft(update);
    setSaved(false);
    setSaveError(false);
  };
  useLayoutEffect(() => {
    onStateChange?.({ dirty, saving });
  }, [dirty, saving, onStateChange]);
  useEffect(() => {
    const id = ++sequence.current;
    if (!editable || invalid) return;
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      authFilesApi
        .previewAccountScheduling(JSON.parse(requestKey), abort.signal)
        .then((response) => {
          if (abort.signal.aborted || sequence.current !== id) return;
          if (
            response.preview !== true ||
            String(response.auth_index) !== String(authIndex) ||
            !response.account_scheduling?.warmup_control ||
            !response.account_scheduling.limit_policy ||
            !response.account_scheduling.effective_limits ||
            !response.current_account_scheduling
          )
            throw new Error('invalid preview');
          setPreview({ key: requestKey, response });
        })
        .catch((error: { status?: number }) => {
          if (!abort.signal.aborted && sequence.current === id)
            setPreview({
              key: requestKey,
              error: error.status === 404 || error.status === 405 ? 'unsupported' : 'failed',
            });
        });
    }, 200);
    return () => {
      window.clearTimeout(timer);
      abort.abort();
    };
  }, [editable, invalid, requestKey, retry, authIndex]);
  const persist = async () => {
    if (savingRef.current || locked || !dirty || invalid || !ready) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError(false);
    try {
      const result = await authFilesApi.updateAccountScheduling(JSON.parse(requestKey));
      if (!result.account_scheduling?.warmup_control || !result.account_scheduling.limit_policy)
        throw new Error('missing authoritative save');
      setBaseline(result.account_scheduling);
      setDraft(schedulingDraft(result.account_scheduling));
      setPreview(null);
      setSaved(true);
      notify(text('saved_toast'), 'success', 2500);
      onApplied?.(result.account_scheduling);
    } catch {
      setSaveError(true);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  const save = () => {
    if (savingRef.current || locked || !dirty || invalid || !ready) return;
    if ('first_production_at' in patch && patch.first_production_at === null) {
      showConfirmation({
        title: text('confirm_clear_anchor'),
        message: t('auth_files.account_settings_scheduling_first_production_at_clear_tooltip'),
        confirmText: text('clear_anchor'),
        cancelText: t('common.cancel'),
        variant: 'danger',
        onConfirm: persist,
      });
      return;
    }
    void persist();
  };
  const setLimit = (
    field: AccountLimitField,
    mode: SchedulingDraft['limits'][AccountLimitField]['mode'],
    value: string
  ) => modify((old) => ({ ...old, limits: { ...old.limits, [field]: { mode, value } } }));
  const metric = (view: AuthFileAccountScheduling, field: AccountLimitField) =>
    field === 'rpm' || field === 'concurrency'
      ? view.effective_limits?.[field]
      : view.limit_policy?.fields[field]?.effective;
  const changedMetrics = LIMIT_FIELDS.filter(
    (field) => metric(current, field) !== metric(candidate || current, field)
  );
  const extraChanges: { label: string; before: string; after: string }[] = [];
  if ('temporary_limits' in patch) {
    const restarting =
      baseline.limit_policy?.temporary_status === 'active' && !!patch.temporary_limits;
    extraChanges.push({
      label: text('temporary_duration'),
      before: restarting
        ? text('original_expiry', {
            time: baseline.limit_policy?.temporary_expires_at
              ? new Date(baseline.limit_policy.temporary_expires_at).toLocaleString(i18n.language)
              : '—',
          })
        : baseline.limit_policy?.temporary_status === 'active'
          ? text('temporary_active')
          : text('no_temporary'),
      after: patch.temporary_limits
        ? text(restarting ? 'temporary_restart' : 'minutes', {
            count: patch.temporary_limits.duration_minutes,
          })
        : text('no_temporary'),
    });
  }
  if (draft.source === 'custom')
    for (const field of LIMIT_FIELDS) {
      const before = initialDraft.limits[field],
        after = draft.limits[field];
      if (
        !changedMetrics.includes(field) &&
        (before.mode !== after.mode || (after.mode !== 'inherit' && before.value !== after.value))
      )
        extraChanges.push({
          label: t('auth_files.pacing.short_' + field),
          before:
            t('auth_files.pacing.' + before.mode) +
            (before.mode === 'inherit' ? '' : ' ' + before.value),
          after:
            t('auth_files.pacing.' + after.mode) +
            (after.mode === 'inherit' ? '' : ' ' + after.value),
        });
    }
  if ('warmup_mode' in patch)
    extraChanges.push({
      label: text('lifecycle'),
      before: text(current.warmup_control?.warmup_mode === 'mature' ? 'mode_mature' : 'mode_auto'),
      after: text(
        candidate?.warmup_control?.warmup_mode === 'mature' ? 'mode_mature' : 'mode_auto'
      ),
    });
  if ('warmup_period_days' in patch)
    extraChanges.push({
      label: text('period'),
      before:
        current.warmup_control?.warmup_period_days == null
          ? text('system_period')
          : String(current.warmup_control.warmup_period_days),
      after:
        candidate?.warmup_control?.warmup_period_days == null
          ? text('system_period')
          : String(candidate.warmup_control.warmup_period_days),
    });
  if ('tier_override' in patch)
    extraChanges.push({
      label: text('tier'),
      before:
        current.tier_source === 'override' ? (current.subscription_tier ?? '—') : text('auto_tier'),
      after: draft.tier === 'auto' ? text('auto_tier') : draft.tier,
    });
  if ('rate_scale' in patch)
    extraChanges.push({
      label: text('legacy_rate'),
      before: number(current.rate_scale),
      after: number(candidate?.rate_scale),
    });
  if ('first_production_at' in patch)
    extraChanges.push({
      label: text('anchor'),
      before: localDateInput(current.first_production_at).replace('T', ' ') || text('auto_anchor'),
      after: draft.anchor.replace('T', ' ') || text('auto_anchor'),
    });
  return (
    <section
      className={styles.editor}
      data-testid="account-scheduling-editor"
      data-preview-ready={ready}
    >
      <div className={styles.current} data-testid="editor-current-saved">
        <span>{text('current_saved')}</span>
        <strong>
          {number(current.effective_limits?.rpm)} {text('rpm_unit')}
        </strong>
        <strong>
          {text('concurrency_value', { value: number(current.effective_limits?.concurrency) })}
        </strong>
        <span>{current.warmup?.mature ? text('mature') : text('warming')}</span>
      </div>
      <fieldset disabled={locked} className={styles.section}>
        <legend>{text('lifecycle')}</legend>
        <div className={styles.choices}>
          {(['auto', 'mature'] as const).map((mode) => (
            <label
              key={mode}
              data-selected={
                mode === 'mature' ? draft.warmup.mode === 'mature' : draft.warmup.mode !== 'mature'
              }
            >
              <input
                type="radio"
                name={'lifecycle-' + fileName}
                checked={
                  mode === 'mature'
                    ? draft.warmup.mode === 'mature'
                    : draft.warmup.mode !== 'mature'
                }
                data-testid={'warmup-mode-' + mode}
                onChange={() =>
                  modify((old) => ({
                    ...old,
                    warmup: {
                      ...old.warmup,
                      mode:
                        mode === 'mature'
                          ? 'mature'
                          : old.periodSource === 'custom'
                            ? 'days'
                            : 'auto',
                    },
                  }))
                }
              />
              {text('mode_' + mode)}
            </label>
          ))}
        </div>
        {draft.warmup.mode !== 'mature' && (
          <div className={styles.periodChoices}>
            <span>{text('period')}</span>
            <div className={styles.choices}>
              {(['inherit', 'custom'] as const).map((source) => (
                <label key={source} data-selected={draft.periodSource === source}>
                  <input
                    type="radio"
                    name={'period-source-' + fileName}
                    checked={draft.periodSource === source}
                    data-testid={source === 'custom' ? 'warmup-mode-days' : 'editor-inherit-period'}
                    onChange={() =>
                      modify((old) => ({
                        ...old,
                        periodSource: source,
                        warmup: { ...old.warmup, mode: source === 'custom' ? 'days' : 'auto' },
                      }))
                    }
                  />
                  {text(source === 'inherit' ? 'system_period' : 'mode_days')}
                </label>
              ))}
            </div>
            {draft.periodSource === 'custom' && (
              <label className={styles.days}>
                <input
                  type="number"
                  aria-label={text('period')}
                  min={1}
                  max={365}
                  step={1}
                  value={draft.warmup.days}
                  data-testid="warmup-period-days"
                  aria-invalid={!!errors.period || undefined}
                  aria-describedby={errors.period ? errorId('period') : undefined}
                  onChange={(event) =>
                    modify((old) => ({
                      ...old,
                      warmup: { ...old.warmup, days: event.target.value },
                    }))
                  }
                />
                <span>{text('days_range')}</span>
                {errors.period && (
                  <small id={errorId('period')} className={styles.error}>
                    {text('integer_range', { min: 1, max: 365 })}
                  </small>
                )}
              </label>
            )}
          </div>
        )}
        <p className={styles.hint}>
          {draft.warmup.mode === 'mature'
            ? text('mature_hint')
            : text('period_hint', {
                value:
                  candidate?.warmup_control?.effective_period_days ??
                  (dirty ? '…' : baseline.warmup_control?.effective_period_days) ??
                  '—',
              })}
        </p>
      </fieldset>
      <fieldset disabled={locked} className={styles.section}>
        <legend>{text('limits_source')}</legend>
        <div className={styles.source}>
          {(['preset', 'custom'] as const).map((source) => (
            <label key={source} data-selected={draft.source === source}>
              <input
                type="radio"
                name={'limit-source-' + fileName}
                checked={draft.source === source}
                data-testid={'editor-source-' + source}
                onChange={() =>
                  modify((old) => ({
                    ...old,
                    source,
                    warmup: {
                      ...old.warmup,
                      speed: source === 'preset' ? (old.warmup.speed ?? 'medium') : null,
                    },
                  }))
                }
              />
              {text('source_' + source)}
            </label>
          ))}
        </div>
        {displayed?.limit_policy?.restricted_reasons.length ? (
          <p className={styles.hint} role="status">
            {text('health_restricted')}
          </p>
        ) : null}
        {draft.source === 'preset' ? (
          modeMature ? (
            <div className={styles.mature} data-testid="editor-mature-policy">
              <strong>
                {text('mature_policy', {
                  rpm: number(displayed?.effective_limits?.rpm),
                  concurrency: number(displayed?.effective_limits?.concurrency),
                })}
              </strong>
              <p>{budget(displayed?.effective_limits?.daily_budget)}</p>
              <p>{text('mature_no_speed')}</p>
            </div>
          ) : (
            <>
              <div className={styles.speedCards} data-testid="speed-profile-picker">
                {SPEED_PROFILES.map((id) => {
                  const profile = profiles?.find((row) => row.id === id);
                  return (
                    <label key={id} data-selected={draft.warmup.speed === id}>
                      <span className={styles.cardTitle}>
                        <input
                          type="radio"
                          name={'speed-' + fileName}
                          checked={draft.warmup.speed === id}
                          disabled={locked}
                          data-testid={'speed-profile-' + id}
                          onChange={() =>
                            modify((old) => ({ ...old, warmup: { ...old.warmup, speed: id } }))
                          }
                        />
                        <strong>{t('auth_files.pacing.speed_' + id)}</strong>
                        {id === 'medium' && <small>{t('auth_files.pacing.suggested')}</small>}
                      </span>
                      <span className={styles.cardMetric}>
                        {profile ? number(profile.rpm) : '—'} <small>{text('rpm_unit')}</small>
                        <span>
                          {text('concurrency_value', {
                            value: profile ? number(profile.concurrency) : '—',
                          })}
                        </span>
                      </span>
                      <small>
                        {profile ? budget(profile.daily_budget) : text('awaiting_preview')}
                      </small>
                    </label>
                  );
                })}
              </div>
              {selectedProfile && (
                <p className={styles.hint}>
                  {text('selected_details', {
                    capacity: selectedProfile.request_capacity,
                    groups: selectedProfile.max_active_bindings,
                  })}
                </p>
              )}
            </>
          )
        ) : (
          <div className={styles.custom} data-testid="editor-custom-fields">
            {LIMIT_FIELDS.map((field) => {
              const item = draft.limits[field];
              const rule = displayed?.limit_policy?.fields[field];
              const inactive =
                pacingOnly && (field === 'request_capacity' || field === 'max_active_bindings');
              return (
                <label key={field} className={styles.customField}>
                  <span>
                    {t('auth_files.pacing.field_' + field)}
                    {inactive && <small>{text('warming_only')}</small>}
                  </span>
                  <div>
                    <select
                      aria-label={
                        t('auth_files.pacing.field_' + field) + ' ' + t('auth_files.pacing.mode')
                      }
                      data-testid={'editor-limit-mode-' + field}
                      value={item.mode}
                      disabled={locked || inactive}
                      onChange={(event) =>
                        setLimit(
                          field,
                          event.target.value as typeof item.mode,
                          item.mode === 'inherit'
                            ? String(rule?.effective ?? item.value)
                            : item.value
                        )
                      }
                    >
                      {(['inherit', 'fixed', 'temporary'] as const).map((mode) => (
                        <option key={mode} value={mode}>
                          {t('auth_files.pacing.' + mode)}
                        </option>
                      ))}
                    </select>
                    <input
                      type="number"
                      step={1}
                      min={rule?.min ?? undefined}
                      max={rule?.max ?? undefined}
                      value={item.mode === 'inherit' ? (rule?.baseline ?? item.value) : item.value}
                      disabled={locked || inactive || item.mode === 'inherit'}
                      data-testid={'editor-limit-' + field}
                      aria-label={t('auth_files.pacing.field_' + field)}
                      aria-invalid={!!errors[field] || undefined}
                      aria-describedby={errors[field] ? errorId(field) : undefined}
                      onChange={(event) => setLimit(field, item.mode, event.target.value)}
                    />
                  </div>
                  {errors[field] && (
                    <small id={errorId(field)} className={styles.error}>
                      {text('integer_range', {
                        min: baseline.limit_policy?.fields[field].min,
                        max: baseline.limit_policy?.fields[field].max,
                      })}
                    </small>
                  )}
                </label>
              );
            })}
            {LIMIT_FIELDS.some((field) => draft.limits[field].mode === 'temporary') && (
              <label className={styles.duration}>
                {text('temporary_duration')}
                <select
                  disabled={locked}
                  value={draft.duration}
                  data-testid="editor-temporary-duration"
                  onChange={(event) =>
                    modify((old) => ({
                      ...old,
                      duration: Number(event.target.value) as 5 | 15 | 30,
                    }))
                  }
                >
                  {[5, 15, 30].map((minutes) => (
                    <option key={minutes} value={minutes}>
                      {text('minutes', { count: minutes })}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        )}
        <p className={styles.hint}>
          {draft.source === 'preset'
            ? draft.warmup.speed === null
              ? text('unchanged_source')
              : text('replace_note')
            : text('custom_note')}
        </p>
        {draft.source === 'custom' && displayed?.effective_limits && (
          <p className={styles.hint}>
            {budget(displayed.effective_limits.daily_budget)} · {text('upstream_limits')}
          </p>
        )}
        {draft.source === 'custom' && baseline.limit_policy?.temporary_status === 'active' && (
          <div className={styles.hint}>
            {text('original_expiry', {
              time: baseline.limit_policy.temporary_expires_at
                ? new Date(baseline.limit_policy.temporary_expires_at).toLocaleString(i18n.language)
                : '—',
            })}{' '}
            <button
              type="button"
              className={styles.textButton}
              disabled={locked}
              data-testid="editor-end-temporary"
              onClick={() =>
                modify((old) => ({
                  ...old,
                  limits: Object.fromEntries(
                    LIMIT_FIELDS.map((name) => [
                      name,
                      old.limits[name].mode !== 'temporary'
                        ? old.limits[name]
                        : {
                            mode:
                              baseline.limit_policy?.fields[name].fixed != null
                                ? 'fixed'
                                : 'inherit',
                            value: String(
                              baseline.limit_policy?.fields[name].fixed ??
                                baseline.limit_policy?.fields[name].baseline ??
                                ''
                            ),
                          },
                    ])
                  ) as SchedulingDraft['limits'],
                }))
              }
            >
              {text('end_temporary')}
            </button>
          </div>
        )}
      </fieldset>
      <details className={styles.maintenance}>
        <summary>{text('maintenance')}</summary>
        <label>
          {text('tier')}
          <select
            value={draft.tier}
            disabled={locked}
            data-testid="editor-tier"
            onChange={(event) =>
              modify((old) => ({ ...old, tier: event.target.value as SchedulingDraft['tier'] }))
            }
          >
            <option value="auto">{text('auto_tier')}</option>
            <option value="max_20x">Max 20x</option>
            <option value="max_5x">Max 5x</option>
            <option value="pro">Pro</option>
          </select>
        </label>
        <label>
          {text('legacy_rate')}
          <input
            type="number"
            min={0.01}
            step="any"
            value={draft.source === 'preset' ? initialDraft.rate : draft.rate}
            disabled={locked}
            data-testid="editor-rate"
            aria-invalid={!!errors.rate || undefined}
            aria-describedby={errors.rate ? errorId('rate') : undefined}
            onChange={(event) =>
              modify((old) => ({
                ...old,
                source: 'custom',
                warmup: { ...old.warmup, speed: null },
                rate: event.target.value,
              }))
            }
          />
        </label>
        {errors.rate && (
          <p id={errorId('rate')} className={styles.error}>
            {t('auth_files.account_settings_scheduling_rate_scale_invalid')}
          </p>
        )}
        <p className={styles.hint}>{text('legacy_rate_hint')}</p>
        <label>
          {text('anchor')}
          <input
            type="datetime-local"
            value={draft.anchor}
            max={localDateInput(new Date().toISOString())}
            disabled={locked}
            data-testid="editor-anchor"
            aria-invalid={!!errors.anchor || undefined}
            aria-describedby={errors.anchor ? errorId('anchor') : undefined}
            onChange={(event) => modify((old) => ({ ...old, anchor: event.target.value }))}
          />
        </label>
        {errors.anchor && (
          <p id={errorId('anchor')} className={styles.error}>
            {t(
              'auth_files.account_settings_scheduling_first_production_at_' +
                (errors.anchor === 'future' ? 'future_error' : 'invalid')
            )}
          </p>
        )}
        <div className={styles.anchorActions}>
          {(['last_activity_at', 'first_auth_at'] as const).map((name) => {
            const value = baseline.anchor_candidates?.[name];
            return value && localDateInput(value) ? (
              <button
                type="button"
                disabled={locked}
                key={name}
                onClick={() => modify((old) => ({ ...old, anchor: localDateInput(value) }))}
              >
                {text(name)}
              </button>
            ) : null;
          })}
          <button
            type="button"
            disabled={locked}
            onClick={() =>
              modify((old) => ({ ...old, anchor: localDateInput(new Date().toISOString()) }))
            }
          >
            {text('set_now')}
          </button>
          {draft.anchor && (
            <button
              type="button"
              disabled={locked}
              data-testid="editor-clear-anchor"
              onClick={() => modify((old) => ({ ...old, anchor: '' }))}
            >
              {text('clear_anchor')}
            </button>
          )}
        </div>
        <p className={styles.hint}>{text('anchor_hint')}</p>
      </details>
      <div className={styles.footer} data-testid="editor-save-footer">
        {dirty && (
          <div className={styles.preview} data-testid="editor-change-preview">
            <strong>{text('unsaved')}</strong>
            {ready ? (
              <>
                <dl>
                  {extraChanges.map((change) => (
                    <div key={change.label}>
                      <dt>{change.label}</dt>
                      <dd>
                        {change.before}
                        <span>→</span>
                        <strong>{change.after}</strong>
                      </dd>
                    </div>
                  ))}
                  {changedMetrics.map((field) => (
                    <div key={field}>
                      <dt>{t('auth_files.pacing.short_' + field)}</dt>
                      <dd>
                        {number(metric(current, field))}
                        <span>→</span>
                        <strong>{number(metric(candidate!, field))}</strong>
                        {pacingOnly &&
                          (field === 'request_capacity' || field === 'max_active_bindings') && (
                            <small>{text('warming_only')}</small>
                          )}
                      </dd>
                    </div>
                  ))}
                  {current.effective_limits?.daily_budget !==
                    candidate?.effective_limits?.daily_budget && (
                    <div>
                      <dt>{text('daily_label')}</dt>
                      <dd>
                        {budget(current.effective_limits?.daily_budget)}
                        <span>→</span>
                        <strong>{budget(candidate?.effective_limits?.daily_budget)}</strong>
                      </dd>
                    </div>
                  )}
                </dl>
                <p>
                  {text('candidate_summary', {
                    stage: candidate?.warmup?.stage ?? '—',
                    speed: candidate?.warmup_control?.speed_profile
                      ? t('auth_files.pacing.speed_' + candidate.warmup_control.speed_profile)
                      : text(draft.source === 'preset' ? 'unchanged_source' : 'source_custom'),
                  })}
                </p>
              </>
            ) : (
              <p>
                {invalid
                  ? text('invalid_' + invalid)
                  : currentPreview?.error
                    ? text('preview_' + currentPreview.error)
                    : text('preview_loading')}
              </p>
            )}
          </div>
        )}
        {!dirty && !editable && <p role="status">{text('preview_unsupported')}</p>}
        {currentPreview?.error && !dirty && (
          <p role="status">{text('preview_' + currentPreview.error)}</p>
        )}
        {currentPreview?.error === 'failed' && (
          <button
            type="button"
            className={styles.textButton}
            onClick={() => setRetry((old) => old + 1)}
          >
            {text('retry_preview')}
          </button>
        )}
        {saveError && (
          <p role="alert" className={styles.error}>
            {text('save_error')}
          </p>
        )}
        <div className={styles.footerActions}>
          <span>{dirty ? text('applies_after_save') : text('saved_current')}</span>
          {dirty && (
            <Button
              variant="ghost"
              disabled={saving}
              onClick={() => {
                setDraft(schedulingDraft(baseline));
                setSaved(false);
                setSaveError(false);
              }}
            >
              {text('discard')}
            </Button>
          )}
          <Button
            disabled={locked || !dirty || !!invalid || !ready}
            loading={saving}
            data-testid="apply-account-limits"
            onClick={save}
          >
            {text(saved && !dirty ? 'saved_button' : 'save')}
          </Button>
        </div>
      </div>
    </section>
  );
}
