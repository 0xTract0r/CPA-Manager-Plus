import { describe, expect, it } from 'vitest';
import type { AuthFileItem } from '@/types';
import {
  formatModified,
  formatModifiedCompact,
  hasAuthFileStatusWarning,
  isAuthFileReauthRequired,
  isHealthyAuthFile,
} from './constants';

// telemetry-device-farm task#18「账号健康显示如实化」：锁定 auto_quarantined 在
// 「问题筛选」与「正常账号筛选」两条判定链上的最高优先级，防止隔离锁清除与
// status_message/unavailable 落库非原子导致的假绿回归。

const baseFile: AuthFileItem = {
  name: 'acct.json',
  type: 'qwen',
  disabled: false,
};

describe('auth file modified time formats', () => {
  it('keeps a full timestamp for detail and a stable compact timestamp for narrow cards', () => {
    const file = {
      ...baseFile,
      modtime: '2026-09-17T21:52:53.405879667+08:00',
    };

    expect(formatModified(file)).toBe('2026-09-17 21:52:53 UTC+8');
    expect(formatModifiedCompact(file)).toBe('09/17 21:52');
  });

  it('uses the same placeholder for missing or invalid timestamps', () => {
    expect(formatModified(baseFile)).toBe('-');
    expect(formatModifiedCompact(baseFile)).toBe('-');
    expect(formatModified({ ...baseFile, modtime: 'not-a-date' })).toBe('-');
    expect(formatModifiedCompact({ ...baseFile, modtime: 'not-a-date' })).toBe('-');
  });
});

describe('hasAuthFileStatusWarning priority', () => {
  it('returns false for a fully healthy account', () => {
    expect(hasAuthFileStatusWarning(baseFile)).toBe(false);
  });

  it('prioritizes auto_quarantined over a healthy-looking status_message', () => {
    const quarantined: AuthFileItem = {
      ...baseFile,
      status_message: 'ok',
      auto_quarantined: true,
      quarantine_reason: 'terminal_auth_failure',
    };
    expect(hasAuthFileStatusWarning(quarantined)).toBe(true);
  });

  it('prioritizes auto_quarantined over an explicit unavailable=false', () => {
    const quarantined: AuthFileItem = {
      ...baseFile,
      unavailable: false,
      auto_quarantined: true,
    };
    expect(hasAuthFileStatusWarning(quarantined)).toBe(true);
  });

  it('falls back to structured unavailable when not quarantined', () => {
    expect(hasAuthFileStatusWarning({ ...baseFile, unavailable: true })).toBe(true);
    expect(hasAuthFileStatusWarning({ ...baseFile, unavailable: false })).toBe(false);
  });

  it('falls back to legacy status_message whitelist when structured fields are absent', () => {
    expect(hasAuthFileStatusWarning({ ...baseFile, status_message: 'token expired' })).toBe(true);
    expect(hasAuthFileStatusWarning({ ...baseFile, status_message: 'healthy' })).toBe(false);
  });

  // reauth 纵深防御兜底：core buildAuthFileEntry 条件下发 reauth_url，或顶层 /
  // metadata reauth_required 标记；即便 unavailable=false / status 健康，也必须判告警，
  // 绝不能把「需重新认证」的死 token 账号渲染成绿色正常（另一切片会置 unavailable=true，
  // 本判定是纵深防御，防止那步缺失时漏判）。
  it('treats a non-empty reauth_url as a warning even when unavailable=false (defense-in-depth, before the unavailable short-circuit)', () => {
    const reauthNeeded: AuthFileItem = {
      ...baseFile,
      type: 'claude',
      unavailable: false,
      status_message: 'ok',
      reauth_url: 'https://claude.ai/oauth/reauthorize?x=1',
    };
    expect(hasAuthFileStatusWarning(reauthNeeded)).toBe(true);
  });

  it('treats a truthy reauth_required flag (top-level and metadata) as a warning', () => {
    expect(hasAuthFileStatusWarning({ ...baseFile, reauth_required: true })).toBe(true);
    expect(
      hasAuthFileStatusWarning({
        ...baseFile,
        unavailable: false,
        metadata: { reauth_required: true },
      } as AuthFileItem)
    ).toBe(true);
  });
});

