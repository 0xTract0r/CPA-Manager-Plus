import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { AuthFileItem } from '@/types';
import fixtures from '@/features/demo/pacingFixtures.json';
import en from '@/i18n/locales/en.json';
import zh from '@/i18n/locales/zh-CN.json';
import tw from '@/i18n/locales/zh-TW.json';
import ru from '@/i18n/locales/ru.json';
import { WarmupPacingButton, WarmupPacingModal } from './WarmupPacing';
import { AuthFileCard, type AuthFileCardProps } from './AuthFileCard';
import { getAuthFileSelectionKey } from '../model/authFilesPageModel';
import { pacingBalanceLevel } from '../model/warmupPacing';

vi.mock('@/components/ui/Modal', () => ({
  Modal: ({ open, title, children }: { open: boolean; title: unknown; children: unknown }) =>
    open ? (
      <section>
        {title as React.ReactNode}
        {children as React.ReactNode}
      </section>
    ) : null,
}));
vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({
    t: (key: string, options: Record<string, unknown> = {}) => {
      const value = key.startsWith('auth_files.pacing.')
        ? en.auth_files.pacing[key.split('.').slice(-1)[0] as keyof typeof en.auth_files.pacing]
        : (options.defaultValue ?? key);
      return Object.entries(options).reduce(
        (text, [name, value]) => text.split(`{{${name}}}`).join(String(value)),
        String(value)
      );
    },
    i18n: { language: 'en', resolvedLanguage: 'en' },
  }),
}));

const file = (name = 'pro') =>
  structuredClone(
    fixtures.files.find((item) => item.name === `pacing-${name}.json`)
  ) as AuthFileItem;
const snapshot = (balance: number | null, threshold: number | null = 4) => ({
  ...file().account_scheduling!.warmup_traffic_pacing!,
  request_balance: balance,
  min_admission_requests: threshold,
});
const props: Omit<AuthFileCardProps, 'file'> = {
  compact: true,
  selected: false,
  resolvedTheme: 'light',
  disableControls: false,
  deleting: null,
  statusUpdating: {},
  statusBarCache: new Map(),
  onShowModels: () => {},
  onShowWarmupPacing: () => {},
  onDownload: () => {},
  onOpenAccountSettings: () => {},
  onDelete: () => {},
  onToggleStatus: () => {},
  onToggleSelect: () => {},
};
function render(element: React.ReactElement) {
  let view!: ReactTestRenderer;
  act(() => {
    view = create(element);
  });
  return view;
}
const text = (view: ReactTestRenderer) => JSON.stringify(view.toJSON());

