import { createElement, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { farmAutoEnrollApi } from '@/services/api/farmAutoEnroll';
import { useNotificationStore } from '@/stores';

export interface UseFarmAutoEnrollResult {
  // 当前全局默认真值（来自 GET /v0/management/farm-auto-enroll 的 .value）。
  enabled: boolean;
  // 首次读取在途：初次挂载 GET 未回来前为 true，ToggleSwitch 据此 disabled。
  loading: boolean;
  // PUT 在途：防重复提交，ToggleSwitch 据此 disabled。
  submitting: boolean;
  // 读取失败信息（PUT 失败只 toast、不进这里，避免把开关整段替换成错误态）。
  error: string;
  // 重拉全局默认（成功翻转后调用，让开关按 core 真值刷新）。
  reload: () => Promise<void>;
  // 用户拨动开关入口：先二次确认（行为变更），确认后 PUT { value: next }。
  requestToggle: (next: boolean) => void;
}

/**
 * 「全局自动纳管新号」开关（GET/PUT /v0/management/farm-auto-enroll，走 core 通用
 * 管理 client）。UI 范式照抄 useFarmAutoProvision：
 * - 拨动是行为变更（开=新认证账号自动进农场名单；关=新号不自动纳管，需在账号设置里
 *   逐个手动开启农场纳管），先弹二次确认说明影响，确认后才 PUT。
 * - 不做乐观翻转：ToggleSwitch 的 checked 直接绑定本 hook 的 enabled，PUT 成功后
 *   reload() 重拉 core 真值才让开关翻到新态；失败则 enabled 不变（等价「回滚」），
 *   只 toast 报错。
 * - 与旁边的「自动供给」开关刻意区分：自动供给打编排器、管「已纳管账号是否自动建
 *   容器」；自动纳管打 core、管「新号是否进农场名单」。确认文案里明确这层区分。
 *
 * 本文件是 .ts（非 .tsx），确认弹窗正文用 React.createElement 手写多段说明，避免仅为
 * 几行文案新增 .tsx 扩展名（与 useFarmAutoProvision / useFarmRetire 同手法）。
 *
 * i18n：本开关为 H4 新增，key 一律带内联 defaultValue（简中），不改共享 locale JSON，
 * 避免与并行改动冲突；locale 已有该 key 时以 JSON 为准，缺失时回落到 defaultValue。
 */
export function useFarmAutoEnroll(): UseFarmAutoEnrollResult {
  const { t } = useTranslation();
  const { showNotification, showConfirmation } = useNotificationStore();
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    setError('');
    try {
      const data = await farmAutoEnrollApi.get();
      setEnabled(Boolean(data?.value));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('common.unknown_error');
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    setLoading(true);
    reload();
  }, [reload]);

  const requestToggle = useCallback(
    (next: boolean) => {
      // 与当前真值一致（如刚 reload 成 next）时无需再发请求。
      if (next === enabled || submitting) {
        return;
      }

      // 两段说明：第一段讲开/关行为，第二段讲与「自动供给」的区分（关闭态额外指向
      // 账号设置里的 per-account 手动纳管开关）。
      const message = createElement(
        'div',
        { 'data-testid': 'farm-capacity-autoenroll-confirm' },
        createElement(
          'p',
          null,
          next
            ? t('farm.capacity.autoEnrollConfirmEnableBody', {
                defaultValue: '开启后，新认证的账号会自动加入农场纳管名单参与调度。',
              })
            : t('farm.capacity.autoEnrollConfirmDisableBody', {
                defaultValue:
                  '关闭后，新认证的账号不会自动进入农场，需要在「账号设置」里为每个号手动开启「农场纳管」。',
              })
        ),
        createElement(
          'p',
          { style: { marginTop: '8px', opacity: 0.8 } },
          t('farm.capacity.autoEnrollConfirmDistinctNote', {
            defaultValue:
              '注意与「自动供给」区分：自动供给负责为已纳管账号创建运行容器；自动纳管只决定新号是否进入农场名单，打的是 core 全局默认。',
          })
        )
      );

      showConfirmation({
        title: next
          ? t('farm.capacity.autoEnrollConfirmEnableTitle', { defaultValue: '开启自动纳管新号？' })
          : t('farm.capacity.autoEnrollConfirmDisableTitle', { defaultValue: '关闭自动纳管新号？' }),
        message,
        variant: next ? 'primary' : 'danger',
        confirmText: next
          ? t('farm.capacity.autoEnrollConfirmEnableCta', { defaultValue: '开启自动纳管' })
          : t('farm.capacity.autoEnrollConfirmDisableCta', { defaultValue: '关闭自动纳管' }),
        onConfirm: async () => {
          setSubmitting(true);
          try {
            const resp = await farmAutoEnrollApi.set(next);
            // 以 core 回显真值为准。
            const applied = resp?.value ?? next;
            showNotification(
              t(
                applied
                  ? 'farm.capacity.autoEnrollToggleSuccessOn'
                  : 'farm.capacity.autoEnrollToggleSuccessOff',
                {
                  defaultValue: applied
                    ? '已开启：新号将自动纳入农场'
                    : '已关闭：新号需手动纳管',
                }
              ),
              'success'
            );
            await reload();
          } catch (err: unknown) {
            const detail = err instanceof Error ? err.message : t('common.unknown_error');
            showNotification(
              `${t('farm.capacity.autoEnrollToggleFailed', {
                defaultValue: '切换自动纳管失败',
              })}: ${detail}`,
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

  return { enabled, loading, submitting, error, reload, requestToggle };
}
