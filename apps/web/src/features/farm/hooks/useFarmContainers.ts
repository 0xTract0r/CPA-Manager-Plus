import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { farmApi } from '@/services/api/farm';
import { useFarmStore } from '@/stores';
import type { FarmContainerView } from '@/types/farm';
import { FARM_CONTAINERS_POLL_INTERVAL_MS } from '@/utils/constants';
import { useInterval } from '@/hooks/useInterval';

export interface UseFarmContainersResult {
  containers: FarmContainerView[];
  setContainers: React.Dispatch<React.SetStateAction<FarmContainerView[]>>;
  loading: boolean;
  error: string;
  reload: () => Promise<void>;
}

/**
 * 拉容器池 + 轮询保活状态。isConfigured=false（编排器地址/admin key 未配置）
 * 时不发请求，直接给空态，交由页面展示配置引导。
 */
export function useFarmContainers(options: { enabled?: boolean } = {}): UseFarmContainersResult {
  const { enabled = true } = options;
  const { t } = useTranslation();
  const isConfigured = useFarmStore((state) => state.isConfigured);
  const [containers, setContainers] = useState<FarmContainerView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    if (!isConfigured || !enabled) {
      setContainers([]);
      setError('');
      setLoading(false);
      return;
    }
    setError('');
    try {
      const data = await farmApi.listContainers();
      setContainers(Array.isArray(data) ? data : []);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('farm.error.load_failed');
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [enabled, isConfigured, t]);

  useEffect(() => {
    setLoading(true);
    reload();
  }, [reload]);

  useInterval(() => {
    reload();
  }, isConfigured && enabled ? FARM_CONTAINERS_POLL_INTERVAL_MS : null);

  return { containers, setContainers, loading, error, reload };
}
