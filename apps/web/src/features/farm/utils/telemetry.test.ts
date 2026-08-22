import { describe, expect, it } from 'vitest';
import {
  FARM_HIGH_ENTROPY_FINGERPRINT_FIELDS,
  displayFingerprintValue,
  fingerprintFieldsClash,
} from './telemetry';

const SHA256 = 'e6b4c2aa114af4db9d2568e2810eb312d61bdfea0a1f219053e5191ed683ca48';

describe('displayFingerprintValue', () => {
  it('高熵字段（device_id）脱敏为前 12 + 后 4', () => {
    expect(displayFingerprintValue('device_id', SHA256)).toBe('e6b4c2aa114a…ca48');
  });

  it('高熵字段（session_id）同样脱敏', () => {
    expect(FARM_HIGH_ENTROPY_FINGERPRINT_FIELDS.has('session_id')).toBe(true);
    expect(displayFingerprintValue('session_id', SHA256)).toBe('e6b4c2aa114a…ca48');
  });

  it('低熵字段（api_base_url_host）原样返回，不脱敏', () => {
    expect(displayFingerprintValue('api_base_url_host', 'api.anthropic.com')).toBe(
      'api.anthropic.com'
    );
  });

  it('低熵字段（entrypoint）原样返回', () => {
    expect(displayFingerprintValue('entrypoint', 'claude-cli')).toBe('claude-cli');
  });

  it('空串原样返回空串', () => {
    expect(displayFingerprintValue('device_id', '')).toBe('');
  });
});

describe('fingerprintFieldsClash', () => {
  it('on-wire 为 null（从未观测）时不撞红', () => {
    expect(fingerprintFieldsClash('abc', null)).toBe(false);
  });

  it('on-wire 为空串（这次没带该字段）时不撞红', () => {
    expect(fingerprintFieldsClash('abc', '')).toBe(false);
  });

  it('declared 为空串时不撞红', () => {
    expect(fingerprintFieldsClash('', 'abc')).toBe(false);
  });

  it('两侧都非空且相同不撞红', () => {
    expect(fingerprintFieldsClash('abc', 'abc')).toBe(false);
  });

  it('两侧都非空且不同才撞红', () => {
    expect(fingerprintFieldsClash('abc', 'xyz')).toBe(true);
  });

  it('用原始值判等：首尾相同但中段不同的两个值仍撞红（不受脱敏影响）', () => {
    const a = 'e6b4c2aa114af4db9d2568e2810eb312d61bdfea0a1f219053e5191ed683ca48';
    const b = 'e6b4c2aa114aFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF83ca48';
    // 脱敏后两者都是 e6b4c2aa114a…ca48（相同），但原始值不同 → 必须撞红。
    expect(displayFingerprintValue('device_id', a)).toBe(displayFingerprintValue('device_id', b));
    expect(fingerprintFieldsClash(a, b)).toBe(true);
  });
});
