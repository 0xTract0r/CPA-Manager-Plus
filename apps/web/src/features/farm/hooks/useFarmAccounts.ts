import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { farmApi } from '@/services/api/farm';
import { useFarmStore } from '@/stores';
import type { FarmAccountEntry, FarmEnv } from '@/types/farm';

export interface UseFarmAccountsResult {
  accounts: FarmAccountEntry[];
  loading: boolean;
  error: string;
  reload: () => Promise<void>;
}

/**
 * GET /api/farm/accounts?env=<env>：编排器透传 CPA 该环境的账号健康列表
 * （复用 CPA 既有 GET /auth-files，无需 core 改动），供绑定弹窗挑账号、
 * 也供页面账号健康区展示。
 */
export function useFarmAccounts(env: FarmEnv): UseFarmAccountsResult {
  const { t } = useTranslation();
  const isConfigured = useFarmStore((state) => state.isConfigured);
  const [accounts, setAccounts] = useState<FarmAccountEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    if (!isConfigured) {
      setAccounts([]);
      setError('');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const data = await farmApi.listAccounts(env);
      setAccounts(Array.isArray(data) ? data : []);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('farm.error.load_failed');
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [env, isConfigured, t]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { accounts, loading, error, reload };
}
