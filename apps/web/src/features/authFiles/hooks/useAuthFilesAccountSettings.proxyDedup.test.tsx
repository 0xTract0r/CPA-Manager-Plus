import { act, createElement, createRef, useImperativeHandle, type Ref } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// scenario ② 覆盖：账号设置弹窗保存前的代理查重(L2) 在连通性探针(L1) 之前 fail-fast。
//  - 改成其它账号在用的代理 → 查重命中：不落库、不探针，报错含冲突账号名，proxyUrlDuplicateError 置位。
//  - 未变更（保留自身原有代理，仅改其它字段）→ 不查重（不误判自身），照常进探针 + 保存。
//  - 改成一个没人用的新代理 → 查重不命中，继续进探针 + 保存。
// 保留真实 findAccountsUsingProxy / toProxyOwnerAccount，只 mock 慢的 runProxyPreflight。

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
      options && typeof options.accounts === 'string'
        ? `${key}|${options.accounts as string}`
        : options && typeof options.defaultValue === 'string'
          ? (options.defaultValue as string)
          : key,
  }),
}));

const { runProxyPreflightMock } = vi.hoisted(() => ({
  runProxyPreflightMock: vi.fn(),
}));

// 保留真实查重逻辑，只切断慢的连通性探针。
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

const mountHook = (accounts: AuthFileItem[]) => {
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
const UNIQUE_PROXY = 'socks5://user:pass@unique:1080';

const authFile: AuthFileItem = { name: 'acct-claude.json', type: 'claude' } as AuthFileItem;

const openEditor = async (harness: ReturnType<typeof mountHook>) => {
  authFilesMock.getAccountSettings.mockResolvedValue({ proxy_url: OLD_PROXY, note: 'AC-14' });
  authFilesMock.downloadText.mockResolvedValue('{"type":"claude"}');
  await act(async () => {
    await harness.getCurrent().openAccountSettingsEditor(authFile);
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

describe('useAuthFilesAccountSettings 保存前代理查重 (scenario ②)', () => {
  it('改成其它账号在用的代理 → 查重命中：不落库、不探针，报错含冲突账号名', async () => {
    // 另一个账号 AC-15 已经在用 NEW_PROXY。
    const accounts: AuthFileItem[] = [
      { name: 'other.json', account_settings: { proxy_url: NEW_PROXY, note: 'AC-15' } } as AuthFileItem,
    ];
    const harness = mountHook(accounts);
    await openEditor(harness);
    act(() => {
      harness.getCurrent().handleAccountSettingsChange('proxyUrl', NEW_PROXY);
    });

    await act(async () => {
      await harness.getCurrent().handleAccountSettingsSave();
    });

    // L2 在 L1 之前 fail-fast：查重命中 → 不落库、连通性探针未触发。
    expect(authFilesMock.updateAccountSettings).not.toHaveBeenCalled();
    expect(runProxyPreflightMock).not.toHaveBeenCalled();
    // 冲突提示置位且含冲突账号名（AC-15）。
    expect(harness.getCurrent().accountSettingsEditor?.proxyUrlDuplicateError).toContain('AC-15');
    const errorCall = notificationState.showNotification.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('AC-15')
    );
    expect(errorCall).toBeTruthy();
    expect(errorCall?.[1]).toBe('error');
    harness.unmount();
  });

  it('保留自身原有代理（未变更，仅改备注）→ 不误判为重复，继续进探针 + 保存', async () => {
    // 另一账号也用同一 OLD_PROXY（历史遗留同代理）；但本次未改动代理 → 应跳过查重，不阻断。
    const accounts: AuthFileItem[] = [
      { name: 'other.json', account_settings: { proxy_url: OLD_PROXY, note: 'AC-15' } } as AuthFileItem,
    ];
    const harness = mountHook(accounts);
    await openEditor(harness);
    // 不改代理（保持 OLD_PROXY 基线），只改备注使其进入 dirty。
    act(() => {
      harness.getCurrent().handleAccountSettingsChange('note', 'renamed');
    });
    expect(harness.getCurrent().accountSettingsDirty).toBe(true);
    runProxyPreflightMock.mockResolvedValue({ ok: true, exitIp: '', reason: 'ok', message: 'ok' });
    authFilesMock.updateAccountSettings.mockResolvedValue(undefined);

    await act(async () => {
      await harness.getCurrent().handleAccountSettingsSave();
    });

    // 未变更代理 → 查重被跳过，未误判为重复（无冲突提示），照常保存。
    expect(harness.getCurrent().accountSettingsEditor).toBeNull();
    expect(authFilesMock.updateAccountSettings).toHaveBeenCalledTimes(1);
    harness.unmount();
  });

  it('改成没人用的新代理 → 查重不命中，继续进探针 + 保存', async () => {
    const accounts: AuthFileItem[] = [
      { name: 'other.json', account_settings: { proxy_url: NEW_PROXY, note: 'AC-15' } } as AuthFileItem,
    ];
    const harness = mountHook(accounts);
    await openEditor(harness);
    act(() => {
      harness.getCurrent().handleAccountSettingsChange('proxyUrl', UNIQUE_PROXY);
    });
    runProxyPreflightMock.mockResolvedValue({
      ok: true,
      exitIp: '203.0.113.9',
      reason: 'ok',
      message: 'connected',
    });
    authFilesMock.updateAccountSettings.mockResolvedValue(undefined);

    await act(async () => {
      await harness.getCurrent().handleAccountSettingsSave();
    });

    expect(runProxyPreflightMock).toHaveBeenCalledTimes(1);
    expect(authFilesMock.updateAccountSettings).toHaveBeenCalledTimes(1);
    const updateArg = authFilesMock.updateAccountSettings.mock.calls[0][0];
    expect(updateArg.proxy_url).toBe(UNIQUE_PROXY);
    harness.unmount();
  });
});
