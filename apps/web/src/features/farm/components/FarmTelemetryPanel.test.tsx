import { act } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type {
  FarmContainerView,
  FarmEgressProbeView,
  FarmTelemetrySilenceStateView,
} from '@/types/farm';
import { FarmTelemetryPanel } from './FarmTelemetryPanel';

/**
 * farm-egress-resilience Change A「遥测停摆四态区分呈现」回归：把单一「偏旧/Stale」
 * 拆成 代理死 / 出站黑洞 / 进程死 / 正常无请求 四态 + 「待确认」诚实边界。
 * 每态 + 待确认 + active + 旧编排器回退 各一个 fixture 用例，断言诊断盒 testid /
 * data-silence-state / data-silence-variant 与探针证据渲染。
 *
 * 断言只看 data-testid / data-* 属性（i18n 的 t 在测试里返回 key，不依赖具体文案），
 * 与 FarmContainerTable.test.tsx 同款稳定引用 mock 口径。
 */

// t 返回 key、i18n.language 固定；引用稳定（详见 FarmContainerTable.test.tsx 说明）。
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

// 全局时区订阅在测试里是 no-op（不触发真实 store 订阅）。
vi.mock('@/hooks/useTimezone', () => ({
  useTimezone: () => undefined,
}));

// 遥测面板的 beacon 数据源固定返回空列表：本组测试只覆盖「遥测停摆四态」区块，
// 该区块只依赖 container.telemetry_silence / telemetry_silence_state，与 beacon 列表无关。
vi.mock('../hooks/useFarmContainerBeacons', () => ({
  FARM_CONTAINER_BEACONS_DEFAULT_LIMIT: 50,
  useFarmContainerBeacons: () => ({ beacons: [], loading: false, error: '', reload: async () => {} }),
}));

const STALE_SILENCE = { is_stale: true, minutes_since_last: 40, threshold_minutes: 30 };

const healthyProbe = (overrides: Partial<FarmEgressProbeView> = {}): FarmEgressProbeView => ({
  checked_at: '2026-08-26T00:00:00Z',
  stale: false,
  proxy_direct_ok: true,
  egress_canary_ok: true,
  egress_canary_targets: [],
  redsocks_recv_q: 0,
  redsocks_backlog: 0,
  redsocks_close_wait: 0,
  redsocks_saturated: false,
  ...overrides,
});

const baseContainer = (
  silenceState: FarmTelemetrySilenceStateView | undefined,
  silence: FarmContainerView['telemetry_silence'] = STALE_SILENCE
): FarmContainerView => ({
  id: 'c-1',
  device_id_masked: 'dev-***',
  status: 'running',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  telemetry_silence: silence,
  telemetry_silence_state: silenceState,
});

const renderPanel = (container: FarmContainerView | null) => {
  let renderer: ReactTestRenderer;
  act(() => {
    renderer = create(<FarmTelemetryPanel container={container} />);
  });
  return renderer!;
};

const nodesByTestId = (renderer: ReactTestRenderer, testId: string): ReactTestInstance[] =>
  renderer.root.findAll(
    (node) => typeof node.type === 'string' && node.props?.['data-testid'] === testId
  );

const firstByTestId = (renderer: ReactTestRenderer, testId: string): ReactTestInstance | undefined =>
  nodesByTestId(renderer, testId)[0];

