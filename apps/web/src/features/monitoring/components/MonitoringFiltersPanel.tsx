import type { TFunction } from 'i18next';
import { Input } from '@/components/ui/Input';
import { Select, type SelectOption } from '@/components/ui/Select';
import {
  IconChevronDown,
  IconRefreshCw,
  IconSearch,
  IconSlidersHorizontal,
  IconTimer,
} from '@/components/ui/icons';
import { MonitoringPanel } from '@/features/monitoring/components/MonitoringPanel';
import type { MonitoringTimeRange } from '@/features/monitoring/hooks/useMonitoringData';
import styles from '../MonitoringCenterPage.module.scss';

type MonitoringFiltersPanelProps = {
  timeRange: MonitoringTimeRange;
  autoRefreshMs: string;
  selectedAccount: string;
  selectedProvider: string;
  selectedModel: string;
  selectedChannel: string;
  selectedApiKeyHash: string;
  selectedStatus: string;
  searchInput: string;
  accountOptions: ReadonlyArray<SelectOption>;
  providerOptions: ReadonlyArray<SelectOption>;
  modelOptions: ReadonlyArray<SelectOption>;
  channelOptions: ReadonlyArray<SelectOption>;
  apiKeyOptions: ReadonlyArray<SelectOption>;
  statusOptions: ReadonlyArray<SelectOption>;
  combinedError: string | null;
  /**
   * 非空时表示：本次刷新失败，当前展示的仍是上一次成功范围的数据（stale-on-error）。
   * 必须与 combinedError 分开渲染，让用户明确知道"看到的不是当前筛选条件的最新结果"，
   * 而不是让旧数据静默地看起来像是最新的。
   */
  staleDataNotice: string | null;
  usageStatisticsEnabled: boolean;
  overallLoading: boolean;
  t: TFunction;
  onTimeRangeChange: (value: MonitoringTimeRange) => void;
  onAutoRefreshChange: (value: string) => void;
  onRefreshAll: () => void | Promise<void>;
  onAccountFilterChange: (value: string) => void;
  onProviderChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onChannelChange: (value: string) => void;
  onApiKeyChange: (value: string) => void;
  onStatusChange: (value: string) => void;
  onSearchChange: (value: string) => void;
  onClearFilters: () => void;
};

// 时间范围快捷按钮：一行独占、一步直选，不再需要先展开分组下拉再选择。
// 只保留高频档位在主按钮行；14 天/全部/任意 N 小时/任意 N 天/日期范围收纳进
// "自定义▾" 弹层，避免主按钮行超过约 7 个控件在窄屏下换行挤压搜索框。
const QUICK_TIME_RANGE_OPTIONS: Array<{ value: MonitoringTimeRange; labelKey: string }> = [
  { value: '1h', labelKey: 'monitoring.range_1h' },
  { value: '3h', labelKey: 'monitoring.range_3h' },
  { value: '24h', labelKey: 'monitoring.range_24h' },
  { value: 'today', labelKey: 'monitoring.range_today' },
  { value: 'yesterday', labelKey: 'monitoring.range_yesterday' },
  { value: '7d', labelKey: 'monitoring.range_7d' },
  { value: '30d', labelKey: 'monitoring.range_30d' },
];

const QUICK_TIME_RANGE_VALUES = new Set<MonitoringTimeRange>(
  QUICK_TIME_RANGE_OPTIONS.map((option) => option.value)
);

const AUTO_REFRESH_OPTIONS = [
  { value: '0', labelKey: 'monitoring.auto_refresh_off' },
  { value: '5000', labelKey: 'monitoring.auto_refresh_5s' },
  { value: '10000', labelKey: 'monitoring.auto_refresh_10s' },
  { value: '30000', labelKey: 'monitoring.auto_refresh_30s' },
  { value: '60000', labelKey: 'monitoring.auto_refresh_60s' },
  { value: '300000', labelKey: 'monitoring.auto_refresh_5m' },
];

const shortLabel = (t: TFunction, shortKey: string, fallbackKey: string) => {
  const fallback = t(fallbackKey);
  const label = t(shortKey, { defaultValue: fallback });
  return label === shortKey ? fallback : label;
};

