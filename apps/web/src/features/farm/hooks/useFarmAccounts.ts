import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { farmApi } from '@/services/api/farm';
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
 *
 * `enabled`（默认 true，保持所有现有调用向后兼容——仍挂载即发）：调用方可传 false
 * gate 掉请求。农场页在部署环境（prod/test）解析出来前传 false，避免用回退值 'test'
 * 先打到错环境的 CPA。初始 loading=true（对齐 useFarmContainers/useFarmCapacity），
 * 未 enabled 时既不发请求、也不置 error，展示层看到的是「加载中」而非「空/错」。
 */
export function useFarmAccounts(env: FarmEnv, enabled: boolean = true): UseFarmAccountsResult {
  const { t } = useTranslation();
  const [accounts, setAccounts] = useState<FarmAccountEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    if (!enabled) return;
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
  }, [env, enabled, t]);

  useEffect(() => {
    if (enabled) reload();
  }, [enabled, reload]);

  return { accounts, loading, error, reload };
}
