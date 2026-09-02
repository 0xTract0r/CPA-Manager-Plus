import { act, createElement, createRef, useImperativeHandle, type Ref } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// 账号设置弹窗「代理输入框内联实时校验」覆盖（hook 层）：
//  - blur 触发主校验路径（格式→查重→连通性探针）+ 就地展示（proxyInline 状态）；
//  - 未变更（与打开基线相同）→ 跳过探针直接标为已连通；
//  - 保存改为读取内联校验状态门控：已通过直接放行不重跑探针、校验中拦住、失败拦住不重跑；
//  - 未经 blur 直接保存仍走「最后确认门」完整校验（既有回归由 proxyProbe/proxyDedup 用例覆盖）。
// 保留真实 findAccountsUsingProxy / runProxyInlineChecks，只 mock 慢的 runProxyPreflight。

const { authFilesMock } = vi.hoisted(() => ({
  authFilesMock: {
    getAccountSettings: vi.fn(),
    downloadText: vi.fn(),
    updateAccountSettings: vi.fn(),
    patchFields: vi.fn(),
    saveText: vi.fn(),
  },
}));

vi.mock('@/services/api', () => ({
  authFilesApi: authFilesMock,
}));

const notificationState = {
  showNotification: vi.fn(),
  showConfirmation: vi.fn(),
};

vi.mock('@/stores', () => ({
  useNotificationStore: (selector?: (state: typeof notificationState) => unknown) =>
    selector ? selector(notificationState) : notificationState,
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (options && typeof options.accounts === 'string') return `${key}|${options.accounts}`;
      if (options && (typeof options.ip === 'string' || typeof options.ip === 'number'))
        return `${key}|${options.ip}`;
      if (options && typeof options.defaultValue === 'string') return options.defaultValue as string;
      return key;
    },
  }),
}));

const { runProxyPreflightMock } = vi.hoisted(() => ({
  runProxyPreflightMock: vi.fn(),
}));

vi.mock('@/utils/proxyPreflight', async (importActual) => ({
  ...(await importActual<typeof import('@/utils/proxyPreflight')>()),
  runProxyPreflight: runProxyPreflightMock,
}));

import {
  useAuthFilesAccountSettings,
  type UseAuthFilesAccountSettingsResult,
} from './useAuthFilesAccountSettings';
import type { AuthFileItem } from '@/types/authFile';

function HookHarness({
  hookRef,
  accounts,
}: {
  hookRef: Ref<UseAuthFilesAccountSettingsResult>;
  accounts: AuthFileItem[];
}) {
  const hook = useAuthFilesAccountSettings({
    disableControls: false,
    loadFiles: vi.fn().mockResolvedValue(undefined),
    loadKeyStats: vi.fn().mockResolvedValue(undefined),
    accounts,
  });
  useImperativeHandle(hookRef, () => hook, [hook]);
  return null;
}

const mountHook = (accounts: AuthFileItem[] = []) => {
  const hookRef = createRef<UseAuthFilesAccountSettingsResult>();
  let renderer: ReactTestRenderer | null = null;
  act(() => {
    renderer = create(createElement(HookHarness, { hookRef, accounts }));
  });
  return {
    getCurrent: () => {
      if (!hookRef.current) throw new Error('hook harness not mounted');
      return hookRef.current;
    },
    unmount: () => {
      act(() => {
        renderer?.unmount();
      });
    },
  };
};

const OLD_PROXY = 'socks5://user:pass@oldhost:1080';
const NEW_PROXY = 'socks5://user:pass@newhost:1080';

const authFile: AuthFileItem = { name: 'acct-claude.json', type: 'claude' } as AuthFileItem;

const openEditor = async (harness: ReturnType<typeof mountHook>) => {
  authFilesMock.getAccountSettings.mockResolvedValue({ proxy_url: OLD_PROXY, note: 'AC-14' });
  authFilesMock.downloadText.mockResolvedValue('{"type":"claude"}');
  await act(async () => {
    await harness.getCurrent().openAccountSettingsEditor(authFile);
  });
};

const editProxy = (harness: ReturnType<typeof mountHook>, value: string) => {
  act(() => {
    harness.getCurrent().handleAccountSettingsChange('proxyUrl', value);
  });
};

const blur = async (harness: ReturnType<typeof mountHook>) => {
  await act(async () => {
    await harness.getCurrent().handleAccountSettingsProxyBlur();
  });
};

beforeEach(() => {
  authFilesMock.getAccountSettings.mockReset();
  authFilesMock.downloadText.mockReset();
  authFilesMock.updateAccountSettings.mockReset();
  authFilesMock.patchFields.mockReset();
  authFilesMock.saveText.mockReset();
  notificationState.showNotification.mockReset();
  notificationState.showConfirmation.mockReset();
  runProxyPreflightMock.mockReset();
});

