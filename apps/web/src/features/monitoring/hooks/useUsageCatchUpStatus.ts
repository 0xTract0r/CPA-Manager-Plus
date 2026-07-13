import { useCallback, useEffect, useState } from 'react';
import { useInterval } from '@/hooks/useInterval';
import { usageServiceApi, type UsageCatchUpRunStatus } from '@/services/api/usageService';
import { useAuthStore } from '@/stores';

export interface UseUsageCatchUpStatusOptions {
  /** 8.6 自动补齐状态挂载的 Manager Server base；为空时不请求。 */
  serviceBase: string;
  /** 是否启用轮询/请求；通常跟随页面自身的可见性 + 当前 layer 状态。 */
  enabled: boolean;
  /** 轮询间隔（毫秒）；<= 0 或 null 时只请求一次，不再轮询。 */
  refreshIntervalMs?: number | null;
}

export interface UseUsageCatchUpStatusReturn {
  status: UsageCatchUpRunStatus | null;
  /** 是否已经拿到过至少一次成功响应（用于区分"加载中"与"从未运行过"）。 */
  found: boolean;
  loading: boolean;
}

/**
 * 轮询 8.6 后台用量自动补齐 worker 的最近一次运行状态，供监控中心页顶部
 * 状态条展示"自动补齐：上次 xxx · 补 N 条 · ok/error/nodata"提示。
 * 请求失败时静默保留上一次已知状态，不打断监控页其余数据流。
 */
export function useUsageCatchUpStatus({
  serviceBase,
  enabled,
  refreshIntervalMs = 60_000,
}: UseUsageCatchUpStatusOptions): UseUsageCatchUpStatusReturn {
  const managementKey = useAuthStore((state) => state.managementKey);
  const [status, setStatus] = useState<UsageCatchUpRunStatus | null>(null);
  const [found, setFound] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!enabled || !serviceBase) return;
    setLoading(true);
    try {
      const response = await usageServiceApi.getCatchUpStatus(serviceBase, managementKey);
      setFound(Boolean(response.found));
      setStatus(response.found ? response.status : null);
    } catch {
      // 静默失败：保留上一次已知状态，不打断监控页其余数据流/不弹通知。
    } finally {
      setLoading(false);
    }
  }, [enabled, managementKey, serviceBase]);

  useEffect(() => {
    if (!enabled || !serviceBase) {
      setStatus(null);
      setFound(false);
      return;
    }
    void load();
  }, [enabled, load, serviceBase]);

  useInterval(
    () => {
      void load();
    },
    enabled && serviceBase && refreshIntervalMs && refreshIntervalMs > 0 ? refreshIntervalMs : null
  );

  return { status, found, loading };
}
