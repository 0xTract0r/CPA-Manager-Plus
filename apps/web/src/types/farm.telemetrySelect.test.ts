import { describe, expect, it } from 'vitest';
import { pickLatestBeaconFieldValue, type FarmContainerBeaconView } from './farm';

// 构造一条最小 beacon（只填测试关心的字段，其余给合法默认值）。列表顺序即
// captured_at 降序（最新在前），与后端 GET .../beacons 契约一致。
function beacon(partial: Partial<FarmContainerBeaconView>): FarmContainerBeaconView {
  return {
    beacon_id: 1,
    captured_at: '2026-08-01T00:00:00Z',
    channel: 'statsig_eval',
    host: 'api.anthropic.com',
    path: '/v1/messages',
    body_bytes: 0,
    device_id: '',
    api_base_url_host: '',
    entrypoint: '',
    source: 'unknown',
    ...partial,
  };
}

describe('pickLatestBeaconFieldValue', () => {
  it('最近一条带值时直接取最近一条', () => {
    const beacons = [beacon({ device_id: 'dev-new' }), beacon({ device_id: 'dev-old' })];
    expect(pickLatestBeaconFieldValue(beacons, 'device_id')).toBe('dev-new');
  });

  it('最近一条该字段为空时回退到更早一条带值的 beacon（横线根因修复）', () => {
    // 第 0 条是 datadog_logs 通道、天然没有 device_id；第 1 条 statsig_eval 带了
    // device_id。只读最近一条会误显横线，应逐字段回退取到 dev-old。
    const beacons = [
      beacon({ channel: 'datadog_logs', device_id: '' }),
      beacon({ channel: 'statsig_eval', device_id: 'dev-old' }),
    ];
    expect(pickLatestBeaconFieldValue(beacons, 'device_id')).toBe('dev-old');
  });

  it('逐字段独立选值：不同字段可能来自不同 beacon', () => {
    const beacons = [
      beacon({ entrypoint: 'claude-cli', device_id: '' }),
      beacon({ entrypoint: '', device_id: 'dev-1', api_base_url_host: 'api.anthropic.com' }),
    ];
    expect(pickLatestBeaconFieldValue(beacons, 'entrypoint')).toBe('claude-cli');
    expect(pickLatestBeaconFieldValue(beacons, 'device_id')).toBe('dev-1');
    expect(pickLatestBeaconFieldValue(beacons, 'api_base_url_host')).toBe('api.anthropic.com');
  });

  it('窗口内所有 beacon 都不带该字段 → 返回空串（调用方回退占位 —）', () => {
    const beacons = [beacon({ device_id: '' }), beacon({ device_id: '' })];
    expect(pickLatestBeaconFieldValue(beacons, 'device_id')).toBe('');
  });

  it('空列表 → 空串', () => {
    expect(pickLatestBeaconFieldValue([], 'device_id')).toBe('');
  });
});
