import { createElement, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { farmApi } from '@/services/api/farm';
import { useNotificationStore } from '@/stores';

export interface UseFarmAutoProvisionOptions {
  // 当前生效的开关真值（来自 GET /api/farm/capacity 的 auto_provision_enabled）。
  enabled: boolean;
  // 成功翻转后重拉 capacity，让开关/漏斗/per-account 供给态按后端真值刷新。
  reload: () => Promise<void>;
}

export interface UseFarmAutoProvisionResult {
  // 请求在途：ToggleSwitch 据此 disabled，防重复提交。
  submitting: boolean;
  // 用户拨动开关的入口：先弹二次确认（行为变更），确认后 PATCH /api/farm/config。
  requestToggle: (next: boolean) => void;
}

/**
 * 「认证即自动供」运行时开关（PATCH /api/farm/config）。复用 useFarmRetire 的
 * showConfirmation 二次确认 + showNotification 反馈模式：
 * - 拨动开关是行为变更（开=新认证账号自动建容器接入农场），先弹确认弹窗说明影响，
 *   用户确认后才调用 farmApi.updateConfig({ auto_provision_enabled: next })。
 * - 不做乐观翻转：ToggleSwitch 的 checked 直接绑定 capacity.auto_provision_enabled，
 *   成功后 reload() 重拉 capacity 才让开关翻到新态；失败则 capacity 不变、开关自然
 *   保持原值（等价「回滚」），只 toast 报错。这样也保留了原只读态兜底——patch 失败
 *   （权限/网络）时展示不会假装已切换。
 * - 重启后该运行时覆盖回落到部署侧默认（FARM_AUTO_PROVISION_ENABLED），确认文案里
 *   明确提示，避免 operator 以为是持久设置。
 *
 * 本文件是 .ts（非 .tsx），确认弹窗正文用 React.createElement 手写两段说明，避免仅为
 * 几行文案新增 .tsx 扩展名（与 useFarmRetire 同手法）。
 */
export function useFarmAutoProvision(
  options: UseFarmAutoProvisionOptions
): UseFarmAutoProvisionResult {
  const { enabled, reload } = options;
  const { t } = useTranslation();
  const { showNotification, showConfirmation } = useNotificationStore();
  const [submitting, setSubmitting] = useState(false);

  const requestToggle = useCallback(
    (next: boolean) => {
      // 与当前真值一致（如轮询刚把 capacity 刷成 next）时无需再发请求。
      if (next === enabled || submitting) {
        return;
      }

      const bodyKey = next
        ? 'farm.capacity.autoProvisionConfirmEnableBody'
        : 'farm.capacity.autoProvisionConfirmDisableBody';
      const message = createElement(
        'div',
        { 'data-testid': 'farm-capacity-autoprovision-confirm' },
        createElement('p', null, t(bodyKey)),
        createElement(
          'p',
          { style: { marginTop: '8px', opacity: 0.8 } },
          t('farm.capacity.autoProvisionConfirmRestartNote')
        )
      );

      showConfirmation({
        title: next
          ? t('farm.capacity.autoProvisionConfirmEnableTitle')
          : t('farm.capacity.autoProvisionConfirmDisableTitle'),
        message,
        variant: next ? 'primary' : 'danger',
        confirmText: next
          ? t('farm.capacity.autoProvisionConfirmEnableCta')
          : t('farm.capacity.autoProvisionConfirmDisableCta'),
        onConfirm: async () => {
          setSubmitting(true);
          try {
            const resp = await farmApi.updateConfig({ auto_provision_enabled: next });
            // 以后端回显真值为准（RWMutex 保护，返回=设置后的值）。
            const applied = resp?.auto_provision_enabled ?? next;
            showNotification(
              t(
                applied
                  ? 'farm.capacity.autoProvisionToggleSuccessOn'
                  : 'farm.capacity.autoProvisionToggleSuccessOff'
              ),
              'success'
            );
            await reload();
          } catch (err: unknown) {
            const detail = err instanceof Error ? err.message : t('common.unknown_error');
            showNotification(
              `${t('farm.capacity.autoProvisionToggleFailed')}: ${detail}`,
              'error'
            );
          } finally {
            setSubmitting(false);
          }
        },
      });
    },
    [enabled, reload, showConfirmation, showNotification, submitting, t]
  );

  return { submitting, requestToggle };
}
