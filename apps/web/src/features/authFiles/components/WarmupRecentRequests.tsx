import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  monitoringAnalyticsApi,
  type MonitoringAnalyticsEventRow,
} from '@/services/api/usageService';
import { useAuthStore, useUsageServiceStore } from '@/stores';
import { formatDateTime } from '@/utils/format';
import styles from './WarmupPacing.module.scss';

export function WarmupRecentRequests({
  authIndex,
  enabled,
}: {
  authIndex: string;
  enabled: boolean;
}) {
  const { t } = useTranslation();
  const k = (name: string) => t(`auth_files.pacing.${name}`);
  const [expanded, setExpanded] = useState(false);
  const [state, setState] = useState<{
    identity: string;
    rows: MonitoringAnalyticsEventRow[];
    error: boolean;
    loaded: boolean;
  }>({ identity: '', rows: [], error: false, loaded: false });
  const base = useUsageServiceStore((store) => store.serviceBase);
  const managementKey = useAuthStore((store) => store.managementKey);
  useEffect(() => {
    if (!expanded || !enabled || !authIndex || !base || typeof document === 'undefined') return;
    let active = true;
    let controller: AbortController | null = null;
    let last = -Infinity;
    const load = async () => {
      if (!active || document.hidden || controller || performance.now() - last < 15000) return;
      last = performance.now();
      const request = new AbortController();
      controller = request;
      try {
        const now = Date.now();
        const response = await monitoringAnalyticsApi.getAnalytics(
          base,
          managementKey,
          {
            from_ms: now - 7 * 86400000,
            to_ms: now,
            filters: { auth_indices: [authIndex] },
            include: { events_page: { limit: 5 } },
          },
          request.signal
        );
        if (!active || request.signal.aborted) return;
        setState({
          identity: authIndex,
          rows: (response.events?.items ?? [])
            .filter((row) => String(row.auth_index) === authIndex)
            .sort((a, b) => b.timestamp_ms - a.timestamp_ms)
            .slice(0, 5),
          error: false,
          loaded: true,
        });
      } catch {
        if (active && !request.signal.aborted)
          setState((old) => ({
            ...old,
            identity: authIndex,
            rows: old.identity === authIndex ? old.rows : [],
            error: true,
            loaded: true,
          }));
      } finally {
        if (controller === request) controller = null;
      }
    };
    const visibility = () => {
      if (document.hidden) {
        controller?.abort();
        controller = null;
      } else void load();
    };
    document.addEventListener('visibilitychange', visibility);
    void load();
    const timer = window.setInterval(() => void load(), 15000);
    return () => {
      active = false;
      controller?.abort();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [authIndex, expanded, enabled, base, managementKey]);
  const current = state.identity === authIndex ? state : null;
  return (
    <details className={styles.history} onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary>{k('recent_requests')}</summary>
      <p>{k('history_note')}</p>
      {expanded &&
        (!authIndex || !base ? (
          <p>{k('history_unavailable')}</p>
        ) : current?.error ? (
          <p role="status">{k('history_failed')}</p>
        ) : !current?.loaded ? (
          <p>{k('loading')}</p>
        ) : current.rows.length === 0 ? (
          <p>{k('history_empty')}</p>
        ) : (
          <div className={styles.historyRows}>
            {current.rows.map((row) => (
              <div key={row.event_hash} className={styles.historyRow}>
                <time>{formatDateTime(new Date(row.timestamp_ms).toISOString())}</time>
                <span>
                  <WarmupRequestStatus row={row} />
                </span>
                <span>
                  {k('cache_read')}: {row.cache_read_tokens ?? '—'} · {k('cache_write')}:{' '}
                  {row.cache_creation_tokens ?? '—'}
                </span>
              </div>
            ))}
          </div>
        ))}
    </details>
  );
}

/** 成功状态不补造 HTTP 200；只有监控行实际提供有效状态码才显示。 */
export function WarmupRequestStatus({
  row,
}: {
  row: Pick<MonitoringAnalyticsEventRow, 'failed' | 'fail_status_code'>;
}) {
  const { t } = useTranslation();
  const code = row.fail_status_code;
  return (
    <>
      {t(`auth_files.pacing.${row.failed ? 'request_failed' : 'request_success'}`)}
      {typeof code === 'number' && Number.isInteger(code) && code >= 100 && code <= 599
        ? ` · ${code}`
        : ''}
    </>
  );
}
