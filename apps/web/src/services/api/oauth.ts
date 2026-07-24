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

const WEBUI_SUPPORTED: string[] = ['codex', 'anthropic', 'antigravity', 'gemini-cli', 'xai'];

// core 的 OAuth 回调接口对 gemini 使用 `gemini` 作为 provider 名，而认证文件 /
// auth-url 端点用的是 `gemini-cli`。提交回调时需要把 provider 归一化过去，
// 与旧版 apps/web 保持一致，避免 gemini 重认证回调 provider 不匹配而失败。
const CALLBACK_PROVIDER_MAP: Record<string, string> = {
  'gemini-cli': 'gemini',
};

export const isOAuthCancelSuccessful = (response: OAuthCancelResponse) =>
  response.status === 'ok' && response.cancelled !== false;

export const oauthApi = {
  startAuth: (
    provider: OAuthProvider,
    options?: { note?: string; proxyUrl?: string; authName?: string; projectId?: string }
  ) => {
    const params: Record<string, string | boolean> = {};
    if (WEBUI_SUPPORTED.includes(provider)) {
      params.is_webui = true;
    }
    // gemini 重认证需要 project_id 指向对应的 GCP 项目；仅 gemini-cli 端点使用。
    if (provider === 'gemini-cli' && options?.projectId) {
      params.project_id = options.projectId;
    }
    // auth_name 让 core 把重认证结果落回目标认证文件：anthropic 直接按 auth_name
    // 覆盖；其余 OAuth provider（codex/gemini/xai/antigravity）由 core 在 OAuth 完成
    // 后按账号身份覆盖同名文件（真机需验证落到正确账号，不误建新号）。
    if (options?.authName) {
      params.auth_name = options.authName;
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
    const callbackProvider = CALLBACK_PROVIDER_MAP[provider] ?? provider;
    return apiClient.post<OAuthCallbackResponse>('/oauth-callback', {
      provider: callbackProvider,
      redirect_url: redirectUrl,
    });
  },
};
