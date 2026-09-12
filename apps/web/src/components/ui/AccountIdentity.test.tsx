import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { resolveAccountIdentity } from '@/utils/accountIdentity';
import { AccountIdentity } from './AccountIdentity';

describe('AccountIdentity', () => {
  it('renders note first and opens the full-email tooltip on hover', () => {
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
    expect(email.children).toEqual(['ow***@example.test']);
    expect(renderer!.root.findAllByProps({ role: 'tooltip' })).toHaveLength(0);

    act(() => email.props.onMouseEnter());
    expect(renderer!.root.findByProps({ role: 'tooltip' }).children).toEqual([
      'owner.long+prod@example.test',
    ]);

    act(() => email.props.onMouseLeave());
    expect(renderer!.root.findAllByProps({ role: 'tooltip' })).toHaveLength(0);

    act(() => email.props.onFocus());
    expect(renderer!.root.findByProps({ role: 'tooltip' }).children).toEqual([
      'owner.long+prod@example.test',
    ]);
  });

  it('keeps a masked email as the primary line when no note exists', () => {
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
    expect(email.children).toEqual(['qa***@example.test']);
    expect(renderer!.root.findByProps({ 'data-testid': 'fallback' }).props['data-has-note']).toBe(
      'false'
    );
  });
});
