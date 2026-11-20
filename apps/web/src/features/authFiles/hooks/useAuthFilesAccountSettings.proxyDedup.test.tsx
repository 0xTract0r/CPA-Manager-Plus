import { act, createElement, createRef, useImperativeHandle, type Ref } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// scenario ② 覆盖：账号设置弹窗保存前的代理查重(L2) 改为「软提醒 + 弹框确认」，不再强制拦截。
//  - 改成其它同类型账号在用的代理 → 照常探针；探针通过后弹一次确认框（带占用账号数 + 账号名），
//    占用警告写入 proxyUrlDuplicateWarning；确认 → 落库，取消 → 不落库、弹窗保持打开。
//  - 调用方已确认过（农场换代理确认框）→ proxyDuplicateConfirmed 跳过二次确认直接落库。
//  - 未变更（保留自身原有代理，仅改其它字段）→ 不查重（不误判自身），照常保存、不弹框。
//  - 改成一个没人用的新代理 / 跨类型复用 → 不弹框，继续探针 + 保存。
// 保留真实 findProxyDuplicateUsage / toProxyOwnerAccount，只 mock 慢的 runProxyPreflight。

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
      key === 'proxy_preflight.duplicate_account_separator'
        ? '、'
        : options && typeof options.accounts === 'string'
          ? `${key}|${String(options.count)}|${options.accounts as string}`
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

type ConfirmationOptions = {
  title?: string;
  message: string;
  onConfirm: () => void;
  onCancel?: () => void;
};

// 另两个 claude 账号 AC-15 / AC-16 已经在用 NEW_PROXY。
const SHARED_ACCOUNTS: AuthFileItem[] = [
  {
    name: 'other15.json',
    type: 'claude',
    account_settings: { proxy_url: NEW_PROXY, note: 'AC-15' },
  } as AuthFileItem,
  {
    name: 'other16.json',
    type: 'claude',
    account_settings: { proxy_url: NEW_PROXY, note: 'AC-16' },
  } as AuthFileItem,
];

// 改成被占用的代理后点保存；保存 promise 会挂在确认框上，故不在这里 await 它。
const saveWithSharedProxy = async () => {
  const harness = mountHook(SHARED_ACCOUNTS);
  await openEditor(harness);
  act(() => {
    harness.getCurrent().handleAccountSettingsChange('proxyUrl', NEW_PROXY);
  });
  runProxyPreflightMock.mockResolvedValue({
    ok: true,
    exitIp: '203.0.113.9',
    reason: 'ok',
    message: 'connected',
  });
  authFilesMock.updateAccountSettings.mockResolvedValue(undefined);
  let saveDone!: Promise<void>;
  await act(async () => {
    saveDone = harness.getCurrent().handleAccountSettingsSave();
  });
  return { harness, saveDone };
};

