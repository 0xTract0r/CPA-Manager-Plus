import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { authFilesApi } from '@/services/api';
import type { AuthFileStatusHistoryEntry } from '@/types/authFile';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconChevronDown, IconChevronUp } from '@/components/ui/icons';
import { formatDateTime } from '@/utils/format';
import styles from './AuthFilesStatusHistoryPanel.module.scss';

const HISTORY_FETCH_LIMIT = 8;

export type AuthFilesStatusHistoryPanelProps = {
  /** 认证文件名，用于查询 /auth-status-history。 */
  authFileName: string;
  /** 变更时触发重新加载（例如父级状态刷新成功后递增）。 */
  reloadKey?: number;
  /** 默认是否展开，第三批集成到 AuthFileCard 时通常传 false（折叠触发）。 */
  defaultExpanded?: boolean;
};

type StatusVariant = 'success' | 'warning' | 'failure' | 'neutral';

const formatOccurredAt = (value: string | undefined): string => {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const formatted = formatDateTime(raw);
  return formatted === 'Invalid Date' ? raw : formatted;
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
 * 数据来自 `authFilesApi.getAuthStatusHistory`，展示最近若干次状态检查事件
 * （已恢复/仍告警/检查失败、触发方式、状态消息、错误信息）。
 */
export function AuthFilesStatusHistoryPanel(props: AuthFilesStatusHistoryPanelProps) {
  const { authFileName, reloadKey = 0, defaultExpanded = false } = props;
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [events, setEvents] = useState<AuthFileStatusHistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requestIdRef = useRef(0);
  const loadedReloadKeyRef = useRef<number | null>(null);

  const loadHistory = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError('');

    try {
      const nextEvents = await authFilesApi.getAuthStatusHistory(authFileName, HISTORY_FETCH_LIMIT);
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
  }, [authFileName, reloadKey, t]);

  useEffect(() => {
    if (!expanded) return;
    if (loadedReloadKeyRef.current === reloadKey) return;
    void loadHistory();
  }, [expanded, loadHistory, reloadKey]);

  return (
    <Card
      className={styles.panelCard}
      title={t('auth_files.status_history_title', { defaultValue: 'Status check history' })}
      extra={
        <Button
          variant="ghost"
          size="xs"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          {expanded ? (
            <>
              {t('auth_files.status_history_hide_button', { defaultValue: 'Hide' })}
              <IconChevronUp size={14} />
            </>
          ) : (
            <>
              {t('auth_files.status_history_show_button', { defaultValue: 'View' })}
              <IconChevronDown size={14} />
            </>
          )}
        </Button>
      }
    >
      {!expanded ? null : loading ? (
        <div className={styles.message}>{t('common.loading')}</div>
      ) : error ? (
        <div className={styles.errorMessage}>{error}</div>
      ) : events.length === 0 ? (
        <EmptyState
          title={t('auth_files.status_history_empty', {
            defaultValue: 'No status checks have been recorded yet.',
          })}
        />
      ) : (
        <div className={styles.list}>
          {events.map((event, index) => {
            const eventType = String(event.event_type ?? '').trim().toLowerCase();
            const variant = resolveStatusVariant(eventType);
            const occurredAt = formatOccurredAt(event.occurred_at);
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
                  <div className={styles.itemTitle}>
                    {occurredAt ||
                      t('auth_files.status_history_unknown_time', {
                        defaultValue: 'Unknown check time',
                      })}
                  </div>
                  <span className={`${styles.statusBadge} ${VARIANT_BADGE_CLASS[variant]}`}>
                    {resolveStatusLabel(t, eventType)}
                  </span>
                </div>

                <div className={styles.itemMeta}>
                  <span>{triggerLabel}</span>
                  {provider ? <span>{provider}</span> : null}
                </div>

                <div className={styles.detailList}>
                  {statusMessage ? (
                    <div className={styles.detail}>
                      <span className={styles.detailLabel}>
                        {t('auth_files.status_history_current_message', {
                          defaultValue: 'Current message',
                        })}
                      </span>
                      <span>{statusMessage}</span>
                    </div>
                  ) : null}

                  {previousMessage ? (
                    <div className={styles.detail}>
                      <span className={styles.detailLabel}>
                        {t('auth_files.status_history_previous_message', {
                          defaultValue: 'Previous message',
                        })}
                      </span>
                      <span>{previousMessage}</span>
                    </div>
                  ) : null}

                  {errorMessage ? (
                    <div className={styles.detail}>
                      <span className={styles.detailLabel}>
                        {t('auth_files.status_history_error', { defaultValue: 'Error' })}
                      </span>
                      <span>{errorMessage}</span>
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
