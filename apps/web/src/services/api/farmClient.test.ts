import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 回归测试：farm 页零配置改造后 farmClient 的两条鉴权路径。
 *
 * - 默认零配置（未设置高级覆盖 adminKey）：baseURL 留空（同源相对路径），
 *   Authorization 带当前 cpamp 会话的 managementKey。
 * - 高级覆盖模式（operator 显式填了 base URL + admin key）：baseURL 换成覆盖
 *   地址，Authorization 改带覆盖 adminKey，且不与会话 managementKey 叠加
 *   （二选一，不同时发送两个 key）。
 * - isConfigured() 的三态语义：同源默认 true；覆盖两项都填 true；覆盖只填
 *   一项（半覆盖态）false——防止未来改动悄悄把「同源默认即可用」的零配置
 *   前提改回旧版「必须先填地址才能用」。
 *
 * 与 client.test.ts 相同的手法：直接 mock `axios` 模块本身，捕获 FarmApiClient
 * 构造函数里注册的请求拦截器，演练真实拦截器逻辑，而不是在测试里重新实现一遍
 * bearer key 选择规则。
 */

type InterceptorHandlers = {
  onFulfilled: (value: unknown) => unknown;
  onRejected: (error: unknown) => unknown;
};

const requestInterceptors: InterceptorHandlers[] = [];

vi.mock('axios', () => {
  const isAxiosError = (value: unknown): value is { response?: unknown; config?: unknown } =>
    Boolean(value && typeof value === 'object' && (value as { isAxiosError?: boolean }).isAxiosError);

  const mockAxiosInstance = {
    interceptors: {
      request: {
        use: (onFulfilled: InterceptorHandlers['onFulfilled'], onRejected: InterceptorHandlers['onRejected']) => {
          requestInterceptors.push({ onFulfilled, onRejected });
        },
      },
      response: {
        use: () => {},
      },
    },
    get: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
  };

  return {
    default: {
      create: vi.fn(() => mockAxiosInstance),
      isAxiosError,
    },
  };
});

const { mocks } = vi.hoisted(() => ({
  mocks: { managementKey: '' as string },
}));

vi.mock('@/stores/useAuthStore', () => ({
  useAuthStore: {
    getState: () => ({ managementKey: mocks.managementKey }),
  },
}));

describe('farmClient 零配置默认 + 高级覆盖', () => {
  beforeEach(() => {
    vi.resetModules();
    requestInterceptors.length = 0;
    mocks.managementKey = '';
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const runRequestInterceptor = (config: { headers: Record<string, unknown> } = { headers: {} }) => {
    const [{ onFulfilled }] = requestInterceptors;
    expect(onFulfilled).toBeDefined();
    return onFulfilled(config) as typeof config & { baseURL?: string };
  };

  it('defaults to same-origin (empty baseURL) and isConfigured=true with no override set', async () => {
    const { farmClient } = await import('./farmClient');

    expect(farmClient.isConfigured()).toBe(true);
    const result = runRequestInterceptor();
    expect(result.baseURL).toBe('');
  });

  it('attaches the cpamp session managementKey as Bearer when no override adminKey is set', async () => {
    mocks.managementKey = 'session-key-123';
    await import('./farmClient');

    const result = runRequestInterceptor();
    expect(result.headers.Authorization).toBe('Bearer session-key-123');
  });

  it('sends no Authorization header when there is neither a session key nor an override', async () => {
    await import('./farmClient');

    const result = runRequestInterceptor();
    expect(result.headers.Authorization).toBeUndefined();
  });

  it('prefers the advanced override adminKey over the session managementKey, and does not stack both', async () => {
    mocks.managementKey = 'session-key-123';
    const { farmClient } = await import('./farmClient');

    farmClient.setConfig({ baseUrl: 'http://127.0.0.1:18517', adminKey: 'override-key' });
    const result = runRequestInterceptor();

    expect(result.baseURL).toBe('http://127.0.0.1:18517');
    expect(result.headers.Authorization).toBe('Bearer override-key');
  });

  it('isConfigured() is true once both override baseUrl and adminKey are set', async () => {
    const { farmClient } = await import('./farmClient');

    farmClient.setConfig({ baseUrl: 'http://127.0.0.1:18517', adminKey: 'k' });

    expect(farmClient.isConfigured()).toBe(true);
  });

  it('isConfigured() is false for a half-filled override (base URL only)', async () => {
    const { farmClient } = await import('./farmClient');

    farmClient.setConfig({ baseUrl: 'http://127.0.0.1:18517', adminKey: '' });

    expect(farmClient.isConfigured()).toBe(false);
  });

  it('isConfigured() is false for a half-filled override (admin key only)', async () => {
    const { farmClient } = await import('./farmClient');

    farmClient.setConfig({ baseUrl: '', adminKey: 'k' });

    expect(farmClient.isConfigured()).toBe(false);
  });

  it('clearing the override (both fields empty again) restores same-origin default with isConfigured=true', async () => {
    const { farmClient } = await import('./farmClient');

    farmClient.setConfig({ baseUrl: 'http://127.0.0.1:18517', adminKey: 'k' });
    farmClient.setConfig({ baseUrl: '', adminKey: '' });

    expect(farmClient.isConfigured()).toBe(true);
    const result = runRequestInterceptor();
    expect(result.baseURL).toBe('');
  });
});
