import { useEffect } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  MonitoringAnalyticsAccountStatRow,
  MonitoringAnalyticsResponse,
} from '@/services/api/usageService';
import type { MonitoringScopeFilters } from '../model/types';
import type { UseMonitoringAnalyticsParams } from './useMonitoringAnalytics';

const { loadMonitoringMetaPayloadMock, useMonitoringAnalyticsMock } = vi.hoisted(() => ({
  loadMonitoringMetaPayloadMock: vi.fn(),
  useMonitoringAnalyticsMock: vi.fn(),
}));
vi.mock('../services/monitoringMetaService', () => ({
  loadMonitoringMetaPayload: loadMonitoringMetaPayloadMock,
}));
vi.mock('./useMonitoringAnalytics', () => ({
  useMonitoringAnalytics: useMonitoringAnalyticsMock,
}));

import { ACCOUNT_FOCUS_BLOCKED_AUTH_INDEX } from '../model/analyticsAdapters';
import { useMonitoringData, type UseMonitoringDataReturn } from './useMonitoringData';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 合成样本：opaque token 与 row.id 完全不同
const TOKEN = 'tok~Q7.z|opaque';
const ROW_ID = 'acct-row-42';
const FOCUS_SELECTOR = `focus:${encodeURIComponent(TOKEN)}`;

const statRow = (withToken: boolean): MonitoringAnalyticsAccountStatRow => ({
  id: ROW_ID,
  ...(withToken ? { account_focus_id: TOKEN } : {}),
  account_snapshot: 'a@example.invalid',
  auth_label_snapshot: '',
  auth_provider_snapshot: 'codex',
  auth_indices: ['idx-a'],
  sources: [],
  source_hashes: [],
  calls: 1,
  success_calls: 1,
  failure_calls: 0,
  success_rate: 1,
  input_tokens: 0,
  output_tokens: 0,
  cached_tokens: 0,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
  total_tokens: 0,
  cost: 0,
  average_latency_ms: null,
  last_seen_ms: 1,
});

type Server = {
  selectorData: MonitoringAnalyticsResponse | null;
  selectorError: string;
  accountsError: (params: UseMonitoringAnalyticsParams) => string;
};
let server: Server;

const selectorResponse = (withToken: boolean): MonitoringAnalyticsResponse => ({
  generated_at_ms: 1,
  granularity: 'hour',
  filter_options: { account_stats: [statRow(withToken)] },
});

const STABLE_PRICES = {};
const plainResponse = { generated_at_ms: 1, granularity: 'hour' } as MonitoringAnalyticsResponse;
const stableRefresh = vi.fn(async () => undefined);
const selectorWith = selectorResponse(true);
const selectorWithout = selectorResponse(false);

const resultFor = (params: UseMonitoringAnalyticsParams) => {
  const isSelector = Boolean(params.include?.filter_selectors);
  const isAccounts = Boolean(params.include?.account_stats);
  return {
    enabled: true,
    loading: isSelector && !server.selectorData && !server.selectorError,
    error: isSelector ? server.selectorError : isAccounts ? server.accountsError(params) : '',
    data: isSelector ? server.selectorData : plainResponse,
    dataStale: false,
    lastRefreshedAt: null,
    serviceBase: 'http://manager.local',
    unavailableReason: '' as const,
    refresh: stableRefresh,
  };
};

