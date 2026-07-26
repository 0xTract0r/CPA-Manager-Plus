import { useEffect } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiKeyAlias } from '@/services/api/usageService';
import type { ModelPrice } from '@/utils/usage';
import type { MonitoringTimeRange } from './useMonitoringData';

// 概览聚合降频解耦的端到端(hook 逻辑层)回归：
// 事件流(events)请求锚点必须每次后台刷新都前移(贴近实时)；概览聚合的 nowMs 锚点走降频门，
// 同窗后台刷新在最小间隔(30s)内不前移 nowMs(=不因锚点漂移重发)，只有满 30s / 手动 force
// 才前移 nowMs。切时间窗(scope 变化)不靠前移 nowMs 触发重拉——概览请求的 fromMs/toMs/
// granularity 随 timeRange 直接变化 → request 变 → 立即重拉(与降频门正交)，此时 nowMs 仍被
// 门限住。用 mock 的 useMonitoringAnalytics 按 include 形状区分两路，捕获各自实际收到的
// nowMs/fromMs/toMs 请求锚点，直接断言两路节奏解耦，不依赖真实计时器抖动。

interface CapturedParams {
  nowMs?: number;
  fromMs?: number | null;
  toMs?: number | null;
}

let latestOverviewParams: CapturedParams = {};
let latestEventsParams: CapturedParams = {};

const STABLE_REFRESH = vi.fn();
const STABLE_ANALYTICS_RESULT = {
  enabled: true,
  loading: false,
  error: '',
  data: null,
  dataStale: false,
  lastRefreshedAt: null as Date | null,
  serviceBase: 'http://manager.local',
  unavailableReason: '' as const,
  refresh: STABLE_REFRESH,
};

vi.mock('../services/monitoringMetaService', () => ({
  loadMonitoringMetaPayload: vi.fn(async () => ({
    authFiles: [],
    channels: [],
    error: '',
  })),
}));

vi.mock('./useMonitoringAnalytics', () => ({
  useMonitoringAnalytics: (params: {
    nowMs?: number;
    fromMs?: number | null;
    toMs?: number | null;
    include?: { events_page?: unknown };
  }) => {
    const captured: CapturedParams = {
      nowMs: params.nowMs,
      fromMs: params.fromMs,
      toMs: params.toMs,
    };
    if (params.include?.events_page) {
      latestEventsParams = captured;
    } else {
      latestOverviewParams = captured;
    }
    return STABLE_ANALYTICS_RESULT;
  },
}));

import { useMonitoringData } from './useMonitoringData';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const EMPTY_MODEL_PRICES: Record<string, ModelPrice> = {};
const EMPTY_API_KEY_ALIASES: ApiKeyAlias[] = [];
const ALL_SCOPE_FILTERS = {
  account: 'all',
  provider: 'all',
  model: 'all',
  channel: 'all',
  apiKeyHash: 'all',
  status: 'all',
} as const;

const BASE_MS = 1_768_759_000_000;

