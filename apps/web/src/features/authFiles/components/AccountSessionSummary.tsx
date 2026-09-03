import { useTranslation } from 'react-i18next';
import type { AuthFileAdaptiveScheduling } from '@/types';
import { deriveAccountSessionSummary } from '@/features/authFiles/model/accountSessionSummary';
import styles from '@/features/authFiles/AuthFilesPage.module.scss';

export interface AccountSessionSummaryProps {
  /** 该账号的 core adaptive_scheduling 投影（可能整体缺失，见类型注释）。 */
  adaptiveScheduling?: AuthFileAdaptiveScheduling | null;
  /**
   * 该账号数据是否正在刷新（复用调用方既有的逐账号「刷新状态」loading，见
   * AuthFileCard.statusRefreshing）——展示上把本区块降级为「统计中…」占位，
   * 避免刷新窗口内继续渲染可能已过期的计数。
   */
  loading?: boolean;
  /** 紧凑卡片模式（跟随 AuthFileCard 的 compact）。 */
  compact?: boolean;
}

/**
 * P7（account-session-count-display）：账号级会话计数展示——总计 · 活跃 ·
 * 已关闭（core P6 SessionAggregateForAuthIndex，经 adaptive_scheduling 投影）。
 * 三态：loading（刷新中）/ unavailable（core 未下发该投影）/ empty（确认 0 条，
 * 显式「暂无会话数据」而非数字 0）；否则渲染三个计数。
 */
export function AccountSessionSummary({
  adaptiveScheduling,
  loading = false,
  compact = false,
}: AccountSessionSummaryProps) {
  const { t } = useTranslation();
  const containerClass = `${styles.sessionSummary} ${compact ? styles.sessionSummaryCompact : ''}`;

  const header = (
    <div className={styles.sessionSummaryHeader}>
      <span className={styles.sessionSummaryLabel}>
        {t('auth_files.session_summary_label', { defaultValue: 'Sessions' })}
      </span>
    </div>
  );

  if (loading) {
    return (
      <div
        className={containerClass}
        data-testid="account-session-summary"
        data-account-session-status="loading"
      >
        {header}
        <span className={styles.sessionSummaryEmpty}>
          {t('auth_files.session_summary_loading', { defaultValue: 'Counting…' })}
        </span>
      </div>
    );
  }

  const summary = deriveAccountSessionSummary(adaptiveScheduling);

  if (summary.status === 'unavailable') {
    return (
      <div
        className={containerClass}
        data-testid="account-session-summary"
        data-account-session-status="unavailable"
      >
        {header}
        <span
          className={styles.sessionSummaryEmpty}
          data-testid="account-session-unavailable"
          title={t('auth_files.session_summary_unavailable_title', {
            defaultValue:
              'This core deployment has not projected session-count data for this account yet.',
          })}
        >
          {t('auth_files.session_summary_unavailable', { defaultValue: 'Session data unavailable' })}
        </span>
      </div>
    );
  }

  if (summary.status === 'empty') {
    return (
      <div
        className={containerClass}
        data-testid="account-session-summary"
        data-account-session-status="empty"
      >
        {header}
        <span className={styles.sessionSummaryEmpty} data-testid="account-session-empty">
          {t('auth_files.session_summary_empty', { defaultValue: 'No session data yet' })}
        </span>
      </div>
    );
  }

  const blockTitle = t('auth_files.session_summary_block_title', {
    total: summary.total,
    active: summary.active,
    closed: summary.closed,
    defaultValue:
      'Distinct sessions observed for this account: {{total}} total ({{active}} active / {{closed}} closed)',
  });

  return (
    <div
      className={containerClass}
      data-testid="account-session-summary"
      data-account-session-status="ok"
      title={blockTitle}
    >
      {header}
      <div className={styles.sessionSummaryGrid}>
        <div className={styles.sessionSummaryItem} data-testid="account-session-total">
          <span className={styles.sessionSummaryItemLabel}>
            {t('auth_files.session_summary_total_label', { defaultValue: 'Total' })}
          </span>
          <span className={styles.sessionSummaryItemValue}>{summary.total}</span>
        </div>
        <div className={styles.sessionSummaryItem} data-testid="account-session-active">
          <span className={styles.sessionSummaryItemLabel}>
            {t('auth_files.session_summary_active_label', { defaultValue: 'Active' })}
          </span>
          <span className={styles.sessionSummaryItemValue}>{summary.active}</span>
        </div>
        <div className={styles.sessionSummaryItem} data-testid="account-session-closed">
          <span className={styles.sessionSummaryItemLabel}>
            {t('auth_files.session_summary_closed_label', { defaultValue: 'Closed' })}
          </span>
          <span className={styles.sessionSummaryItemValue}>{summary.closed}</span>
        </div>
      </div>
    </div>
  );
}
