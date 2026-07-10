import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { authFilesApi } from '@/services/api';
import type { AuthFileReauthHistoryEntry } from '@/types/authFile';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconChevronDown, IconChevronUp } from '@/components/ui/icons';
import { formatDateTime } from '@/utils/format';
import styles from './AuthFilesReauthHistoryPanel.module.scss';

const HISTORY_FETCH_LIMIT = 8;

export type AuthFilesReauthHistoryPanelProps = {
  /** 认证文件名，用于查询 /oauth-reauth-history。 */
  authFileName: string;
  /** 变更时触发重新加载（例如父级重新认证成功后递增）。 */
  reloadKey?: number;
  /** 默认是否展开，第三批集成到 AuthFileCard 时通常传 false（折叠触发）。 */
  defaultExpanded?: boolean;
};

const formatOccurredAt = (value: string | undefined): string => {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const formatted = formatDateTime(raw);
  return formatted === 'Invalid Date' ? raw : formatted;
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
 * 数据来自 `authFilesApi.getOAuthReauthHistory`，展示最近若干次重新认证事件
 * （成功/失败、账号变化、套餐、错误信息）。
 */
export function AuthFilesReauthHistoryPanel(props: AuthFilesReauthHistoryPanelProps) {
  const { authFileName, reloadKey = 0, defaultExpanded = false } = props;
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [events, setEvents] = useState<AuthFileReauthHistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requestIdRef = useRef(0);
  const loadedReloadKeyRef = useRef<number | null>(null);

  const loadHistory = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError('');

    try {
      const nextEvents = await authFilesApi.getOAuthReauthHistory(authFileName, HISTORY_FETCH_LIMIT);
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
      title={t('auth_files.reauth_history_title', { defaultValue: 'Re-auth history' })}
      extra={
        <Button
          variant="ghost"
          size="xs"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          {expanded ? (
            <>
              {t('auth_files.reauth_history_hide_button', { defaultValue: 'Hide' })}
              <IconChevronUp size={14} />
            </>
          ) : (
            <>
              {t('auth_files.reauth_history_show_button', { defaultValue: 'View' })}
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
          title={t('auth_files.reauth_history_empty', {
            defaultValue: 'No re-authentication history yet.',
          })}
        />
      ) : (
        <div className={styles.list}>
          {events.map((event, index) => {
            const success = isSuccessEvent(event);
            const provider = providerSummary(event);
            const accountSummary = accountTransitionSummary(event);
            const plan = planSummary(event);
            const occurredAt = formatOccurredAt(event.occurred_at);

            return (
              <div
                key={`${event.occurred_at || 'unknown'}-${event.event_type || 'event'}-${index}`}
                className={`${styles.item} ${success ? styles.itemSuccess : styles.itemFailure}`}
              >
                <div className={styles.itemHeader}>
                  <div className={styles.itemTitle}>
                    {occurredAt ||
                      t('auth_files.reauth_history_unknown_time', {
                        defaultValue: 'Unknown time',
                      })}
                  </div>
                  <span
                    className={`${styles.statusBadge} ${success ? styles.statusSuccess : styles.statusFailure}`}
                  >
                    {success
                      ? t('auth_files.reauth_history_status_success', { defaultValue: 'Success' })
                      : t('auth_files.reauth_history_status_failure', { defaultValue: 'Failure' })}
                  </span>
                </div>

                {provider ? <div className={styles.itemMeta}>{provider}</div> : null}

                <div className={styles.detailList}>
                  {accountSummary ? (
                    <div className={styles.detail}>
                      <span className={styles.detailLabel}>
                        {t('auth_files.reauth_history_account', { defaultValue: 'Account' })}
                      </span>
                      <span>{accountSummary}</span>
                    </div>
                  ) : null}

                  {plan ? (
                    <div className={styles.detail}>
                      <span className={styles.detailLabel}>
                        {t('auth_files.reauth_history_plan', { defaultValue: 'Plan' })}
                      </span>
                      <span>{plan}</span>
                    </div>
                  ) : null}

                  {!success && event.error?.trim() ? (
                    <div className={styles.detail}>
                      <span className={styles.detailLabel}>
                        {t('auth_files.reauth_history_error', { defaultValue: 'Error' })}
                      </span>
                      <span>{event.error.trim()}</span>
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
