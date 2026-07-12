import type { ChangeEvent, ReactNode, RefObject } from 'react';
import { Link } from 'react-router-dom';
import type { TFunction } from 'i18next';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/DropdownMenu';
import {
  IconDownload,
  IconExternalLink,
  IconFileText,
  IconInbox,
  IconRefreshCw,
  IconSettings,
  IconX,
} from '@/components/ui/icons';
import type { SyncCoreHistoryCursorProgress } from '@/features/monitoring/hooks/useUsageData';
import styles from '../MonitoringCenterPage.module.scss';

type MonitoringActionBarProps = {
  usageTransferAvailable: boolean;
  usageExporting: boolean;
  usageImporting: boolean;
  usageSyncingFromCore: boolean;
  usageSyncProgress: SyncCoreHistoryCursorProgress | null;
  hasResumableCoreHistorySync: boolean;
  loggingToFile: boolean;
  modelPricesAvailable: boolean;
  usageImportInputRef: RefObject<HTMLInputElement | null>;
  t: TFunction;
  onUsageExport: () => void | Promise<void>;
  onUsageImportClick: () => void;
  onUsageImportChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onSyncCoreHistoryRangeSelect: (sinceMs: number | null) => void;
  onSyncCoreHistoryRetry: () => void;
  onSyncCoreHistoryCancel: () => void;
  statusSummary: ReactNode;
};

const DAY_MS = 24 * 60 * 60 * 1000;

const shortLabel = (t: TFunction, shortKey: string, fallbackKey: string) => {
  const fallback = t(fallbackKey);
  const label = t(shortKey, { defaultValue: fallback });
  return label === shortKey ? fallback : label;
};

export function MonitoringActionBar({
  usageTransferAvailable,
  usageExporting,
  usageImporting,
  usageSyncingFromCore,
  usageSyncProgress,
  hasResumableCoreHistorySync,
  loggingToFile,
  modelPricesAvailable,
  usageImportInputRef,
  t,
  onUsageExport,
  onUsageImportClick,
  onUsageImportChange,
  onSyncCoreHistoryRangeSelect,
  onSyncCoreHistoryRetry,
  onSyncCoreHistoryCancel,
  statusSummary,
}: MonitoringActionBarProps) {
  const modelPriceSettingsLabel = shortLabel(
    t,
    'usage_stats.model_price_settings_short',
    'usage_stats.model_price_settings'
  );
  const accountActionsLabel = shortLabel(t, 'nav.account_actions_short', 'nav.account_actions');

  const syncDisabledBase = !usageTransferAvailable || usageExporting || usageImporting;
  const syncTitle = usageTransferAvailable
    ? t('usage_stats.sync_core_history')
    : t('usage_stats.import_export_requires_usage_service');

  const syncRangeMenuItems: DropdownMenuItem[] = [
    {
      key: 'sync-range-7d',
      label: t('usage_stats.sync_core_history_range_7d'),
      onClick: () => onSyncCoreHistoryRangeSelect(Date.now() - 7 * DAY_MS),
    },
    {
      key: 'sync-range-30d',
      label: t('usage_stats.sync_core_history_range_30d'),
      onClick: () => onSyncCoreHistoryRangeSelect(Date.now() - 30 * DAY_MS),
    },
    {
      key: 'sync-range-all',
      label: t('usage_stats.sync_core_history_range_all'),
      onClick: () => onSyncCoreHistoryRangeSelect(null),
    },
  ];

  const syncProgressLabel = usageSyncProgress
    ? t('usage_stats.sync_core_history_progress', {
        added: usageSyncProgress.added,
        batch: usageSyncProgress.batchCount,
      })
    : '';

  return (
    <section className={styles.actionBar} aria-label={t('common.action')}>
      <div className={styles.actionGroup}>
        <button
          type="button"
          className={`${styles.actionButton} ${styles.actionButtonPrimary}`}
          onClick={() => void onUsageExport()}
          disabled={!usageTransferAvailable || usageExporting || usageImporting}
          title={
            usageTransferAvailable
              ? t('usage_stats.export')
              : t('usage_stats.import_export_requires_usage_service')
          }
        >
          <IconDownload size={16} />
          <span>{usageExporting ? t('common.loading') : t('usage_stats.export')}</span>
        </button>
        <button
          type="button"
          className={`${styles.actionButton} ${styles.actionButtonPrimary}`}
          onClick={onUsageImportClick}
          disabled={!usageTransferAvailable || usageExporting || usageImporting}
          title={
            usageTransferAvailable
              ? t('usage_stats.import')
              : t('usage_stats.import_export_requires_usage_service')
          }
        >
          <IconFileText size={16} />
          <span>{usageImporting ? t('common.loading') : t('usage_stats.import')}</span>
        </button>
        {usageSyncingFromCore ? (
          <div className={styles.syncProgressGroup}>
            <span className={`${styles.actionButton} ${styles.syncProgressButton}`} aria-live="polite">
              <IconRefreshCw size={16} className={styles.syncProgressSpinner} />
              <span>{syncProgressLabel}</span>
            </span>
            <button
              type="button"
              className={styles.syncCancelButton}
              onClick={onSyncCoreHistoryCancel}
              title={t('common.cancel')}
              aria-label={t('usage_stats.sync_core_history_cancel')}
            >
              <IconX size={14} />
            </button>
          </div>
        ) : hasResumableCoreHistorySync ? (
          <button
            type="button"
            className={styles.actionButton}
            onClick={onSyncCoreHistoryRetry}
            disabled={syncDisabledBase}
            title={syncTitle}
          >
            <IconRefreshCw size={16} />
            <span>{t('usage_stats.sync_core_history_resume')}</span>
          </button>
        ) : (
          <DropdownMenu
            ariaLabel={t('usage_stats.sync_core_history_range_menu_label')}
            triggerClassName={styles.actionButton}
            triggerIcon={<IconRefreshCw size={16} />}
            triggerLabel={<span>{t('usage_stats.sync_core_history')}</span>}
            items={syncRangeMenuItems}
            disabled={syncDisabledBase}
            align="start"
          />
        )}
        {modelPricesAvailable ? (
          <Link
            to="/model-prices"
            className={styles.actionButton}
            title={t('usage_stats.model_price_settings')}
          >
            <IconSettings size={16} />
            <span>{modelPriceSettingsLabel}</span>
          </Link>
        ) : null}
        <Link
          to="/monitoring/account-actions"
          className={styles.actionButton}
          title={t('nav.account_actions')}
        >
          <IconInbox size={16} />
          <span>{accountActionsLabel}</span>
        </Link>
        <input
          ref={usageImportInputRef}
          type="file"
          accept=".json,.jsonl,.ndjson,.txt,application/json,application/x-ndjson,text/plain"
          style={{ display: 'none' }}
          onChange={onUsageImportChange}
        />
      </div>

      <div className={styles.actionBarMeta}>
        {statusSummary}
        {loggingToFile ? (
          <Link to="/logs" className={`${styles.actionButton} ${styles.quickNavLink}`}>
            <IconFileText size={16} />
            <span>{t('monitoring.open_logs')}</span>
            <IconExternalLink size={14} />
          </Link>
        ) : null}
      </div>
    </section>
  );
}
