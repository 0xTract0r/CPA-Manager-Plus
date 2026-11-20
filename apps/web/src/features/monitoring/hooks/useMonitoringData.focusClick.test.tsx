import { useEffect, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { TFunction } from 'i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  MonitoringAnalyticsAccountStatRow,
  MonitoringAnalyticsRequest,
  MonitoringAnalyticsResponse,
} from '@/services/api/usageService';
import { MonitoringFiltersPanel } from '../components/MonitoringFiltersPanel';
import { resolveMonitoringAccountFocusAction } from '../accountOverviewState';
import { resolveMonitoringAccountFocusNotice } from '../model/monitoringAnalyticsModel';
import type { MonitoringAccountRow, MonitoringScopeFilters } from '../model/types';

// 真实 useMonitoringData + 真实 useMonitoringAnalytics；只替换网络层 getAnalytics 与元数据加载。
const net = vi.hoisted(() => ({
  getAnalytics: vi.fn(),
}));
vi.mock('@/services/api/usageService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api/usageService')>();
  return {
    ...actual,
    monitoringAnalyticsApi: { ...actual.monitoringAnalyticsApi, getAnalytics: net.getAnalytics },
  };
});
vi.mock('@/hooks/useRequestMonitoringAvailability', () => ({
  useRequestMonitoringAvailability: () => ({
    checking: false,
    available: true,
    managerServiceAvailable: true,
    modelPricesAvailable: true,
    serviceBase: 'http://manager.local',
    reason: '',
  }),
}));
vi.mock('@/stores', () => ({
  useAuthStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ apiBase: 'http://cpa.local', managementKey: 'k' }),
}));
vi.mock('../services/monitoringMetaService', () => ({
  loadMonitoringMetaPayload: vi.fn(async () => ({
    authFiles: [],
    authFilesLoaded: true,
    channels: [],
    channelsLoaded: true,
    error: '',
  })),
}));

import { useMonitoringData, type UseMonitoringDataReturn } from './useMonitoringData';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = ((key: string) => key) as TFunction;
const HOUR = 3_600_000;

const stat = (
  overrides: Partial<MonitoringAnalyticsAccountStatRow> & { id: string }
): MonitoringAnalyticsAccountStatRow => ({
  account_snapshot: 'same@example.invalid',
  auth_label_snapshot: '',
  auth_provider_snapshot: 'codex',
  auth_indices: ['idx-shared'],
  sources: [],
  source_hashes: [],
  calls: 1,
  success_calls: 1,
  failure_calls: 0,
  success_rate: 1,
  input_tokens: 1,
  output_tokens: 1,
  cached_tokens: 0,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
  total_tokens: 2,
  cost: 0,
  average_latency_ms: null,
  last_seen_ms: 1,
  models: [],
  ...overrides,
});

// 旧 Manager：在线账号行没有 account_focus_id（预验 739cbe0f 的 unknown 1/3、左右 3/2 形状）
const OLD_ROWS = [
  stat({ id: 'old-unknown', auth_provider_snapshot: 'unknown', calls: 1 }),
  stat({
    id: 'old-left',
    account_snapshot: 'left@example.invalid',
    auth_indices: ['idx-l', 'idx-shared'],
    calls: 3,
  }),
  stat({
    id: 'old-right',
    account_snapshot: 'right@example.invalid',
    auth_indices: ['idx-r', 'idx-shared'],
    calls: 3,
  }),
];
const TOKEN = 'tk/9.opaque';
const TOKEN_SELECTOR = 'sel~22.opaque';
const NEW_ROWS = [stat({ id: 'new-a', account_focus_id: TOKEN, calls: 3 })];
const NEW_SELECTOR_ROWS = [
  stat({ id: 'sel-a', account_snapshot: 'b@example.invalid', account_focus_id: TOKEN_SELECTOR }),
];

type ServerMode = 'old' | 'new';
let mode: ServerMode = 'old';
let rejectToken = '';
// 为 true 时，不带 focus token 的新列表/选择器请求保持在途（模拟旧行仍在界面上可点）。
let holdListRequests = false;
const requests: MonitoringAnalyticsRequest[] = [];

const respond = (request: MonitoringAnalyticsRequest): MonitoringAnalyticsResponse => {
  const include = request.include ?? {};
  const base: MonitoringAnalyticsResponse = { generated_at_ms: Date.now(), granularity: 'hour' };
  if (include.filter_selectors) {
    return {
      ...base,
      filter_options: { account_stats: mode === 'new' ? NEW_SELECTOR_ROWS : OLD_ROWS },
    };
  }
  if (include.account_stats) {
    return { ...base, account_stats: mode === 'new' ? NEW_ROWS : OLD_ROWS };
  }
  return { ...base, events: { items: [], has_more: false, total_count: 0 } as never };
};