describe('useAuthFilesAccountSettings 保存前代理查重提醒 (scenario ②)', () => {
  it('改成其它账号在用的代理 → 照常探针，弹一次确认框（带占用账号数 + 账号名），确认后落库', async () => {
    const { harness, saveDone } = await saveWithSharedProxy();

    // 占用情况按实际账号数统计（2 个），且排除自身。
    expect(harness.getCurrent().accountSettingsProxyDuplicate).toEqual({
      count: 2,
      labels: ['AC-15', 'AC-16'],
    });
    // 查重不再 fail-fast：连通性探针照常跑。
    expect(runProxyPreflightMock).toHaveBeenCalledTimes(1);
    // 不再写「重复即拦截」的错误通知。
    const dupError = notificationState.showNotification.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('duplicate')
    );
    expect(dupError).toBeUndefined();
    // 就地警告（非错误）带次数 + 账号名；proxyUrlError 不因重复置位。
    const editor = harness.getCurrent().accountSettingsEditor;
    expect(editor?.proxyUrlDuplicateWarning).toBe('proxy_preflight.duplicate_account|2|AC-15、AC-16');
    expect(editor?.proxyUrlError).toBeNull();
    // 确认前不落库，且保存按钮不在确认框背后转圈。
    expect(authFilesMock.updateAccountSettings).not.toHaveBeenCalled();
    expect(editor?.saving).toBe(false);
    expect(notificationState.showConfirmation).toHaveBeenCalledTimes(1);
    const options = notificationState.showConfirmation.mock.calls[0][0] as ConfirmationOptions;
    expect(options.title).toBe('proxy_preflight.duplicate_confirm_title');
    expect(options.message).toBe('proxy_preflight.duplicate_confirm_message|2|AC-15、AC-16');

    await act(async () => {
      options.onConfirm();
      await saveDone;
    });

    // 确认后照原流程落库，且不二次确认、不重跑探针。
    expect(authFilesMock.updateAccountSettings).toHaveBeenCalledTimes(1);
    expect(authFilesMock.updateAccountSettings.mock.calls[0][0].proxy_url).toBe(NEW_PROXY);
    expect(notificationState.showConfirmation).toHaveBeenCalledTimes(1);
    expect(runProxyPreflightMock).toHaveBeenCalledTimes(1);
    expect(harness.getCurrent().accountSettingsEditor).toBeNull();
    harness.unmount();
  });

  it('改成其它账号在用的代理 → 确认框点取消 → 不落库，弹窗保持打开', async () => {
    const { harness, saveDone } = await saveWithSharedProxy();

    expect(notificationState.showConfirmation).toHaveBeenCalledTimes(1);
    const options = notificationState.showConfirmation.mock.calls[0][0] as ConfirmationOptions;
    await act(async () => {
      options.onCancel?.();
      await saveDone;
    });

    expect(authFilesMock.updateAccountSettings).not.toHaveBeenCalled();
    const editor = harness.getCurrent().accountSettingsEditor;
    expect(editor).not.toBeNull();
    expect(editor?.proxyUrl).toBe(NEW_PROXY);
    expect(editor?.saving).toBe(false);
    harness.unmount();
  });

  it('调用方已确认过占用（proxyDuplicateConfirmed）→ 不再二次弹框，直接落库', async () => {
    const harness = mountHook(SHARED_ACCOUNTS);
    await openEditor(harness);
    act(() => {
      harness.getCurrent().handleAccountSettingsChange('proxyUrl', NEW_PROXY);
    });
    runProxyPreflightMock.mockResolvedValue({
      ok: true,
      exitIp: '203.0.113.9',
      reason: 'ok',
      message: 'connected',
    });
    authFilesMock.updateAccountSettings.mockResolvedValue(undefined);

    await act(async () => {
      await harness.getCurrent().handleAccountSettingsSave({ proxyDuplicateConfirmed: true });
    });

    expect(notificationState.showConfirmation).not.toHaveBeenCalled();
    expect(authFilesMock.updateAccountSettings).toHaveBeenCalledTimes(1);
    harness.unmount();
  });

  it('保留自身原有代理（未变更，仅改备注）→ 不误判为重复，继续进探针 + 保存', async () => {
    // 另一账号也用同一 OLD_PROXY（历史遗留同代理）；但本次未改动代理 → 应跳过查重，不阻断。
    const accounts: AuthFileItem[] = [
      {
        name: 'other.json',
        type: 'claude',
        account_settings: { proxy_url: OLD_PROXY, note: 'AC-15' },
      } as AuthFileItem,
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

    // 未变更代理 → 查重被跳过，未误判为重复（不弹确认框），照常保存。
    expect(notificationState.showConfirmation).not.toHaveBeenCalled();
    expect(harness.getCurrent().accountSettingsEditor).toBeNull();
    expect(authFilesMock.updateAccountSettings).toHaveBeenCalledTimes(1);
    harness.unmount();
  });

  it.each(['claude', 'codex'])('类型 %s：新代理或跨类型复用均继续探针及保存', async (provider) => {
    const accounts: AuthFileItem[] = [
      {
        name: 'other.json',
        type: 'claude',
        account_settings: { proxy_url: NEW_PROXY, note: 'AC-15' },
      } as AuthFileItem,
    ];
    accounts[0].type = provider;
    const target = provider === 'codex' ? NEW_PROXY : UNIQUE_PROXY;
    const harness = mountHook(accounts);
    await openEditor(harness);
    act(() => {
      harness.getCurrent().handleAccountSettingsChange('proxyUrl', target);
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
    expect(updateArg.proxy_url).toBe(target);
    // 无同类型占用 → 不弹确认框。
    expect(notificationState.showConfirmation).not.toHaveBeenCalled();
    harness.unmount();
  });
});
