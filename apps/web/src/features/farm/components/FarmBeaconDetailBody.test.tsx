import { act } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FarmBeaconRedactedBodyResponse, FarmContainerBeaconView } from '@/types/farm';
import { BeaconDetailBody } from './FarmBeaconDetailBody';

/**
 * 信标详情抽屉正文（BeaconDetailBody）回归：核心断言「查看完整请求体」的 full 视图把
 * 遥测完整体里每个 event 对象的指纹字段（event_name / model / device_id / env）**真实展开
 * 可见**，而不是被折叠成一排空 `{}`。
 *
 * 背景 bug（本次修复）：react-json-view-lite 把折叠对象渲染成**字面空 `{}`**（空 span、
 * 无省略号），此前 preview / full 共用 `shouldExpandNode = level < 2`。遥测完整体形如
 * `{"events":[{"event_type":…,"event_data":{"event_name":…,"model":…}}]}`：root=level0、
 * events 数组=level1、**每个 event 对象=level2**——`level < 2` 把 level2 的每个 event 折叠
 * 掉，于是一段合法 JSON 看着像一排空对象、指纹字段全不可见。修复把 full 视图改为全展开、
 * preview 维持浅展开。
 *
 * 断言口径与 FarmTelemetryPanel.test.tsx 同款：react-test-renderer + data-testid 定位 +
 * collectText 收集可见文本（i18n 的 t 在测试里返回 key，不依赖具体文案）。
 */

// t 返回 key、i18n.language 固定；引用稳定（详见 FarmTelemetryPanel.test.tsx 说明）。
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

// 「查看完整请求体」按需 hook：用 hoisted mock，可按用例覆盖返回的完整脱敏 body。
// BeaconDetailBody 只从该模块 import useFarmBeaconRedactedBody，故只桩这一个导出。
const { useFarmBeaconRedactedBodyMock } = vi.hoisted(() => ({
  useFarmBeaconRedactedBodyMock: vi.fn(),
}));

vi.mock('../hooks/useFarmContainerBeacons', () => ({
  useFarmBeaconRedactedBody: useFarmBeaconRedactedBodyMock,
}));

// 后端真实形态的完整脱敏 body：events 数组非空、每个 event 元素带 event_data 指纹字段。
// 这正是 bug 报告里「渲染成 {events:[{},{},...]} 一排空对象」的 11K 合法 JSON 的最小复刻。
const FULL_BODY = JSON.stringify({
  events: [
    {
      event_type: 'statsig::log_event',
      event_data: {
        event_name: 'tengu_startup',
        model: 'claude-sonnet-4-5-20250929',
        device_id: 'ffffffffffff0000aaaabbbbcccc3333',
        env: 'production',
      },
    },
    {
      event_type: 'statsig::log_event',
      event_data: {
        event_name: 'tengu_api_success',
        model: 'claude-opus-4-1-20250805',
        device_id: 'ffffffffffff0000aaaabbbbcccc3333',
        env: 'production',
      },
    },
  ],
});

const beacon = (overrides: Partial<FarmContainerBeaconView> = {}): FarmContainerBeaconView => ({
  beacon_id: 1,
  captured_at: '2026-08-26T00:00:00Z',
  channel: 'event_logging',
  host: 'api.anthropic.com',
  path: '/api/hello_claude',
  body_bytes: 11126,
  device_id: 'ffffffffffff0000aaaabbbbcccc3333',
  api_base_url_host: 'api.anthropic.com',
  entrypoint: 'cli',
  source: 'mitmproxy',
  source_kind: 'on_wire',
  // 预览给一个小而完整的 JSON：能 parse → 渲染折叠树，且「查看完整请求体」按钮随之渲染。
  body_preview: JSON.stringify({
    events: [{ event_type: 'statsig::log_event', event_data: { event_name: 'tengu_startup' } }],
  }),
  ...overrides,
});

const redactedBody = (
  overrides: Partial<FarmBeaconRedactedBodyResponse> = {}
): FarmBeaconRedactedBodyResponse => ({
  beacon_id: 1,
  redacted_body: FULL_BODY,
  total_bytes: FULL_BODY.length,
  truncated: false,
  ...overrides,
});

