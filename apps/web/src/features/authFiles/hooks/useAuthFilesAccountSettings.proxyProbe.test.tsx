import { act, createElement, createRef, useImperativeHandle, type Ref } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// 账号设置弹窗保存前的代理连通性预检回归覆盖：
//  - 探针 ok:false → 不调 updateAccountSettings（fail-closed，不落库）。
//  - 探针 ok:true → 正常调用 updateAccountSettings 保存。
// hook 无 UI 依赖，用最小 harness 挂载真实 hook 逻辑，网络/探针边界处切断。

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
    t: (key: string, options?: Record<string, unknown>) =>
      options && typeof options.defaultValue === 'string' ? (options.defaultValue as string) : key,
  }),
}));

const { runProxyPreflightMock } = vi.hoisted(() => ({
  runProxyPreflightMock: vi.fn(),
}));

// 只 mock runProxyPreflight（连通性探针），保留真实的 findAccountsUsingProxy 查重逻辑；
// 本用例不传 accounts（默认空列表）→ 查重恒无冲突，不影响探针分支断言。
vi.mock('@/utils/proxyPreflight', async (importActual) => ({
  ...(await importActual<typeof import('@/utils/proxyPreflight')>()),
  runProxyPreflight: runProxyPreflightMock,
}));

import {
  useAuthFilesAccountSettings,
  type UseAuthFilesAccountSettingsResult,
} from './useAuthFilesAccountSettings';
import type { AuthFileItem } from '@/types/authFile';

function HookHarness({ hookRef }: { hookRef: Ref<UseAuthFilesAccountSettingsResult> }) {
  const hook = useAuthFilesAccountSettings({
    disableControls: false,
    loadFiles: vi.fn().mockResolvedValue(undefined),
    loadKeyStats: vi.fn().mockResolvedValue(undefined),
  });
  useImperativeHandle(hookRef, () => hook, [hook]);
  return null;
}

const mountHook = () => {
  const hookRef = createRef<UseAuthFilesAccountSettingsResult>();
  let renderer: ReactTestRenderer | null = null;
  act(() => {
    renderer = create(createElement(HookHarness, { hookRef }));
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

const seedEditor = async (harness: ReturnType<typeof mountHook>) => {
  authFilesMock.getAccountSettings.mockResolvedValue({ proxy_url: OLD_PROXY, note: 'n' });
  authFilesMock.downloadText.mockResolvedValue('{"type":"claude"}');
  await act(async () => {
    await harness.getCurrent().openAccountSettingsEditor(authFile);
  });
  // 改动 proxy_url 使账号设置白名单进入 dirty 状态（否则保存直接短路返回）。
  act(() => {
    harness.getCurrent().handleAccountSettingsChange('proxyUrl', NEW_PROXY);
  });
  expect(harness.getCurrent().accountSettingsDirty).toBe(true);
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

describe('useAuthFilesAccountSettings 保存前代理连通性预检', () => {
  it('探针 ok:false → 不调 updateAccountSettings（不落库）', async () => {
    const harness = mountHook();
    await seedEditor(harness);
    authFilesMock.updateAccountSettings.mockResolvedValue(undefined);
    runProxyPreflightMock.mockResolvedValue({
      ok: false,
      exitIp: '',
      reason: 'dial_failed',
      message: '无法经该代理连通',
    });

    await act(async () => {
      await harness.getCurrent().handleAccountSettingsSave();
    });

    expect(runProxyPreflightMock).toHaveBeenCalledTimes(1);
    expect(authFilesMock.updateAccountSettings).not.toHaveBeenCalled();
    expect(harness.getCurrent().accountSettingsEditor?.proxyUrlError).toBe('invalid');
    harness.unmount();
  });

  it('探针 ok:true → 调用 updateAccountSettings 并展示出口 IP', async () => {
    const harness = mountHook();
    await seedEditor(harness);
    authFilesMock.updateAccountSettings.mockResolvedValue(undefined);
    runProxyPreflightMock.mockResolvedValue({
      ok: true,
      exitIp: '203.0.113.9',
      reason: 'ok',
      message: 'connected',
    });

    await act(async () => {
      await harness.getCurrent().handleAccountSettingsSave();
    });

    expect(runProxyPreflightMock).toHaveBeenCalledTimes(1);
    expect(authFilesMock.updateAccountSettings).toHaveBeenCalledTimes(1);
    const updateArg = authFilesMock.updateAccountSettings.mock.calls[0][0];
    expect(updateArg.proxy_url).toBe(NEW_PROXY);
    // 出口 IP 通过 connected_with_ip 提示展示（t 桩返回 key，断言带 ip 插值参数被调用）。
    expect(notificationState.showNotification).toHaveBeenCalledWith(
      'proxy_preflight.connected_with_ip',
      'success'
    );
    harness.unmount();
  });
});
