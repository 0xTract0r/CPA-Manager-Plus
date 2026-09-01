/**
 * 代理输入统一预检 helper。
 *
 * 目标：凡是填代理的地方，保存 / 下一步前先做「格式校验 + 后端连通性探针」，双过才放行。
 * 流程 = 先跑格式校验（各入口复用自己已有的 validateProxyUrl 语义）→ 格式过再调
 * probeProxyConnectivity → 返回归一结果 { ok, exitIp, reason, message }。
 *
 * message 是给用户看的中文错误 / 提示；有 i18n 就走传入的 translate，没有就回退中文字面
 * （与周边入口文案一致）。
 */
import {
  probeProxyConnectivity,
  type ProxyProbeReason,
  type ProxyProbeResult,
} from '@/services/api/proxyProbe';

/** 允许的代理 scheme（与各入口现有 validateProxyUrl 保持一致）。 */
const PROXY_URL_ALLOWED_SCHEMES = new Set(['http', 'https', 'socks5', 'socks5h']);

/** 格式校验结果：valid=false 时 reason 区分「未填」与「格式非法」。 */
export interface ProxyFormatCheck {
  valid: boolean;
  reason?: 'empty' | 'invalid';
}

/**
 * 通用代理格式校验（http/https/socks5/socks5h）。
 * 空串按 `empty` 处理，交由调用方决定语义（必填入口拦截 / 可选入口跳过）。
 */
export const validateProxyUrlFormat = (proxyUrl: string): ProxyFormatCheck => {
  const trimmed = (proxyUrl || '').trim();
  if (!trimmed) {
    return { valid: false, reason: 'empty' };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, reason: 'invalid' };
  }
  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
  if (!PROXY_URL_ALLOWED_SCHEMES.has(scheme) || !parsed.hostname) {
    return { valid: false, reason: 'invalid' };
  }
  return { valid: true };
};

/** reason → 中文回退文案（无 i18n / i18n 缺 key 时使用）。 */
export const PROXY_PREFLIGHT_FALLBACK_MESSAGES: Record<ProxyProbeReason, string> = {
  ok: '连通正常',
  empty_proxy_url: '请填写代理',
  invalid_proxy_url: '代理格式非法',
  dial_failed: '无法经该代理连通',
  timeout: '连通超时',
  probe_failed: '探测失败，请重试',
};

/** 预检归一结果。message 恒为可直接展示的字符串。 */
export interface ProxyPreflightResult {
  ok: boolean;
  exitIp: string;
  reason: ProxyProbeReason;
  message: string;
}

export interface RunProxyPreflightOptions {
  /** 格式校验器：复用各入口已有的 validateProxyUrl 语义。默认走通用 validateProxyUrlFormat。 */
  formatValidator?: (proxyUrl: string) => ProxyFormatCheck;
  /** i18n 文案解析：传 reason 返回本地化字符串；返回空则回退中文字面。 */
  translate?: (reason: ProxyProbeReason) => string | undefined;
  /** 探针实现（默认真实 probeProxyConnectivity）；便于测试注入。 */
  probe?: (proxyUrl: string) => Promise<ProxyProbeResult>;
}

const resolveMessage = (
  reason: ProxyProbeReason,
  translate?: (reason: ProxyProbeReason) => string | undefined
): string => {
  const localized = translate?.(reason);
  if (localized) return localized;
  return PROXY_PREFLIGHT_FALLBACK_MESSAGES[reason];
};

/**
 * 单个代理地址的完整预检：格式校验 → 连通性探针。
 * 格式不过：直接返回 empty/invalid，不触网。
 * 格式过：调探针，把 ok / exitIp / reason 一并归一返回。
 */
export async function runProxyPreflight(
  proxyUrl: string,
  options: RunProxyPreflightOptions = {}
): Promise<ProxyPreflightResult> {
  const formatValidator = options.formatValidator ?? validateProxyUrlFormat;
  const format = formatValidator(proxyUrl);
  if (!format.valid) {
    const reason: ProxyProbeReason =
      format.reason === 'empty' ? 'empty_proxy_url' : 'invalid_proxy_url';
    return { ok: false, exitIp: '', reason, message: resolveMessage(reason, options.translate) };
  }

  const probeFn = options.probe ?? probeProxyConnectivity;
  const probe = await probeFn(proxyUrl.trim());
  return {
    ok: probe.ok,
    exitIp: probe.exitIp,
    reason: probe.reason,
    message: resolveMessage(probe.reason, options.translate),
  };
}

/**
 * 保存/认证前的单代理预检门禁（可选代理入口用）。
 * - 空串 → 直接放行（passed:true），由调用方语义决定是否需要代理。
 * - 非空 → 先触发 onProbeStart（用于置探测中 loading 态、禁用保存按钮），跑预检，
 *   不过则回调 onFail(message) 并返回 passed:false，过则返回 passed:true。
 */
export async function ensureProxyReachableForSave(params: {
  proxyUrl: string;
  translate?: (reason: ProxyProbeReason) => string | undefined;
  onProbeStart?: () => void;
  onFail: (message: string, result: ProxyPreflightResult) => void;
  probe?: (proxyUrl: string) => Promise<ProxyProbeResult>;
}): Promise<{ passed: boolean; result?: ProxyPreflightResult }> {
  const trimmed = (params.proxyUrl || '').trim();
  if (!trimmed) return { passed: true };

  params.onProbeStart?.();
  const result = await runProxyPreflight(trimmed, {
    translate: params.translate,
    probe: params.probe,
  });
  if (!result.ok) {
    params.onFail(result.message, result);
    return { passed: false, result };
  }
  return { passed: true, result };
}

/**
 * 批量代理预检（OpenAI 多 key entry 每个可带独立代理）。
 * 只探非空项，遇到第一个不过即回调 onFail(message, index) 并短路返回 false。
 */
export async function ensureProxiesReachableForSave(params: {
  proxyUrls: string[];
  translate?: (reason: ProxyProbeReason) => string | undefined;
  onProbeStart?: () => void;
  onFail: (message: string, index: number, result: ProxyPreflightResult) => void;
  probe?: (proxyUrl: string) => Promise<ProxyProbeResult>;
}): Promise<boolean> {
  const targets = params.proxyUrls
    .map((url, index) => ({ url: (url || '').trim(), index }))
    .filter((target) => target.url);
  if (targets.length === 0) return true;

  params.onProbeStart?.();
  for (const target of targets) {
    const result = await runProxyPreflight(target.url, {
      translate: params.translate,
      probe: params.probe,
    });
    if (!result.ok) {
      params.onFail(result.message, target.index, result);
      return false;
    }
  }
  return true;
}