const nodesByTestId = (renderer: ReactTestRenderer, testId: string): ReactTestInstance[] =>
  renderer.root.findAll(
    (node) => typeof node.type === 'string' && node.props?.['data-testid'] === testId
  );

const firstByTestId = (
  renderer: ReactTestRenderer,
  testId: string
): ReactTestInstance | undefined => nodesByTestId(renderer, testId)[0];

// 递归收集某个 ReactTestInstance 的可见文本（拼接所有子字符串节点），用于断言 JSON 树
// 里的 event 字段键 / 值确实作为可见文本渲染（不是被折叠成空 `{}`）。
const collectText = (instance: ReactTestInstance): string =>
  instance.children
    .map((child) => (typeof child === 'string' ? child : collectText(child)))
    .join('');

const renderDrawer = (containerId: string | null = 'c-1', b: FarmContainerBeaconView = beacon()) => {
  let renderer: ReactTestRenderer;
  act(() => {
    renderer = create(<BeaconDetailBody beacon={b} containerId={containerId} />);
  });
  return renderer!;
};

describe('BeaconDetailBody 完整请求体展开深度 (farm-beacon-body-expand-depth)', () => {
  beforeEach(() => {
    // 默认返回完整 body；不打开抽屉「查看完整请求体」段时不会被 render（组件按 showFullBody 门控）。
    useFarmBeaconRedactedBodyMock.mockReturnValue({
      data: redactedBody(),
      loading: false,
      error: '',
      reload: async () => {},
    });
  });

  it('点「查看完整请求体」后 full 视图全展开：event 字段键+值真实可见，非一排空 {}', () => {
    const renderer = renderDrawer('c-1');

    // 入口在（beacon_id + containerId 齐备）。
    const toggle = firstByTestId(renderer, 'farm-telemetry-drawer-full-body-toggle');
    expect(toggle).toBeDefined();

    // 点开前完整 body 树未挂载（仅上方预览）。
    expect(nodesByTestId(renderer, 'farm-telemetry-drawer-full-body-preview-tree')).toHaveLength(0);

    // 点「查看完整请求体」。
    act(() => {
      (toggle!.props.onClick as () => void)();
    });

    // 完整 body 折叠树已渲染。
    const fullTree = firstByTestId(renderer, 'farm-telemetry-drawer-full-body-preview-tree');
    expect(fullTree).toBeDefined();

    // 核心断言：full 视图全展开——event 对象里的指纹字段**键与值**都作为可见文本渲染，
    // 回归此前 level<2 把每个 event（level2）折叠成空 `{}`、指纹字段全不可见的 bug。
    const text = collectText(fullTree!);
    for (const token of [
      'event_name',
      'model',
      'device_id',
      'env',
      'tengu_startup',
      'claude-sonnet-4-5-20250929',
      'tengu_api_success',
      'claude-opus-4-1-20250805',
    ]) {
      expect(text).toContain(token);
    }
  });

  it('preview 视图维持浅展开：body_preview 折叠树只展开顶层，深层 event 字段不铺开', () => {
    const b = beacon({
      body_preview: JSON.stringify({
        events: [
          {
            event_type: 'statsig::log_event',
            event_data: { event_name: 'tengu_startup', model: 'claude-sonnet-4-5-preview' },
          },
        ],
      }),
    });
    const renderer = renderDrawer('c-1', b);

    const previewTree = firstByTestId(renderer, 'farm-telemetry-drawer-body-preview-tree');
    expect(previewTree).toBeDefined();

    const text = collectText(previewTree!);
    // 浅展开：顶层 `events` 键可见，但每个 event（level2）折叠，深层 model 值不铺开
    // （证明 preview / full 分档生效，preview 不被一刀切改深）。
    expect(text).toContain('events');
    expect(text).not.toContain('claude-sonnet-4-5-preview');
  });

  it('缺 containerId 时不渲染「查看完整请求体」入口（优雅降级，仅保留预览）', () => {
    const renderer = renderDrawer(null);
    expect(nodesByTestId(renderer, 'farm-telemetry-drawer-full-body-toggle')).toHaveLength(0);
    // 预览仍在。
    expect(nodesByTestId(renderer, 'farm-telemetry-drawer-body-preview')).toHaveLength(1);
  });
});
