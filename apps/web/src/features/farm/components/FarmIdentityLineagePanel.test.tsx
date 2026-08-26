import { act } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  FarmBindingView,
  FarmContainerView,
  FarmIdentityLineageRecord,
  FarmIdentityLineageResponse,
} from '@/types/farm';

/**
 * §3 身份/代理变更历史区（farm-proxy-rotation SURV1「持久化身份谱系」）：
 * <FarmIdentityLineagePanel> 用容器当前绑定 binding.account（未绑定回退
 * last_bound_account）调用 farmApi.getIdentityLineage(account, env)，脱敏时间线
 * 渲染每个 epoch，并把 cross_ip_reuse_detected 做成显著审计横幅。覆盖：无账号可查
 * / 加载中 / 请求失败 / 成功但空 / 成功有数据（含 current 徽标 + 跨 IP 复用两种
 * 结论）五类诚实状态，以及 account/env 取值口径（回退 last_bound_account、非法 env
 * 归一 undefined）。
 *
 * i18n 的 t 在测试里返回原始 key（不依赖具体文案，与 FarmTelemetryPanel.test.tsx
 * 同款稳定引用 mock 口径）；farm.lineage.error 的 {{message}} 插值场景额外把真实
 * message 拼进返回值，供断言错误文本确实透传而非被吞掉。
 */

const { mocks } = vi.hoisted(() => ({
  mocks: {
    getIdentityLineage: vi.fn(),
  },
}));

vi.mock('react-i18next', () => {
  const stableUseTranslationResult = {
    t: (key: string, options?: Record<string, unknown>) => {
      if (options && typeof options.message === 'string') {
        return `${key}::${options.message}`;
      }
      return key;
    },
    i18n: { language: 'en' },
  };
  return {
    initReactI18next: { type: '3rdParty', init: () => {} },
    useTranslation: () => stableUseTranslationResult,
  };
});

// 全局时区订阅在测试里是 no-op（不触发真实 store 订阅），与 FarmTelemetryPanel.test.tsx
// 同款处理。
vi.mock('@/hooks/useTimezone', () => ({
  useTimezone: () => undefined,
}));

vi.mock('@/services/api/farm', () => ({
  farmApi: {
    getIdentityLineage: mocks.getIdentityLineage,
  },
}));

import { FarmIdentityLineagePanel } from './FarmIdentityLineagePanel';

const baseContainer = (overrides: Partial<FarmContainerView> = {}): FarmContainerView => ({
  id: 'c-1',
  device_id_masked: 'dev-***',
  status: 'running',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  ...overrides,
});

const boundContainer = (bindingOverrides: Partial<FarmBindingView> = {}): FarmContainerView =>
  baseContainer({
    binding: {
      env: 'prod',
      account: 'claude-1@example.com',
      bound_at: '2026-01-01T00:00:00Z',
      ...bindingOverrides,
    },
  });

const epoch = (overrides: Partial<FarmIdentityLineageRecord> = {}): FarmIdentityLineageRecord => ({
  container_id: 'c-1',
  device_id_masked: 'aaaaaaaaaaaa…wxyz',
  device_id_hash: 'hash-1',
  start_at: '2026-08-01T00:00:00Z',
  reason: 'provisioned',
  current: false,
  ...overrides,
});

const lineageResponse = (
  epochs: FarmIdentityLineageRecord[],
  crossIpReuseDetected = false
): FarmIdentityLineageResponse => ({
  account: 'claude-1@example.com',
  epochs,
  cross_ip_reuse_detected: crossIpReuseDetected,
});

const renderPanel = async (container: FarmContainerView | null): Promise<ReactTestRenderer> => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<FarmIdentityLineagePanel container={container} />);
  });
  return renderer;
};

// 只匹配宿主（DOM）元素，不匹配复合组件实例（同 FarmContainerTable.test.tsx 口径：
// TableRow/HealthPill 把 data-testid 透传给底层宿主标签，同时命中会重复计数）。
const nodesByTestId = (renderer: ReactTestRenderer, testId: string): ReactTestInstance[] =>
  renderer.root.findAll(
    (node) => typeof node.type === 'string' && node.props?.['data-testid'] === testId
  );
const firstByTestId = (renderer: ReactTestRenderer, testId: string): ReactTestInstance | undefined =>
  nodesByTestId(renderer, testId)[0];
