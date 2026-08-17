import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { farmApi } from '@/services/api/farm';
import type { FarmContainerView } from '@/types/farm';

export interface UseFarmRetiredContainersResult {
  containers: FarmContainerView[];
  loading: boolean;
  error: string;
  reload: () => Promise<void>;
}

/**
 * 已退役 / 幽灵态容器归档视图。
 *
 * useFarmContainers 的默认轮询刻意保持 backend 默认语义（不传 status，排除
 * retired/orphaned），避免把归档数据混进容器池默认活跃视图 / 绑定弹窗的可选
 * 容器列表。这个 hook 只在 operator 主动切到"已退役"分组视图时（enabled=true）
 * 才发起请求，按精确 status 值并行拉 retired + orphaned 两种归档状态
 * （handlers.go handleListContainers：具体状态值只筛该状态），前端合并展示。
 */
export function useFarmRetiredContainers(enabled: boolean): UseFarmRetiredContainersResult {
  const { t } = useTranslation();
  const [containers, setContainers] = useState<FarmContainerView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    if (!enabled) {
      setContainers([]);
      setError('');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const [retired, orphaned] = await Promise.all([
        farmApi.listContainers('retired'),
        farmApi.listContainers('orphaned'),
      ]);
      const merged = [
        ...(Array.isArray(retired) ? retired : []),
        ...(Array.isArray(orphaned) ? orphaned : []),
      ];
      merged.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
      setContainers(merged);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('farm.error.load_failed');
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [enabled, t]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { containers, loading, error, reload };
}
