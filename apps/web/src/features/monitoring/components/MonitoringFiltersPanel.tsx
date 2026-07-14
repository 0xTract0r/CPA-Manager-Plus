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
  /**
   * 自定义段的紧凑显示标签(如"最近20天"/"最近20小时"/"07/01~07/14")；
   * 由调用方基于自定义描述符格式化好传入，未选过自定义或没有描述符时回退"自定义"。
   */
  customRangeCompactLabel: string;
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

// v4：时间行改为对齐分析页(usage-analytics)的"连体分段模块"结构——单个
// .segmentedControl 外框包 7 个 .segmentButton，无间隙、细线分隔，取代 v3 的
// "短时段下拉 + 独立药丸按钮"两套并存的旧结构。彻底移除短时段下拉(1h/3h 收纳进
// 自定义弹层的"N 小时"模式)。自定义(最后一段)不参与快捷档判断，用"是否命中任一
// 快捷档"取反来判断当前是否处于自定义范围。
const QUICK_TIME_RANGE_OPTIONS: ReadonlyArray<{ value: MonitoringTimeRange; labelKey: string }> = [
  { value: '24h', labelKey: 'monitoring.range_24h' },
  { value: 'today', labelKey: 'monitoring.range_today' },
  { value: 'yesterday', labelKey: 'monitoring.range_yesterday' },
  { value: '7d', labelKey: 'monitoring.range_7d' },
  { value: '30d', labelKey: 'monitoring.range_30d' },
  { value: 'all', labelKey: 'monitoring.range_all' },
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
  customRangeCompactLabel,
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

  return (
    <MonitoringPanel className={styles.toolbarPanel}>
      <div className={styles.controlBar}>
        <div
          className={styles.segmentedControl}
          role="group"
          aria-label={t('monitoring.filter_time_range')}
        >
          {QUICK_TIME_RANGE_OPTIONS.map((option) => {
            const active = timeRange === option.value;
            return (
              <button
                key={option.value}
                type="button"
                className={`${styles.segmentButton} ${active ? styles.segmentButtonActive : ''}`}
                aria-pressed={active}
                onClick={() => onTimeRangeChange(option.value)}
              >
                {t(option.labelKey)}
              </button>
            );
          })}

          <button
            type="button"
            className={`${styles.segmentButton} ${styles.timeRangeCustomTrigger} ${
              isCustomActive ? styles.segmentButtonActive : ''
            }`}
            aria-pressed={isCustomActive}
            aria-haspopup="dialog"
            onClick={() => onTimeRangeChange('custom')}
          >
            <span className={styles.timeRangeCustomTriggerLabel}>{customRangeCompactLabel}</span>
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
          <Select
            value={selectedStatus}
            options={statusOptions}
            onChange={onStatusChange}
            ariaLabel={t('monitoring.filter_status')}
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
