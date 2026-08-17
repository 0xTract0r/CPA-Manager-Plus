import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { farmApi } from '@/services/api/farm';
import type { FarmCapacityResponse } from '@/types/farm';
import { FARM_OVERVIEW_POLL_INTERVAL_MS } from '@/utils/constants';
import { useInterval } from '@/hooks/useInterval';

export interface UseFarmCapacityResult {
  capacity: FarmCapacityResponse | null;
  loading: boolean;
  error: string;
  reload: () => Promise<void>;
}

/**
 * GET /api/farm/capacity：容量就绪度（活跃/上限容器数、宿主可用内存 vs 阈值、
 * host_metrics_available、has_headroom）+ 「认证即自动供」灰度开关与 per-account
 * 供给状态。农场页默认零配置即可用（同源代理 + cpamp 会话身份），本 hook 不再
 * 按 isConfigured 短路，复用 FARM_OVERVIEW_POLL_INTERVAL_MS（30s）轮询节拍，让
 * 「哪些账号已自动接入 / 卡在无 proxy / 容量满」随巡检近实时刷新。
 *
 * 诚实边界原样透传：host_metrics_available=false 时 mem_* 字段不可信、
 * provisioning 关闭态恒空数组，均交由展示层按契约呈现，这里不臆造/不改写。
 */
export function useFarmCapacity(): UseFarmCapacityResult {
  const { t } = useTranslation();
  const [capacity, setCapacity] = useState<FarmCapacityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    setError('');
    try {
      const data = await farmApi.getCapacity();
      setCapacity(data ?? null);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('farm.error.load_failed');
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    setLoading(true);
    reload();
  }, [reload]);

  useInterval(() => {
    reload();
  }, FARM_OVERVIEW_POLL_INTERVAL_MS);

  return { capacity, loading, error, reload };
}
