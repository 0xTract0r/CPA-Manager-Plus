/**
 * 农场编排器（Device Farm）独立 Axios 客户端
 *
 * 农场编排器是一个独立后端服务（services/farm-orchestrator），不是 CPA 的一部分：
 * - base URL 独立配置（编排器地址，不是 CPA 的 apiBase，也不拼 /v0/management 前缀）
 * - 鉴权独立：编排器要求 `Authorization: Bearer <FARM_MGMT_KEY>`
 *   （见 services/farm-orchestrator/internal/httpapi/middleware.go），
 *   与 CPA 的 managementKey 无关，不能共用 `@/services/api/client` 单例。
 * - 401 语义不同：单例 apiClient 遇 401 会 dispatch `unauthorized` 触发整个
 *   管理前端登出（见 client.ts）。农场编排器故障或 admin key 配错只应该让
 *   农场页面本身报错，绝不能把整个 CPA 管理会话登出——因此这里刻意不接入
 *   `unauthorized` 事件，错误只通过 Promise reject 交回调用方就地处理。
 */

import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import type { ApiError } from '@/types';
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
        if (this.adminKey) {
          config.headers.Authorization = `Bearer ${this.adminKey}`;
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

  isConfigured(): boolean {
    return Boolean(this.baseUrl && this.adminKey);
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