describe('isAuthFileReauthRequired', () => {
  it('returns false for a healthy account with no reauth signal', () => {
    expect(isAuthFileReauthRequired(baseFile)).toBe(false);
  });

  it('detects reauth_url, reauth_required, and metadata.reauth_required', () => {
    expect(isAuthFileReauthRequired({ ...baseFile, reauth_url: 'https://x' })).toBe(true);
    expect(isAuthFileReauthRequired({ ...baseFile, reauth_required: true })).toBe(true);
    expect(
      isAuthFileReauthRequired({ ...baseFile, reauth_required: 'yes' } as unknown as AuthFileItem)
    ).toBe(true);
    expect(
      isAuthFileReauthRequired({ ...baseFile, metadata: { reauth_required: 1 } } as AuthFileItem)
    ).toBe(true);
  });

  it('ignores empty / falsy reauth signals', () => {
    expect(isAuthFileReauthRequired({ ...baseFile, reauth_url: '   ' })).toBe(false);
    expect(isAuthFileReauthRequired({ ...baseFile, reauth_required: false })).toBe(false);
  });
});

describe('isHealthyAuthFile excludes quarantined accounts', () => {
  it('treats a disabled-false, warning-free account as healthy', () => {
    expect(isHealthyAuthFile(baseFile)).toBe(true);
  });

  it('excludes disabled accounts', () => {
    expect(isHealthyAuthFile({ ...baseFile, disabled: true })).toBe(false);
  });

  it('excludes an auto_quarantined account even when status_message still reads healthy', () => {
    const quarantined: AuthFileItem = {
      ...baseFile,
      status_message: 'ok',
      auto_quarantined: true,
      quarantine_reason: 'terminal_auth_failure',
    };
    // 回归点：修复前 isHealthyAuthFile 只看 status_message 文本，会把这种
    // "隔离锁已生效但 status_message 未同步"的账号误判为正常。
    expect(isHealthyAuthFile(quarantined)).toBe(false);
  });

  it('excludes a reauth-required account (reauth_url present) even when unavailable=false and status reads healthy', () => {
    const reauthNeeded: AuthFileItem = {
      ...baseFile,
      type: 'claude',
      unavailable: false,
      status_message: 'ok',
      reauth_url: 'https://claude.ai/oauth/reauthorize?x=1',
    };
    // 「仅显示正常凭证」筛选走 isHealthyAuthFile → 需重新认证账号一律不算正常（被排除），
    // 对应「仅显示有问题凭证」筛选走 hasAuthFileStatusWarning → 命中（被包含）。
    expect(isHealthyAuthFile(reauthNeeded)).toBe(false);
    expect(hasAuthFileStatusWarning(reauthNeeded)).toBe(true);
  });
});

import type { AuthFileType } from '@/types';
import { isMetaFile } from '@/utils/quota/validators';
import {
  getAuthFileIcon,
  getTypeColor,
  getTypeLabel,
  isQuotaRefreshSupportedProvider,
  normalizeProviderKey,
  QUOTA_PROVIDER_TYPES,
} from './constants';

describe('authFiles constants - devin', () => {
  it('returns valid distinct light and dark icons for devin', () => {
    const light = getAuthFileIcon('devin', 'light');
    const dark = getAuthFileIcon('devin', 'dark');

    expect(light).toBeTruthy();
    expect(dark).toBeTruthy();
    expect(light).not.toBe(dark);
  });

  it('returns correct type colors for devin in light and dark mode', () => {
    expect(getTypeColor('devin', 'light')).toEqual({
      bg: '#e8f4ff',
      text: '#155e9b',
    });
    expect(getTypeColor('devin', 'dark')).toEqual({
      bg: '#123b5d',
      text: '#8dc9f5',
    });
  });

  it('supports devin as AuthFileType', () => {
    const type: AuthFileType = 'devin';
    expect(type).toBe('devin');
  });
});

