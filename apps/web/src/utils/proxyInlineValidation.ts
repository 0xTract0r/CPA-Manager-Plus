/**
 * 代理输入框「内联实时校验」的共享状态机与触发逻辑。
 *
 * 目标：把原本埋在「提交按钮点击」里的代理校验，提到代理输入框失焦（blur）时就地触发，
 * 并把「验证过程 + 结果」直接展示在输入框旁：
 *   - 格式校验（L0，同步、不触网）复用 `validateProxyUrlFormat`；
 *   - 查重（L2，本地秒级）复用调用方注入的 `findProxyDuplicateUsage`；
 *   - 连通性探针（L1，慢）复用 `runProxyPreflight`；
 *   - 顺序恒为 L0 → L2 → L1。
 *
 * 查重是「软提醒」不是门禁：命中只把占用情况（账号数 + 账号名）挂在结果的 `duplicate` 上、
 * 生成就地警告文案 `warning`，照常继续跑连通性探针；最终 ok / invalid 只由格式与探针决定。
 * 提交（开始 OAuth / 保存）时再由调用方用 `requestProxyDuplicateConfirmation` 弹框确认。
 *
 * 本模块保持框架无关（不依赖 React / 具体 i18n 实例）：i18n 文案由调用方通过 `translate` /
 * `duplicateWarning` / `t` 注入，返回的 `message` / `warning` 恒为可直接展示的字符串。
 */
import {
  runProxyPreflight,
  validateProxyUrlFormat,
  PROXY_PREFLIGHT_FALLBACK_MESSAGES,
  EMPTY_PROXY_DUPLICATE_USAGE,
  type ProxyDuplicateUsage,
} from './proxyPreflight';
import type { ProxyProbeReason, ProxyProbeResult } from '@/services/api/proxyProbe';

/** 内联校验的四态：未校验 / 校验中 / 不合格 / 已连通。 */
export type ProxyInlinePhase = 'idle' | 'checking' | 'invalid' | 'ok';

/** 「校验中」的细分阶段：查重 / 连通性探针（用于就地展示更精确的过程文案）。 */
export type ProxyInlineStage = 'dedup' | 'probe';

export interface ProxyInlineValidationState {
  phase: ProxyInlinePhase;
  /** 仅 phase==='checking' 时有意义：当前处于查重还是连通性探针阶段。 */
  stage?: ProxyInlineStage;
  /** invalid 时的错误文案；ok 时的成功文案（均已本地化，可直接展示）。 */
  message?: string;
  /** ok 且真正做过探针时的出口 IP；未变更放行 / 未探针时为空串。 */
  exitIp?: string;
  /** 本状态对应的、已去首尾空白的被校验值；用于缓存去重（同值不重复探针）与提交门控。 */
  checkedValue?: string;
  /**
   * 查重结果（软提醒）：已占用该代理的同类型账号数 + 展示名。未查重 / 无占用时缺省。
   * 不影响 phase；提交时据此弹框确认。
   */
  duplicate?: ProxyDuplicateUsage;
  /** 查重命中时的就地警告文案（已本地化，含占用账号数与账号名）；无占用时缺省。 */
  warning?: string;
}

/** 未校验初始态（常量，避免重复分配）。 */
export const PROXY_INLINE_IDLE: ProxyInlineValidationState = { phase: 'idle' };

/** 同步格式预检结果：空 / 非法 / 通过。 */
export type ProxyInlineFormatPrecheck = 'empty' | 'invalid' | 'valid';

/**
 * 同步格式预检（不触网）。供 blur 处理器先分流：
 *   - empty → 由调用方按语义决定（必填入口不就地报错、只在提交时拦；置回 idle）；
 *   - invalid → 立即就地标红「代理格式非法」，不进网络；
 *   - valid → 进入查重 + 连通性探针。
 */
export function precheckProxyInlineFormat(proxyUrl: string): ProxyInlineFormatPrecheck {
  const format = validateProxyUrlFormat(proxyUrl);
  if (format.valid) return 'valid';
  return format.reason === 'empty' ? 'empty' : 'invalid';
}

