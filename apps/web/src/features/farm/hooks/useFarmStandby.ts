import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { farmApi } from '@/services/api/farm';
import { useNotificationStore } from '@/stores';
import type { FarmContainerView } from '@/types/farm';
import type { UseFarmContainersResult } from './useFarmContainers';

// 待机/恢复动作的目标：容器 id 必填，label 可选（展示用，默认回退 id）。容器池视图
// 直接传 FarmContainerView.id；账号视图传 account.farm_container_id + 备注名作 label。
export interface FarmStandbyTarget {
  id: string;
  label?: string;
}

export interface UseFarmStandbyOptions {
  // 容器池视图传入以做乐观更新（先把 status 本地翻成 standby/running，失败回滚）；
  // 账号视图没有本地容器数组可改，省略即可，成功后仅靠 reload 刷新。
  setContainers?: UseFarmContainersResult['setContainers'];
  // 成功后重新拉取（容器池 reload / 账号列表 reload）。
  reload: () => Promise<void> | void;
}

export interface UseFarmStandbyResult {
  standbyingContainerId: string | null;
  resumingContainerId: string | null;
  standby: (target: FarmStandbyTarget) => void;
  resume: (target: FarmStandbyTarget) => void;
}

/**
 * farm-account-standby-control R2 待机/恢复。
 *
 * 接线 POST /api/farm/containers/{id}/standby 与 /resume（body { confirm:true }）。
 * 与 useFarmRetire 的区别：
 * - retire 是不可逆软删归档（设备脱管、可选删卷），用 danger 二次确认；
 * - standby 是**可逆**临时停摆（docker stop + 停遥测 + 保卷保身份，随时 resume），
 *   所以二次确认用中性 primary 变体，文案强调"可恢复、保留卷与身份"，不吓唬成删除。
 *
 * 乐观更新复用 useFarmRetire 同款手法：容器池视图传 setContainers 时先本地把 status
 * 翻成目标态（standby/running），请求失败回滚到 previousStatus；账号视图不传
 * setContainers，成功后仅靠 reload 刷新。两者都在 finally 清 in-flight 标记。
 */
export function useFarmStandby(options: UseFarmStandbyOptions): UseFarmStandbyResult {
  const { setContainers, reload } = options;
  const { t } = useTranslation();
  const { showNotification, showConfirmation } = useNotificationStore();
  const [standbyingContainerId, setStandbyingContainerId] = useState<string | null>(null);
  const [resumingContainerId, setResumingContainerId] = useState<string | null>(null);

  const applyOptimisticStatus = useCallback(
    (id: string, status: FarmContainerView['status']) => {
      setContainers?.((prev) => prev.map((c) => (c.id === id ? { ...c, status } : c)));
    },
    [setContainers]
  );

  const rollbackStatus = useCallback(
    (id: string, previous: Map<string, FarmContainerView['status']>) => {
      setContainers?.((prev) =>
        prev.map((c) => (c.id === id && previous.has(c.id) ? { ...c, status: previous.get(c.id)! } : c))
      );
    },
    [setContainers]
  );

  const standby = useCallback(
    (target: FarmStandbyTarget) => {
      const label = target.label || target.id;
      showConfirmation({
        title: t('farm.standby.confirmTitle', { defaultValue: '移出农场（待机）' }),
        message: t('farm.standby.confirmBody', {
          label,
          defaultValue:
            '将容器 {{label}} 移出农场待机：停止容器与遥测上报、保留专属卷与身份（device_id）。' +
            '这是可逆操作，稍后可随时"恢复"重新启动。',
        }),
        // 可逆操作用中性 primary，不用 danger——避免与退役（不可逆软删）视觉混淆。
        variant: 'primary',
        confirmText: t('farm.standby.confirmAction', { defaultValue: '移出农场（待机）' }),
        onConfirm: async () => {
          // 记录受影响行原状态，用于失败回滚（只读乐观快照，容器池视图才有）。
          const previous = new Map<string, FarmContainerView['status']>();
          previous.set(target.id, 'running');
          setStandbyingContainerId(target.id);
          applyOptimisticStatus(target.id, 'standby');
          try {
            const resp = await farmApi.standbyContainer(target.id);
            const extra = resp.message ? `：${resp.message}` : '';
            showNotification(
              `${t('farm.standby.standbySuccess', { label, defaultValue: '已将 {{label}} 移出农场待机' })}${extra}`,
              'success'
            );
            await reload();
          } catch (err: unknown) {
            rollbackStatus(target.id, previous);
            const message = err instanceof Error ? err.message : t('common.unknown_error');
            showNotification(
              `${t('farm.standby.standbyFailed', { defaultValue: '移出农场待机失败' })}: ${message}`,
              'error'
            );
          } finally {
            setStandbyingContainerId(null);
          }
        },
      });
    },
    [applyOptimisticStatus, reload, rollbackStatus, showConfirmation, showNotification, t]
  );

  const resume = useCallback(
    (target: FarmStandbyTarget) => {
      const label = target.label || target.id;
      showConfirmation({
        title: t('farm.standby.resumeTitle', { defaultValue: '恢复容器' }),
        message: t('farm.standby.resumeBody', {
          label,
          defaultValue: '将待机容器 {{label}} 恢复到运行态：重新启动容器并继续发送遥测。',
        }),
        variant: 'primary',
        confirmText: t('farm.standby.resumeAction', { defaultValue: '恢复' }),
        onConfirm: async () => {
          const previous = new Map<string, FarmContainerView['status']>();
          previous.set(target.id, 'standby');
          setResumingContainerId(target.id);
          applyOptimisticStatus(target.id, 'running');
          try {
            const resp = await farmApi.resumeContainer(target.id);
            const extra = resp.message ? `：${resp.message}` : '';
            showNotification(
              `${t('farm.standby.resumeSuccess', { label, defaultValue: '已恢复 {{label}}' })}${extra}`,
              'success'
            );
            await reload();
          } catch (err: unknown) {
            rollbackStatus(target.id, previous);
            const message = err instanceof Error ? err.message : t('common.unknown_error');
            showNotification(
              `${t('farm.standby.resumeFailed', { defaultValue: '恢复失败' })}: ${message}`,
              'error'
            );
          } finally {
            setResumingContainerId(null);
          }
        },
      });
    },
    [applyOptimisticStatus, reload, rollbackStatus, showConfirmation, showNotification, t]
  );

  return { standbyingContainerId, resumingContainerId, standby, resume };
}
