import { describe, expect, it } from 'vitest';
import { maskQuotaAccountText, resolveQuotaAccountDisplayText } from './quotaDisplay';

describe('quotaDisplay', () => {
  it('uses note first, keeps a masked email visible, and exposes the full email for hover', () => {
    const display = resolveQuotaAccountDisplayText(
      {
        name: 'very-long-account-name@example.com.json',
        email: 'actual-account@example.com',
        note: '生产主账号',
      },
      'masked'
    );

    expect(display.primary).toBe('生产主账号');
    expect(display.secondary).toBe('ac***@example.com');
    expect(display.title).toBe('actual-account@example.com');
  });

  it('shows full credential names when full display mode is selected', () => {
    const display = resolveQuotaAccountDisplayText(
      { name: 'very-long-account-name@example.com.json' },
      'full'
    );

    expect(display.primary).toBe('very-long-account-name@example.com');
    expect(display.title).toBe('very-long-account-name@example.com');
  });

  it('masks key-like credential names before applying generic filename masking', () => {
    const masked = maskQuotaAccountText('sk-proj-secret-value-1234567890.json');

    expect(masked).not.toContain('secret-value');
    expect(masked).toMatch(/^sk\*+/);
  });

  it('falls back to compact masking for long non-email credential names', () => {
    expect(maskQuotaAccountText('personal-codex-account.json')).toBe('per***ount.json');
  });
});
