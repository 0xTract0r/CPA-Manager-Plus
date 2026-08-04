import { createElement, useCallback, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { farmApi } from '@/services/api/farm';
import { useNotificationStore } from '@/stores';
import type { FarmContainerView } from '@/types/farm';
import type { UseFarmContainersResult } from './useFarmContainers';

export interface UseFarmRetireOptions {
  setContainers: UseFarmContainersResult['setContainers'];
  reload: UseFarmContainersResult['reload'];
}

export interface UseFarmRetireResult {
  retiringContainerId: string | null;
  retire: (container: FarmContainerView) => void;
}

/**
 * 退役容器（软删归档），接线 DELETE /api/farm/containers/{id}?delete_volume=
 * （dto.go retireContainerResponse）。复用 useFarmBindings.unbind 的
 * showConfirmation 二次确认 + 乐观更新模式：
 * - 二次确认弹窗内额外提供"保留卷（默认）/ 同时删除卷"单选，删卷不可逆
 *   （会清除 machine ID 与 Claude 状态），默认保留最安全。
 * - 确认后先本地把 status 标成 retired 再回退（失败回滚 previousStatus）：
 *   容器池默认活跃分组视图据此立即把它排除，不必等 reload 网络往返。
 * - 已绑定容器后端会 409 拒绝（handlers.go：需先解绑），这里不提前拦截，
 *   交给调用方（行操作）只在 !container.binding 时才渲染退役按钮。
 *
 * 本文件是 .ts（非 .tsx），二次确认弹窗内的"保留卷/删除卷"单选用
 * React.createElement 手写而非 JSX，避免仅为几行小组件新增 .tsx 扩展名。
 */
export function useFarmRetire(options: UseFarmRetireOptions): UseFarmRetireResult {
  const { setContainers, reload } = options;
  const { t } = useTranslation();
  const { showNotification, showConfirmation } = useNotificationStore();
  const [retiringContainerId, setRetiringContainerId] = useState<string | null>(null);

  const retire = useCallback(
    (container: FarmContainerView) => {
      const previousStatus = container.status;
      let deleteVolume = false;
      const radioName = `farm-retire-volume-${container.id}`;
      const radioStyle: CSSProperties = {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        marginTop: '8px',
      };

      const message = createElement(
        'div',
        { 'data-testid': 'farm-retire-confirm' },
        createElement('p', null, t('farm.retire.confirmBody', { id: container.id })),
        createElement(
          'label',
          { style: radioStyle },
          createElement('input', {
            type: 'radio',
            name: radioName,
            defaultChecked: true,
            'data-testid': 'farm-retire-keep-volume',
            onChange: () => {
              deleteVolume = false;
            },
          }),
          t('farm.retire.keepVolume')
        ),
        createElement(
          'label',
          { style: radioStyle },
          createElement('input', {
            type: 'radio',
            name: radioName,
            'data-testid': 'farm-retire-delete-volume',
            onChange: () => {
              deleteVolume = true;
            },
          }),
          t('farm.retire.deleteVolume')
        )
      );

      showConfirmation({
        title: t('farm.retire.confirmTitle'),
        message,
        variant: 'danger',
        confirmText: t('farm.actions.retire'),
        onConfirm: async () => {
          setRetiringContainerId(container.id);
          // 乐观更新：先本地把 status 标成 retired，默认活跃分组视图立即
          // 排除它；失败再回滚为 previousStatus。
          setContainers((prev) =>
            prev.map((c) => (c.id === container.id ? { ...c, status: 'retired' } : c))
          );
          try {
            const resp = await farmApi.retireContainer(container.id, { deleteVolume });
            const successMessage = `${t('farm.notification.retire_success', { id: container.id })}${
              resp.detail ? `: ${resp.detail}` : ''
            }`;
            showNotification(successMessage, 'success');
            await reload();
          } catch (err: unknown) {
            setContainers((prev) =>
              prev.map((c) => (c.id === container.id ? { ...c, status: previousStatus } : c))
            );
            const message = err instanceof Error ? err.message : t('common.unknown_error');
            showNotification(`${t('farm.error.retire_failed')}: ${message}`, 'error');
          } finally {
            setRetiringContainerId(null);
          }
        },
      });
    },
    [reload, setContainers, showConfirmation, showNotification, t]
  );

  return { retiringContainerId, retire };
}
