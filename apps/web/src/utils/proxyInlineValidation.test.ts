import { describe, expect, it, vi } from 'vitest';
import {
  precheckProxyInlineFormat,
  runProxyInlineChecks,
  isProxyInlineValidatedOk,
  isProxyInlineChecking,
  isProxyInlineInvalid,
  type ProxyInlineStage,
  type ProxyInlineValidationState,
} from './proxyInlineValidation';
import type { ProxyProbeResult } from '@/services/api/proxyProbe';

// 内联校验共享状态机的纯逻辑覆盖：格式预检分流、查重(L2)先于探针(L1)、连通失败/成功归一、
// 查重列表不可用降级、阶段回调顺序，以及提交门控三态判定（校验中/失败/通过）。
// 校验判定规则本身沿用既有 proxyPreflight（探针经注入桩切断网络）。

const PROXY = 'socks5://user:pass@host:1080';

const okProbe = (exitIp: string): ((url: string) => Promise<ProxyProbeResult>) =>
  vi.fn(async () => ({ ok: true, exitIp, reason: 'ok' as const }));
const failProbe = (
  reason: ProxyProbeResult['reason']
): ((url: string) => Promise<ProxyProbeResult>) =>
  vi.fn(async () => ({ ok: false, exitIp: '', reason }));

describe('precheckProxyInlineFormat', () => {
  it('区分空 / 非法 / 通过（同步、不触网）', () => {
    expect(precheckProxyInlineFormat('')).toBe('empty');
    expect(precheckProxyInlineFormat('   ')).toBe('empty');
    expect(precheckProxyInlineFormat('not a url')).toBe('invalid');
    expect(precheckProxyInlineFormat('ftp://host:21')).toBe('invalid');
    expect(precheckProxyInlineFormat(PROXY)).toBe('valid');
    expect(precheckProxyInlineFormat('http://1.2.3.4:8080')).toBe('valid');
  });
});

describe('runProxyInlineChecks', () => {
  it('查重命中 → invalid（含冲突账号名），不触探针（L2 先于 L1）', async () => {
    const probe = okProbe('203.0.113.9');
    const result = await runProxyInlineChecks({
      proxyUrl: PROXY,
      checkDuplicate: () => ['AC-14'],
      duplicateMessage: (accounts) => `dup:${accounts.join(',')}`,
      probe,
    });
    expect(result.phase).toBe('invalid');
    expect(result.message).toBe('dup:AC-14');
    expect(result.checkedValue).toBe(PROXY);
    expect(probe).not.toHaveBeenCalled();
  });

  it('查重不命中 + 探针 ok → ok（带出口 IP）', async () => {
    const probe = okProbe('203.0.113.9');
    const result = await runProxyInlineChecks({
      proxyUrl: PROXY,
      checkDuplicate: () => [],
      duplicateMessage: () => 'dup',
      probe,
    });
    expect(result.phase).toBe('ok');
    expect(result.exitIp).toBe('203.0.113.9');
    expect(result.checkedValue).toBe(PROXY);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('查重不命中 + 探针失败 → invalid（连通失败文案）', async () => {
    const probe = failProbe('timeout');
    const result = await runProxyInlineChecks({
      proxyUrl: PROXY,
      checkDuplicate: () => [],
      duplicateMessage: () => 'dup',
      translate: (reason) => `reason:${reason}`,
      probe,
    });
    expect(result.phase).toBe('invalid');
    expect(result.message).toBe('reason:timeout');
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('查重列表不可用（抛错）→ 降级跳过查重，继续探针', async () => {
    const probe = okProbe('203.0.113.9');
    const result = await runProxyInlineChecks({
      proxyUrl: PROXY,
      checkDuplicate: () => {
        throw new Error('list unavailable');
      },
      duplicateMessage: () => 'dup',
      probe,
    });
    expect(result.phase).toBe('ok');
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('阶段回调按 dedup → probe 顺序推进', async () => {
    const stages: ProxyInlineStage[] = [];
    await runProxyInlineChecks({
      proxyUrl: PROXY,
      checkDuplicate: () => [],
      duplicateMessage: () => 'dup',
      probe: okProbe('203.0.113.9'),
      onStage: (stage) => stages.push(stage),
    });
    expect(stages).toEqual(['dedup', 'probe']);
  });

  it('空值 → idle（不触网）', async () => {
    const probe = okProbe('203.0.113.9');
    const result = await runProxyInlineChecks({
      proxyUrl: '   ',
      checkDuplicate: () => ['AC-14'],
      duplicateMessage: () => 'dup',
      probe,
    });
    expect(result.phase).toBe('idle');
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('提交门控状态判定', () => {
  const okState: ProxyInlineValidationState = { phase: 'ok', exitIp: '1.2.3.4', checkedValue: PROXY };
  const checkingState: ProxyInlineValidationState = {
    phase: 'checking',
    stage: 'probe',
    checkedValue: PROXY,
  };
  const invalidState: ProxyInlineValidationState = {
    phase: 'invalid',
    message: 'bad',
    checkedValue: PROXY,
  };

  it('isProxyInlineValidatedOk 仅当 ok 且值逐字符相同', () => {
    expect(isProxyInlineValidatedOk(okState, PROXY)).toBe(true);
    expect(isProxyInlineValidatedOk(okState, 'http://other:8080')).toBe(false);
    expect(isProxyInlineValidatedOk(checkingState, PROXY)).toBe(false);
    expect(isProxyInlineValidatedOk(undefined, PROXY)).toBe(false);
  });

  it('isProxyInlineChecking 仅当 checking 且值逐字符相同', () => {
    expect(isProxyInlineChecking(checkingState, PROXY)).toBe(true);
    expect(isProxyInlineChecking(checkingState, 'http://other:8080')).toBe(false);
    expect(isProxyInlineChecking(okState, PROXY)).toBe(false);
  });

  it('isProxyInlineInvalid 仅当 invalid 且值逐字符相同', () => {
    expect(isProxyInlineInvalid(invalidState, PROXY)).toBe(true);
    expect(isProxyInlineInvalid(invalidState, 'http://other:8080')).toBe(false);
    expect(isProxyInlineInvalid(okState, PROXY)).toBe(false);
  });
});
