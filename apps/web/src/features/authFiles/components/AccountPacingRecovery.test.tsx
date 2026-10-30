import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthFileItem } from '@/types';
import fixtures from '@/features/demo/pacingFixtures.json';
import { AccountPacingRecovery } from './AccountPacingRecovery';
const live = vi.hoisted(() => ({
  value: {} as { file: AuthFileItem; stale: boolean; failed: boolean; eta: number | null },
}));
vi.mock('../hooks/useWarmupPacing', async (original) => ({
  ...(await original<typeof import('../hooks/useWarmupPacing')>()),
  useWarmupPacing: () => live.value,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const render = () => {
  let view!: ReactTestRenderer;
  act(() => {
    view = create(<AccountPacingRecovery file={live.value.file} />);
  });
  return view;
};
beforeEach(() => {
  live.value = {
    file: structuredClone(fixtures.files[0]) as AuthFileItem,
    stale: false,
    failed: false,
    eta: 12,
  };
});
describe('compact live recovery summary', () => {
  it('shows mature policy without a fictitious recovery countdown', () => {
    live.value.file.account_scheduling!.warmup = { mature: true };
    const view = render();
    expect(JSON.stringify(view.toJSON())).toContain('mature_policy_active');
    expect(JSON.stringify(view.toJSON())).not.toContain('compact_admission_eta');
    expect(view.root.findAllByProps({ role: 'progressbar' })).toHaveLength(0);
    act(() => view.unmount());
  });
  it('reports health restrictions when manual maturity has not made the account mature', () => {
    live.value.file.account_scheduling!.warmup = { mature: false };
    live.value.file.account_scheduling!.warmup_control = {
      speed_profile: 'medium',
      warmup_mode: 'mature',
      warmup_period_days: null,
      effective_period_days: 60,
      source: 'profile',
      manual_mature: true,
      profiles: [],
    };
    const view = render();
    expect(JSON.stringify(view.toJSON())).toContain('manual_mature_restricted');
    act(() => view.unmount());
  });
  it('requires server balance confirmation when the countdown reaches zero', () => {
    live.value.eta = 0;
    const snapshot = live.value.file.account_scheduling!.warmup_traffic_pacing!;
    snapshot.request_balance = 1;
    snapshot.min_admission_requests = 4;
    const view = render();
    expect(JSON.stringify(view.toJSON())).toContain('await_confirmation');
    act(() => view.unmount());
  });
});
