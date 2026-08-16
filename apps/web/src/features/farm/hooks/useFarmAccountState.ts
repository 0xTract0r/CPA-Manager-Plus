import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { farmApi } from '@/services/api/farm';
import { useFarmStore } from '@/stores';
import type { FarmAccountStateView, FarmEnv } from '@/types/farm';

export interface UseFarmAccountStateResult {
  accountStates: FarmAccountStateView[];
  loading: boolean;
  error: string;
  reload: () => Promise<void>;
}

/**
 * GET /api/farm/account-state?env=<env>：账号认证态快照（FO1「账号态单一
 * 采集源」，farmrunner.AccountStateCollector 周期采集落库）。P7「状态栏
 * 两维徽标」用它的 observed_at 给账号认证态平面补 as-of 时间戳 + 陈旧标记
 * （见 utils/health.ts decideAccountAuthPlane），账号认证态本身的
 * alive/dead/unknown 判定优先信 FarmContainerView.account_auth_status（后端
 * 已经按 farmrunner.DecideAccountAuthPlane 权威算好，能正确区分
 * not_wired/unknown 等边界，见 decideAccountAuthPlane 顶部注释）——本 hook
 * 只补时间戳，不重新发明判定逻辑。
 *
 * 未装配（s.accountState==nil）时后端优雅退化为空列表而非报错，这里同样
 * 不视为 error。
 */
export function useFarmAccountState(env: FarmEnv): UseFarmAccountStateResult {
  const { t } = useTranslation();
  const isConfigured = useFarmStore((state) => state.isConfigured);
  const [accountStates, setAccountStates] = useState<FarmAccountStateView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    if (!isConfigured) {
      setAccountStates([]);
      setError('');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const data = await farmApi.listAccountState(env);
      setAccountStates(Array.isArray(data?.accounts) ? data.accounts : []);
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

  return { accountStates, loading, error, reload };
}
