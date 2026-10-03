import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Drawer } from '@/components/ui/Drawer';
import type { AuthFileItem } from '@/types/authFile';
import type { UsageAnalyticsFiltersState } from '@/features/usage-analytics/usageAnalyticsModel';
import { formatInUtc8 } from '@/utils/datetime';
import type { FastImpact, FastMetric, FastModel } from './types';
import { buildFastImpactViewModel, buildFastModelComparison } from './fastImpactViewModel';
import styles from './FastImpactPanel.module.scss';

const number = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 1 });
const date = (ms: number) => formatInUtc8(ms, {
  month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});
const modes = ['default', 'priority', 'unknown', 'flex'] as const;

export function FastImpactPanel({
  data, filters, accounts, onFilters, onRequests, busy, error, mock = false, snapshotAt,
}: {
  data?: FastImpact;
  filters: UsageAnalyticsFiltersState;
  accounts: AuthFileItem[];
  onFilters: (patch: Partial<UsageAnalyticsFiltersState>) => void;
  onRequests: (model: FastModel, requestId?: string) => void;
  busy?: boolean;
  error?: string;
  mock?: boolean;
  snapshotAt?: number;
}) {
  const { t } = useTranslation();
  const text = (key: string, options?: Record<string, unknown>) => t(`fast_impact.${key}`, options);
  const [selected, setSelected] = useState('');
  const [originalRange, setOriginalRange] = useState<Pick<UsageAnalyticsFiltersState, 'timeRange' | 'customRange'> | null>(null);
  const account = filters.authIndex || 'all';
  // 兼容旧链接和本地存储；首页只使用一个明确口径。
  useEffect(() => {
    if (filters.fastMetric !== 'end_to_end_tps' || filters.fastMode !== 'tier') {
      onFilters({ fastMetric: 'end_to_end_tps', fastMode: 'tier' });
    }
  }, [filters.fastMetric, filters.fastMode, onFilters]);
  const options = [
    { value: 'all', label: text('select_account') },
    ...accounts.filter((a) => (a.provider || a.type) === 'codex' && (a.auth_index ?? a.authIndex) != null)
      .map((a) => ({ value: String(a.auth_index ?? a.authIndex), label: a.note || a.label || a.name })),
  ];
  if (account !== 'all' && !options.some((o) => o.value === account)) {
    options.push({ value: account, label: `${text('historical_account')} · ${account}` });
  }
  const selectedAccount = accounts.find((a) => String(a.auth_index ?? a.authIndex) === account);
  const fastEnabled = selectedAccount?.account_settings?.fast ?? selectedAccount?.accountSettings?.fast;
  const updating = busy || Boolean(data && (data.metric !== 'end_to_end_tps' || data.mode !== 'tier'));
  const readiness = data ? buildFastImpactViewModel(data, 'end_to_end_tps') : null;
  const rows = (data?.models || []).map((model) => ({ model, ...buildFastModelComparison(model) }))
    .sort((a, b) => Number(b.matched) - Number(a.matched) || b.model.attempts - a.model.attempts);
  const currentRows = rows.filter((row) => row.model.tiers.default.attempts + row.model.tiers.priority.attempts > 0);
  const legacyRows = rows.filter((row) => row.model.tiers.default.attempts + row.model.tiers.priority.attempts === 0);
  const detail = data?.models.find((model) => model.model === selected);
  const detailPair = detail ? buildFastModelComparison(detail) : null;
  const metricValue = (metric: FastMetric) => metric.p50 == null ? text('no_sample') : `${number(metric.p50)} token/s`;
  const exclusions = (values: Record<string, number>) => Object.entries(values)
    .map(([key, count]) => `${text(`exclude_${key}`)} ${count}`).join(' · ') || text('none');
  const activityMax = Math.max(1, ...(data?.activity || []).map((bucket) =>
    bucket.default_attempts + bucket.priority_attempts + bucket.unknown_attempts + bucket.flex_attempts));
  const legend = (
    <div className={styles.legend}>
      {modes.filter((mode) => mode !== 'flex' || (readiness?.flexAttempts || 0) > 0).map((mode) => (
        <span key={mode}><i className={styles[mode]} />{text(mode === 'unknown' ? 'unrecorded' : mode)}</span>
      ))}
    </div>
  );
  const renderBars = (a: FastMetric, b: FastMetric) => {
    const maximum = Math.max(1, a.p50 || 0, b.p50 || 0);
    return <div className={styles.barGroup}>
      {([{ mode: 'default', metric: a }, { mode: 'priority', metric: b }] as const).map(({ mode, metric }) => (
        <div className={styles.barRow} key={mode}>
          <span>{text(mode)}</span>
          {metric.samples > 0 && metric.p50 != null ? <>
            <div className={styles.barTrack}><i className={styles[mode]} style={{ width: `${Math.max(0, metric.p50 / maximum * 100)}%` }} /></div>
            <span className={styles.barValue}>{number(metric.p50)} <small>token/s</small></span>
          </> : <span className={styles.barMissing}>{text(mode === 'priority' ? 'priority_timing_gap' : 'default_timing_gap')}</span>}
        </div>
      ))}
    </div>;
  };

  return <section className={styles.root} data-testid="fast-impact" aria-busy={updating}>
    <header className={styles.header}>
      <h2>{text('title')}</h2>
      <p>{text('simple_hint')}</p>
      {snapshotAt && <span className={styles.snapshot}>{text('snapshot_label', { time: date(snapshotAt) })}</span>}
    </header>
    {mock && <aside className={styles.notice} data-testid="fast-mock-provenance">
      {text(account === 'preview-synthetic' ? 'synthetic_notice' : 'production_notice')}
    </aside>}
    <div className={styles.controls}>
      <label>{text('account')}<Select value={account} options={options} ariaLabel={text('account')}
        onChange={(authIndex) => {
          setSelected('');
          setOriginalRange(null);
          onFilters({ authIndex, authFile: 'all', provider: 'codex', model: 'all', status: 'all', fastMetric: 'end_to_end_tps', fastMode: 'tier' });
        }} /></label>
      {account !== 'all' && <span className={styles.accountState}>
        <i className={fastEnabled === true ? styles.stateOn : styles.stateNeutral} />
        {text(snapshotAt ? 'snapshot_setting' : 'current_setting')} · {text(fastEnabled === true ? 'setting_on' : fastEnabled === false ? 'setting_off' : 'setting_unknown')}
      </span>}
    </div>
    {account === 'all' ? <div className={styles.empty}>{text('select_account')}</div>
      : error ? <div role="alert" className={styles.notice}>{error}<span>{text('retry_from_toolbar')}</span></div>
      : updating ? <div role="status" className={styles.empty}>{text('updating')}</div>
      : !data ? <div className={styles.empty}>{text('no_data')}</div>
      : <>
        {!data.complete && <div role="alert" className={styles.notice}>{text('partial_range')}</div>}
        <section className={styles.comparison} data-testid="fast-comparison-chart">
          <div className={styles.sectionHeader}>
            <div><h3>{text('overall_title')}</h3><p>{text('overall_hint')}</p></div>
            <span className={styles.unit}>{text('per_second')}</span>
          </div>
          {currentRows.length === 0 ? <div className={styles.empty} data-testid="fast-empty-explanation">
            {text(readiness && readiness.unknownAttempts > 0 ? 'legacy_gap' : 'no_data')}
          </div> : currentRows.map((row) => {
            const change = data.complete && row.change != null ? Math.round(row.change * 10) / 10 : null;
            const canShowBars = row.matched || row.a.samples === 0 || row.b.samples === 0;
            return <article className={styles.modelCard} key={row.model.model} data-testid="fast-model-row">
              <div className={styles.modelHeading}>
                <h4>{row.model.model_resolution === 'unresolved' ? text('unresolved_model', { model: row.model.model }) : row.model.model}</h4>
                <Button size="sm" variant="ghost" onClick={() => setSelected(row.model.model)} aria-label={`${row.model.model} · ${text('evidence')}`}>{text('evidence')} ↗</Button>
              </div>
              <div className={styles.modelContent}>
                {canShowBars ? renderBars(row.a, row.b) : <p className={styles.loadGap}>{text(row.reason)}</p>}
                <div className={styles.result}>
                  {change != null ? <>
                    <span className={change > 0 ? styles.positive : change < 0 ? styles.negative : ''}>{text(change > 0 ? 'faster_by' : change < 0 ? 'slower_by' : 'same_speed', { percent: number(Math.abs(change)) })}</span>
                    <small>{text(row.preliminary ? 'initial_observation' : 'matched_observation')}</small>
                  </> : canShowBars && <span className={styles.gap}>{text(data.complete ? row.reason : 'partial_result')}</span>}
                </div>
              </div>
              <p className={styles.sampleLine}>{text(row.matched ? 'matched_samples' : 'recorded_samples', { defaultCount: row.a.samples, priorityCount: row.b.samples })}</p>
            </article>;
          })}
        </section>
        {data.activity && data.activity.length > 0 && <section className={styles.activity} data-testid="fast-activity-chart">
          <div className={styles.sectionHeader}><div><h3>{text('activity_title')}</h3><p>{text('activity_hint')}</p></div>{legend}</div>
          <div className={styles.activityPlot}>
            {data.activity.map((bucket) => {
              const total = bucket.default_attempts + bucket.priority_attempts + bucket.unknown_attempts + bucket.flex_attempts;
              const label = `${date(bucket.from_ms)} · ${total ? modes.map((mode) => `${text(mode === 'unknown' ? 'unrecorded' : mode)} ${bucket[`${mode}_attempts`]}`).join(' · ') : text('no_requests')}`;
              return <button key={bucket.from_ms} className={styles.activityBucket} title={label} aria-label={label} disabled={!total}
                onClick={() => {
                  if (!originalRange) setOriginalRange({ timeRange: filters.timeRange, customRange: filters.customRange });
                  onFilters({ timeRange: 'custom', customRange: { startMs: bucket.from_ms, endMs: bucket.to_ms } });
                }}>
                <span className={styles.activityStack} style={{ height: `${total / activityMax * 100}%` }}>
                  {modes.filter((mode) => bucket[`${mode}_attempts`] > 0).map((mode) => <i key={mode} className={styles[mode]} style={{ height: `${bucket[`${mode}_attempts`] / total * 100}%` }} />)}
                </span>
              </button>;
            })}
          </div>
          <div className={styles.activityAxis}><span>{date(data.from_ms)}</span><span>{date(data.to_ms)}</span></div>
          {originalRange && <Button size="sm" variant="secondary" onClick={() => { onFilters(originalRange); setOriginalRange(null); }}>{text('restore_range')}</Button>}
        </section>}
        <details className={styles.notes} data-testid="fast-data-readiness">
          <summary>{text('data_notes', { count: readiness?.unknownAttempts.toLocaleString() || '0' })}</summary>
          <p>{text('history_explanation')}</p>
          <p>{text('request_counts', { defaultCount: readiness?.defaultAttempts.toLocaleString(), priorityCount: readiness?.priorityAttempts.toLocaleString(), unknownCount: readiness?.unknownAttempts.toLocaleString(), flexCount: readiness?.flexAttempts.toLocaleString() })}</p>
          <p>{text('query_range', { from: date(data.from_ms), to: date(data.to_ms), count: data.scanned.toLocaleString() })}</p>
          {legacyRows.map((row) => <div className={styles.legacyRow} key={row.model.model}><span>{row.model.model}</span><span>{text('unknown_requests', { count: row.model.tiers.unknown.attempts.toLocaleString() })}</span><Button size="xs" variant="ghost" onClick={() => setSelected(row.model.model)}>{text('evidence')}</Button></div>)}
        </details>
      </>}
    <footer className={styles.footer}>{text('simple_disclaimer')}</footer>
    <Drawer open={Boolean(detail) && !updating} onClose={() => setSelected('')} title={detail?.model} width={720}
      footer={<Button onClick={() => detail && onRequests(detail)}>{text('requests')}</Button>}>
      {detail && detailPair && <div className={styles.detail}>
        <section><h3>{text('overall_title')}</h3><p>{text('overall_definition')}</p>
          {detailPair.matched ? <>{renderBars(detailPair.a, detailPair.b)}<p>{text('matched_samples', { defaultCount: detailPair.a.samples, priorityCount: detailPair.b.samples })}</p></>
            : <p>{text(detailPair.reason)}</p>}
        </section>
        <section><h3>{text('visible_title')}</h3><p>{text('visible_hint')}</p>
          {detailPair.matched && detailPair.defaultTier.visible_tps.samples > 0 && detailPair.priorityTier.visible_tps.samples > 0
            ? renderBars(detailPair.defaultTier.visible_tps, detailPair.priorityTier.visible_tps)
            : <div className={styles.metricFacts}>{(['default', 'priority'] as const).map((mode) => <p key={mode}>{text(mode)}：{metricValue(detail.tiers[mode].visible_tps)} <small>({text('sample_count', { count: detail.tiers[mode].visible_tps.samples })})</small></p>)}<p>{text('visible_not_comparable')}</p></div>}
        </section>
        <section><h3>{text('sample_basis')}</h3><p>{text('basis_explanation')}</p>
          {detailPair.cohort && <div className={styles.basis}><span>{text('reasoning')} {detailPair.cohort.effort}</span><span>{text('input_length')} {detailPair.cohort.input_bucket}</span><span>{text('cache_share')} {detailPair.cohort.cache_bucket}</span></div>}
          <p>{text('sample_coverage', { percent: number(detail.coverage * 100) })}</p>
        </section>
        <details className={styles.notes}><summary>{text('all_records')}</summary>
          <div className={styles.factsGrid}>{modes.filter((mode) => detail.tiers[mode].attempts > 0).map((mode) => {
            const tier = detail.tiers[mode];
            return <div className={styles.factCard} key={mode}><h4>{text(mode === 'unknown' ? 'unrecorded' : mode)}</h4>
              <p>{text('attempt_count', { count: tier.attempts })}</p><p>{text('overall_short')}：{metricValue(tier.end_to_end_tps)}</p>
              <p>{text('visible_title')}：{metricValue(tier.visible_tps)}</p>
              <p>{text('failed')} {tier.failed} · {text('cancelled')} {tier.cancelled} · {text('empty')} {tier.empty}</p>
              <p>{exclusions(tier.excluded)}</p>
            </div>;
          })}</div>
        </details>
        <details className={styles.notes}><summary>{text('timeline')}</summary><p>{text('timeline_hint')}{detail.observations_truncated ? ` · ${text('last_40')}` : ''}</p>
          <ol className={styles.timeline}>{detail.observations.map((observation, i) => <li key={`${observation.request_id}-${i}`}>
            <time>{date(observation.started_at_ms)}</time><span>{text(observation.tier)} · {text(observation.failed ? 'failed' : 'success')}</span>
            {observation.request_id && <Button size="xs" variant="ghost" onClick={() => onRequests(detail, observation.request_id)}>{text('view_request')}</Button>}
          </li>)}</ol>
        </details>
      </div>}
    </Drawer>
  </section>;
}
