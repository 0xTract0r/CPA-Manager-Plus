/**
 * Quota management page - coordinates the three quota sections.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { usePanelFeatureAvailability } from '@/hooks/usePanelFeatureAvailability';
import { useAuthStore } from '@/stores';
import { authFilesApi, configFileApi } from '@/services/api';
import {
  quotaSnapshotsApi,
  parseCoreQuotaTimestamp,
  type CoreQuotaRefreshPolicy,
  type CoreQuotaSnapshotsResponse,
} from '@/services/api/quotaSnapshots';
import {
  monitoringAnalyticsApi,
  type UsageHeaderSnapshot,
} from '@/services/api/usageService';
import { buildUsageHeaderSnapshotLookup } from '@/utils/usageHeaderSnapshots';
import { buildCoreQuotaSnapshotLookup } from '@/utils/quota/coreQuotaSnapshots';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { IconSearch, IconRefreshCw } from '@/components/ui/icons';
import {
  QuotaSection,
  ANTIGRAVITY_CONFIG,
  CLAUDE_CONFIG,
  CODEX_CONFIG,
  GEMINI_CLI_CONFIG,
  KIMI_CONFIG,
  XAI_CONFIG
} from '@/components/quota';
import { CodexReauthDialog } from '@/features/oauth/CodexReauthDialog';
import {
  createCodexReauthTargetFromAuthFile,
  type CodexReauthTarget,
} from '@/features/oauth/codexReauthModel';
import type { QuotaSortMode } from '@/components/quota/quotaConfigs';
import type { AuthFileItem } from '@/types';
import { formatInUtc8 } from '@/utils/format';
import {
  DEFAULT_QUOTA_ACCOUNT_DISPLAY_MODE,
  readQuotaPageUiState,
  writeQuotaPageUiState,
  type QuotaSectionType,
  type QuotaSectionViewMode,
  type QuotaAccountDisplayMode,
} from './quotaPageUiState';
import styles from './QuotaPage.module.scss';

// ---- 核心定时刷新状态面板：字段兼容层（从旧版 apps/web QuotaPage 移植） ----
// core 的刷新策略字段历史上有 seconds / minutes 两种命名，需要做兼容归一化。

type NormalizedQuotaRefreshPolicy = {
  returned: boolean;
  enabled?: boolean;
  intervalMinutes?: number;
  jitterMinutes?: number;
  startupCatchUp?: boolean;
  startupMaxStalenessMinutes?: number;
};

const readPolicyNumber = (
  policy: CoreQuotaRefreshPolicy | null,
  key: keyof CoreQuotaRefreshPolicy
): number | undefined => {
  const value = policy?.[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};

const secondsToDisplayMinutes = (seconds: number): number => {
  const minutes = seconds / 60;
  return Number.isInteger(minutes) ? minutes : Number(minutes.toFixed(2));
};

const readPolicyMinutes = (
  policy: CoreQuotaRefreshPolicy | null,
  secondsKey: keyof CoreQuotaRefreshPolicy,
  legacyMinutesKey: keyof CoreQuotaRefreshPolicy
): number | undefined => {
  const seconds = readPolicyNumber(policy, secondsKey);
  if (seconds !== undefined) return secondsToDisplayMinutes(seconds);
  return readPolicyNumber(policy, legacyMinutesKey);
};

const normalizeQuotaRefreshPolicy = (
  response: CoreQuotaSnapshotsResponse | null
): NormalizedQuotaRefreshPolicy => {
  const policy = response?.policy ?? response?.refresh_policy ?? null;
  if (!policy) return { returned: false };

  return {
    returned: true,
    enabled: typeof policy.enabled === 'boolean' ? policy.enabled : undefined,
    intervalMinutes: readPolicyMinutes(policy, 'interval_seconds', 'interval_minutes'),
    jitterMinutes: readPolicyMinutes(policy, 'jitter_seconds', 'jitter_minutes'),
    startupCatchUp:
      typeof policy.startup_catch_up === 'boolean' ? policy.startup_catch_up : undefined,
    startupMaxStalenessMinutes: readPolicyMinutes(
      policy,
      'startup_max_staleness_seconds',
      'startup_max_staleness_minutes'
    ),
  };
};

const pickQuotaTimestamp = (
  response: CoreQuotaSnapshotsResponse | null,
  field: 'last_refreshed_at' | 'next_refresh_at',
  mode: 'latest' | 'earliest'
): Date | null => {
  const topLevel = parseCoreQuotaTimestamp(response?.[field]);
  if (topLevel) return topLevel;
  const now = Date.now();

  const dates =
    response?.entries
      ?.filter((entry) => entry.disabled !== true)
      ?.map((entry) => parseCoreQuotaTimestamp(entry[field]))
      .filter((date): date is Date => Boolean(date))
      .filter((date) => field !== 'next_refresh_at' || date.getTime() > now) ?? [];

  if (dates.length === 0) return null;
  return dates.reduce((selected, date) =>
    mode === 'latest'
      ? date.getTime() > selected.getTime()
        ? date
        : selected
      : date.getTime() < selected.getTime()
        ? date
        : selected
  );
};

const formatRefreshTime = (value: Date | null) => {
  if (!value) return '';
  // 展示一律 UTC+8（Asia/Shanghai），不跟随浏览器本地时区。
  return formatInUtc8(value, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    withZoneLabel: true,
  });
};

export function QuotaPage() {
  const { t } = useTranslation();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const managementKey = useAuthStore((state) => state.managementKey);
  const featureAvailability = usePanelFeatureAvailability();
  const managerServiceBase = featureAvailability.managerServiceBase;
  const initialUiState = useRef(readQuotaPageUiState());

  const [files, setFiles] = useState<AuthFileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchQuery, setSearchQuery] = useState(() => initialUiState.current.searchQuery);
  const [sortMode, setSortMode] = useState<QuotaSortMode>(() => initialUiState.current.sortMode);
  const [sectionViewModes, setSectionViewModes] = useState(() => ({
    ...initialUiState.current.sectionViewModes,
  }));
  const [codexReauthTarget, setCodexReauthTarget] = useState<CodexReauthTarget | null>(null);
  const [headerSnapshots, setHeaderSnapshots] = useState<UsageHeaderSnapshot[]>([]);
  const [accountDisplayModes, setAccountDisplayModes] = useState(() => ({
    ...initialUiState.current.accountDisplayModes,
  }));
  const [quotaSnapshotStatus, setQuotaSnapshotStatus] = useState<CoreQuotaSnapshotsResponse | null>(
    null
  );
  const [pageRefreshInFlight, setPageRefreshInFlight] = useState(false);
  const pageRefreshInFlightRef = useRef(false);

  const disableControls = connectionStatus !== 'connected';
  const quotaRefreshPolicy = useMemo(
    () => normalizeQuotaRefreshPolicy(quotaSnapshotStatus),
    [quotaSnapshotStatus]
  );
  const quotaLastRefreshedAt = useMemo(
    () => pickQuotaTimestamp(quotaSnapshotStatus, 'last_refreshed_at', 'latest'),
    [quotaSnapshotStatus]
  );
  const quotaNextRefreshAt = useMemo(
    () => pickQuotaTimestamp(quotaSnapshotStatus, 'next_refresh_at', 'earliest'),
    [quotaSnapshotStatus]
  );

  const formatMinutes = useCallback(
    (minutes: number | undefined) => {
      if (minutes === undefined) return t('quota_management.auto_refresh_default_policy');
      if (minutes === 1) return t('quota_management.auto_refresh_one_minute');
      if (minutes >= 60 && Number.isInteger(minutes / 60)) {
        return t('quota_management.auto_refresh_hours_with_minutes', {
          hours: minutes / 60,
          minutes,
        });
      }
      return t('quota_management.auto_refresh_minutes', { minutes });
    },
    [t]
  );

  const autoRefreshRows = useMemo(
    () => [
      {
        testId: 'quota-auto-refresh-policy',
        label: t('quota_management.auto_refresh_policy_label'),
        value: !quotaRefreshPolicy.returned
          ? t('quota_management.auto_refresh_policy_missing')
          : quotaRefreshPolicy.enabled === undefined
            ? t('quota_management.auto_refresh_default_policy')
            : quotaRefreshPolicy.enabled
              ? t('quota_management.auto_refresh_policy_enabled')
              : t('quota_management.auto_refresh_policy_disabled'),
      },
      {
        testId: 'quota-auto-refresh-interval',
        label: t('quota_management.auto_refresh_interval_label'),
        value: formatMinutes(quotaRefreshPolicy.intervalMinutes),
      },
      {
        testId: 'quota-auto-refresh-jitter',
        label: t('quota_management.auto_refresh_jitter_label'),
        value:
          quotaRefreshPolicy.jitterMinutes === undefined
            ? t('quota_management.auto_refresh_default_policy')
            : t('quota_management.auto_refresh_jitter_duration', {
                duration: formatMinutes(quotaRefreshPolicy.jitterMinutes),
              }),
      },
      {
        testId: 'quota-auto-refresh-startup',
        label: t('quota_management.auto_refresh_startup_label'),
        value:
          quotaRefreshPolicy.startupCatchUp === undefined
            ? t('quota_management.auto_refresh_default_policy')
            : quotaRefreshPolicy.startupCatchUp
              ? t('quota_management.auto_refresh_startup_enabled')
              : t('quota_management.auto_refresh_startup_disabled'),
      },
      {
        testId: 'quota-auto-refresh-startup-max-staleness',
        label: t('quota_management.auto_refresh_startup_max_staleness_label'),
        value: formatMinutes(quotaRefreshPolicy.startupMaxStalenessMinutes),
      },
      {
        testId: 'quota-auto-refresh-last',
        label: t('quota_management.auto_refresh_last_label'),
        value: quotaLastRefreshedAt
          ? formatRefreshTime(quotaLastRefreshedAt)
          : t('quota_management.auto_refresh_not_refreshed'),
      },
      {
        testId: 'quota-auto-refresh-next',
        label: t('quota_management.auto_refresh_next_label'),
        value: quotaNextRefreshAt
          ? formatRefreshTime(quotaNextRefreshAt)
          : t('quota_management.auto_refresh_waiting_schedule'),
      },
    ],
    [formatMinutes, quotaLastRefreshedAt, quotaNextRefreshAt, quotaRefreshPolicy, t]
  );
  const sortOptions = useMemo(
    () => [
      { value: 'default', label: t('quota_management.sort_default') },
      { value: 'name-asc', label: t('quota_management.sort_name_asc') },
      { value: 'plan-desc', label: t('quota_management.sort_plan_desc') },
      { value: 'plan-asc', label: t('quota_management.sort_plan_asc') }
    ],
    [t]
  );

  const loadConfig = useCallback(async () => {
    try {
      await configFileApi.fetchConfigYaml();
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : t('notification.refresh_failed');
      setError((prev) => prev || errorMessage);
    }
  }, [t]);

  const loadFiles = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await authFilesApi.list();
      setFiles(data?.files || []);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : t('notification.refresh_failed');
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  }, [t]);

  const loadHeaderSnapshots = useCallback(async () => {
    if (!managerServiceBase) {
      setHeaderSnapshots([]);
      return;
    }
    try {
      const response = await monitoringAnalyticsApi.getHeaderSnapshots(managerServiceBase, managementKey, {
        days: 30,
        limit: 1000,
      });
      setHeaderSnapshots(response.items ?? []);
    } catch {
      setHeaderSnapshots((current) => current);
    }
  }, [managementKey, managerServiceBase]);

  const loadQuotaSnapshotStatus = useCallback(async () => {
    try {
      const data = await quotaSnapshotsApi.getSnapshots();
      setQuotaSnapshotStatus(data);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : t('notification.refresh_failed');
      setError((prev) => prev || errorMessage);
    }
  }, [t]);

  const handleHeaderRefresh = useCallback(async () => {
    await Promise.all([loadConfig(), loadFiles(), loadHeaderSnapshots(), loadQuotaSnapshotStatus()]);
  }, [loadConfig, loadFiles, loadHeaderSnapshots, loadQuotaSnapshotStatus]);

  useHeaderRefresh(handleHeaderRefresh);

  const refreshPageQuota = useCallback(async () => {
    if (disableControls || pageRefreshInFlightRef.current) return;

    pageRefreshInFlightRef.current = true;
    setPageRefreshInFlight(true);
    setError('');
    try {
      const [, , refreshedStatus] = await Promise.all([
        loadConfig(),
        loadFiles(),
        quotaSnapshotsApi.refresh({}),
      ]);
      setQuotaSnapshotStatus(refreshedStatus);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : t('notification.refresh_failed');
      setError(errorMessage);
    } finally {
      pageRefreshInFlightRef.current = false;
      setPageRefreshInFlight(false);
    }
  }, [disableControls, loadConfig, loadFiles, t]);

  useEffect(() => {
    loadFiles();
    loadConfig();
    loadHeaderSnapshots();
    loadQuotaSnapshotStatus();
  }, [loadFiles, loadConfig, loadHeaderSnapshots, loadQuotaSnapshotStatus]);

  const headerSnapshotLookup = useMemo(
    () => buildUsageHeaderSnapshotLookup(headerSnapshots),
    [headerSnapshots]
  );

  // core `GET /quota/snapshots` 只读持久快照的多键 lookup（auth_id/auth_index/name）。
  // 直接复用顶部自动刷新面板已经拉取的 quotaSnapshotStatus.entries，把额度与
  // reauth_required / error 状态在 mount 时下发给 codex/claude 卡片；全程只读 core
  // 已持久化的快照，绝不在进入页面时触发任何真实上游请求（反关联风控红线）。
  const coreQuotaSnapshotLookup = useMemo(
    () => buildCoreQuotaSnapshotLookup(quotaSnapshotStatus?.entries ?? []),
    [quotaSnapshotStatus]
  );

  useEffect(() => {
    writeQuotaPageUiState({
      searchQuery,
      sortMode,
      sectionViewModes,
      accountDisplayModes,
    });
  }, [accountDisplayModes, searchQuery, sectionViewModes, sortMode]);

  const getSectionViewMode = useCallback(
    (sectionType: QuotaSectionType): QuotaSectionViewMode =>
      sectionViewModes[sectionType] ?? 'paged',
    [sectionViewModes]
  );

  const setSectionViewMode = useCallback(
    (sectionType: QuotaSectionType, viewMode: QuotaSectionViewMode) => {
      setSectionViewModes((current) => ({
        ...current,
        [sectionType]: viewMode,
      }));
    },
    []
  );

  const handleCodexReauthSuccess = useCallback(async () => {
    await loadFiles();
  }, [loadFiles]);

  const getAccountDisplayMode = useCallback(
    (sectionType: QuotaSectionType): QuotaAccountDisplayMode =>
      accountDisplayModes[sectionType] ?? DEFAULT_QUOTA_ACCOUNT_DISPLAY_MODE,
    [accountDisplayModes]
  );

  const setAccountDisplayMode = useCallback(
    (sectionType: QuotaSectionType, mode: QuotaAccountDisplayMode) => {
      setAccountDisplayModes((current) => ({
        ...current,
        [sectionType]: mode,
      }));
    },
    []
  );

  return (
    <div className={styles.container}>
      <div className={styles.autoRefreshPanel} data-testid="quota-auto-refresh-panel">
        <div className={styles.autoRefreshText}>
          <div className={styles.autoRefreshTitle}>{t('quota_management.auto_refresh_title')}</div>
          <div className={styles.autoRefreshStatus} data-testid="quota-auto-refresh-status">
            {t('quota_management.auto_refresh_status_hint')}
          </div>
          <div className={styles.autoRefreshMetaGrid}>
            {autoRefreshRows.map((row) => (
              <div key={row.testId} className={styles.autoRefreshMetaItem} data-testid={row.testId}>
                <span className={styles.autoRefreshMetaLabel}>{row.label}</span>
                <span className={styles.autoRefreshMetaValue}>{row.value}</span>
              </div>
            ))}
          </div>
        </div>
        <div className={styles.autoRefreshControls}>
          <Link
            data-testid="quota-auto-refresh-config-link"
            className={styles.autoRefreshButton}
            to="/config"
          >
            {t('quota_management.auto_refresh_configure')}
          </Link>
          <Button
            data-testid="quota-refresh-now"
            className={styles.autoRefreshButton}
            variant="secondary"
            size="sm"
            type="button"
            disabled={disableControls || pageRefreshInFlight}
            loading={pageRefreshInFlight}
            onClick={() => void refreshPageQuota()}
          >
            {!pageRefreshInFlight && <IconRefreshCw size={16} />}
            {pageRefreshInFlight
              ? t('quota_management.auto_refresh_running')
              : t('quota_management.refresh_now')}
          </Button>
        </div>
      </div>

      {error && <div className={styles.errorBox}>{error}</div>}

      <div className={styles.toolbar}>
        <div className={styles.toolbarField}>
          <Input
            label={t('quota_management.search_label')}
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={t('quota_management.search_placeholder')}
            rightElement={<IconSearch size={16} />}
            aria-label={t('quota_management.search_label')}
          />
        </div>
        <div className={`${styles.toolbarField} ${styles.sortField}`}>
          <label htmlFor="quota-sort-mode" className={styles.toolbarLabel}>
            {t('quota_management.sort_label')}
          </label>
          <Select
            id="quota-sort-mode"
            value={sortMode}
            options={sortOptions}
            onChange={(value) => setSortMode(value as QuotaSortMode)}
            ariaLabel={t('quota_management.sort_label')}
            fullWidth
          />
        </div>
      </div>

      <QuotaSection
        config={CODEX_CONFIG}
        files={files}
        loading={loading}
        disabled={disableControls}
        searchQuery={searchQuery}
        sortMode={sortMode}
        viewMode={getSectionViewMode(CODEX_CONFIG.type)}
        onViewModeChange={(viewMode) => setSectionViewMode(CODEX_CONFIG.type, viewMode)}
        onReauthAccount={(file) => setCodexReauthTarget(createCodexReauthTargetFromAuthFile(file))}
        accountDisplayMode={getAccountDisplayMode(CODEX_CONFIG.type)}
        onAccountDisplayModeChange={(mode) => setAccountDisplayMode(CODEX_CONFIG.type, mode)}
        headerSnapshotLookup={headerSnapshotLookup}
        coreQuotaSnapshotLookup={coreQuotaSnapshotLookup}
      />
      <QuotaSection
        config={CLAUDE_CONFIG}
        files={files}
        loading={loading}
        disabled={disableControls}
        searchQuery={searchQuery}
        sortMode={sortMode}
        viewMode={getSectionViewMode(CLAUDE_CONFIG.type)}
        onViewModeChange={(viewMode) => setSectionViewMode(CLAUDE_CONFIG.type, viewMode)}
        accountDisplayMode={getAccountDisplayMode(CLAUDE_CONFIG.type)}
        onAccountDisplayModeChange={(mode) => setAccountDisplayMode(CLAUDE_CONFIG.type, mode)}
        coreQuotaSnapshotLookup={coreQuotaSnapshotLookup}
      />
      <QuotaSection
        config={ANTIGRAVITY_CONFIG}
        files={files}
        loading={loading}
        disabled={disableControls}
        searchQuery={searchQuery}
        sortMode={sortMode}
        viewMode={getSectionViewMode(ANTIGRAVITY_CONFIG.type)}
        onViewModeChange={(viewMode) => setSectionViewMode(ANTIGRAVITY_CONFIG.type, viewMode)}
        accountDisplayMode={getAccountDisplayMode(ANTIGRAVITY_CONFIG.type)}
        onAccountDisplayModeChange={(mode) =>
          setAccountDisplayMode(ANTIGRAVITY_CONFIG.type, mode)
        }
      />
      <QuotaSection
        config={GEMINI_CLI_CONFIG}
        files={files}
        loading={loading}
        disabled={disableControls}
        searchQuery={searchQuery}
        sortMode={sortMode}
        viewMode={getSectionViewMode(GEMINI_CLI_CONFIG.type)}
        onViewModeChange={(viewMode) => setSectionViewMode(GEMINI_CLI_CONFIG.type, viewMode)}
        accountDisplayMode={getAccountDisplayMode(GEMINI_CLI_CONFIG.type)}
        onAccountDisplayModeChange={(mode) =>
          setAccountDisplayMode(GEMINI_CLI_CONFIG.type, mode)
        }
      />
      <QuotaSection
        config={KIMI_CONFIG}
        files={files}
        loading={loading}
        disabled={disableControls}
        searchQuery={searchQuery}
        sortMode={sortMode}
        viewMode={getSectionViewMode(KIMI_CONFIG.type)}
        onViewModeChange={(viewMode) => setSectionViewMode(KIMI_CONFIG.type, viewMode)}
        accountDisplayMode={getAccountDisplayMode(KIMI_CONFIG.type)}
        onAccountDisplayModeChange={(mode) => setAccountDisplayMode(KIMI_CONFIG.type, mode)}
      />
      <QuotaSection
        config={XAI_CONFIG}
        files={files}
        loading={loading}
        disabled={disableControls}
        searchQuery={searchQuery}
        sortMode={sortMode}
        viewMode={getSectionViewMode(XAI_CONFIG.type)}
        onViewModeChange={(viewMode) => setSectionViewMode(XAI_CONFIG.type, viewMode)}
        accountDisplayMode={getAccountDisplayMode(XAI_CONFIG.type)}
        onAccountDisplayModeChange={(mode) => setAccountDisplayMode(XAI_CONFIG.type, mode)}
      />

      <CodexReauthDialog
        open={Boolean(codexReauthTarget)}
        target={codexReauthTarget}
        onClose={() => setCodexReauthTarget(null)}
        onSuccess={handleCodexReauthSuccess}
      />
    </div>
  );
}
