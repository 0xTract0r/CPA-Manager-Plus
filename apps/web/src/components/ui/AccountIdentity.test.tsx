import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAccountPrivacyStore } from '@/stores';
import { resolveAccountIdentity } from '@/utils/accountIdentity';
import { AccountIdentity } from './AccountIdentity';
import styles from './AccountIdentity.module.scss';

describe('AccountIdentity', () => {
  beforeEach(() => {
    useAccountPrivacyStore.setState({ maskEmails: false });
    vi.unstubAllGlobals();
  });

  it('renders note first and a directly selectable full email by default', () => {
    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(
        <AccountIdentity
          identity={resolveAccountIdentity({
            note: '生产主账号',
            email: 'owner.long+prod@example.test',
            fallback: 'codex-owner.json',
          })}
          showFallback
          testId="identity"
        />
      );
    });

    expect(renderer!.root.findByProps({ 'data-testid': 'identity' }).props['data-has-note']).toBe(
      'true'
    );
    const email = renderer!.root.findByProps({ 'data-testid': 'identity-email' });
    expect(email.children).toEqual(['owner.long+prod@example.test']);
    expect(email.props['data-email-visibility']).toBe('full');
    expect(renderer!.root.findAllByProps({ role: 'dialog' })).toHaveLength(0);

    act(() => email.props.onMouseEnter());
    expect(renderer!.root.findByProps({ role: 'dialog' })).toBeTruthy();
  });

  it('renders an explicit note label and can move the secondary email out of the identity block', () => {
    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(
        <AccountIdentity
          identity={resolveAccountIdentity({
            note: 'AC-16',
            email: 'owner@example.test',
          })}
          noteLabel="Note"
          showSecondaryEmail={false}
          testId="labeled"
        />
      );
    });

    expect(renderer!.root.findAll((node) => node.children.includes('Note'))).toHaveLength(1);
    expect(renderer!.root.findAll((node) => node.children.includes('AC-16'))).toHaveLength(1);
    expect(renderer!.root.findAllByProps({ 'data-testid': 'labeled-email' })).toHaveLength(0);
  });

  it('uses the labeled grid when a note and secondary email share the content column', () => {
    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(
        <AccountIdentity
          identity={resolveAccountIdentity({
            note: 'AC-13',
            email: 'owner@example.test',
          })}
          noteLabel="Note"
          secondaryEmailLabel="Email"
          testId="aligned"
        />
      );
    });

    const root = renderer!.root.findByProps({ 'data-testid': 'aligned' });
    expect(root.props.className.split(' ')).toContain(styles.labeled);
    expect(renderer!.root.findAll((node) => node.children.includes('Email'))).toHaveLength(1);
    expect(renderer!.root.findByProps({ 'data-testid': 'aligned-email' }).children).toEqual([
      'owner@example.test',
    ]);
  });

  it('uses the full email as the primary line when no note exists', () => {
    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(
        <AccountIdentity
          identity={resolveAccountIdentity({ email: 'qa+fallback@example.test' })}
          testId="fallback"
        />
      );
    });

    const email = renderer!.root.findByProps({ 'data-testid': 'fallback-email' });
    expect(email.children).toEqual(['qa+fallback@example.test']);
    expect(renderer!.root.findByProps({ 'data-testid': 'fallback' }).props['data-has-note']).toBe(
      'false'
    );
  });

  it('can label a primary email when no note exists', () => {
    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(
        <AccountIdentity
          identity={resolveAccountIdentity({ email: 'qa+fallback@example.test' })}
          primaryEmailLabel="Email"
          testId="email-only"
        />
      );
    });

    expect(renderer!.root.findAll((node) => node.children.includes('Email'))).toHaveLength(1);
    expect(renderer!.root.findByProps({ 'data-testid': 'email-only-email' }).children).toEqual([
      'qa+fallback@example.test',
    ]);
  });

  it('does not render an email-like file fallback as a second account email', () => {
    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(
        <AccountIdentity
          identity={resolveAccountIdentity({
            note: '生产账号',
            email: 'account@example.test',
            fallback: 'archive.owner@example.test.json',
          })}
          showFallback
          testId="identity"
        />
      );
    });

    expect(
      renderer!.root.findAllByProps({ 'data-testid': 'identity-fallback-email' })
    ).toHaveLength(0);
    expect(
      renderer!.root.findAll((node) => node.children.includes('archive.owner@example.test'))
    ).toHaveLength(0);
  });

  it('keeps a masked email popover open for copying when privacy mode is enabled', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    useAccountPrivacyStore.setState({ maskEmails: true });

    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(
        <AccountIdentity
          identity={resolveAccountIdentity({
            note: '生产账号',
            email: 'account.owner@example.test',
          })}
          testId="identity"
        />
      );
    });

    let email = renderer!.root.findByProps({ 'data-testid': 'identity-email' });
    expect(email.children).toEqual(['ac***@example.test']);
    expect(email.props['data-email-visibility']).toBe('masked');

    act(() => email.props.onClick());
    email = renderer!.root.findByProps({ 'data-testid': 'identity-email' });
    act(() => email.props.onMouseLeave());
    expect(renderer!.root.findByProps({ role: 'dialog' })).toBeTruthy();

    const copyButton = renderer!.root.findByProps({ 'data-testid': 'identity-email-copy' });
    await act(async () => {
      await copyButton.props.onClick({ preventDefault: vi.fn(), stopPropagation: vi.fn() });
    });
    expect(writeText).toHaveBeenCalledWith('account.owner@example.test');

    act(() => email.props.onKeyDown({ key: 'Escape', preventDefault: vi.fn() }));
    expect(renderer!.root.findAllByProps({ role: 'dialog' })).toHaveLength(0);
  });
});
