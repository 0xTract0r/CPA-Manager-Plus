import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 回归测试：账号级探测端点（如「测试发送消息」）返回 401 时，不应触发全局
 * 'unauthorized' 登出事件——该 401 来自「被测账号」上游认证失败，不代表管理
 * 会话过期。历史上 cpamp 从旧版 apps/web 移植 client.ts 时曾丢失
 * ACCOUNT_LEVEL_PROBE_PATHS 白名单，导致无条件 401 → dispatch('unauthorized')，
 * 使得测一个被封禁/失效的账号就会把整个管理前端登出。
 *
 * 这里直接 mock `axios` 模块本身，捕获 ApiClient 注册的响应拦截器错误处理
 * 分支，从而演练真实的 handleError 逻辑（含 isAccountLevelProbeUrl 判断），
 * 而不是在测试里重新实现一遍白名单规则。
 */

type InterceptorHandlers = {
  onFulfilled: (value: unknown) => unknown;
  onRejected: (error: unknown) => unknown;
};

const requestInterceptors: InterceptorHandlers[] = [];
const responseInterceptors: InterceptorHandlers[] = [];

vi.mock('axios', () => {
  const isAxiosError = (value: unknown): value is { response?: unknown; config?: unknown } =>
    Boolean(value && typeof value === 'object' && (value as { isAxiosError?: boolean }).isAxiosError);

  const mockAxiosInstance = {
    defaults: { timeout: 0 },
    interceptors: {
      request: {
        use: (onFulfilled: InterceptorHandlers['onFulfilled'], onRejected: InterceptorHandlers['onRejected']) => {
          requestInterceptors.push({ onFulfilled, onRejected });
        }
      },
      response: {
        use: (onFulfilled: InterceptorHandlers['onFulfilled'], onRejected: InterceptorHandlers['onRejected']) => {
          responseInterceptors.push({ onFulfilled, onRejected });
        }
      }
    },
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    request: vi.fn()
  };

  return {
    default: {
      create: vi.fn(() => mockAxiosInstance),
      isAxiosError
    }
  };
});

vi.mock('@/features/demo/demoMode', () => ({
  isDemoMode: () => false
}));

// client.ts 顶层直接 import 了 demoApi 的三个 handler；真实 demoApi 模块又会在顶层
// 加载 demoFixtures（引用 demoMode 的 DEMO_API_BASE 常量）。由于上面已经把整个
// demoMode 模块 mock 掉（只保留 isDemoMode），若不隔离 demoApi，模块加载阶段就会
// 因缺失 DEMO_API_BASE 报错。这些 handler 本身只在 isDemoMode() 为 true 时才会被
// client.ts 调用，测试里恒为 false，因此可以安全地整体 mock 掉。
vi.mock('@/features/demo/demoApi', () => ({
  handleDemoApiRequest: vi.fn(),
  handleDemoFormRequest: vi.fn(),
  handleDemoRawRequest: vi.fn()
}));

describe('apiClient 401 unauthorized dispatch whitelist', () => {
  let dispatchEventSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    requestInterceptors.length = 0;
    responseInterceptors.length = 0;
    dispatchEventSpy = vi.fn();
    // 本项目 vitest 默认 node 环境（未配 jsdom），全局 window 不存在，
    // 用 vi.stubGlobal 提供最小 mock，而非依赖真实 DOM 的 window.dispatchEvent。
    vi.stubGlobal('window', {
      dispatchEvent: dispatchEventSpy
    });
    // 触发模块初始化，注册拦截器
    await import('./client');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const makeAxiosError = (url: string, status = 401) => ({
    isAxiosError: true,
    message: 'Request failed with status code 401',
    config: { url },
    response: { status, data: { error: 'unauthorized' } }
  });

  const runResponseErrorInterceptor = (error: unknown) => {
    const [{ onRejected }] = responseInterceptors;
    expect(onRejected).toBeDefined();
    // onRejected 声明类型是 (error: unknown) => unknown，但运行时实际返回被拒绝的
    // Promise（handleError 内部 reject 出去），这里显式包一层 Promise.resolve 以获得
    // 可 .catch() 的类型，而不改变真实运行时行为。
    return Promise.resolve(onRejected(error)).catch(() => {
      // handleError 把错误 reject 出去是预期行为，这里只关心副作用（dispatchEvent）
    });
  };

  it('does NOT dispatch unauthorized when /auth-files/test-message returns 401', async () => {
    await runResponseErrorInterceptor(makeAxiosError('/auth-files/test-message'));

    const dispatchedEventTypes = dispatchEventSpy.mock.calls.map(([event]) => (event as Event).type);
    expect(dispatchedEventTypes).not.toContain('unauthorized');
  });

  it('still dispatches unauthorized for a normal management endpoint 401', async () => {
    await runResponseErrorInterceptor(makeAxiosError('/auth-files'));

    const dispatchedEventTypes = dispatchEventSpy.mock.calls.map(([event]) => (event as Event).type);
    expect(dispatchedEventTypes).toContain('unauthorized');
  });

  it('does not treat a path merely containing the probe suffix as whitelisted', async () => {
    await runResponseErrorInterceptor(makeAxiosError('/x/auth-files/test-message'));

    const dispatchedEventTypes = dispatchEventSpy.mock.calls.map(([event]) => (event as Event).type);
    expect(dispatchedEventTypes).toContain('unauthorized');
  });

  it('ignores query string when matching the probe path', async () => {
    await runResponseErrorInterceptor(makeAxiosError('/auth-files/test-message?foo=bar'));

    const dispatchedEventTypes = dispatchEventSpy.mock.calls.map(([event]) => (event as Event).type);
    expect(dispatchedEventTypes).not.toContain('unauthorized');
  });

  it('still dispatches unauthorized for non-401 status on the probe endpoint (no-op)', async () => {
    // 500 场景下拦截器根本不应该走 dispatch 分支（无论端点），确保白名单只影响 401 判断
    await runResponseErrorInterceptor(makeAxiosError('/auth-files/test-message', 500));

    const dispatchedEventTypes = dispatchEventSpy.mock.calls.map(([event]) => (event as Event).type);
    expect(dispatchedEventTypes).not.toContain('unauthorized');
  });
});
