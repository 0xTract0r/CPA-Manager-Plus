import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';

// OAuth 新增账号「代理输入框内联实时校验」覆盖：
//  - blur 触发主校验路径（格式→查重(软提醒)→连通性探针）+ 就地展示；
//  - 查重命中只就地展示带次数的警告（不标红、不禁用按钮），探针照常跑；
//  - 提交（开始认证）改为读取内联校验状态门控：已通过直接放行不重跑探针、校验中拦住、
//    失败拦住不重跑；已通过但有占用 → 弹一次确认框后再进 OAuth。
// 保留真实 findProxyDuplicateUsage / toProxyOwnerAccount / runProxyInlineChecks，只 mock 慢的
// runProxyPreflight（连通性探针）；查重账号来源 authFilesApi.list 按用例注入。

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
    // 把 count / accounts / ip 插值参数拼进返回值，便于断言「警告含占用账号数与账号名 / 出口 IP」。
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key === 'proxy_preflight.duplicate_account_separator') return '、';
      if (opts && typeof opts.accounts === 'string') return `${key}|${String(opts.count)}|${opts.accounts}`;
      if (opts && (typeof opts.ip === 'string' || typeof opts.ip === 'number'))
        return `${key}|${opts.ip}`;
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

// 只 mock runProxyPreflight（连通性探针），保留真实查重逻辑（runProxyInlineChecks 内部经它触发探针）。
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

const proxyStatusNodes = (renderer: ReactTestRenderer) =>
  renderer.root.findAll(
    (node) =>
      typeof node.props?.['data-testid'] === 'string' &&
      node.props['data-testid'] === 'oauth-proxy-status-codex'
  );

const setProxy = (renderer: ReactTestRenderer, value: string) => {
  act(() => {
    findProxyInput(renderer).props.onChange({ target: { value } });
  });
};

const blurProxy = async (renderer: ReactTestRenderer) => {
  await act(async () => {
    await findProxyInput(renderer).props.onBlur();
  });
};

beforeEach(() => {
  mocks.startAuth.mockReset();
  mocks.authFilesList.mockReset();
  mocks.runProxyPreflight.mockReset();
  mocks.showNotification.mockReset();
  mocks.showConfirmation.mockReset();
  mocks.navigate.mockReset();
  mocks.authFilesList.mockResolvedValue({ files: [] });
});

