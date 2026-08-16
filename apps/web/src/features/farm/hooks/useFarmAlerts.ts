import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { farmApi, type FarmAlertsQuery } from '@/services/api/farm';
import { useFarmStore } from '@/stores';
import type { FarmAlertEntry } from '@/types/farm';
import { FARM_ALERTS_POLL_INTERVAL_MS } from '@/utils/constants';
import { useInterval } from '@/hooks/useInterval';

export interface UseFarmAlertsResult {
  alerts: FarmAlertEntry[];
  loading: boolean;
  error: string;
  reload: () => Promise<void>;
}

/**
 * GET /api/farm/alerts：跨容器告警 feed，供 <FarmAlertsPanel> 消费
 * （design.md 决策4/6，tasks.md P0-9）。P0-5 后端已交付（
 * services/farm-orchestrator/internal/httpapi/server.go 注册
 * handleGetAlerts，dto.go 定义 alertsResponse，见 services/api/farm.ts
 * farmApi.getAlerts 注释），本 hook 正常消费真实响应；请求失败时把 error
 * 原样呈现给 <FarmAlertsPanel> 的 AsyncPanel error 态，不吞掉也不伪造
 * 空成功。
 */
export function useFarmAlerts(query?: FarmAlertsQuery): UseFarmAlertsResult {
  const { t } = useTranslation();
  const isConfigured = useFarmStore((state) => state.isConfigured);
  const [alerts, setAlerts] = useState<FarmAlertEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    if (!isConfigured) {
      setAlerts([]);
      setError('');
      setLoading(false);
      return;
    }
    setError('');
    try {
      const data = await farmApi.getAlerts(query);
      setAlerts(Array.isArray(data?.alerts) ? data.alerts : []);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('farm.error.load_failed');
      setError(message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConfigured, t, query?.window, query?.status]);

  useEffect(() => {
    setLoading(true);
    reload();
  }, [reload]);

  useInterval(() => {
    reload();
  }, isConfigured ? FARM_ALERTS_POLL_INTERVAL_MS : null);

  return { alerts, loading, error, reload };
}
