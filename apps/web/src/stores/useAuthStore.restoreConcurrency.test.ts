import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const apiClientSetConfig = vi.fn();
const fetchConfigMock = vi.fn();
const clearConfigCacheMock = vi.fn();
const clearModelsCacheMock = vi.fn();
const usageServiceGetManagerConfigMock = vi.fn();

vi.mock('@/services/api/client', () => ({
  apiClient: {
    setConfig: apiClientSetConfig,
  },
}));

vi.mock('./useConfigStore', () => ({
  useConfigStore: {
    getState: () => ({
      fetchConfig: fetchConfigMock,
      clearCache: clearConfigCacheMock,
    }),
  },
}));

vi.mock('./useModelsStore', () => ({
  useModelsStore: {
    getState: () => ({
      clearCache: clearModelsCacheMock,
    }),
  },
}));

vi.mock('@/services/api/usageService', async () => {
  const actual = await vi.importActual<typeof import('@/services/api/usageService')>(
    '@/services/api/usageService'
  );
  return {
    ...actual,
    usageServiceApi: {
      ...actual.usageServiceApi,
      getManagerConfig: usageServiceGetManagerConfigMock,
    },
  };
});

const createStubWindow = (host = 'cpa.local:8317') => {
  const listeners = new Map<string, Set<EventListener>>();

  return {
    location: { host },
    addEventListener: vi.fn((type: string, listener: EventListener) => {
      if (!listeners.has(type)) {
        listeners.set(type, new Set());
      }
      listeners.get(type)!.add(listener);
    }),
    removeEventListener: vi.fn((type: string, listener: EventListener) => {
      listeners.get(type)?.delete(listener);
    }),
    dispatchEvent: vi.fn((event: Event) => {
      const set = listeners.get(event.type);
      if (set) {
        set.forEach((listener) => listener(event));
      }
      return true;
    }),
  };
};

describe('useAuthStore v1 obfuscation persistence gate and v2 migration', () => {
  let storage: StorageLike;
  const TEST_HOST = 'cpa.local:8317';
  const TEST_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';

  const createV1Blob = (host: string, ua: string, payload: unknown): string => {
    const encoder = new TextEncoder();
    const SECRET_SALT = 'cli-proxy-api-webui::secure-storage';
    const keyBytes = encoder.encode(`${SECRET_SALT}|${host}|${ua}`);
    const data = encoder.encode(JSON.stringify(payload));
    const encrypted = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) {
      encrypted[i] = data[i] ^ keyBytes[i % keyBytes.length];
    }
    let binary = '';
    for (let i = 0; i < encrypted.length; i++) {
      binary += String.fromCharCode(encrypted[i]);
    }
    return 'enc::v1::' + btoa(binary);
  };

  const createV1AuthState = (managementKey = 'correct-management-key') => ({
    state: {
      apiBase: 'http://cpa.local:8317',
      managementKey,
      rememberPassword: true,
      serverVersion: null,
      serverBuildDate: null,
      sessionMode: '',
      sessionPanelBase: '',
    },
    version: 0,
  });

  beforeEach(() => {
    vi.resetModules();
    apiClientSetConfig.mockClear();
    fetchConfigMock.mockReset();
    clearConfigCacheMock.mockClear();
    clearModelsCacheMock.mockClear();
    usageServiceGetManagerConfigMock.mockReset();
    storage = createMemoryStorage();
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('window', createStubWindow(TEST_HOST));
    vi.stubGlobal('navigator', {
      userAgent: TEST_UA,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  for (const replacement of ['login', 'logout'] as const) {
    for (const outcome of ['401', '500', 'success'] as const) {
      it(`134 preserves ${replacement} against late restore ${outcome}`, async () => {
        let resolveA!: (value: unknown) => void;
        let rejectA!: (error: unknown) => void;
        fetchConfigMock.mockImplementationOnce(() => new Promise((resolve, reject) => {
          resolveA = resolve; rejectA = reject;
        })).mockResolvedValue({ models: [] });
        storage.setItem('cli-proxy-auth', createV1Blob(TEST_HOST, TEST_UA, createV1AuthState('old-key-A')));
        storage.setItem('isLoggedIn', 'true');
        const { useAuthStore } = await import('./useAuthStore');
        const restoring = useAuthStore.getState().restoreSession();
        expect(fetchConfigMock).toHaveBeenCalledTimes(1);
        if (replacement === 'login') {
          await useAuthStore.getState().login({
            apiBase: 'http://new.local:8317', managementKey: 'new-key-B', rememberPassword: true,
          });
          expect(useAuthStore.getState().managementKey).toBe('new-key-B');
          expect(storage.getItem('isLoggedIn')).toBe('true');
        } else {
          useAuthStore.getState().logout();
        }
        const before = {
          state: { ...useAuthStore.getState() }, auth: storage.getItem('cli-proxy-auth'), loggedIn: storage.getItem('isLoggedIn'),
        };
        apiClientSetConfig.mockClear();
        if (outcome === 'success') resolveA({ models: [] });
        else rejectA(Object.assign(new Error('late A error'), { status: Number(outcome) }));
        expect(await restoring).toBe(false);
        expect(useAuthStore.getState()).toEqual(before.state);
        expect(storage.getItem('cli-proxy-auth')).toBe(before.auth);
        expect(storage.getItem('isLoggedIn')).toBe(before.loggedIn);
        expect(apiClientSetConfig).not.toHaveBeenCalled();
      });
    }
  }
});
