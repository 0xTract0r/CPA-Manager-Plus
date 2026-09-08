import { act, type ChangeEvent } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { getDemoAuthFiles } from '@/features/demo/demoFixtures';
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
  getFirstProductionSetNow: () => ReturnType<ReactTestRenderer['root']['findByType']> | undefined;
  getCandidateLastActivity: () => ReturnType<ReactTestRenderer['root']['findByType']> | undefined;
  getCandidateFirstAuth: () => ReturnType<ReactTestRenderer['root']['findByType']> | undefined;
  getCandidateNow: () => ReturnType<ReactTestRenderer['root']['findByType']> | undefined;
  getApplyButton: () => ReturnType<ReactTestRenderer['root']['findByType']> | undefined;
  getText: () => string;
};

// 把 RFC3339 派生成组件写入输入框的 datetime-local 值（分钟精度、本地 wall-clock），
// 与 AccountSchedulingPanel 内 rfc3339ToDatetimeLocal 同款，用来做时区无关的断言。
const toLocalInput = (rfc: string): string => {
  const d = new Date(rfc);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const LAST_ACTIVITY_RFC = '2026-09-02T13:19:00Z';
const FIRST_AUTH_RFC = '2026-08-30T06:05:00Z';

const candidatesScheduling: AuthFileAccountScheduling = {
  subscription_tier: 'max_5x',
  tier_source: 'auto',
  rate_scale: 1,
  anchor_candidates: {
    last_activity_at: LAST_ACTIVITY_RFC,
    first_auth_at: FIRST_AUTH_RFC,
  },
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
  const getFirstProductionSetNow = () =>
    renderer.root
      .findAllByType(Button)
      .find(
        (node) =>
          node.props['data-testid'] === 'account-settings-scheduling-first-production-at-set-now'
      );
  const getCandidateLastActivity = () =>
    renderer.root
      .findAllByType(Button)
      .find(
        (node) =>
          node.props['data-testid'] ===
          'account-settings-scheduling-first-production-at-candidate-last-activity'
      );
  const getCandidateFirstAuth = () =>
    renderer.root
      .findAllByType(Button)
      .find(
        (node) =>
          node.props['data-testid'] ===
          'account-settings-scheduling-first-production-at-candidate-first-auth'
      );
  const getCandidateNow = () =>
    renderer.root
      .findAllByType(Button)
      .find(
        (node) =>
          node.props['data-testid'] ===
          'account-settings-scheduling-first-production-at-candidate-now'
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
    getFirstProductionSetNow,
    getCandidateLastActivity,
    getCandidateFirstAuth,
    getCandidateNow,
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

  it('[养号锚点·清] the clear button (two-step) empties the input and submits null to restore auto', async () => {
    mocks.updateAccountScheduling.mockResolvedValue({
      name: 'claude-acct.json',
      account_scheduling: autoScheduling,
    });
    const panel = mountPanel({ initialScheduling: anchoredScheduling });

    expect(panel.getFirstProductionInput().props.value).not.toBe('');
    // 两步确认：第一次点只武装，不清空；第二次点才清空。
    act(() => panel.getFirstProductionClear()?.props.onClick());
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

  it('disables the first_production_at input + set-now + clear buttons when the disabled prop is set', () => {
    const panel = mountPanel({ initialScheduling: anchoredScheduling, disabled: true });
    expect(panel.getFirstProductionInput().props.disabled).toBe(true);
    expect(panel.getFirstProductionClear()?.props.disabled).toBe(true);
    expect(panel.getFirstProductionSetNow()?.props.disabled).toBe(true);
    panel.renderer.unmount();
  });

  it('[养号锚点·当前时间] the set-now button fills the input with the current local time and enables Apply', () => {
    vi.useFakeTimers();
    // 固定为一个过去的本地时间：nowDatetimeLocal() 用本地 getter 截断到分钟，
    // 断言值与时区无关；且 ≤ now 不会触发未来时间校验。
    vi.setSystemTime(new Date('2026-05-01T08:30:00'));
    try {
      const panel = mountPanel();
      expect(panel.getFirstProductionInput().props.value).toBe('');

      act(() => panel.getFirstProductionSetNow()?.props.onClick());

      expect(panel.getFirstProductionInput().props.value).toBe('2026-05-01T08:30');
      // 设为当前时间后表单 dirty，Apply 可点（走现有 PATCH set 路径）。
      expect(panel.getApplyButton()?.props.disabled).toBe(false);
      expect(panel.getFirstProductionInput().props.error).toBeFalsy();
      panel.renderer.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('[养号锚点·清·两步确认] the clear button arms a confirm state on the first click and only clears on the second', () => {
    const panel = mountPanel({ initialScheduling: anchoredScheduling });
    expect(panel.getFirstProductionInput().props.value).not.toBe('');

    // 第一次点：武装成「确认清除?」，输入不变。
    act(() => panel.getFirstProductionClear()?.props.onClick());
    expect(panel.getFirstProductionInput().props.value).not.toBe('');
    expect(panel.getText()).toContain('Confirm clear?');

    // 第二次点：真正清空。
    act(() => panel.getFirstProductionClear()?.props.onClick());
    expect(panel.getFirstProductionInput().props.value).toBe('');
    panel.renderer.unmount();
  });

  it('[养号锚点·两步确认解除] editing the date (or set-now) disarms a pending clear confirm', () => {
    const panel = mountPanel({ initialScheduling: anchoredScheduling });

    // 武装确认。
    act(() => panel.getFirstProductionClear()?.props.onClick());
    expect(panel.getText()).toContain('Confirm clear?');

    // 手动改日期 → 解除武装，回到普通「清除」，且不清空。
    act(() =>
      panel
        .getFirstProductionInput()
        .props.onChange({ target: { value: '2021-03-03T09:00' } } as ChangeEvent<HTMLInputElement>)
    );
    expect(panel.getText()).not.toContain('Confirm clear?');
    expect(panel.getFirstProductionInput().props.value).toBe('2021-03-03T09:00');
    panel.renderer.unmount();
  });

  it('[候选锚点·设] clicking a candidate sets the date input to that value and enables Apply', async () => {
    mocks.updateAccountScheduling.mockResolvedValue({
      name: 'claude-acct.json',
      account_scheduling: candidatesScheduling,
    });
    const panel = mountPanel({ initialScheduling: candidatesScheduling });

    // 未点前输入为空（该基线没有 first_production_at），候选按钮显示各自的具体时间。
    expect(panel.getFirstProductionInput().props.value).toBe('');
    expect(panel.getText()).toContain('Last activity');
    expect(panel.getText()).toContain(toLocalInput(LAST_ACTIVITY_RFC).replace('T', ' '));

    // 点「最近活动」候选 → 输入被设成该候选对应的 datetime-local 值，Apply 变可点。
    act(() => panel.getCandidateLastActivity()?.props.onClick());
    expect(panel.getFirstProductionInput().props.value).toBe(toLocalInput(LAST_ACTIVITY_RFC));
    expect(panel.getApplyButton()?.props.disabled).toBe(false);

    // 走现有 PATCH set 路径：提交把该候选时间作为 RFC3339 first_production_at 回传。
    await act(async () => {
      await panel.getApplyButton()?.props.onClick();
    });
    expect(mocks.updateAccountScheduling).toHaveBeenCalledWith(
      expect.objectContaining({ first_production_at: new Date(LAST_ACTIVITY_RFC).toISOString() })
    );
    panel.renderer.unmount();
  });

  it('[候选锚点·次选] clicking the first-auth candidate sets the input to that value', () => {
    const panel = mountPanel({ initialScheduling: candidatesScheduling });
    act(() => panel.getCandidateFirstAuth()?.props.onClick());
    expect(panel.getFirstProductionInput().props.value).toBe(toLocalInput(FIRST_AUTH_RFC));
    panel.renderer.unmount();
  });

  it('[候选锚点·缺失] omits the button for a missing candidate value, always keeps "current time"', () => {
    const panel = mountPanel({
      initialScheduling: {
        subscription_tier: 'max_5x',
        tier_source: 'auto',
        rate_scale: 1,
        // 只有 last_activity_at，缺 first_auth_at。
        anchor_candidates: { last_activity_at: LAST_ACTIVITY_RFC },
      },
    });
    expect(panel.getCandidateLastActivity()).toBeDefined();
    // 缺失的候选不渲染对应按钮（优雅降级）。
    expect(panel.getCandidateFirstAuth()).toBeUndefined();
    // 「当前时间」永远有（前端本地算，不依赖投影）。
    expect(panel.getCandidateNow()).toBeDefined();
    panel.renderer.unmount();
  });

  it('[候选锚点·无投影] renders only the "current time" candidate when anchor_candidates is absent', () => {
    // autoScheduling 基线没有 anchor_candidates（真后端投影本轮未接的降级形态）。
    const panel = mountPanel();
    expect(panel.getCandidateLastActivity()).toBeUndefined();
    expect(panel.getCandidateFirstAuth()).toBeUndefined();
    expect(panel.getCandidateNow()).toBeDefined();
    panel.renderer.unmount();
  });

  it('[候选锚点·禁用] disables the candidate buttons when the disabled prop is set', () => {
    const panel = mountPanel({ initialScheduling: candidatesScheduling, disabled: true });
    expect(panel.getCandidateLastActivity()?.props.disabled).toBe(true);
    expect(panel.getCandidateFirstAuth()?.props.disabled).toBe(true);
    expect(panel.getCandidateNow()?.props.disabled).toBe(true);
    panel.renderer.unmount();
  });

  it('[养号锚点·空态] hides the clear button and shows the auto status text when the anchor input is empty', () => {
    // 复现用户报的困惑：账号本就是自动（无锚点）时，输入为空。此时不能出现一个变灰的
    // 「清除」按钮（会被误读成坏掉的「恢复默认」），而应显示「当前已是自动」状态文字。
    const panel = mountPanel(); // autoScheduling：无 first_production_at → 输入为空
    expect(panel.getFirstProductionInput().props.value).toBe('');
    // 空值时「清除」按钮根本不渲染（不是 disabled，而是不在 DOM 里）。
    expect(panel.getFirstProductionClear()).toBeUndefined();
    // 原位改为显示「当前已是自动」状态文字（走独立 testid，且文案是既有 auto 文案）。
    const autoStatus = panel.renderer.root
      .findAll((node) => node.props?.['data-testid'] === 'account-settings-scheduling-first-production-at-auto-status');
    expect(autoStatus.length).toBe(1);
    expect(panel.getText()).toContain('Auto (stamped on first serve)');
    // 「设为当前时间」仍在（用户仍可从这里重新设锚点）。
    expect(panel.getFirstProductionSetNow()).toBeDefined();
    panel.renderer.unmount();
  });

  it('[养号锚点·有值→清空] shows a "Clear" button (no "restore auto" wording), two-step, then hides it and shows auto after clearing', () => {
    const panel = mountPanel({ initialScheduling: anchoredScheduling });
    expect(panel.getFirstProductionInput().props.value).not.toBe('');
    // 有值才渲染「清除」按钮。
    expect(panel.getFirstProductionClear()).toBeDefined();
    // 标签去掉了会被误读成 restore 动作的「/ restore auto」措辞。
    expect(panel.getText()).not.toContain('restore auto');

    // 两步确认：第一次点武装成「确认清除?」，输入不变。
    act(() => panel.getFirstProductionClear()?.props.onClick());
    expect(panel.getText()).toContain('Confirm clear?');
    expect(panel.getFirstProductionInput().props.value).not.toBe('');

    // 第二次点：真正清空。
    act(() => panel.getFirstProductionClear()?.props.onClick());
    expect(panel.getFirstProductionInput().props.value).toBe('');
    // 清空后按钮消失（不是变灰），原位改显「当前已是自动」。
    expect(panel.getFirstProductionClear()).toBeUndefined();
    expect(panel.getText()).toContain('Auto (stamped on first serve)');
    panel.renderer.unmount();
  });

  it('[候选锚点·demo] pro-03 / default-04 fixtures now render last-activity + now candidates in the panel', () => {
    // 用户走查发现有的 claude demo 号打开只剩「当前时间」候选（缺 anchor_candidates）。
    // 补齐后：这两个号在面板里必须至少渲染「最近活动 / 首次认证 / 当前时间」。
    const files = getDemoAuthFiles().files;
    for (const idx of ['claude-pro-03', 'claude-default-04']) {
      const acct = files.find((f) => f.authIndex === idx);
      expect(acct?.provider).toBe('claude');
      const panel = mountPanel({ initialScheduling: acct?.account_scheduling });
      expect(panel.getCandidateLastActivity()).toBeDefined();
      expect(panel.getCandidateFirstAuth()).toBeDefined();
      expect(panel.getCandidateNow()).toBeDefined();
      panel.renderer.unmount();
    }
  });

  it('[候选锚点·demo] claude-research-02 stays the graceful-degradation sample (last-activity only, no first-auth)', () => {
    const acct = getDemoAuthFiles().files.find((f) => f.authIndex === 'claude-research-02');
    const cands = acct?.account_scheduling?.anchor_candidates;
    expect(cands?.last_activity_at).toBeTruthy();
    // 刻意缺 first_auth_at → 面板只渲染「最近活动 / 当前时间」两个候选。
    expect(cands?.first_auth_at == null).toBe(true);
    const panel = mountPanel({ initialScheduling: acct?.account_scheduling });
    expect(panel.getCandidateLastActivity()).toBeDefined();
    expect(panel.getCandidateFirstAuth()).toBeUndefined();
    expect(panel.getCandidateNow()).toBeDefined();
    panel.renderer.unmount();
  });

  it('[候选锚点·demo] every claude demo account exposes at least last-activity candidate data (not just current time)', () => {
    // 断言所有 claude demo 号都带 anchor_candidates.last_activity_at（用相对当前时间、
    // 且必须是过去，满足面板 max=now 禁未来）——用户打开任意 claude 号都能看到候选。
    const claudeAccounts = getDemoAuthFiles().files.filter((f) => f.provider === 'claude');
    expect(claudeAccounts.length).toBeGreaterThanOrEqual(4);
    for (const acct of claudeAccounts) {
      const lastActivity = acct.account_scheduling?.anchor_candidates?.last_activity_at;
      expect(lastActivity, `${acct.authIndex} should have a last_activity_at candidate`).toBeTruthy();
      expect(Date.parse(lastActivity as string)).toBeLessThanOrEqual(Date.now());
    }
  });

  it('[无悬浮槽] renders the reset/set-now/clear actions outside the Input rightElement (no absolute overlap slot)', () => {
    const panel = mountPanel({ initialScheduling: anchoredScheduling });
    // 两个 Input 都不再携带 rightElement（即不再用那个 48px 绝对定位悬浮槽）。
    const inputsWithRightElement = panel.renderer.root
      .findAllByType(Input)
      .filter((node) => node.props.rightElement != null);
    expect(inputsWithRightElement.length).toBe(0);
    // 三个动作按钮仍然存在，只是移出了悬浮槽。
    expect(panel.getResetButton()).toBeDefined();
    expect(panel.getFirstProductionSetNow()).toBeDefined();
    expect(panel.getFirstProductionClear()).toBeDefined();
    panel.renderer.unmount();
  });
});
