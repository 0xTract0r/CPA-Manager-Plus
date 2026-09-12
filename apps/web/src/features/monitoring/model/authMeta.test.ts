import { describe, expect, it } from 'vitest';
import { buildMonitoringAuthMetaMap } from './authMeta';

describe('buildMonitoringAuthMetaMap', () => {
  it('projects the current remark as label while preserving the full account email', () => {
    const map = buildMonitoringAuthMetaMap([
      {
        name: 'codex-owner.json',
        authIndex: 'auth-owner',
        provider: 'codex',
        email: 'Owner.Long+prod@example.test',
        note: '生产主账号',
      },
    ]);

    expect(map.get('auth-owner')).toMatchObject({
      label: '生产主账号',
      note: '生产主账号',
      account: 'Owner.Long+prod@example.test',
      email: 'Owner.Long+prod@example.test',
    });
  });

  it('falls back safely when neither remark nor email exists', () => {
    const map = buildMonitoringAuthMetaMap([
      { name: 'opaque-account.json', authIndex: 'auth-opaque', provider: 'claude' },
    ]);

    expect(map.get('auth-opaque')).toMatchObject({
      label: 'opaque-account.json',
      account: 'opaque-account.json',
    });
  });
});