describe('OAuthPage 代理输入框内联实时校验（失焦触发 + 提交门控）', () => {
  it('blur 填非法格式 → 就地标红、不发探针', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<OAuthPage />);
    });

    setProxy(renderer, 'not a url');
    await blurProxy(renderer);

    expect(mocks.runProxyPreflight).not.toHaveBeenCalled();
    expect(findProxyInput(renderer).props.error).toBe('auth_login.account_proxy_invalid');

    await act(async () => renderer.unmount());
  });

  it('blur 填重复代理 → 就地展示带次数的警告（非错误）、照常探针、开始按钮不禁用', async () => {
    mocks.authFilesList.mockResolvedValue({
      files: [
        { name: 'ph01.json', type: 'codex', account_settings: { proxy_url: PROXY, note: 'GPT-PH-01' } },
        { name: 'ph02.json', type: 'codex', account_settings: { proxy_url: PROXY, note: 'GPT-PH-02' } },
      ],
    });
    mocks.runProxyPreflight.mockResolvedValue({
      ok: true,
      exitIp: '203.0.113.9',
      reason: 'ok',
      message: 'proxy_preflight.reason_ok',
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<OAuthPage />);
    });

    setProxy(renderer, PROXY);
    await blurProxy(renderer);

    // 查重命中不再阻断探针。
    expect(mocks.runProxyPreflight).toHaveBeenCalledTimes(1);
    const input = findProxyInput(renderer);
    // 不是错误：无红框。
    expect(input.props.error).toBeUndefined();
    // 警告带占用账号数 + 账号名。
    expect(input.props.warning).toBe('proxy_preflight.duplicate_account|2|GPT-PH-01、GPT-PH-02');
    // 连通性结果照常展示（已连通 + 出口 IP），开始按钮可点。
    const okNodes = proxyStatusNodes(renderer).filter(
      (node) => node.props['data-proxy-phase'] === 'ok'
    );
    expect(okNodes.length).toBe(1);
    expect(findLoginButton(renderer).props.disabled).toBe(false);
    // blur 阶段只提醒，不弹确认框。
    expect(mocks.showConfirmation).not.toHaveBeenCalled();

    await act(async () => renderer.unmount());
  });

  it('blur 已校验通过但有占用 → 点开始认证弹一次确认框，确认后进 OAuth 且不重跑探针', async () => {
    mocks.authFilesList.mockResolvedValue({
      files: [
        { name: 'ph01.json', type: 'codex', account_settings: { proxy_url: PROXY, note: 'GPT-PH-01' } },
      ],
    });
    mocks.runProxyPreflight.mockResolvedValue({
      ok: true,
      exitIp: '203.0.113.9',
      reason: 'ok',
      message: 'proxy_preflight.reason_ok',
    });
    mocks.startAuth.mockResolvedValue({ url: 'https://auth.example/login', state: undefined });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<OAuthPage />);
    });

    setProxy(renderer, PROXY);
    await blurProxy(renderer);
    expect(mocks.runProxyPreflight).toHaveBeenCalledTimes(1);

    let clickDone!: Promise<unknown>;
    await act(async () => {
      clickDone = findLoginButton(renderer).props.onClick();
    });
    expect(mocks.showConfirmation).toHaveBeenCalledTimes(1);
    const options = mocks.showConfirmation.mock.calls[0][0] as {
      message: string;
      onConfirm: () => void;
    };
    expect(options.message).toBe('proxy_preflight.duplicate_confirm_message|1|GPT-PH-01');
    expect(mocks.startAuth).not.toHaveBeenCalled();

    await act(async () => {
      options.onConfirm();
      await clickDone;
    });
    expect(mocks.startAuth).toHaveBeenCalledTimes(1);
    expect(mocks.runProxyPreflight).toHaveBeenCalledTimes(1);
    expect(mocks.showConfirmation).toHaveBeenCalledTimes(1);

    await act(async () => renderer.unmount());
  });

  it('blur 填不可达代理 → 探针一次、就地标红连通失败；随后点开始认证被拦住且不重跑探针', async () => {
    mocks.runProxyPreflight.mockResolvedValue({
      ok: false,
      exitIp: '',
      reason: 'timeout',
      message: 'proxy_preflight.reason_timeout',
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<OAuthPage />);
    });

    setProxy(renderer, PROXY);
    await blurProxy(renderer);

    expect(mocks.runProxyPreflight).toHaveBeenCalledTimes(1);
    expect(findProxyInput(renderer).props.error).toBe('proxy_preflight.reason_timeout');

    // 提交门控：失败态点开始认证 → 拦住、不进 OAuth、不重跑探针。
    await act(async () => {
      await findLoginButton(renderer).props.onClick();
    });
    expect(mocks.startAuth).not.toHaveBeenCalled();
    expect(mocks.runProxyPreflight).toHaveBeenCalledTimes(1);

    await act(async () => renderer.unmount());
  });

  it('blur 填可达代理 → 探针一次、就地展示出口 IP；随后点开始认证直接放行、不重跑探针', async () => {
    mocks.runProxyPreflight.mockResolvedValue({
      ok: true,
      exitIp: '203.0.113.9',
      reason: 'ok',
      message: 'proxy_preflight.reason_ok',
    });
    // 返回缺 state 的响应 → 命中 missing-state 早退分支（此时 startAuth 已被调用），避免 startPolling 触碰 window。
    mocks.startAuth.mockResolvedValue({ url: 'https://auth.example/login', state: undefined });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<OAuthPage />);
    });

    setProxy(renderer, PROXY);
    await blurProxy(renderer);

    expect(mocks.runProxyPreflight).toHaveBeenCalledTimes(1);
    // 就地状态区展示「已连通 + 出口 IP」（success 徽标）。
    const okNodes = proxyStatusNodes(renderer).filter(
      (node) => node.props['data-proxy-phase'] === 'ok'
    );
    expect(okNodes.length).toBe(1);
    expect(JSON.stringify(okNodes[0].props.children)).toContain('203.0.113.9');
    // 无 error 红框。
    expect(findProxyInput(renderer).props.error).toBeUndefined();

    // 提交门控：已校验通过 → 直接放行进 OAuth，不重跑探针。
    await act(async () => {
      await findLoginButton(renderer).props.onClick();
    });
    expect(mocks.startAuth).toHaveBeenCalledTimes(1);
    expect(mocks.startAuth).toHaveBeenCalledWith(
      'codex',
      expect.objectContaining({ proxyUrl: PROXY })
    );
    expect(mocks.runProxyPreflight).toHaveBeenCalledTimes(1);

    await act(async () => renderer.unmount());
  });

  it('校验中点开始认证 → 拦住提示「验证中」，不进 OAuth', async () => {
    // 查重列表 pending（永不 resolve）→ 停在「校验中(查重)」，探针尚未触发。
    mocks.authFilesList.mockReturnValue(new Promise<{ files: unknown[] }>(() => {}));

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<OAuthPage />);
    });

    setProxy(renderer, PROXY);
    // 不 await 完成：blur 后立即处于 checking。
    act(() => {
      void findProxyInput(renderer).props.onBlur();
    });

    const checkingNodes = proxyStatusNodes(renderer).filter(
      (node) => node.props['data-proxy-phase'] === 'checking'
    );
    expect(checkingNodes.length).toBe(1);

    await act(async () => {
      await findLoginButton(renderer).props.onClick();
    });
    expect(mocks.startAuth).not.toHaveBeenCalled();
    expect(mocks.runProxyPreflight).not.toHaveBeenCalled();
    const warnCall = mocks.showNotification.mock.calls.find(
      (call) => call[0] === 'proxy_preflight.validating_wait'
    );
    expect(warnCall).toBeTruthy();

    await act(async () => renderer.unmount());
  });
});
