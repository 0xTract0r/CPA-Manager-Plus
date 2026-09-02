/**
 * 代理输入框「内联实时校验」的共享状态机与触发逻辑。
 *
 * 目标：把原本埋在「提交按钮点击」里的代理校验，提到代理输入框失焦（blur）时就地触发，
 * 并把「验证过程 + 结果」直接展示在输入框旁。校验判定规则本身不变——只改触发时机与展示位置：
 *   - 格式校验（L0，同步、不触网）复用 `validateProxyUrlFormat`；
 *   - 查重（L2，本地秒级）复用调用方注入的 `findAccountsUsingProxy`；
 *   - 连通性探针（L1，慢）复用 `runProxyPreflight`；
 *   - 顺序恒为 L0 → L2 → L1（L2 先于 L1 fail-fast），与既有提交路径一致。
 *
 * 本模块保持框架无关（不依赖 React / i18n）：i18n 文案由调用方通过 `translate` /
 * `duplicateMessage` 注入，返回的 `message` 恒为可直接展示的字符串。
 */
import {
  runProxyPreflight,
  validateProxyUrlFormat,
  PROXY_PREFLIGHT_FALLBACK_MESSAGES,
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

export interface RunProxyInlineChecksParams {
  proxyUrl: string;
  /** i18n 文案解析：传 reason 返回本地化字符串；返回空则回退中文字面。 */
  translate?: (reason: ProxyProbeReason) => string | undefined;
  /**
   * L2 查重：返回冲突账号展示名列表（空数组=无冲突）。允许同步或异步。
   * 抛错视为「查重列表不可用」→ 降级跳过查重、继续连通性探针（与既有提交路径的降级一致）。
   */
  checkDuplicate: (proxyUrl: string) => Promise<string[]> | string[];
  /** 命中查重时的本地化文案构造（含冲突账号名）。 */
  duplicateMessage: (accounts: string[]) => string;
  /** 阶段回调：进入查重 / 探针阶段时通知调用方更新「验证中」的细分文案。 */
  onStage?: (stage: ProxyInlineStage) => void;
  /** 探针实现（默认真实 probeProxyConnectivity，经 runProxyPreflight 调用）；便于测试注入。 */
  probe?: (proxyUrl: string) => Promise<ProxyProbeResult>;
}

/**
 * 格式已过后的内联校验：L2 查重 → L1 连通性探针，返回归一的 invalid / ok 状态。
 * 调用前应先用 `precheckProxyInlineFormat` 处理空 / 格式非法，避免无谓的「验证中」闪烁与触网。
 */
export async function runProxyInlineChecks(
  params: RunProxyInlineChecksParams
): Promise<ProxyInlineValidationState> {
  const trimmed = (params.proxyUrl || '').trim();
  if (!trimmed) return PROXY_INLINE_IDLE;

  // L2 查重（本地秒级，先于慢的连通性探针 fail-fast）。列表不可用（抛错）时降级跳过。
  params.onStage?.('dedup');
  let conflicts: string[] = [];
  try {
    conflicts = await params.checkDuplicate(trimmed);
  } catch {
    conflicts = [];
  }
  if (conflicts.length > 0) {
    return { phase: 'invalid', message: params.duplicateMessage(conflicts), checkedValue: trimmed };
  }

  // L1 连通性探针。格式已在 precheck 阶段通过，这里跳过重复格式校验。
  params.onStage?.('probe');
  const preflight = await runProxyPreflight(trimmed, {
    formatValidator: () => ({ valid: true }),
    translate: params.translate,
    probe: params.probe,
  });
  if (!preflight.ok) {
    return { phase: 'invalid', message: preflight.message, checkedValue: trimmed };
  }
  return {
    phase: 'ok',
    message: preflight.message,
    exitIp: preflight.exitIp,
    checkedValue: trimmed,
  };
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
 * 用于提交门控：失败 → 拦住并高亮（错误已就地展示），不放行、也不重跑探针。
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
