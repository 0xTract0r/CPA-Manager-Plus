import { act, type ChangeEvent } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import type { AuthFileAccountScheduling } from '@/types/authFile';

// AccountSchedulingPanel：调度旋钮（tier_override / rate_scale）UI 层验证——
// Select/Input 与 useAccountSchedulingControls 的接线、Apply 按钮 dirty/error
// 门控，以及「保存成功后用返回投影重渲染徽标/生效速率，而不是提交前的表单值」。

const { mocks } = vi.hoisted(() => ({
  mocks: {
    updateAccountScheduling: vi.fn(),
    showNotification: vi.fn(),
  },
}));

// t mock 做最小 `{{token}}` 插值：本文件断言渲染出的「Effective rate scale: N」/
// legal_values 拼接句都依赖插值结果，不能像 farmEnrolled 等既有测试那样只回退
// defaultValue 原文。
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

import { AccountSchedulingPanel, type AccountSchedulingPanelProps } from './AccountSchedulingPanel';

const autoScheduling: AuthFileAccountScheduling = {
  subscription_tier: 'max_5x',
  tier_source: 'auto',
  rate_scale: 1,
};

const anchoredScheduling: AuthFileAccountScheduling = {
  subscription_tier: 'max_5x',
  tier_source: 'auto',
  rate_scale: 1,
  first_production_at: '2026-01-01T00:00:00Z',
  warmup: { stage: 'mature', mature: true, age_days: 240 },
};

type Harness = {
  renderer: ReactTestRenderer;
  getSelect: () => ReturnType<ReactTestRenderer['root']['findByType']>;
  getRateScaleInput: () => ReturnType<ReactTestRenderer['root']['findByType']>;
  getResetButton: () => ReturnType<ReactTestRenderer['root']['findByType']> | undefined;
  getFirstProductionInput: () => ReturnType<ReactTestRenderer['root']['findByType']>;
  getFirstProductionClear: () => ReturnType<ReactTestRenderer['root']['findByType']> | undefined;
  getApplyButton: () => ReturnType<ReactTestRenderer['root']['findByType']> | undefined;
  getText: () => string;
};

const mountPanel = (overrides: Partial<AccountSchedulingPanelProps> = {}): Harness => {
  const props: AccountSchedulingPanelProps = {
    fileName: 'claude-acct.json',
    authIndex: 1,
    initialScheduling: autoScheduling,
    disabled: false,
    ...overrides,
  };
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<AccountSchedulingPanel {...props} />);
  });

  const getSelect = () => renderer.root.findByType(Select);
  const getRateScaleInput = () =>
    renderer.root
      .findAllByType(Input)
      .find((node) => node.props['data-testid'] === 'account-settings-scheduling-rate-scale-input')!;
  const getResetButton = () =>
    renderer.root
      .findAllByType(Button)
      .find((node) => node.props['data-testid'] === 'account-settings-scheduling-rate-scale-reset');
  const getFirstProductionInput = () =>
    renderer.root
      .findAllByType(Input)
      .find(
        (node) =>
          node.props['data-testid'] === 'account-settings-scheduling-first-production-at-input'
      )!;
  const getFirstProductionClear = () =>
    renderer.root
      .findAllByType(Button)
      .find(
        (node) =>
          node.props['data-testid'] === 'account-settings-scheduling-first-production-at-clear'
      );
  const getApplyButton = () =>
    renderer.root
      .findAllByType(Button)
      .find((node) => node.props['data-testid'] === 'account-settings-scheduling-apply');
  const getText = () => JSON.stringify(renderer.toJSON());

  return {
    renderer,
    getSelect,
    getRateScaleInput,
    getResetButton,
    getFirstProductionInput,
    getFirstProductionClear,
    getApplyButton,
    getText,
  };
};

