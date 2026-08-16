import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { farmApi } from '@/services/api/farm';
import { useFarmStore } from '@/stores';
import type { FarmOverviewResponse } from '@/types/farm';
import { FARM_OVERVIEW_POLL_INTERVAL_MS } from '@/utils/constants';
import { useInterval } from '@/hooks/useInterval';

export interface UseFarmOverviewResult {
  overview: FarmOverviewResponse | null;
  loading: boolean;
  error: string;
  reload: () => Promise<void>;
}

/**
 * GET /api/farm/overview：KPI 聚合，供 <FarmOverviewBar> 首屏概览带消费
 * （design.md 决策4/6，tasks.md P0-9）。isConfigured=false 时不发请求，与
 * 其余 farm hooks 短路口径一致。
 */
export function useFarmOverview(): UseFarmOverviewResult {
  const { t } = useTranslation();
  const isConfigured = useFarmStore((state) => state.isConfigured);
  const [overview, setOverview] = useState<FarmOverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    if (!isConfigured) {
      setOverview(null);
      setError('');
      setLoading(false);
      return;
    }
    setError('');
    try {
      const data = await farmApi.getOverview();
      setOverview(data ?? null);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('farm.error.load_failed');
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [isConfigured, t]);

  useEffect(() => {
    setLoading(true);
    reload();
  }, [reload]);

  useInterval(() => {
    reload();
  }, isConfigured ? FARM_OVERVIEW_POLL_INTERVAL_MS : null);

  return { overview, loading, error, reload };
}
