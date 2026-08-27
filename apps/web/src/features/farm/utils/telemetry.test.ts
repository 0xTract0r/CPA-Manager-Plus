import { describe, expect, it } from 'vitest';
import {
  FARM_HIGH_ENTROPY_FINGERPRINT_FIELDS,
  displayFingerprintValue,
  fingerprintFieldsClash,
  normalizeMaskSeparator,
  pinFieldClash,
  pinFieldRawValue,
  type FarmFingerprintPin,
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

// farm-proxy-rotation §5「指纹卡 pin」：把指纹卡的 declared 列换成「预期(pin)」，
// 数据源改读 container.fingerprint_pin，逐字段对照 on-wire 实测。
describe('pinFieldRawValue', () => {
  const PIN: FarmFingerprintPin = {
    device_id_masked: 'e6b4c2aa114a…ca48',
    entrypoint: 'cli',
    api_base_url_host: 'api.anthropic.com',
  };

  it('device_id 取 device_id_masked（已脱敏，不再二次处理）', () => {
    expect(pinFieldRawValue(PIN, 'device_id')).toBe('e6b4c2aa114a…ca48');
  });

  it('entrypoint 取 entrypoint 原样', () => {
    expect(pinFieldRawValue(PIN, 'entrypoint')).toBe('cli');
  });

  it('api_base_url_host 取 api_base_url_host 原样', () => {
    expect(pinFieldRawValue(PIN, 'api_base_url_host')).toBe('api.anthropic.com');
  });

  it('pin 缺失（旧编排器/字段裁剪防御）时任意字段都返回空串，不臆造', () => {
    expect(pinFieldRawValue(undefined, 'device_id')).toBe('');
    expect(pinFieldRawValue(undefined, 'entrypoint')).toBe('');
    expect(pinFieldRawValue(undefined, 'api_base_url_host')).toBe('');
  });
});

describe('pinFieldClash', () => {
  it('device_id：pin 已脱敏串与 on-wire 原始值脱敏后一致 → 不撞红', () => {
    const onWireRawDeviceId = 'e6b4c2aa114af4db9d2568e2810eb312d61bdfea0a1f219053e5191ed683ca48';
    expect(pinFieldClash('device_id', 'e6b4c2aa114a…ca48', onWireRawDeviceId)).toBe(false);
  });

  it('device_id：on-wire 原始值脱敏后与 pin 不一致 → 撞红=泄露', () => {
    // 前 12 位不同，脱敏后必然不同：e6b4… vs ffff…
    const onWireRawDeviceId = 'ffffffffffffdb9d2568e2810eb312d61bdfea0a1f219053e5191ed683ca48';
    expect(pinFieldClash('device_id', 'e6b4c2aa114a…ca48', onWireRawDeviceId)).toBe(true);
  });

  it('entrypoint：低熵字段直接原始值比对，不一致才撞红', () => {
    expect(pinFieldClash('entrypoint', 'cli', 'cli')).toBe(false);
    expect(pinFieldClash('entrypoint', 'cli', 'python-httpx')).toBe(true);
  });

  it('api_base_url_host：出现自有 host（非官方端点）即撞红=host_leak', () => {
    expect(pinFieldClash('api_base_url_host', 'api.anthropic.com', 'api.anthropic.com')).toBe(
      false
    );
    expect(
      pinFieldClash('api_base_url_host', 'api.anthropic.com', 'cpa.wisedata.co')
    ).toBe(true);
  });

  it('on-wire 为 null（从未观测）时不撞红', () => {
    expect(pinFieldClash('device_id', 'e6b4c2aa114a…ca48', null)).toBe(false);
  });

  it('on-wire 为空串（该来源这次没带该字段）时不撞红', () => {
    expect(pinFieldClash('entrypoint', 'cli', '')).toBe(false);
  });

  it('pin 缺失（pinRaw 空串）时不撞红，不据此误判泄露', () => {
    expect(pinFieldClash('device_id', '', 'e6b4c2aa114af4db9d2568e2810eb312d61bdfea0a1f219053e5191ed683ca48')).toBe(
      false
    );
  });

  // §5 指纹卡假撞红回归：后端 maskIdentifierMiddle 产出的 pin.device_id_masked 用三个
  // ASCII 点「...」，前端 displayFingerprintValue 脱敏 on-wire 原始值用 U+2026「…」。
  // 之前的 fixture 两侧都写成「…」（与前端脱敏口径一致），恰好掩盖了后端真实的「...」
  // 格式，故这条真实场景一直未被覆盖——正是本次坐实的假撞红根因。
  it('device_id：pin 用后端三点「...」、on-wire 前端「…」，底层同一 raw → 归一后不误撞红', () => {
    const onWireRawDeviceId = 'e6b4c2aa114af4db9d2568e2810eb312d61bdfea0a1f219053e5191ed683ca48';
    const pinMaskedBackend = 'e6b4c2aa114a...ca48'; // 后端 maskIdentifierMiddle 真实格式
    // 前端对 onWireRaw 脱敏得到 'e6b4c2aa114a…ca48'（U+2026），只与 pin 差分隔符字符。
    expect(displayFingerprintValue('device_id', onWireRawDeviceId)).toBe('e6b4c2aa114a…ca48');
    expect(pinFieldClash('device_id', pinMaskedBackend, onWireRawDeviceId)).toBe(false);
  });

  it('device_id：pin 用后端三点「...」、on-wire 底层为真不同 device_id → 仍撞红=泄露', () => {
    // 前 12 位不同，脱敏后必然不同（ffff… vs e6b4…），分隔符归一不会掩盖真实差异。
    const onWireDifferent = 'ffffffffffffdb9d2568e2810eb312d61bdfea0a1f219053e5191ed683ca48';
    const pinMaskedBackend = 'e6b4c2aa114a...ca48';
    expect(pinFieldClash('device_id', pinMaskedBackend, onWireDifferent)).toBe(true);
  });

  it('entrypoint/api_base_url_host：低熵字段不含省略号序列，归一无副作用，判等语义不变', () => {
    // 三字段一致覆盖：pin 侧分隔符差异只影响 device_id，低熵两字段行为必须保持。
    expect(pinFieldClash('entrypoint', 'cli', 'cli')).toBe(false);
    expect(pinFieldClash('entrypoint', 'cli', 'python-httpx')).toBe(true);
    expect(pinFieldClash('api_base_url_host', 'api.anthropic.com', 'api.anthropic.com')).toBe(false);
    expect(pinFieldClash('api_base_url_host', 'api.anthropic.com', 'cpa.wisedata.co')).toBe(true);
  });
});

describe('normalizeMaskSeparator', () => {
  it('三个 ASCII 点「...」与 U+2026「…」折成同一种，底层同 raw 的两端掩码归一后相等', () => {
    expect(normalizeMaskSeparator('e6b4c2aa114a...ca48')).toBe('e6b4c2aa114a…ca48');
    expect(normalizeMaskSeparator('e6b4c2aa114a…ca48')).toBe('e6b4c2aa114a…ca48');
    expect(normalizeMaskSeparator('e6b4c2aa114a...ca48')).toBe(
      normalizeMaskSeparator('e6b4c2aa114a…ca48')
    );
  });

  it('低熵 host 的单点不被误折（api.anthropic.com 保持原样）', () => {
    expect(normalizeMaskSeparator('api.anthropic.com')).toBe('api.anthropic.com');
    expect(normalizeMaskSeparator('cpa.wisedata.co')).toBe('cpa.wisedata.co');
  });

  it('空串原样返回空串', () => {
    expect(normalizeMaskSeparator('')).toBe('');
  });
});
