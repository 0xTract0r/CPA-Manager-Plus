import { act, createElement, useEffect } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthFileAccountScheduling } from '@/types/authFile';

// 调度旋钮（tier_override / rate_scale）hook：验证「设 / 清 / 非法」三分支的请求
// 参数构造，以及「用返回投影重渲染，不乐观更新」（成功回调后 view/表单值必须
// 来自 mock 的 API 响应，而不是提交前的本地表单值）。

const { mocks } = vi.hoisted(() => ({
  mocks: {
    updateAccountScheduling: vi.fn(),
    showNotification: vi.fn(),
  },
}));

// t mock 做最小 `{{token}}` 插值（真实 react-i18next 会插值 legal_values 拼接句里的
// {{message}}/{{values}}；farmEnrolled 等既有测试的 t mock 不插值是因为它们的用例
// 没有依赖插值结果，本文件的「非法」分支断言依赖插值后的可读文案）。
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (!options || typeof options.defaultValue !== 'string') return key;
      return options.defaultValue.replace(/\{\{(\w+)\}\}/g, (match, token: string) => {
        const value = options[token];
        return value === undefined ? match : String(value);
      });
    },
  }),
}));

vi.mock('@/services/api', () => ({
  authFilesApi: {
    updateAccountScheduling: mocks.updateAccountScheduling,
  },
}));

vi.mock('@/stores', () => ({
  useNotificationStore: (
    selector: (state: { showNotification: typeof mocks.showNotification }) => unknown
  ) => selector({ showNotification: mocks.showNotification }),
}));

import {
  useAccountSchedulingControls,
  type UseAccountSchedulingControlsOptions,
  type UseAccountSchedulingControlsResult,
} from './useAccountSchedulingControls';

type Harness = {
  getCurrent: () => UseAccountSchedulingControlsResult;
  unmount: () => void;
};

const mountHook = (options: UseAccountSchedulingControlsOptions): Harness => {
  const hookRef: { current: UseAccountSchedulingControlsResult | null } = { current: null };
  let renderer: ReactTestRenderer | null = null;

  function HookHarness() {
    const value = useAccountSchedulingControls(options);
    useEffect(() => {
      hookRef.current = value;
    });
    return null;
  }

  act(() => {
    renderer = create(createElement(HookHarness));
  });

  return {
    getCurrent: () => {
      if (!hookRef.current) throw new Error('Failed to mount useAccountSchedulingControls harness');
      return hookRef.current;
    },
    unmount: () => {
      if (!renderer) return;
      act(() => {
        renderer?.unmount();
      });
    },
  };
};

const autoScheduling: AuthFileAccountScheduling = {
  subscription_tier: 'max_5x',
  tier_source: 'auto',
  rate_scale: 1,
};

const overrideScheduling: AuthFileAccountScheduling = {
  subscription_tier: 'max_20x',
  tier_source: 'override',
  rate_scale: 0.5,
};

