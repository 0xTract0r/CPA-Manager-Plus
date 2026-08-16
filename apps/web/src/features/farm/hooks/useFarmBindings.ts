import { createElement, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { farmApi } from '@/services/api/farm';
import { useNotificationStore } from '@/stores';
import type { FarmContainerView, FarmCreateBindingRequest } from '@/types/farm';
import type { UseFarmContainersResult } from './useFarmContainers';

export interface UseFarmBindingsOptions {
  setContainers: UseFarmContainersResult['setContainers'];
  reload: UseFarmContainersResult['reload'];
}

export interface UseFarmBindingsResult {
  bindingPending: boolean;
  unbindingContainerId: string | null;
  bind: (request: FarmCreateBindingRequest) => Promise<void>;
  unbind: (container: FarmContainerView) => void;
}

/**
 * 绑定/解绑操作，接线 POST /api/farm/bindings 与
 * DELETE /api/farm/bindings/{container_id}（handlers.go：绑定/解绑排他，
 * 一个容器同时只能绑一个账号；同一账号同一 env 也只能绑一个容器）。
 *
 * 解绑走 showConfirmation 二次确认 + 乐观更新（先本地清掉 binding，失败再
 * 回滚），绑定成功/失败都走 showNotification toast。
 */
export function useFarmBindings(options: UseFarmBindingsOptions): UseFarmBindingsResult {
  const { setContainers, reload } = options;
  const { t } = useTranslation();
  const { showNotification, showConfirmation } = useNotificationStore();
  const [bindingPending, setBindingPending] = useState(false);
  const [unbindingContainerId, setUnbindingContainerId] = useState<string | null>(null);

  const bind = useCallback(
    async (request: FarmCreateBindingRequest) => {
      setBindingPending(true);
      try {
        const resp = await farmApi.createBinding(request);
        await reload();
        if (resp.device_write === 'ok') {
          showNotification(t('farm.notification.bind_success', { id: request.container_id }), 'success');
        } else {
          // pending：P1（CPA 侧持久化）未上线时挂起，binding 已生效但 CPA
          // device_id 段未同步；failed 理论上会被后端回滚并直接抛错，这里
          // 兜底展示 detail。
          showNotification(
            `${t('farm.notification.bind_pending', { id: request.container_id })}${
              resp.detail ? `: ${resp.detail}` : ''
            }`,
            'warning'
          );
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : t('farm.error.bind_failed');
        showNotification(`${t('farm.error.bind_failed')}: ${message}`, 'error');
        throw err;
      } finally {
        setBindingPending(false);
      }
    },
    [reload, showNotification, t]
  );

  const unbind = useCallback(
    (container: FarmContainerView) => {
      const previousBinding = container.binding;
      showConfirmation({
        title: t('farm.unbind_confirm_title'),
        message: createElement(
          'div',
          { 'data-testid': 'farm-unbind-confirm' },
          t('farm.unbind_confirm_message', { id: container.id })
        ),
        variant: 'danger',
        confirmText: t('common.confirm'),
        onConfirm: async () => {
          setUnbindingContainerId(container.id);
          // 乐观更新：先本地清掉 binding，失败再回滚，避免整页等待网络往返
          setContainers((prev) =>
            prev.map((c) => (c.id === container.id ? { ...c, binding: undefined } : c))
          );
          try {
            await farmApi.deleteBinding(container.id);
            showNotification(t('farm.notification.unbind_success', { id: container.id }), 'success');
            await reload();
          } catch (err: unknown) {
            setContainers((prev) =>
              prev.map((c) => (c.id === container.id ? { ...c, binding: previousBinding } : c))
            );
            const message = err instanceof Error ? err.message : t('farm.error.unbind_failed');
            showNotification(`${t('farm.error.unbind_failed')}: ${message}`, 'error');
          } finally {
            setUnbindingContainerId(null);
          }
        },
      });
    },
    [reload, setContainers, showConfirmation, showNotification, t]
  );

  return { bindingPending, unbindingContainerId, bind, unbind };
}
