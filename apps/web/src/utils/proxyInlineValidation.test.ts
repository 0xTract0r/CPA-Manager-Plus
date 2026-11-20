import { describe, expect, it, vi } from 'vitest';
import {
  precheckProxyInlineFormat,
  runProxyInlineChecks,
  isProxyInlineValidatedOk,
  isProxyInlineChecking,
  isProxyInlineInvalid,
  formatProxyDuplicateWarning,
  requestProxyDuplicateConfirmation,
  type ProxyDuplicateConfirmationRequest,
  type ProxyInlineStage,
  type ProxyInlineStageContext,
  type ProxyInlineValidationState,
} from './proxyInlineValidation';
import { EMPTY_PROXY_DUPLICATE_USAGE, type ProxyDuplicateUsage } from './proxyPreflight';
import type { ProxyProbeResult } from '@/services/api/proxyProbe';

// 内联校验共享状态机的纯逻辑覆盖：格式预检分流、查重(L2)软提醒不阻断探针(L1)、连通失败/成功归一、
// 查重列表不可用降级、阶段回调顺序（探针阶段带查重结果），提交门控三态判定（校验中/失败/通过），
// 以及占用警告文案 / 提交前占用确认（确认继续、取消停止、无占用不弹框）。
// 校验判定规则本身沿用既有 proxyPreflight（探针经注入桩切断网络）。

const PROXY = 'socks5://user:pass@host:1080';

const usage = (count: number, labels: string[]): ProxyDuplicateUsage => ({ count, labels });

