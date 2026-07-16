import { describe, expect, it } from 'vitest';
import { buildRealtimeSourceDisplay } from '@/features/monitoring/realtimeSourceDisplay';
import type { UsageDetailWithEndpoint } from '@/utils/usage';
import { buildSourceInfoMap } from '@/utils/sourceResolver';
import { buildEventRows } from './eventRows';

const buildRows = (overrides: Partial<UsageDetailWithEndpoint> = {}) =>
  buildEventRows(
    [
      {
        timestamp: '2026-05-19T10:00:00Z',
        source: 'alice@example.com',
        auth_index: 'auth-1',
        latency_ms: 1500,
        ttft_ms: 500,
        tokens: {
          input_tokens: 10,
          output_tokens: 20,
          total_tokens: 30,
        },
        failed: false,
        __modelName: 'gpt-5.4',
        __endpoint: 'POST /v1/chat/completions',
        __endpointMethod: 'POST',
        __endpointPath: '/v1/chat/completions',
        __timestampMs: Date.parse('2026-05-19T10:00:00Z'),
        ...overrides,
      },
    ],
    new Map(),
    new Map(),
    { byAuthIndex: new Map(), bySource: new Map(), byIdentityKey: new Map() },
    new Map(),
    {},
    new Map()
  );

describe('buildEventRows', () => {
  it('calculates output tokens per second from total latency', () => {
    const [row] = buildRows();

    expect(row.latencyMs).toBe(1500);
    expect(row.ttftMs).toBe(500);
    expect(row.tokensPerSecond).toBeCloseTo(20 / 1.5);
  });

  it('does not let TTFT change output tokens per second', () => {
    const [withoutTTFT] = buildRows({ ttft_ms: undefined });
    const [smallTTFT] = buildRows({ ttft_ms: 100 });
    const [invalidTTFT] = buildRows({ ttft_ms: 2000 });

    expect(withoutTTFT.tokensPerSecond).toBeCloseTo(20 / 1.5);
    expect(smallTTFT.tokensPerSecond).toBeCloseTo(20 / 1.5);
    expect(invalidTTFT.tokensPerSecond).toBeCloseTo(20 / 1.5);
  });

  it('does not calculate tokens per second without output tokens or total latency', () => {
    const [noOutput] = buildRows({ tokens: { output_tokens: 0 } });
    const [noLatency] = buildRows({ latency_ms: undefined });
    const [zeroLatency] = buildRows({ latency_ms: 0 });

    expect(noOutput.tokensPerSecond).toBeNull();
    expect(noLatency.tokensPerSecond).toBeNull();
    expect(zeroLatency.tokensPerSecond).toBeNull();
  });

  it('keeps CPA executor and service tier metadata searchable', () => {
    const [row] = buildRows({
      executor_type: 'codex',
      service_tier: 'priority',
      reasoning_effort: 'medium',
    });

    expect(row.executorType).toBe('codex');
    expect(row.serviceTier).toBe('priority');
    expect(row.searchText).toContain('codex');
    expect(row.searchText).toContain('priority');
    expect(row.searchText).toContain('medium');
  });

  it('keeps response header diagnostics searchable', () => {
    const [row] = buildRows({
      failed: true,
      fail_status_code: 429,
      response_metadata: {
        quota: {
          plan_type: 'plus',
          used_percent: 87,
          recover_at_ms: 1780000060000,
        },
        errors: {
          kind: 'rate_limit',
          code: 'retry_after',
        },
        trace: {
          primary_trace_id: 'req-header',
        },
      },
      header_quota_recover_at_ms: 1780000060000,
      header_quota_used_percent: 87,
      header_quota_plan_type: 'plus',
      header_error_kind: 'rate_limit',
      header_error_code: 'retry_after',
      header_trace_id: 'req-header',
    });

    expect(row.responseMetadata?.quota?.plan_type).toBe('plus');
    expect(row.headerQuotaUsedPercent).toBe(87);
    expect(row.headerTraceId).toBe('req-header');
    expect(row.searchText).toContain('rate_limit');
    expect(row.searchText).toContain('retry_after');
    expect(row.searchText).toContain('req-header');
    expect(row.searchText).toContain('plus');
  });

  it('derives response header diagnostics from metadata-only usage details', () => {
    const [row] = buildRows({
      failed: true,
      fail_status_code: 429,
      response_metadata: {
        quota: {
          active_limit: 'premium',
          used_percent: 92,
          recover_at_ms: 1780000120000,
        },
        errors: {
          kind: 'rate_limit',
          ide_error_code: 'usage_limit_reached',
        },
        trace: {
          primary_trace_id: 'req-metadata-only',
        },
      },
    });

    expect(row.headerQuotaPlanType).toBe('premium');
    expect(row.headerQuotaUsedPercent).toBe(92);
    expect(row.headerQuotaRecoverAtMs).toBe(1780000120000);
    expect(row.headerErrorKind).toBe('rate_limit');
    expect(row.headerErrorCode).toBe('usage_limit_reached');
    expect(row.headerTraceId).toBe('req-metadata-only');
    expect(row.searchText).toContain('usage_limit_reached');
    expect(row.searchText).toContain('req-metadata-only');
    expect(row.searchText).toContain('premium');
  });

  it('keeps shared provider display names available to realtime source cells', () => {
    const sharedKey = 'sk-shared1234567890abcdef';
    const sourceInfoMap = buildSourceInfoMap({
      codexApiKeys: [
        {
          apiKey: sharedKey,
          prefix: 'Shared Relay',
          baseUrl: 'https://api.shared.example/v1',
        },
      ],
      claudeApiKeys: [
        {
          apiKey: sharedKey,
          prefix: 'Shared Relay',
          baseUrl: 'https://api.shared.example/v1',
        },
      ],
    });
    const [row] = buildEventRows(
      [
        {
          timestamp: '2026-05-19T10:00:00Z',
          source: 'm:sk-s...cdef',
          auth_index: null,
          auth_provider_snapshot: 'codex',
          latency_ms: 1500,
          tokens: {
            input_tokens: 10,
            output_tokens: 20,
            total_tokens: 30,
          },
          failed: false,
          __modelName: 'gpt-5.4',
          __endpoint: 'POST /v1/chat/completions',
          __endpointMethod: 'POST',
          __endpointPath: '/v1/chat/completions',
          __timestampMs: Date.parse('2026-05-19T10:00:00Z'),
        },
      ],
      new Map(),
      new Map(),
      sourceInfoMap,
      new Map(),
      {},
      new Map()
    );

    const t = ((key: string) => key) as Parameters<typeof buildRealtimeSourceDisplay>[1];
    const display = buildRealtimeSourceDisplay(row, t);

    expect(row.source).toBe('Shared Relay');
    expect(row.sourceKey).toBe('shared:m:sk-s...cdef');
    expect(row.provider).toBe('codex');
    expect(display.primary).toBe('Shared Relay');
  });

  it('keeps row id stable across refresh when new events are prepended (regression: realtime table flush/闪屏)', () => {
    const buildDetail = (
      eventHash: string,
      timestamp: string,
      overrides: Partial<UsageDetailWithEndpoint> = {}
    ): UsageDetailWithEndpoint => ({
      timestamp,
      source: 'alice@example.com',
      auth_index: 'auth-1',
      tokens: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
      failed: false,
      __modelName: 'gpt-5.4',
      __endpoint: 'POST /v1/chat/completions',
      __endpointMethod: 'POST',
      __endpointPath: '/v1/chat/completions',
      __timestampMs: Date.parse(timestamp),
      __eventHash: eventHash,
      ...overrides,
    });

    const buildIds = (details: UsageDetailWithEndpoint[]) =>
      buildEventRows(
        details,
        new Map(),
        new Map(),
        { byAuthIndex: new Map(), bySource: new Map(), byIdentityKey: new Map() },
        new Map(),
        {},
        new Map()
      ).map((row) => row.id);

    const detailA = buildDetail('hash-a', '2026-05-19T10:00:00Z');
    const detailB = buildDetail('hash-b', '2026-05-19T10:01:00Z');
    const detailC = buildDetail('hash-c', '2026-05-19T10:02:00Z');
    const detailNew = buildDetail('hash-new', '2026-05-19T10:03:00Z');

    const idsBeforePrepend = buildIds([detailA, detailB, detailC]);
    // 模拟自动刷新:新事件 prepend 到数组头部,导致 A/B/C 的数组 index 全部 +1。
    const idsAfterPrepend = buildIds([detailNew, detailA, detailB, detailC]);

    const [idA, idB, idC] = idsBeforePrepend;
    const [idNewAfter, idAAfter, idBAfter, idCAfter] = idsAfterPrepend;

    // 核心断言:同一事件跨刷新(数组位置变化)id 必须保持不变。
    // 这个断言在未修复的 index-based id 实现上会失败,因为 prepend 后
    // A/B/C 的 index 从 0/1/2 变成 1/2/3,拼出的 id 也随之改变。
    expect(idAAfter).toBe(idA);
    expect(idBAfter).toBe(idB);
    expect(idCAfter).toBe(idC);
    // 新事件应该拿到一个此前不存在的新 id。
    expect(idNewAfter).not.toBe(idA);
    expect(idNewAfter).not.toBe(idB);
    expect(idNewAfter).not.toBe(idC);
  });

  it('falls back to a composite stable key (without array index) when event_hash is missing', () => {
    const buildDetailNoHash = (
      timestamp: string,
      overrides: Partial<UsageDetailWithEndpoint> = {}
    ): UsageDetailWithEndpoint => ({
      timestamp,
      source: 'alice@example.com',
      auth_index: 'auth-1',
      tokens: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
      failed: false,
      __modelName: 'gpt-5.4',
      __endpoint: 'POST /v1/chat/completions',
      __endpointMethod: 'POST',
      __endpointPath: '/v1/chat/completions',
      __timestampMs: Date.parse(timestamp),
      __eventHash: undefined,
      ...overrides,
    });

    const buildIds = (details: UsageDetailWithEndpoint[]) =>
      buildEventRows(
        details,
        new Map(),
        new Map(),
        { byAuthIndex: new Map(), bySource: new Map(), byIdentityKey: new Map() },
        new Map(),
        {},
        new Map()
      ).map((row) => row.id);

    const detailA = buildDetailNoHash('2026-05-19T10:00:00Z');
    const detailB = buildDetailNoHash('2026-05-19T10:01:00Z');
    const detailNew = buildDetailNoHash('2026-05-19T10:02:00Z');

    const idsBeforePrepend = buildIds([detailA, detailB]);
    const idsAfterPrepend = buildIds([detailNew, detailA, detailB]);

    expect(idsAfterPrepend[1]).toBe(idsBeforePrepend[0]);
    expect(idsAfterPrepend[2]).toBe(idsBeforePrepend[1]);
    // 兜底 key 不应包含数组 index 本身作为唯一区分因子。
    expect(idsBeforePrepend[0]).not.toMatch(/-\d+$/);
  });
});
