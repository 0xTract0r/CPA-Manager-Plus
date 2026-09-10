import { createElement, useCallback, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { farmApi } from '@/services/api/farm';
import { useNotificationStore } from '@/stores';
import type { AuthFileItem } from '@/types/authFile';
import type { FarmEnv } from '@/types/farm';
import { isClaudeFile } from '@/utils/quota/validators';

export interface UseFarmEnrolledDisableGuardOptions {
  // 账号页原生的停用/启用切换（useAuthFilesData.handleStatusToggle）。被本 guard 包一层：
  // 停用一个 farm_enrolled 账号时先弹语义澄清对话框，其余情况原样透传。
  onToggle: (item: AuthFileItem, enabled: boolean) => void;
  // 编排器环境。调用方（AuthFilesPage）从 useFarmDeploymentEnv 解析真实部署环境传入
  // （prod/test）；默认 'test' 仅作回退，绝不回退 'prod'（与 403 env 修复同策略）。
  env?: FarmEnv;
}

export interface UseFarmEnrolledDisableGuardResult {
  // 替换原 onToggleStatus 透传给账号卡片。
  guardedToggle: (item: AuthFileItem, enabled: boolean) => void;
  // 正在为某账号执行"一并移出农场（待机）"时的账号名（in-flight 标记，调用方可用于置灰）。
  standbyingAccount: string | null;
}

/**
 * farm-account-standby-control R1：停用语义拆清。
 *
 * 背景：对一个已纳入农场（farm_enrolled）的账号点"停用"，CPA 侧只停"服务"（出站
 * serving），但农场容器仍在温着、继续发遥测——这与 operator 直觉的"停用=彻底停掉"
 * 不符，容易留下被遗忘的温容器。
 *
 * 本 guard 在停用 farm_enrolled 账号时弹对话框澄清该语义，并给两个出口：
 *  - 仅停服务（保持现状）：维持原停用行为，容器继续温着发遥测；
 *  - 一并移出农场（停遥测）：停用 + 调 standby 端点让容器待机（停容器 + 停遥测 + 保卷）。
 *
 * 非 farm_enrolled 账号、非 Claude 账号、或"重新启用"动作一律原样透传，不弹这段。
 *
 * 容器 id 解析：账号页的 AuthFileItem 不带农场容器 id，这里按名字去
 * GET /api/farm/accounts?env= 匹配拿 farm_container_id 再调 standby。解析不到容器时
 * （未绑定 / 编排器不可达）优雅降级为"仅停服务"并 toast 说明，绝不谎报已待机。
 */
export function useFarmEnrolledDisableGuard(
  options: UseFarmEnrolledDisableGuardOptions
): UseFarmEnrolledDisableGuardResult {
  const { onToggle, env = 'test' } = options;
  const { t } = useTranslation();
  const { showNotification, showConfirmation } = useNotificationStore();
  const [standbyingAccount, setStandbyingAccount] = useState<string | null>(null);

  // 解析账号对应的农场容器并调 standby。解析不到容器时不报错、只提示已仅停服务。
  const standbyAccountContainer = useCallback(
    async (item: AuthFileItem) => {
      const displayName = item.note || item.name;
      setStandbyingAccount(item.name);
      try {
        const accounts = await farmApi.listAccounts(env);
        const match = Array.isArray(accounts)
          ? accounts.find((a) => a.name === item.name)
          : undefined;
        const containerId = match?.farm_bound ? match.farm_container_id : undefined;
        if (!containerId) {
          showNotification(
            t('farm.standby.accountNoContainer', {
              label: displayName,
              defaultValue: '{{label}} 当前未绑定农场容器，已仅停服务（无需待机）',
            }),
            'info'
          );
          return;
        }
        const resp = await farmApi.standbyContainer(containerId);
        const extra = resp.message ? `：${resp.message}` : '';
        showNotification(
          `${t('farm.standby.accountStandbySuccess', {
            label: displayName,
            defaultValue: '已将 {{label}} 移出农场待机（停容器 + 停遥测 + 保留卷）',
          })}${extra}`,
          'success'
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : t('common.unknown_error');
        showNotification(
          `${t('farm.standby.accountStandbyFailed', {
            defaultValue: '移出农场待机失败（服务已停用）',
          })}: ${message}`,
          'error'
        );
      } finally {
        setStandbyingAccount(null);
      }
    },
    [env, showNotification, t]
  );

  const guardedToggle = useCallback(
    (item: AuthFileItem, enabled: boolean) => {
      // 只拦截"停用一个已纳管 Claude 账号"；重新启用、非纳管、非 Claude 一律原样透传。
      const isDisabling = enabled === false;
      const isFarmEnrolled = item.farm_enrolled === true;
      if (!isDisabling || !isFarmEnrolled || !isClaudeFile(item)) {
        onToggle(item, enabled);
        return;
      }

      const displayName = item.note || item.name;
      // 默认选"仅停服务"（保持现状，最小副作用）。radio 手法与 useFarmRetire 的
      // 保卷/删卷单选一致：.ts 文件里用 createElement 手写几行，不为此新增 .tsx。
      let choice: 'service_only' | 'standby' = 'service_only';
      const radioName = `farm-disable-choice-${item.name}`;
      const radioStyle: CSSProperties = {
        display: 'flex',
        alignItems: 'flex-start',
        gap: '8px',
        marginTop: '10px',
      };

      const message = createElement(
        'div',
        { 'data-testid': 'farm-enrolled-disable-confirm' },
        createElement(
          'p',
          null,
          t('farm.standby.disableExplain', {
            label: displayName,
            defaultValue:
              '“停用”只停止 {{label}} 的服务出站；它的农场容器仍在温着、继续发送遥测。请选择处理方式：',
          })
        ),
        createElement(
          'label',
          { style: radioStyle },
          createElement('input', {
            type: 'radio',
            name: radioName,
            defaultChecked: true,
            'data-testid': 'farm-disable-service-only',
            onChange: () => {
              choice = 'service_only';
            },
          }),
          createElement(
            'span',
            null,
            t('farm.standby.disableServiceOnly', {
              defaultValue: '仅停服务（保持现状）——容器继续温着、继续发遥测',
            })
          )
        ),
        createElement(
          'label',
          { style: radioStyle },
          createElement('input', {
            type: 'radio',
            name: radioName,
            'data-testid': 'farm-disable-standby',
            onChange: () => {
              choice = 'standby';
            },
          }),
          createElement(
            'span',
            null,
            t('farm.standby.disableStandby', {
              defaultValue: '一并移出农场（停遥测）——停容器 + 停遥测 + 保留卷，可恢复',
            })
          )
        )
      );

      showConfirmation({
        title: t('farm.standby.disableTitle', { defaultValue: '停用账号' }),
        message,
        variant: 'primary',
        confirmText: t('farm.standby.disableConfirm', { defaultValue: '确认停用' }),
        onConfirm: async () => {
          // 两个分支都先停服务（维持原停用语义）。
          onToggle(item, false);
          if (choice === 'standby') {
            await standbyAccountContainer(item);
          }
        },
      });
    },
    [onToggle, showConfirmation, standbyAccountContainer, t]
  );

  return { guardedToggle, standbyingAccount };
}
