import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { farmApi } from '@/services/api/farm';
import { useFarmStore } from '@/stores';
import type { FarmUsageItem } from '@/types/farm';

export interface UseFarmUsageResult {
  items: FarmUsageItem[];
  note: string;
  loading: boolean;
  error: string;
  reload: () => Promise<void>;
}

/**
 * GET /api/farm/usage：按容器/账号聚合的 token 用量 + 费用（编排器聚合 CPA
 * GET /v0/management/usage?include_details=true 的 details[]，只保留农场
 * 绑定账号）。口径见 FarmUsageResponse.note —— CPA 自上次重启起的内存态计数，
 * 不持久、重启即清零，供页面"Token 用量明细"面板原样展示。不传 env，聚合
 * 全部已绑定 env。
 */
export function useFarmUsage(): UseFarmUsageResult {
  const { t } = useTranslation();
  const isConfigured = useFarmStore((state) => state.isConfigured);
  const [items, setItems] = useState<FarmUsageItem[]>([]);
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    if (!isConfigured) {
      setItems([]);
      setNote('');
      setError('');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const data = await farmApi.getUsage();
      setItems(Array.isArray(data?.items) ? data.items : []);
      setNote(data?.note ?? '');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('farm.error.load_failed');
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [isConfigured, t]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { items, note, loading, error, reload };
}