describe('FarmTelemetryPanel 遥测停摆四态诊断 (farm-egress-resilience Change A)', () => {
  it('代理死：诊断盒 error 变体 + 代理直连探针标不通', () => {
    const renderer = renderPanel(
      baseContainer({
        state: 'proxy_dead',
        process_terminated: false,
        probe: healthyProbe({ proxy_direct_ok: false, egress_canary_ok: false }),
      })
    );
    const box = firstByTestId(renderer, 'farm-telemetry-silence-state');
    expect(box).toBeDefined();
    expect(box?.props['data-silence-state']).toBe('proxy_dead');
    expect(box?.props['data-silence-variant']).toBe('error');
    // 探针证据里代理直连标不通。
    expect(firstByTestId(renderer, 'farm-telemetry-silence-probe-proxy')?.props['data-ok']).toBe(
      'false'
    );
    // 结论 + 建议动作都渲染。
    expect(nodesByTestId(renderer, 'farm-telemetry-silence-conclusion')).toHaveLength(1);
    expect(nodesByTestId(renderer, 'farm-telemetry-silence-action')).toHaveLength(1);
  });

  it('出站黑洞：error 变体 + redsocks 标饱和 + 代理直连仍通', () => {
    const renderer = renderPanel(
      baseContainer({
        state: 'egress_blackhole',
        process_terminated: false,
        probe: healthyProbe({
          egress_canary_ok: false,
          redsocks_saturated: true,
          redsocks_recv_q: 128,
          redsocks_backlog: 64,
        }),
      })
    );
    const box = firstByTestId(renderer, 'farm-telemetry-silence-state');
    expect(box?.props['data-silence-state']).toBe('egress_blackhole');
    expect(box?.props['data-silence-variant']).toBe('error');
    expect(firstByTestId(renderer, 'farm-telemetry-silence-probe-redsocks')?.props['data-saturated']).toBe(
      'true'
    );
    expect(firstByTestId(renderer, 'farm-telemetry-silence-probe-proxy')?.props['data-ok']).toBe(
      'true'
    );
  });

  it('进程死：error 变体 + 进程终止信号行渲染', () => {
    const renderer = renderPanel(
      baseContainer({ state: 'process_dead', process_terminated: true, probe: null })
    );
    const box = firstByTestId(renderer, 'farm-telemetry-silence-state');
    expect(box?.props['data-silence-state']).toBe('process_dead');
    expect(box?.props['data-silence-variant']).toBe('error');
    expect(nodesByTestId(renderer, 'farm-telemetry-silence-proc-terminated')).toHaveLength(1);
    // 无探针时显式标「无探针快照」（诚实边界），不臆断。
    expect(nodesByTestId(renderer, 'farm-telemetry-silence-probe-none')).toHaveLength(1);
  });

  it('正常无请求：muted 变体（benign）+ 探针全通', () => {
    const renderer = renderPanel(
      baseContainer({ state: 'idle_no_request', process_terminated: false, probe: healthyProbe() })
    );
    const box = firstByTestId(renderer, 'farm-telemetry-silence-state');
    expect(box?.props['data-silence-state']).toBe('idle_no_request');
    expect(box?.props['data-silence-variant']).toBe('muted');
    expect(firstByTestId(renderer, 'farm-telemetry-silence-probe-canary')?.props['data-ok']).toBe(
      'true'
    );
  });

  it('待确认（indeterminate）：warning 变体 + 无探针快照标注，绝不臆断正常', () => {
    const renderer = renderPanel(
      baseContainer({ state: 'indeterminate', process_terminated: false, probe: null })
    );
    const box = firstByTestId(renderer, 'farm-telemetry-silence-state');
    expect(box?.props['data-silence-state']).toBe('indeterminate');
    expect(box?.props['data-silence-variant']).toBe('warning');
    expect(nodesByTestId(renderer, 'farm-telemetry-silence-probe-none')).toHaveLength(1);
  });

  it('active：遥测在报，不弹诊断盒，仅新鲜度徽标标 active', () => {
    const renderer = renderPanel(
      baseContainer(
        { state: 'active', process_terminated: false, probe: null },
        { is_stale: false, minutes_since_last: 2, threshold_minutes: 30 }
      )
    );
    expect(nodesByTestId(renderer, 'farm-telemetry-silence-state')).toHaveLength(0);
    expect(firstByTestId(renderer, 'farm-telemetry-freshness')?.props['data-silence-state']).toBe(
      'active'
    );
  });

  it('未知/缺失 state 值经 normalize 落到 indeterminate（待确认），不臆断', () => {
    const renderer = renderPanel(
      // state 声明为 string（后端可能返回未来新增字面值），这里喂非枚举值验证前端
      // normalizeFarmTelemetrySilenceState 兜底为 indeterminate，绝不臆断成乐观结论。
      baseContainer({ state: 'some_future_state', process_terminated: false, probe: healthyProbe() })
    );
    const box = firstByTestId(renderer, 'farm-telemetry-silence-state');
    expect(box?.props['data-silence-state']).toBe('indeterminate');
    expect(box?.props['data-silence-variant']).toBe('warning');
  });

  it('从未观测 + 无探针 + indeterminate：不叠诊断盒（「从未观测」徽标已足够诚实）', () => {
    const renderer = renderPanel(
      baseContainer(
        { state: 'indeterminate', process_terminated: false, probe: null },
        { is_stale: false, minutes_since_last: -1, threshold_minutes: 30 }
      )
    );
    expect(nodesByTestId(renderer, 'farm-telemetry-silence-state')).toHaveLength(0);
    expect(firstByTestId(renderer, 'farm-telemetry-freshness')?.props['data-never-observed']).toBe(
      'true'
    );
  });

  it('旧编排器未返回四态字段时回退既有「遥测太旧」单态告警', () => {
    const renderer = renderPanel(baseContainer(undefined, STALE_SILENCE));
    expect(nodesByTestId(renderer, 'farm-telemetry-silence-state')).toHaveLength(0);
    expect(nodesByTestId(renderer, 'farm-telemetry-stale-warning')).toHaveLength(1);
  });
});