describe('useAccountSchedulingControls', () => {
  beforeEach(() => {
    mocks.updateAccountScheduling.mockReset();
    mocks.showNotification.mockReset();
  });

  it('derives initial form state from the baseline projection (auto tier, effective rate)', () => {
    const harness = mountHook({ fileName: 'acct.json', initialScheduling: autoScheduling });
    const current = harness.getCurrent();
    expect(current.tierOverride).toBe('auto');
    expect(current.rateScaleText).toBe('1');
    expect(current.dirty).toBe(false);
    harness.unmount();
  });

  it('derives initial form state from an override baseline', () => {
    const harness = mountHook({ fileName: 'acct.json', initialScheduling: overrideScheduling });
    const current = harness.getCurrent();
    expect(current.tierOverride).toBe('max_20x');
    expect(current.rateScaleText).toBe('0.5');
    harness.unmount();
  });

  it('falls back to auto/1 when account_scheduling is entirely missing (older core)', () => {
    const harness = mountHook({ fileName: 'acct.json', initialScheduling: undefined });
    const current = harness.getCurrent();
    expect(current.tierOverride).toBe('auto');
    expect(current.rateScaleText).toBe('1');
    harness.unmount();
  });

  it('[设] sends the picked tier and numeric rate_scale on apply', async () => {
    mocks.updateAccountScheduling.mockResolvedValue({
      name: 'acct.json',
      account_scheduling: overrideScheduling,
    });
    const harness = mountHook({ fileName: 'acct.json', initialScheduling: autoScheduling });

    act(() => harness.getCurrent().setTierOverride('max_20x'));
    act(() => harness.getCurrent().setRateScaleText('0.5'));
    expect(harness.getCurrent().dirty).toBe(true);

    await act(async () => {
      await harness.getCurrent().applyScheduling();
    });

    expect(mocks.updateAccountScheduling).toHaveBeenCalledTimes(1);
    expect(mocks.updateAccountScheduling).toHaveBeenCalledWith({
      name: 'acct.json',
      tier_override: 'max_20x',
      rate_scale: 0.5,
    });
    harness.unmount();
  });

  it('[清] sends null for tier_override when switching back to auto, and null for an emptied rate_scale', async () => {
    mocks.updateAccountScheduling.mockResolvedValue({
      name: 'acct.json',
      account_scheduling: autoScheduling,
    });
    const harness = mountHook({ fileName: 'acct.json', initialScheduling: overrideScheduling });

    act(() => harness.getCurrent().setTierOverride('auto'));
    act(() => harness.getCurrent().setRateScaleText(''));

    await act(async () => {
      await harness.getCurrent().applyScheduling();
    });

    expect(mocks.updateAccountScheduling).toHaveBeenCalledWith({
      name: 'acct.json',
      tier_override: null,
      rate_scale: null,
    });
    harness.unmount();
  });

  it('[非法] blocks apply and surfaces an inline error for a non-positive rate_scale, without calling the API', async () => {
    const harness = mountHook({ fileName: 'acct.json', initialScheduling: autoScheduling });

    act(() => harness.getCurrent().setRateScaleText('0'));
    expect(harness.getCurrent().rateScaleError).toBeTruthy();

    await act(async () => {
      await harness.getCurrent().applyScheduling();
    });
    expect(mocks.updateAccountScheduling).not.toHaveBeenCalled();

    act(() => harness.getCurrent().setRateScaleText('not-a-number'));
    expect(harness.getCurrent().rateScaleError).toBeTruthy();
    await act(async () => {
      await harness.getCurrent().applyScheduling();
    });
    expect(mocks.updateAccountScheduling).not.toHaveBeenCalled();

    harness.unmount();
  });

  it('refreshes view/form state from the API response, not the submitted form value (no optimistic update)', async () => {
    // core 回显的档位/速率与用户提交的表单值不同——用于坐实「用返回投影重渲染」。
    const echoedFromServer: AuthFileAccountScheduling = {
      subscription_tier: 'pro',
      tier_source: 'override',
      rate_scale: 2,
    };
    mocks.updateAccountScheduling.mockResolvedValue({
      name: 'acct.json',
      account_scheduling: echoedFromServer,
    });
    const harness = mountHook({ fileName: 'acct.json', initialScheduling: autoScheduling });

    act(() => harness.getCurrent().setTierOverride('max_20x'));
    act(() => harness.getCurrent().setRateScaleText('0.3'));

    await act(async () => {
      await harness.getCurrent().applyScheduling();
    });

    const current = harness.getCurrent();
    expect(current.view).toEqual(echoedFromServer);
    expect(current.tierOverride).toBe('pro');
    expect(current.rateScaleText).toBe('2');
    expect(current.dirty).toBe(false);
    harness.unmount();
  });

  it('calls onApplied with the server-echoed projection after a successful save', async () => {
    const onApplied = vi.fn();
    mocks.updateAccountScheduling.mockResolvedValue({
      name: 'acct.json',
      account_scheduling: overrideScheduling,
    });
    const harness = mountHook({ fileName: 'acct.json', initialScheduling: autoScheduling, onApplied });

    act(() => harness.getCurrent().setTierOverride('max_20x'));
    await act(async () => {
      await harness.getCurrent().applyScheduling();
    });

    expect(onApplied).toHaveBeenCalledWith(overrideScheduling);
    harness.unmount();
  });

  it('surfaces legal_values from a 400 error response and keeps prior view unchanged (no optimistic update on failure)', async () => {
    mocks.updateAccountScheduling.mockRejectedValue({
      message: 'invalid tier_override "bogus" for provider "claude"',
      status: 400,
      data: { error: 'invalid tier_override', legal_values: ['max_20x', 'max_5x', 'pro'] },
    });
    const harness = mountHook({ fileName: 'acct.json', initialScheduling: autoScheduling });

    act(() => harness.getCurrent().setTierOverride('max_20x'));
    await act(async () => {
      await harness.getCurrent().applyScheduling();
    });

    const current = harness.getCurrent();
    expect(current.errorMessage).toContain('max_20x, max_5x, pro');
    expect(current.legalTierValues).toEqual(['max_20x', 'max_5x', 'pro']);
    // 失败时不应把 view 换成用户提交的表单值。
    expect(current.view).toEqual(autoScheduling);
    expect(mocks.showNotification).toHaveBeenCalledWith(expect.stringContaining('max_20x'), 'error');
    harness.unmount();
  });

  it('sends auth_index when provided', async () => {
    mocks.updateAccountScheduling.mockResolvedValue({
      name: 'acct.json',
      account_scheduling: overrideScheduling,
    });
    const harness = mountHook({
      fileName: 'acct.json',
      authIndex: 3,
      initialScheduling: autoScheduling,
    });

    act(() => harness.getCurrent().setTierOverride('max_20x'));
    await act(async () => {
      await harness.getCurrent().applyScheduling();
    });

    expect(mocks.updateAccountScheduling).toHaveBeenCalledWith(
      expect.objectContaining({ auth_index: 3 })
    );
    harness.unmount();
  });
});
