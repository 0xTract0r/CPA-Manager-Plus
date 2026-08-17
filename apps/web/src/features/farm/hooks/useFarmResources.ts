import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { farmApi } from '@/services/api/farm';
import type { FarmResourceContainer, FarmResourceHost } from '@/types/farm';

export interface UseFarmResourcesResult {
  containers: FarmResourceContainer[];
  host: FarmResourceHost | null;
  loading: boolean;
  error: string;
  reload: () => Promise<void>;
}

/**
 * GET /api/farm/resources：已绑定且 running 的农场容器 docker stats 快照
 * （mem/cpu vs limit）+ 整机资源水位。host.note 固定携带"整机含非农场进程"
 * 口径说明，前端原样展示，不另造措辞。取不到时数值字段后端已回退 0，这里
 * 不再臆造数据，null host 表示尚未取到整机快照。
 */
export function useFarmResources(): UseFarmResourcesResult {
  const { t } = useTranslation();
  const [containers, setContainers] = useState<FarmResourceContainer[]>([]);
  const [host, setHost] = useState<FarmResourceHost | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await farmApi.getResources();
      setContainers(Array.isArray(data?.containers) ? data.containers : []);
      setHost(data?.host ?? null);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('farm.error.load_failed');
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { containers, host, loading, error, reload };
}
