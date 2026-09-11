import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EChartsView } from '@/components/charts/EChartsView';
import { useTimezone } from '@/hooks';
import { formatInUtc8 } from '@/utils/datetime';
import type { PerformanceData, PerformanceGroup } from './types';
import {
  coverage,
  milliseconds,
  metricNumber,
  normalizeThresholds,
  performanceStatus,
  readThresholds,
  THRESHOLD_KEY,
} from './performanceModel';
import styles from './PerformancePanel.module.scss';

export function PerformancePanel({
  data,
  onModel,
  onRequests,
  mock = false,
}: {
  data?: PerformanceData;
  onModel: (model: string) => void;
  onRequests: (model: string) => void;
  mock?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const { timeZone } = useTimezone();
  const text = (key: string) => t(`performance.${key}`);
  const [thresholds, setThresholds] = useState(readThresholds);
  const [sort, setSort] = useState('latency');
  const [saveError, setSaveError] = useState(false);
  const models = useMemo(
    () =>
      [...(data?.models ?? [])].sort((a, b) => {
        if (sort === 'model') return a.model.localeCompare(b.model);
        const av = sort === 'speed' ? a.total_tps.p50 : a.latency_ms.p95;
        const bv = sort === 'speed' ? b.total_tps.p50 : b.latency_ms.p95;
        if (av === null) return bv === null ? a.model.localeCompare(b.model) : 1;
        if (bv === null) return -1;
        return bv - av;
      }),
    [data?.models, sort]
  );
  if (!data)
    return (
      <div className={styles.empty} data-testid="performance-unavailable">
        {text('unavailable')}
      </div>
    );
  const summary = data.summary;
  const alerts = models.filter((row) => performanceStatus(row, thresholds) === 'slow');
  const successRate = summary.total_calls
    ? (summary.success_calls / summary.total_calls) * 100
    : null;
  const metricCards = [
    [
      text('latencyP95'),
      milliseconds(summary.latency_ms.p95),
      `${text('average')} ${milliseconds(summary.latency_ms.mean)}`,
    ],
    [
      text('ttfbP95'),
      milliseconds(summary.ttfb_ms.p95),
      `${text('validSamples')} ${coverage(summary.ttfb_ms)}`,
    ],
    [
      text('speedP50'),
      metricNumber(summary.total_tps.p50),
      `P10 ${metricNumber(summary.total_tps.p10)} · token/s`,
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
      name: key.toUpperCase(),
      type: 'line',
      showSymbol: false,
      connectNulls: false,
      data: data.timeline.map((row) => {
        const value = (speed ? row.total_tps : row.latency_ms)[key];
        return value === null ? null : value / (speed ? 1 : 1000);
      }),
    })),
  });
  const updateThreshold = (key: keyof typeof thresholds, value: string) => {
    const next = normalizeThresholds({ ...thresholds, [key]: value });
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
            {text('sort')}
            <select value={sort} onChange={(event) => setSort(event.target.value)}>
              <option value="latency">{text('latencyP95')}</option>
              <option value="speed">{text('speedP50')}</option>
              <option value="model">{text('model')}</option>
            </select>
          </label>
          <label>
            {text('maxLatency')}
            <input
              type="number"
              min="1"
              max="3600"
              value={thresholds.latencySeconds}
              onChange={(event) => updateThreshold('latencySeconds', event.target.value)}
            />
          </label>
          <label>
            {text('minSpeed')}
            <input
              type="number"
              min="1"
              max="100000"
              value={thresholds.minTps}
              onChange={(event) => updateThreshold('minTps', event.target.value)}
            />
          </label>
          <label>
            {text('minSamples')}
            <input
              type="number"
              min="1"
              max="1000000"
              value={thresholds.minSamples}
              onChange={(event) => updateThreshold('minSamples', event.target.value)}
            />
          </label>
        </div>
        <p>
          {text('thresholdHint')}
          {saveError ? ` ${text('saveError')}` : ''}
        </p>
        {alerts.length > 0 ? (
          <p className={styles.alert} role="status">
            {text('alert')}: {alerts.map((row) => row.model).join(' · ')}
          </p>
        ) : null}
        <div className={styles.tableWrap}>
          <table>
            <thead>
              <tr>
                <th>{text('model')}</th>
                <th>{text('attempts')}</th>
                <th>{text('success')}</th>
                <th>{text('latencyP95')}</th>
                <th>{text('ttfbP95')}</th>
                <th>{text('speedP50')}</th>
                <th>TPS P10</th>
                <th>{text('coverage')}</th>
                <th>{text('status')}</th>
                <th>{text('details')}</th>
              </tr>
            </thead>
            <tbody>
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
        <div className={styles.panel}>
          <h3>{text('distribution')}</h3>
          <div className={styles.tableWrap}>
            <table>
              <thead>
                <tr>
                  <th>{text('metric')}</th>
                  <th>{text('average')}</th>
                  <th>P10</th>
                  <th>P50</th>
                  <th>P95</th>
                  <th>P99</th>
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
        </div>
        <div className={styles.panel}>
          <h3>{text('capacity')}</h3>
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
        </div>
      </div>
      <div className={styles.panel}>
        <h3>{text('accounts')}</h3>
        <div className={styles.tableWrap}>
          <table>
            <thead>
              <tr>
                <th>{text('account')}</th>
                <th>{text('provider')}</th>
                <th>{text('attempts')}</th>
                <th>{text('latencyP95')}</th>
                <th>{text('speedP50')}</th>
                <th>{text('cost')}</th>
              </tr>
            </thead>
            <tbody>
              {data.accounts.map((row) => (
                <tr key={`${row.provider}:${row.account_key}`}>
                  <td>{row.account_key || '—'}</td>
                  <td>{row.provider || '—'}</td>
                  <td>{row.total_calls}</td>
                  <td>{milliseconds(row.latency_ms.p95)}</td>
                  <td>{metricNumber(row.total_tps.p50)}</td>
                  <td>${metricNumber(row.estimated_cost, 4)}</td>
                </tr>
              ))}
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
