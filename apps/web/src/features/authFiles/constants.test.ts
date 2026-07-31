import { describe, expect, it } from 'vitest';
import type { AuthFileItem } from '@/types';
import { hasAuthFileStatusWarning, isHealthyAuthFile } from './constants';

// telemetry-device-farm task#18「账号健康显示如实化」：锁定 auto_quarantined 在
// 「问题筛选」与「正常账号筛选」两条判定链上的最高优先级，防止隔离锁清除与
// status_message/unavailable 落库非原子导致的假绿回归。

const baseFile: AuthFileItem = {
  name: 'acct.json',
  type: 'qwen',
  disabled: false,
};

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
});
