import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 回归测试：农场页零配置改造后 useFarmStore 的默认态、setConfig/clearConfig
 * 语义，以及旧版持久化数据的迁移。
 *
 * - 默认（从未配置过）：orchestratorBaseUrl/farmAdminKey 为空，isConfigured
 *   为 true（同源代理默认即可用，不再是"必须先填地址才能用"的旧门槛）。
 * - setConfig 把 baseUrl/adminKey 灌进 farmClient 单例，并把 isConfigured
 *   直接取自 farmClient.isConfigured()（单一事实来源，不在 store 里重复判定
 *   逻辑）。
 * - clearConfig 退回同源代理默认，isConfigured 恒 true。
 * - 迁移：旧版本持久化下来的 isConfigured=false（当时"从未配置"的默认值）
 *   在 rehydrate 后应按当前 farmClient.isConfigured() 重新计算，不能让陈旧的
 *   持久化布尔值悄悄压制新语义。
 */

type StorageLike = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
  clear: () => void;
};

const createMemoryStorage = (): StorageLike => {
  const store = new Map<string, string>();
  return {
    getItem: (key) => (store.has(key) ? (store.get(key) as string) : null),
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
  };
};

const { mocks } = vi.hoisted(() => ({
  mocks: {
    setConfig: vi.fn(),
    isConfigured: vi.fn(() => true),
  },
}));

vi.mock('@/services/api/farmClient', () => ({
  farmClient: {
    setConfig: mocks.setConfig,
    isConfigured: mocks.isConfigured,
  },
}));

describe('useFarmStore 默认零配置 + 高级覆盖', () => {
  let storage: StorageLike;

  beforeEach(() => {
    vi.resetModules();
    mocks.setConfig.mockClear();
    mocks.isConfigured.mockReset();
    mocks.isConfigured.mockReturnValue(true);
    storage = createMemoryStorage();
    vi.stubGlobal('localStorage', storage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults to same-origin mode: empty override fields and isConfigured=true', async () => {
    const { useFarmStore } = await import('./useFarmStore');

    const state = useFarmStore.getState();
    expect(state.orchestratorBaseUrl).toBe('');
    expect(state.farmAdminKey).toBe('');
    expect(state.isConfigured).toBe(true);
  });

  it('setConfig with both fields pushes the override into farmClient and mirrors farmClient.isConfigured()', async () => {
    mocks.isConfigured.mockReturnValue(true);
    const { useFarmStore } = await import('./useFarmStore');

    useFarmStore.getState().setConfig({
      orchestratorBaseUrl: 'http://127.0.0.1:18517',
      farmAdminKey: 'k',
    });

    expect(mocks.setConfig).toHaveBeenCalledWith({
      baseUrl: 'http://127.0.0.1:18517',
      adminKey: 'k',
    });
    const state = useFarmStore.getState();
    expect(state.orchestratorBaseUrl).toBe('http://127.0.0.1:18517');
    expect(state.farmAdminKey).toBe('k');
    expect(state.isConfigured).toBe(true);
  });

  it('setConfig with a half-filled override mirrors farmClient.isConfigured()=false', async () => {
    mocks.isConfigured.mockReturnValue(false);
    const { useFarmStore } = await import('./useFarmStore');

    useFarmStore.getState().setConfig({
      orchestratorBaseUrl: 'http://127.0.0.1:18517',
      farmAdminKey: '',
    });

    expect(useFarmStore.getState().isConfigured).toBe(false);
  });

  it('clearConfig restores same-origin defaults with isConfigured=true', async () => {
    mocks.isConfigured.mockReturnValueOnce(false).mockReturnValue(true);
    const { useFarmStore } = await import('./useFarmStore');

    useFarmStore.getState().setConfig({ orchestratorBaseUrl: 'http://x', farmAdminKey: '' });
    useFarmStore.getState().clearConfig();

    expect(mocks.setConfig).toHaveBeenLastCalledWith({ baseUrl: '', adminKey: '' });
    const state = useFarmStore.getState();
    expect(state.orchestratorBaseUrl).toBe('');
    expect(state.farmAdminKey).toBe('');
    expect(state.isConfigured).toBe(true);
  });

  it('migrates a stale persisted isConfigured=false back to farmClient.isConfigured() on rehydrate', async () => {
    const { obfuscatedStorage } = await import('@/services/storage/secureStorage');
    const { STORAGE_KEY_FARM } = await import('@/utils/constants');
    // 模拟旧版本代码（改造前默认 isConfigured=false）遗留下来的持久化数据：
    // 从未配置过高级覆盖，但当时的默认值就是 false。
    obfuscatedStorage.setItem(STORAGE_KEY_FARM, {
      state: { orchestratorBaseUrl: '', farmAdminKey: '', isConfigured: false },
      version: 0,
    });
    mocks.isConfigured.mockReturnValue(true);

    const { useFarmStore } = await import('./useFarmStore');
    await useFarmStore.persist.rehydrate();

    expect(useFarmStore.getState().isConfigured).toBe(true);
  });

  it('keeps a persisted, still-valid full override across rehydrate without overwriting it', async () => {
    const { obfuscatedStorage } = await import('@/services/storage/secureStorage');
    const { STORAGE_KEY_FARM } = await import('@/utils/constants');
    obfuscatedStorage.setItem(STORAGE_KEY_FARM, {
      state: {
        orchestratorBaseUrl: 'http://127.0.0.1:18517',
        farmAdminKey: 'k',
        isConfigured: true,
      },
      version: 0,
    });
    mocks.isConfigured.mockReturnValue(true);

    const { useFarmStore } = await import('./useFarmStore');
    await useFarmStore.persist.rehydrate();

    const state = useFarmStore.getState();
    expect(state.orchestratorBaseUrl).toBe('http://127.0.0.1:18517');
    expect(state.farmAdminKey).toBe('k');
    expect(state.isConfigured).toBe(true);
    expect(mocks.setConfig).toHaveBeenCalledWith({
      baseUrl: 'http://127.0.0.1:18517',
      adminKey: 'k',
    });
  });
});