describe('warmup pacing', () => {
  it.each([
    [0, 4, 'empty'],
    [0.999, 4, 'empty'],
    [1, 4, 'low'],
    [3.99, 4, 'low'],
    [4, 4, 'ready'],
    [5, 6, 'low'],
    [6, 6, 'ready'],
    [1, 1, 'ready'],
    [2, null, 'unknown'],
    [null, 4, 'unknown'],
    [NaN, 4, 'unknown'],
    [-1, 4, 'unknown'],
  ] as const)('colors balance %s using actual threshold %s', (balance, threshold, level) => {
    expect(pacingBalanceLevel(snapshot(balance, threshold))).toBe(level);
  });
  it.each(['disabled', 'error', 'uninitialized', 'not_applicable'] as const)(
    'never shows stale positive balance as ready for %s',
    (status) => {
      const stale = { ...snapshot(8), status };
      expect(pacingBalanceLevel(stale)).toBe('unknown');
      const target = file();
      target.account_scheduling!.warmup_traffic_pacing = stale;
      const view = render(<WarmupPacingModal file={target} open onClose={() => {}} />);
      expect(view.root.findByProps({ 'data-testid': 'pacing-balance' }).children[0]).toBe('—');
    }
  );
  it('opens by the account identity key and keeps unknown separate from zero', () => {
    const onOpen = vi.fn();
    const target = file('unknown');
    const view = render(<WarmupPacingButton file={target} onOpen={onOpen} />);
    const button = view.root.findByType('button');
    expect(button.props['data-level']).toBe('unknown');
    expect(text(view)).toContain('Unknown');
    act(() => button.props.onClick());
    expect(onOpen).toHaveBeenCalledWith(getAuthFileSelectionKey(target));
  });
  it.each([
    [0.999, 4, '0.99', 'empty'],
    [11.999, 12, '11.99', 'low'],
    [2.55, 4, '2.55', 'low'],
  ] as const)(
    'never rounds balance %s across threshold %s',
    (balance, threshold, displayed, level) => {
      const target = file();
      target.account_scheduling!.warmup_traffic_pacing = {
        ...snapshot(balance, threshold),
        request_capacity: 16,
      };
      const entry = render(<WarmupPacingButton file={target} onOpen={() => {}} />);
      expect(text(entry)).toContain(`${displayed}/16`);
      expect(entry.root.findByType('button').props['data-level']).toBe(level);
      const detail = render(<WarmupPacingModal file={target} open onClose={() => {}} />);
      expect(detail.root.findByProps({ 'data-testid': 'pacing-balance' }).children[0]).toBe(
        displayed
      );
    }
  );
  it('emits distinct stable keys for same-name accounts across index aliases', () => {
    const first = { ...file(), name: 'shared.json', auth_index: 'first' };
    const second = { ...file(), name: 'shared.json', auth_index: undefined, authIndex: 'second' };
    const onOpen = vi.fn();
    const view = render(
      <>
        <WarmupPacingButton file={first} onOpen={onOpen} />
        <WarmupPacingButton file={second} onOpen={onOpen} />
      </>
    );
    act(() => view.root.findAllByType('button')[1].props.onClick());
    expect(onOpen).toHaveBeenCalledWith(getAuthFileSelectionKey(second));
    expect(onOpen).not.toHaveBeenCalledWith(getAuthFileSelectionKey(first));
    const refreshed = { ...second, authIndex: undefined, auth_index: 'second' };
    expect(getAuthFileSelectionKey(refreshed)).toBe(getAuthFileSelectionKey(second));
  });
  it('shows entry only for known Claude warming accounts and preserves manual tier', () => {
    for (const target of [
      file('mature'),
      { ...file(), type: 'codex', provider: 'codex' },
      { ...file(), account_scheduling: null },
    ]) {
      const view = render(<AuthFileCard {...props} file={target} />);
      expect(view.root.findAllByType(WarmupPacingButton)).toHaveLength(0);
    }
    const target = file('max20');
    const view = render(<AuthFileCard {...props} file={target} />);
    expect(view.root.findAllByType(WarmupPacingButton)).toHaveLength(1);
    expect(
      view.root.findByProps({ 'data-testid': `auth-file-tier-override-${target.name}` })
    ).toBeTruthy();
  });
  it('renders dynamic limits, pending reservations, safe blockers and updated snapshots', () => {
    const target = file('max20');
    const view = render(<WarmupPacingModal file={target} open onClose={() => {}} />);
    expect(text(view)).toContain('Active group limit reached');
    expect(text(view)).toContain('not yet sent');
    expect(text(view)).toContain('other limits still affect sending');
    expect(view.root.findByProps({ role: 'progressbar' }).props['aria-valuemax']).toBe(12);
    const changed = file('threshold');
    changed.account_scheduling!.warmup_traffic_pacing!.reason = 'private/internal/path';
    changed.account_scheduling!.warmup_traffic_pacing!.blocking_reasons = ['private/internal/path'];
    act(() => view.update(<WarmupPacingModal file={changed} open onClose={() => {}} />));
    expect(view.root.findByProps({ role: 'progressbar' }).props['aria-valuemax']).toBe(3);
    expect(text(view)).not.toContain('private/internal/path');
  });
  it('does not render a zero-time snapshot as a real observation', () => {
    const target = file();
    target.account_scheduling!.warmup_traffic_pacing!.observed_at = '0001-01-01T00:00:00Z';
    const view = render(<WarmupPacingModal file={target} open onClose={() => {}} />);
    expect(text(view)).not.toContain('0001-01-01');
    expect(view.root.findByType('time').children).toEqual(['Unknown']);
  });
  it('keeps all four locale resources complete', () => {
    for (const locale of [zh, tw, ru])
      expect(Object.keys(locale.auth_files.pacing).sort()).toEqual(
        Object.keys(en.auth_files.pacing).sort()
      );
  });
});
