import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { farmApi } from '@/services/api/farm';
import type { FarmApiError } from '@/services/api/farmClient';
import { useNotificationStore } from '@/stores';
import type { FarmRotateProxyRequest, FarmRotateProxyResponse } from '@/types/farm';

export interface UseFarmRotateProxyResult {
  /** 当前是否有换代理请求在途（同一时刻只支持一个），调用方可用来禁用触发控件。 */
  rotating: boolean;
  /**
   * 发起 POST /api/farm/rotate-proxy。`confirm` 由本 hook 强制写死 true——O1
   * 「绝不未确认自动换」已经由调用方的二次确认弹窗完成，这里只负责把已确认的
   * 请求发出去，调用方不需要也不应该自己传 confirm。
   * 成功返回响应体并 toast 成功；失败按 businessCode 精确匹配已知错误码分支
   * toast 可读文案，返回 null（不 throw——调用方按 `result` 是否为 null 判断
   * 是否继续后续动作，例如账号设置弹窗只在轮换成功后才真正保存 proxy_url）。
   */
  rotateProxy: (
    request: Omit<FarmRotateProxyRequest, 'confirm'>
  ) => Promise<FarmRotateProxyResponse | null>;
}

// 轮换失败机器码 → 可读提示 i18n key（farm.rotate.error_*，foundation 已在
// en/zh-CN/zh-TW/ru 四语言 locale 就绪）。fail-closed 无可用代理时后端复用
// onboard 的 no_available_proxy（非本端点独有码，见 types/farm.ts
// FarmRotationErrorCode 顶部注释：「轮换错误处理需同时覆盖该码」），故一并列入。
// 未命中已知码时落回通用 farm.rotate.error 文案，不臆造未定义的错误分支。
const ROTATE_ERROR_MESSAGE_KEY: Record<string, string> = {
  not_farm_account: 'farm.rotate.error_not_farm_account',
  not_claude_provider: 'farm.rotate.error_not_claude_provider',
  provider_unverifiable: 'farm.rotate.error_provider_unverifiable',
  proxy_change_required: 'farm.rotate.error_proxy_change_required',
  proxy_unchanged: 'farm.rotate.error_proxy_unchanged',
  no_available_proxy: 'farm.rotate.error_no_available_proxy',
};

/**
 * 代理轮换（POST /api/farm/rotate-proxy，rotation.go handleRotateProxy）action
 * hook。照搬 useFarmBindings.ts / useFarmRetire.ts 的「状态 + action +
 * showNotification」范式，但**不**像它们那样在 hook 内部持有 showConfirmation：
 * §2 换代理的二次确认文案（新建容器 / 新 device_id / 旧容器退役 / fail-closed
 * 窗口 / 保卷宽限）挂在具体调用场景（例如账号设置弹窗改 proxy_url 并保存），
 * 不适合在这个通用 action hook 里写死；确认后调用方才会调这里的 rotateProxy。
 *
 * §2 严格 gate（isClaudeProvider && farmBound===true，不是
 * isClaudeManagedPolicy——codex 必须排除在容器动作之外）同样由调用方负责：
 * 本 hook 不重复判断账号是否够资格触发容器动作，只负责发起已确认的请求、
 * 按 businessCode 精确匹配错误分支并 toast 结果；后端 rotation.go 仍会按
 * FarmRotationErrorCode 做服务端兜底校验（not_farm_account /
 * not_claude_provider / provider_unverifiable 等），前端 gate 失手时不会
 * 真的越权换到非农场 Claude 账号或 codex 账号头上。
 */
export function useFarmRotateProxy(): UseFarmRotateProxyResult {
  const { t } = useTranslation();
  const { showNotification } = useNotificationStore();
  const [rotating, setRotating] = useState(false);

  const rotateProxy = useCallback(
    async (
      request: Omit<FarmRotateProxyRequest, 'confirm'>
    ): Promise<FarmRotateProxyResponse | null> => {
      setRotating(true);
      try {
        const resp = await farmApi.rotateProxy({ ...request, confirm: true });
        // farm.rotate.success 是完整模板句（占位符是 {{account}}，不是 {{id}}——
        // 与 useFarmBindings/useFarmRetire 那种「短标签 + 手写 id」的 key 设计不同，
        // 四语言 locale 已经把「新容器/新 device_id/旧容器 superseded」写进句子本身，
        // 这里不需要也不应该再手写一遍）。resp.detail 是可选的额外后端说明（例如
        // superseded=false 时旧容器退役失败的原因），模板之外单独追加。
        const successMessage = `${t('farm.rotate.success', { account: resp.account || request.account_id })}${
          resp.detail ? ` ${resp.detail}` : ''
        }`;
        showNotification(successMessage, 'success');
        return resp;
      } catch (err: unknown) {
        const farmError = err as Partial<FarmApiError>;
        const rawMessage = err instanceof Error ? err.message : '';
        // 机器码来自响应体独立 `code` 字段（farmClient 解析进 businessCode），
        // 不对 message 自由文本做子串匹配，呼应 useFarmOnboard 既有做法。
        const businessCode =
          typeof farmError.businessCode === 'string' ? farmError.businessCode : undefined;
        const messageKey = businessCode ? ROTATE_ERROR_MESSAGE_KEY[businessCode] : undefined;
        // farm.rotate.error 同样是模板句（占位符 {{message}}），未命中已知
        // businessCode 时落回它、把原始错误文本喂给占位符，而不是裸拼接。
        const message = messageKey
          ? t(messageKey)
          : t('farm.rotate.error', { message: rawMessage || t('common.unknown_error') });
        showNotification(message, 'error');
        return null;
      } finally {
        setRotating(false);
      }
    },
    [showNotification, t]
  );

  return { rotating, rotateProxy };
}
