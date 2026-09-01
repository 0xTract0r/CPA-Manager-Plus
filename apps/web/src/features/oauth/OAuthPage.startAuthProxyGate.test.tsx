import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';

// scenario (b) 回归覆盖：OAuth 新增账号在「格式过 → 连通性探针」后，探针不过就不进入 OAuth。
//  - 探针 ok:false → return-before-OAuth，不调 oauthApi.startAuth（fail-closed）。
//  - 探针 ok:true  → 继续进入 OAuth，调 oauthApi.startAuth。
// 全量渲染真实 OAuthPage（照 AuthFilesPage 系列测试的 react-test-renderer + 模块 mock 范式），
// 直接断言 oauthApi.startAuth 的调用/未调用，而不是弱化成只测中间判定。
// 为避免 startPolling 触碰 node 环境不存在的 window，ok:true 用例让 startAuth 返回缺 state 的
// 响应，命中「missing state」早退分支——此时 oauthApi.startAuth 已被调用，断言成立且不触网 window。

const { mocks } = vi.hoisted(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  return {
    mocks: {
      startAuth: vi.fn(),
      authFilesList: vi.fn(),
      runProxyPreflight: vi.fn(),
      showNotification: vi.fn(),
      navigate: vi.fn(),
    },
  };
});

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
}));

vi.mock('@/stores', () => ({
  useNotificationStore: () => ({ showNotification: mocks.showNotification }),
  useAuthStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ connectionStatus: 'disconnected', apiBase: 'http://manager.local', supportsPlugin: false }),
  useThemeStore: (selector: (state: { resolvedTheme: 'light' }) => unknown) =>
    selector({ resolvedTheme: 'light' }),
}));

vi.mock('@/services/api', () => ({
  oauthApi: {
    startAuth: mocks.startAuth,
    getAuthStatus: vi.fn(),
    cancelAuth: vi.fn(),
    submitCallback: vi.fn(),
  },
  pluginsApi: { list: vi.fn().mockResolvedValue({ plugins: [] }) },
  isOAuthCancelSuccessful: () => true,
}));

vi.mock('@/services/api/authFiles', () => ({
  authFilesApi: { list: mocks.authFilesList },
}));

vi.mock('@/services/api/vertex', () => ({
  vertexApi: { importCredential: vi.fn() },
}));

vi.mock('@/utils/clipboard', () => ({
  copyToClipboard: vi.fn(async () => true),
}));

// 只 mock runProxyPreflight（连通性探针），保留真实的 findAccountsUsingProxy / toProxyOwnerAccount
// 查重逻辑；查重的账号来源 authFilesApi.list 已 mock 为空列表 → 无冲突，探针照常执行。
vi.mock('@/utils/proxyPreflight', async (importActual) => ({
  ...(await importActual<typeof import('@/utils/proxyPreflight')>()),
  runProxyPreflight: mocks.runProxyPreflight,
}));

vi.mock('@/features/plugins/pluginResources', () => ({
  getPluginTitle: () => '',
  resolvePluginAssetURL: () => '',
}));

import { OAuthPage } from './OAuthPage';

const PROXY = 'socks5://user:pass@host:1080';

const findProxyInput = (renderer: ReactTestRenderer) => {
  const input = renderer.root
    .findAllByType(Input)
    .find((node) => node.props.label === 'auth_login.account_proxy_label');
  if (!input) throw new Error('proxy input not found');
  return input;
};

const findLoginButton = (renderer: ReactTestRenderer) => {
  const button = renderer.root
    .findAllByType(Button)
    .find((node) => node.props.children === 'auth_login.codex_oauth_button');
  if (!button) throw new Error('login button not found');
  return button;
};

beforeEach(() => {
  mocks.startAuth.mockReset();
  mocks.authFilesList.mockReset();
  mocks.runProxyPreflight.mockReset();
  mocks.showNotification.mockReset();
  mocks.navigate.mockReset();
  mocks.authFilesList.mockResolvedValue({ files: [] });
});

describe('OAuthPage 新增账号起 OAuth 前的连通性门禁 (scenario b)', () => {
  it('探针 ok:false → 不进入 OAuth（不调 oauthApi.startAuth）', async () => {
    mocks.runProxyPreflight.mockResolvedValue({
      ok: false,
      exitIp: '',
      reason: 'dial_failed',
      message: '无法经该代理连通',
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<OAuthPage />);
    });

    act(() => {
      findProxyInput(renderer).props.onChange({ target: { value: PROXY } });
    });
    await act(async () => {
      await findLoginButton(renderer).props.onClick();
    });

    expect(mocks.runProxyPreflight).toHaveBeenCalledTimes(1);
    expect(mocks.startAuth).not.toHaveBeenCalled();

    await act(async () => {
      renderer.unmount();
    });
  });

  it('探针 ok:true → 进入 OAuth（调 oauthApi.startAuth）', async () => {
    mocks.runProxyPreflight.mockResolvedValue({
      ok: true,
      exitIp: '203.0.113.9',
      reason: 'ok',
      message: 'connected',
    });
    // 返回缺 state 的响应 → 命中 missing-state 早退分支，避免 startPolling 触碰 window。
    mocks.startAuth.mockResolvedValue({ url: 'https://auth.example/login', state: undefined });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<OAuthPage />);
    });

    act(() => {
      findProxyInput(renderer).props.onChange({ target: { value: PROXY } });
    });
    await act(async () => {
      await findLoginButton(renderer).props.onClick();
    });

    expect(mocks.runProxyPreflight).toHaveBeenCalledTimes(1);
    expect(mocks.startAuth).toHaveBeenCalledTimes(1);
    expect(mocks.startAuth).toHaveBeenCalledWith(
      'codex',
      expect.objectContaining({ proxyUrl: PROXY })
    );

    await act(async () => {
      renderer.unmount();
    });
  });
});
