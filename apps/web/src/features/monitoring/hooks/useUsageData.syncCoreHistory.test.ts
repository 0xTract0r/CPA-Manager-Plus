import { describe, expect, it, vi } from 'vitest';
import { runSyncCoreHistoryCursorLoop } from './useUsageData';
import type {
  UsageSyncCoreHistoryParams,
  UsageSyncCoreHistoryResponse,
} from '@/services/api/usageService';

type SyncFn = (
  params?: UsageSyncCoreHistoryParams,
  signal?: AbortSignal
) => Promise<UsageSyncCoreHistoryResponse>;

describe('runSyncCoreHistoryCursorLoop', () => {
  it('聚合多批结果，直到 hasMore=false 才结束', async () => {
    const sync = vi
      .fn<SyncFn>()
      .mockResolvedValueOnce({
        added: 100,
        skipped: 5,
        total: 105,
        failed: 0,
        hasMore: true,
        nextSince: '2026-01-01T00:00:00Z',
      })
      .mockResolvedValueOnce({
        added: 50,
        skipped: 0,
        total: 50,
        failed: 0,
        hasMore: true,
        nextSince: '2026-01-02T00:00:00Z',
      })
      .mockResolvedValueOnce({
        added: 20,
        skipped: 2,
        total: 22,
        failed: 0,
        hasMore: false,
      });

    const progressUpdates: Array<{ batchCount: number; added: number; skipped: number }> = [];

    const outcome = await runSyncCoreHistoryCursorLoop(sync, {
      onProgress: (progress) => progressUpdates.push(progress),
    });

    expect(sync).toHaveBeenCalledTimes(3);
    // 首批：无 since/limit 时透传 undefined（服务端首批默认语义）。
    expect(sync).toHaveBeenNthCalledWith(1, undefined);
    expect(sync).toHaveBeenNthCalledWith(2, {
      since: '2026-01-01T00:00:00Z',
      limit: undefined,
    });
    expect(sync).toHaveBeenNthCalledWith(3, {
      since: '2026-01-02T00:00:00Z',
      limit: undefined,
    });

    expect(outcome).toEqual({
      status: 'completed',
      batchCount: 3,
      added: 170,
      skipped: 7,
    });
    expect(progressUpdates).toHaveLength(3);
    expect(progressUpdates[2]).toEqual({
      batchCount: 3,
      added: 170,
      skipped: 7,
      nextSince: undefined,
    });
  });

  it('传入 since 时首批带上用户选择的范围起点', async () => {
    const sync = vi.fn<SyncFn>().mockResolvedValueOnce({
      added: 10,
      skipped: 0,
      total: 10,
      failed: 0,
      hasMore: false,
    });

    const outcome = await runSyncCoreHistoryCursorLoop(sync, {
      since: '2026-06-01T00:00:00.000Z',
    });

    expect(sync).toHaveBeenCalledWith({ since: '2026-06-01T00:00:00.000Z', limit: undefined });
    expect(outcome.status).toBe('completed');
    expect(outcome.added).toBe(10);
  });

  it('无历史数据时首批即返回 no_data，不再继续请求', async () => {
    const sync = vi.fn<SyncFn>().mockResolvedValueOnce({
      added: 0,
      skipped: 0,
      total: 0,
      failed: 0,
      noHistoricalData: true,
      hasMore: false,
    });

    const outcome = await runSyncCoreHistoryCursorLoop(sync);

    expect(sync).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ status: 'no_data', batchCount: 0, added: 0, skipped: 0 });
  });

  it('中途失败时保留已导入批次的累计结果与失败前的 nextSince，供断点续传', async () => {
    const failure = new Error('network_error');
    const sync = vi
      .fn<SyncFn>()
      .mockResolvedValueOnce({
        added: 100,
        skipped: 0,
        total: 100,
        failed: 0,
        hasMore: true,
        nextSince: '2026-01-01T00:00:00Z',
      })
      .mockRejectedValueOnce(failure);

    const outcome = await runSyncCoreHistoryCursorLoop(sync);

    expect(sync).toHaveBeenCalledTimes(2);
    expect(outcome).toEqual({
      status: 'failed',
      batchCount: 1,
      added: 100,
      skipped: 0,
      nextSince: '2026-01-01T00:00:00Z',
      error: failure,
    });
  });

  it('用户取消后立即停止，保留已完成批次的进度并记住 nextSince', async () => {
    let cancelled = false;
    const sync = vi
      .fn<SyncFn>()
      .mockImplementationOnce(async () => {
        cancelled = true; // 模拟第一批完成后用户点击取消
        return {
          added: 100,
          skipped: 0,
          total: 100,
          failed: 0,
          hasMore: true,
          nextSince: '2026-01-01T00:00:00Z',
        };
      });

    const outcome = await runSyncCoreHistoryCursorLoop(sync, {
      isCancelled: () => cancelled,
    });

    // 第一批已经在发起时不会被拦截（isCancelled 在批次开始前检查），
    // 但拿到 hasMore=true 后，下一轮循环开始前检测到取消标志应立即停止，不再发起第二批请求。
    expect(sync).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({
      status: 'cancelled',
      batchCount: 1,
      added: 100,
      skipped: 0,
      nextSince: '2026-01-01T00:00:00Z',
    });
  });

  it('取消会中断在途请求（通过 AbortSignal），而不是等到该批返回后才生效', async () => {
    const abortController = new AbortController();
    let observedSignal: AbortSignal | undefined;
    let rejectInFlight: ((error: unknown) => void) | undefined;

    const sync = vi.fn<SyncFn>().mockImplementationOnce((_params, signal) => {
      observedSignal = signal;
      return new Promise<UsageSyncCoreHistoryResponse>((_resolve, reject) => {
        rejectInFlight = reject;
        // 模拟真实 axios 行为：signal abort 后请求被中断并抛出 ERR_CANCELED。
        signal?.addEventListener('abort', () => {
          const abortError = new Error('canceled') as Error & { code?: string };
          abortError.name = 'CanceledError';
          abortError.code = 'ERR_CANCELED';
          reject(abortError);
        });
      });
    });

    const outcomePromise = runSyncCoreHistoryCursorLoop(sync, {
      signal: abortController.signal,
    });

    // 请求已经发起（在途），此时点击取消。
    expect(sync).toHaveBeenCalledTimes(1);
    expect(observedSignal).toBe(abortController.signal);
    abortController.abort();

    const outcome = await outcomePromise;

    expect(outcome.status).toBe('cancelled');
    // 该批被中断，未完成，不计入 batchCount / added。
    expect(outcome.batchCount).toBe(0);
    expect(outcome.added).toBe(0);
    // 避免未处理的 rejection 警告（该 reject 已经在 abort 监听器里触发过一次）。
    void rejectInFlight;
  });

  it('取消发生在批中时，游标停在该批的起点，不使用未返回的 nextSince', async () => {
    const abortController = new AbortController();

    const sync = vi
      .fn<SyncFn>()
      .mockResolvedValueOnce({
        added: 100,
        skipped: 0,
        total: 100,
        failed: 0,
        hasMore: true,
        nextSince: '2026-01-01T00:00:00Z',
      })
      .mockImplementationOnce((_params, signal) => {
        return new Promise<UsageSyncCoreHistoryResponse>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            const abortError = new Error('canceled') as Error & { code?: string };
            abortError.name = 'CanceledError';
            abortError.code = 'ERR_CANCELED';
            reject(abortError);
          });
        });
      });

    const outcomePromise = runSyncCoreHistoryCursorLoop(sync, {
      signal: abortController.signal,
    });

    // 等待第一批完成、第二批发起后再取消。
    await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(2));
    abortController.abort();

    const outcome = await outcomePromise;

    expect(outcome).toEqual({
      status: 'cancelled',
      // 第一批已完成，计入累计结果。
      batchCount: 1,
      added: 100,
      skipped: 0,
      // 第二批起点是第一批返回的 nextSince，不是第二批未返回的 nextSince。
      nextSince: '2026-01-01T00:00:00Z',
    });
  });

  it('调用前已取消（尚未发起任何请求）时直接返回 cancelled，不调用 sync', async () => {
    const sync = vi.fn<SyncFn>();

    const outcome = await runSyncCoreHistoryCursorLoop(sync, {
      isCancelled: () => true,
    });

    expect(sync).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      status: 'cancelled',
      batchCount: 0,
      added: 0,
      skipped: 0,
      nextSince: undefined,
    });
  });

  it('范围=全部历史（since 未传）时首批即取消，nextSince 合法地为 undefined（=从头续传，而非"无可续传"）', async () => {
    const abortController = new AbortController();

    const sync = vi.fn<SyncFn>().mockImplementationOnce((_params, signal) => {
      return new Promise<UsageSyncCoreHistoryResponse>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          const abortError = new Error('canceled') as Error & { code?: string };
          abortError.name = 'CanceledError';
          abortError.code = 'ERR_CANCELED';
          reject(abortError);
        });
      });
    });

    const outcomePromise = runSyncCoreHistoryCursorLoop(sync, {
      // since 未传 = 全部历史，与"最近 30 天"等具体 since 的区别就在这里。
      signal: abortController.signal,
    });

    await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(1));
    abortController.abort();

    const outcome = await outcomePromise;

    expect(outcome.status).toBe('cancelled');
    // 首批在途取消，nextSince 回退到本批起点，即调用方传入的 since（此处为 undefined）。
    // 调用方（页面层）不能用 `nextSince !== undefined` 判断是否可续传，
    // 必须用独立的 status === 'cancelled' | 'failed' 标志区分"可续传"与"续传起点值"。
    expect(outcome.nextSince).toBeUndefined();
    expect(outcome.batchCount).toBe(0);
  });

  it('传入 limit 时每批请求都带上该 limit', async () => {
    const sync = vi.fn<SyncFn>().mockResolvedValueOnce({
      added: 1,
      skipped: 0,
      total: 1,
      failed: 0,
      hasMore: false,
    });

    await runSyncCoreHistoryCursorLoop(sync, { limit: 100 });

    expect(sync).toHaveBeenCalledWith({ since: undefined, limit: 100 });
  });
});