export function MonitoringFiltersPanel({
  timeRange,
  autoRefreshMs,
  selectedAccount,
  selectedProvider,
  selectedModel,
  selectedChannel,
  selectedApiKeyHash,
  selectedStatus,
  searchInput,
  accountOptions,
  providerOptions,
  modelOptions,
  channelOptions,
  apiKeyOptions,
  statusOptions,
  combinedError,
  staleDataNotice,
  usageStatisticsEnabled,
  overallLoading,
  t,
  onTimeRangeChange,
  onAutoRefreshChange,
  onRefreshAll,
  onAccountFilterChange,
  onProviderChange,
  onModelChange,
  onChannelChange,
  onApiKeyChange,
  onStatusChange,
  onSearchChange,
  onClearFilters,
}: MonitoringFiltersPanelProps) {
  const autoRefreshLabel = shortLabel(
    t,
    'monitoring.auto_refresh_short',
    'monitoring.auto_refresh'
  );
  const clearFiltersLabel = shortLabel(
    t,
    'monitoring.clear_filters_short',
    'monitoring.clear_filters'
  );

  const isCustomActive = !QUICK_TIME_RANGE_VALUES.has(timeRange);
  const activeNonQuickLabelKey: Record<string, string> = {
    '14d': 'monitoring.range_14d',
    all: 'monitoring.range_all',
    custom: 'monitoring.range_custom',
  };
  const customTriggerLabel = isCustomActive
    ? t(activeNonQuickLabelKey[timeRange] ?? 'monitoring.range_custom')
    : t('monitoring.range_custom');

  return (
    <MonitoringPanel className={styles.toolbarPanel}>
      <div className={styles.controlBar}>
        <div className={styles.timeRangeRow} role="group" aria-label={t('monitoring.filter_time_range')}>
          {QUICK_TIME_RANGE_OPTIONS.map((option) => {
            const active = timeRange === option.value;
            return (
              <button
                key={option.value}
                type="button"
                className={`${styles.timeRangeQuickButton} ${
                  active ? styles.timeRangeQuickButtonActive : ''
                }`}
                aria-pressed={active}
                onClick={() => onTimeRangeChange(option.value)}
              >
                {t(option.labelKey)}
              </button>
            );
          })}

          <button
            type="button"
            className={`${styles.timeRangeQuickButton} ${styles.timeRangeCustomTrigger} ${
              isCustomActive ? styles.timeRangeQuickButtonActive : ''
            }`}
            aria-pressed={isCustomActive}
            aria-haspopup="dialog"
            onClick={() => onTimeRangeChange('custom')}
          >
            {customTriggerLabel}
            <IconChevronDown size={14} className={styles.timeRangeCustomTriggerIcon} />
          </button>
        </div>

        <div className={styles.controlBarSecondaryRow}>
          <div className={styles.filterSearchInputWrap}>
            <Input
              value={searchInput}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder={t('monitoring.search_placeholder')}
              className={styles.filterSearchInput}
              rightElement={<IconSearch size={16} />}
              aria-label={t('monitoring.search_placeholder')}
            />
          </div>

          <div className={styles.refreshControls}>
            <div className={styles.autoRefreshField}>
              <span className={styles.autoRefreshLabel} title={t('monitoring.auto_refresh')}>
                <IconTimer size={16} />
                {autoRefreshLabel}
              </span>
              <Select
                className={styles.autoRefreshSelect}
                triggerClassName={styles.autoRefreshSelectTrigger}
                value={autoRefreshMs}
                options={AUTO_REFRESH_OPTIONS.map((option) => ({
                  value: option.value,
                  label: t(option.labelKey),
                }))}
                onChange={onAutoRefreshChange}
                ariaLabel={t('monitoring.auto_refresh')}
                fullWidth={false}
              />
            </div>

            <button
              type="button"
              className={styles.refreshButton}
              onClick={() => void onRefreshAll()}
              disabled={overallLoading}
            >
              <IconRefreshCw
                size={16}
                className={overallLoading ? styles.refreshIconSpinning : styles.refreshIcon}
              />
              <span className={styles.refreshButtonLabel}>{t('usage_stats.refresh')}</span>
            </button>

            <button
              type="button"
              className={styles.clearButton}
              onClick={onClearFilters}
              title={t('monitoring.clear_filters')}
              aria-label={t('monitoring.clear_filters')}
            >
              <IconSlidersHorizontal size={16} />
              <span>{clearFiltersLabel}</span>
            </button>
          </div>
        </div>
      </div>

      <div className={styles.statusButtonRow} role="group" aria-label={t('monitoring.filter_status')}>
        <span className={styles.statusButtonLabel}>{t('monitoring.filter_status')}</span>
        {statusOptions.map((option) => {
          const active = selectedStatus === option.value;
          return (
            <button
              key={option.value}
              type="button"
              className={`${styles.statusButtonChip} ${active ? styles.statusButtonChipActive : ''}`}
              aria-pressed={active}
              onClick={() => onStatusChange(option.value)}
            >
              {option.label}
            </button>
          );
        })}
      </div>

      <div className={styles.filterBar}>
        <div className={styles.filterGrid}>
          <div className={styles.filterAccountStack}>
            <Select
              value={selectedAccount}
              options={accountOptions}
              onChange={onAccountFilterChange}
              ariaLabel={t('monitoring.filter_account')}
              triggerClassName={styles.filterSelectTrigger}
            />
          </div>
          <Select
            value={selectedProvider}
            options={providerOptions}
            onChange={onProviderChange}
            ariaLabel={t('monitoring.filter_provider')}
            triggerClassName={styles.filterSelectTrigger}
          />
          <Select
            value={selectedModel}
            options={modelOptions}
            onChange={onModelChange}
            ariaLabel={t('monitoring.filter_model')}
            triggerClassName={styles.filterSelectTrigger}
          />
          <Select
            value={selectedChannel}
            options={channelOptions}
            onChange={onChannelChange}
            ariaLabel={t('monitoring.filter_channel')}
            triggerClassName={styles.filterSelectTrigger}
          />
          <Select
            value={selectedApiKeyHash}
            options={apiKeyOptions}
            onChange={onApiKeyChange}
            ariaLabel={t('monitoring.filter_api_key')}
            triggerClassName={styles.filterSelectTrigger}
          />
        </div>
      </div>

      {combinedError ? <div className={styles.errorBox}>{combinedError}</div> : null}
      {staleDataNotice ? (
        <div className={styles.errorBox} role="status">
          {staleDataNotice}
        </div>
      ) : null}
      {!usageStatisticsEnabled ? (
        <div className={styles.callout}>
          <strong>{t('monitoring.usage_disabled_title')}</strong>
          <span>{t('monitoring.usage_disabled_body')}</span>
        </div>
      ) : null}
    </MonitoringPanel>
  );
}