describe('useMonitoringData exact account focus requests', () => {
  let renderer: ReactTestRenderer | null = null;
  let latest: UseMonitoringDataReturn | null = null;

  const paramsOf = (predicate: (params: UseMonitoringAnalyticsParams) => boolean) =>
    useMonitoringAnalyticsMock.mock.calls
      .map(([params]) => params as UseMonitoringAnalyticsParams)
      .filter(predicate);
  const lastAccounts = () => paramsOf((p) => Boolean(p.include?.account_stats)).slice(-1)[0];
  const lastEvents = () => paramsOf((p) => Boolean(p.include?.events_page)).slice(-1)[0];

  let currentScope: MonitoringScopeFilters = {};
  function Harness() {
    const result = useMonitoringData({
      config: null,
      connectionScopeKey: null,
      modelPrices: STABLE_PRICES,
      timeRange: 'today',
      searchQuery: '',
      scopeFilters: currentScope,
      activeDataTab: 'accounts',
    });
    useEffect(() => {
      latest = result;
    }, [result]);
    return null;
  }

  const render = async (scopeFilters: MonitoringScopeFilters) => {
    currentScope = scopeFilters;
    await act(async () => {
      renderer = create(<Harness />);
      await Promise.resolve();
      await Promise.resolve();
    });
    // 让 effect 驱动的能力状态结算
    await act(async () => {
      await Promise.resolve();
    });
  };

  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_100_000);
    latest = null;
    server = { selectorData: selectorWith, selectorError: '', accountsError: () => '' };
    loadMonitoringMetaPayloadMock.mockReset();
    loadMonitoringMetaPayloadMock.mockResolvedValue({
      authFiles: [],
      authFilesLoaded: true,
      channels: [],
      channelsLoaded: true,
      error: '',
    });
    useMonitoringAnalyticsMock.mockReset();
    useMonitoringAnalyticsMock.mockImplementation(resultFor);
  });
  afterEach(() => {
    renderer?.unmount();
    renderer = null;
    vi.restoreAllMocks();
  });

  it('new server: sends the issued token verbatim and keeps independent filters', async () => {
    await render({ account: FOCUS_SELECTOR, apiKeyHash: 'k1', model: 'gpt-x' });
    expect(latest?.accountFocusState).toBe('active');
    expect(lastAccounts()?.filters).toEqual({
      account_focus_id: TOKEN,
      api_key_hashes: ['k1'],
      models: ['gpt-x'],
    });
    expect(JSON.stringify(lastAccounts()?.filters)).not.toContain(ROW_ID);
    expect(lastAccounts()?.include?.account_focus).toBe(true);
    // 事件请求不设置 include.account_focus，但同样携带已确认的 token
    expect(lastEvents()?.include?.account_focus).toBeUndefined();
    expect(lastEvents()?.filters?.account_focus_id).toBe(TOKEN);
  });

  it('old server opening a new link: blocked and asks to refresh + reselect, never full set', async () => {
    server.selectorData = selectorWithout;
    await render({ account: FOCUS_SELECTOR, apiKeyHash: 'k1' });
    expect(latest?.accountFocusState).toBe('unavailable');
    for (const params of [lastAccounts(), lastEvents()]) {
      expect(params?.filters?.account_focus_id).toBeUndefined();
      expect(params?.filters?.accounts).toBeUndefined();
      expect(params?.filters?.credential_ids).toBeUndefined();
      expect(params?.filters?.auth_indices).toEqual([ACCOUNT_FOCUS_BLOCKED_AUTH_INDEX]);
      expect(params?.filters?.api_key_hashes).toEqual(['k1']);
    }
    expect(latest?.filteredRows).toEqual([]);
  });

  it('options still loading: pending and blocked', async () => {
    server.selectorData = null;
    await render({ account: FOCUS_SELECTOR });
    expect(latest?.accountFocusState).toBe('pending');
    expect(lastAccounts()?.filters?.auth_indices).toEqual([ACCOUNT_FOCUS_BLOCKED_AUTH_INDEX]);
    expect(lastAccounts()?.filters?.account_focus_id).toBeUndefined();
  });

  it('server rejects an issued token (expired): becomes unavailable and stops sending it', async () => {
    server.accountsError = (params) => (params.filters?.account_focus_id ? 'focus expired' : '');
    await render({ account: FOCUS_SELECTOR });
    expect(latest?.accountFocusState).toBe('unavailable');
    expect(lastAccounts()?.filters?.account_focus_id).toBeUndefined();
    expect(lastAccounts()?.filters?.auth_indices).toEqual([ACCOUNT_FOCUS_BLOCKED_AUTH_INDEX]);
  });

  it('legacy URL selectors keep their original filters and never send the new param', async () => {
    await render({ account: 'provider:codex|auth:idx-a' });
    expect(latest?.accountFocusState).toBe('none');
    expect(lastAccounts()?.filters).toEqual({ auth_indices: ['idx-a'] });
  });
});
