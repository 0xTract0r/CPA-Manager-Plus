import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { farmApi } from '@/services/api/farm';
import type { FarmEnv, FarmStandbySummaryResponse } from '@/types/farm';
import { FARM_OVERVIEW_POLL_INTERVAL_MS } from '@/utils/constants';
import { useInterval } from '@/hooks/useInterval';

export interface UseFarmStandbySummaryResult {
  summary: FarmStandbySummaryResponse | null;
  loading: boolean;
  error: string;
  reload: () => Promise<void>;
}

/**
 * farm-account-standby-control R4：GET /api/farm/standby-summary?env=。
 *
 * 聚合"停用超 N 天账号 / 待机容器 / 未回收退役卷"三类沉积量，供 FarmStandbySummaryPanel
 * 提醒人工清理。与容量面板同款：默认零配置（同源代理 + cpamp 会话身份），复用
 * FARM_OVERVIEW_POLL_INTERVAL_MS（30s）节拍轮询，让看板随巡检近实时刷新。
 *
 * env 由调用方从 useFarmDeploymentEnv 解析后传入（prod/test），不再写死 'test'——否则
 * 生产 cpamp 的看板会错查测试环境（与 403 env 竞态同类）。enabled 门：env 尚未 resolved
 * 时传 false，避免先用回退值 'test' 打一发测试环境 CPA。
 */
export function useFarmStandbySummary(
  env: FarmEnv,
  enabled: boolean = true
): UseFarmStandbySummaryResult {
  const { t } = useTranslation();
  const [summary, setSummary] = useState<FarmStandbySummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    if (!enabled) return;
    setError('');
    try {
      const data = await farmApi.getStandbySummary(env);
      setSummary(data ?? null);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('farm.error.load_failed');
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [env, enabled, t]);

  useEffect(() => {
    if (!enabled) return;
    setLoading(true);
    reload();
  }, [reload, enabled]);

  useInterval(() => {
    if (enabled) reload();
  }, FARM_OVERVIEW_POLL_INTERVAL_MS);

  return { summary, loading, error, reload };
}
