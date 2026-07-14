export type MonitoringDataTab = 'accounts' | 'apiKeys' | 'realtime';
export type MonitoringCenterTimeRange =
  | '1h'
  | '3h'
  | '24h'
  | 'today'
  | 'yesterday'
  | '7d'
  | '14d'
  | '30d'
  | 'all'
  | 'custom';
export type MonitoringCenterStatusFilter = 'all' | 'success' | 'failed';

export const MONITORING_DATA_TABS: readonly MonitoringDataTab[] = [
  'accounts',
  'apiKeys',
  'realtime',
] as const;

export const DEFAULT_MONITORING_DATA_TAB: MonitoringDataTab = 'accounts';
// 默认时间窗从"今天"改为"最近 24 小时"：跨零点后"今天"几乎没有数据，容易让用户误以为
// 系统没有流量；"最近 24 小时"打开即有数据，体验更稳定。
export const DEFAULT_MONITORING_TIME_RANGE: MonitoringCenterTimeRange = '24h';
export const DEFAULT_MONITORING_AUTO_REFRESH_MS = '30000';
export const DEFAULT_MONITORING_TABLE_PAGE_SIZE = 12;
export const DEFAULT_MONITORING_REALTIME_PAGE_SIZE = 10;
// "仅显示低命中率" 筛选阈值：与染色阈值(GOOD=0.6/WARN=0.3)解耦，用户可在预设档位间切换，
// 默认沿用原先写死的 0.3(30%)，保持既有行为不变。
export const REALTIME_LOW_CACHE_HIT_RATE_THRESHOLD_PRESETS = [0.5, 0.3, 0.1] as const;
export const DEFAULT_REALTIME_LOW_CACHE_HIT_RATE_THRESHOLD = 0.3;

export const MONITORING_CENTER_UI_STATE_STORAGE_KEY = 'monitoring.centerUiState';

export type MonitoringCenterUiState = {
  activeDataTab: MonitoringDataTab;
  timeRange: MonitoringCenterTimeRange;
  customStartInput: string;
  customEndInput: string;
  searchInput: string;
  autoRefreshMs: string;
  selectedAccount: string;
  selectedProvider: string;
  selectedModel: string;
  selectedChannel: string;
  selectedApiKeyHash: string;
  selectedHeaderTraceId: string;
  selectedStatus: MonitoringCenterStatusFilter;
  apiKeyPageSize: number;
  realtimePageSize: number;
  // 0-1 之间的小数（如 0.3 表示 30%）；预设档位之外允许用户输入自定义合法值。
  realtimeLowCacheHitRateThreshold: number;
};

const TAB_SET = new Set<MonitoringDataTab>(MONITORING_DATA_TABS);
const TIME_RANGE_SET = new Set<MonitoringCenterTimeRange>([
  '1h',
  '3h',
  '24h',
  'today',
  'yesterday',
  '7d',
  '14d',
  '30d',
  'all',
  'custom',
]);
const STATUS_FILTER_SET = new Set<MonitoringCenterStatusFilter>(['all', 'success', 'failed']);
const AUTO_REFRESH_MS_SET = new Set(['0', '5000', '10000', '30000', '60000', '300000']);
const TABLE_PAGE_SIZE_OPTIONS = [12, 20, 50, 100] as const;
const REALTIME_PAGE_SIZE_OPTIONS = [10, 50, 100, 150, 300] as const;

export const normalizeMonitoringDataTab = (value: unknown): MonitoringDataTab =>
  typeof value === 'string' && TAB_SET.has(value as MonitoringDataTab)
    ? (value as MonitoringDataTab)
    : DEFAULT_MONITORING_DATA_TAB;

export const normalizeMonitoringTimeRange = (value: unknown): MonitoringCenterTimeRange =>
  typeof value === 'string' && TIME_RANGE_SET.has(value as MonitoringCenterTimeRange)
    ? (value as MonitoringCenterTimeRange)
    : DEFAULT_MONITORING_TIME_RANGE;

export const normalizeMonitoringStatusFilter = (value: unknown): MonitoringCenterStatusFilter =>
  typeof value === 'string' && STATUS_FILTER_SET.has(value as MonitoringCenterStatusFilter)
    ? (value as MonitoringCenterStatusFilter)
    : 'all';

export const normalizeMonitoringAutoRefreshMs = (value: unknown): string => {
  const stringValue = typeof value === 'number' ? String(value) : value;
  return typeof stringValue === 'string' && AUTO_REFRESH_MS_SET.has(stringValue)
    ? stringValue
    : DEFAULT_MONITORING_AUTO_REFRESH_MS;
};

