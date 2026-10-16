import { useState, type ReactNode, type ReactElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LogsPage } from './logs/LogsPage';
import { PluginsPage } from './plugins/PluginsPage';
import { PluginResourcePage } from './plugins/PluginResourcePage';
import { SystemPage } from './system/SystemPage';
import { DashboardPage } from './dashboard/DashboardPage';
import { AccountActionCandidatesPage } from './monitoring/AccountActionCandidatesPage';
import { DatabaseStatusCard } from './system/components/DatabaseStatusCard';
import { VersionCard } from './dashboard/components/VersionCard';
import { AccountProcessingPolicySection } from './config/components/AccountProcessingPolicySection';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import type { PluginListResponse } from '@/types';

const mocks = vi.hoisted(() => ({
  auth: {
    apiBase: 'https://a.test',
    managementKey: 'a',
    connectionStatus: 'connected',
    supportsPlugin: true,
  },
  managerBase: 'https://manager.test',
  params: new URLSearchParams(),
  t: (key: string, options?: { returnObjects?: boolean }) => options?.returnObjects ? [] : key,
  headerRefresh: undefined as undefined | (() => Promise<unknown>),
  plugins: vi.fn(),
  pluginStore: vi.fn(),
  updatePlugin: vi.fn(),
  logs: vi.fn(),
  errorLogs: vi.fn(),
  status: vi.fn(),
  candidates: vi.fn(),
  ignoreCandidate: vi.fn(),
  clearLogs: vi.fn(),
  confirmation: vi.fn(),
  keys: vi.fn(),
  files: vi.fn(),
  providers: vi.fn(),
  noop: vi.fn(),
  fetchModels: vi.fn(),
  fetchConfig: vi.fn(),
  models: { models: [{ name: 'gpt-retained' }], loading: false, error: null },
  config: { loggingToFile: true, requestLog: true, apiKeys: ['key'] },
  scrollNode: { scrollTop: 10, scrollHeight: 1000, clientHeight: 100 },
  requestScroll: vi.fn(),
  policy: vi.fn(), updatePolicy: vi.fn(),
}));
vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({ t: mocks.t, i18n: { language: 'en' } }),
}));
vi.mock('react-router-dom', () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  useNavigate: () => mocks.noop,
  useSearchParams: () => [mocks.params, mocks.noop],
  useParams: () => ({ pluginId: 'retained-plugin', menuIndex: '0' }),
}));
vi.mock('@/stores', () => ({
  useAuthStore: (selector?: (s: typeof mocks.auth) => unknown) =>
    selector ? selector(mocks.auth) : mocks.auth,
  useThemeStore: (selector: (s: object) => unknown) => selector({ resolvedTheme: 'light' }),
  useConfigStore: (selector: (s: object) => unknown) =>
    selector({ config: mocks.config, fetchConfig: mocks.fetchConfig, clearCache: mocks.noop }),
  useNotificationStore: (selector?: (s: object) => unknown) => {
    const state = { showNotification: mocks.noop, showConfirmation: mocks.confirmation };
    return selector ? selector(state) : state;
  },
  useModelsStore: (selector: (s: object) => unknown) =>
    selector({ ...mocks.models, fetchModels: mocks.fetchModels }),
}));
vi.mock('@/hooks/useHeaderRefresh', () => ({
  useHeaderRefresh: (refresh: () => Promise<unknown>) => {
    mocks.headerRefresh = refresh;
  },
}));
vi.mock('@/hooks/useLocalStorage', () => ({
  useLocalStorage: (_key: string, initial: unknown) => useState(initial),
}));
vi.mock('@/hooks/usePanelFeatureAvailability', () => ({
  usePanelFeatureAvailability: () => ({
    checking: false,
    managerServiceAvailable: true,
    managerServiceBase: mocks.managerBase,
  }),
}));
vi.mock('@/hooks/useRequestMonitoringAvailability', () => ({
  useRequestMonitoringAvailability: () => ({
    checking: false,
    available: true,
    serviceBase: mocks.managerBase,
  }),
}));
vi.mock('@/services/api', () => ({
  pluginsApi: { list: mocks.plugins, updateEnabled: mocks.updatePlugin },
  pluginStoreApi: { list: mocks.pluginStore },
  apiKeysApi: { list: mocks.keys },
  authFilesApi: { list: mocks.files },
  providersApi: {
    getGeminiKeys: mocks.providers,
    getCodexConfigs: mocks.providers,
    getXAIConfigs: mocks.providers,
    getClaudeConfigs: mocks.providers,
    getOpenAIProviders: mocks.providers,
  },
}));
vi.mock('@/services/api/apiKeys', () => ({ apiKeysApi: { list: mocks.keys } }));
vi.mock('@/services/api/logs', () => ({
  logsApi: { fetchLogs: mocks.logs, fetchErrorLogs: mocks.errorLogs, clearLogs: mocks.clearLogs },
}));
vi.mock('@/services/api/usageService', () => ({
  usageServiceApi: {
    getStatus: mocks.status,
    listAccountActionCandidates: mocks.candidates,
    ignoreAccountActionCandidate: mocks.ignoreCandidate,
    getManagerConfig: async () => ({ config: {} }),
    getApiKeyAliases: async () => ({ items: [] }),
    getAccountProcessingPolicy: mocks.policy, updateAccountProcessingPolicy: mocks.updatePolicy,
  },
}));
vi.mock('./monitoring/services/monitoringMetaService', () => ({
  loadMonitoringMetaPayload: async () => ({ authFiles: [], channels: [] }),
}));
vi.mock('./dashboard/hooks/useDashboardUsageSummary', () => ({
  useDashboardUsageSummary: () => ({
    enabled: true,
    loading: false,
    summary: null,
    recentFailures: [],
    topModels: [],
    modelCostRank: [],
    trafficTimeline: [],
    hourlyActivity: [],
    tokenMix: [],
    channelHealth: [],
    failureSources: [],
    serviceBase: mocks.managerBase,
    refresh: mocks.noop,
  }),
}));
vi.mock('./system/ManagerUpdates', () => ({ useManagerUpdates: () => ({ available: false }) }));
vi.mock('./system/components/DatabaseStatusCard', () => ({
  DatabaseStatusCard: ({ status, error }: { status: unknown; error: string }) => (
    <section>
      {JSON.stringify(status)}
      {error}
    </section>
  ),
}));
vi.mock('./dashboard/components/VersionCard', () => ({
  VersionCard: ({
    collectorStatus,
    errorLogCount,
    collectorError,
  }: {
    collectorStatus: unknown;
    errorLogCount: number;
    collectorError: string;
  }) => (
    <section>
      {JSON.stringify(collectorStatus)}
      {errorLogCount}
      {collectorError}
    </section>
  ),
}));
vi.mock('./dashboard/components/UsageMetricsCard', () => ({ UsageMetricsCard: () => null }));
vi.mock('./dashboard/components/CollectorStatusCard', () => ({ CollectorStatusCard: () => null }));
vi.mock('./dashboard/components/HealthAlertsCard', () => ({ HealthAlertsCard: () => null }));
vi.mock('./dashboard/components/TrafficOverviewCard', () => ({ TrafficOverviewCard: () => null }));
vi.mock('./plugins/PluginStorePage', () => ({ PluginStorePage: () => null }));
vi.mock('./plugins/pluginHostStyle', () => ({ createPluginHostStyleBridge: () => null }));
vi.mock('./logs/hooks/useLogScroller', () => ({
  isNearBottom: (node: typeof mocks.scrollNode) =>
    !node || node.scrollHeight - node.scrollTop - node.clientHeight < 24,
  useLogScroller: () => ({
    logViewerRef: { current: mocks.scrollNode },
    canLoadMore: false,
    handleLogScroll: mocks.noop,
    requestScrollToBottom: mocks.requestScroll,
    scrollToBottom: mocks.noop,
  }),
}));
vi.mock('@/components/ui/Modal', () => ({ Modal: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const text = (node: ReactTestInstance): string =>
  node.children.map((c) => (typeof c === 'string' ? c : text(c))).join('');
let renderer: ReactTestRenderer;
const mount = async (element: ReactElement) => {
  await act(async () => {
    renderer = create(element);
  });
};
const refresh = () => mocks.headerRefresh!();
beforeEach(() => {
  vi.stubGlobal('window', {
    setInterval,
    clearInterval,
    addEventListener: mocks.noop,
    removeEventListener: mocks.noop,
    location: { search: '' },
  });
  mocks.auth.managementKey = 'a';
  mocks.managerBase = 'https://manager.test';
  mocks.params = new URLSearchParams();
  mocks.models.loading = false;
  mocks.requestScroll.mockClear();
  mocks.fetchModels.mockResolvedValue(mocks.models.models);
  mocks.fetchConfig.mockResolvedValue({});
  mocks.plugins.mockReset();
  mocks.updatePlugin.mockResolvedValue(undefined);
  mocks.logs.mockReset();
  mocks.errorLogs.mockReset();
  mocks.status.mockReset();
  mocks.candidates.mockReset();
  mocks.confirmation.mockReset();
  mocks.clearLogs.mockResolvedValue(undefined);
  mocks.ignoreCandidate.mockReset();
  mocks.keys.mockResolvedValue(['key']);
  mocks.files.mockResolvedValue({ files: [] });
  mocks.providers.mockResolvedValue([{}]);
  mocks.status.mockResolvedValue({ collector: { enabled: true }, marker: 'last-good' });
  mocks.errorLogs.mockResolvedValue({ files: [{ name: 'error-retained.log' }] });
});
afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

const pluginData: PluginListResponse = {
  pluginsEnabled: true,
  pluginsDir: 'plugins',
  plugins: [
    {
      id: 'retained-plugin',
      path: 'plugins/retained.so',
      configured: true,
      registered: true,
      enabled: true,
      effectiveEnabled: true,
      supportsOAuth: false,
      logo: '',
      configFields: [],
      metadata: { name: 'Retained Plugin', version: '1.0', author: 'test', configFields: [], githubRepository: 'test/plugin', logo: '' },
      menus: [{ menu: 'Resource', path: '/v0/resource/plugins/retained/page', description: '' }],
    },
  ],
};

describe('page refresh interactions', () => {
  it('keeps store results on failure and only accepts the latest overlapping refresh', async () => {
    const { PluginStorePage } = await vi.importActual<typeof import('./plugins/PluginStorePage')>('./plugins/PluginStorePage');
    const data = { plugins: [], sources: [], sourceErrors: [], pluginsEnabled: true, pluginsDir: 'plugins' };
    mocks.pluginStore.mockResolvedValueOnce(data);
    await mount(<PluginStorePage />);
    const old = deferred<unknown>(), next = deferred<unknown>();
    mocks.pluginStore.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    let first!: Promise<unknown>, second!: Promise<unknown>;
    act(() => { first = refresh(); second = refresh(); });
    await act(async () => { next.reject(new Error('current-offline')); await second; });
    expect(text(renderer.root)).toContain('current-offline');
    await act(async () => { old.reject(new Error('stale-offline')); await first; });
    expect(text(renderer.root)).not.toContain('stale-offline');
    expect(text(renderer.root)).toContain('current-offline');
    expect(text(renderer.root)).toContain('plugin_store.global_enabled');
  });

  it('releases refresh busy state when plugin mutation reconciliation supersedes a read', async () => {
    mocks.plugins.mockResolvedValueOnce(pluginData);
    await mount(<PluginsPage />);
    const old = deferred<PluginListResponse>();
    mocks.plugins.mockReturnValueOnce(old.promise);
    let pending!: Promise<unknown>;
    act(() => { pending = refresh(); });
    mocks.plugins.mockResolvedValueOnce({ ...pluginData, plugins: [{ ...pluginData.plugins[0], enabled: false }] });
    await act(async () => { await renderer.root.findByType(ToggleSwitch).props.onChange(false); });
    expect(renderer.root.findByType(ToggleSwitch).props.checked).toBe(false);
    expect(renderer.root.findAllByType('button').find(n => text(n) === 'plugin_management.refresh')!.props.disabled).toBe(false);
    await act(async () => { old.resolve(pluginData); await pending; });
    expect(renderer.root.findByType(ToggleSwitch).props.checked).toBe(false);
  });

  it('does not resurrect cleared logs when an earlier refresh finishes', async () => {
    mocks.logs.mockResolvedValueOnce({ lines: ['before-clear'] });
    await mount(<LogsPage />);
    const next = deferred<unknown>();
    mocks.logs.mockReturnValueOnce(next.promise);
    let pending!: Promise<unknown>;
    act(() => { pending = refresh(); });
    await act(async () => {
      renderer.root.findAllByType('button').find(n => text(n) === 'logs.clear_button')!.props.onClick();
      await mocks.confirmation.mock.calls[0][0].onConfirm();
    });
    expect(text(renderer.root)).not.toContain('before-clear');
    await act(async () => { next.resolve({ lines: ['stale-cleared-line'] }); await pending; });
    expect(text(renderer.root)).not.toContain('stale-cleared-line');
    expect(mocks.clearLogs).toHaveBeenCalled();
  });

  it('reconciles a completed mutation using the current candidate filter', async () => {
    const candidate = { id: 1, accountSnapshot: 'pending-account', status: 'pending', actionType: 'disable' };
    mocks.candidates.mockResolvedValue({ items: [candidate], pendingCount: 1 });
    await mount(<AccountActionCandidatesPage />);
    const mutation = deferred<unknown>();
    mocks.ignoreCandidate.mockReturnValueOnce(mutation.promise);
    let pending!: Promise<unknown>;
    act(() => { pending = renderer.root.findAllByType('button').find(n => text(n) === 'account_actions.ignore')!.props.onClick(); });
    await act(async () => {
      renderer.root.findAllByType('button').find(n => text(n) === 'account_actions.filter_all')!.props.onClick();
    });
    await act(async () => { mutation.resolve({}); await pending; });
    expect(mocks.candidates.mock.lastCall?.[2]).toBe('');
    expect(text(renderer.root)).toContain('pending-account');
  });

  it('keeps policy controls visible and busy during refresh and isolates a new manager', async () => {
    const capability = { enabled: true, configured: true, source: 'database', locked: false, envKey: 'ENV', configFileKey: 'field' };
    mocks.policy.mockResolvedValueOnce({ codexQuotaCooldown: capability, authIssueQueue: capability, authIssueAutoDisable: capability });
    await mount(<AccountProcessingPolicySection />);
    expect(renderer.root.findAllByType(ToggleSwitch).map(n => n.props.checked)).toEqual([true, true, true]);
    const next = deferred<unknown>(); mocks.policy.mockReturnValueOnce(next.promise);
    const refreshButton = renderer.root.findAllByType('button').find(n => text(n) === 'accountPolicy.refresh')!;
    let pending!: Promise<unknown>; act(() => { pending = refreshButton.props.onClick(); });
    expect(renderer.root.findAllByType(ToggleSwitch).every(n => n.props.disabled)).toBe(true);
    await act(async () => { next.reject(new Error('offline')); await pending; });
    expect(renderer.root.findAllByType(ToggleSwitch).map(n => n.props.checked)).toEqual([true, true, true]);
    expect(text(renderer.root)).toContain('offline');
    mocks.policy.mockReturnValue(new Promise(() => {})); mocks.managerBase = 'https://new-manager.test';
    await act(async () => { renderer.update(<AccountProcessingPolicySection />); });
    expect(renderer.root.findAllByType(ToggleSwitch)).toHaveLength(0);
  });

  it.each(['logs', 'system', 'dashboard', 'candidates'] as const)('rejects a late %s response after a connection switch', async (kind) => {
    const old = deferred<unknown>(), next = deferred<unknown>();
    mocks.logs.mockResolvedValue({ lines: [] }); mocks.candidates.mockResolvedValue({ items: [], pendingCount: 0 });
    const api = kind === 'logs' ? mocks.logs : kind === 'candidates' ? mocks.candidates : mocks.status;
    api.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const element = () => kind === 'logs' ? <LogsPage /> : kind === 'system' ? <SystemPage /> : kind === 'dashboard' ? <DashboardPage /> : <AccountActionCandidatesPage />;
    await mount(element());
    mocks.auth.managementKey = 'b';
    await act(async () => { renderer.update(element()); });
    await act(async () => { old.resolve(kind === 'logs' ? { lines: ['old-scope-secret'] } : kind === 'candidates' ? { items: [{ id: 1, accountSnapshot: 'old-scope-secret' }], pendingCount: 1 } : { marker: 'old-scope-secret' }); });
    expect(text(renderer.root)).not.toContain('old-scope-secret');
    await act(async () => { next.resolve(kind === 'logs' ? { lines: ['new-scope-result'] } : kind === 'candidates' ? { items: [{ id: 2, accountSnapshot: 'new-scope-result' }], pendingCount: 1 } : { marker: 'new-scope-result' }); });
    expect(text(renderer.root)).toContain('new-scope-result');
  });

  it.each(['installed', 'resource'])(
    'keeps the %s plugin mounted through pending/failure and clears it on connection change',
    async (kind) => {
      const element = kind === 'installed' ? <PluginsPage /> : <PluginResourcePage />;
      mocks.plugins.mockResolvedValueOnce(pluginData);
      await mount(element);
      const getNode = () =>
        kind === 'resource'
          ? renderer.root.findByType('iframe')
          : renderer.root.findByProps({ role: 'table' });
      const original = getNode();
      const next = deferred<PluginListResponse>();
      mocks.plugins.mockReturnValueOnce(next.promise);
      let pending!: Promise<unknown>;
      act(() => {
        pending = refresh();
      });
      expect(getNode()).toBe(original);
      await act(async () => {
        next.reject(new Error('offline'));
        await pending;
      });
      expect(getNode()).toBe(original);
      expect(text(renderer.root)).toContain('offline');
      mocks.plugins.mockReturnValueOnce(new Promise(() => {}));
      mocks.auth.managementKey = 'b';
      await act(async () => {
        renderer.update(kind === 'installed' ? <PluginsPage /> : <PluginResourcePage />);
      });
      expect(renderer.root.findAllByType(kind === 'resource' ? 'iframe' : 'table')).toHaveLength(0);
      expect(text(renderer.root)).not.toContain('Retained Plugin');
    }
  );

  it.each(['logs', 'errors'])(
    'keeps existing %s while refreshing, reports failure, and replaces successful data',
    async (tab) => {
      if (tab === 'errors') mocks.params = new URLSearchParams('tab=errors');
      mocks.logs.mockResolvedValue({ lines: ['old-visible-line'], latestAfter: 1 });
      await mount(<LogsPage />);
      const expected = tab === 'logs' ? 'old-visible-line' : 'error-retained.log';
      expect(text(renderer.root)).toContain(expected);
      mocks.requestScroll.mockClear();
      const next = deferred<unknown>();
      const api = tab === 'logs' ? mocks.logs : mocks.errorLogs;
      api.mockReturnValueOnce(next.promise);
      let pending!: Promise<unknown>;
      act(() => {
        pending = refresh();
      });
      expect(text(renderer.root)).toContain(expected);
      if (tab === 'logs') expect(mocks.requestScroll).not.toHaveBeenCalled();
      await act(async () => {
        next.reject(new Error('offline'));
        await pending;
      });
      expect(text(renderer.root)).toContain(expected);
      expect(text(renderer.root)).toContain('offline');
      api.mockResolvedValueOnce(
        tab === 'logs' ? { lines: ['new-visible-line'] } : { files: [{ name: 'new-error.log' }] }
      );
      await act(async () => {
        await refresh();
      });
      expect(text(renderer.root)).toContain(tab === 'logs' ? 'new-visible-line' : 'new-error.log');
    }
  );

  it('retains system models and database status through refresh failure', async () => {
    await mount(<SystemPage />);
    expect(text(renderer.root)).toContain('gpt-retained');
    const originalStatus = renderer.root.findByType(DatabaseStatusCard).props.status;
    const next = deferred<unknown>();
    mocks.status.mockReturnValueOnce(next.promise);
    mocks.models.loading = true;
    await act(async () => {
      renderer.update(<SystemPage />);
    });
    let pending!: Promise<unknown>;
    act(() => {
      pending = refresh();
    });
    expect(text(renderer.root)).toContain('gpt-retained');
    expect(renderer.root.findByType(DatabaseStatusCard).props.status).toBe(originalStatus);
    await act(async () => {
      next.reject(new Error('offline'));
      await pending;
    });
    expect(renderer.root.findByType(DatabaseStatusCard).props.status).toBe(originalStatus);
    expect(renderer.root.findByType(DatabaseStatusCard).props.error).toBe('offline');
  });

  it('retains dashboard counts and operational snapshots when only some endpoints fail', async () => {
    await mount(<DashboardPage />);
    const version = () => renderer.root.findByType(VersionCard);
    const collector = version().props.collectorStatus;
    expect(version().props.errorLogCount).toBe(1);
    const next = deferred<unknown>();
    mocks.status.mockReturnValueOnce(next.promise);
    mocks.providers.mockRejectedValue(new Error('providers offline'));
    mocks.errorLogs.mockRejectedValueOnce(new Error('logs offline'));
    let pending!: Promise<unknown>;
    act(() => {
      pending = refresh();
    });
    expect(version().props.collectorStatus).toBe(collector);
    expect(version().props.errorLogCount).toBe(1);
    await act(async () => {
      next.reject(new Error('collector offline'));
      await pending;
    });
    expect(version().props.collectorStatus).toBe(collector);
    expect(version().props.errorLogCount).toBe(1);
    expect(text(renderer.root)).toContain('notification.refresh_failed');
    const providerLink = renderer.root
      .findAllByType('a')
      .find((n) => text(n).includes('nav.ai_providers'));
    expect(providerLink).toBeDefined();
    expect(text(providerLink!)).toContain('5');
  });

  it('retains candidates after failure and clears them on filter or manager changes', async () => {
    mocks.candidates.mockResolvedValueOnce({
      items: [
        {
          id: 1,
          accountSnapshot: 'retained-account',
          authFileName: 'retained.json',
          provider: 'codex',
          status: 'pending',
          actionType: 'disable',
          reason: 'test',
        },
      ],
      pendingCount: 1,
    });
    await mount(<AccountActionCandidatesPage />);
    const next = deferred<unknown>();
    mocks.candidates.mockReturnValueOnce(next.promise);
    const button = renderer.root.findAllByType('button').find((n) => text(n) === 'common.refresh')!;
    let pending!: Promise<unknown>;
    act(() => {
      pending = button.props.onClick();
    });
    expect(text(renderer.root)).toContain('retained-account');
    await act(async () => {
      next.reject(new Error('offline'));
      await pending;
    });
    expect(text(renderer.root)).toContain('retained-account');
    expect(text(renderer.root)).toContain('offline');
    mocks.candidates.mockReturnValue(new Promise(() => {}));
    act(() => {
      renderer.root
        .findAllByType('button')
        .find((n) => text(n) === 'account_actions.filter_all')!
        .props.onClick();
    });
    expect(text(renderer.root)).not.toContain('retained-account');
  });
});
