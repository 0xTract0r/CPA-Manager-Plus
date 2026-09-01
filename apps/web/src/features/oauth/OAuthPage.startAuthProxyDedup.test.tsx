import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';

// scenario ① 覆盖：OAuth 新增账号在「格式过 → 二级查重(L2) → 连通性探针(L1)」流程中，
// 查重命中就 fail-fast——不调连通性探针、不调 oauthApi.startAuth，报错含冲突账号名。
//  - 查重命中（现有账号已用同一代理）→ return-before-probe：runProxyPreflight / startAuth 均不调。
//  - 查重不命中 → 继续到连通性探针 → 探针 ok:true 才进 OAuth。
// 保留真实 findAccountsUsingProxy / toProxyOwnerAccount，只 mock 慢的 runProxyPreflight，
// 直接断言查重先于连通性（L2 在 L1 之前）。

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
  useTranslation: () => ({
    // 让带 accounts 插值参数的 key 把冲突账号名拼进返回值，便于断言「报错含冲突账号名」。
    t: (key: string, opts?: Record<string, unknown>) =>
      opts && typeof opts.accounts === 'string' ? `${key}|${opts.accounts}` : key,
  }),
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

// 保留真实查重逻辑，只切断慢的连通性探针。
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
});

describe('OAuthPage 新增账号起 OAuth 前的代理查重门禁 (scenario ①)', () => {
  it('查重命中（现有账号已用同一代理）→ 不进探针、不进 OAuth，报错含冲突账号名', async () => {
    // 现有账号 AC-14 已经在用同一代理（列表内联 account_settings.proxy_url）。
    mocks.authFilesList.mockResolvedValue({
      files: [{ name: 'ac14.json', account_settings: { proxy_url: PROXY, note: 'AC-14' } }],
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

    // L2 在 L1 之前 fail-fast：查重命中 → 连通性探针与 OAuth 均未触发。
    expect(mocks.runProxyPreflight).not.toHaveBeenCalled();
    expect(mocks.startAuth).not.toHaveBeenCalled();
    // 报错含冲突账号名（AC-14）。
    const errorCall = mocks.showNotification.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('AC-14')
    );
    expect(errorCall).toBeTruthy();
    expect(errorCall?.[1]).toBe('error');

    await act(async () => {
      renderer.unmount();
    });
  });

  it('查重不命中 → 继续到连通性探针（探针 ok:true 进 OAuth）', async () => {
    // 现有账号用的是另一个代理 → 不冲突。
    mocks.authFilesList.mockResolvedValue({
      files: [{ name: 'other.json', account_settings: { proxy_url: 'http://other:8080', note: 'AC-15' } }],
    });
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

    await act(async () => {
      renderer.unmount();
    });
  });
});