describe('useMonitoringData overview aggregation refresh decoupling', () => {
  let renderer: ReactTestRenderer | null = null;
  let nowValue = BASE_MS;
  let latest: ReturnType<typeof useMonitoringData> | null = null;

  beforeEach(() => {
    nowValue = BASE_MS;
    vi.spyOn(Date, 'now').mockImplementation(() => nowValue);
  });

  afterEach(() => {
    renderer?.unmount();
    renderer = null;
    latest = null;
    latestOverviewParams = {};
    latestEventsParams = {};
    vi.restoreAllMocks();
  });

  function Harness({
    searchQuery = 'scope',
    timeRange = '24h',
  }: {
    searchQuery?: string;
    timeRange?: MonitoringTimeRange;
  }) {
    const result = useMonitoringData({
      config: null,
      modelPrices: EMPTY_MODEL_PRICES,
      apiKeyAliases: EMPTY_API_KEY_ALIASES,
      // 用滚动档：fromMs/toMs 随 nowMs 前移，nowMs 本身也进入请求参数，便于断言锚点变化；
      // 切换 timeRange 时 fromMs/toMs 随窗口直接变化，便于断言"切窗即重拉"。
      timeRange,
      customTimeRange: null,
      searchQuery,
      searchApiKeyHash: '',
      scopeFilters: ALL_SCOPE_FILTERS,
    });
    useEffect(() => {
      latest = result;
    });
    return null;
  }

  const backgroundTick = async (atMs: number) => {
    nowValue = atMs;
    await act(async () => {
      await latest!.refreshMeta(false, { forceOverview: false });
    });
  };

  it('advances the events clock every background tick but throttles the overview clock to the minimum interval', async () => {
    await act(async () => {
      renderer = create(<Harness searchQuery="scope-a" />);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    // 首屏：两路锚点相同。
    expect(latestOverviewParams.nowMs).toBe(BASE_MS);
    expect(latestEventsParams.nowMs).toBe(BASE_MS);

    // 后台 tick @ +5s：events 前移到 +5s，概览被降频门挡住，仍停在 BASE。
    await backgroundTick(BASE_MS + 5_000);
    expect(latestEventsParams.nowMs).toBe(BASE_MS + 5_000);
    expect(latestOverviewParams.nowMs).toBe(BASE_MS);

    // 后台 tick @ +25s：events 继续前移，概览仍未满 30s → 不前移(同窗不重复重拉概览)。
    await backgroundTick(BASE_MS + 25_000);
    expect(latestEventsParams.nowMs).toBe(BASE_MS + 25_000);
    expect(latestOverviewParams.nowMs).toBe(BASE_MS);
    // events 的时间边界也随锚点前移(证明 events 一路完全不受概览降频门影响)。
    expect(latestEventsParams.toMs).toBe(BASE_MS + 25_000);
    expect(latestOverviewParams.toMs).toBe(BASE_MS);

    // 后台 tick @ +30s：满最小间隔 → 概览前移到 +30s。
    await backgroundTick(BASE_MS + 30_000);
    expect(latestEventsParams.nowMs).toBe(BASE_MS + 30_000);
    expect(latestOverviewParams.nowMs).toBe(BASE_MS + 30_000);
  });

  it('advances the overview clock immediately on a forced (manual) refresh even within the interval', async () => {
    await act(async () => {
      renderer = create(<Harness searchQuery="scope-a" />);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(latestOverviewParams.nowMs).toBe(BASE_MS);

    // 手动/强制刷新 @ +3s（远未到 30s）：概览也应立即前移。
    nowValue = BASE_MS + 3_000;
    await act(async () => {
      await latest!.refreshMeta(false, { forceOverview: true });
    });
    expect(latestOverviewParams.nowMs).toBe(BASE_MS + 3_000);
    expect(latestEventsParams.nowMs).toBe(BASE_MS + 3_000);
  });

  it('refetches the overview immediately when the time window (scope) changes, without waiting 30s and without advancing the gated nowMs', async () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    await act(async () => {
      renderer = create(<Harness timeRange="24h" />);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    // 先用一次同窗后台 tick 把概览时钟门限在旧锚点(BASE，不满 30s)。
    await backgroundTick(BASE_MS + 10_000);
    expect(latestOverviewParams.nowMs).toBe(BASE_MS);
    expect(latestOverviewParams.fromMs).toBe(BASE_MS - DAY_MS); // 24h 窗口

    // 切时间窗 24h → 7d：概览请求的 scope(fromMs/toMs/granularity)随 timeRange 立即变化
    // → request 变 → 概览实例立即重拉，不必等满 30s、也不依赖任何"重锚"去改 nowMs。
    // 关键断言：概览 fromMs 立即切到 7d 窗口(证明切窗即重拉)，而 nowMs 仍是被降频门限住的
    // BASE(证明降频门只管同窗后台 nowMs 前移，切窗重拉走 request 变化这条正交路径)。
    await act(async () => {
      renderer!.update(<Harness timeRange="7d" />);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(latestOverviewParams.fromMs).toBe(BASE_MS - 7 * DAY_MS); // 7d 窗口 → 概览已切到新 scope
    expect(latestOverviewParams.toMs).toBe(BASE_MS);
    expect(latestOverviewParams.nowMs).toBe(BASE_MS); // nowMs 仍被门限，未被前移/重锚
  });
});