net.getAnalytics.mockImplementation(
  async (_base: string, _key: string, request: MonitoringAnalyticsRequest) => {
    requests.push(request);
    if (
      holdListRequests &&
      !request.filters?.account_focus_id &&
      (request.include?.account_stats || request.include?.filter_selectors)
    ) {
      return new Promise<MonitoringAnalyticsResponse>(() => {});
    }
    if (rejectToken && request.filters?.account_focus_id === rejectToken) {
      throw new Error('account_focus_id expired');
    }
    return respond(request);
  }
);

let latest: UseMonitoringDataReturn | null = null;
let clickRow: ((row: MonitoringAccountRow) => void) | null = null;
let pickSelector: ((value: string) => void) | null = null;
let latestRefreshMeta: UseMonitoringDataReturn['refreshMeta'] | null = null;

function Page({ initial }: { initial: MonitoringScopeFilters }) {
  const [scope, setScope] = useState<MonitoringScopeFilters>(initial);
  const result = useMonitoringData({
    config: null,
    connectionScopeKey: 'c',
    modelPrices: STABLE_PRICES,
    timeRange: '24h',
    searchQuery: '',
    scopeFilters: scope,
    activeDataTab: 'accounts',
  });
  useEffect(() => {
    latest = result;
    latestRefreshMeta = result.refreshMeta;
    // 与 MonitoringCenterPage.focusAccount 同一动作：resolveMonitoringAccountFocusAction -> setSelectedAccount
    clickRow = (row) => {
      const action = resolveMonitoringAccountFocusAction(null, row);
      if (action.type === 'focus') setScope((prev) => ({ ...prev, account: action.filterValue }));
    };
    pickSelector = (value) => setScope((prev) => ({ ...prev, account: value }));
  }, [result]);
  return null;
}
const STABLE_PRICES = {};

