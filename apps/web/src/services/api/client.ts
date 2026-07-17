/**
 * Axios API 客户端
 * 替代原项目 src/core/api-client.js
 */

import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import type { ApiClientConfig, ApiError } from '@/types';
import {
  BUILD_DATE_HEADER_KEYS,
  CPA_SUPPORT_PLUGIN_HEADER_KEYS,
  REQUEST_TIMEOUT_MS,
  VERSION_HEADER_KEYS
} from '@/utils/constants';
import { computeApiUrl } from '@/utils/connection';
import {
  handleDemoApiRequest,
  handleDemoFormRequest,
  handleDemoRawRequest,
} from '@/features/demo/demoApi';
import { isDemoMode } from '@/features/demo/demoMode';

/**
 * 账号级探测端点：这些端点会拿「被测账号」去请求上游，上游认证失败时后端会把
 * 上游的 401 原样透传为响应状态码。这里的 401 表示「被测账号凭证失效」，而不是
 * 「管理会话过期」，因此不能触发全局登出——账号级失败应由发起该操作的页面就地
 * 处理（展示错误结果），否则测一个坏号就会把整个管理前端登出。
 *
 * 经核对 core 后端（gitlink 9c295240）：仅 POST /auth-files/test-message 会把上游
 * 401 透传成自身 HTTP 401；同类按账号名请求的管理端点（/auth-files/refresh-status
 * 恒 200 包 body、/auth-files/models 只读本地不打上游、account-settings /
 * quota/refresh / provider-tls-probe / oauth-callback / *-auth-url / get-auth-status
 * 均返回 200 或本地业务码）都不透传上游 401，因此不加入本白名单。
 */
const ACCOUNT_LEVEL_PROBE_PATHS = ['/auth-files/test-message'];

/**
 * 判断某次请求 URL 是否属于账号级探测端点。请求拦截器里 baseURL 单独挂在
 * config.baseURL 上，config.url 恒为传入的相对字面量路径（如
 * `/auth-files/test-message`，且该端点不带 query string），所以用精确相等匹配即可。
 * 刻意不做 endsWith 前缀匹配，避免将来出现 `/x/auth-files/test-message` 之类路径被
 * 误豁免，也避免掩盖该端点自身真正的管理鉴权 401。
 */
const isAccountLevelProbeUrl = (url: string | undefined): boolean => {
  if (!url) return false;
  const path = url.split('?')[0];
  return ACCOUNT_LEVEL_PROBE_PATHS.some((probe) => path === probe);
};

class ApiClient {
  private instance: AxiosInstance;
  private apiBase: string = '';
  private managementKey: string = '';

  constructor() {
    this.instance = axios.create({
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json'
      }
    });

