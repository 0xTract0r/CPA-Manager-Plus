import { createElement, useEffect } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * useFarmAutoEnroll：挂载即 GET /v0/management/farm-auto-enroll 读全局默认 →
 * 拨动开关先二次确认 → PUT { value: next } → 成功 reload 刷新 / 失败保持原值 + toast。
 * 演练真实 hook 逻辑，只 mock 边界（farmAutoEnrollApi.get/set、通知/确认 store）。
 */

const { mocks } = vi.hoisted(() => ({
  mocks: {
    get: vi.fn(),
    set: vi.fn(),
    showNotification: vi.fn(),
    showConfirmation: vi.fn(),
  },
}));

vi.mock('react-i18next', () => {
  // t 忽略 defaultValue，回 key，便于断言到稳定 key（真实运行时才回落 defaultValue）。
  // 关键：t 引用必须稳定——本 hook 在挂载 effect 里依赖 reload（dep [t]）拉数据，
  // 真实 react-i18next 的 t 跨渲染稳定（与 useFarmCapacity 同款 [t]/[reload] 模式），
  // 若 mock 每次渲染换新 t，会让挂载 effect 反复触发形成渲染抖动。
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }) };
});

vi.mock('@/services/api/farmAutoEnroll', () => ({
  farmAutoEnrollApi: {
    get: mocks.get,
    set: mocks.set,
  },
}));

vi.mock('@/stores', () => ({
  useNotificationStore: () => ({
    showNotification: mocks.showNotification,
    showConfirmation: mocks.showConfirmation,
  }),
}));

import { useFarmAutoEnroll, type UseFarmAutoEnrollResult } from './useFarmAutoEnroll';

type ConfirmationOptions = {
  title?: string;
  variant?: string;
  confirmText?: string;
  onConfirm: () => void | Promise<void>;
};

// 捕获 hook 最新返回值：在 useEffect 里赋值（渲染期以外），避免 react-hooks 告警。
let latestResult: UseFarmAutoEnrollResult | null = null;
let renderer: ReactTestRenderer | null = null;

const Harness = () => {
  const result = useFarmAutoEnroll();
  useEffect(() => {
    latestResult = result;
  }, [result]);
  return null;
};

// 挂载并 flush 首次 GET（异步）后返回最新 hook 值。
const mountHook = async (): Promise<UseFarmAutoEnrollResult> => {
  await act(async () => {
    renderer = create(createElement(Harness));
  });
  if (!latestResult) {
    throw new Error('hook not mounted');
  }
  return latestResult;
};

// 每次读最新返回值（enabled 变化后 requestToggle 会被重建，勿用挂载时的旧闭包）。
const current = (): UseFarmAutoEnrollResult => {
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

describe('useFarmAutoEnroll', () => {
  beforeEach(() => {
    latestResult = null;
    renderer = null;
    mocks.get.mockReset().mockResolvedValue({ value: false });
    mocks.set.mockReset().mockResolvedValue({ value: true });
    mocks.showNotification.mockReset();
    mocks.showConfirmation.mockReset();
  });

  afterEach(() => {
    act(() => {
      renderer?.unmount();
    });
    vi.clearAllMocks();
  });

  it('reads the global default on mount', async () => {
    mocks.get.mockResolvedValueOnce({ value: true });
    const hook = await mountHook();
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(hook.enabled).toBe(true);
    expect(hook.loading).toBe(false);
  });

  it('confirms then PUTs the next value and reloads on enable', async () => {
    await mountHook(); // 初始 value:false
    expect(mocks.get).toHaveBeenCalledTimes(1);

    act(() => {
      current().requestToggle(true);
    });

    const confirmation = lastConfirmation();
    expect(confirmation.title).toBe('farm.capacity.autoEnrollConfirmEnableTitle');
    expect(confirmation.variant).toBe('primary');
    // 尚未确认前不发写请求。
    expect(mocks.set).not.toHaveBeenCalled();

    await act(async () => {
      await confirmation.onConfirm();
    });

    expect(mocks.set).toHaveBeenCalledWith(true);
    // reload 重拉一次（mount 1 + reload 1 = 2）。
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(mocks.showNotification).toHaveBeenCalledWith(
      'farm.capacity.autoEnrollToggleSuccessOn',
      'success'
    );
  });

  it('uses the backend echo value for the success message, and disables with danger variant', async () => {
    mocks.get.mockResolvedValueOnce({ value: true }); // 初始 enabled=true
    mocks.set.mockResolvedValueOnce({ value: false });
    await mountHook();

    act(() => {
      current().requestToggle(false);
    });

    const confirmation = lastConfirmation();
    expect(confirmation.title).toBe('farm.capacity.autoEnrollConfirmDisableTitle');
    expect(confirmation.variant).toBe('danger');

    await act(async () => {
      await confirmation.onConfirm();
    });

    expect(mocks.set).toHaveBeenCalledWith(false);
    expect(mocks.showNotification).toHaveBeenCalledWith(
      'farm.capacity.autoEnrollToggleSuccessOff',
      'success'
    );
  });

  it('keeps state (no reload) and toasts an error when the PUT fails', async () => {
    mocks.set.mockRejectedValueOnce(new Error('boom'));
    await mountHook(); // 初始 value:false，mount get 调 1 次
    expect(mocks.get).toHaveBeenCalledTimes(1);

    act(() => {
      current().requestToggle(true);
    });

    await act(async () => {
      await lastConfirmation().onConfirm();
    });

    // 失败不 reload：get 仍只被 mount 调过一次。
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(mocks.showNotification).toHaveBeenCalledWith(
      'farm.capacity.autoEnrollToggleFailed: boom',
      'error'
    );
  });

  it('is a no-op (no confirmation) when toggled to the current value', async () => {
    mocks.get.mockResolvedValueOnce({ value: true }); // enabled=true
    await mountHook();

    act(() => {
      current().requestToggle(true);
    });

    expect(mocks.showConfirmation).not.toHaveBeenCalled();
    expect(mocks.set).not.toHaveBeenCalled();
  });
});
