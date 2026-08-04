import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { farmApi } from '@/services/api/farm';
import type { FarmApiError } from '@/services/api/farmClient';
import { useNotificationStore } from '@/stores';
import { FARM_ONBOARD_ERROR_CODES, type FarmEnv, type FarmOnboardErrorCode } from '@/types/farm';
import type { UseFarmAccountsResult } from './useFarmAccounts';

export interface UseFarmOnboardOptions {
  reload: UseFarmAccountsResult['reload'];
}

export interface UseFarmOnboardResult {
  // 当前正在 onboard 中的账号名（同一时刻只允许一个 onboard 请求在途），
  // 供 FarmAccountsPanel 只让被点击那一行的按钮进入 loading 态。
  onboardingAccountId: string | null;
  onboard: (accountId: string, env: FarmEnv) => Promise<void>;
}

// design.md 决策5 机器码 → 可读提示 i18n key 的映射；未命中已知码时落回通用
// 失败文案（farm.error.onboard_failed），不臆造未定义的错误分支。
const ONBOARD_ERROR_MESSAGE_KEY: Record<FarmOnboardErrorCode, string> = {
  no_available_proxy: 'farm.error.onboardNoProxy',
  farm_capacity_exhausted: 'farm.error.onboardCapacityFull',
};

/**
 * POST /api/farm/onboard（P0-10，design.md 决策5「半自动 onboard」）：账号页
 * 对「已认证但未接入农场」（farm_bound=false）账号一键接入，编排器内部按
 * 「无空闲容器则建容器→绑定→起容器」原子链路处理，失败原子回滚，前端只管
 * 一次性调用 + 呈现结果，不重复后端的建容器/绑定两步逻辑。
 *
 * 后端 POST /api/farm/onboard（P0-6）已落地并已注册路由。失败响应体是独立
 * 形状 `onboardErrorResponse{ error(自由文本), code(机器码) }`
 * （services/farm-orchestrator/internal/httpapi/dto.go），机器码在响应体的
 * `code` 独立字段，不在 `error` 文本里，因此这里按 farmClient 解析出的
 * `businessCode` 精确匹配分支，不再对 message 文本做子串匹配。
 */
export function useFarmOnboard(options: UseFarmOnboardOptions): UseFarmOnboardResult {
  const { reload } = options;
  const { t } = useTranslation();
  const { showNotification, showConfirmation } = useNotificationStore();
  const [onboardingAccountId, setOnboardingAccountId] = useState<string | null>(null);

  const actuallyOnboard = useCallback(
    async (accountId: string, env: FarmEnv) => {
      setOnboardingAccountId(accountId);
      try {
        await farmApi.onboardAccount(accountId, env);
        showNotification(t('farm.notification.onboardSuccess', { id: accountId }), 'success');
        await reload();
      } catch (err: unknown) {
        const farmError = err as Partial<FarmApiError>;
        const rawMessage = err instanceof Error ? err.message : '';
        // 机器码来自响应体独立 `code` 字段（farmClient 解析进 businessCode），
        // 不再从 `error` 自由文本里子串匹配——onboardErrorResponse.error 只是
        // 给人看的说明文字，不保证包含机器码原文。
        const businessCode = typeof farmError.businessCode === 'string' ? farmError.businessCode : undefined;
        const knownCode = FARM_ONBOARD_ERROR_CODES.find((code) => code === businessCode) as
          | FarmOnboardErrorCode
          | undefined;
        const message = knownCode
          ? t(ONBOARD_ERROR_MESSAGE_KEY[knownCode])
          : `${t('farm.error.onboardFailed')}${rawMessage ? `: ${rawMessage}` : ''}`;
        showNotification(message, 'error');
      } finally {
        setOnboardingAccountId(null);
      }
    },
    [reload, showNotification, t]
  );

  // 二次确认（对齐 useFarmRetire/useFarmBindings.unbind 已有的
  // showConfirmation 用法，「接入农场」此前是三个农场副作用 hook 里唯一没有
  // 确认弹窗的一个）：onboard 会真实创建容器、绑定真实账号并经住宅代理对外
  // 发起请求，不是幂等的只读操作，取消则不产生任何副作用。
  const onboard = useCallback(
    async (accountId: string, env: FarmEnv) => {
      showConfirmation({
        title: t('farm.onboardConfirm.title'),
        message: t('farm.onboardConfirm.body', { id: accountId }),
        variant: 'primary',
        confirmText: t('farm.accountHealth.onboardAction', { defaultValue: 'Onboard to farm' }),
        cancelText: t('common.cancel'),
        onConfirm: async () => {
          await actuallyOnboard(accountId, env);
        },
      });
    },
    [actuallyOnboard, showConfirmation, t]
  );

  return { onboardingAccountId, onboard };
}