describe('useAuthFilesAccountSettings 代理输入框内联实时校验（失焦触发 + 保存门控）', () => {
  it('blur 填非法格式 → proxyUrlError=invalid，不发探针', async () => {
    const harness = mountHook();
    await openEditor(harness);
    editProxy(harness, 'not a url');
    await blur(harness);

    expect(runProxyPreflightMock).not.toHaveBeenCalled();
    expect(harness.getCurrent().accountSettingsEditor?.proxyUrlError).toBe('invalid');
    harness.unmount();
  });

  it('blur 填重复代理 → 内联标红指名冲突账号、不发探针', async () => {
    const accounts: AuthFileItem[] = [
      { name: 'other.json', account_settings: { proxy_url: NEW_PROXY, note: 'AC-15' } } as AuthFileItem,
    ];
    const harness = mountHook(accounts);
    await openEditor(harness);
    editProxy(harness, NEW_PROXY);
    await blur(harness);

    expect(runProxyPreflightMock).not.toHaveBeenCalled();
    const inline = harness.getCurrent().accountSettingsEditor?.proxyInline;
    expect(inline?.phase).toBe('invalid');
    expect(inline?.message).toContain('AC-15');
    harness.unmount();
  });

  it('blur 填不可达代理 → 探针一次、内联标红连通失败', async () => {
    const harness = mountHook();
    await openEditor(harness);
    editProxy(harness, NEW_PROXY);
    runProxyPreflightMock.mockResolvedValue({
      ok: false,
      exitIp: '',
      reason: 'timeout',
      message: 'proxy_preflight.reason_timeout',
    });
    await blur(harness);

    expect(runProxyPreflightMock).toHaveBeenCalledTimes(1);
    const inline = harness.getCurrent().accountSettingsEditor?.proxyInline;
    expect(inline?.phase).toBe('invalid');
    expect(inline?.message).toBe('proxy_preflight.reason_timeout');
    harness.unmount();
  });

  it('blur 填可达代理 → 探针一次、内联展示出口 IP；随后保存直接放行不重跑探针', async () => {
    const harness = mountHook();
    await openEditor(harness);
    editProxy(harness, NEW_PROXY);
    runProxyPreflightMock.mockResolvedValue({
      ok: true,
      exitIp: '203.0.113.9',
      reason: 'ok',
      message: 'proxy_preflight.reason_ok',
    });
    await blur(harness);

    expect(runProxyPreflightMock).toHaveBeenCalledTimes(1);
    const inline = harness.getCurrent().accountSettingsEditor?.proxyInline;
    expect(inline?.phase).toBe('ok');
    expect(inline?.exitIp).toBe('203.0.113.9');

    authFilesMock.updateAccountSettings.mockResolvedValue(undefined);
    await act(async () => {
      await harness.getCurrent().handleAccountSettingsSave();
    });

    // 已校验通过 → 保存直接落库，探针未被重跑（仍是 blur 那一次）。
    expect(authFilesMock.updateAccountSettings).toHaveBeenCalledTimes(1);
    expect(authFilesMock.updateAccountSettings.mock.calls[0][0].proxy_url).toBe(NEW_PROXY);
    expect(runProxyPreflightMock).toHaveBeenCalledTimes(1);
    harness.unmount();
  });

  it('blur 未变更（保持打开基线）→ 标为已连通、跳过探针', async () => {
    const harness = mountHook();
    await openEditor(harness);
    // 不改代理（仍是 OLD_PROXY 基线）直接失焦。
    await blur(harness);

    expect(runProxyPreflightMock).not.toHaveBeenCalled();
    const inline = harness.getCurrent().accountSettingsEditor?.proxyInline;
    expect(inline?.phase).toBe('ok');
    expect(inline?.exitIp).toBe('');
    harness.unmount();
  });

  it('校验中保存 → 拦住提示「验证中」、不落库', async () => {
    const harness = mountHook();
    await openEditor(harness);
    editProxy(harness, NEW_PROXY);
    // 探针 pending → 停在校验中。
    runProxyPreflightMock.mockReturnValue(new Promise(() => {}));
    act(() => {
      void harness.getCurrent().handleAccountSettingsProxyBlur();
    });
    expect(harness.getCurrent().accountSettingsEditor?.proxyInline?.phase).toBe('checking');

    authFilesMock.updateAccountSettings.mockResolvedValue(undefined);
    await act(async () => {
      await harness.getCurrent().handleAccountSettingsSave();
    });

    expect(authFilesMock.updateAccountSettings).not.toHaveBeenCalled();
    const warnCall = notificationState.showNotification.mock.calls.find(
      (call) => call[0] === 'proxy_preflight.validating_wait'
    );
    expect(warnCall).toBeTruthy();
    harness.unmount();
  });
});