const normalizeString = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;

const normalizeSelectValue = (value: unknown): string => {
  const normalized = normalizeString(value, 'all').trim();
  return normalized || 'all';
};

const normalizePageSize = (
  value: unknown,
  options: readonly number[],
  fallback: number
): number => {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && options.includes(parsed) ? parsed : fallback;
};

// 阈值允许预设档位之外的自定义值，但必须是 (0, 1) 区间内的有限小数，
// 避免持久化损坏值（NaN/负数/超过 100%）污染后续筛选逻辑。
export const isValidLowCacheHitRateThreshold = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1;

export const normalizeLowCacheHitRateThreshold = (value: unknown): number => {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return isValidLowCacheHitRateThreshold(parsed)
    ? parsed
    : DEFAULT_REALTIME_LOW_CACHE_HIT_RATE_THRESHOLD;
};

export const getDefaultMonitoringCenterUiState = (): MonitoringCenterUiState => ({
  activeDataTab: DEFAULT_MONITORING_DATA_TAB,
  timeRange: DEFAULT_MONITORING_TIME_RANGE,
  customStartInput: '',
  customEndInput: '',
  searchInput: '',
  autoRefreshMs: DEFAULT_MONITORING_AUTO_REFRESH_MS,
  selectedAccount: 'all',
  selectedProvider: 'all',
  selectedModel: 'all',
  selectedChannel: 'all',
  selectedApiKeyHash: 'all',
  selectedHeaderTraceId: 'all',
  selectedStatus: 'all',
  apiKeyPageSize: DEFAULT_MONITORING_TABLE_PAGE_SIZE,
  realtimePageSize: DEFAULT_MONITORING_REALTIME_PAGE_SIZE,
  realtimeLowCacheHitRateThreshold: DEFAULT_REALTIME_LOW_CACHE_HIT_RATE_THRESHOLD,
});

export const normalizeMonitoringCenterUiState = (value: unknown): MonitoringCenterUiState => {
  const defaults = getDefaultMonitoringCenterUiState();
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return defaults;
  }

  const record = value as Record<string, unknown>;
  return {
    activeDataTab: normalizeMonitoringDataTab(record.activeDataTab),
    timeRange: normalizeMonitoringTimeRange(record.timeRange),
    customStartInput: normalizeString(record.customStartInput),
    customEndInput: normalizeString(record.customEndInput),
    searchInput: normalizeString(record.searchInput),
    autoRefreshMs: normalizeMonitoringAutoRefreshMs(record.autoRefreshMs),
    selectedAccount: normalizeSelectValue(record.selectedAccount),
    selectedProvider: normalizeSelectValue(record.selectedProvider),
    selectedModel: normalizeSelectValue(record.selectedModel),
    selectedChannel: normalizeSelectValue(record.selectedChannel),
    selectedApiKeyHash: normalizeSelectValue(record.selectedApiKeyHash),
    // Trace IDs are high-cardinality diagnostics. Keep URL-driven exact filters
    // supported at runtime, but do not persist hidden trace filters across visits.
    selectedHeaderTraceId: defaults.selectedHeaderTraceId,
    selectedStatus: normalizeMonitoringStatusFilter(record.selectedStatus),
    apiKeyPageSize: normalizePageSize(
      record.apiKeyPageSize,
      TABLE_PAGE_SIZE_OPTIONS,
      defaults.apiKeyPageSize
    ),
    realtimePageSize: normalizePageSize(
      record.realtimePageSize,
      REALTIME_PAGE_SIZE_OPTIONS,
      defaults.realtimePageSize
    ),
    realtimeLowCacheHitRateThreshold: normalizeLowCacheHitRateThreshold(
      record.realtimeLowCacheHitRateThreshold
    ),
  };
};

export const readMonitoringCenterUiState = (): MonitoringCenterUiState => {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
    return getDefaultMonitoringCenterUiState();
  }

  try {
    const raw = window.localStorage.getItem(MONITORING_CENTER_UI_STATE_STORAGE_KEY);
    if (raw) {
      return normalizeMonitoringCenterUiState(JSON.parse(raw));
    }
  } catch {
    // Ignore storage failures and fall back to defaults.
  }

  return getDefaultMonitoringCenterUiState();
};

export const writeMonitoringCenterUiState = (state: Partial<MonitoringCenterUiState>) => {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(
      MONITORING_CENTER_UI_STATE_STORAGE_KEY,
      JSON.stringify(normalizeMonitoringCenterUiState(state))
    );
  } catch {
    // Ignore storage failures and keep the runtime state in memory only.
  }
};
