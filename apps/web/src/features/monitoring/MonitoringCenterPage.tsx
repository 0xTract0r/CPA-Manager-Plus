import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';
import { useLocation } from 'react-router-dom';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { useTimezone } from '@/hooks/useTimezone';
import {
  buildRealtimeMonitorRows,
  getRangeBounds,
  type MonitoringAccountRow,
  type MonitoringCustomTimeRange,
  type MonitoringStatusTone,
  type MonitoringTimeRange,
  useMonitoringData,
} from '@/features/monitoring/hooks/useMonitoringData';
import {
  ACCOUNT_OVERVIEW_CARD_PAGE_SIZE_OPTIONS,
  ACCOUNT_OVERVIEW_TABLE_PAGE_SIZE_OPTIONS,
  buildEmptyMonitoringStatusData,
  buildMonitoringAccountAuthStateMap,
  buildMonitoringAccountStatusDataMap,
  normalizeAccountOverviewPageSize,
  resolveMonitoringStatusRangeBounds,
  shouldClampAccountOverviewPage,
  shouldResetAccountOverviewPage,
  sortAccountRows,
  readAccountOverviewUiState,
  resolveMonitoringAccountFocusAction,
  writeAccountOverviewUiState,
  type AccountDisplayMode,
  type AccountOverviewPageResetState,
  type AccountSortKey,
  type AccountSortState,
  type MonitoringAccountOverviewMode,
} from '@/features/monitoring/accountOverviewState';
import {
  buildMonitoringAccountQuotaTargetsByRowId,
  type MonitoringAccountQuotaTarget,
} from '@/features/monitoring/accountOverviewQuotaTargets';
import {
  AccountExpandedDetails,
  AccountOverviewCard,
} from '@/features/monitoring/components/AccountOverviewCard';
import {
  AccountOverviewPanel,
  AccountOverviewPanelActions,
} from '@/features/monitoring/components/AccountOverviewPanel';
import {
  ApiKeySummaryPanel,
  ApiKeySummaryPanelActions,
} from '@/features/monitoring/components/ApiKeySummaryPanel';
import { MonitoringDataPanel } from '@/features/monitoring/components/MonitoringDataPanel';
import { MonitoringActionBar } from '@/features/monitoring/components/MonitoringActionBar';
import { MonitoringDatabaseMaintenanceHint } from '@/features/monitoring/components/MonitoringDatabaseMaintenanceHint';
import { MonitoringCustomRangeModal } from '@/features/monitoring/components/MonitoringCustomRangeModal';
import { MonitoringFiltersPanel } from '@/features/monitoring/components/MonitoringFiltersPanel';
import { UsageImportProgressModal } from '@/features/monitoring/components/UsageImportProgressModal';
import { usePageTransitionLayer } from '@/components/common/PageTransitionLayer';
import { UsageCoverageWarning } from '@/components/usage/UsageCoverageWarning';
import { useDatabaseMaintenance } from '@/components/common/useDatabaseMaintenance';
import { IconInbox } from '@/components/ui/icons';
import {
  MonitoringStatusHeader,
  MonitoringStatusSummary,
} from '@/features/monitoring/components/MonitoringStatusHeader';
import { MonitoringSummarySection } from '@/features/monitoring/components/MonitoringSummarySection';
import type { MonitoringTab } from '@/features/monitoring/components/MonitoringTabsBar';
import {
  RealtimeEventsPanel,
  RealtimeEventsPanelActions,
} from '@/features/monitoring/components/RealtimeEventsPanel';
import { type AccountQuotaState } from '@/features/monitoring/components/accountOverviewPresentation';
import {
  ANTIGRAVITY_CONFIG,
  CLAUDE_CONFIG,
  CODEX_CONFIG,
  DEVIN_CONFIG,
  KIMI_CONFIG,
  XAI_CONFIG,
  refreshQuotaWithConfig,
  type QuotaConfig,
  type QuotaRefreshResult,
  type QuotaSetter,
} from '@/components/quota';
import {
  buildAccountOptions,
  buildAccountOverviewColumns,
  buildAccountSortOptions,
  buildApiKeyOptionsFromRows,
  buildApiKeyOverviewColumns,
  buildAuthFilesByAuthIndex,
  buildAccountQuotaErrorEntry,
  buildAccountQuotaEntryFromProviderState,
  buildAccountQuotaRefreshFailureEntry,
  buildCachedAccountQuotaEntry,
  buildObservedCodexAccountQuotaEntry,
  buildChannelOptionsFromValues,
  buildMonitoringInitialStateFromQuery,
  buildModelOptionsFromValues,
  buildPaginationState,
  buildPrimarySummaryCards,
  buildProviderOptionsFromValues,
  buildRealtimeLogRows,
  buildSecondarySummaryCards,
  buildStatusOptions,
  deriveMonitoringKpiLoadingState,
  formatAccountOverviewScopeText,
  formatDateTimeLocalValue,
  formatMonitoringCustomRangeCompactLabel,
  formatMonitoringSummaryScopeText,
  getCurrentInputValue,
  getTodayStartInputValue,
  isUsageImportFile,
  mergeSharedAccountQuotaState,
  mergeObservedAccountQuotaState,
  parseDateTimeLocalValue,
  updateMonitoringAccountQuotaStateByRowId,
  type FocusSnapshot,
  type MonitoringCustomRangeDescriptor,
  type MonitoringProviderQuotaState,
  type MonitoringQuotaStores,
  type StatusFilter,
} from '@/features/monitoring/model/monitoringCenterPageModel';
import { resolveMonitoringDimensionCounts } from '@/features/monitoring/model/monitoringAnalyticsModel';
import { useHeaderSnapshotsLoader } from '@/features/monitoring/hooks/useHeaderSnapshotsLoader';
import {
  isUsageImportCancelledError,
  isUsageImportPausedError,
  type UsageImportProgress,
} from '@/features/monitoring/services/usageImportSession';
import {
  runSyncCoreHistoryCursorLoop,
  useUsageData,
  type SyncCoreHistoryCursorProgress,
} from '@/features/monitoring/hooks/useUsageData';
import { useUsageCatchUpStatus } from '@/features/monitoring/hooks/useUsageCatchUpStatus';
import { presentUsageCatchUpStatus } from '@/features/monitoring/model/usageCatchUpPresentation';
import { getUsageServiceErrorCode } from '@/services/api/usageService';
import {
  normalizeLowCacheHitRateThreshold,
  readMonitoringCenterUiState,
  writeMonitoringCenterUiState,
  type MonitoringDataTab,
} from '@/features/monitoring/monitoringCenterUiState';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useInterval } from '@/hooks/useInterval';
import { useRequestMonitoringAvailability } from '@/hooks/useRequestMonitoringAvailability';
import { isFileLogsAvailable } from '@/features/logs/logFeatureAvailability';
import { useAccountPrivacyStore } from '@/stores/useAccountPrivacyStore';
import { useAuthStore, useConfigStore, useNotificationStore, useQuotaStore } from '@/stores';
import { useUsageHeaderSnapshotStore } from '@/stores/useUsageHeaderSnapshotStore';
import { useAccountCredentialMutationRevisionStore } from '@/stores/useAccountCredentialMutationRevisionStore';
import { createCodexInspectionConnectionFingerprint } from '@/features/monitoring/codexInspection';
import type { StatusBarData } from '@/utils/recentRequests';
import { downloadBlob } from '@/utils/download';
import { sha256Hex } from '@/utils/apiKeyHash';
import { formatCompactNumber } from '@/utils/usage';
import {
  buildProviderCredentialTaskPlan,
  createKeyedSerialTaskQueue,
  runProviderCredentialTaskPlan,
} from '@/utils/quota/providerRefreshScheduler';
import {
  buildUsageHeaderSnapshotLookup,
  filterFreshUsageHeaderQuotaSnapshots,
  getHighConfidenceUsageHeaderSnapshotForAuthFile,
} from '@/utils/usageHeaderSnapshots';
import {
  getCredentialScopedQuotaState,
  getQuotaCredentialStoreKey,
} from '@/utils/quota/credentialScope';
import { buildSourceInfoMap, buildSourceProviderStateMap } from '@/utils/sourceResolver';
import styles from './MonitoringCenterPage.module.scss';

export { AccountExpandedDetails, AccountOverviewCard };

const MAX_CONCURRENT_ACCOUNT_QUOTA_PROVIDERS = 3;
const MAX_CONCURRENT_ACCOUNT_QUOTA_REQUESTS_PER_PROVIDER = 1;
const DATABASE_MAINTENANCE_LONG_RANGE_MS = 7 * 24 * 60 * 60 * 1000;
const CREDENTIAL_MUTATION_COVERAGE_RETRY_DELAYS_MS = [0, 1_000, 2_000, 4_000, 8_000] as const;

type MonitoringQuotaRefreshResult = {
  status: 'success' | 'error';
  state: MonitoringProviderQuotaState;
  error?: string;
};

const DEFAULT_ACCOUNT_PAGE_SIZE = ACCOUNT_OVERVIEW_TABLE_PAGE_SIZE_OPTIONS[0];
const EMPTY_STATUS_BAR_DATA: StatusBarData = {
  blocks: [],
  blockDetails: [],
  successRate: 100,
  totalSuccess: 0,
  totalFailure: 0,
};

const shortLabel = (t: TFunction, shortKey: string, fallbackKey: string) => {
  const fallback = t(fallbackKey);
  const label = t(shortKey, { defaultValue: fallback });
  return label === shortKey ? fallback : label;
};

