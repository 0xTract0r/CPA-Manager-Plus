import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createElement, useLayoutEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthFileItem, CodexQuotaState } from '@/types';
import {
  buildCodexCreditsHistoryLookup,
  getCodexCreditsHistoryForAuthFile,
  type CodexCreditsHistoryLookup,
} from '@/utils/quota/codexCreditsBurn';
import {
  CODEX_CREDITS_HISTORY_REFRESH_INTERVAL_MS,
  useCodexCreditsHistoryLookup,
  withCodexCreditsHistory,
} from './useCodexCreditsHistoryLookup';

const { getCreditsHistory } = vi.hoisted(() => ({ getCreditsHistory: vi.fn() }));
vi.mock('@/services/api/usageService', () => ({
  monitoringAnalyticsApi: { getCreditsHistory },
}));

const historyItem = (balance: number) => ({
  auth_file_snapshot: 'codex-a.json',
  auth_index: '7',
  quota_reset_at_ms: Date.parse('2026-11-20T00:00:00Z'),
  window_start_ms: Date.parse('2026-11-13T00:00:00Z'),
  unlimited: false,
  points: [
    { timestamp_ms: Date.parse('2026-11-13T00:00:00Z'), balance: balance + 100 },
    { timestamp_ms: Date.parse('2026-11-14T00:00:00Z'), balance },
  ],
});

const codexFile = {
  name: 'codex-a.json',
  type: 'codex',
  auth_index: '7',
} as unknown as AuthFileItem;
const claudeFile = {
  name: 'codex-a.json',
  type: 'claude',
  auth_index: '7',
} as unknown as AuthFileItem;
const baseQuota = { status: 'success', windows: [] } as unknown as CodexQuotaState;

let last: CodexCreditsHistoryLookup;
let view: ReactTestRenderer | undefined;
function Probe({ base }: { base: string }) {
  const lookup = useCodexCreditsHistoryLookup(base, 'key');
  useLayoutEffect(() => {
    last = lookup;
  }, [lookup]);
  return null;
}
const mount = async (base: string) => {
  await act(async () => {
    view = create(createElement(Probe, { base }));
  });
};
const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

describe('useCodexCreditsHistoryLookup', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    getCreditsHistory.mockReset();
  });
  afterEach(() => {
    act(() => view?.unmount());
    view = undefined;
    vi.useRealTimers();
  });

  it('挂载拉一次，之后按 5 分钟节流，不跟随 60s 轮询', async () => {
    getCreditsHistory.mockResolvedValue({ items: [historyItem(500)] });
    await mount('http://mgr');

    expect(getCreditsHistory).toHaveBeenCalledTimes(1);
    expect(getCreditsHistory).toHaveBeenCalledWith('http://mgr', 'key', {
      days: 7,
      max_points: 200,
    });
    expect(Boolean(getCodexCreditsHistoryForAuthFile(last, codexFile))).toBe(true);

    await advance(60_000);
    expect(getCreditsHistory).toHaveBeenCalledTimes(1);

    await advance(CODEX_CREDITS_HISTORY_REFRESH_INTERVAL_MS - 60_000);
    expect(getCreditsHistory).toHaveBeenCalledTimes(2);
  });

  it('拉取失败保留上一次结果', async () => {
    getCreditsHistory.mockResolvedValueOnce({ items: [historyItem(500)] });
    await mount('http://mgr');
    const first = getCodexCreditsHistoryForAuthFile(last, codexFile);
    expect(first).toBeDefined();

    getCreditsHistory.mockRejectedValueOnce(new Error('boom'));
    await advance(CODEX_CREDITS_HISTORY_REFRESH_INTERVAL_MS);
    expect(getCreditsHistory).toHaveBeenCalledTimes(2);
    expect(getCodexCreditsHistoryForAuthFile(last, codexFile)).toEqual(first);
  });

  it('managerServiceBase 为空（CPA panel 模式）时不发请求', async () => {
    await mount('');
    await advance(CODEX_CREDITS_HISTORY_REFRESH_INTERVAL_MS * 2);
    expect(getCreditsHistory).not.toHaveBeenCalled();
    expect(last.byFileAuthIndex.size).toBe(0);
  });
});

describe('withCodexCreditsHistory', () => {
  const lookup = buildCodexCreditsHistoryLookup([historyItem(500)]);

  it('Codex 卡片拿到积分序列时挂上 creditsHistory（renderCodexItems 据此画预测块）', () => {
    const next = withCodexCreditsHistory(baseQuota, lookup, codexFile);
    expect(next?.creditsHistory?.points).toHaveLength(2);
    expect(next?.creditsHistory?.quotaResetAtMs).toBe(Date.parse('2026-11-20T00:00:00Z'));
  });

  it('同名同索引重新认证后只使用新身份的历史点', () => {
    const start = Date.parse('2026-11-13T00:00:00Z');
    const end = Date.parse('2026-11-14T00:00:00Z');
    const previous = withCodexCreditsHistory(baseQuota, lookup, codexFile)!;
    const next = withCodexCreditsHistory(previous, lookup, codexFile, start);
    expect(next?.creditsHistory?.points.map((point) => point.timestampMs)).toEqual([end]);
    expect(withCodexCreditsHistory(previous, lookup, codexFile, end)?.creditsHistory).toBeUndefined();
  });

  it('非 Codex 卡片、身份不匹配或无 quota 时原样返回', () => {
    expect(withCodexCreditsHistory(baseQuota, lookup, claudeFile)).toBe(baseQuota);
    const otherIndex = { ...codexFile, auth_index: '8' } as unknown as AuthFileItem;
    expect(withCodexCreditsHistory(baseQuota, lookup, otherIndex)).toBe(baseQuota);
    expect(withCodexCreditsHistory(undefined, lookup, codexFile)).toBeUndefined();
  });
});
