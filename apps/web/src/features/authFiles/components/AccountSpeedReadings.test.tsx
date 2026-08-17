import { create, act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountSpeedReadings } from './AccountSpeedReadings';
import type { AccountSpeedMetricSummary } from '@/features/authFiles/model/accountSpeedMetrics';

// 复用仓库既有 i18n mock 口径：有 defaultValue 时展开 {{opt}} 插值，否则回原 key。
vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (options && typeof options.defaultValue === 'string') {
        return Object.entries(options).reduce(
          (acc, [optionKey, optionValue]) =>
            optionKey === 'defaultValue'
              ? acc
              : acc.split(`{{${optionKey}}}`).join(String(optionValue)),
          options.defaultValue as string
        );
      }
      return key;
    },
  }),
}));

const hookMock = vi.fn();
vi.mock('@/features/authFiles/hooks/useAccountSpeedMetrics', () => ({
  useAccountSpeedMetrics: (args: unknown) => hookMock(args),
}));

const okSummary: AccountSpeedMetricSummary = {
  medianTtftMs: 1320,
  medianLatencyMs: 3760,
  medianTps: 97,
  ttftSamples: 15,
  latencySamples: 15,
  tpsSamples: 15,
  events: 15,
};

const emptySummary: AccountSpeedMetricSummary = {
  medianTtftMs: null,
  medianLatencyMs: null,
  medianTps: null,
  ttftSamples: 0,
  latencySamples: 0,
  tpsSamples: 0,
  events: 15,
};

function renderJson(): string {
  let renderer: ReactTestRenderer;
  act(() => {
    renderer = create(<AccountSpeedReadings accountName="acct" />);
  });
  return JSON.stringify(renderer!.toJSON());
}

afterEach(() => hookMock.mockReset());

describe('AccountSpeedReadings sample-note 分态守卫', () => {
  it('ok 态：三读数 + 「· N reqs」内联在 header', () => {
    hookMock.mockReturnValue({
      status: 'ok',
      loading: false,
      error: '',
      metrics: {
        hasData: true,
        totalEvents: 15,
        usedEvents: 15,
        overall: okSummary,
        byServiceTier: {},
        priorityTier: null,
        defaultTier: null,
      },
      windowHours: 24,
      sampleCount: 15,
    });
    const json = renderJson();
    expect(json).toContain('· 15 reqs');
    // 三读数标签在（说明是 ok 展示态而非降级占位）
    expect(json).toContain('First token');
    expect(json).toContain('TPS');
  });

  it('insufficient 态：即便 sampleCount>0 也绝不显示样本注记（回归锁定）', () => {
    // 有 15 条事件但都算不出中位（缺 ttft/latency）→ hasData=false → insufficient，
    // 但 sampleCount=usedEvents=15>0。搬进 header 后若只用 sampleCount>0 守卫，
    // 会渲染成自相矛盾的「数据不足 · 15次」。此测试锁定：注记不得出现。
    hookMock.mockReturnValue({
      status: 'insufficient',
      loading: false,
      error: '',
      metrics: {
        hasData: false,
        totalEvents: 15,
        usedEvents: 15,
        overall: emptySummary,
        byServiceTier: {},
        priorityTier: null,
        defaultTier: null,
      },
      windowHours: 24,
      sampleCount: 15,
    });
    const json = renderJson();
    expect(json).toContain('Not enough data');
    expect(json).not.toContain('· 15 reqs');
    expect(json).not.toContain('reqs');
  });

  it('loading 态：显示 Measuring，无样本注记', () => {
    hookMock.mockReturnValue({
      status: 'loading',
      loading: true,
      error: '',
      metrics: null,
      windowHours: 24,
      sampleCount: 0,
    });
    const json = renderJson();
    expect(json).toContain('Measuring');
    expect(json).not.toContain('reqs');
  });

  it('disabled/unavailable/error 态：不渲染任何内容', () => {
    for (const status of ['disabled', 'unavailable', 'error'] as const) {
      hookMock.mockReturnValue({
        status,
        loading: false,
        error: status === 'error' ? 'boom' : '',
        metrics: null,
        windowHours: 24,
        sampleCount: 0,
      });
      let renderer: ReactTestRenderer;
      act(() => {
        renderer = create(<AccountSpeedReadings accountName="acct" />);
      });
      expect(renderer!.toJSON()).toBeNull();
      hookMock.mockReset();
    }
  });
});
