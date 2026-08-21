import { act } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { FarmContainerView } from '@/types/farm';
import { FarmContainerTable } from './FarmContainerTable';

/**
 * 回归测试：容器池「过滤后为空」与「池真空」必须是两种不同措辞（零配置改造
 * bullet 5）。之前两种情况共用同一句「容器池为空」，用户在非默认分组下（如
 * 只看『异常』）看到这句话会误以为整个农场没有任何容器，实际上只是当前分组
 * 恰好没有匹配项。
 *
 * groupFilter 固定用非 'all'/'retired' 的具名分组（如 'degraded'），避免触发
 * useFarmRetiredContainers 的按需拉取（enabled=false 时该 hook 不发请求，
 * 测试无需再 mock farmApi）。
 */

// useTranslation() 的返回值必须在多次调用间保持引用稳定（真实
// react-i18next 就是如此）：FarmContainerTable 渲染树里的
// useFarmRetiredContainers 把 `t` 放进 useCallback 依赖数组并驱动
// useEffect；如果这里每次调用都返回新对象/新函数引用，会让该 effect
// 每次渲染都以为依赖变了而重新触发 setState，形成无限重渲染循环
// （实测：不稳定引用会导致该测试文件 OOM 崩溃退出）。常量必须声明在
// factory 内部（而非 vi.mock 外层顶层变量）——vi.mock 会被提升到文件
// import 之前执行，引用外层同文件的顶层 const 会触发 TDZ 报错。
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

const baseContainer = (overrides: Partial<FarmContainerView> & { id: string }): FarmContainerView => ({
  device_id_masked: 'dev-***',
  status: 'running',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  ...overrides,
});

const noop = () => undefined;

const renderTable = (props: Partial<Parameters<typeof FarmContainerTable>[0]> = {}) => {
  let renderer: ReactTestRenderer;
  act(() => {
    renderer = create(
      <FarmContainerTable
        containers={[]}
        loading={false}
        error=""
        unbindingContainerId={null}
        retiringContainerId={null}
        onBind={noop}
        onUnbind={noop}
        onRetire={noop}
        groupFilter="degraded"
        onGroupFilterChange={noop}
        {...props}
      />
    );
  });
  return renderer!;
};

// 只匹配宿主（DOM）元素，不匹配复合组件实例：react-test-renderer 的
// `findAll` 会遍历整棵测试实例树，宿主元素与转发同一个 `data-testid` 的
// 复合组件实例（例如 TableRow 把 `data-testid` 放进 `...rest` 再透传给
// 底层 `<tr>`）会被同时命中，导致同一处只算一个可见节点却被计数两次。
const findByTestId = (renderer: ReactTestRenderer, testId: string): ReactTestInstance[] =>
  renderer.root.findAll(
    (node) => typeof node.type === 'string' && node.props?.['data-testid'] === testId
  );

describe('FarmContainerTable empty states', () => {
  it('shows the pool-empty state when the container pool itself has no containers', () => {
    const renderer = renderTable({ containers: [] });

    expect(findByTestId(renderer, 'farm-containers-empty')).toHaveLength(1);
    expect(findByTestId(renderer, 'farm-containers-filtered-empty')).toHaveLength(0);
  });

  it('shows the filtered-empty state when the pool has containers but none match the active filter', () => {
    const renderer = renderTable({
      containers: [baseContainer({ id: 'c-1', status: 'running' })],
      groupFilter: 'degraded',
    });

    expect(findByTestId(renderer, 'farm-containers-filtered-empty')).toHaveLength(1);
    expect(findByTestId(renderer, 'farm-containers-empty')).toHaveLength(0);
  });

  it('renders matching rows (no empty state) when the filter has at least one match', () => {
    const renderer = renderTable({
      containers: [baseContainer({ id: 'c-1', status: 'degraded' })],
      groupFilter: 'degraded',
    });

    expect(findByTestId(renderer, 'farm-containers-empty')).toHaveLength(0);
    expect(findByTestId(renderer, 'farm-containers-filtered-empty')).toHaveLength(0);
    expect(findByTestId(renderer, 'farm-container-row-c-1')).toHaveLength(1);
  });
});

// R5-2 改绑防误绑（回显上次绑定）：解绑过的 down 容器带 last_bound_account 时，
// 绑定列回显「上次绑定：<脱敏账号>（已解绑）」，而不是空占位或裸 device_id。
describe('FarmContainerTable last-bound回显 (R5-2)', () => {
  it('shows the last-bound line for an unbound down container carrying last_bound_account', () => {
    const renderer = renderTable({
      containers: [
        baseContainer({ id: 'c-9', status: 'down', last_bound_account: 'acct9@example.com' }),
      ],
      groupFilter: 'down',
    });

    expect(findByTestId(renderer, 'farm-container-last-bound-c-9')).toHaveLength(1);
  });

  it('omits the last-bound line when the unbound container has no last_bound_account', () => {
    const renderer = renderTable({
      containers: [baseContainer({ id: 'c-10', status: 'down' })],
      groupFilter: 'down',
    });

    expect(findByTestId(renderer, 'farm-container-last-bound-c-10')).toHaveLength(0);
  });
});