// 文案桩：把 count / accounts 拼进返回值，便于断言插值参数。
const fakeT = (key: string, options?: Record<string, unknown>) => {
  if (key === 'proxy_preflight.duplicate_account_separator') return '、';
  if (options && 'count' in options) return `${key}|${String(options.count)}|${String(options.accounts)}`;
  return key;
};

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
  it('查重命中 → 不再判 invalid：继续探针，结果带占用情况与警告文案（含账号数 + 账号名）', async () => {
    const probe = okProbe('203.0.113.9');
    const duplicateWarning = vi.fn(
      (found: ProxyDuplicateUsage) => `dup:${found.count}:${found.labels.join(',')}`
    );
    const result = await runProxyInlineChecks({
      proxyUrl: PROXY,
      checkDuplicate: () => usage(2, ['GPT-PH-01', 'GPT-PH-02']),
      duplicateWarning,
      probe,
    });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(result.phase).toBe('ok');
    expect(result.exitIp).toBe('203.0.113.9');
    expect(result.checkedValue).toBe(PROXY);
    expect(result.duplicate).toEqual(usage(2, ['GPT-PH-01', 'GPT-PH-02']));
    expect(result.warning).toBe('dup:2:GPT-PH-01,GPT-PH-02');
    expect(duplicateWarning).toHaveBeenCalledTimes(1);
  });

  it('查重命中 + 探针失败 → invalid（连通失败文案），占用警告仍保留', async () => {
    const result = await runProxyInlineChecks({
      proxyUrl: PROXY,
      checkDuplicate: () => usage(1, ['AC-14']),
      duplicateWarning: () => 'dup',
      translate: (reason) => `reason:${reason}`,
      probe: failProbe('dial_failed'),
    });
    expect(result.phase).toBe('invalid');
    expect(result.message).toBe('reason:dial_failed');
    expect(result.duplicate?.count).toBe(1);
    expect(result.warning).toBe('dup');
  });

  it('查重不命中 + 探针 ok → ok（带出口 IP），不带占用字段', async () => {
    const probe = okProbe('203.0.113.9');
    const duplicateWarning = vi.fn(() => 'dup');
    const result = await runProxyInlineChecks({
      proxyUrl: PROXY,
      checkDuplicate: () => EMPTY_PROXY_DUPLICATE_USAGE,
      duplicateWarning,
      probe,
    });
    expect(result.phase).toBe('ok');
    expect(result.exitIp).toBe('203.0.113.9');
    expect(result.checkedValue).toBe(PROXY);
    expect(result.duplicate).toBeUndefined();
    expect(result.warning).toBeUndefined();
    expect(duplicateWarning).not.toHaveBeenCalled();
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('查重不命中 + 探针失败 → invalid（连通失败文案）', async () => {
    const probe = failProbe('timeout');
    const result = await runProxyInlineChecks({
      proxyUrl: PROXY,
      checkDuplicate: () => EMPTY_PROXY_DUPLICATE_USAGE,
      duplicateWarning: () => 'dup',
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
      duplicateWarning: () => 'dup',
      probe,
    });
    expect(result.phase).toBe('ok');
    expect(result.duplicate).toBeUndefined();
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('阶段回调按 dedup → probe 顺序推进，探针阶段带上查重结果', async () => {
    const stages: Array<[ProxyInlineStage, ProxyInlineStageContext | undefined]> = [];
    await runProxyInlineChecks({
      proxyUrl: PROXY,
      checkDuplicate: () => usage(1, ['AC-14']),
      duplicateWarning: () => 'dup',
      probe: okProbe('203.0.113.9'),
      onStage: (stage, context) => stages.push([stage, context]),
    });
    expect(stages.map(([stage]) => stage)).toEqual(['dedup', 'probe']);
    expect(stages[1][1]).toEqual({ duplicate: usage(1, ['AC-14']), warning: 'dup' });
  });

  it('空值 → idle（不触网）', async () => {
    const probe = okProbe('203.0.113.9');
    const result = await runProxyInlineChecks({
      proxyUrl: '   ',
      checkDuplicate: () => usage(1, ['AC-14']),
      duplicateWarning: () => 'dup',
      probe,
    });
    expect(result.phase).toBe('idle');
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('formatProxyDuplicateWarning', () => {
  it('按 count 与当前语言分隔符拼出占用账号数 + 账号名', () => {
    expect(formatProxyDuplicateWarning(fakeT, usage(2, ['GPT-PH-01', 'GPT-PH-02']))).toBe(
      'proxy_preflight.duplicate_account|2|GPT-PH-01、GPT-PH-02'
    );
  });
});

describe('requestProxyDuplicateConfirmation', () => {
  it('无占用 → 不弹框，直接继续', async () => {
    const showConfirmation = vi.fn();
    await expect(
      requestProxyDuplicateConfirmation(showConfirmation, fakeT, EMPTY_PROXY_DUPLICATE_USAGE)
    ).resolves.toBe(true);
    await expect(requestProxyDuplicateConfirmation(showConfirmation, fakeT, undefined)).resolves.toBe(
      true
    );
    expect(showConfirmation).not.toHaveBeenCalled();
  });

  it('有占用 → 弹一次确认框（文案带账号数 + 账号名），确认 → true', async () => {
    const showConfirmation = vi.fn<(options: ProxyDuplicateConfirmationRequest) => void>();
    const pending = requestProxyDuplicateConfirmation(
      showConfirmation,
      fakeT,
      usage(2, ['GPT-PH-01', 'GPT-PH-02'])
    );
    expect(showConfirmation).toHaveBeenCalledTimes(1);
    const options = showConfirmation.mock.calls[0][0];
    expect(options.title).toBe('proxy_preflight.duplicate_confirm_title');
    expect(options.message).toBe('proxy_preflight.duplicate_confirm_message|2|GPT-PH-01、GPT-PH-02');
    expect(options.confirmText).toBe('proxy_preflight.duplicate_confirm_ok');
    options.onConfirm();
    await expect(pending).resolves.toBe(true);
  });

  it('有占用 → 取消 / 关闭确认框 → false', async () => {
    const showConfirmation = vi.fn<(options: ProxyDuplicateConfirmationRequest) => void>();
    const pending = requestProxyDuplicateConfirmation(showConfirmation, fakeT, usage(1, ['AC-14']));
    showConfirmation.mock.calls[0][0].onCancel?.();
    await expect(pending).resolves.toBe(false);
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
