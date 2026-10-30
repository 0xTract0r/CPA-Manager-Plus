import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { AuthFileAccountScheduling, AuthFileItem } from '@/types';
import { AccountLimitsModal } from './AccountLimitsModal';
import { AccountPacingRecovery } from './AccountPacingRecovery';
import { AccountSchedulingEditor } from './AccountSchedulingEditor';
import { Modal } from '@/components/ui/Modal';

const { showConfirmation } = vi.hoisted(() => ({ showConfirmation: vi.fn() }));

vi.mock('@/components/ui/Modal', () => ({
  Modal: ({ children }: { children: ReactNode }) => <section>{children}</section>,
}));
vi.mock('./AccountPacingRecovery', () => ({ AccountPacingRecovery: () => null }));
vi.mock('./AccountSchedulingEditor', () => ({ AccountSchedulingEditor: () => null }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/stores', () => ({
  useNotificationStore: (selector: (state: { showConfirmation: () => void }) => unknown) =>
    selector({ showConfirmation }),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

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
  act(() => view.root.findByType(AccountSchedulingEditor).props.onApplied(saved));
  expect(view.root.findByType(AccountPacingRecovery).props.file.account_scheduling).toBe(saved);
  expect(view.root.findByType(AccountSchedulingEditor).props.initialScheduling).toBe(saved);
  expect(onApplied).toHaveBeenCalledWith('one.json', saved);
  expect(consoleError.mock.calls.flat().join(' ')).not.toMatch(/same key/i);
  act(() => view.unmount());
});

it('keeps closing stable while committing the latest callbacks and form guards', () => {
  const initialClose = vi.fn();
  const latestClose = vi.fn();
  const props = {
    file: { name: 'one.json', auth_index: 'one' },
    backLabel: 'Back',
    onClose: initialClose,
    onBack: () => {},
    onApplied: () => {},
  };
  let view!: ReactTestRenderer;
  act(() => {
    view = create(<AccountLimitsModal {...props} />);
  });
  const close = view.root.findByType(Modal).props.onClose;
  act(() =>
    view.root
      .findByType(AccountSchedulingEditor)
      .props.onStateChange({ dirty: false, saving: true })
  );
  act(() => view.update(<AccountLimitsModal {...props} onClose={latestClose} />));
  expect(view.root.findByType(Modal).props.onClose).toBe(close);
  act(() => close());
  expect(initialClose).not.toHaveBeenCalled();
  expect(latestClose).not.toHaveBeenCalled();
  act(() =>
    view.root
      .findByType(AccountSchedulingEditor)
      .props.onStateChange({ dirty: true, saving: false })
  );
  act(() => close());
  expect(showConfirmation).toHaveBeenCalledTimes(1);
  act(() => showConfirmation.mock.calls[0][0].onConfirm());
  expect(latestClose).toHaveBeenCalledTimes(1);
  expect(initialClose).not.toHaveBeenCalled();
  act(() => view.unmount());
});
