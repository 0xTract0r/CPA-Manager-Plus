import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { farmApi } from '@/services/api/farm';
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
 * 拉容器池 + 轮询保活状态。农场页默认零配置即可用（同源代理 + cpamp 会话
 * 身份，见 farmClient.ts），因此这里不再按 isConfigured 短路——只受调用方传入
 * 的 `enabled` 控制（例如抽屉未打开时可以显式关闭轮询）。
 */
export function useFarmContainers(options: { enabled?: boolean } = {}): UseFarmContainersResult {
  const { enabled = true } = options;
  const { t } = useTranslation();
  const [containers, setContainers] = useState<FarmContainerView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    if (!enabled) {
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
  }, [enabled, t]);

  useEffect(() => {
    setLoading(true);
    reload();
  }, [reload]);

  useInterval(() => {
    reload();
  }, enabled ? FARM_CONTAINERS_POLL_INTERVAL_MS : null);

  return { containers, setContainers, loading, error, reload };
}