/** 阶段回调附带的上下文（进入探针阶段时带上查重结果）。 */
export interface ProxyInlineStageContext {
  duplicate?: ProxyDuplicateUsage;
  warning?: string;
}

export interface RunProxyInlineChecksParams {
  proxyUrl: string;
  /** i18n 文案解析：传 reason 返回本地化字符串；返回空则回退中文字面。 */
  translate?: (reason: ProxyProbeReason) => string | undefined;
  /**
   * L2 查重：返回占用该代理的同类型账号情况（count=0 表示无占用）。允许同步或异步。
   * 抛错视为「查重列表不可用」→ 降级跳过查重、继续连通性探针。
   */
  checkDuplicate: (proxyUrl: string) => Promise<ProxyDuplicateUsage> | ProxyDuplicateUsage;
  /** 查重命中时的就地警告文案构造（含占用账号数与账号名）。 */
  duplicateWarning: (usage: ProxyDuplicateUsage) => string;
  /**
   * 阶段回调：进入查重 / 探针阶段时通知调用方更新「验证中」的细分文案。
   * 进入探针阶段时一并带上查重结果，便于探针跑的同时就地先展示占用警告。
   */
  onStage?: (stage: ProxyInlineStage, context?: ProxyInlineStageContext) => void;
  /** 探针实现（默认真实 probeProxyConnectivity，经 runProxyPreflight 调用）；便于测试注入。 */
  probe?: (proxyUrl: string) => Promise<ProxyProbeResult>;
}

/**
 * 格式已过后的内联校验：L2 查重（软提醒）→ L1 连通性探针，返回归一的 invalid / ok 状态。
 * 查重命中不再判 invalid：结果带上 `duplicate` + `warning`，phase 仍由探针决定。
 * 调用前应先用 `precheckProxyInlineFormat` 处理空 / 格式非法，避免无谓的「验证中」闪烁与触网。
 */
export async function runProxyInlineChecks(
  params: RunProxyInlineChecksParams
): Promise<ProxyInlineValidationState> {
  const trimmed = (params.proxyUrl || '').trim();
  if (!trimmed) return PROXY_INLINE_IDLE;

  // L2 查重（本地秒级）。列表不可用（抛错）时降级跳过；命中只记录占用情况，不阻断。
  params.onStage?.('dedup');
  let duplicate: ProxyDuplicateUsage = EMPTY_PROXY_DUPLICATE_USAGE;
  try {
    duplicate = (await params.checkDuplicate(trimmed)) ?? EMPTY_PROXY_DUPLICATE_USAGE;
  } catch {
    duplicate = EMPTY_PROXY_DUPLICATE_USAGE;
  }
  const duplicateFields: ProxyInlineStageContext =
    duplicate.count > 0 ? { duplicate, warning: params.duplicateWarning(duplicate) } : {};

  // L1 连通性探针。格式已在 precheck 阶段通过，这里跳过重复格式校验。
  params.onStage?.('probe', duplicateFields);
  const preflight = await runProxyPreflight(trimmed, {
    formatValidator: () => ({ valid: true }),
    translate: params.translate,
    probe: params.probe,
  });
  if (!preflight.ok) {
    return {
      phase: 'invalid',
      message: preflight.message,
      checkedValue: trimmed,
      ...duplicateFields,
    };
  }
  return {
    phase: 'ok',
    message: preflight.message,
    exitIp: preflight.exitIp,
    checkedValue: trimmed,
    ...duplicateFields,
  };
}

/** 文案解析函数的最小签名（兼容 react-i18next 的 t）。 */
export type ProxyDuplicateTranslate = (key: string, options?: Record<string, unknown>) => string;

/** 查重相关文案 key（就地警告 / 确认框）。 */
export const PROXY_DUPLICATE_I18N = {
  warning: 'proxy_preflight.duplicate_account',
  separator: 'proxy_preflight.duplicate_account_separator',
  confirmTitle: 'proxy_preflight.duplicate_confirm_title',
  confirmMessage: 'proxy_preflight.duplicate_confirm_message',
  confirmOk: 'proxy_preflight.duplicate_confirm_ok',
  cancel: 'common.cancel',
} as const;