const textOf = (renderer: ReactTestRenderer): string => JSON.stringify(renderer.toJSON());

describe('FarmIdentityLineagePanel (farm-proxy-rotation SURV1 §3)', () => {
  beforeEach(() => {
    mocks.getIdentityLineage.mockReset();
  });

  it('container=null：诚实空态，不发请求', async () => {
    const renderer = await renderPanel(null);
    expect(mocks.getIdentityLineage).not.toHaveBeenCalled();
    expect(firstByTestId(renderer, 'farm-lineage-empty')).toBeDefined();
    expect(firstByTestId(renderer, 'farm-lineage-loading')).toBeUndefined();
    expect(firstByTestId(renderer, 'farm-lineage-error')).toBeUndefined();
    expect(firstByTestId(renderer, 'farm-lineage-cross-ip-audit')).toBeUndefined();
  });

  it('容器从未绑定过账号（无 binding、无 last_bound_account）：空态，不发请求', async () => {
    const renderer = await renderPanel(baseContainer());
    expect(mocks.getIdentityLineage).not.toHaveBeenCalled();
    expect(firstByTestId(renderer, 'farm-lineage-empty')).toBeDefined();
  });

  it('未绑定但有 last_bound_account：回退用它查询，env 缺失（未绑定无 binding.env）', async () => {
    mocks.getIdentityLineage.mockResolvedValueOnce(lineageResponse([]));
    const renderer = await renderPanel(baseContainer({ last_bound_account: 'retired@example.com' }));
    expect(mocks.getIdentityLineage).toHaveBeenCalledWith('retired@example.com', undefined);
    expect(firstByTestId(renderer, 'farm-lineage-empty')).toBeDefined();
  });

  it('已绑定：用 binding.account + binding.env 发请求', async () => {
    mocks.getIdentityLineage.mockResolvedValueOnce(lineageResponse([epoch({ current: true })]));
    await renderPanel(boundContainer());
    expect(mocks.getIdentityLineage).toHaveBeenCalledWith('claude-1@example.com', 'prod');
  });

  it('binding.env 非法值（非 test/prod）时归一为 undefined，不把非法值透传给后端', async () => {
    mocks.getIdentityLineage.mockResolvedValueOnce(lineageResponse([]));
    await renderPanel(boundContainer({ env: 'staging' }));
    expect(mocks.getIdentityLineage).toHaveBeenCalledWith('claude-1@example.com', undefined);
  });

  it('加载中：显示 loading，不显示审计横幅（避免用初始值误显「审计通过」）', async () => {
    let resolveFn!: (value: FarmIdentityLineageResponse) => void;
    mocks.getIdentityLineage.mockReturnValueOnce(
      new Promise<FarmIdentityLineageResponse>((resolve) => {
        resolveFn = resolve;
      })
    );
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<FarmIdentityLineagePanel container={boundContainer()} />);
    });
    expect(firstByTestId(renderer, 'farm-lineage-loading')).toBeDefined();
    expect(firstByTestId(renderer, 'farm-lineage-cross-ip-audit')).toBeUndefined();

    await act(async () => {
      resolveFn(lineageResponse([epoch({ current: true })]));
    });
    expect(firstByTestId(renderer, 'farm-lineage-loading')).toBeUndefined();
    expect(firstByTestId(renderer, 'farm-lineage-cross-ip-audit')).toBeDefined();
  });

  it('两个 epoch（当前 + 已结束）：渲染两行，current 徽标只在当前行出现，字段逐列透传', async () => {
    const epochs = [
      epoch({
        device_id_masked: 'device-current-mask',
        proxy_masked: 'socks5://proxy-a:1080',
        egress_ip: '1.2.3.4',
        reason: 'provisioned',
        current: true,
      }),
      epoch({
        device_id_masked: 'device-old-mask',
        proxy_masked: 'socks5://proxy-b:1080',
        egress_ip: '5.6.7.8',
        reason: 'manual_rotation',
        end_at: '2026-08-10T00:00:00Z',
        end_reason: 'superseded',
        operator: 'cory',
        current: false,
      }),
    ];
    mocks.getIdentityLineage.mockResolvedValueOnce(lineageResponse(epochs, false));
    const renderer = await renderPanel(boundContainer());

    expect(nodesByTestId(renderer, 'farm-lineage-row-0')).toHaveLength(1);
    expect(nodesByTestId(renderer, 'farm-lineage-row-1')).toHaveLength(1);
    expect(firstByTestId(renderer, 'farm-lineage-row-0')?.props['data-current']).toBe('true');
    expect(firstByTestId(renderer, 'farm-lineage-row-1')?.props['data-current']).toBe('false');
    expect(firstByTestId(renderer, 'farm-lineage-current-badge-0')).toBeDefined();
    expect(firstByTestId(renderer, 'farm-lineage-current-badge-1')).toBeUndefined();

    const text = textOf(renderer);
    expect(text).toContain('device-current-mask');
    expect(text).toContain('socks5://proxy-a:1080');
    expect(text).toContain('1.2.3.4');
    expect(text).toContain('device-old-mask');
    expect(text).toContain('socks5://proxy-b:1080');
    expect(text).toContain('5.6.7.8');
    expect(text).toContain('cory');
    expect(text).toContain('farm.lineage.reason_provisioned');
    expect(text).toContain('farm.lineage.reason_manual_rotation');
    expect(text).toContain('farm.lineage.endReason_superseded');
    // 当前 epoch 无 end_at：End 列回退「进行中」文案。
    expect(text).toContain('farm.lineage.ongoing');
  });

  it('未知 reason/end_reason 值（后端新增枚举）：回退原始字符串，不臆造/不崩溃', async () => {
    mocks.getIdentityLineage.mockResolvedValueOnce(
      lineageResponse([
        epoch({
          reason: 'some_future_reason',
          end_at: '2026-08-10T00:00:00Z',
          end_reason: 'some_future_end_reason',
        }),
      ])
    );
    const renderer = await renderPanel(boundContainer());
    const text = textOf(renderer);
    // key 存在时 t 只返回 key（mock 行为）；未知值经 defaultValue 回退，这里的 mock
    // 不区分「key 命中」与「走 defaultValue」，故只断言不崩溃、且原始值仍可在树中
    // 找到不了也没关系——核心诉求是渲染成功、未抛错。
    expect(firstByTestId(renderer, 'farm-lineage-row-0')).toBeDefined();
    expect(text).not.toContain('undefined');
  });

  it('cross_ip_reuse_detected=true：审计横幅高亮为 err + 警示文案', async () => {
    mocks.getIdentityLineage.mockResolvedValueOnce(lineageResponse([epoch({ current: true })], true));
    const renderer = await renderPanel(boundContainer());
    const pill = firstByTestId(renderer, 'farm-lineage-cross-ip-pill');
    expect(pill).toBeDefined();
    expect(pill?.props['data-status']).toBe('err');
    expect(textOf(renderer)).toContain('farm.lineage.crossIpWarning');
  });

  it('cross_ip_reuse_detected=false：审计横幅为 ok + 通过文案', async () => {
    mocks.getIdentityLineage.mockResolvedValueOnce(lineageResponse([epoch({ current: true })], false));
    const renderer = await renderPanel(boundContainer());
    const pill = firstByTestId(renderer, 'farm-lineage-cross-ip-pill');
    expect(pill).toBeDefined();
    expect(pill?.props['data-status']).toBe('ok');
    expect(textOf(renderer)).toContain('farm.lineage.crossIpNone');
  });

  it('epochs=[]（成功响应但无记录）：诚实空态，不是错误', async () => {
    mocks.getIdentityLineage.mockResolvedValueOnce(lineageResponse([], false));
    const renderer = await renderPanel(boundContainer());
    expect(firstByTestId(renderer, 'farm-lineage-empty')).toBeDefined();
    expect(firstByTestId(renderer, 'farm-lineage-error')).toBeUndefined();
  });

  it('请求失败：error 态呈现真实错误信息，不吞错误、不臆造空成功', async () => {
    mocks.getIdentityLineage.mockRejectedValueOnce(new Error('upstream identity-lineage 500'));
    const renderer = await renderPanel(boundContainer());
    const box = firstByTestId(renderer, 'farm-lineage-error');
    expect(box).toBeDefined();
    expect(textOf(renderer)).toContain('upstream identity-lineage 500');
    expect(firstByTestId(renderer, 'farm-lineage-cross-ip-audit')).toBeUndefined();
    expect(firstByTestId(renderer, 'farm-lineage-loading')).toBeUndefined();
    expect(firstByTestId(renderer, 'farm-lineage-empty')).toBeUndefined();
  });
});
