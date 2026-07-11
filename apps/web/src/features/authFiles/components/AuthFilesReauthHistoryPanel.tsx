import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { authFilesApi } from '@/services/api';
import type { AuthFileItem, AuthFileReauthHistoryEntry } from '@/types';
import { formatInUtc8 } from '@/utils/format';
import styles from './AuthFilesReauthHistoryPanel.module.scss';

const HISTORY_FETCH_LIMIT = 8;

export type AuthFilesReauthHistoryPanelProps = {
  /** 认证文件对象；用于查询 /oauth-reauth-history 以及首屏 reauth_history 兜底。 */
  file: AuthFileItem;
  /** 变更时触发重新加载（例如父级重新认证成功后递增）。 */
  reloadKey?: number;
};

const formatOccurredAt = (value: string | undefined, locale: string): string => {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) return raw;
  // 展示一律 UTC+8（Asia/Shanghai），不跟随浏览器本地时区。
  return formatInUtc8(
    parsed,
    { dateStyle: 'medium', timeStyle: 'short', withZoneLabel: true },
    locale || undefined,
    raw
  );
};

const accountTransitionSummary = (event: AuthFileReauthHistoryEntry): string => {
  const before = event.before?.email?.trim() ?? '';
  const after = event.after?.email?.trim() ?? '';
  if (before && after && before !== after) {
    return `${before} -> ${after}`;
  }
  return after || before;
};

const planSummary = (event: AuthFileReauthHistoryEntry): string =>
  event.after?.plan?.trim() || event.before?.plan?.trim() || '';

const providerSummary = (event: AuthFileReauthHistoryEntry): string =>
  event.after?.provider?.trim() || event.before?.provider?.trim() || event.provider?.trim() || '';

const isSuccessEvent = (event: AuthFileReauthHistoryEntry): boolean => {
  const eventType = String(event.event_type ?? '').trim().toLowerCase();
  return eventType === 'success' || eventType === 'reauth_success';
};

/**
 * 认证文件重新认证（OAuth reauth）历史面板。
 * 折叠态只渲染一个裸文字触发链接，不占用卡片额外空间；展开后才懒加载历史，
 * 首屏用 file.reauth_history 兜底展示（对照旧版 web 端形态，不使用 Card 外壳）。
 */
export function AuthFilesReauthHistoryPanel(props: AuthFilesReauthHistoryPanelProps) {
  const { file, reloadKey = 0 } = props;
  const { t, i18n } = useTranslation();
  const seededEvents = useMemo(
    () => (Array.isArray(file.reauth_history) ? file.reauth_history.slice(0, HISTORY_FETCH_LIMIT) : []),
    [file.reauth_history]
  );
  const [expanded, setExpanded] = useState(false);
  const triggerLabel = expanded
    ? t('auth_files.reauth_history_hide_button', { defaultValue: 'Hide re-auth history' })
    : t('auth_files.reauth_history_show_button', { defaultValue: 'View re-auth history' });
  const [events, setEvents] = useState<AuthFileReauthHistoryEntry[]>(seededEvents);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requestIdRef = useRef(0);
  const loadedReloadKeyRef = useRef<number | null>(null);

  useEffect(() => {
    if (loadedReloadKeyRef.current === null) {
      setEvents(seededEvents);
    }
  }, [seededEvents]);

  const loadHistory = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError('');

    try {
      const nextEvents = await authFilesApi.getOAuthReauthHistory(file.name, HISTORY_FETCH_LIMIT);
      if (requestId !== requestIdRef.current) return;
      setEvents(nextEvents);
      loadedReloadKeyRef.current = reloadKey;
    } catch (err: unknown) {
      if (requestId !== requestIdRef.current) return;
      const message = err instanceof Error ? err.message : '';
      setError(message || t('notification.refresh_failed'));
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }, [file.name, reloadKey, t]);

  useEffect(() => {
    if (!expanded) return;
    if (loadedReloadKeyRef.current === reloadKey) return;
    void loadHistory();
  }, [expanded, loadHistory, reloadKey]);

  return (
    <div className={styles.inlineRoot}>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-label={triggerLabel}
      >
        {triggerLabel}
      </button>

      {expanded && (
        <div className={styles.panel}>
          <div className={styles.content}>
            {loading ? (
              <div className={styles.loading}>{t('common.loading')}</div>
            ) : error ? (
              <div className={styles.error}>{error}</div>
            ) : events.length === 0 ? (
              <div className={styles.empty}>
                {t('auth_files.reauth_history_empty', {
                  defaultValue: 'No re-authentication history yet.',
                })}
              </div>
            ) : (
              <div className={styles.list}>
                {events.map((event, index) => {
                  const success = isSuccessEvent(event);
                  const provider = providerSummary(event);
                  const accountSummary = accountTransitionSummary(event);
                  const plan = planSummary(event);
                  const occurredAt = formatOccurredAt(event.occurred_at, i18n.language);

                  return (
                    <div
                      key={`${event.occurred_at || 'unknown'}-${event.event_type || 'event'}-${index}`}
                      className={`${styles.item} ${success ? styles.itemSuccess : styles.itemFailure}`}
                    >
                      <div className={styles.itemHeader}>
                        <div className={styles.itemSummary}>
                          <div className={styles.itemTitle}>
                            {occurredAt ||
                              t('auth_files.reauth_history_unknown_time', {
                                defaultValue: 'Unknown time',
                              })}
                          </div>
                          <div className={styles.meta}>
                            {provider ? <span>{provider}</span> : null}
                            <span>{file.name}</span>
                          </div>
                        </div>

                        <span
                          className={`${styles.status} ${success ? styles.statusSuccess : styles.statusFailure}`}
                        >
                          {success
                            ? t('auth_files.reauth_history_status_success', { defaultValue: 'Success' })
                            : t('auth_files.reauth_history_status_failure', { defaultValue: 'Failure' })}
                        </span>
                      </div>

                      <div className={styles.detailList}>
                        {accountSummary ? (
                          <div className={styles.detail}>
                            {t('auth_files.reauth_history_account', { defaultValue: 'Account' })}
                            {': '}
                            {accountSummary}
                          </div>
                        ) : null}

                        {plan ? (
                          <div className={styles.detail}>
                            {t('auth_files.reauth_history_plan', { defaultValue: 'Plan' })}
                            {': '}
                            {plan}
                          </div>
                        ) : null}

                        {!success && event.error?.trim() ? (
                          <div className={styles.detail}>
                            {t('auth_files.reauth_history_error', { defaultValue: 'Error' })}
                            {': '}
                            {event.error.trim()}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <div className={styles.footer}>
              {t('auth_files.reauth_history_footer', {
                defaultValue:
                  'Showing the newest history entries only. The source of truth is <authDir>/.oauth-history/reauth.jsonl.',
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
