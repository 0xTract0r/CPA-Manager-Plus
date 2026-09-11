import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import type { AuthFileItem } from '@/types/authFile';
import { EChartsView } from '@/components/charts/EChartsView';
import { useTimezone } from '@/hooks';
import { formatInUtc8 } from '@/utils/datetime';
import type { PerformanceData, PerformanceGroup } from './types';
import {
  coverage,
  comparePerformanceValues,
  milliseconds,
  metricNumber,
  DEFAULT_THRESHOLDS,
  parseThresholdDraft,
  buildPerformanceAccountDirectory,
  resolvePerformanceAccount,
  performanceStatus,
  readThresholds,
  THRESHOLD_KEY,
  type PerformanceAccountSnapshot,
} from './performanceModel';
import styles from './PerformancePanel.module.scss';

export function PerformancePanel({
  data,
  onModel,
  onRequests,
  mock = false,
  authFiles = [],
  accountSnapshots = [],
}: {
  data?: PerformanceData;
  onModel: (model: string) => void;
  onRequests: (model: string) => void;
  mock?: boolean;
  authFiles?: AuthFileItem[];
  accountSnapshots?: PerformanceAccountSnapshot[];
}) {
  const { t, i18n } = useTranslation();
  const { timeZone } = useTimezone();
  const text = (key: string) => t(`performance.${key}`);
  const [thresholds, setThresholds] = useState(readThresholds);
  const toDraft = (value: typeof thresholds) => ({
    latencySeconds: String(value.latencySeconds),
    minTps: String(value.minTps),
    minSamples: String(value.minSamples),
  });
  const [draft, setDraft] = useState(() => toDraft(thresholds));
  const [formError, setFormError] = useState(false);
  const accountDirectory = useMemo(
    () => buildPerformanceAccountDirectory(authFiles, accountSnapshots),
    [authFiles, accountSnapshots]
  );
  const usesDefaults = (Object.keys(DEFAULT_THRESHOLDS) as Array<keyof typeof thresholds>).every(
    (key) => thresholds[key] === DEFAULT_THRESHOLDS[key]
  );
  const [modelQuery, setModelQuery] = useState('');
  const [modelStatus, setModelStatus] = useState('all');
  const [accountQuery, setAccountQuery] = useState('');
  const [provider, setProvider] = useState('all');
  const [modelSort, setModelSort] = useState({ key: 'attempts', descending: true });
  const [accountSort, setAccountSort] = useState({ key: 'attempts', descending: true });
  const [saveError, setSaveError] = useState(false);
  const value = (row: PerformanceGroup, key: string) => {
    switch (key) {
      case 'attempts':
        return row.total_calls;
      case 'success':
        return row.total_calls ? row.success_calls / row.total_calls : null;
      case 'latencyP95':
        return row.latency_ms.p95;
      case 'ttfbP95':
        return row.ttfb_ms.p95;
      case 'speedP50':
        return row.total_tps.p50;
      case 'slowSpeed':
        return row.total_tps.p10;
      case 'coverage':
        return row.total_tps.samples;
      case 'cost':
        return row.estimated_cost;
      case 'status':
        return text(performanceStatus(row, thresholds));
      default:
        return null;
    }
  };
  const models = [...(data?.models ?? [])]
    .filter(
      (row) =>
        row.model.toLowerCase().includes(modelQuery.trim().toLowerCase()) &&
        (modelStatus === 'all' || performanceStatus(row, thresholds) === modelStatus)
    )
    .sort((a, b) =>
      comparePerformanceValues(
        modelSort.key === 'model' ? a.model : value(a, modelSort.key),
        modelSort.key === 'model' ? b.model : value(b, modelSort.key),
        modelSort.descending
      )
    );
  const accountRows = (data?.accounts ?? []).map((row) => ({
    ...row,
    identity: resolvePerformanceAccount(row, accountDirectory),
  }));
  const accountValue = (row: (typeof accountRows)[number], key: string) =>
    key === 'account'
      ? row.identity?.email || row.identity?.name || null
      : key === 'accountNote'
        ? row.identity?.note || null
        : key === 'provider'
          ? row.provider
          : value(row, key);
  const accounts = accountRows
    .filter(
      (row) =>
        (provider === 'all' || row.provider === provider) &&
        [
          row.identity?.email,
          row.identity?.name,
          row.identity?.note,
          row.account_key,
          row.provider,
        ].some((field) => field?.toLowerCase().includes(accountQuery.trim().toLowerCase()))
    )
    .sort((a, b) =>
      comparePerformanceValues(
        accountValue(a, accountSort.key),
        accountValue(b, accountSort.key),
        accountSort.descending
      )
    );
  const sortHeader = (key: string, account = false) => {
    const current = account ? accountSort : modelSort;
    const set = account ? setAccountSort : setModelSort;
    const selected = current.key === key;
    return (
      <th
        key={key}
        scope="col"
        aria-sort={selected ? (current.descending ? 'descending' : 'ascending') : 'none'}
      >
        <button
          type="button"
          onClick={() =>
            set({
              key,
              descending: selected
                ? !current.descending
                : !['model', 'account', 'accountNote', 'provider', 'status'].includes(key),
            })
          }
        >
          {text(key)}{' '}
          <span aria-hidden="true">{selected ? (current.descending ? '↓' : '↑') : '↕'}</span>
        </button>
      </th>
    );
  };
  if (!data)
    return (
      <div className={styles.empty} data-testid="performance-unavailable">
        {text('unavailable')}
      </div>
    );
  const summary = data.summary;
  const alerts = data.models.filter((row) => performanceStatus(row, thresholds) === 'slow');
  const successRate = summary.total_calls
    ? (summary.success_calls / summary.total_calls) * 100
    : null;
  const metricCards = [
    [
      text('latencyP95'),
      milliseconds(summary.latency_ms.p95),
      `${text('latencyHint')} · ${text('average')} ${milliseconds(summary.latency_ms.mean)}`,
    ],
    [
      text('ttfbP95'),
      milliseconds(summary.ttfb_ms.p95),
      `${text('ttfbHint')} · ${text('validSamples')} ${coverage(summary.ttfb_ms)}`,
    ],
    [
      text('speedP50'),
      `${metricNumber(summary.total_tps.p50)} token/s`,
      `${text('slowSpeed')} ${metricNumber(summary.total_tps.p10)} token/s`,
    ],
    [
      text('success'),
      successRate === null ? '—' : `${metricNumber(successRate)}%`,
      `${summary.total_calls} ${text('attempts')}`,
    ],
  ];
  // 时间显示依赖全局时区，空值在折线图中保留间断，不把缺失样本画成零。
  const labels = data.timeline.map((row) =>
    formatInUtc8(
      row.bucket_ms,
      { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' },
      i18n.language
    )
  );
  const chart = (speed: boolean) => ({
    backgroundColor: 'transparent',
    animation: false,
    color: speed ? ['#16a085', '#61b9a3'] : ['#4a90e2', '#b284dd'],
    tooltip: { trigger: 'axis', confine: true },
    legend: { bottom: 0, textStyle: { color: '#8692a6' } },
    grid: { top: 18, left: 50, right: 20, bottom: 68 },
    xAxis: { type: 'category', data: labels, axisLabel: { color: '#8692a6', hideOverlap: true } },
    yAxis: {
      type: 'value',
      name: speed ? 'token/s' : 's',
      axisLabel: { color: '#8692a6' },
      splitLine: { lineStyle: { color: '#8692a622' } },
    },
    series: (speed ? (['p50', 'p10'] as const) : (['p50', 'p95'] as const)).map((key) => ({
      name: text(
        speed
          ? key === 'p50'
            ? 'typicalSpeed'
            : 'slowSpeed'
          : key === 'p50'
            ? 'typicalLatency'
            : 'latencyP95'
      ),
      type: 'line',
      showSymbol: data.timeline.length <= 36,
      connectNulls: false,
      data: data.timeline.map((row) => {
        const value = (speed ? row.total_tps : row.latency_ms)[key];
        return value === null ? null : value / (speed ? 1 : 1000);
      }),
    })),
  });
  const applyThresholds = (next: typeof thresholds) => {
    setDraft(toDraft(next));
    setFormError(false);
    setThresholds(next);
    try {
      localStorage.setItem(THRESHOLD_KEY, JSON.stringify(next));
      setSaveError(false);
    } catch {
      setSaveError(true);
    }
  };
  const statusLabel = (row: PerformanceGroup) => text(performanceStatus(row, thresholds));
  return (
    <section className={styles.root} data-testid="model-performance" data-timezone={timeZone}>
      <div className={styles.header}>
        <div>
          <h2>{text('title')}</h2>
          <p>{text('intro')}</p>
        </div>
        <span className={styles.tag}>{mock ? text('mock') : text('fullRange')}</span>
      </div>
      <div className={styles.cards}>
        {metricCards.map(([label, value, meta]) => (
          <div className={styles.card} key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
            <small>{meta}</small>
          </div>
        ))}
      </div>
      {summary.total_calls === 0 ? <p className={styles.empty}>{text('empty')}</p> : null}
      <details className={styles.guide}>
        <summary>{text('readingGuide')}</summary>
        <p>{text('typicalHelp')}</p>
        <p>{text('latencyHelp')}</p>
        <p>{text('speedHelp')}</p>
      </details>
      <div className={styles.charts}>
        <div className={styles.panel}>
          <h3>{text('latencyTrend')}</h3>
          <EChartsView
            option={chart(false)}
            ariaLabel={text('latencyTrend')}
            style={{ height: 250 }}
          />
        </div>
        <div className={styles.panel}>
          <h3>{text('speedTrend')}</h3>
          <EChartsView
            option={chart(true)}
            ariaLabel={text('speedTrend')}
            style={{ height: 250 }}
          />
        </div>
      </div>
      <div className={styles.panel}>
        <h3>{text('compare')}</h3>
        <div className={styles.filters}>
          <label>
            {text('searchModel')}
            <input
              type="search"
              value={modelQuery}
              placeholder={text('modelSearchHint')}
              onChange={(event) => setModelQuery(event.target.value)}
            />
          </label>
          <label>
            {text('status')}
            <select aria-label={text('status')} value={modelStatus} onChange={(event) => setModelStatus(event.target.value)}>
              {['all', 'slow', 'healthy', 'insufficient'].map((key) => (
                <option key={key} value={key}>
                  {text(key)}
                </option>
              ))}
            </select>
          </label>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setModelQuery('');
              setModelStatus('all');
              setModelSort({ key: 'attempts', descending: true });
            }}
          >
            {text('resetTable')}
          </Button>
          <span role="status">
            {t('performance.rowCount', { shown: models.length, total: data.models.length })}
          </span>
        </div>
        <p>{text('tableScope')}</p>
        <div className={styles.thresholdOverview}>
          <div>
            <strong>{text(usesDefaults ? 'defaultReference' : 'customReference')}</strong>
            <p>
              {t('performance.thresholdSummary', {
                latency: thresholds.latencySeconds,
                speed: thresholds.minTps,
                samples: thresholds.minSamples,
              })}
            </p>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => applyThresholds({ ...DEFAULT_THRESHOLDS })}
          >
            {text('resetDefaults')}
          </Button>
        </div>
        <details className={styles.guide}>
          <summary>{text('editThresholds')}</summary>
          <p>{text('thresholdHint')}</p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const next = parseThresholdDraft(draft);
              if (!next) {
                setFormError(true);
                return;
              }
              applyThresholds(next);
            }}
          >
            <div className={styles.filters}>
              {(
                [
                  ['latencySeconds', 'maxLatency', 'latencySettingHelp'],
                  ['minTps', 'minSpeed', 'speedSettingHelp'],
                  ['minSamples', 'minSamples', 'sampleSettingHelp'],
                ] as const
              ).map(([key, label, hint]) => (
                <label key={key}>
                  {text(label)}
                  <input
                    aria-label={text(label)}
                    aria-describedby={'performance-' + key + '-hint'}
                    type="number"
                    required
                    min="0"
                    step={key === 'minSamples' ? '1' : 'any'}
                    max={key === 'latencySeconds' ? 3600 : key === 'minTps' ? 100000 : 1000000}
                    value={draft[key]}
                    onChange={(event) =>
                      setDraft((previous) => ({ ...previous, [key]: event.target.value }))
                    }
                  />
                  <small id={'performance-' + key + '-hint'}>{text(hint)}</small>
                </label>
              ))}
            </div>
            {formError ? <p role="alert">{text('invalidSettings')}</p> : null}
            <Button type="submit" size="sm">
              {text('applySettings')}
            </Button>
          </form>
        </details>
        {saveError ? <p role="alert">{text('saveError')}</p> : null}
        {alerts.length > 0 ? (
          <p className={styles.alert} role="status">
            {text('alert')}: {alerts.map((row) => row.model).join(' · ')}
          </p>
        ) : null}
        <div className={styles.tableWrap}>
          <table>
            <thead>
              <tr>
                {[
                  'model',
                  'attempts',
                  'success',
                  'latencyP95',
                  'ttfbP95',
                  'speedP50',
                  'slowSpeed',
                  'coverage',
                  'status',
                ].map((key) => sortHeader(key))}
                <th>{text('details')}</th>
              </tr>
            </thead>
            <tbody>
              {models.length === 0 ? (
                <tr>
                  <td colSpan={10} className={styles.empty}>
                    {text('noMatches')}
                  </td>
                </tr>
              ) : null}
              {models.map((row) => (
                <tr key={row.model}>
                  <td>
                    <button onClick={() => onModel(row.model)}>{row.model}</button>
                  </td>
                  <td>{row.total_calls}</td>
                  <td>
                    {row.total_calls
                      ? `${metricNumber((100 * row.success_calls) / row.total_calls)}%`
                      : '—'}
                  </td>
                  <td>{milliseconds(row.latency_ms.p95)}</td>
                  <td>{milliseconds(row.ttfb_ms.p95)}</td>
                  <td>{metricNumber(row.total_tps.p50)}</td>
                  <td>{metricNumber(row.total_tps.p10)}</td>
                  <td>{coverage(row.total_tps)}</td>
                  <td
                    className={
                      performanceStatus(row, thresholds) === 'slow' ? styles.slow : styles.muted
                    }
                  >
                    {statusLabel(row)}
                  </td>
                  <td>
                    <button onClick={() => onRequests(row.model)}>{text('requests')}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className={styles.charts}>
        <details className={styles.panel}>
          <summary>{text('distribution')}</summary>
          <p>{text('distributionHelp')}</p>
          <div className={styles.tableWrap}>
            <table>
              <thead>
                <tr>
                  <th>{text('metric')}</th>
                  <th>{text('average')}</th>
                  <th>{text('p10Label')}</th>
                  <th>{text('p50Label')}</th>
                  <th>{text('p95Label')}</th>
                  <th>{text('p99Label')}</th>
                  <th>{text('validSamples')}</th>
                </tr>
              </thead>
              <tbody>
                {(['latency_ms', 'ttfb_ms', 'total_tps'] as const).map((key) => {
                  const metric = summary[key];
                  const format = key === 'total_tps' ? metricNumber : milliseconds;
                  return (
                    <tr key={key}>
                      <td>{text(key)}</td>
                      {(['mean', 'p10', 'p50', 'p95', 'p99'] as const).map((p) => (
                        <td key={p}>{format(metric[p])}</td>
                      ))}
                      <td>{coverage(metric)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </details>
        <details className={styles.panel}>
          <summary>{text('capacity')}</summary>
          <div className={styles.tableWrap}>
            <table>
              <tbody>
                {[
                  [text('rpm'), metricNumber(summary.requests_per_minute)],
                  [text('throughput'), `${metricNumber(summary.output_tokens_per_second)} token/s`],
                  [
                    text('concurrency'),
                    summary.concurrency_samples
                      ? metricNumber(summary.observed_peak_concurrency, 0)
                      : '—',
                  ],
                  [text('rateLimited'), `${summary.rate_limited_calls} / ${summary.total_calls}`],
                  [text('timeouts'), `${summary.timeout_calls} / ${summary.total_calls}`],
                  [text('cancelled'), metricNumber(summary.cancelled_calls, 0)],
                  [text('retries'), `${summary.retried_requests} / ${summary.linked_requests}`],
                ].map(([label, value]) => (
                  <tr key={label}>
                    <td>{label}</td>
                    <td>{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>{text('concurrencyHint')}</p>
        </details>
      </div>
      <div className={styles.panel}>
        <h3>{text('accounts')}</h3>
        <div className={styles.filters}>
          <label>
            {text('searchAccount')}
            <input
              type="search"
              value={accountQuery}
              placeholder={text('accountSearchHint')}
              onChange={(event) => setAccountQuery(event.target.value)}
            />
          </label>
          <label>
            {text('provider')}
            <select aria-label={text('provider')} value={provider} onChange={(event) => setProvider(event.target.value)}>
              <option value="all">{text('all')}</option>
              {[...new Set(data.accounts.map((row) => row.provider))].sort().map((key) => (
                <option key={key} value={key}>
                  {key || text('unknown')}
                </option>
              ))}
            </select>
          </label>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setAccountQuery('');
              setProvider('all');
              setAccountSort({ key: 'attempts', descending: true });
            }}
          >
            {text('resetTable')}
          </Button>
          <span role="status">
            {t('performance.rowCount', { shown: accounts.length, total: data.accounts.length })}
          </span>
        </div>
        <p>{text('tableScope')}</p>
        <div className={styles.tableWrap}>
          <table>
            <thead>
              <tr>
                {[
                  'account',
                  'accountNote',
                  'provider',
                  'attempts',
                  'latencyP95',
                  'speedP50',
                  'cost',
                ].map((key) => sortHeader(key, true))}
              </tr>
            </thead>
            <tbody>
              {accounts.length === 0 ? (
                <tr>
                  <td colSpan={7} className={styles.empty}>
                    {text('noMatches')}
                  </td>
                </tr>
              ) : null}
              {accounts.map((row) => {
                const identity = row.identity;
                return (
                  <tr key={`${row.provider}:${row.account_key}`}>
                    <td className={styles.accountIdentity}>
                      <strong>
                        {identity?.email || identity?.name || text('unidentifiedAccount')}
                      </strong>
                      {identity?.email && identity.name && identity.email !== identity.name ? (
                        <small>{identity.name}</small>
                      ) : null}
                      {!identity ? <small>{text('accountMissingHint')}</small> : null}
                      {identity?.historical ? <small>{text('historicalAccount')}</small> : null}
                      <details>
                        <summary>{text('accountIdentifier')}</summary>
                        <code>{row.account_key || '—'}</code>
                      </details>
                    </td>
                    <td className={styles.accountNote}>
                      {identity?.note || text(identity?.historical ? 'noHistoricalNote' : 'noNote')}
                    </td>
                    <td>{row.provider || '—'}</td>
                    <td>{row.total_calls}</td>
                    <td>{milliseconds(row.latency_ms.p95)}</td>
                    <td>{metricNumber(row.total_tps.p50)}</td>
                    <td>${metricNumber(row.estimated_cost, 4)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p>{text('compareHint')}</p>
      </div>
      <div className={styles.cards}>
        {[
          [text('cost'), `$${metricNumber(summary.estimated_cost, 4)}`, text('estimated')],
          [
            text('costPerSuccess'),
            summary.success_calls
              ? `$${metricNumber(summary.estimated_cost / summary.success_calls, 4)}`
              : '—',
            text('costHint'),
          ],
          [text('cacheTokens'), metricNumber(summary.cached_tokens, 0), text('cacheHint')],
          [
            text('telemetryCoverage'),
            `${summary.telemetry_samples} / ${summary.total_calls}`,
            text('legacyHint'),
          ],
        ].map(([label, value, meta]) => (
          <div className={styles.card} key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
            <small>{meta}</small>
          </div>
        ))}
      </div>
      <div className={styles.panel}>
        <h3>{text('definitions')}</h3>
        <p>{text('definitionsHint')}</p>
        <p>{text('qualityHint')}</p>
      </div>
    </section>
  );
}