describe('AccountSchedulingPanel', () => {
  beforeEach(() => {
    mocks.updateAccountScheduling.mockReset();
    mocks.showNotification.mockReset();
  });

  it('renders auto tier + effective rate from the baseline, with Apply disabled (not dirty)', () => {
    const panel = mountPanel();
    expect(panel.getSelect().props.value).toBe('auto');
    expect(panel.getRateScaleInput().props.value).toBe('1');
    expect(panel.getApplyButton()?.props.disabled).toBe(true);
    expect(panel.getText()).toContain('Auto-detected tier');
    panel.renderer.unmount();
  });

  it('renders manual badge + current rate when the baseline is already an override', () => {
    const panel = mountPanel({
      initialScheduling: { subscription_tier: 'max_20x', tier_source: 'override', rate_scale: 0.5 },
    });
    expect(panel.getSelect().props.value).toBe('max_20x');
    expect(panel.getRateScaleInput().props.value).toBe('0.5');
    expect(panel.getText()).toContain('Manual tier override');
    panel.renderer.unmount();
  });

  it('[设] enables Apply once dirty, and submits the picked tier + numeric rate_scale', async () => {
    mocks.updateAccountScheduling.mockResolvedValue({
      name: 'claude-acct.json',
      account_scheduling: { subscription_tier: 'max_20x', tier_source: 'override', rate_scale: 0.5 },
    });
    const panel = mountPanel();

    act(() => panel.getSelect().props.onChange('max_20x'));
    act(() =>
      panel.getRateScaleInput().props.onChange({ target: { value: '0.5' } } as ChangeEvent<HTMLInputElement>)
    );
    expect(panel.getApplyButton()?.props.disabled).toBe(false);

    await act(async () => {
      await panel.getApplyButton()?.props.onClick();
    });

    expect(mocks.updateAccountScheduling).toHaveBeenCalledWith({
      name: 'claude-acct.json',
      auth_index: 1,
      tier_override: 'max_20x',
      rate_scale: 0.5,
    });
    panel.renderer.unmount();
  });

  it('[清] the reset button clears rate_scale to empty, and selecting Auto clears tier_override on apply', async () => {
    mocks.updateAccountScheduling.mockResolvedValue({
      name: 'claude-acct.json',
      account_scheduling: autoScheduling,
    });
    const panel = mountPanel({
      initialScheduling: { subscription_tier: 'max_20x', tier_source: 'override', rate_scale: 0.5 },
    });

    act(() => panel.getSelect().props.onChange('auto'));
    act(() => panel.getResetButton()?.props.onClick());
    expect(panel.getRateScaleInput().props.value).toBe('');

    await act(async () => {
      await panel.getApplyButton()?.props.onClick();
    });

    expect(mocks.updateAccountScheduling).toHaveBeenCalledWith(
      expect.objectContaining({ tier_override: null, rate_scale: null })
    );
    panel.renderer.unmount();
  });

  it('[非法] shows an inline error and disables Apply for a non-positive rate_scale, without calling the API', () => {
    const panel = mountPanel();

    act(() => panel.getSelect().props.onChange('max_20x'));
    act(() =>
      panel.getRateScaleInput().props.onChange({ target: { value: '-1' } } as ChangeEvent<HTMLInputElement>)
    );

    expect(panel.getRateScaleInput().props.error).toBeTruthy();
    expect(panel.getApplyButton()?.props.disabled).toBe(true);
    expect(mocks.updateAccountScheduling).not.toHaveBeenCalled();
    panel.renderer.unmount();
  });

  it('refreshes the displayed badge/effective rate from the API response, not the submitted form values', async () => {
    // 用户提交 max_20x / 0.3，但 core 回显 pro / 2——UI 必须显示回显值。
    mocks.updateAccountScheduling.mockResolvedValue({
      name: 'claude-acct.json',
      account_scheduling: { subscription_tier: 'pro', tier_source: 'override', rate_scale: 2 },
    });
    const panel = mountPanel();

    act(() => panel.getSelect().props.onChange('max_20x'));
    act(() =>
      panel.getRateScaleInput().props.onChange({ target: { value: '0.3' } } as ChangeEvent<HTMLInputElement>)
    );

    await act(async () => {
      await panel.getApplyButton()?.props.onClick();
    });

    expect(panel.getText()).toContain('Effective rate scale: 2');
    expect(panel.getSelect().props.value).toBe('pro');
    expect(panel.getRateScaleInput().props.value).toBe('2');
    panel.renderer.unmount();
  });

  it('invokes onApplied with the server-echoed projection after a successful save', async () => {
    const onApplied = vi.fn();
    const echoed: AuthFileAccountScheduling = {
      subscription_tier: 'max_20x',
      tier_source: 'override',
      rate_scale: 0.5,
    };
    mocks.updateAccountScheduling.mockResolvedValue({
      name: 'claude-acct.json',
      account_scheduling: echoed,
    });
    const panel = mountPanel({ onApplied });

    act(() => panel.getSelect().props.onChange('max_20x'));
    await act(async () => {
      await panel.getApplyButton()?.props.onClick();
    });

    expect(onApplied).toHaveBeenCalledWith(echoed);
    panel.renderer.unmount();
  });

  it('disables all controls when the disabled prop is set', () => {
    const panel = mountPanel({ disabled: true });
    expect(panel.getSelect().props.disabled).toBe(true);
    expect(panel.getRateScaleInput().props.disabled).toBe(true);
    expect(panel.getApplyButton()?.props.disabled).toBe(true);
    panel.renderer.unmount();
  });

  it('shows a readable error (with legal_values) when the API rejects the request', async () => {
    mocks.updateAccountScheduling.mockRejectedValue({
      message: 'invalid tier_override',
      status: 400,
      data: { error: 'invalid tier_override', legal_values: ['max_20x', 'max_5x', 'pro'] },
    });
    const panel = mountPanel();

    act(() => panel.getSelect().props.onChange('max_20x'));
    await act(async () => {
      await panel.getApplyButton()?.props.onClick();
    });

    expect(panel.getText()).toContain('max_20x, max_5x, pro');
    panel.renderer.unmount();
  });

  it('[养号锚点] renders a datetime-local first_production_at input with the warning hint and auto status when unset', () => {
    const panel = mountPanel();
    const input = panel.getFirstProductionInput();
    expect(input.props.type).toBe('datetime-local');
    expect(input.props.value).toBe('');
    // 警示小字：设得比真实早会 skip warm-up（封号风险）。
    expect(panel.getText()).toContain('ban risk');
    // 未锚定 → 状态回显「自动打戳」。
    expect(panel.getText()).toContain('Auto (stamped on first serve)');
    panel.renderer.unmount();
  });

  it('[养号锚点·回显] renders the current anchor + warmup stage/mature/age from the projection', () => {
    const panel = mountPanel({ initialScheduling: anchoredScheduling });
    expect(panel.getFirstProductionInput().props.value).not.toBe('');
    expect(panel.getText()).toContain('Stage: mature');
    expect(panel.getText()).toContain('Mature');
    expect(panel.getText()).toContain('Age: 240d');
    panel.renderer.unmount();
  });

  it('[养号锚点·设] submits the picked date as RFC3339 when the anchor changes', async () => {
    mocks.updateAccountScheduling.mockResolvedValue({
      name: 'claude-acct.json',
      account_scheduling: anchoredScheduling,
    });
    const panel = mountPanel();

    const localInput = '2020-06-15T10:30';
    act(() =>
      panel
        .getFirstProductionInput()
        .props.onChange({ target: { value: localInput } } as ChangeEvent<HTMLInputElement>)
    );
    expect(panel.getApplyButton()?.props.disabled).toBe(false);

    await act(async () => {
      await panel.getApplyButton()?.props.onClick();
    });

    expect(mocks.updateAccountScheduling).toHaveBeenCalledWith(
      expect.objectContaining({ first_production_at: new Date(localInput).toISOString() })
    );
    panel.renderer.unmount();
  });

  it('[养号锚点·清] the clear button empties the input and submits null to restore auto', async () => {
    mocks.updateAccountScheduling.mockResolvedValue({
      name: 'claude-acct.json',
      account_scheduling: autoScheduling,
    });
    const panel = mountPanel({ initialScheduling: anchoredScheduling });

    expect(panel.getFirstProductionInput().props.value).not.toBe('');
    act(() => panel.getFirstProductionClear()?.props.onClick());
    expect(panel.getFirstProductionInput().props.value).toBe('');

    await act(async () => {
      await panel.getApplyButton()?.props.onClick();
    });

    expect(mocks.updateAccountScheduling).toHaveBeenCalledWith(
      expect.objectContaining({ first_production_at: null })
    );
    panel.renderer.unmount();
  });

  it('[养号锚点·未来] shows an inline error and disables Apply for a future date, without calling the API', () => {
    const panel = mountPanel();

    act(() =>
      panel
        .getFirstProductionInput()
        .props.onChange({ target: { value: '3000-01-01T00:00' } } as ChangeEvent<HTMLInputElement>)
    );

    expect(panel.getFirstProductionInput().props.error).toBeTruthy();
    expect(panel.getApplyButton()?.props.disabled).toBe(true);
    expect(mocks.updateAccountScheduling).not.toHaveBeenCalled();
    panel.renderer.unmount();
  });

  it('disables the first_production_at input + clear button when the disabled prop is set', () => {
    const panel = mountPanel({ initialScheduling: anchoredScheduling, disabled: true });
    expect(panel.getFirstProductionInput().props.disabled).toBe(true);
    expect(panel.getFirstProductionClear()?.props.disabled).toBe(true);
    panel.renderer.unmount();
  });
});
