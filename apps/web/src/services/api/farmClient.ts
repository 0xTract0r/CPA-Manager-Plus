/**
 * 农场编排器（Device Farm）独立 Axios 客户端
 *
 * 默认零配置：base URL 留空（''），axios 拼出的请求 URL 就是相对路径
 * `/api/farm/*`（见 services/api/farm.ts），天然打向当前管理前端同源——由
 * manager-server 反代到真正的农场编排器后端，operator 不需要手填地址。
 * 鉴权同样分两档：
 * - 默认零配置模式（未设置高级覆盖 adminKey）：请求带当前 cpamp 会话的
 *   `managementKey` 作为 `Authorization: Bearer`（见 useAuthStore.ts），交由
 *   同源反代身后的农场 handler 校验调用方身份。
 * - 高级覆盖模式（operator 在 FarmConfigPanel 显式填了 base URL + admin
 *   key，要直连另一个独立编排器实例）：改带覆盖 adminKey 作为 Bearer
 *   （编排器自身鉴权见 services/farm-orchestrator/internal/httpapi/
 *   middleware.go 的 `FARM_MGMT_KEY` 校验），与 cpamp 会话 managementKey 无关。
 * - 401 语义不同：单例 apiClient 遇 401 会 dispatch `unauthorized` 触发整个
 *   管理前端登出（见 client.ts）。农场编排器故障或 admin key 配错只应该让
 *   农场页面本身报错，绝不能把整个 CPA 管理会话登出——因此这里刻意不接入
 *   `unauthorized` 事件，错误只通过 Promise reject 交回调用方就地处理。
 */

import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import type { ApiError } from '@/types';
import { useAuthStore } from '@/stores/useAuthStore';
import { FARM_REQUEST_TIMEOUT_MS } from '@/utils/constants';

export interface FarmClientConfig {
  baseUrl: string;
  adminKey: string;
}

// 农场编排器错误对象：`code` 字段沿用 ApiError 既有约定（axios 网络层错误码，
// 如 'ECONNABORTED'，见 client.ts / LoginPage.tsx 用法），不能被后端业务机器码
// 覆盖。onboard 端点（P0-6）失败响应体是独立形状
// `onboardErrorResponse{ error(自由文本), code(机器码) }`（dto.go），因此这里
// 用单独的 `businessCode` 字段把响应体里的 `code` 原样带出，调用方（如
// useFarmOnboard）按 businessCode 做精确分支，不必再去 message 文本里子串匹配。
export type FarmApiError = ApiError & { businessCode?: string };

const handleFarmError = (error: unknown): FarmApiError => {
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object';

  if (axios.isAxiosError(error)) {
    const responseData: unknown = error.response?.data;
    const responseRecord = isRecord(responseData) ? responseData : null;
    const message =
      typeof responseRecord?.error === 'string'
        ? responseRecord.error
        : error.message || 'Farm orchestrator request failed';
    const apiError = new Error(message) as FarmApiError;
    apiError.name = 'FarmApiError';
    apiError.status = error.response?.status;
    apiError.code = error.code;
    apiError.details = responseData;
    apiError.data = responseData;
    if (typeof responseRecord?.code === 'string') {
      apiError.businessCode = responseRecord.code;
    }
    return apiError;
  }

  const fallbackMessage =
    error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown farm orchestrator error';
  const fallback = new Error(fallbackMessage) as FarmApiError;
  fallback.name = 'FarmApiError';
  return fallback;
};

class FarmApiClient {
  private instance: AxiosInstance;
  private baseUrl = '';
  private adminKey = '';

  constructor() {
    this.instance = axios.create({
      timeout: FARM_REQUEST_TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    this.instance.interceptors.request.use(
      (config) => {
        config.baseURL = this.baseUrl;
        // 高级覆盖 adminKey 优先；否则回落到当前 cpamp 会话的 managementKey，
        // 使默认零配置模式下打向同源 /api/farm/* 的请求也带有效身份。两种模式
        // 二选一，不叠加发送。
        const bearerKey = this.adminKey || useAuthStore.getState().managementKey;
        if (bearerKey) {
          config.headers.Authorization = `Bearer ${bearerKey}`;
        }
        return config;
      },
      (error) => Promise.reject(handleFarmError(error))
    );

    this.instance.interceptors.response.use(
      (response) => response,
      // 刻意不在这里 dispatch 全局 `unauthorized` 事件：农场编排器 401
      // （admin key 配错/失效）只代表这一个独立后端不可用，不代表 CPA
      // 管理会话过期，不能把整个前端登出。
      (error) => Promise.reject(handleFarmError(error))
    );
  }

  setConfig(config: FarmClientConfig): void {
    this.baseUrl = (config.baseUrl || '').replace(/\/+$/, '');
    this.adminKey = config.adminKey || '';
  }

  /**
   * 默认零配置模式（baseUrl / adminKey 均未覆盖）始终视为"已就绪"——请求打同源
   * `/api/farm/*`，鉴权走 cpamp 会话 managementKey，不需要 operator 手填任何值。
   * 高级覆盖模式下要求 baseUrl 与 adminKey 同时填齐，缺一视为未就绪（避免半覆盖
   * 态悄悄把请求打到错误地址、或带错的 Bearer key）。
   */
  isConfigured(): boolean {
    const hasOverride = Boolean(this.baseUrl) || Boolean(this.adminKey);
    return hasOverride ? Boolean(this.baseUrl && this.adminKey) : true;
  }

  async get<T = unknown>(url: string, config?: AxiosRequestConfig): Promise<T> {
    const response = await this.instance.get<T>(url, config);
    return response.data;
  }

  async post<T = unknown>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> {
    const response = await this.instance.post<T>(url, data, config);
    return response.data;
  }

  async delete<T = unknown>(url: string, config?: AxiosRequestConfig): Promise<T> {
    const response = await this.instance.delete<T>(url, config);
    return response.data;
  }
}

// 导出单例，独立于 `@/services/api/client` 的 CPA apiClient 单例。
export const farmClient = new FarmApiClient();