// farm-proxy-rotation §5「指纹卡 pin」：把指纹自洽卡的 declared 列换成「预期(pin)」，
// 数据源改读 container.fingerprint_pin，逐字段对照 on-wire 实测；不一致即撞红=泄露。
//
// 本文件顶部 vi.mock('../hooks/useFarmContainerBeacons', ...) 是静态工厂（非
// vi.fn()），恒返回空 beacons，未按用例可配置——故这里 onWireCaptured 恒为
// false、on-wire 恒是「从未观测」pending 占位，clash 恒为 false。这组用例只覆盖
// pin 存在 / 缺失两态的渲染与存在性门控；clash=true（撞红=泄露，含逐字段泄露
// 标记 + device_id 额外告警盒）需要能按用例返回不同 on-wire beacon 的 mock，
// 当前共享静态 mock 不支持，未在这里覆盖——留给集成阶段把 useFarmContainerBeacons
// 的 mock 换成 vi.fn() 后补一组真撞红场景（见交接 gaps）。
describe('FarmTelemetryPanel 指纹自洽卡 pin (farm-proxy-rotation §5)', () => {
  const pinContainer = (
    fingerprint_pin?: FarmContainerView['fingerprint_pin']
  ): FarmContainerView => ({
    id: 'c-pin-1',
    device_id_masked: 'dev-***',
    status: 'running',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    fingerprint_pin,
  });

  it('pin 缺失（旧编排器/字段裁剪防御）：整卡不渲染 pin 值，只标存在性门控横幅', () => {
    const renderer = renderPanel(pinContainer(undefined));
    expect(nodesByTestId(renderer, 'farm-telemetry-pin-missing-banner')).toHaveLength(1);
    for (const field of ['device_id', 'entrypoint', 'api_base_url_host']) {
      const cell = firstByTestId(renderer, `farm-telemetry-pin-${field}`);
      expect(cell?.props['data-pin-empty']).toBe('true');
    }
    // 空 pin 不会误撞红：既无逐字段泄露标记，也无 device_id 额外告警盒。
    expect(nodesByTestId(renderer, 'farm-telemetry-pin-device-id-alert')).toHaveLength(0);
  });

  it('pin 存在（三字段齐全）：不渲染存在性门控横幅，逐字段用 pin 值渲染且不误撞红', () => {
    const renderer = renderPanel(
      pinContainer({
        device_id_masked: 'e6b4c2aa114a…ca48',
        entrypoint: 'cli',
        api_base_url_host: 'api.anthropic.com',
      })
    );
    expect(nodesByTestId(renderer, 'farm-telemetry-pin-missing-banner')).toHaveLength(0);
    for (const field of ['device_id', 'entrypoint', 'api_base_url_host']) {
      const cell = firstByTestId(renderer, `farm-telemetry-pin-${field}`);
      expect(cell?.props['data-pin-empty']).toBeUndefined();
      const row = firstByTestId(renderer, `farm-telemetry-consistency-row-${field}`);
      // 共享 beacons mock 恒返回 []，on-wire 恒未观测：不应误撞红。
      expect(row?.props['data-clash']).toBe('false');
    }
    expect(nodesByTestId(renderer, 'farm-telemetry-pin-device-id-alert')).toHaveLength(0);
    // on-wire 列在「从未观测」时是 pending 占位，不是撞红态。
    expect(firstByTestId(renderer, 'farm-telemetry-onwire-device_id')?.props['data-pending']).toBe(
      'true'
    );
  });

  it('pin 列表头带 columnHint 说明（title），不是裸文案', () => {
    const renderer = renderPanel(pinContainer(undefined));
    const header = firstByTestId(renderer, 'farm-telemetry-pin-column-header');
    expect(header).toBeDefined();
    expect(typeof header?.props.title).toBe('string');
    expect((header?.props.title as string).length).toBeGreaterThan(0);
  });
});