    this.setupInterceptors();
  }

  /**
   * 设置 API 配置
   */
  setConfig(config: ApiClientConfig): void {
    this.apiBase = computeApiUrl(config.apiBase);
    this.managementKey = config.managementKey;

    if (config.timeout) {
      this.instance.defaults.timeout = config.timeout;
    } else {
      this.instance.defaults.timeout = REQUEST_TIMEOUT_MS;
    }
  }

  private readHeader(
    headers: Record<string, unknown> | undefined,
    keys: string[]
  ): string | null {
    if (!headers) return null;

    const normalizeValue = (value: unknown): string | null => {
      if (value === undefined || value === null) return null;
      if (Array.isArray(value)) {
        const first = value.find((entry) => entry !== undefined && entry !== null && String(entry).trim());
        return first !== undefined ? String(first) : null;
      }
      const text = String(value);
      return text ? text : null;
    };

    const headerGetter = (headers as { get?: (name: string) => unknown }).get;
    if (typeof headerGetter === 'function') {
      for (const key of keys) {
        const match = normalizeValue(headerGetter.call(headers, key));
        if (match) return match;
      }
    }

    const entries =
      typeof (headers as { entries?: () => Iterable<[string, unknown]> }).entries === 'function'
        ? Array.from((headers as { entries: () => Iterable<[string, unknown]> }).entries())
        : Object.entries(headers);

    const normalized = Object.fromEntries(
      entries.map(([key, value]) => [String(key).toLowerCase(), value])
    );
    for (const key of keys) {
      const match = normalizeValue(normalized[key.toLowerCase()]);
      if (match) return match;
    }
    return null;
  }

  private readBooleanHeader(
    headers: Record<string, unknown> | undefined,
    keys: string[]
  ): boolean | null {
    const value = this.readHeader(headers, keys);
    if (value === null) return null;

    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return null;
  }

  /**
   * 设置请求/响应拦截器
   */
  private setupInterceptors(): void {
    // 请求拦截器
    this.instance.interceptors.request.use(
      (config) => {
        // 设置 baseURL
        config.baseURL = this.apiBase;
        if (config.url) {
          // Normalize deprecated Gemini endpoint to the current path.
          config.url = config.url.replace(/\/generative-language-api-key\b/g, '/gemini-api-key');
        }

        // 添加认证头
        if (this.managementKey) {
          config.headers.Authorization = `Bearer ${this.managementKey}`;
        }

        return config;
      },
      (error) => Promise.reject(this.handleError(error))
    );

    // 响应拦截器
    this.instance.interceptors.response.use(
      (response) => {
        const headers = response.headers as Record<string, string | undefined>;
        const version = this.readHeader(headers, VERSION_HEADER_KEYS);
        const buildDate = this.readHeader(headers, BUILD_DATE_HEADER_KEYS);
        const supportsPlugin = this.readBooleanHeader(headers, CPA_SUPPORT_PLUGIN_HEADER_KEYS);

        // 触发版本更新事件（后续通过 store 处理）
        if (version || buildDate) {
          window.dispatchEvent(
            new CustomEvent('server-version-update', {
              detail: { version: version || null, buildDate: buildDate || null }
            })
          );
        }
        if (supportsPlugin !== null) {
          window.dispatchEvent(
            new CustomEvent('server-plugin-support-update', {
              detail: { supportsPlugin }
            })
          );
        }

        return response;
      },
      (error) => Promise.reject(this.handleError(error))
    );
  }

  /**
   * 错误处理
   */
  private handleError(error: unknown): ApiError {
    const isRecord = (value: unknown): value is Record<string, unknown> =>
      value !== null && typeof value === 'object';

    if (axios.isAxiosError(error)) {
      const responseData: unknown = error.response?.data;
      const responseRecord = isRecord(responseData) ? responseData : null;
      const errorValue = responseRecord?.error;
      const message =
        typeof errorValue === 'string'
          ? errorValue
          : isRecord(errorValue) && typeof errorValue.message === 'string'
            ? errorValue.message
            : typeof responseRecord?.message === 'string'
              ? responseRecord.message
              : error.message || 'Request failed';
      const apiError = new Error(message) as ApiError;
      apiError.name = 'ApiError';
      apiError.status = error.response?.status;
      apiError.code = error.code;
      apiError.details = responseData;
      apiError.data = responseData;

      // 401 未授权 - 触发登出事件。
      // 但账号级探测端点（如测试发送消息）的 401 来自「被测账号」上游认证失败，
      // 不代表管理会话过期，跳过全局登出，交由发起页面就地处理错误。
      if (error.response?.status === 401 && !isAccountLevelProbeUrl(error.config?.url)) {
        window.dispatchEvent(new Event('unauthorized'));
      }

      return apiError;
    }

    const fallbackMessage =
      error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown error occurred';
    const fallback = new Error(fallbackMessage) as ApiError;
    fallback.name = 'ApiError';
    return fallback;
  }

  /**
   * GET 请求
   */
  async get<T = unknown>(url: string, config?: AxiosRequestConfig): Promise<T> {
    if (__DEMO_SITE__ && isDemoMode()) {
      return handleDemoApiRequest<T>('get', url, undefined, config);
    }
    const response = await this.instance.get<T>(url, config);
    return response.data;
  }

  /**
   * POST 请求
   */
  async post<T = unknown>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> {
    if (__DEMO_SITE__ && isDemoMode()) {
      return handleDemoApiRequest<T>('post', url, data, config);
    }
    const response = await this.instance.post<T>(url, data, config);
    return response.data;
  }

  /**
   * PUT 请求
   */
  async put<T = unknown>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> {
    if (__DEMO_SITE__ && isDemoMode()) {
      return handleDemoApiRequest<T>('put', url, data, config);
    }
    const response = await this.instance.put<T>(url, data, config);
    return response.data;
  }

  /**
   * PATCH 请求
   */
  async patch<T = unknown>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> {
    if (__DEMO_SITE__ && isDemoMode()) {
      return handleDemoApiRequest<T>('patch', url, data, config);
    }
    const response = await this.instance.patch<T>(url, data, config);
    return response.data;
  }

  /**
   * DELETE 请求
   */
  async delete<T = unknown>(url: string, config?: AxiosRequestConfig): Promise<T> {
    if (__DEMO_SITE__ && isDemoMode()) {
      return handleDemoApiRequest<T>('delete', url, undefined, config);
    }
    const response = await this.instance.delete<T>(url, config);
    return response.data;
  }

  /**
   * 获取原始响应（用于下载等场景）
   */
  async getRaw(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse> {
    if (__DEMO_SITE__ && isDemoMode()) {
      return handleDemoRawRequest(url, config);
    }
    return this.instance.get(url, config);
  }

  /**
   * 发送 FormData
   */
  async postForm<T = unknown>(
    url: string,
    formData: FormData,
    config?: AxiosRequestConfig
  ): Promise<T> {
    if (__DEMO_SITE__ && isDemoMode()) {
      return handleDemoFormRequest<T>(url, formData, config);
    }
    const response = await this.instance.post<T>(url, formData, {
      ...config,
      headers: {
        ...(config?.headers || {}),
        'Content-Type': 'multipart/form-data'
      }
    });
    return response.data;
  }

  /**
   * 保留对 axios.request 的访问，便于下载等场景
   */
  async requestRaw(config: AxiosRequestConfig): Promise<AxiosResponse> {
    if (__DEMO_SITE__ && isDemoMode()) {
      return handleDemoRawRequest(config.url || '/', config);
    }
    return this.instance.request(config);
  }
}

// 导出单例
export const apiClient = new ApiClient();
