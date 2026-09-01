/**
 * 代理连通性探针 service。
 *
 * 后端契约（已钉死）：
 *   POST /v0/management/diagnostics/proxy-connectivity-probe
 *   请求体：{ "proxy_url": "<string>" }
 *   响应始终 200 + { "ok": <bool>, "exit_ip": "<string>", "reason": "<string>" }
 *   reason ∈ ok | empty_proxy_url | invalid_proxy_url | dial_failed | timeout | probe_failed
 *   exit_ip 仅在 ok:true 时非空。
 *
 * 基址已含 `/v0/management` 前缀（client.ts 请求拦截器 baseURL=computeApiUrl(apiBase)），
 * 且自动附带 `Authorization: Bearer ${managementKey}`，所以这里只传相对路径即可。
 */
import { apiClient } from './client';

/** 后端返回的 reason 全集（前端归一使用）。 */
export type ProxyProbeReason =
  | 'ok'
  | 'empty_proxy_url'
  | 'invalid_proxy_url'
  | 'dial_failed'
  | 'timeout'
  | 'probe_failed';

const PROXY_PROBE_REASONS: readonly ProxyProbeReason[] = [
  'ok',
  'empty_proxy_url',
  'invalid_proxy_url',
  'dial_failed',
  'timeout',
  'probe_failed',
];

/** 归一化后的探针结果（`exit_ip` → `exitIp`）。 */
export interface ProxyProbeResult {
  ok: boolean;
  exitIp: string;
  reason: ProxyProbeReason;
}

/** 后端原始响应形状（字段名走 snake_case）。 */
interface RawProxyProbeResponse {
  ok?: boolean;
  exit_ip?: string;
  reason?: string;
}

/** 把后端 reason 字符串收敛到已知枚举；未知值一律当作 probe_failed。 */
const normalizeReason = (reason: unknown): ProxyProbeReason => {
  if (typeof reason === 'string' && (PROXY_PROBE_REASONS as readonly string[]).includes(reason)) {
    return reason as ProxyProbeReason;
  }
  return 'probe_failed';
};

/**
 * 调用后端代理连通性探针。
 * - 正常响应：归一化 `exit_ip`→`exitIp`、reason 收敛到枚举。
 * - 网络异常 / 非 200 抛错：兜底成 `{ ok:false, exitIp:'', reason:'probe_failed' }`，
 *   让上层预检始终能拿到确定性结果（不放行、给出可读错误）。
 */
export async function probeProxyConnectivity(proxyUrl: string): Promise<ProxyProbeResult> {
  try {
    const resp = await apiClient.post<RawProxyProbeResponse>(
      '/diagnostics/proxy-connectivity-probe',
      { proxy_url: proxyUrl }
    );
    return {
      ok: Boolean(resp?.ok),
      exitIp: typeof resp?.exit_ip === 'string' ? resp.exit_ip : '',
      reason: normalizeReason(resp?.reason),
    };
  } catch {
    return { ok: false, exitIp: '', reason: 'probe_failed' };
  }
}
