import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { AccountLimitPolicy, AuthFileAccountScheduling } from '@/types/authFile';
import { AccountLimitPolicyPanel } from './AccountLimitPolicyPanel';
import { LIMIT_FIELDS } from '../model/accountLimitPolicy';
const { patch } = vi.hoisted(() => ({ patch: vi.fn() }));
vi.mock('@/services/api/authFiles', () => ({ authFilesApi: { updateAccountScheduling: patch } }));
vi.mock('./AccountWarmupSummary', () => ({ AccountWarmupSummary: () => null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const scheduling = (): AuthFileAccountScheduling => ({
  warmup_control: {
    speed_profile: null,
    warmup_mode: 'auto',
    warmup_period_days: null,
    effective_period_days: 60,
    manual_mature: false,
    source: 'legacy',
    profiles: ['low', 'medium', 'high', 'extreme'].map((id) => ({
      id,
      rpm: 5,
      daily_budget: 500,
      concurrency: 1,
      request_capacity: 8,
      max_active_bindings: 1,
    })) as NonNullable<AuthFileAccountScheduling['warmup_control']>['profiles'],
  },
  limit_policy: {
    fields: Object.fromEntries(
      LIMIT_FIELDS.map((name) => [
        name,
        {
          baseline: 4,
          effective: 4,
          min: 1,
          max: 100,
          source: 'baseline',
          fixed: null,
          temporary: null,
        },
      ])
    ) as AccountLimitPolicy['fields'],
    temporary_status: 'none',
    temporary_issued_at: null,
    temporary_expires_at: null,
    temporary_end_reason: null,
    restricted_reasons: [],
  } as AccountLimitPolicy,
});
function render(view: AuthFileAccountScheduling) {
  let element!: ReactTestRenderer;
  act(() => {
    element = create(
      <AccountLimitPolicyPanel fileName="one.json" authIndex="one" initialScheduling={view} />
    );
  });
  return element;
}
describe('speed and warm-up editor', () => {
  it('submits only the selected account with speed and period in one request', async () => {
    const baseline = scheduling();
    patch.mockResolvedValue({
      account_scheduling: {
        ...baseline,
        warmup_control: {
          ...baseline.warmup_control,
          speed_profile: 'high',
          warmup_period_days: 30,
          effective_period_days: 30,
        },
      },
    });
    const view = render(baseline);
    expect(view.root.findByProps({ 'data-testid': 'apply-account-limits' }).props.disabled).toBe(
      true
    );
    act(() => view.root.findByProps({ 'data-testid': 'speed-profile-high' }).props.onChange());
    act(() => view.root.findByProps({ 'data-testid': 'warmup-mode-days' }).props.onChange());
    act(() =>
      view.root
        .findByProps({ 'data-testid': 'warmup-period-days' })
        .props.onChange({ target: { value: '30' } })
    );
    await act(async () =>
      view.root.findByProps({ 'data-testid': 'apply-account-limits' }).props.onClick()
    );
    expect(patch).toHaveBeenLastCalledWith({
      name: 'one.json',
      auth_index: 'one',
      speed_profile: 'high',
      warmup_period_days: 30,
    });
    expect(view.root.findByProps({ 'data-testid': 'speed-profile-high' }).props.checked).toBe(true);
    act(() => view.unmount());
  });
  it('uses only legacy fields for numeric edits and echoes the custom profile state', async () => {
    const baseline = scheduling();
    baseline.warmup_control!.speed_profile = 'high';
    patch.mockResolvedValue({
      account_scheduling: {
        ...baseline,
        warmup_control: { ...baseline.warmup_control!, speed_profile: null, source: 'legacy' },
      },
    });
    const view = render(baseline);
    act(() => view.root.findAllByType('select')[0].props.onChange({ target: { value: 'fixed' } }));
    act(() =>
      view.root.findByProps({ id: 'limit-rpm' }).props.onChange({ target: { value: '5' } })
    );
    await act(async () =>
      view.root.findByProps({ 'data-testid': 'apply-account-limits' }).props.onClick()
    );
    expect(patch).toHaveBeenLastCalledWith({
      name: 'one.json',
      auth_index: 'one',
      speed_profile: null,
      limit_overrides: { rpm: 5 },
    });
    expect(view.root.findByProps({ 'data-testid': 'speed-profile-high' }).props.checked).toBe(
      false
    );
    act(() => view.unmount());
  });
  it('disables new controls when the server projection is absent', () => {
    const baseline = scheduling();
    delete baseline.warmup_control;
    const view = render(baseline);
    expect(view.root.findByProps({ 'data-testid': 'speed-profile-high' }).props.disabled).toBe(
      true
    );
    expect(view.root.findByProps({ 'data-testid': 'warmup-mode-picker' }).props.disabled).toBe(
      true
    );
    act(() => view.unmount());
  });
  it('keeps dirty speed drafts when parent data refreshes', () => {
    const baseline = scheduling();
    const view = render(baseline);
    act(() => view.root.findByProps({ 'data-testid': 'speed-profile-low' }).props.onChange());
    act(() =>
      view.update(
        <AccountLimitPolicyPanel
          fileName="one.json"
          authIndex="one"
          initialScheduling={{
            ...baseline,
            warmup_control: { ...baseline.warmup_control!, speed_profile: 'extreme' },
          }}
        />
      )
    );
    expect(view.root.findByProps({ 'data-testid': 'speed-profile-low' }).props.checked).toBe(true);
    act(() => view.unmount());
  });
});
