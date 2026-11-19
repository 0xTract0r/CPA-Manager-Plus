import { useEffect, useMemo, useState } from 'react';
import {
  monitoringAnalyticsApi,
  type CodexCreditsHistoryItemPayload,
} from '@/services/api/usageService';
import {
  buildCodexCreditsHistoryLookup,
  getCodexCreditsHistoryForAuthFile,
  type CodexCreditsHistoryLookup,
} from '@/utils/quota/codexCreditsBurn';
import { resolveAuthProvider } from '@/utils/quota';
import type { AuthFileItem, CodexQuotaState } from '@/types';

// 积分序列变化很慢，认证文件页 60s 轮询不需要跟着拉；独立 5 分钟节流。
export const CODEX_CREDITS_HISTORY_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

const CREDITS_HISTORY_QUERY = { days: 7, max_points: 200 } as const;

const EMPTY_LOOKUP: CodexCreditsHistoryLookup = buildCodexCreditsHistoryLookup([]);

/**
 * 挂载时拉一次 credits-history，之后每 intervalMs 再拉一次（只读 GET）。
 * - managerServiceBase 为空（CPA panel 模式）时不发请求，返回空 lookup。
 * - 拉取失败保留上一次结果；请求不被 await，不阻塞页面其他加载。
 */
export function useCodexCreditsHistoryLookup(
  managerServiceBase: string,
  managementKey: string,
  intervalMs: number = CODEX_CREDITS_HISTORY_REFRESH_INTERVAL_MS
): CodexCreditsHistoryLookup {
  const [items, setItems] = useState<CodexCreditsHistoryItemPayload[]>([]);

  useEffect(() => {
    if (!managerServiceBase) return undefined;
    let cancelled = false;
    const load = async () => {
      try {
        const response = await monitoringAnalyticsApi.getCreditsHistory(
          managerServiceBase,
          managementKey,
          CREDITS_HISTORY_QUERY
        );
        if (!cancelled) setItems(response.items ?? []);
      } catch {
        // 失败保留上一次结果，预测块继续显示旧序列。
      }
    };
    void load();
    const timer = setInterval(() => void load(), intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [intervalMs, managementKey, managerServiceBase]);

  return useMemo(
    () => (managerServiceBase ? buildCodexCreditsHistoryLookup(items) : EMPTY_LOOKUP),
    [items, managerServiceBase]
  );
}

/** 与 QuotaSection 同口径：只给 Codex 卡片挂 creditsHistory，由共用 renderCodexItems 渲染预测块。 */
export function withCodexCreditsHistory(
  quota: CodexQuotaState | undefined,
  lookup: CodexCreditsHistoryLookup | undefined,
  file: AuthFileItem,
  afterMs = 0
): CodexQuotaState | undefined {
  if (!quota || !lookup || resolveAuthProvider(file) !== 'codex') return quota;
  const creditsHistory = getCodexCreditsHistoryForAuthFile(lookup, file);
  if (afterMs <= 0) return creditsHistory ? { ...quota, creditsHistory } : quota;
  // 文件名和索引可在重新认证后复用，只保留确认身份边界后的观测。
  const points = creditsHistory?.points.filter((point) => point.timestampMs > afterMs);
  return {
    ...quota,
    creditsHistory: creditsHistory && points?.length ? { ...creditsHistory, points } : undefined,
  };
}
