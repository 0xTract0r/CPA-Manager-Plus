import { act, type ReactNode } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Button } from '@/components/ui/Button';

// 反关联回归（openspec fix-oauth-egress-anticorr 漏洞 1-Codex）：
// Codex 卡片「重新登录」弹窗必须把目标账号文件名作为 auth_name 传给 core，
// core 才会用该账号自己的 proxy_url 换 token；目标账号代理为空 / 非法 / 不存在时
// core 返回 400，弹窗必须给出明确中文错误，不能静默失败或显示成功。
// 弹窗是 QuotaPage / AuthFilesPage / 两个 Codex 巡检页共用的唯一入口，这里直接测弹窗本身。

const { mocks } = vi.hoisted(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  return {
    mocks: {
      startAuth: vi.fn(),
      getAuthStatus: vi.fn(),
      submitCallback: vi.fn(),
      showNotification: vi.fn(),
    },
  };
});

// t 必须是稳定引用（与真实 react-i18next 一致），否则 loadAuthLink 依赖每次渲染都变，
// 打开弹窗的 effect 会反复重跑、多次调用 startAuth。
const stableT = (key: string) => key;
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: stableT }),
}));

vi.mock('@/components/ui/Modal', () => ({
  Modal: (props: { children: ReactNode; footer?: ReactNode }) => (
    <div>
      <div>{props.children}</div>
      <div>{props.footer}</div>
    </div>
  ),
}));

// AccountIdentity 的 tooltip 依赖浏览器事件 API（node 环境没有 window.addEventListener），
// 与本测试关注的取链接逻辑无关，替换成纯展示。
vi.mock('@/components/ui/AccountIdentity', () => ({
  AccountIdentity: () => <span />,
}));

vi.mock('@/services/api', () => ({
  oauthApi: {
    startAuth: mocks.startAuth,
    getAuthStatus: mocks.getAuthStatus,
    submitCallback: mocks.submitCallback,
  },
}));

vi.mock('@/stores', () => ({
  useNotificationStore: (
    selector: (state: { showNotification: typeof mocks.showNotification }) => unknown
  ) => selector({ showNotification: mocks.showNotification }),
}));

vi.mock('@/utils/clipboard', () => ({
  copyToClipboard: vi.fn(async () => true),
}));

import { CodexReauthDialog } from './CodexReauthDialog';
import type { CodexReauthTarget } from './codexReauthModel';

const TARGET_FILE = 'codex-target@example.com-pro.json';

const buildTarget = (overrides: Partial<CodexReauthTarget> = {}): CodexReauthTarget => ({
  account: 'target@example.com',
  email: 'target@example.com',
  note: 'GPT-US-01',
  fileName: TARGET_FILE,
  authIndex: '7',
  accountId: 'acct-1',
  ...overrides,
});

// 模拟 apiClient.handleError 归一化后的 ApiError（带 HTTP status）。
const apiError = (status: number, message: string) =>
  Object.assign(new Error(message), { name: 'ApiError', status });

const mountDialog = async (target: CodexReauthTarget) => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<CodexReauthDialog open target={target} onClose={() => {}} />);
  });
  // 弹窗打开后用 setTimeout(0) 触发首次取链接，推进计时器并冲刷 startAuth 的 promise。
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  return renderer;
};

const textOf = (renderer: ReactTestRenderer) => JSON.stringify(renderer.toJSON());

const findButton = (renderer: ReactTestRenderer, label: string) => {
  const button = renderer.root.findAllByType(Button).find((node) => {
    const children = node.props.children as ReactNode;
    return Array.isArray(children) ? children.includes(label) : children === label;
  });
  if (!button) throw new Error(`button not found: ${label}`);
  return button;
};

beforeEach(() => {
  vi.stubGlobal('window', globalThis);
  vi.useFakeTimers();
  mocks.startAuth.mockReset();
  mocks.getAuthStatus.mockReset();
  mocks.submitCallback.mockReset();
  mocks.showNotification.mockReset();
  mocks.getAuthStatus.mockResolvedValue({ status: 'wait' });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('CodexReauthDialog 按目标账号发起重新认证', () => {
  it('startAuth 带目标账号文件名作为 authName', async () => {
    mocks.startAuth.mockResolvedValue({ url: 'https://auth.example/login', state: 'st-1' });

    const renderer = await mountDialog(buildTarget());

    expect(mocks.startAuth).toHaveBeenCalledTimes(1);
    expect(mocks.startAuth).toHaveBeenCalledWith(
      'codex',
      expect.objectContaining({ authName: TARGET_FILE })
    );
    expect(textOf(renderer)).toContain('codex_reauth.waiting');

    await act(async () => {
      renderer.unmount();
    });
  });

  it('「重新获取链接」同样带目标账号 authName', async () => {
    mocks.startAuth.mockResolvedValue({ url: 'https://auth.example/login', state: 'st-1' });

    const renderer = await mountDialog(buildTarget());
    await act(async () => {
      findButton(renderer, 'codex_reauth.refresh_link').props.onClick();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(mocks.startAuth).toHaveBeenCalledTimes(2);
    for (const call of mocks.startAuth.mock.calls) {
      expect(call).toEqual(['codex', expect.objectContaining({ authName: TARGET_FILE })]);
    }

    await act(async () => {
      renderer.unmount();
    });
  });

  it('后端 400（目标账号无有效代理）→ 显示明确中文错误，不显示成功、不可打开链接', async () => {
    mocks.startAuth.mockRejectedValue(apiError(400, 'target auth proxy_url is empty'));

    const renderer = await mountDialog(buildTarget());
    const text = textOf(renderer);

    expect(text).toContain('codex_reauth.proxy_rejected');
    expect(text).not.toContain('codex_reauth.success');
    expect(text).not.toContain('codex_reauth.waiting');
    expect(findButton(renderer, 'codex_reauth.open_link').props.disabled).toBe(true);
    expect(mocks.getAuthStatus).not.toHaveBeenCalled();

    const errorNotifications = mocks.showNotification.mock.calls.filter(
      ([, type]) => type === 'error'
    );
    expect(errorNotifications).toHaveLength(1);
    expect(String(errorNotifications[0][0])).toContain('codex_reauth.proxy_rejected');
    expect(
      mocks.showNotification.mock.calls.some(([, type]) => type === 'success')
    ).toBe(false);

    await act(async () => {
      renderer.unmount();
    });
  });

  it('非 400 错误仍显示后端原始信息（不被代理文案吞掉）', async () => {
    mocks.startAuth.mockRejectedValue(apiError(500, 'upstream exploded'));

    const renderer = await mountDialog(buildTarget());
    const text = textOf(renderer);

    expect(text).toContain('upstream exploded');
    expect(text).not.toContain('codex_reauth.proxy_rejected');

    await act(async () => {
      renderer.unmount();
    });
  });

  it('目标缺少文件名 → fail-closed，不发起无目标的 OAuth', async () => {
    const renderer = await mountDialog(buildTarget({ fileName: '   ' }));

    expect(mocks.startAuth).not.toHaveBeenCalled();
    expect(textOf(renderer)).toContain('codex_reauth.missing_target');
    expect(findButton(renderer, 'codex_reauth.open_link').props.disabled).toBe(true);

    await act(async () => {
      renderer.unmount();
    });
  });
});
