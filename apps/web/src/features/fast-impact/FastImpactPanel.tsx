import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Drawer } from '@/components/ui/Drawer';
import type { AuthFileItem } from '@/types/authFile';
import type { UsageAnalyticsFiltersState } from '@/features/usage-analytics/usageAnalyticsModel';
import { formatInUtc8 } from '@/utils/datetime';
import type { FastImpact, FastMetric, FastModel, FastTier } from './types';
import styles from './FastImpactPanel.module.scss';

const number = (value?: number | null) =>
  value == null ? '—' : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
const percent = (value: number | null) =>
  value == null ? '—' : `${value > 0 ? '+' : ''}${number(value)}%`;
const date = (ms: number) =>
  formatInUtc8(ms, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

export function FastImpactPanel({
  data,
  filters,
  accounts,
  onFilters,
  onRequests,
  busy,
  error,
  mock = false,
}: {
  data?: FastImpact;
  filters: UsageAnalyticsFiltersState;
  accounts: AuthFileItem[];
  onFilters: (patch: Partial<UsageAnalyticsFiltersState>) => void;
  onRequests: (model: FastModel, requestId?: string) => void;
  busy?: boolean;
  error?: string;
  mock?: boolean;
}) {
  const { t } = useTranslation();
  const text = (key: string) => t(`fast_impact.${key}`);
  const [selected, setSelected] = useState('');
  const detail = data?.models.find((m) => m.model === selected);
  const metric = filters.fastMetric || 'visible_tps';
  const account = filters.authIndex || 'all';
  const options = [
    { value: 'all', label: text('select_account') },
    ...accounts
      .filter((a) => (a.provider || a.type) === 'codex' && (a.auth_index ?? a.authIndex) != null)
      .map((a) => ({
        value: String(a.auth_index ?? a.authIndex),
        label: a.note || a.label || a.name,
      })),
  ];
  if (account !== 'all' && !options.some((o) => o.value === account))
    options.push({ value: account, label: `${text('historical_account')} · ${account}` });
  const modelMetric = (tier: FastTier): FastMetric => tier[metric];
  const pair = (m: FastModel) => {
    const c = m.cohorts.find((c) => c.key === m.selected_cohort);
    return { a: c?.default || m.tiers.default, b: c?.priority || m.tiers.priority, cohort: c };
  };
  const detailPair = detail ? pair(detail) : null;
  const sources = (tier: FastTier) =>
    Object.entries(tier.sources)
      .map(([key, n]) => `${text(`source_${key}`)} ${n}`)
      .join(' · ') || '—';
  const exclusions = (values: Record<string, number>) =>
    Object.entries(values)
      .map(([key, n]) => `${text(`exclude_${key}`)} ${n}`)
      .join(' · ') || text('none');
  return (
    <section className={styles.root} data-testid="fast-impact" aria-busy={busy}>
      <header className={styles.header}>
        <div>
          <h2>{text('title')}</h2>
          <p>{text('hint')}</p>
        </div>
        <span className={styles.badge}>{mock ? text('mock') : text('observational')}</span>
      </header>
      {mock && (
        <aside className={styles.notice} data-testid="fast-mock-provenance">
          {text('mock_notice')}
        </aside>
      )}
      <div className={styles.controls}>
        <label>
          {text('account')}
          <Select
            value={account}
            options={options}
            ariaLabel={text('account')}
            onChange={(authIndex) => {
              setSelected('');
              onFilters({
                authIndex,
                authFile: 'all',
                provider: 'codex',
                model: 'all',
                status: 'all',
              });
            }}
          />
        </label>
        <label>
          {text('metric')}
          <Select
            value={metric}
            options={['visible_tps', 'end_to_end_tps'].map((value) => ({
              value,
              label: text(value),
            }))}
            ariaLabel={text('metric')}
            onChange={(fastMetric) =>
              onFilters({ fastMetric: fastMetric as 'visible_tps' | 'end_to_end_tps' })
            }
          />
        </label>
        <label>
          {text('mode')}
          <Select
            value={filters.fastMode || 'tier'}
            options={['tier', 'transition'].map((value) => ({ value, label: text(value) }))}
            ariaLabel={text('mode')}
            onChange={(fastMode) => onFilters({ fastMode: fastMode as 'tier' | 'transition' })}
          />
        </label>
      </div>
      <p className={styles.definition}>
        {text(metric === 'visible_tps' ? 'visible_definition' : 'e2e_definition')}
      </p>
      {account === 'all' ? (
        <div className={styles.empty}>{text('select_account')}</div>
      ) : error ? (
        <div role="alert" className={styles.notice}>
          {error}
        </div>
      ) : busy ? (
        <div role="status" className={styles.notice}>
          {text('updating')}
        </div>
      ) : !data ? (
        <div className={styles.empty}>{text('upgrade_required')}</div>
      ) : (
        <>
          <div className={styles.coverage}>
            <span>
              {date(data.from_ms)} — {date(data.to_ms)}
            </span>
            <strong>
              {data.scanned} / {data.matched} {text('attempts')}
            </strong>
            <span>{data.complete ? text('complete') : text('incomplete')}</span>
          </div>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  {[
                    'model',
                    'default',
                    'priority',
                    'change',
                    'samples',
                    'waiting',
                    'reliability',
                  ].map((k) => (
                    <th key={k}>{text(k)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.models.map((m) => {
                  const { a, b, cohort } = pair(m);
                  const all = Object.values(m.tiers);
                  return (
                    <tr key={m.model} data-testid="fast-model-row">
                      <td data-label={text('model')}>
                        <button className={styles.model} onClick={() => setSelected(m.model)}>
                          {m.model}
                        </button>
                        <small>{text(m.status)}</small>
                        <small>
                          {cohort
                            ? `${cohort.effort} · ${cohort.input_bucket} · ${text('cache')} ${cohort.cache_bucket}`
                            : text('unmatched')}
                        </small>
                      </td>
                      <td data-label={text('default')}>
                        <strong>{number(modelMetric(a).p50)}</strong>
                        <small>token/s · p50</small>
                        <small>
                          {text('e2e_short')} {number(a.end_to_end_tps.p50)}
                        </small>
                      </td>
                      <td data-label={text('priority')}>
                        <strong>{number(modelMetric(b).p50)}</strong>
                        <small>token/s · p50</small>
                        <small>
                          {text('e2e_short')} {number(b.end_to_end_tps.p50)}
                        </small>
                      </td>
                      <td
                        data-label={text('change')}
                        className={
                          m.change_pct == null
                            ? ''
                            : m.change_pct >= 0
                              ? styles.positive
                              : styles.negative
                        }
                      >
                        <strong>{percent(m.change_pct)}</strong>
                        <small>
                          {text('coverage')} {number(m.coverage * 100)}%
                        </small>
                      </td>
                      <td data-label={text('samples')}>
                        {modelMetric(a).samples} / {modelMetric(b).samples}
                        <small>
                          {text('default')} / {text('priority')}
                        </small>
                        <small>
                          {text('unknown')} {m.tiers.unknown.attempts}
                        </small>
                      </td>
                      <td data-label={text('waiting')}>
                        {number(
                          a.first_visible_ms.p50 == null ? null : a.first_visible_ms.p50 / 1000
                        )}{' '}
                        /{' '}
                        {number(
                          b.first_visible_ms.p50 == null ? null : b.first_visible_ms.p50 / 1000
                        )}{' '}
                        s
                        <small>
                          {text('first_body')}{' '}
                          {number(a.first_body_ms.p50 == null ? null : a.first_body_ms.p50 / 1000)}{' '}
                          /{' '}
                          {number(b.first_body_ms.p50 == null ? null : b.first_body_ms.p50 / 1000)}{' '}
                          s
                        </small>
                      </td>
                      <td data-label={text('reliability')}>
                        {text('failed')} {all.reduce((n, t) => n + t.failed, 0)}
                        <small>
                          {text('empty')} {all.reduce((n, t) => n + t.empty, 0)} ·{' '}
                          {text('cancelled')} {all.reduce((n, t) => n + t.cancelled, 0)}
                        </small>
                        <small>
                          {text('attempts')} {m.attempts}
                        </small>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {data.models.length === 0 && <div className={styles.empty}>{text('no_data')}</div>}
        </>
      )}
      <footer className={styles.footer}>{text('cost_notice')}</footer>
      <Drawer
        open={Boolean(detail) && !busy}
        onClose={() => setSelected('')}
        title={detail?.model}
        width={780}
        footer={
          <Button onClick={() => detail && onRequests(detail)}>{text('requests')}</Button>
        }
      >
        {detail && detailPair && (
          <div className={styles.detail}>
            <p>
              {text(detail.status)} · {text('coverage')} {number(detail.coverage * 100)}%
            </p>
            {detail.transition && (
              <aside className={styles.notice}>
                {text('observed_switch')} {date(detail.transition.from_ms)} —{' '}
                {date(detail.transition.to_ms)}
                <br />
                {text('equal_windows')} {date(detail.transition.before_from_ms)} →{' '}
                {date(detail.transition.from_ms)} / {date(detail.transition.to_ms)} →{' '}
                {date(detail.transition.after_to_ms)}
              </aside>
            )}
            <h3>{text('distribution')}</h3>
            <div className={styles.cards}>
              {(['default', 'priority', 'unknown', 'flex'] as const).map((tier) => {
                const value = detail.tiers[tier];
                return (
                  <div className={styles.card} key={tier}>
                    <b>{text(tier)}</b>
                    <strong>
                      {number(modelMetric(value).p50)} <small>token/s</small>
                    </strong>
                    <small>
                      p25 {number(modelMetric(value).p25)} · p75 {number(modelMetric(value).p75)} ·
                      n={modelMetric(value).samples}
                    </small>
                    <small>
                      {text('e2e_short')} {number(value.end_to_end_tps.p50)} token/s · n=
                      {value.end_to_end_tps.samples}
                    </small>
                    <small>{sources(value)}</small>
                    <p>{exclusions(value.excluded)}</p>
                  </div>
                );
              })}
            </div>
            <h3>{text('cohorts')}</h3>
            <div className={styles.cohorts}>
              {detail.cohorts.map((c) => (
                <div className={styles.cohort} key={c.key}>
                  <b>
                    {c.effort} · {c.input_bucket} · {text('cache')} {c.cache_bucket}
                  </b>
                  <span>
                    {number(modelMetric(c.default).p50)} → {number(modelMetric(c.priority).p50)}{' '}
                    token/s · {percent(c.change_pct)}
                  </span>
                  <small>
                    {text(c.status)} · n={modelMetric(c.default).samples}/
                    {modelMetric(c.priority).samples}
                  </small>
                </div>
              ))}
            </div>
            <p>{exclusions(detail.excluded)}</p>
            <h3>{text('timeline')}</h3>
            <p>
              {text('timeline_hint')}
              {detail.observations_truncated ? ` · ${text('last_40')}` : ''}
            </p>
            <ol className={styles.timeline}>
              {detail.observations.map((o, i) => (
                <li key={`${o.request_id}-${i}`}>
                  <time>{date(o.started_at_ms)}</time>
                  <span>
                    {text(o.tier)} · {o.output_tokens} tokens ·{' '}
                    {text(o.failed ? 'failed' : 'success')}
                  </span>
                  {o.request_id && (
                    <button
                      className={styles.model}
                      onClick={() => onRequests(detail, o.request_id)}
                    >
                      {o.request_id}
                    </button>
                  )}
                </li>
              ))}
            </ol>
          </div>
        )}
      </Drawer>
    </section>
  );
}
