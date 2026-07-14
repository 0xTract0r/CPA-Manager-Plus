/**
 * OAuth 与设备码登录相关 API
 */

import { apiClient } from './client';

export type BuiltInOAuthProvider =
  | 'codex'
  | 'anthropic'
  | 'antigravity'
  | 'kimi'
  | 'xai';
export type OAuthProvider = BuiltInOAuthProvider | (string & {});

export interface OAuthStartResponse {
  url: string;
  state?: string;
  // core -auth-url 系列接口返回授权链接过期时间：expires_in_seconds（如 900）与 ISO8601 的 expires_at。
  // 前端据此渲染倒计时；两者任一存在即可，优先用 expires_at 的绝对时间。
  expires_in_seconds?: number;
  expires_at?: string;
}

export type OAuthSessionStatus = 'ok' | 'wait' | 'error' | 'cancelled';

export interface OAuthStatusResponse {
  status: OAuthSessionStatus;
  error?: string;
  provider?: string;
  // 后端完成态字段：见 core CompleteOAuthSessionWithRecord / oauthSessionResultForRecord。
  saved_path?: string;
  auth_name?: string;
  note?: string;
  proxy_url?: string;
}

export interface OAuthCancelResponse {
  status: 'ok' | 'error';
  cancelled?: boolean;
  error?: string;
}

export interface OAuthCallbackResponse {
  status: 'ok';
}

const WEBUI_SUPPORTED: string[] = ['codex', 'anthropic', 'antigravity', 'xai'];

export const isOAuthCancelSuccessful = (response: OAuthCancelResponse) =>
  response.status === 'ok' && response.cancelled !== false;

export const oauthApi = {
  startAuth: (provider: OAuthProvider, options?: { note?: string; proxyUrl?: string }) => {
    const params: Record<string, string | boolean> = {};
    if (WEBUI_SUPPORTED.includes(provider)) {
      params.is_webui = true;
    }
    if (options?.note) {
      params.note = options.note;
    }
    if (options?.proxyUrl) {
      params.proxy_url = options.proxyUrl;
    }
    return apiClient.get<OAuthStartResponse>(`/${provider}-auth-url`, {
      params: Object.keys(params).length ? params : undefined,
    });
  },

  getAuthStatus: (state: string) =>
    apiClient.get<OAuthStatusResponse>(`/get-auth-status`, {
      params: { state },
    }),

  cancelAuth: (state: string) =>
    apiClient.delete<OAuthCancelResponse>('/oauth-session', {
      params: { state },
    }),

  submitCallback: (provider: OAuthProvider, redirectUrl: string) => {
    return apiClient.post<OAuthCallbackResponse>('/oauth-callback', {
      provider,
      redirect_url: redirectUrl,
    });
  },
};