describe('authFiles constants - meta', () => {
  it('returns valid icon for meta in light and dark mode and resolves muse alias', () => {
    const light = getAuthFileIcon('meta', 'light');
    const dark = getAuthFileIcon('meta', 'dark');
    const museLight = getAuthFileIcon('muse', 'light');

    expect(light).toBeTruthy();
    expect(dark).toBeTruthy();
    expect(museLight).toBe(light);
  });

  it('returns correct type colors for meta in light and dark mode', () => {
    expect(getTypeColor('meta', 'light')).toEqual({
      bg: '#e5f2ff',
      text: '#0064e0',
    });
    expect(getTypeColor('meta', 'dark')).toEqual({
      bg: '#0b3564',
      text: '#70b5ff',
    });
  });

  it('supports meta as AuthFileType', () => {
    const type: AuthFileType = 'meta';
    expect(type).toBe('meta');
  });

  it('normalizes provider keys and aliases correctly', () => {
    expect(normalizeProviderKey('meta')).toBe('meta');
    expect(normalizeProviderKey('muse')).toBe('meta');
    expect(normalizeProviderKey('MUSE')).toBe('meta');
  });

  it('includes meta in QUOTA_PROVIDER_TYPES in phase 2', () => {
    expect((QUOTA_PROVIDER_TYPES as Set<string>).has('meta')).toBe(true);
  });

  it('resolves type label for meta as Muse (Meta)', () => {
    const t = ((key: string) => key) as unknown as Parameters<typeof getTypeLabel>[0];
    expect(getTypeLabel(t, 'meta')).toBe('Muse (Meta)');
    expect(getTypeLabel(t, 'muse')).toBe('Muse (Meta)');
  });

  it('validates meta files using isMetaFile', () => {
    expect(isMetaFile({ name: 'meta-test.json', provider: 'meta' })).toBe(true);
    expect(isMetaFile({ name: 'muse-test.json', type: 'muse' })).toBe(true);
    expect(isMetaFile({ name: 'codex.json', provider: 'codex' })).toBe(false);
  });

  it('correctly evaluates quota refresh eligibility via isQuotaRefreshSupportedProvider', () => {
    // Meta / Muse is quota-refreshable in phase 2
    expect(isQuotaRefreshSupportedProvider('meta')).toBe(true);
    expect(isQuotaRefreshSupportedProvider('muse')).toBe(true);
    expect(isQuotaRefreshSupportedProvider('META')).toBe(true);

    // Supported providers (including Devin)
    expect(isQuotaRefreshSupportedProvider('devin')).toBe(true);
    expect(isQuotaRefreshSupportedProvider('codex')).toBe(true);
    expect(isQuotaRefreshSupportedProvider('claude')).toBe(true);
    expect(isQuotaRefreshSupportedProvider('antigravity')).toBe(true);
    expect(isQuotaRefreshSupportedProvider('kimi')).toBe(true);
    expect(isQuotaRefreshSupportedProvider('xai')).toBe(true);
    expect(isQuotaRefreshSupportedProvider('x-ai')).toBe(true);
    expect(isQuotaRefreshSupportedProvider('grok')).toBe(true);

    // Other non-quota providers
    expect(isQuotaRefreshSupportedProvider('vertex')).toBe(false);
    expect(isQuotaRefreshSupportedProvider('qwen')).toBe(false);
    expect(isQuotaRefreshSupportedProvider('iflow')).toBe(false);
    expect(isQuotaRefreshSupportedProvider('')).toBe(false);
  });
});
