import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { authFilesApi } from '@/services/api';
import type { AuthFileItem, AuthFileStatusHistoryEntry } from '@/types';
import { formatInUtc8 } from '@/utils/format';
import styles from './AuthFilesStatusHistoryPanel.module.scss';

const HISTORY_FETCH_LIMIT = 8;

export type AuthFilesStatusHistoryPanelProps = {
  /** 认证文件对象；用于查询 /auth-status-history 以及首屏 status_history 兜底。 */
  file: AuthFileItem;
  /** 变更时触发重新加载（例如父级状态刷新成功后递增）。 */
  reloadKey?: number;
};

type StatusVariant = 'success' | 'warning' | 'failure' | 'neutral';

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

const resolveStatusVariant = (eventType: string): StatusVariant => {
  switch (eventType) {
    case 'cleared':
      return 'success';
    case 'warning':
      return 'warning';
    case 'check_failed':
      return 'failure';
    default:
      return 'neutral';
  }
};

const resolveStatusLabel = (t: TFunction, eventType: string): string => {
  switch (eventType) {
    case 'cleared':
      return t('auth_files.status_history_status_cleared', { defaultValue: 'Cleared' });
    case 'warning':
      return t('auth_files.status_history_status_warning', { defaultValue: 'Still warning' });
    case 'check_failed':
      return t('auth_files.status_history_status_failed', { defaultValue: 'Check failed' });
    default:
      return t('auth_files.status_history_status_checked', { defaultValue: 'Checked' });
  }
};

const resolveTriggerLabel = (t: TFunction, trigger: string | undefined): string =>
  String(trigger ?? '').trim().toLowerCase() === 'auto'
    ? t('auth_files.status_history_trigger_auto', { defaultValue: 'Automatic check' })
    : t('auth_files.status_history_trigger_manual', { defaultValue: 'Manual check' });

const VARIANT_ITEM_CLASS: Record<StatusVariant, string> = {
  success: styles.itemSuccess,
  warning: styles.itemWarning,
  failure: styles.itemFailure,
  neutral: styles.itemNeutral,
};

const VARIANT_BADGE_CLASS: Record<StatusVariant, string> = {
  success: styles.statusSuccess,
  warning: styles.statusWarning,
  failure: styles.statusFailure,
  neutral: styles.statusNeutral,
};

/**
 * 认证文件状态检查历史面板。
 * 折叠态只渲染一个裸文字触发链接，不占用卡片额外空间；展开后才懒加载历史，
 * 首屏用 file.status_history 兜底展示（对照旧版 web 端形态，不使用 Card 外壳）。
 */
export function AuthFilesStatusHistoryPanel(props: AuthFilesStatusHistoryPanelProps) {
  const { file, reloadKey = 0 } = props;
  const { t, i18n } = useTranslation();
  const seededEvents = useMemo(
    () =>
      Array.isArray(file.status_history) ? file.status_history.slice(0, HISTORY_FETCH_LIMIT) : [],
    [file.status_history]
  );
  const [expanded, setExpanded] = useState(false);
  const panelTriggerLabel = expanded
    ? t('auth_files.status_history_hide_button', { defaultValue: 'Hide status check history' })
    : t('auth_files.status_history_show_button', { defaultValue: 'View status check history' });
  const [events, setEvents] = useState<AuthFileStatusHistoryEntry[]>(seededEvents);
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
      const nextEvents = await authFilesApi.getAuthStatusHistory(file.name, HISTORY_FETCH_LIMIT);
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
        aria-label={panelTriggerLabel}
      >
        {panelTriggerLabel}
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
                {t('auth_files.status_history_empty', {
                  defaultValue: 'No status checks have been recorded yet.',
                })}
              </div>
            ) : (
              <div className={styles.list}>
                {events.map((event, index) => {
                  const eventType = String(event.event_type ?? '').trim().toLowerCase();
                  const variant = resolveStatusVariant(eventType);
                  const occurredAt = formatOccurredAt(event.occurred_at, i18n.language);
                  const triggerLabel = resolveTriggerLabel(t, event.trigger);
                  const provider = String(event.provider ?? '').trim();
                  const statusMessage = String(event.status_message ?? '').trim();
                  const previousMessage = String(event.previous_message ?? '').trim();
                  const errorMessage = String(event.error ?? '').trim();

                  return (
                    <div
                      key={`${event.occurred_at || 'unknown'}-${event.event_type || 'event'}-${index}`}
                      className={`${styles.item} ${VARIANT_ITEM_CLASS[variant]}`}
                    >
                      <div className={styles.itemHeader}>
                        <div className={styles.itemSummary}>
                          <div className={styles.itemTitle}>
                            {occurredAt ||
                              t('auth_files.status_history_unknown_time', {
                                defaultValue: 'Unknown check time',
                              })}
                          </div>
                          <div className={styles.meta}>
                            <span>{triggerLabel}</span>
                            {provider ? <span>{provider}</span> : null}
                            <span>{file.name}</span>
                          </div>
                        </div>

                        <span className={`${styles.status} ${VARIANT_BADGE_CLASS[variant]}`}>
                          {resolveStatusLabel(t, eventType)}
                        </span>
                      </div>

                      <div className={styles.detailList}>
                        {statusMessage ? (
                          <div className={styles.detail}>
                            {t('auth_files.status_history_current_message', {
                              defaultValue: 'Current message',
                            })}
                            {': '}
                            {statusMessage}
                          </div>
                        ) : null}

                        {previousMessage ? (
                          <div className={styles.detail}>
                            {t('auth_files.status_history_previous_message', {
                              defaultValue: 'Previous message',
                            })}
                            {': '}
                            {previousMessage}
                          </div>
                        ) : null}

                        {errorMessage ? (
                          <div className={styles.detail}>
                            {t('auth_files.status_history_error', { defaultValue: 'Error' })}
                            {': '}
                            {errorMessage}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <div className={styles.footer}>
              {t('auth_files.status_history_footer', {
                defaultValue:
                  'Showing the newest history entries only. The source of truth is <authDir>/.auth-status-history/status.jsonl.',
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
