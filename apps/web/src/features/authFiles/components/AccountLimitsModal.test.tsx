import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { AuthFileAccountScheduling, AuthFileItem } from '@/types';
import { AccountLimitsModal } from './AccountLimitsModal';
import { AccountPacingRecovery } from './AccountPacingRecovery';
import { AccountSchedulingPanel } from './AccountSchedulingPanel';

vi.mock('@/components/ui/Modal', () => ({
  Modal: ({ children }: { children: ReactNode }) => <section>{children}</section>,
}));
vi.mock('./AccountPacingRecovery', () => ({ AccountPacingRecovery: () => null }));
vi.mock('./AccountSchedulingPanel', () => ({ AccountSchedulingPanel: () => null }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/stores', () => ({
  useNotificationStore: (selector: (state: { showConfirmation: () => void }) => unknown) =>
    selector({ showConfirmation: () => {} }),
}));
afterEach(() => vi.restoreAllMocks());

it('keeps recovery and editor sibling keys distinct before and after saving', () => {
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  const file: AuthFileItem = { name: 'one.json', auth_index: 'one' };
  const saved: AuthFileAccountScheduling = { warmup: { mature: true } };
  const onApplied = vi.fn();
  let view!: ReactTestRenderer;
  act(() => {
    view = create(
      <AccountLimitsModal
        file={file}
        backLabel="Back"
        onClose={() => {}}
        onBack={() => {}}
        onApplied={onApplied}
      />
    );
  });
  act(() => view.root.findByType(AccountSchedulingPanel).props.onApplied(saved));
  expect(view.root.findByType(AccountPacingRecovery).props.file.account_scheduling).toBe(saved);
  expect(view.root.findByType(AccountSchedulingPanel).props.initialScheduling).toBe(saved);
  expect(onApplied).toHaveBeenCalledWith('one.json', saved);
  expect(consoleError.mock.calls.flat().join(' ')).not.toMatch(/same key/i);
  act(() => view.unmount());
});