/** 把占用账号展示名按当前语言的分隔符拼接（中文「、」，其它语言「, 」）。 */
const joinDuplicateLabels = (t: ProxyDuplicateTranslate, usage: ProxyDuplicateUsage): string =>
  usage.labels.join(t(PROXY_DUPLICATE_I18N.separator, { defaultValue: '、' }));

/** 就地警告文案：「该代理已被 N 个账号使用：A、B」（按 count 走复数形式）。 */
export function formatProxyDuplicateWarning(
  t: ProxyDuplicateTranslate,
  usage: ProxyDuplicateUsage
): string {
  return t(PROXY_DUPLICATE_I18N.warning, {
    count: usage.count,
    accounts: joinDuplicateLabels(t, usage),
  });
}

/** 确认框选项的最小形态（与 useNotificationStore.showConfirmation 入参兼容）。 */
export interface ProxyDuplicateConfirmationRequest {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: 'danger' | 'primary' | 'secondary';
  onConfirm: () => void;
  onCancel?: () => void;
}

/**
 * 代理被占用时的提交前确认：弹确认框（文案含占用账号数与账号名），返回用户是否确认继续。
 *   - 确认 → resolve(true)，调用方照原流程继续（开始 OAuth / 保存）；
 *   - 取消 / 关闭确认框 → resolve(false)，调用方停在原地、不发请求。
 * 无占用（count=0 / 缺省）直接 resolve(true)，不弹框。
 */
export function requestProxyDuplicateConfirmation(
  showConfirmation: (options: ProxyDuplicateConfirmationRequest) => void,
  t: ProxyDuplicateTranslate,
  usage: ProxyDuplicateUsage | undefined
): Promise<boolean> {
  if (!usage || usage.count <= 0) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    showConfirmation({
      title: t(PROXY_DUPLICATE_I18N.confirmTitle),
      message: t(PROXY_DUPLICATE_I18N.confirmMessage, {
        count: usage.count,
        accounts: joinDuplicateLabels(t, usage),
      }),
      confirmText: t(PROXY_DUPLICATE_I18N.confirmOk),
      cancelText: t(PROXY_DUPLICATE_I18N.cancel),
      variant: 'primary',
      onConfirm: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
}

/**
 * 判断某个内联校验状态是否「已针对当前值校验通过」。
 * 用于提交门控：ok 且 checkedValue 与当前去空白值逐字符相同 → 直接放行，不再重跑探针。
 */
export function isProxyInlineValidatedOk(
  state: ProxyInlineValidationState | undefined,
  proxyUrl: string
): boolean {
  if (!state || state.phase !== 'ok') return false;
  return state.checkedValue === (proxyUrl || '').trim();
}

/**
 * 判断某个内联校验状态是否「正在针对当前值校验中」。
 * 用于提交门控：校验中 → 拦住并提示「代理验证中，请稍候」，不放行。
 */
export function isProxyInlineChecking(
  state: ProxyInlineValidationState | undefined,
  proxyUrl: string
): boolean {
  if (!state || state.phase !== 'checking') return false;
  return state.checkedValue === (proxyUrl || '').trim();
}

/**
 * 判断某个内联校验状态是否「已针对当前值校验失败」。
 * 用于提交门控：失败（格式非法 / 连通失败）→ 拦住并高亮（错误已就地展示），不放行、也不重跑探针。
 * 查重命中不会进入 invalid（只是软提醒）。
 */
export function isProxyInlineInvalid(
  state: ProxyInlineValidationState | undefined,
  proxyUrl: string
): boolean {
  if (!state || state.phase !== 'invalid') return false;
  return state.checkedValue === (proxyUrl || '').trim();
}

/** 无 i18n / i18n 缺 key 时，格式非法的中文回退文案。 */
export const PROXY_INLINE_INVALID_FORMAT_FALLBACK =
  PROXY_PREFLIGHT_FALLBACK_MESSAGES.invalid_proxy_url;
