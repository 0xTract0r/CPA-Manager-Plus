import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';

// scenario ① 覆盖：OAuth 新增账号的代理查重(L2) 改为「软提醒 + 弹框确认」，不再强制拦截。
//  - 查重命中（同类型现有账号已用同一代理）→ 照常跑连通性探针；探针通过后弹一次确认框，
//    文案带占用账号数 + 账号名；确认 → 进 OAuth（调 oauthApi.startAuth），取消 → 停在原地。
//  - 查重不命中 / 跨类型复用 → 不弹框，探针 ok:true 直接进 OAuth。
// 保留真实 findProxyDuplicateUsage / toProxyOwnerAccount，只 mock 慢的 runProxyPreflight。

const { mocks } = vi.hoisted(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  return {
    mocks: {
      startAuth: vi.fn(),
      authFilesList: vi.fn(),
      runProxyPreflight: vi.fn(),
      showNotification: vi.fn(),
      showConfirmation: vi.fn(),
      navigate: vi.fn(),
    },
  };
});

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({
    // 把 count / accounts 插值拼进返回值，便于断言文案带占用账号数与账号名。
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key === 'proxy_preflight.duplicate_account_separator') return '、';
      if (opts && typeof opts.accounts === 'string') return `${key}|${String(opts.count)}|${opts.accounts}`;
      return key;
    },
  }),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
}));

vi.mock('@/stores', () => ({
  useNotificationStore: () => ({
    showNotification: mocks.showNotification,
    showConfirmation: mocks.showConfirmation,
  }),
  useAuthStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      connectionStatus: 'disconnected',
      apiBase: 'http://manager.local',
      supportsPlugin: false,
    }),
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

type ConfirmationOptions = {
  title?: string;
  message: string;
  onConfirm: () => void;
  onCancel?: () => void;
};

const SHARED_FILES = {
  files: [
    { name: 'ph01.json', type: 'codex', account_settings: { proxy_url: PROXY, note: 'GPT-PH-01' } },
    { name: 'ph02.json', type: 'codex', account_settings: { proxy_url: PROXY, note: 'GPT-PH-02' } },
  ],
};

beforeEach(() => {
  mocks.startAuth.mockReset();
  mocks.authFilesList.mockReset();
  mocks.runProxyPreflight.mockReset();
  mocks.showNotification.mockReset();
  mocks.showConfirmation.mockReset();
  mocks.navigate.mockReset();
});

// 填代理并点开始认证；点击 promise 会挂在确认框上，故不在这里 await 它。
const startWithSharedProxy = async () => {
  mocks.authFilesList.mockResolvedValue(SHARED_FILES);
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
  let clickDone!: Promise<unknown>;
  await act(async () => {
    clickDone = findLoginButton(renderer).props.onClick();
  });
  return { renderer, clickDone };
};

describe('OAuthPage 新增账号起 OAuth 前的代理查重提醒 (scenario ①)', () => {
  it('查重命中 → 照常探针；探针通过后弹一次确认框（带占用账号数 + 账号名），确认后进 OAuth', async () => {
    const { renderer, clickDone } = await startWithSharedProxy();

    // 查重不再 fail-fast：连通性探针照常跑。
    expect(mocks.runProxyPreflight).toHaveBeenCalledTimes(1);
    // 不再报「重复即拦截」的错误。
    const dupError = mocks.showNotification.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('duplicate')
    );
    expect(dupError).toBeUndefined();
    // 弹出确认框：文案带占用账号数(2) + 账号名；确认前不进 OAuth。
    expect(mocks.showConfirmation).toHaveBeenCalledTimes(1);
    const options = mocks.showConfirmation.mock.calls[0][0] as ConfirmationOptions;
    expect(options.title).toBe('proxy_preflight.duplicate_confirm_title');
    expect(options.message).toBe('proxy_preflight.duplicate_confirm_message|2|GPT-PH-01、GPT-PH-02');
    expect(mocks.startAuth).not.toHaveBeenCalled();
    // 就地警告带次数 + 账号名，且不是错误（无红框）。
    const input = findProxyInput(renderer);
    expect(input.props.warning).toBe('proxy_preflight.duplicate_account|2|GPT-PH-01、GPT-PH-02');
    expect(input.props.error).toBeUndefined();

    await act(async () => {
      options.onConfirm();
      await clickDone;
    });

    // 确认后照原流程进 OAuth，且不再二次确认、不重跑探针。
    expect(mocks.startAuth).toHaveBeenCalledTimes(1);
    expect(mocks.startAuth).toHaveBeenCalledWith(
      'codex',
      expect.objectContaining({ proxyUrl: PROXY })
    );
    expect(mocks.showConfirmation).toHaveBeenCalledTimes(1);
    expect(mocks.runProxyPreflight).toHaveBeenCalledTimes(1);

    await act(async () => {
      renderer.unmount();
    });
  });

  it('查重命中 → 确认框点取消 → 不进 OAuth、停在原地', async () => {
    const { renderer, clickDone } = await startWithSharedProxy();

    expect(mocks.showConfirmation).toHaveBeenCalledTimes(1);
    const options = mocks.showConfirmation.mock.calls[0][0] as ConfirmationOptions;
    await act(async () => {
      options.onCancel?.();
      await clickDone;
    });

    expect(mocks.startAuth).not.toHaveBeenCalled();
    // 停在原地：输入值保留、内联状态仍是已连通（可再次点开始认证）。
    const input = findProxyInput(renderer);
    expect(input.props.value).toBe(PROXY);
    expect(findLoginButton(renderer).props.disabled).toBe(false);

    await act(async () => {
      renderer.unmount();
    });
  });

  it('查重命中但探针失败 → 不弹确认框、不进 OAuth（连通性仍是硬门禁）', async () => {
    mocks.authFilesList.mockResolvedValue(SHARED_FILES);
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
    expect(mocks.showConfirmation).not.toHaveBeenCalled();
    expect(mocks.startAuth).not.toHaveBeenCalled();

    await act(async () => {
      renderer.unmount();
    });
  });

  it.each(['codex', 'claude'])('类型 %s：新代理或跨类型复用继续探针及 OAuth', async (provider) => {
    // 现有账号用的是另一个代理 → 不冲突。
    mocks.authFilesList.mockResolvedValue({
      files: [
        {
          name: 'other.json',
          type: provider,
          account_settings: {
            proxy_url: provider === 'claude' ? PROXY : 'http://other:8080',
            note: 'AC-15',
          },
        },
      ],
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
    // 无同类型占用 → 不弹确认框、无就地警告。
    expect(mocks.showConfirmation).not.toHaveBeenCalled();
    expect(findProxyInput(renderer).props.warning).toBeUndefined();

    await act(async () => {
      renderer.unmount();
    });
  });
});