const flush = async () => {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const accountRequestsSince = (start: number) =>
  requests.slice(start).filter((r) => r.include?.account_stats || r.include?.events_page);

const isWideAccountQuery = (r: MonitoringAnalyticsRequest) =>
  Boolean(r.filters?.accounts?.length) ||
  Boolean(r.filters?.providers?.length) ||
  Boolean(r.filters?.credential_ids?.length) ||
  Boolean(r.filters?.auth_indices?.some((value) => !value.startsWith('__')));

const renderNotice = (state: UseMonitoringDataReturn['accountFocusState']) =>
  renderToStaticMarkup(
    <MonitoringFiltersPanel
      timeRange="24h"
      autoRefreshMs="30000"
      selectedAccount="x"
      selectedProvider="all"
      selectedModel="all"
      selectedChannel="all"
      selectedApiKeyHash="all"
      selectedStatus="all"
      searchInput=""
      accountOptions={[]}
      providerOptions={[]}
      modelOptions={[]}
      channelOptions={[]}
      apiKeyOptions={[]}
      statusOptions={[]}
      combinedError={null}
      customRangeCompactLabel="monitoring.range_custom"
      staleDataNotice={resolveMonitoringAccountFocusNotice(state, t)}
      usageStatisticsEnabled
      overallLoading={false}
      t={t}
      onTimeRangeChange={() => {}}
      onAutoRefreshChange={() => {}}
      onRefreshAll={() => {}}
      onAccountFilterChange={() => {}}
      onProviderChange={() => {}}
      onModelChange={() => {}}
      onChannelChange={() => {}}
      onApiKeyChange={() => {}}
      onStatusChange={() => {}}
      onSearchChange={() => {}}
      onClearFilters={() => {}}
    />
  );

describe('real hook + row click: exact account focus', () => {
  let renderer: ReactTestRenderer | null = null;
  let nowMs = 1_795_000_000_000;

  beforeEach(() => {
    nowMs = 1_795_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    requests.length = 0;
    rejectToken = '';
    holdListRequests = false;
    latest = null;
  });
  afterEach(() => {
    renderer?.unmount();
    renderer = null;
    vi.restoreAllMocks();
  });

  const mount = async (initial: MonitoringScopeFilters) => {
    await act(async () => {
      renderer = create(<Page initial={initial} />);
    });
    await flush();
  };

  it('red (739cbe0f): old Manager online row click sends no wide account query and shows the unsupported notice', async () => {
    mode = 'old';
    await mount({ model: 'gpt-x', status: 'failed', apiKeyHash: 'k1' });
    const rows = latest!.accountRows;
    expect(rows.map((row) => row.id).sort()).toEqual(['old-left', 'old-right', 'old-unknown']);

    const firstClick = requests.length;
    for (const id of ['old-unknown', 'old-left', 'old-right']) {
      const start = requests.length;
      const row = latest!.accountRows.find((item) => item.id === id)!;
      await act(async () => clickRow!(row));
      await flush();
      // 三行都映射到同一阻断请求，后续点击会被去重；全部已发请求都必须非宽查询
      const sent = accountRequestsSince(start);
      sent.forEach((r) => {
        expect(isWideAccountQuery(r)).toBe(false);
        expect(r.filters?.account_focus_id).toBeUndefined();
        // 用户独立筛选保留
        expect(r.filters?.models).toEqual(['gpt-x']);
        expect(r.filters?.failed_only).toBe(true);
        expect(r.filters?.api_key_hashes).toEqual(['k1']);
      });
      expect(latest!.accountFocusState).toBe('unsupported');
      // 不展示 3/2 条虚假明细
      expect(latest!.filteredRows).toEqual([]);
      expect(renderNotice(latest!.accountFocusState)).toContain(
        'monitoring.account_focus_unsupported'
      );
    }
    expect(accountRequestsSince(firstClick).length).toBeGreaterThan(0);
  });

  it('old Manager: picking an old row from the lightweight selector is fail-closed too', async () => {
    mode = 'old';
    await mount({});
    const option = latest!.filterOptions.accountRows.find((row) => row.id === 'old-left')!;
    expect(option.filterValue).toMatch(/^focus-unsupported:/);
    const start = requests.length;
    await act(async () => pickSelector!(option.filterValue!));
    await flush();
    accountRequestsSince(start).forEach((r) => expect(isWideAccountQuery(r)).toBe(false));
    expect(latest!.accountFocusState).toBe('unsupported');
  });

  it('old Manager opening a new focus URL: no wide query, asks to refresh and reselect', async () => {
    mode = 'old';
    await mount({ account: `focus:${encodeURIComponent(TOKEN)}`, model: 'gpt-x' });
    accountRequestsSince(0).forEach((r) => {
      expect(isWideAccountQuery(r)).toBe(false);
      expect(r.filters?.account_focus_id).toBeUndefined();
    });
    expect(latest!.accountFocusState).toBe('unavailable');
    expect(renderNotice(latest!.accountFocusState)).toContain(
      'monitoring.account_focus_unavailable'
    );
  });

  it('new Manager, relative 24h: clock advances after the list, click keeps token + models + failed_only inside the issued window', async () => {
    mode = 'new';
    await mount({ model: 'gpt-x', status: 'failed', channel: 'chan-1' });
    const listRequest = requests.filter((r) => r.include?.account_stats).slice(-1)[0];
    expect(listRequest.include?.account_focus).toBe(true);
    const issuedFrom = listRequest.from_ms;
    const issuedTo = listRequest.to_ms;
    expect(issuedTo - issuedFrom).toBe(24 * HOUR);

    // 列表返回后时钟前进（相对窗口 now 漂移），再点击
    nowMs += 1_234;
    const row = latest!.accountRows.find((item) => item.id === 'new-a')!;
    expect(row.filterValue).toBe(`focus:${encodeURIComponent(TOKEN)}`);
    expect(TOKEN).not.toBe(row.id);
    const start = requests.length;
    await act(async () => clickRow!(row));
    await flush();
    const detail = requests.slice(start).filter((r) => r.filters?.account_focus_id);
    expect(detail.length).toBeGreaterThan(0);
    detail.forEach((r) => {
      expect(r.filters?.account_focus_id).toBe(TOKEN);
      expect(r.filters?.models).toEqual(['gpt-x']);
      expect(r.filters?.failed_only).toBe(true);
      expect(r.filters?.providers).toEqual(['chan-1']);
      expect(r.filters?.accounts).toBeUndefined();
      expect(r.filters?.auth_indices).toBeUndefined();
      // 不越出签发窗口，也不早于当前窗口起点
      expect(r.from_ms).toBeGreaterThanOrEqual(issuedFrom);
      expect(r.to_ms).toBeLessThanOrEqual(issuedTo);
    });
    expect(latest!.accountFocusState).toBe('active');
  });

  it('new Manager, relative 24h: real background refresh moves the window, held list row click uses issued ∩ new window', async () => {
    mode = 'new';
    await mount({ model: 'gpt-x', status: 'failed', apiKeyHash: 'k7' });
    const issued = requests.filter((r) => r.include?.account_stats).slice(-1)[0];
    expect(issued.include?.account_focus).toBe(true);
    expect(issued.to_ms - issued.from_ms).toBe(24 * HOUR);
    const row = latest!.accountRows.find((item) => item.id === 'new-a')!;
    expect(row.filterValue).toBe(`focus:${encodeURIComponent(TOKEN)}`);

    // 真实后台刷新：hook 的 refreshMeta(showLoading=false, forceOverview=false)，
    // 推进超过概览降频门限 OVERVIEW_MIN_REFRESH_INTERVAL_MS(30s)，让时间锚真实前移。
    holdListRequests = true;
    nowMs += 31_000;
    const beforeRefresh = requests.length;
    await act(async () => {
      await latestRefreshMeta!(false, { forceOverview: false });
    });
    await flush();
    const moved = requests
      .slice(beforeRefresh)
      .filter((r) => r.include?.account_stats || r.include?.filter_selectors);
    expect(moved.length).toBeGreaterThan(0);
    // 先断言：至少一个真实请求窗口已严格晚于签发窗口
    const newWindow = moved.find((r) => r.from_ms > issued.from_ms && r.to_ms > issued.to_ms)!;
    expect(newWindow).toBeTruthy();
    expect(newWindow.from_ms).toBeGreaterThan(issued.from_ms);
    expect(newWindow.to_ms).toBeGreaterThan(issued.to_ms);
    // 新列表仍在途：界面上仍是签发时的旧行
    expect(latest!.accountRows.find((item) => item.id === 'new-a')?.filterValue).toBe(
      row.filterValue
    );

    const beforeClick = requests.length;
    await act(async () => clickRow!(row));
    await flush();
    const detail = requests.slice(beforeClick).filter((r) => r.filters?.account_focus_id);
    expect(detail.length).toBeGreaterThan(0);
    const expectedFrom = Math.max(issued.from_ms, newWindow.from_ms);
    const expectedTo = Math.min(issued.to_ms, newWindow.to_ms);
    expect(expectedFrom).toBe(newWindow.from_ms);
    expect(expectedTo).toBe(issued.to_ms);
    detail.forEach((r) => {
      expect(r.filters?.account_focus_id).toBe(TOKEN);
      expect(r.filters?.models).toEqual(['gpt-x']);
      expect(r.filters?.failed_only).toBe(true);
      expect(r.filters?.api_key_hashes).toEqual(['k7']);
      expect(r.filters?.accounts).toBeUndefined();
      expect(r.filters?.auth_indices).toBeUndefined();
      expect([r.from_ms, r.to_ms]).toEqual([expectedFrom, expectedTo]);
    });
    expect(latest!.accountFocusState).toBe('active');
  });

  it('new Manager: wide selector row (no models/failed_only) click still intersects with the user filters', async () => {
    mode = 'new';
    await mount({ model: 'gpt-x', status: 'failed', apiKeyHash: 'k9' });
    const selectorRequest = requests.filter((r) => r.include?.filter_selectors).slice(-1)[0];
    expect(selectorRequest.filters).toBeUndefined();
    expect(selectorRequest.include?.account_focus).toBe(true);
    const option = latest!.filterOptions.accountRows.find((row) => row.id === 'sel-a')!;
    const start = requests.length;
    await act(async () => pickSelector!(option.filterValue!));
    await flush();
    const detail = requests.slice(start).filter((r) => r.filters?.account_focus_id);
    expect(detail.length).toBeGreaterThan(0);
    detail.forEach((r) => {
      expect(r.filters?.account_focus_id).toBe(TOKEN_SELECTOR);
      expect(r.filters?.models).toEqual(['gpt-x']);
      expect(r.filters?.failed_only).toBe(true);
      expect(r.filters?.api_key_hashes).toEqual(['k9']);
    });
  });

  it('new Manager: server rejects the token after click -> refresh-and-reselect, no full set', async () => {
    mode = 'new';
    rejectToken = TOKEN;
    await mount({});
    const row = latest!.accountRows.find((item) => item.id === 'new-a')!;
    const start = requests.length;
    await act(async () => clickRow!(row));
    await flush();
    expect(latest!.accountFocusState).toBe('unavailable');
    const after = requests.slice(start);
    const last = after.filter((r) => r.include?.account_stats).slice(-1)[0];
    expect(last.filters?.account_focus_id).toBeUndefined();
    expect(last.filters?.auth_indices?.[0]).toMatch(/^__/);
    after.forEach((r) => expect(isWideAccountQuery(r)).toBe(false));
  });
});
