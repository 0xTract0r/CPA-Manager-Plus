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

/** IPv6 文本表示的最大长度（含 IPv4 映射地址）；超过即视为非法形状。 */
const MAX_EXIT_IP_LENGTH = 45;

/** 严格 IPv4：四段 0-255 点分十进制。 */
const IPV4_PATTERN = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/**
 * 粗粒度 IPv6 形状校验：仅十六进制段 / 冒号 / 点（IPv4 尾段），可带 zone id（%eth0）。
 * 目的不是完整 RFC 校验，而是把 exit_ip 约束在合法 IP 字符集内，拒绝任意文本注入。
 */
const isLikelyIpv6 = (value: string): boolean => {
  if (!value.includes(':')) return false;
  const addr = value.split('%')[0] ?? value;
  return /^[0-9A-Fa-f:.]+$/.test(addr) && (addr.match(/:/g)?.length ?? 0) >= 2;
};

/**
 * exit_ip 形状校验：合法 IPv4 / IPv6 且长度合理才算有效。
 * 防止恶意代理在探针响应里回显任意文本冒充出口 IP（如注入脚本 / 命令 / 超长串）。
 */
const isValidExitIpShape = (value: string): boolean => {
  if (value.length > MAX_EXIT_IP_LENGTH) return false;
  return IPV4_PATTERN.test(value) || isLikelyIpv6(value);
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
    const exitIp = typeof resp?.exit_ip === 'string' ? resp.exit_ip : '';
    // exit_ip 形状防御：后端契约里 exit_ip 仅在 ok:true 时非空。若回显了非 IPv4/IPv6 形状
    // （或超长）的 exit_ip，视为无效探测，fail-closed 收敛到 probe_failed 并清空 exitIp，
    // 避免恶意代理把任意文本冒充出口 IP 展示给用户。
    if (exitIp !== '' && !isValidExitIpShape(exitIp)) {
      return { ok: false, exitIp: '', reason: 'probe_failed' };
    }
    return {
      ok: Boolean(resp?.ok),
      exitIp,
      reason: normalizeReason(resp?.reason),
    };
  } catch {
    return { ok: false, exitIp: '', reason: 'probe_failed' };
  }
}
