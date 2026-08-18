import { createElement, useEffect } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * useFarmAutoProvision：拨动「认证即自动供」开关 → 二次确认 → PATCH /api/farm/config
 * → 成功 reload 刷新 / 失败保持原值 + toast。演练真实 hook 逻辑，只 mock 边界
 * （farmApi.updateConfig、通知/确认 store），不在测试里重写确认流程。
 */

const { mocks } = vi.hoisted(() => ({
  mocks: {
    updateConfig: vi.fn(),
    showNotification: vi.fn(),
    showConfirmation: vi.fn(),
    reload: vi.fn(),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/services/api/farm', () => ({
  farmApi: {
    updateConfig: mocks.updateConfig,
  },
}));

vi.mock('@/stores', () => ({
  useNotificationStore: () => ({
    showNotification: mocks.showNotification,
    showConfirmation: mocks.showConfirmation,
  }),
}));

import { useFarmAutoProvision, type UseFarmAutoProvisionResult } from './useFarmAutoProvision';

type ConfirmationOptions = {
  title?: string;
  variant?: string;
  confirmText?: string;
  onConfirm: () => void | Promise<void>;
};

// 捕获 hook 返回值：在 useEffect 里赋值（渲染期以外），避免 react-hooks/globals
// 对「渲染期重赋值外部变量」的告警（与 useUsageAnalytics.test 同手法）。
let latestResult: UseFarmAutoProvisionResult | null = null;
let renderer: ReactTestRenderer | null = null;

const Harness = ({ value }: { value: boolean }) => {
  const result = useFarmAutoProvision({ enabled: value, reload: mocks.reload });
  useEffect(() => {
    latestResult = result;
  }, [result]);
  return null;
};

const mountHook = (enabled: boolean): UseFarmAutoProvisionResult => {
  act(() => {
    renderer = create(createElement(Harness, { value: enabled }));
  });
  if (!latestResult) {
    throw new Error('hook not mounted');
  }
  return latestResult;
};

const lastConfirmation = (): ConfirmationOptions => {
  const calls = mocks.showConfirmation.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0] as ConfirmationOptions;
};

describe('useFarmAutoProvision', () => {
  beforeEach(() => {
    latestResult = null;
    renderer = null;
    mocks.updateConfig.mockReset().mockResolvedValue({ auto_provision_enabled: true });
    mocks.showNotification.mockReset();
    mocks.showConfirmation.mockReset();
    mocks.reload.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    act(() => {
      renderer?.unmount();
    });
    vi.clearAllMocks();
  });

  it('confirms then PATCHes with the next value and reloads on enable', async () => {
    const hook = mountHook(false);

    act(() => {
      hook.requestToggle(true);
    });

    const confirmation = lastConfirmation();
    expect(confirmation.title).toBe('farm.capacity.autoProvisionConfirmEnableTitle');
    expect(confirmation.variant).toBe('primary');
    // 尚未确认前不发请求。
    expect(mocks.updateConfig).not.toHaveBeenCalled();

    await act(async () => {
      await confirmation.onConfirm();
    });

    expect(mocks.updateConfig).toHaveBeenCalledWith({ auto_provision_enabled: true });
    expect(mocks.reload).toHaveBeenCalledTimes(1);
    expect(mocks.showNotification).toHaveBeenCalledWith(
      'farm.capacity.autoProvisionToggleSuccessOn',
      'success'
    );
  });

  it('uses the backend echo value for the success message, and disables with danger variant', async () => {
    mocks.updateConfig.mockResolvedValueOnce({ auto_provision_enabled: false });
    const hook = mountHook(true);

    act(() => {
      hook.requestToggle(false);
    });

    const confirmation = lastConfirmation();
    expect(confirmation.title).toBe('farm.capacity.autoProvisionConfirmDisableTitle');
    expect(confirmation.variant).toBe('danger');

    await act(async () => {
      await confirmation.onConfirm();
    });

    expect(mocks.updateConfig).toHaveBeenCalledWith({ auto_provision_enabled: false });
    expect(mocks.showNotification).toHaveBeenCalledWith(
      'farm.capacity.autoProvisionToggleSuccessOff',
      'success'
    );
  });

  it('keeps state (no reload) and toasts an error when the PATCH fails', async () => {
    mocks.updateConfig.mockRejectedValueOnce(new Error('boom'));
    const hook = mountHook(false);

    act(() => {
      hook.requestToggle(true);
    });

    await act(async () => {
      await lastConfirmation().onConfirm();
    });

    expect(mocks.reload).not.toHaveBeenCalled();
    expect(mocks.showNotification).toHaveBeenCalledWith(
      'farm.capacity.autoProvisionToggleFailed: boom',
      'error'
    );
  });

  it('is a no-op (no confirmation) when toggled to the current value', () => {
    const hook = mountHook(true);

    act(() => {
      hook.requestToggle(true);
    });

    expect(mocks.showConfirmation).not.toHaveBeenCalled();
    expect(mocks.updateConfig).not.toHaveBeenCalled();
  });
});
