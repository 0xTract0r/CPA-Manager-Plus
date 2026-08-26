import { act } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { FarmAlertEntry } from '@/types/farm';
import { FarmAlertsPanel } from './FarmAlertsPanel';

/**
 * farm-egress-resilience Change A：telemetry_silence 告警的「遥测停摆四态」子类型
 * 呈现（后端把四态写进 detail.silence_state，不新增独立 reason）。断言子类型标签
 * testid / data-silence-state / 语义色变体，以及 active 与非 telemetry_silence 告警
 * 不渲染子标签。用 summary 模式（不渲染筛选 Select）保持渲染树精简。
 *
 * i18n 的 t 在测试里返回 key，断言只看 data-* 属性与 className，不依赖具体文案。
 */

vi.mock('react-i18next', () => {
  const stableUseTranslationResult = {
    t: (key: string) => key,
    i18n: { language: 'en' },
  };
  return {
    initReactI18next: { type: '3rdParty', init: () => {} },
    useTranslation: () => stableUseTranslationResult,
  };
});

vi.mock('@/hooks/useTimezone', () => ({
  useTimezone: () => undefined,
}));

// 告警 feed 数据源在测试里由每个用例注入（通过 mock 返回值切换）。
const alertsMock = vi.fn();
vi.mock('../hooks/useFarmAlerts', () => ({
  useFarmAlerts: () => alertsMock(),
}));

const baseAlert = (overrides: Partial<FarmAlertEntry> & { id: number }): FarmAlertEntry => ({
  container_id: 'c-1',
  ts: '2026-08-26T00:00:00Z',
  to_status: 'degraded',
  reason: 'telemetry_silence',
  severity: 'info',
  last_seen: '2026-08-26T00:00:00Z',
  ...overrides,
});

const renderPanel = (alerts: FarmAlertEntry[]) => {
  alertsMock.mockReturnValue({ alerts, loading: false, error: '', reload: async () => {} });
  let renderer: ReactTestRenderer;
  act(() => {
    renderer = create(<FarmAlertsPanel mode="summary" />);
  });
  return renderer!;
};

const nodesByTestId = (renderer: ReactTestRenderer, testId: string): ReactTestInstance[] =>
  renderer.root.findAll(
    (node) => typeof node.type === 'string' && node.props?.['data-testid'] === testId
  );

const firstByTestId = (renderer: ReactTestRenderer, testId: string): ReactTestInstance | undefined =>
  nodesByTestId(renderer, testId)[0];

describe('FarmAlertsPanel 遥测停摆四态子类型 (farm-egress-resilience Change A)', () => {
  it('telemetry_silence + detail.silence_state=egress_blackhole 渲染 error 子标签', () => {
    const renderer = renderPanel([
      baseAlert({ id: 1, detail: { silence_state: 'egress_blackhole' } }),
    ]);
    const tag = firstByTestId(renderer, 'farm-alert-silence-state-1');
    expect(tag).toBeDefined();
    expect(tag?.props['data-silence-state']).toBe('egress_blackhole');
    expect(String(tag?.props.className)).toContain('error');
  });

  it('detail.silence_state=idle_no_request 渲染 muted（benign）子标签', () => {
    const renderer = renderPanel([
      baseAlert({ id: 2, detail: { silence_state: 'idle_no_request' } }),
    ]);
    const tag = firstByTestId(renderer, 'farm-alert-silence-state-2');
    expect(tag?.props['data-silence-state']).toBe('idle_no_request');
    expect(String(tag?.props.className)).toContain('muted');
  });

  it('未知 silence_state 值经 normalize 落 indeterminate（warning，待确认）', () => {
    const renderer = renderPanel([
      baseAlert({ id: 3, detail: { silence_state: 'some_future_state' } }),
    ]);
    const tag = firstByTestId(renderer, 'farm-alert-silence-state-3');
    expect(tag?.props['data-silence-state']).toBe('indeterminate');
    expect(String(tag?.props.className)).toContain('warning');
  });

  it('detail.silence_state=active 不渲染子标签（active 不产告警）', () => {
    const renderer = renderPanel([baseAlert({ id: 4, detail: { silence_state: 'active' } })]);
    expect(nodesByTestId(renderer, 'farm-alert-silence-state-4')).toHaveLength(0);
  });

  it('telemetry_silence 无 detail 时不渲染子标签（缺证据不臆断）', () => {
    const renderer = renderPanel([baseAlert({ id: 5 })]);
    expect(nodesByTestId(renderer, 'farm-alert-silence-state-5')).toHaveLength(0);
  });

  it('非 telemetry_silence 告警不渲染四态子标签', () => {
    const renderer = renderPanel([
      baseAlert({ id: 6, reason: 'container_down', to_status: 'down', detail: { silence_state: 'proxy_dead' } }),
    ]);
    expect(nodesByTestId(renderer, 'farm-alert-silence-state-6')).toHaveLength(0);
  });
});