export function MonitoringCenterPage() {
  const { t, i18n } = useTranslation();
  // 订阅全局时区：切换时区时账号总览/实时事件/状态条等时间戳随之重渲染，无需刷新。
  // timeZone 还要显式进入下方范围文案(scope text)的 useMemo 依赖，否则缓存值不随切换更新。
  const { timeZone } = useTimezone();
  const { status: managerStatus } = useDatabaseMaintenance();
  const location = useLocation();
  const config = useConfigStore((state) => state.config);
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const apiBase = useAuthStore((state) => state.apiBase);
  const managementKey = useAuthStore((state) => state.managementKey);
  const quotaRequestScope = useMemo(() => ({ apiBase, managementKey }), [apiBase, managementKey]);
  const showNotification = useNotificationStore((state) => state.showNotification);
  const showConfirmation = useNotificationStore((state) => state.showConfirmation);
  const requestMonitoringAvailability = useRequestMonitoringAvailability();
  const connectionFingerprint = useMemo(
    () => createCodexInspectionConnectionFingerprint(apiBase, managementKey),
    [apiBase, managementKey]
  );
  const credentialMutationRevisions = useAccountCredentialMutationRevisionStore(
    (state) => state.events
  );
  const accountQuotaContextKey = useMemo(
    () =>
      JSON.stringify({
        apiBase,
        managementKey,
        serviceBase: requestMonitoringAvailability.serviceBase,
      }),
    [apiBase, managementKey, requestMonitoringAvailability.serviceBase]
  );
  const pageTransitionLayer = usePageTransitionLayer();
  const isCurrentLayer = pageTransitionLayer ? pageTransitionLayer.status === 'current' : true;
  const usageCatchUpStatusQuery = useUsageCatchUpStatus({
    serviceBase: requestMonitoringAvailability.serviceBase,
    enabled: isCurrentLayer && requestMonitoringAvailability.available,
  });
  const initialAccountOverviewUiState = useRef(readAccountOverviewUiState());
  const initialMonitoringCenterUiState = useRef(
    buildMonitoringInitialStateFromQuery(location.search, readMonitoringCenterUiState())
  );
  const initialMonitoringDrilldownFilters = useRef(
    (() => {
      const params = new URLSearchParams(location.search);
      const minLatencyMs = Number(params.get('min_latency_ms'));
      return {
        requestId: params.get('request_id')?.trim() || '',
        resolvedModel: params.get('resolved_model')?.trim() || '',
        unresolvedModel: params.get('unresolved_model')?.trim() || '',
        authFile: params.get('auth_file')?.trim() || '',
        authIndex: params.get('auth_index')?.trim() || '',
        projectId: params.get('project_id')?.trim() || '',
        requestType: params.get('request_type')?.trim() || '',
        minLatencyMs: Number.isFinite(minLatencyMs) && minLatencyMs > 0 ? minLatencyMs : undefined,
        cacheStatus: params.get('cache_status')?.trim() || '',
      };
    })()
  );
  const [timeRange, setTimeRange] = useState<MonitoringTimeRange>(
    initialMonitoringCenterUiState.current.timeRange
  );
  const databaseMaintenance = managerStatus?.databaseMaintenance;
  const monitoringMaintenanceWarning = databaseMaintenance?.performanceDegraded === true;
  const [customStartInput, setCustomStartInput] = useState(
    () => initialMonitoringCenterUiState.current.customStartInput || getTodayStartInputValue()
  );
  const [customEndInput, setCustomEndInput] = useState(
    () => initialMonitoringCenterUiState.current.customEndInput || getCurrentInputValue()
  );
  const [customDraftStartInput, setCustomDraftStartInput] = useState(
    () => initialMonitoringCenterUiState.current.customStartInput || getTodayStartInputValue()
  );
  const [customDraftEndInput, setCustomDraftEndInput] = useState(
    () => initialMonitoringCenterUiState.current.customEndInput || getCurrentInputValue()
  );
  const [searchInput, setSearchInput] = useState(
    () => initialMonitoringCenterUiState.current.searchInput
  );
  const [autoRefreshMs, setAutoRefreshMs] = useState(
    () => initialMonitoringCenterUiState.current.autoRefreshMs
  );
  const [documentVisible, setDocumentVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState !== 'hidden'
  );
  const headerSnapshots = useUsageHeaderSnapshotStore((state) => state.items);
  const headerSnapshotGeneratedAtMs = useUsageHeaderSnapshotStore((state) => state.generatedAtMs);
  const antigravityQuota = useQuotaStore((state) => state.antigravityQuota);
  const claudeQuota = useQuotaStore((state) => state.claudeQuota);
  const codexQuota = useQuotaStore((state) => state.codexQuota);
  const devinQuota = useQuotaStore((state) => state.devinQuota);
  const kimiQuota = useQuotaStore((state) => state.kimiQuota);
  const xaiQuota = useQuotaStore((state) => state.xaiQuota);
  const sharedQuotaStores = useMemo<MonitoringQuotaStores>(
    () => ({
      antigravityQuota,
      claudeQuota,
      codexQuota,
      devinQuota,
      kimiQuota,
      xaiQuota,
    }),
    [antigravityQuota, claudeQuota, codexQuota, devinQuota, kimiQuota, xaiQuota]
  );
  const setAntigravityQuota = useQuotaStore((state) => state.setAntigravityQuota);
  const setClaudeQuota = useQuotaStore((state) => state.setClaudeQuota);
  const setCodexQuota = useQuotaStore((state) => state.setCodexQuota);
  const setDevinQuota = useQuotaStore((state) => state.setDevinQuota);
  const setKimiQuota = useQuotaStore((state) => state.setKimiQuota);
  const setXaiQuota = useQuotaStore((state) => state.setXaiQuota);
  const [selectedAccount, setSelectedAccount] = useState(
    () => initialMonitoringCenterUiState.current.selectedAccount
  );
  const [selectedProvider, setSelectedProvider] = useState(
    () => initialMonitoringCenterUiState.current.selectedProvider
  );
  const [selectedModel, setSelectedModel] = useState(
    () => initialMonitoringCenterUiState.current.selectedModel
  );
  const [selectedChannel, setSelectedChannel] = useState(
    () => initialMonitoringCenterUiState.current.selectedChannel
  );
  const [selectedApiKeyHash, setSelectedApiKeyHash] = useState(
    () => initialMonitoringCenterUiState.current.selectedApiKeyHash
  );
  const [selectedHeaderTraceId, setSelectedHeaderTraceId] = useState(
    () => initialMonitoringCenterUiState.current.selectedHeaderTraceId
  );
  const [selectedStatus, setSelectedStatus] = useState<StatusFilter>(
    () => initialMonitoringCenterUiState.current.selectedStatus
  );
  const [preciseDrilldown, setPreciseDrilldown] = useState(() => ({
    authIndex: initialMonitoringDrilldownFilters.current.authIndex,
    requestId: initialMonitoringDrilldownFilters.current.requestId,
    resolvedModel: initialMonitoringDrilldownFilters.current.resolvedModel,
    unresolvedModel: initialMonitoringDrilldownFilters.current.unresolvedModel,
  }));
  const [drilldownAuthFile, setDrilldownAuthFile] = useState(
    () => initialMonitoringDrilldownFilters.current.authFile
  );
  const [drilldownAuthIndex] = useState(() => initialMonitoringDrilldownFilters.current.authIndex);
  const [drilldownProjectId, setDrilldownProjectId] = useState(
    () => initialMonitoringDrilldownFilters.current.projectId
  );
  const [drilldownRequestType, setDrilldownRequestType] = useState(
    () => initialMonitoringDrilldownFilters.current.requestType
  );
  const [drilldownMinLatencyMs, setDrilldownMinLatencyMs] = useState(
    () => initialMonitoringDrilldownFilters.current.minLatencyMs
  );
  const [drilldownCacheStatus, setDrilldownCacheStatus] = useState(
    () => initialMonitoringDrilldownFilters.current.cacheStatus
  );
  const [expandedAccounts, setExpandedAccounts] = useState<Record<string, boolean>>({});
  const [expandedApiKeys, setExpandedApiKeys] = useState<Record<string, boolean>>({});
  const [focusedAccountId, setFocusedAccountId] = useState<string | null>(null);
  const [isCustomRangeModalOpen, setIsCustomRangeModalOpen] = useState(false);
  // 记录用户在 自定义弹层 里实际选择的方式(N小时/N天/日期范围)，供"当前统计范围"caption
  // 与时间行"自定义"段还原实际所选范围，而不是笼统展示"自定义"。刷新页面后没有描述符
  // (旧持久化状态只存了 timeRange='custom')时，两处都回退到笼统文案，不报错、不空白。
  const [customRangeDescriptor, setCustomRangeDescriptor] =
    useState<MonitoringCustomRangeDescriptor | null>(null);
  const [usageExporting, setUsageExporting] = useState(false);
  const [usageImporting, setUsageImporting] = useState(false);
  const [usageSyncingFromCore, setUsageSyncingFromCore] = useState(false);
  const [usageSyncCancelling, setUsageSyncCancelling] = useState(false);
  const [usageSyncProgress, setUsageSyncProgress] = useState<SyncCoreHistoryCursorProgress | null>(
    null
  );
  const usageSyncCancelRef = useRef(false);
  const usageSyncAbortControllerRef = useRef<AbortController | null>(null);
  const usageSyncResumeSinceRef = useRef<string | undefined>(undefined);
  // 续传起点 undefined 合法地表示"从全部历史开头续传"，不能用它判断是否可续传；
  // 必须用独立标志区分"是否存在可续传的同步"与"续传起点值"。
  const [usageSyncResumable, setUsageSyncResumable] = useState(false);
  const [usageImportCancelling, setUsageImportCancelling] = useState(false);
  const [usageImportTask, setUsageImportTask] = useState<{
    file: File;
    progress: UsageImportProgress;
  } | null>(null);
  const [accountQuotaStatesByRowId, setAccountQuotaStatesByRowId] = useState<
    Record<string, AccountQuotaState>
  >({});
  const [activeDataTab, setActiveDataTab] = useState<MonitoringDataTab>(
    initialMonitoringCenterUiState.current.activeDataTab
  );
  const [accountOverviewMode, setAccountOverviewMode] = useState<MonitoringAccountOverviewMode>(
    initialAccountOverviewUiState.current.mode
  );
  const maskAccountEmails = useAccountPrivacyStore((state) => state.maskEmails);
  const setMaskAccountEmails = useAccountPrivacyStore((state) => state.setMaskEmails);
  const accountDisplayMode: AccountDisplayMode = maskAccountEmails ? 'masked' : 'full';
  const setAccountDisplayMode = useCallback(
    (mode: AccountDisplayMode) => setMaskAccountEmails(mode === 'masked'),
    [setMaskAccountEmails]
  );
  const [accountSort, setAccountSort] = useState<AccountSortState>(
    initialAccountOverviewUiState.current.sort
  );
  const [accountPageByMode, setAccountPageByMode] = useState(() => ({
    table: 1,
    card: initialAccountOverviewUiState.current.cardPagination.page,
  }));
  const [accountPageSizeByMode, setAccountPageSizeByMode] = useState(() => ({
    table: DEFAULT_ACCOUNT_PAGE_SIZE,
    card: initialAccountOverviewUiState.current.cardPagination.pageSize,
  }));
  const [apiKeyPage, setApiKeyPage] = useState(1);
  const [apiKeyPageSize, setApiKeyPageSize] = useState<number>(
    initialMonitoringCenterUiState.current.apiKeyPageSize
  );
  const [realtimePage, setRealtimePage] = useState(1);
  const [realtimePageSize, setRealtimePageSize] = useState(
    initialMonitoringCenterUiState.current.realtimePageSize
  );
  // "仅显示低命中率" 筛选状态提升到页面级：masthead 工具条 chip 与实时表过滤共享同一状态，
  // 保证它与 "仅显示失败" chip 在同一行、embedded 与非 embedded 两条渲染路径都可达。
  const [realtimeLowCacheHitRateOnly, setRealtimeLowCacheHitRateOnly] = useState(false);
  // 低命中率筛选阈值同样提升到页面级并持久化：用户可在预设档位(<50%/<30%/<10%)间切换，
  // 或输入自定义百分比；默认沿用原先写死的 0.3，不改变既有默认体验。
  const [realtimeLowCacheHitRateThreshold, setRealtimeLowCacheHitRateThreshold] = useState(
    () => initialMonitoringCenterUiState.current.realtimeLowCacheHitRateThreshold
  );
  const focusSnapshotRef = useRef<FocusSnapshot | null>(null);
  const previousAccountPageResetStateRef = useRef<AccountOverviewPageResetState | null>(null);
  const accountQuotaStatesByRowIdRef = useRef<Record<string, AccountQuotaState>>({});
  const accountQuotaRequestIdsByRowIdRef = useRef<Record<string, number>>({});
  const accountQuotaMutationRevisionsByRowIdRef = useRef<Record<string, number>>({});
  const accountQuotaContextGenerationRef = useRef(0);
  const accountQuotaContextKeyRef = useRef(accountQuotaContextKey);
  const [accountQuotaRefreshQueue] = useState(() => createKeyedSerialTaskQueue());
  const requestedCredentialMutationRevisionsRef = useRef<Record<string, number>>({});
  const coveredCredentialMutationRevisionsRef = useRef<Record<string, number>>({});
  const queuedCredentialMutationProvidersRef = useRef<Set<string>>(new Set());
  const credentialMutationRefreshPromiseRef = useRef<Promise<void> | null>(null);
  const credentialMutationRefreshGenerationRef = useRef(0);
  const [credentialMutationRefreshKick, setCredentialMutationRefreshKick] = useState(0);
  const [pendingCredentialMutationProviders, setPendingCredentialMutationProviders] = useState<
    string[]
  >([]);
  const usageImportInputRef = useRef<HTMLInputElement | null>(null);
  const usageImportAbortRef = useRef<AbortController | null>(null);
  const usageImportCancelPendingRef = useRef(false);
  const usageImportRunIDRef = useRef(0);
  const deferredSearch = useDeferredValue(searchInput);
  const deferredSearchApiKeyHash = useMemo(() => sha256Hex(deferredSearch), [deferredSearch]);
  const accountPage =
    accountOverviewMode === 'card' ? accountPageByMode.card : accountPageByMode.table;
  const accountPageSize =
    accountOverviewMode === 'card' ? accountPageSizeByMode.card : accountPageSizeByMode.table;
  const customStartMs = useMemo(
    () => parseDateTimeLocalValue(customStartInput),
    [customStartInput]
  );
  const customEndMs = useMemo(() => parseDateTimeLocalValue(customEndInput), [customEndInput]);
  const customDraftStartMs = useMemo(
    () => parseDateTimeLocalValue(customDraftStartInput),
    [customDraftStartInput]
  );
  const customDraftEndMs = useMemo(
    () => parseDateTimeLocalValue(customDraftEndInput),
    [customDraftEndInput]
  );
  const customTimeRangeError = useMemo(() => {
    if (timeRange !== 'custom') return '';
    if (customStartMs === null || customEndMs === null) {
      return t('monitoring.custom_range_required');
    }
    if (customStartMs > customEndMs) {
      return t('monitoring.custom_range_invalid');
    }
    return '';
  }, [customEndMs, customStartMs, t, timeRange]);
  const customTimeRange = useMemo<MonitoringCustomTimeRange | null>(() => {
    if (
      timeRange !== 'custom' ||
      customTimeRangeError ||
      customStartMs === null ||
      customEndMs === null
    ) {
      return null;
    }
    return {
      startMs: customStartMs,
      endMs: customEndMs,
    };
  }, [customEndMs, customStartMs, customTimeRangeError, timeRange]);
  const monitoringMaintenanceLongRange =
    timeRange === '7d' ||
    timeRange === '14d' ||
    timeRange === '30d' ||
    timeRange === 'all' ||
    (timeRange === 'custom' &&
      customTimeRange !== null &&
      customTimeRange.endMs - customTimeRange.startMs >= DATABASE_MAINTENANCE_LONG_RANGE_MS);
  const customDraftTimeRangeError = useMemo(() => {
    if (customDraftStartMs === null || customDraftEndMs === null) {
      return t('monitoring.custom_range_required');
    }
    if (customDraftStartMs > customDraftEndMs) {
      return t('monitoring.custom_range_invalid');
    }
    return '';
  }, [customDraftEndMs, customDraftStartMs, t]);

  const {
    loading: usageLoading,
    error: usageError,
    modelPrices,
    apiKeyAliases,
    loadApiKeyAliases,
    exportUsage,
    importUsage,
    syncCoreHistory,
    cancelUsageImport,
  } = useUsageData({ loadUsageEvents: false });

  const monitoringScopeFilters = useMemo(
    () => ({
      ...preciseDrilldown,
      account: selectedAccount,
      provider: selectedProvider,
      authFile: drilldownAuthFile || undefined,
      authIndex: drilldownAuthIndex || undefined,
      projectId: drilldownProjectId || undefined,
      requestType: drilldownRequestType || undefined,
      minLatencyMs: drilldownMinLatencyMs,
      cacheStatus: drilldownCacheStatus || undefined,
      model: selectedModel,
      channel: selectedChannel,
      apiKeyHash: selectedApiKeyHash,
      headerTraceId: selectedHeaderTraceId,
      status: selectedStatus,
      // G2b：仅当"仅显示低命中率" chip 开启时才下推阈值，让后端做跨全部数据的 SQL 层
      // 全量筛选；未开启时不传，保持原有"不筛选"行为。
      maxCacheHitRate: realtimeLowCacheHitRateOnly ? realtimeLowCacheHitRateThreshold : undefined,
    }),
    [
      preciseDrilldown,
      drilldownAuthFile,
      drilldownAuthIndex,
      drilldownCacheStatus,
      drilldownMinLatencyMs,
      drilldownProjectId,
      drilldownRequestType,
      realtimeLowCacheHitRateOnly,
      realtimeLowCacheHitRateThreshold,
      selectedAccount,
      selectedApiKeyHash,
      selectedChannel,
      selectedHeaderTraceId,
      selectedModel,
      selectedProvider,
      selectedStatus,
    ]
  );

  const {
    loading: monitoringLoading,
    error: monitoringError,
    authFiles,
    summary: monitoringSummary,
    coverage: monitoringCoverage,
    accountRows: monitoringAccountRows,
    apiKeyRows: monitoringApiKeyRows,
    filterOptions: monitoringFilterOptions,
    filteredRows,
    eventsHasMore,
    eventsLoadingMore,
    eventsRetentionLimited,
    eventsTotalCount,
    eventsLoadedCount,
    lastRefreshedAt: monitoringLastRefreshedAt,
    isTransitioningScope: monitoringScopeTransitioning,
    overviewDataStale: monitoringOverviewDataStale,
    hasPresentationSnapshot: hasMonitoringPresentationSnapshot,
    refreshMeta,
    loadMoreEvents,
  } = useMonitoringData({
    config,
    connectionScopeKey: connectionFingerprint,
    modelPrices,
    apiKeyAliases,
    timeRange,
    customTimeRange,
    searchQuery: deferredSearch,
    searchApiKeyHash: deferredSearchApiKeyHash,
    scopeFilters: monitoringScopeFilters,
    activeDataTab,
  });

  const loadHeaderSnapshots = useHeaderSnapshotsLoader({
    serviceBase: requestMonitoringAvailability.serviceBase,
    managementKey,
  });

  useLayoutEffect(() => {
    if (accountQuotaContextKeyRef.current === accountQuotaContextKey) return;
    accountQuotaContextKeyRef.current = accountQuotaContextKey;
    accountQuotaContextGenerationRef.current += 1;
    accountQuotaRequestIdsByRowIdRef.current = {};
    accountQuotaMutationRevisionsByRowIdRef.current = {};
    accountQuotaStatesByRowIdRef.current = {};
    credentialMutationRefreshGenerationRef.current += 1;
    credentialMutationRefreshPromiseRef.current = null;
    requestedCredentialMutationRevisionsRef.current = {};
    coveredCredentialMutationRevisionsRef.current = {};
    queuedCredentialMutationProvidersRef.current.clear();
    setCredentialMutationRefreshKick(0);
    setAccountQuotaStatesByRowId((current) => (Object.keys(current).length === 0 ? current : {}));
    setPendingCredentialMutationProviders([]);
  }, [accountQuotaContextKey]);

  useEffect(
    () => () => {
      accountQuotaContextGenerationRef.current += 1;
      accountQuotaRequestIdsByRowIdRef.current = {};
      credentialMutationRefreshGenerationRef.current += 1;
      credentialMutationRefreshPromiseRef.current = null;
    },
    []
  );

  const refreshAll = useCallback(
    async (options?: { forceOverview?: boolean }) => {
      const [, metaPayload] = await Promise.all([
        loadApiKeyAliases(),
        refreshMeta(false, { forceOverview: options?.forceOverview ?? true }),
        loadHeaderSnapshots(),
      ]);
      if (!metaPayload?.authFilesLoaded) return;
      const hasUncoveredRevision = Object.entries(
        requestedCredentialMutationRevisionsRef.current
      ).some(
        ([key, revision]) => revision > (coveredCredentialMutationRevisionsRef.current[key] ?? 0)
      );
      if (hasUncoveredRevision && !credentialMutationRefreshPromiseRef.current) {
        setCredentialMutationRefreshKick((current) => current + 1);
      }
    },
    [loadApiKeyAliases, loadHeaderSnapshots, refreshMeta]
  );

  useEffect(() => {
    if (!connectionFingerprint) return;
    let hasNewRevision = false;
    Object.entries(credentialMutationRevisions).forEach(([key, event]) => {
      if (event.connectionFingerprint !== connectionFingerprint) return;
      if ((requestedCredentialMutationRevisionsRef.current[key] ?? 0) >= event.revision) return;
      requestedCredentialMutationRevisionsRef.current[key] = event.revision;
      queuedCredentialMutationProvidersRef.current.add(event.provider);
      hasNewRevision = true;
    });
    const hasUncoveredRevision = Object.entries(
      requestedCredentialMutationRevisionsRef.current
    ).some(
      ([key, revision]) => revision > (coveredCredentialMutationRevisionsRef.current[key] ?? 0)
    );
    if (
      (!hasNewRevision && !(credentialMutationRefreshKick > 0 && hasUncoveredRevision)) ||
      credentialMutationRefreshPromiseRef.current
    ) {
      return;
    }

    credentialMutationRefreshGenerationRef.current += 1;
    const refreshGeneration = credentialMutationRefreshGenerationRef.current;
    const requestedAtStart = { ...requestedCredentialMutationRevisionsRef.current };

    const coverRevisions = (snapshot: Record<string, number>) => {
      Object.entries(snapshot).forEach(([key, revision]) => {
        coveredCredentialMutationRevisionsRef.current[key] = Math.max(
          coveredCredentialMutationRevisionsRef.current[key] ?? 0,
          revision
        );
      });
    };
    const generationAlive = () =>
      credentialMutationRefreshGenerationRef.current === refreshGeneration;
    const hasNewerRequestedRevision = () =>
      Object.entries(requestedCredentialMutationRevisionsRef.current).some(
        ([key, revision]) =>
          revision > (coveredCredentialMutationRevisionsRef.current[key] ?? 0) &&
          revision > (requestedAtStart[key] ?? 0)
      );
    const consumeProvidersForQuota = () => {
      const providers = Array.from(queuedCredentialMutationProvidersRef.current);
      queuedCredentialMutationProvidersRef.current.clear();
      setCredentialMutationRefreshKick(0);
      setPendingCredentialMutationProviders(providers);
    };

    const refresh = Promise.resolve()
      .then(() => refreshMeta(false))
      .then((payload) => {
        if (!generationAlive()) return;
        if (!payload?.authFilesLoaded) return;
        coverRevisions(requestedAtStart);
      })
      .finally(() => {
        if (!generationAlive()) return;
        credentialMutationRefreshPromiseRef.current = null;
        if (hasNewerRequestedRevision()) {
          setCredentialMutationRefreshKick((current) => current + 1);
          return;
        }
        const fullyCovered = !Object.entries(requestedCredentialMutationRevisionsRef.current).some(
          ([key, revision]) => revision > (coveredCredentialMutationRevisionsRef.current[key] ?? 0)
        );
        if (fullyCovered) {
          consumeProvidersForQuota();
          return;
        }
        // Coverage failed for the current revisions. Attempt a bounded retry
        // before leaving them stranded. Each retry is a real metadata reload.
        let retryIndex = 0;
        const attemptRetry = () => {
          if (!generationAlive()) return;
          if (retryIndex >= CREDENTIAL_MUTATION_COVERAGE_RETRY_DELAYS_MS.length) {
            // Exhausted: leave revisions uncovered and providers queued so a
            // later mutation, page re-entry, or explicit refresh can recover.
            setCredentialMutationRefreshKick(0);
            return;
          }
          const delayMs = CREDENTIAL_MUTATION_COVERAGE_RETRY_DELAYS_MS[retryIndex];
          retryIndex += 1;
          const runRetry = () => {
            if (!generationAlive()) return;
            if (hasNewerRequestedRevision()) {
              setCredentialMutationRefreshKick((current) => current + 1);
              return;
            }
            const retryRequestedAtStart = {
              ...requestedCredentialMutationRevisionsRef.current,
            };
            credentialMutationRefreshPromiseRef.current = Promise.resolve()
              .then(() => refreshMeta(false))
              .then((payload) => {
                if (!generationAlive()) return;
                if (!payload?.authFilesLoaded) return;
                coverRevisions(retryRequestedAtStart);
              })
              .finally(() => {
                if (!generationAlive()) return;
                credentialMutationRefreshPromiseRef.current = null;
                if (hasNewerRequestedRevision()) {
                  setCredentialMutationRefreshKick((current) => current + 1);
                  return;
                }
                const nowCovered = !Object.entries(
                  requestedCredentialMutationRevisionsRef.current
                ).some(
                  ([key, revision]) =>
                    revision > (coveredCredentialMutationRevisionsRef.current[key] ?? 0)
                );
                if (nowCovered) {
                  consumeProvidersForQuota();
                  return;
                }
                attemptRetry();
              });
          };
          if (delayMs <= 0) {
            runRetry();
          } else {
            setTimeout(runRetry, delayMs);
            // A timer may wake after the generation changes; runRetry fences it
            // before it can issue a metadata request or change state.
          }
        };
        attemptRetry();
      });
    credentialMutationRefreshPromiseRef.current = refresh;
  }, [
    connectionFingerprint,
    credentialMutationRefreshKick,
    credentialMutationRevisions,
    refreshMeta,
  ]);

  const setCurrentAccountPage = useCallback(
    (page: number) => {
      setAccountPageByMode((previous) => ({
        ...previous,
        [accountOverviewMode]: page,
      }));
    },
    [accountOverviewMode]
  );

  const resetCurrentAccountPage = useCallback(() => {
    setCurrentAccountPage(1);
  }, [setCurrentAccountPage]);

  useHeaderRefresh(refreshAll, isCurrentLayer);
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const updateVisibility = () => setDocumentVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', updateVisibility);
    return () => document.removeEventListener('visibilitychange', updateVisibility);
  }, []);
  useInterval(
    () => {
      // 同窗后台自动刷新：概览聚合走降频门(forceOverview:false)，事件流仍每个 tick 照常刷。
      void refreshAll({ forceOverview: false }).catch(() => {});
    },
    isCurrentLayer &&
      documentVisible &&
      connectionStatus === 'connected' &&
      Number(autoRefreshMs) > 0
      ? Number(autoRefreshMs)
      : null
  );

  useEffect(() => {
    if (!isCurrentLayer || !requestMonitoringAvailability.serviceBase) return;
    void loadHeaderSnapshots();
  }, [isCurrentLayer, loadHeaderSnapshots, requestMonitoringAvailability.serviceBase]);

  const monitoringUnavailable =
    !requestMonitoringAvailability.checking && !requestMonitoringAvailability.available;
  const usageTransferAvailable = requestMonitoringAvailability.available;
  const monitoringUnavailableTitle =
    requestMonitoringAvailability.reason === 'monitoring_disabled'
      ? t('monitoring.request_monitoring_disabled_title')
      : t('monitoring.request_monitoring_unavailable_title');
  const monitoringUnavailableBody =
    requestMonitoringAvailability.reason === 'monitoring_disabled'
      ? t('monitoring.request_monitoring_disabled_body')
      : requestMonitoringAvailability.reason === 'service_unavailable'
        ? t('monitoring.request_monitoring_service_unavailable_body')
        : t('monitoring.request_monitoring_not_configured_body');
  const monitoringBlockingLoading =
    monitoringLoading && (!monitoringScopeTransitioning || !hasMonitoringPresentationSnapshot);
  const overallLoading =
    usageLoading || monitoringBlockingLoading || requestMonitoringAvailability.checking;
  // KPI 卡片级 loading 反馈：区分"切时间窗转场"（变暗+更新中遮罩）与"首屏还没有任何展示
  // 快照"（骨架占位）。去闪烁关键：kpiUpdating 用 overviewDataStale(切窗才 true、同窗后台
  // 刷新恒 false)而非 monitoringLoading，使同窗每次后台刷新不再变灰转圈，数值静默原地更新。
  const { kpiUpdating, kpiFirstLoad } = deriveMonitoringKpiLoadingState({
    monitoringLoading,
    overviewDataStale: monitoringOverviewDataStale,
    hasPresentationSnapshot: hasMonitoringPresentationSnapshot,
  });
  const combinedError = monitoringUnavailable
    ? monitoringError
    : [usageError, monitoringError].filter(Boolean).join('；');
  // 显式 stale-on-error 提示：请求失败/超时时，useMonitoringData 会保留上一次成功范围
  // 的展示快照(hasPresentationSnapshot)而不是清空页面，但这必须让用户明确知道，而不是
  // 静默地把旧数据当作最新结果展示。仅在真的还在为新 scope 转场、且已有旧快照可显示时
  // 才提示，避免和首次加载失败(还没有任何快照)的 combinedError 重复。
  const staleDataNotice =
    monitoringError && monitoringScopeTransitioning && hasMonitoringPresentationSnapshot
      ? t('monitoring.stale_data_notice')
      : null;
  const hasPrices = Object.keys(modelPrices).length > 0;
  const usageCatchUpStatusPresentation = presentUsageCatchUpStatus(
    usageCatchUpStatusQuery.found,
    usageCatchUpStatusQuery.status,
    i18n.language,
    t
  );

  useEffect(() => {
    accountQuotaStatesByRowIdRef.current = accountQuotaStatesByRowId;
  }, [accountQuotaStatesByRowId]);

  useEffect(() => {
    writeAccountOverviewUiState({
      mode: accountOverviewMode,
      accountDisplayMode,
      sort: accountSort,
      cardPagination: {
        page: accountPageByMode.card,
        pageSize: accountPageSizeByMode.card,
      },
    });
  }, [
    accountDisplayMode,
    accountOverviewMode,
    accountPageByMode.card,
    accountPageSizeByMode.card,
    accountSort,
  ]);

  useEffect(() => {
    writeMonitoringCenterUiState({
      activeDataTab,
      timeRange,
      customStartInput,
      customEndInput,
      searchInput,
      autoRefreshMs,
      selectedAccount,
      selectedProvider,
      selectedModel,
      selectedChannel,
      selectedApiKeyHash,
      selectedHeaderTraceId,
      selectedStatus,
      apiKeyPageSize,
      realtimePageSize,
      realtimeLowCacheHitRateThreshold,
    });
  }, [
    activeDataTab,
    apiKeyPageSize,
    autoRefreshMs,
    customEndInput,
    customStartInput,
    realtimeLowCacheHitRateThreshold,
    realtimePageSize,
    searchInput,
    selectedAccount,
    selectedApiKeyHash,
    selectedChannel,
    selectedHeaderTraceId,
    selectedModel,
    selectedProvider,
    selectedStatus,
    timeRange,
  ]);

  const providerOptions = useMemo(
    () => buildProviderOptionsFromValues(monitoringFilterOptions.providers, selectedProvider, t),
    [monitoringFilterOptions.providers, selectedProvider, t]
  );

  const accountOptions = useMemo(
    () =>
      buildAccountOptions(
        monitoringFilterOptions.accountRows,
        selectedAccount,
        t,
        accountDisplayMode
      ),
    [accountDisplayMode, monitoringFilterOptions.accountRows, selectedAccount, t]
  );

  const modelOptions = useMemo(
    () => buildModelOptionsFromValues(monitoringFilterOptions.models, selectedModel, t),
    [monitoringFilterOptions.models, selectedModel, t]
  );

  const channelOptions = useMemo(
    () => buildChannelOptionsFromValues(monitoringFilterOptions.channels, selectedChannel, t),
    [monitoringFilterOptions.channels, selectedChannel, t]
  );

  const apiKeyOptions = useMemo(
    () => buildApiKeyOptionsFromRows(monitoringFilterOptions.apiKeyRows, selectedApiKeyHash, t),
    [monitoringFilterOptions.apiKeyRows, selectedApiKeyHash, t]
  );

  const statusOptions = useMemo(() => buildStatusOptions(t), [t]);

  const authFilesByAuthIndex = useMemo(() => buildAuthFilesByAuthIndex(authFiles), [authFiles]);
  const accountSourceProviderStateBySourceKey = useMemo(
    () =>
      buildSourceProviderStateMap(
        buildSourceInfoMap({
          geminiApiKeys: config?.geminiApiKeys || [],
          claudeApiKeys: config?.claudeApiKeys || [],
          codexApiKeys: config?.codexApiKeys || [],
          xaiApiKeys: config?.xaiApiKeys || [],
          metaApiKeys: config?.metaApiKeys || [],
          vertexApiKeys: config?.vertexApiKeys || [],
          openaiCompatibility: config?.openaiCompatibility || [],
        })
      ),
    [config]
  );

  const scopedRows = filteredRows;
  const scopedStatsRows = useMemo(
    () => scopedRows.filter((row) => row.statsIncluded),
    [scopedRows]
  );
  const accountStatusNowMs = monitoringLastRefreshedAt?.getTime() ?? Date.now();
  const accountStatusBounds = useMemo(() => {
    const bounds = getRangeBounds(timeRange, accountStatusNowMs, customTimeRange);
    if (!bounds || timeRange !== 'yesterday') return bounds;
    return { ...bounds, endMs: bounds.endMs - 1 };
  }, [accountStatusNowMs, customTimeRange, timeRange]);
  // 下面三个范围文案都经 formatInUtc8(读全局时区)渲染起止时刻，必须把 timeZone 纳入
  // 依赖，否则切换时区后 useMemo 命中旧缓存、文案不即时更新(R5-4 切换滞后根因)。
  // timeZone 是在被调函数内部间接读取(全局 store)，exhaustive-deps 看不到这层依赖会误报
  // "unnecessary dependency"，此处的依赖是有意的缓存失效信号，故在依赖数组行按需禁用该规则。
  const accountOverviewScopeText = useMemo(
    () => formatAccountOverviewScopeText(accountStatusBounds, i18n.language, t),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accountStatusBounds, i18n.language, t, timeZone]
  );
  const monitoringSummaryScopeText = useMemo(
    () => formatMonitoringSummaryScopeText(timeRange, t, customRangeDescriptor, i18n.language),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [customRangeDescriptor, i18n.language, t, timeRange, timeZone]
  );
  // 时间行"自定义"段的紧凑标签：仅在真的处于 custom 档时用描述符还原实际选择，
  // 其余快捷档下 timeRange !== 'custom'，回退到笼统的"自定义"文案(段本身不高亮)。
  const customRangeCompactLabel = useMemo(
    () =>
      timeRange === 'custom'
        ? formatMonitoringCustomRangeCompactLabel(customRangeDescriptor, i18n.language, t)
        : t('monitoring.range_custom'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [customRangeDescriptor, i18n.language, t, timeRange, timeZone]
  );

  const scopedSummary = monitoringSummary;
  const accountRows = monitoringAccountRows;
  const apiKeyRows = monitoringApiKeyRows;
  const { accountCount, apiKeyCount } = useMemo(
    () =>
      resolveMonitoringDimensionCounts({
        activeDataTab,
        accountRowCount: accountRows.length,
        apiKeyRowCount: apiKeyRows.length,
        accountSelectorCount:
          monitoringFilterOptions.accountCount ?? monitoringFilterOptions.accountRows.length,
        apiKeySelectorCount:
          monitoringFilterOptions.apiKeyCount ?? monitoringFilterOptions.apiKeyRows.length,
      }),
    [
      accountRows.length,
      activeDataTab,
      apiKeyRows.length,
      monitoringFilterOptions.accountCount,
      monitoringFilterOptions.accountRows.length,
      monitoringFilterOptions.apiKeyCount,
      monitoringFilterOptions.apiKeyRows.length,
    ]
  );
  const accountStatusDataByRowId = useMemo(
    () => buildMonitoringAccountStatusDataMap(scopedRows, accountStatusBounds, accountRows),
    [accountRows, accountStatusBounds, scopedRows]
  );
  const emptyAccountStatusData = useMemo(() => {
    const resolvedBounds = resolveMonitoringStatusRangeBounds(scopedRows, accountStatusBounds);
    return resolvedBounds ? buildEmptyMonitoringStatusData(resolvedBounds) : EMPTY_STATUS_BAR_DATA;
  }, [accountStatusBounds, scopedRows]);
  const accountAuthStateByRowId = useMemo(
    () =>
      buildMonitoringAccountAuthStateMap(
        accountRows,
        authFilesByAuthIndex,
        accountSourceProviderStateBySourceKey
      ),
    [accountRows, accountSourceProviderStateBySourceKey, authFilesByAuthIndex]
  );
  const sortedAccountRows = useMemo(
    () => sortAccountRows(accountRows, accountSort),
    [accountRows, accountSort]
  );
  const groupedRealtimeRows = useMemo(
    () => buildRealtimeMonitorRows(scopedStatsRows),
    [scopedStatsRows]
  );
  const realtimeLogRows = useMemo(() => buildRealtimeLogRows(scopedRows), [scopedRows]);
  const accountPagination = useMemo(
    () => buildPaginationState(sortedAccountRows, accountPage, accountPageSize),
    [accountPage, accountPageSize, sortedAccountRows]
  );
  const apiKeyPagination = useMemo(
    () => buildPaginationState(apiKeyRows, apiKeyPage, apiKeyPageSize),
    [apiKeyPage, apiKeyPageSize, apiKeyRows]
  );
  const realtimePagination = useMemo(
    () => buildPaginationState(realtimeLogRows, realtimePage, realtimePageSize),
    [realtimeLogRows, realtimePage, realtimePageSize]
  );
  const accountPageResetState = useMemo<AccountOverviewPageResetState>(
    () => ({
      customEndInput,
      customStartInput,
      deferredSearch,
      selectedAccount,
      selectedApiKeyHash,
      selectedChannel,
      selectedHeaderTraceId,
      selectedModel,
      selectedProvider,
      selectedStatus,
      timeRange,
    }),
    [
      customEndInput,
      customStartInput,
      deferredSearch,
      selectedAccount,
      selectedApiKeyHash,
      selectedChannel,
      selectedHeaderTraceId,
      selectedModel,
      selectedProvider,
      selectedStatus,
      timeRange,
    ]
  );

  useEffect(() => {
    if (
      shouldResetAccountOverviewPage(
        previousAccountPageResetStateRef.current,
        accountPageResetState
      )
    ) {
      if (monitoringScopeTransitioning && hasMonitoringPresentationSnapshot) {
        return;
      }
      resetCurrentAccountPage();
      setApiKeyPage(1);
      setRealtimePage(1);
    }

    previousAccountPageResetStateRef.current = accountPageResetState;
  }, [
    accountPageResetState,
    hasMonitoringPresentationSnapshot,
    monitoringScopeTransitioning,
    resetCurrentAccountPage,
  ]);

  useEffect(() => {
    if (
      !shouldClampAccountOverviewPage(overallLoading, accountPage, accountPagination.currentPage)
    ) {
      return;
    }

    setCurrentAccountPage(accountPagination.currentPage);
  }, [accountPage, accountPagination.currentPage, overallLoading, setCurrentAccountPage]);

  const accountQuotaTargetsByRowId = useMemo(
    () => buildMonitoringAccountQuotaTargetsByRowId(accountRows, accountAuthStateByRowId),
    [accountAuthStateByRowId, accountRows]
  );
  const headerSnapshotLookup = useMemo(
    () =>
      buildUsageHeaderSnapshotLookup(
        filterFreshUsageHeaderQuotaSnapshots(headerSnapshots, headerSnapshotGeneratedAtMs)
      ),
    [headerSnapshotGeneratedAtMs, headerSnapshots]
  );
  const scopedFailureCount = scopedSummary.failureCalls;
  const accountQuotaStatesByRowIdWithObservedHeaders = useMemo(() => {
    let changed = false;
    const nextStates: Record<string, AccountQuotaState> = {};
    const rowIds = new Set([
      ...accountQuotaTargetsByRowId.keys(),
      ...Object.keys(accountQuotaStatesByRowId),
    ]);
    rowIds.forEach((rowId) => {
      const state = accountQuotaStatesByRowId[rowId];
      const targets = accountQuotaTargetsByRowId.get(rowId) ?? [];
      const sharedEntries = targets
        .map((target) => buildCachedAccountQuotaEntry(target, sharedQuotaStores, t))
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
      const stateWithSharedQuota = mergeSharedAccountQuotaState(state, targets, sharedEntries);
      const observedEntries = targets
        .map((target) =>
          buildObservedCodexAccountQuotaEntry(
            target,
            getHighConfidenceUsageHeaderSnapshotForAuthFile(headerSnapshotLookup, target.file),
            t
          )
        )
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
      const nextState = mergeObservedAccountQuotaState(
        stateWithSharedQuota,
        targets,
        observedEntries
      );
      if (nextState) nextStates[rowId] = nextState;
      changed = changed || nextState !== state;
    });
    return changed ? nextStates : accountQuotaStatesByRowId;
  }, [
    accountQuotaStatesByRowId,
    accountQuotaTargetsByRowId,
    headerSnapshotLookup,
    sharedQuotaStores,
    t,
  ]);

  const hasSearchFilter = Boolean(deferredSearch.trim());
  const hasScopeFilter =
    selectedAccount !== 'all' ||
    selectedProvider !== 'all' ||
    selectedModel !== 'all' ||
    selectedChannel !== 'all' ||
    selectedApiKeyHash !== 'all' ||
    selectedHeaderTraceId !== 'all' ||
    selectedStatus !== 'all' ||
    Boolean(
      preciseDrilldown.authIndex ||
      preciseDrilldown.requestId ||
      preciseDrilldown.resolvedModel ||
      preciseDrilldown.unresolvedModel
    ) ||
    Boolean(drilldownAuthFile) ||
    Boolean(drilldownProjectId) ||
    Boolean(drilldownRequestType) ||
    Boolean(drilldownMinLatencyMs) ||
    Boolean(drilldownCacheStatus);
  const hasActiveDataFilter = hasSearchFilter || hasScopeFilter;
  const failedGroupCount = groupedRealtimeRows.filter((row) => row.failureCalls > 0).length;
  const failedOnlyActive = selectedStatus === 'failed';
  const hasMonitoringDisplayData =
    scopedSummary.totalCalls > 0 ||
    accountRows.length > 0 ||
    apiKeyRows.length > 0 ||
    filteredRows.length > 0;
  const connectionTone: MonitoringStatusTone =
    connectionStatus === 'connected' ? 'good' : connectionStatus === 'connecting' ? 'warn' : 'bad';
  const connectionLabel =
    connectionStatus === 'connected'
      ? t('common.connected_status')
      : connectionStatus === 'connecting'
        ? t('common.connecting_status')
        : connectionStatus === 'error'
          ? t('common.error')
          : t('common.disconnected_status');

  const accountOverviewColumns = useMemo(() => buildAccountOverviewColumns(t), [t]);

  const apiKeyOverviewColumns = useMemo(() => buildApiKeyOverviewColumns(t), [t]);

  const accountSortOptions = useMemo(
    () => buildAccountSortOptions(accountOverviewColumns, t),
    [accountOverviewColumns, t]
  );

  const accountPageSizeOptions =
    accountOverviewMode === 'card'
      ? ACCOUNT_OVERVIEW_CARD_PAGE_SIZE_OPTIONS
      : ACCOUNT_OVERVIEW_TABLE_PAGE_SIZE_OPTIONS;

  const primarySummaryCards = useMemo(
    () =>
      buildPrimarySummaryCards({
        summary: scopedSummary,
        accountCount,
        failedGroupCount,
        hasPrices,
        locale: i18n.language,
        t,
      }),
    [accountCount, failedGroupCount, hasPrices, i18n.language, scopedSummary, t]
  );

  const secondarySummaryCards = useMemo(
    () => buildSecondarySummaryCards(scopedSummary, i18n.language, t),
    [i18n.language, scopedSummary, t]
  );

  const dataTabs = useMemo<MonitoringTab<MonitoringDataTab>[]>(() => {
    const totalCalls = scopedSummary.totalCalls;
    const failureCount = scopedFailureCount;
    const realtimeHasFailure = failureCount > 0;
    const realtimeBadge = realtimeHasFailure ? failureCount : formatCompactNumber(totalCalls);
    return [
      {
        id: 'accounts',
        label: shortLabel(t, 'monitoring.data_tab_accounts_short', 'monitoring.data_tab_accounts'),
        fullLabel: t('monitoring.data_tab_accounts'),
        icon: 'accounts',
        badge: accountCount,
        badgeTitle: t('monitoring.data_tab_accounts_badge_title', { count: accountCount }),
      },
      {
        id: 'apiKeys',
        label: shortLabel(t, 'monitoring.data_tab_api_keys_short', 'monitoring.data_tab_api_keys'),
        fullLabel: t('monitoring.data_tab_api_keys'),
        icon: 'apiKeys',
        badge: apiKeyCount,
        badgeTitle: t('monitoring.data_tab_api_keys_badge_title', { count: apiKeyCount }),
      },
      {
        id: 'realtime',
        label: shortLabel(t, 'monitoring.data_tab_realtime_short', 'monitoring.data_tab_realtime'),
        fullLabel: t('monitoring.data_tab_realtime'),
        icon: 'realtime',
        badge: realtimeBadge,
        badgeTone: realtimeHasFailure ? 'failure' : 'default',
        badgeTitle: t('monitoring.data_tab_realtime_badge_title', {
          failed: failureCount,
          total: totalCalls,
        }),
      },
    ];
  }, [accountCount, apiKeyCount, scopedFailureCount, scopedSummary.totalCalls, t]);

  const handleDataTabChange = useCallback((tab: MonitoringDataTab) => {
    setActiveDataTab(tab);
  }, []);

  const restoreFocusSnapshot = useCallback(() => {
    const snapshot = focusSnapshotRef.current;
    focusSnapshotRef.current = null;
    setFocusedAccountId(null);

    if (!snapshot) {
      setSelectedAccount('all');
      return;
    }

    setSearchInput(snapshot.searchInput);
    setSelectedAccount(snapshot.selectedAccount);
    setSelectedProvider(snapshot.selectedProvider);
    setSelectedModel(snapshot.selectedModel);
    setSelectedChannel(snapshot.selectedChannel);
    setSelectedApiKeyHash(snapshot.selectedApiKeyHash);
    setSelectedHeaderTraceId(snapshot.selectedHeaderTraceId);
    setSelectedStatus(snapshot.selectedStatus);
  }, []);

  const clearFilters = useCallback(() => {
    focusSnapshotRef.current = null;
    setFocusedAccountId(null);
    setSearchInput('');
    setSelectedAccount('all');
    setSelectedProvider('all');
    setSelectedModel('all');
    setSelectedChannel('all');
    setSelectedApiKeyHash('all');
    setSelectedHeaderTraceId('all');
    setSelectedStatus('all');
    setPreciseDrilldown({ authIndex: '', requestId: '', resolvedModel: '', unresolvedModel: '' });
    setDrilldownAuthFile('');
    setDrilldownProjectId('');
    setDrilldownRequestType('');
    setDrilldownMinLatencyMs(undefined);
    setDrilldownCacheStatus('');
  }, []);

  const renderMonitoringEmptyState = () => (
    <div className={styles.emptyState}>
      <IconInbox size={48} className={styles.emptyStateIcon} aria-hidden="true" />
      <strong className={styles.emptyStateTitle}>
        {hasActiveDataFilter ? t('monitoring.no_filtered_data') : t('monitoring.no_data')}
      </strong>
      {!hasActiveDataFilter ? (
        <details className={styles.emptyStateDetails}>
          <summary className={styles.emptyStateSummary}>
            {t('monitoring.empty_diagnostics_link')}
          </summary>
          <span className={styles.emptyStateBody}>{t('monitoring.empty_diagnostics_body')}</span>
        </details>
      ) : null}
    </div>
  );

  const openCustomRangeModal = useCallback(() => {
    setCustomDraftStartInput(customStartInput || getTodayStartInputValue());
    setCustomDraftEndInput(customEndInput || getCurrentInputValue());
    setIsCustomRangeModalOpen(true);
  }, [customEndInput, customStartInput]);

  const handleTimeRangeChange = useCallback(
    (range: MonitoringTimeRange) => {
      if (range === 'custom') {
        openCustomRangeModal();
        return;
      }
      setIsCustomRangeModalOpen(false);
      setTimeRange(range);
    },
    [openCustomRangeModal]
  );

  const handleCustomDraftStartChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setCustomDraftStartInput(event.target.value);
  }, []);

  const handleCustomDraftEndChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setCustomDraftEndInput(event.target.value);
  }, []);

  const applyCustomTimeRange = useCallback(() => {
    if (customDraftTimeRangeError) return;
    setCustomStartInput(customDraftStartInput);
    setCustomEndInput(customDraftEndInput);
    // 日期范围模式的描述符只在提交时(而不是每次草稿改动时)重新计算一次，
    // 用最终确认的开始/结束时间还原展示，与其余 hours/days 模式一致。
    const startMs = parseDateTimeLocalValue(customDraftStartInput);
    const endMs = parseDateTimeLocalValue(customDraftEndInput);
    setCustomRangeDescriptor(
      startMs !== null && endMs !== null ? { mode: 'range', startMs, endMs } : null
    );
    setTimeRange('custom');
    setIsCustomRangeModalOpen(false);
  }, [customDraftEndInput, customDraftStartInput, customDraftTimeRangeError]);

  // 任意 N 小时/N 天：换算成 [now - N, now] 的 datetime-local 输入值，复用既有
  // custom 日期区间提交路径(customStartInput/customEndInput + timeRange='custom')，
  // 不新增单独的时间范围计算口径；额外记录 hours/days 描述符，供 caption 与时间行
  // "自定义"段还原"最近 N 小时/N 天"这种更直观的展示，而不是退化成日期范围格式。
  const applyHoursTimeRange = useCallback((hours: number) => {
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - hours * 60 * 60 * 1000);
    const startValue = formatDateTimeLocalValue(startDate);
    const endValue = formatDateTimeLocalValue(endDate);
    setCustomStartInput(startValue);
    setCustomEndInput(endValue);
    setCustomDraftStartInput(startValue);
    setCustomDraftEndInput(endValue);
    setCustomRangeDescriptor({ mode: 'hours', hours });
    setTimeRange('custom');
    setIsCustomRangeModalOpen(false);
  }, []);

  const applyDaysTimeRange = useCallback((days: number) => {
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);
    const startValue = formatDateTimeLocalValue(startDate);
    const endValue = formatDateTimeLocalValue(endDate);
    setCustomStartInput(startValue);
    setCustomEndInput(endValue);
    setCustomDraftStartInput(startValue);
    setCustomDraftEndInput(endValue);
    setCustomRangeDescriptor({ mode: 'days', days });
    setTimeRange('custom');
    setIsCustomRangeModalOpen(false);
  }, []);

  const toggleFailedOnly = useCallback(() => {
    setSelectedStatus((previous) => (previous === 'failed' ? 'all' : 'failed'));
  }, []);

  const toggleRealtimeLowCacheHitRateOnly = useCallback(() => {
    setRealtimeLowCacheHitRateOnly((previous) => !previous);
  }, []);

  const changeRealtimeLowCacheHitRateThreshold = useCallback((threshold: number) => {
    setRealtimeLowCacheHitRateThreshold(normalizeLowCacheHitRateThreshold(threshold));
  }, []);

  const toggleApiKeyExpanded = useCallback((apiKeyId: string) => {
    setExpandedApiKeys((previous) => ({
      ...previous,
      [apiKeyId]: !previous[apiKeyId],
    }));
  }, []);

  const commitAccountQuotaState = useCallback((rowId: string, state: AccountQuotaState) => {
    accountQuotaStatesByRowIdRef.current = updateMonitoringAccountQuotaStateByRowId(
      accountQuotaStatesByRowIdRef.current,
      rowId,
      state
    );
    setAccountQuotaStatesByRowId((previous) => {
      const next = updateMonitoringAccountQuotaStateByRowId(previous, rowId, state);
      accountQuotaStatesByRowIdRef.current = next;
      return next;
    });
  }, []);

  const refreshQuotaForTarget = useCallback(
    async (
      target: MonitoringAccountQuotaTarget,
      isCurrent: () => boolean
    ): Promise<MonitoringQuotaRefreshResult | null> => {
      const run = async <TState, TData>(
        config: QuotaConfig<TState, TData>,
        setQuota: QuotaSetter<TState>,
        currentState: TState | undefined
      ): Promise<MonitoringQuotaRefreshResult | null> => {
        const result: QuotaRefreshResult<TState, TData> | null = await refreshQuotaWithConfig({
          config,
          file: target.file,
          setQuota,
          t,
          isCurrent,
          requestScope: quotaRequestScope,
          currentState,
        });
        if (!result) return null;
        return result.status === 'error'
          ? {
              status: 'error',
              state: result.state as MonitoringProviderQuotaState,
              error: result.error,
            }
          : {
              status: 'success',
              state: result.state as MonitoringProviderQuotaState,
            };
      };

      switch (target.provider) {
        case 'antigravity':
          return run(
            ANTIGRAVITY_CONFIG,
            setAntigravityQuota,
            getCredentialScopedQuotaState(sharedQuotaStores.antigravityQuota, target.file)
          );
        case 'claude':
          return run(
            CLAUDE_CONFIG,
            setClaudeQuota,
            getCredentialScopedQuotaState(sharedQuotaStores.claudeQuota, target.file)
          );
        case 'codex':
          return run(
            CODEX_CONFIG,
            setCodexQuota,
            getCredentialScopedQuotaState(sharedQuotaStores.codexQuota, target.file)
          );
        case 'kimi':
          return run(
            KIMI_CONFIG,
            setKimiQuota,
            getCredentialScopedQuotaState(sharedQuotaStores.kimiQuota, target.file)
          );
        case 'devin':
          return run(
            DEVIN_CONFIG,
            setDevinQuota,
            getCredentialScopedQuotaState(sharedQuotaStores.devinQuota, target.file)
          );
        case 'xai':
          return run(
            XAI_CONFIG,
            setXaiQuota,
            getCredentialScopedQuotaState(sharedQuotaStores.xaiQuota, target.file)
          );
      }
    },
    [
      quotaRequestScope,
      sharedQuotaStores,
      setAntigravityQuota,
      setClaudeQuota,
      setCodexQuota,
      setDevinQuota,
      setKimiQuota,
      setXaiQuota,
      t,
    ]
  );

  const loadAccountQuota = useCallback(
    (rowId: string, force: boolean = false): Promise<void> => {
      const currentState = accountQuotaStatesByRowIdRef.current[rowId];
      const targets = accountQuotaTargetsByRowId.get(rowId) ?? [];
      const targetKey = targets.map((target) => target.key).join('|');
      const mutationRevision = accountQuotaMutationRevisionsByRowIdRef.current[rowId] ?? 0;
      const requestKey = `${accountQuotaContextKey}\u0000${rowId}\u0000${targetKey}\u0000${mutationRevision}`;
      if (accountQuotaRefreshQueue.isPending(requestKey)) {
        return accountQuotaRefreshQueue.run(requestKey, async () => undefined);
      }
      const cachedEntries = targets
        .map((target) => buildCachedAccountQuotaEntry(target, sharedQuotaStores, t))
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
      const previousEntriesByKey = new Map(cachedEntries.map((entry) => [entry.key, entry]));
      if (currentState?.targetKey === targetKey) {
        currentState.entries.forEach((entry) => previousEntriesByKey.set(entry.key, entry));
      }
      const previousEntries = Array.from(previousEntriesByKey.values());
      const observedEntries = targets
        .map((target) =>
          buildObservedCodexAccountQuotaEntry(
            target,
            getHighConfidenceUsageHeaderSnapshotForAuthFile(headerSnapshotLookup, target.file),
            t
          )
        )
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
      if (currentState?.status === 'loading' && currentState.targetKey === targetKey) {
        return Promise.resolve();
      }
      if (
        !force &&
        currentState &&
        currentState.status !== 'idle' &&
        currentState.targetKey === targetKey
      ) {
        return Promise.resolve();
      }

      const contextGeneration = accountQuotaContextGenerationRef.current;
      const requestId = (accountQuotaRequestIdsByRowIdRef.current[rowId] ?? 0) + 1;
      accountQuotaRequestIdsByRowIdRef.current[rowId] = requestId;
      const isCurrentRequest = () =>
        accountQuotaContextGenerationRef.current === contextGeneration &&
        accountQuotaRequestIdsByRowIdRef.current[rowId] === requestId;

      commitAccountQuotaState(rowId, {
        status: 'loading',
        targetKey,
        entries: previousEntries.length > 0 ? previousEntries : observedEntries,
        lastRefreshedAt: currentState?.lastRefreshedAt,
      });

      return accountQuotaRefreshQueue.run(requestKey, async () => {
        if (!isCurrentRequest()) return;
        if (targets.length === 0) {
          commitAccountQuotaState(rowId, {
            status: 'success',
            targetKey,
            entries: [],
            lastRefreshedAt: Date.now(),
          });
          return;
        }
        const taskPlan = buildProviderCredentialTaskPlan(targets, {
          getProviderKey: (target) => target.provider,
          getCredentialKey: (target) => getQuotaCredentialStoreKey(target.file),
        });
        const settled = await runProviderCredentialTaskPlan(
          taskPlan,
          {
            perProviderConcurrency: MAX_CONCURRENT_ACCOUNT_QUOTA_REQUESTS_PER_PROVIDER,
            maxConcurrentProviders: MAX_CONCURRENT_ACCOUNT_QUOTA_PROVIDERS,
          },
          async ({ item: target }) => {
            try {
              return {
                target,
                result: {
                  status: 'fulfilled' as const,
                  value: await refreshQuotaForTarget(target, isCurrentRequest),
                },
              };
            } catch (reason: unknown) {
              return {
                target,
                result: {
                  status: 'rejected' as const,
                  reason,
                },
              };
            }
          }
        );
        if (!isCurrentRequest()) return;
        if (settled.some(({ result }) => result.status === 'fulfilled' && result.value === null)) {
          return;
        }

        const hasFailure = settled.some(
          ({ result }) =>
            result.status === 'rejected' ||
            (result.status === 'fulfilled' && result.value?.status === 'error')
        );
        const completedAtMs = Date.now();
        const entries = settled.map(({ result, target: fallback }) => {
          if (result.status === 'fulfilled') {
            const refreshResult = result.value;
            if (!refreshResult) {
              return (
                previousEntriesByKey.get(fallback.key) ??
                buildAccountQuotaErrorEntry(fallback, t('common.unknown_error'), t)
              );
            }
            const providerEntry = buildAccountQuotaEntryFromProviderState(
              fallback,
              refreshResult.state,
              t
            );
            if (refreshResult.status === 'success') {
              return (
                providerEntry ??
                previousEntriesByKey.get(fallback.key) ??
                buildAccountQuotaErrorEntry(fallback, t('common.unknown_error'), t)
              );
            }
            const observedEntry = buildObservedCodexAccountQuotaEntry(
              fallback,
              getHighConfidenceUsageHeaderSnapshotForAuthFile(headerSnapshotLookup, fallback.file),
              t
            );
            return buildAccountQuotaRefreshFailureEntry(
              fallback,
              refreshResult.error || t('common.unknown_error'),
              t,
              previousEntriesByKey.get(fallback.key) ?? providerEntry ?? undefined,
              observedEntry,
              completedAtMs
            );
          }

          const error =
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason || t('common.unknown_error'));
          const observedEntry = buildObservedCodexAccountQuotaEntry(
            fallback,
            getHighConfidenceUsageHeaderSnapshotForAuthFile(headerSnapshotLookup, fallback.file),
            t
          );
          return buildAccountQuotaRefreshFailureEntry(
            fallback,
            error,
            t,
            previousEntriesByKey.get(fallback.key),
            observedEntry,
            completedAtMs
          );
        });

        const hasSuccess = entries.some((entry) => !entry.error);
        const firstError = entries.find((entry) => entry.error)?.error;
        commitAccountQuotaState(rowId, {
          status: hasFailure ? 'error' : hasSuccess ? 'success' : 'error',
          targetKey,
          entries,
          error: hasFailure ? firstError || t('common.unknown_error') : '',
          failedAtMs: hasFailure ? completedAtMs : undefined,
          lastRefreshedAt: hasFailure ? currentState?.lastRefreshedAt : completedAtMs,
        });
      });
    },
    [
      accountQuotaContextKey,
      accountQuotaRefreshQueue,
      accountQuotaTargetsByRowId,
      commitAccountQuotaState,
      headerSnapshotLookup,
      refreshQuotaForTarget,
      sharedQuotaStores,
      t,
    ]
  );

  useEffect(() => {
    if (pendingCredentialMutationProviders.length === 0) return;
    const providers = new Set(pendingCredentialMutationProviders);
    const affectedRowIds = new Set<string>();
    accountQuotaTargetsByRowId.forEach((targets, rowId) => {
      if (targets.some((target) => providers.has(target.provider))) affectedRowIds.add(rowId);
    });
    Object.entries(accountQuotaStatesByRowIdRef.current).forEach(([rowId, state]) => {
      if (state.entries.some((entry) => providers.has(entry.provider))) affectedRowIds.add(rowId);
    });

    const previousStates = accountQuotaStatesByRowIdRef.current;
    const nextStates = { ...previousStates };
    affectedRowIds.forEach((rowId) => {
      delete nextStates[rowId];
      accountQuotaRequestIdsByRowIdRef.current[rowId] =
        (accountQuotaRequestIdsByRowIdRef.current[rowId] ?? 0) + 1;
      accountQuotaMutationRevisionsByRowIdRef.current[rowId] =
        (accountQuotaMutationRevisionsByRowIdRef.current[rowId] ?? 0) + 1;
    });
    accountQuotaStatesByRowIdRef.current = nextStates;
    setAccountQuotaStatesByRowId(nextStates);
    setPendingCredentialMutationProviders([]);

    affectedRowIds.forEach((rowId) => {
      if (previousStates[rowId] || expandedAccounts[rowId] || focusedAccountId === rowId) {
        void loadAccountQuota(rowId, true);
      }
    });
  }, [
    accountQuotaTargetsByRowId,
    expandedAccounts,
    focusedAccountId,
    loadAccountQuota,
    pendingCredentialMutationProviders,
  ]);

  const toggleAccountExpanded = useCallback((accountId: string) => {
    setExpandedAccounts((previous) => ({
      ...previous,
      [accountId]: !previous[accountId],
    }));
  }, []);

  const focusAccount = useCallback(
    (row: MonitoringAccountRow) => {
      const action = resolveMonitoringAccountFocusAction(focusedAccountId, row);
      if (action.type === 'restore') {
        restoreFocusSnapshot();
        return;
      }

      if (!focusSnapshotRef.current) {
        focusSnapshotRef.current = {
          searchInput,
          selectedAccount,
          selectedProvider,
          selectedModel,
          selectedChannel,
          selectedApiKeyHash,
          selectedHeaderTraceId,
          selectedStatus,
        };
      }

      setFocusedAccountId(action.rowId);
      setSelectedAccount(action.filterValue);
    },
    [
      focusedAccountId,
      restoreFocusSnapshot,
      searchInput,
      selectedAccount,
      selectedApiKeyHash,
      selectedChannel,
      selectedHeaderTraceId,
      selectedModel,
      selectedProvider,
      selectedStatus,
    ]
  );

  const handleAccountFilterChange = useCallback(
    (value: string) => {
      setSelectedAccount(value);

      if (focusedAccountId) {
        focusSnapshotRef.current = null;
        setFocusedAccountId(null);
      }
    },
    [focusedAccountId]
  );

  const handleAccountPageSizeChange = useCallback(
    (pageSize: number) => {
      setAccountPageSizeByMode((previous) => ({
        ...previous,
        [accountOverviewMode]: normalizeAccountOverviewPageSize(pageSize, accountOverviewMode),
      }));
      resetCurrentAccountPage();
    },
    [accountOverviewMode, resetCurrentAccountPage]
  );

  const handleApiKeyPageSizeChange = useCallback((pageSize: number) => {
    setApiKeyPageSize(normalizeAccountOverviewPageSize(pageSize, 'table'));
    setApiKeyPage(1);
  }, []);

  const handleRealtimePageSizeChange = useCallback((pageSize: number) => {
    setRealtimePageSize(pageSize);
    setRealtimePage(1);
  }, []);

  const handleAccountSortKeyChange = useCallback(
    (key: AccountSortKey) => {
      resetCurrentAccountPage();
      setAccountSort((previous) =>
        previous.key === key
          ? previous
          : {
              key,
              direction: 'desc',
            }
      );
    },
    [resetCurrentAccountPage]
  );

  const handleAccountSort = useCallback(
    (key: AccountSortKey) => {
      resetCurrentAccountPage();
      setAccountSort((previous) =>
        previous.key === key
          ? {
              key,
              direction: previous.direction === 'desc' ? 'asc' : 'desc',
            }
          : {
              key,
              direction: 'desc',
            }
      );
    },
    [resetCurrentAccountPage]
  );

  const dataPanelActions = useMemo(() => {
    if (activeDataTab === 'accounts') {
      return (
        <AccountOverviewPanelActions
          mode={accountOverviewMode}
          accountDisplayMode={accountDisplayMode}
          searchInput={searchInput}
          accountSort={accountSort}
          accountSortOptions={accountSortOptions}
          overallLoading={overallLoading}
          t={t}
          onSearchChange={setSearchInput}
          onRefreshAll={refreshAll}
          onAccountSortKeyChange={handleAccountSortKeyChange}
          onModeChange={setAccountOverviewMode}
          onAccountDisplayModeChange={setAccountDisplayMode}
        />
      );
    }

    if (activeDataTab === 'apiKeys') {
      return <ApiKeySummaryPanelActions rowCount={apiKeyRows.length} t={t} />;
    }

    return (
      <RealtimeEventsPanelActions
        rowCount={realtimeLogRows.length}
        scopedFailureCount={scopedFailureCount}
        failedOnlyActive={failedOnlyActive}
        lowCacheHitRateOnly={realtimeLowCacheHitRateOnly}
        lowCacheHitRateThreshold={realtimeLowCacheHitRateThreshold}
        accountDisplayMode={accountDisplayMode}
        exportRows={realtimeLogRows}
        hasPrices={hasPrices}
        t={t}
        onToggleFailedOnly={toggleFailedOnly}
        onToggleLowCacheHitRateOnly={toggleRealtimeLowCacheHitRateOnly}
        onLowCacheHitRateThresholdChange={changeRealtimeLowCacheHitRateThreshold}
        onAccountDisplayModeChange={setAccountDisplayMode}
      />
    );
  }, [
    accountOverviewMode,
    accountDisplayMode,
    accountSort,
    accountSortOptions,
    activeDataTab,
    apiKeyRows.length,
    changeRealtimeLowCacheHitRateThreshold,
    failedOnlyActive,
    handleAccountSortKeyChange,
    hasPrices,
    overallLoading,
    realtimeLogRows,
    realtimeLowCacheHitRateOnly,
    realtimeLowCacheHitRateThreshold,
    refreshAll,
    scopedFailureCount,
    searchInput,
    setAccountDisplayMode,
    t,
    toggleFailedOnly,
    toggleRealtimeLowCacheHitRateOnly,
  ]);

  const handleAccountPageChange = useCallback(
    (page: number) => {
      setCurrentAccountPage(page);
    },
    [setCurrentAccountPage]
  );

  const handleApiKeyPageChange = useCallback((page: number) => {
    setApiKeyPage(page);
  }, []);

  const resolveUsageTransferError = useCallback(
    (error: unknown) => {
      const rawMessage =
        error instanceof Error ? error.message : String(error || t('common.unknown_error'));
      return rawMessage === 'usage_import_export_requires_usage_service'
        ? t('usage_stats.import_export_requires_usage_service')
        : rawMessage;
    },
    [t]
  );

  const handleUsageExport = useCallback(async () => {
    setUsageExporting(true);
    try {
      const response = await exportUsage();
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      downloadBlob({
        filename: response.filename || `usage-events-${timestamp}.jsonl`,
        blob: response.blob,
      });
      showNotification(t('usage_stats.export_success'), 'success');
    } catch (error: unknown) {
      const message = resolveUsageTransferError(error);
      showNotification(
        `${t('notification.download_failed')}${message ? `: ${message}` : ''}`,
        'error'
      );
    } finally {
      setUsageExporting(false);
    }
  }, [exportUsage, resolveUsageTransferError, showNotification, t]);

  const runSyncCoreHistory = useCallback(
    async (since: string | undefined) => {
      usageSyncCancelRef.current = false;
      setUsageSyncCancelling(false);
      const abortController = new AbortController();
      usageSyncAbortControllerRef.current = abortController;
      setUsageSyncingFromCore(true);
      setUsageSyncProgress({ batchCount: 0, added: 0, skipped: 0 });
      try {
        const outcome = await runSyncCoreHistoryCursorLoop(syncCoreHistory, {
          since,
          onProgress: (progress) => setUsageSyncProgress(progress),
          isCancelled: () => usageSyncCancelRef.current,
          signal: abortController.signal,
        });

        if (outcome.status === 'no_data') {
          usageSyncResumeSinceRef.current = undefined;
          setUsageSyncResumable(false);
          showNotification(t('usage_stats.sync_core_history_no_data'), 'warning');
          return;
        }

        if (outcome.status === 'cancelled') {
          usageSyncResumeSinceRef.current = outcome.nextSince;
          setUsageSyncResumable(true);
          showNotification(
            t('usage_stats.sync_core_history_cancelled', {
              batches: outcome.batchCount,
              added: outcome.added,
            }),
            'warning'
          );
          if (outcome.batchCount > 0) await refreshAll();
          return;
        }

        if (outcome.status === 'failed') {
          usageSyncResumeSinceRef.current = outcome.nextSince;
          setUsageSyncResumable(true);
          const code = getUsageServiceErrorCode(outcome.error);
          const message =
            code === 'cpa_core_connection_not_configured'
              ? t('usage_stats.sync_core_history_not_configured')
              : resolveUsageTransferError(outcome.error);
          if (outcome.batchCount > 0) {
            showNotification(
              t('usage_stats.sync_core_history_partial_failed', {
                batches: outcome.batchCount,
                added: outcome.added,
                nextBatch: outcome.batchCount + 1,
                message,
              }),
              'error'
            );
            await refreshAll();
          } else {
            showNotification(
              `${t('usage_stats.sync_core_history_failed')}${message ? `: ${message}` : ''}`,
              'error'
            );
          }
          return;
        }

        // completed
        usageSyncResumeSinceRef.current = undefined;
        setUsageSyncResumable(false);
        showNotification(
          t('usage_stats.sync_core_history_success', {
            added: outcome.added,
            skipped: outcome.skipped,
            batches: outcome.batchCount,
          }),
          'success'
        );
        await refreshAll();
      } finally {
        usageSyncAbortControllerRef.current = null;
        setUsageSyncingFromCore(false);
        setUsageSyncCancelling(false);
        setUsageSyncProgress(null);
      }
    },
    [refreshAll, resolveUsageTransferError, showNotification, syncCoreHistory, t]
  );

  const handleSyncCoreHistoryRangeSelect = useCallback(
    (sinceMs: number | null) => {
      const since = sinceMs === null ? undefined : new Date(sinceMs).toISOString();
      void runSyncCoreHistory(since);
    },
    [runSyncCoreHistory]
  );

  const handleSyncCoreHistoryRetry = useCallback(() => {
    void runSyncCoreHistory(usageSyncResumeSinceRef.current);
  }, [runSyncCoreHistory]);

  const handleSyncCoreHistoryCancel = useCallback(() => {
    usageSyncCancelRef.current = true;
    setUsageSyncCancelling(true);
    // 立即中断在途请求，而不是等到下一批开始前才检查取消标志；
    // 否则单批耗时较长时点击取消不会有任何效果，请求会一直跑到完成。
    usageSyncAbortControllerRef.current?.abort();
  }, []);

  const runUsageImport = useCallback(
    async (file: File) => {
      const runID = usageImportRunIDRef.current + 1;
      usageImportRunIDRef.current = runID;
      const controller = new AbortController();
      usageImportAbortRef.current = controller;
      setUsageImporting(true);
      setUsageImportTask((current) => ({
        file,
        progress:
          current?.file === file
            ? { ...current.progress, phase: 'preparing', error: undefined }
            : {
                sessionId: '',
                filename: file.name,
                phase: 'preparing',
                uploadedBytes: 0,
                totalBytes: file.size,
                percent: 0,
              },
      }));
      try {
        const result = await importUsage(file, {
          signal: controller.signal,
          onProgress: (progress) => {
            if (usageImportRunIDRef.current !== runID) return;
            setUsageImportTask({ file, progress });
          },
        });
        if (usageImportRunIDRef.current !== runID) return;
        const unsupported = result.unsupported ?? 0;
        showNotification(
          `${t('usage_stats.import_success', {
            added: result.added ?? 0,
            skipped: result.skipped ?? 0,
            total: result.total ?? 0,
            failed: result.failed ?? 0,
          })}${unsupported > 0 ? `, ${t('usage_stats.import_unsupported', { count: unsupported })}` : ''}`,
          (result.failed ?? 0) > 0 || unsupported > 0 ? 'warning' : 'success'
        );
        if (result.format?.startsWith('legacy') || (result.warnings ?? []).length > 0) {
          showNotification(t('usage_stats.import_legacy_warning'), 'warning');
        }
        await refreshAll();
        if (usageImportRunIDRef.current === runID) {
          setUsageImportTask(null);
        }
      } catch (error: unknown) {
        if (usageImportRunIDRef.current !== runID) return;
        if (isUsageImportPausedError(error)) {
          setUsageImportTask((current) =>
            current?.file === file
              ? { ...current, progress: { ...current.progress, phase: 'paused', error: undefined } }
              : current
          );
          return;
        }
        if (isUsageImportCancelledError(error)) {
          setUsageImportTask((current) =>
            current?.file === file
              ? {
                  ...current,
                  progress: { ...current.progress, phase: 'cancelled', error: undefined },
                }
              : current
          );
          showNotification(t('usage_stats.import_cancelled'), 'success');
          return;
        }
        const message = resolveUsageTransferError(error);
        setUsageImportTask((current) =>
          current?.file === file
            ? { ...current, progress: { ...current.progress, phase: 'failed', error: message } }
            : current
        );
        showNotification(
          `${t('notification.upload_failed')}${message ? `: ${message}` : ''}`,
          'error'
        );
      } finally {
        if (usageImportRunIDRef.current === runID) {
          usageImportAbortRef.current = null;
          setUsageImporting(false);
        }
      }
    },
    [importUsage, refreshAll, resolveUsageTransferError, showNotification, t]
  );

  const handleUsageImportPause = useCallback(() => {
    usageImportAbortRef.current?.abort();
  }, []);

  const handleUsageImportResume = useCallback(() => {
    if (!usageImportTask || usageImporting) return;
    void runUsageImport(usageImportTask.file);
  }, [runUsageImport, usageImportTask, usageImporting]);

  const handleUsageImportCancel = useCallback(async () => {
    const task = usageImportTask;
    if (!task || usageImportCancelPendingRef.current) return;
    usageImportCancelPendingRef.current = true;
    const runID = usageImportRunIDRef.current + 1;
    usageImportRunIDRef.current = runID;
    usageImportAbortRef.current?.abort();
    usageImportAbortRef.current = null;
    setUsageImporting(true);
    setUsageImportCancelling(true);
    let closeTask = false;
    try {
      if (task.progress.sessionId) {
        const cancelled = await cancelUsageImport(task.progress.sessionId, task.file);
        if (cancelled?.status === 'completed') {
          showNotification(
            t('usage_stats.import_completed_before_cancel', {
              added: cancelled.result?.added ?? 0,
              skipped: cancelled.result?.skipped ?? 0,
            }),
            'warning'
          );
          await refreshAll();
          closeTask = true;
        } else if (cancelled?.status === 'cancelled') {
          const uploadedBytes = cancelled.received_bytes;
          const totalBytes = cancelled.size_bytes || task.progress.totalBytes;
          setUsageImportTask((current) =>
            current?.file === task.file
              ? {
                  ...current,
                  progress: {
                    sessionId: cancelled.id,
                    filename: cancelled.filename || task.file.name,
                    phase: 'cancelled',
                    status: cancelled.status,
                    uploadedBytes,
                    totalBytes,
                    percent:
                      totalBytes > 0
                        ? uploadedBytes >= totalBytes
                          ? 100
                          : Math.max(0, Math.floor((uploadedBytes / totalBytes) * 100))
                        : 0,
                    retryable: cancelled.retryable,
                    result: cancelled.result,
                  },
                }
              : current
          );
          showNotification(t('usage_stats.import_cancelled'), 'success');
        } else {
          showNotification(t('usage_stats.import_cancelled'), 'success');
          closeTask = true;
        }
      } else {
        showNotification(t('usage_stats.import_cancelled'), 'success');
        closeTask = true;
      }
    } catch (error: unknown) {
      const message = resolveUsageTransferError(error);
      setUsageImportTask((current) =>
        current?.file === task.file
          ? { ...current, progress: { ...current.progress, phase: 'paused', error: message } }
          : current
      );
      showNotification(
        `${t('usage_stats.import_cancel_failed')}${message ? `: ${message}` : ''}`,
        'error'
      );
    } finally {
      usageImportCancelPendingRef.current = false;
      if (usageImportRunIDRef.current === runID) {
        setUsageImporting(false);
        setUsageImportCancelling(false);
        if (closeTask) {
          setUsageImportTask(null);
        }
      }
    }
  }, [
    cancelUsageImport,
    refreshAll,
    resolveUsageTransferError,
    showNotification,
    t,
    usageImportTask,
  ]);

  const handleUsageImportModalClose = useCallback(() => {
    if (!usageImporting && !usageImportCancelling) {
      setUsageImportTask(null);
    }
  }, [usageImportCancelling, usageImporting]);

  useEffect(
    () => () => {
      usageImportRunIDRef.current += 1;
      usageImportAbortRef.current?.abort();
    },
    []
  );

  const handleUsageImportClick = useCallback(() => {
    if (!requestMonitoringAvailability.available) {
      showNotification(t('usage_stats.import_export_requires_usage_service'), 'warning');
      return;
    }
    usageImportInputRef.current?.click();
  }, [requestMonitoringAvailability.available, showNotification, t]);

  const handleUsageImportChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;

      if (!isUsageImportFile(file)) {
        showNotification(t('usage_stats.import_invalid'), 'error');
        return;
      }
      showConfirmation({
        title: t('usage_stats.import_confirm_title'),
        message: t('usage_stats.import_confirm_body', { name: file.name }),
        confirmText: t('usage_stats.import'),
        variant: 'primary',
        onConfirm: () => runUsageImport(file),
      });
    },
    [runUsageImport, showConfirmation, showNotification, t]
  );

  if (monitoringUnavailable) {
    return (
      <div className={styles.page}>
        <MonitoringStatusHeader
          showLoadingOverlay={false}
          monitoringUnavailable={monitoringUnavailable}
          monitoringUnavailableTitle={monitoringUnavailableTitle}
          monitoringUnavailableBody={monitoringUnavailableBody}
          t={t}
        />
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <MonitoringStatusHeader
        showLoadingOverlay={
          overallLoading &&
          !hasMonitoringDisplayData &&
          (!monitoringScopeTransitioning || !hasMonitoringPresentationSnapshot)
        }
        monitoringUnavailable={monitoringUnavailable}
        monitoringUnavailableTitle={monitoringUnavailableTitle}
        monitoringUnavailableBody={monitoringUnavailableBody}
        t={t}
      />

      <MonitoringDatabaseMaintenanceHint
        performanceDegraded={monitoringMaintenanceWarning}
        longRange={monitoringMaintenanceLongRange}
      />

      <MonitoringActionBar
        usageTransferAvailable={usageTransferAvailable}
        usageExporting={usageExporting}
        usageImporting={usageImporting}
        usageSyncingFromCore={usageSyncingFromCore}
        usageSyncCancelling={usageSyncCancelling}
        usageSyncProgress={usageSyncProgress}
        hasResumableCoreHistorySync={usageSyncResumable}
        loggingToFile={isFileLogsAvailable(config)}
        modelPricesAvailable={requestMonitoringAvailability.modelPricesAvailable}
        usageImportInputRef={usageImportInputRef}
        t={t}
        onUsageExport={handleUsageExport}
        onUsageImportClick={handleUsageImportClick}
        onUsageImportChange={handleUsageImportChange}
        onSyncCoreHistoryRangeSelect={handleSyncCoreHistoryRangeSelect}
        onSyncCoreHistoryRetry={handleSyncCoreHistoryRetry}
        onSyncCoreHistoryCancel={handleSyncCoreHistoryCancel}
        statusSummary={
          <MonitoringStatusSummary
            connectionTone={connectionTone}
            connectionLabel={connectionLabel}
            lastRefreshedAt={monitoringLastRefreshedAt}
            locale={i18n.language}
            scopedFailureCount={scopedFailureCount}
            totalCalls={scopedSummary.totalCalls}
            t={t}
            usageCatchUpStatus={usageCatchUpStatusPresentation}
          />
        }
      />

      <MonitoringFiltersPanel
        timeRange={timeRange}
        customRangeCompactLabel={customRangeCompactLabel}
        autoRefreshMs={autoRefreshMs}
        selectedAccount={selectedAccount}
        selectedProvider={selectedProvider}
        selectedModel={selectedModel}
        selectedChannel={selectedChannel}
        selectedApiKeyHash={selectedApiKeyHash}
        selectedStatus={selectedStatus}
        searchInput={searchInput}
        accountOptions={accountOptions}
        providerOptions={providerOptions}
        modelOptions={modelOptions}
        channelOptions={channelOptions}
        apiKeyOptions={apiKeyOptions}
        statusOptions={statusOptions}
        combinedError={combinedError}
        staleDataNotice={staleDataNotice}
        usageStatisticsEnabled={Boolean(config?.usageStatisticsEnabled)}
        overallLoading={overallLoading}
        t={t}
        onTimeRangeChange={handleTimeRangeChange}
        onAutoRefreshChange={setAutoRefreshMs}
        onRefreshAll={refreshAll}
        onAccountFilterChange={handleAccountFilterChange}
        onProviderChange={setSelectedProvider}
        onModelChange={setSelectedModel}
        onChannelChange={setSelectedChannel}
        onApiKeyChange={setSelectedApiKeyHash}
        onStatusChange={(value) => setSelectedStatus(value as StatusFilter)}
        onSearchChange={setSearchInput}
        onClearFilters={clearFilters}
      />

      <UsageCoverageWarning coverage={monitoringCoverage} t={t} />

      <MonitoringSummarySection
        primaryCards={primarySummaryCards}
        secondaryCards={secondarySummaryCards}
        scopeText={monitoringSummaryScopeText}
        updating={kpiUpdating}
        firstLoad={kpiFirstLoad}
      />

      <MonitoringDataPanel
        tabs={dataTabs}
        activeTab={activeDataTab}
        onTabChange={handleDataTabChange}
        ariaLabel={t('monitoring.data_tabs_aria_label')}
        actions={dataPanelActions}
        renderContent={(tab) => {
          if (tab === 'accounts') {
            return (
              <AccountOverviewPanel
                embedded
                mode={accountOverviewMode}
                accountDisplayMode={accountDisplayMode}
                searchInput={searchInput}
                columns={accountOverviewColumns}
                rows={sortedAccountRows}
                pagination={accountPagination}
                accountSort={accountSort}
                accountSortOptions={accountSortOptions}
                expandedAccounts={expandedAccounts}
                focusedAccountId={focusedAccountId}
                accountAuthStateByRowId={accountAuthStateByRowId}
                accountStatusDataByRowId={accountStatusDataByRowId}
                emptyAccountStatusData={emptyAccountStatusData}
                accountQuotaStatesByRowId={accountQuotaStatesByRowIdWithObservedHeaders}
                accountPageSize={accountPageSize}
                accountPageSizeOptions={accountPageSizeOptions}
                accountOverviewScopeText={accountOverviewScopeText}
                hasPrices={hasPrices}
                overallLoading={overallLoading}
                locale={i18n.language}
                emptyState={renderMonitoringEmptyState()}
                t={t}
                onSearchChange={setSearchInput}
                onRefreshAll={refreshAll}
                onAccountSortKeyChange={handleAccountSortKeyChange}
                onModeChange={setAccountOverviewMode}
                onAccountDisplayModeChange={setAccountDisplayMode}
                onAccountSort={handleAccountSort}
                onLoadAccountQuota={loadAccountQuota}
                onToggleExpanded={toggleAccountExpanded}
                onFocusAccount={focusAccount}
                onPageChange={handleAccountPageChange}
                onPageSizeChange={handleAccountPageSizeChange}
              />
            );
          }

          if (tab === 'apiKeys') {
            return (
              <ApiKeySummaryPanel
                embedded
                rows={apiKeyRows}
                columns={apiKeyOverviewColumns}
                pagination={apiKeyPagination}
                expandedApiKeys={expandedApiKeys}
                hasPrices={hasPrices}
                locale={i18n.language}
                pageSize={apiKeyPageSize}
                pageSizeOptions={ACCOUNT_OVERVIEW_TABLE_PAGE_SIZE_OPTIONS}
                emptyState={renderMonitoringEmptyState()}
                t={t}
                onToggleApiKey={toggleApiKeyExpanded}
                onPageChange={handleApiKeyPageChange}
                onPageSizeChange={handleApiKeyPageSizeChange}
              />
            );
          }

          return (
            <RealtimeEventsPanel
              embedded
              rows={realtimeLogRows}
              pagination={realtimePagination}
              pageSize={realtimePageSize}
              scopedFailureCount={scopedFailureCount}
              failedOnlyActive={failedOnlyActive}
              lowCacheHitRateOnly={realtimeLowCacheHitRateOnly}
              lowCacheHitRateThreshold={realtimeLowCacheHitRateThreshold}
              eventsHasMore={eventsHasMore}
              eventsLoadingMore={eventsLoadingMore}
              eventsRetentionLimited={eventsRetentionLimited}
              eventsTotalCount={eventsTotalCount}
              eventsLoadedCount={eventsLoadedCount}
              overallLoading={overallLoading}
              hasPrices={hasPrices}
              accountDisplayMode={accountDisplayMode}
              locale={i18n.language}
              emptyState={renderMonitoringEmptyState()}
              t={t}
              onToggleFailedOnly={toggleFailedOnly}
              onToggleLowCacheHitRateOnly={toggleRealtimeLowCacheHitRateOnly}
              onLowCacheHitRateThresholdChange={changeRealtimeLowCacheHitRateThreshold}
              onAccountDisplayModeChange={setAccountDisplayMode}
              onPageChange={setRealtimePage}
              onPageSizeChange={handleRealtimePageSizeChange}
              onLoadMoreEvents={loadMoreEvents}
            />
          );
        }}
      />

      <MonitoringCustomRangeModal
        open={isCustomRangeModalOpen}
        onClose={() => setIsCustomRangeModalOpen(false)}
        startInput={customDraftStartInput}
        endInput={customDraftEndInput}
        error={customDraftTimeRangeError}
        t={t}
        onApply={applyCustomTimeRange}
        onStartChange={handleCustomDraftStartChange}
        onEndChange={handleCustomDraftEndChange}
        onApplyHours={applyHoursTimeRange}
        onApplyDays={applyDaysTimeRange}
      />

      <UsageImportProgressModal
        open={Boolean(usageImportTask)}
        progress={usageImportTask?.progress ?? null}
        busy={usageImportCancelling}
        onPause={handleUsageImportPause}
        onResume={handleUsageImportResume}
        onCancel={() => void handleUsageImportCancel()}
        onClose={handleUsageImportModalClose}
      />
    </div>
  );
}
