import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '@/components/ui/Modal';
import { useMonitoringAnalytics } from '@/features/monitoring/hooks/useMonitoringAnalytics';
import type { MonitoringEventRow } from '@/features/monitoring/model/types';
import type { RequestTelemetry } from './types';
import { metricNumber, milliseconds } from './performanceModel';
import styles from './PerformancePanel.module.scss';

export function RequestTracePanel({
  row,
  onClose,
}: {
  row: MonitoringEventRow;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const text = (key: string) => t(`performance.${key}`);
  // 关联查看限定选中事件前后24小时，避免从无限历史检索；可见提示说明范围。
  const fromMs = row.requestId ? Math.max(1, row.timestampMs - 86400000) : undefined;
  const toMs = row.requestId ? row.timestampMs + 86400000 : undefined;
  const analytics = useMonitoringAnalytics({
    fromMs,
    toMs,
    filters: { request_ids: row.requestId ? [row.requestId] : [] },
    include: { events_page: { limit: 100 } },
    dataScopeKey: row.requestId,
  });
  const attempts = useMemo(() => {
    const map = new Map<string, RequestTelemetry>();
    if (row.telemetry?.attempt_id) map.set(row.telemetry.attempt_id, row.telemetry);
    if (!analytics.dataStale)
      for (const event of analytics.data?.events?.items ?? []) {
        if (event.request_id === row.requestId && event.telemetry?.attempt_id)
          map.set(event.telemetry.attempt_id, event.telemetry);
      }
    return [...map.values()].sort((a, b) => a.started_at_ms - b.started_at_ms);
  }, [analytics.data, analytics.dataStale, row]);
  return (
    <Modal open onClose={onClose} title={text('traceTitle')} width={880}>
      <section className={styles.root} data-testid="request-trace">
        <p>
          {row.model} · {row.requestId || '—'}
        </p>
        {analytics.loading ? <p aria-live="polite">{t('common.loading')}</p> : null}
        {analytics.error ? <p role="alert">{text('traceError')}</p> : null}
        {!attempts.length ? (
          <p>{text('noTelemetry')}</p>
        ) : (
          attempts.map((trace, index) => (
            <TraceAttempt key={trace.attempt_id} trace={trace} index={index} />
          ))
        )}
        <p className={styles.muted}>{text('limitedTrace')} · ±24 h</p>
      </section>
    </Modal>
  );
}

export function TraceAttempt({ trace, index }: { trace: RequestTelemetry; index: number }) {
  const { t } = useTranslation();
  const text = (key: string) => t(`performance.${key}`);
  const duration = Math.max(1, trace.ended_at_ms - trace.started_at_ms);
  const stages = [
    ['headers', trace.response_headers_ms],
    ['body', trace.first_body_ms],
    ['firstContent', trace.first_content_ms],
    ['lastContent', trace.last_content_ms],
  ] as const;
  return (
    <div className={styles.panel}>
      <h3>
        #{index + 1} · {text('transport')}: {trace.transport}
      </h3>
      <p>
        {text('attemptId')}: {trace.attempt_id}
      </p>
      <p>
        {text('observation')}: {trace.observation_kind}
      </p>
      <p>
        {text('connect')}: {milliseconds(trace.connect_ms)} · {text('tls')}:{' '}
        {milliseconds(trace.tls_ms)}
      </p>
      {stages.map(([key, value]) => (
        <div className={styles.stage} key={key}>
          <span>{text(key)}</span>
          <div className={styles.track}>
            {value !== undefined ? (
              <span style={{ width: `${Math.max(0, Math.min(100, (value / duration) * 100))}%` }} />
            ) : null}
          </div>
          <strong>{milliseconds(value)}</strong>
        </div>
      ))}
      <div className={styles.cards}>
        {[
          [text('contentChunks'), metricNumber(trace.content_chunks, 0)],
          [text('maxGap'), milliseconds(trace.max_content_gap_ms)],
          [
            `${text('stalls')} (≥${milliseconds(trace.stall_threshold_ms)})`,
            metricNumber(trace.stall_count, 0),
          ],
          [text('stallDuration'), milliseconds(trace.stall_duration_ms)],
        ].map(([label, value]) => (
          <div className={styles.card} key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      <p>
        {trace.stream_completed === undefined
          ? text('unknown')
          : text(trace.stream_completed ? 'completed' : 'incomplete')}{' '}
        · {trace.finish_reason || trace.failure_kind || '—'}
      </p>
      <p>{text('traceHint')}</p>
    </div>
  );
}
