import { act, useEffect } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthFileItem } from '@/types';
import type { CoreQuotaSnapshotEntry } from '@/services/api/quotaSnapshots';
import { buildCoreQuotaSnapshotLookup } from '@/utils/quota/coreQuotaSnapshots';
import type { QuotaConfig } from './quotaConfigs';
import { QuotaSection } from './QuotaSection';
import { useQuotaLoader } from './useQuotaLoader';

type TestQuotaState = {
  status: 'idle' | 'loading' | 'success' | 'error';
  windows: unknown[];
  error?: string;
  errorStatus?: number;
  failedAtMs?: number;
  rateLimitResetCreditsAvailableCount?: number | null;
  authFileKey?: string;
};

type TestQuotaData = {
  resetCredits: number;
};

const { mocks } = vi.hoisted(() => {
  const quotaStoreState: Record<string, unknown> = {
    codexQuota: {},
  };

  quotaStoreState.setCodexQuota = vi.fn((updater: unknown) => {
    const current = quotaStoreState.codexQuota as Record<string, unknown>;
    quotaStoreState.codexQuota =
      typeof updater === 'function' ? (updater as (prev: typeof current) => typeof current)(current) : updater;
  });

  return {
    mocks: {
      fetchQuota: vi.fn(),
      quotaStoreState,
      resetQuota: vi.fn(),
      showConfirmation: vi.fn(),
      showNotification: vi.fn(),
    },
  };
});

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));

vi.mock('@/hooks/useHeaderRefresh', () => ({
  triggerHeaderRefresh: vi.fn(),
}));

vi.mock('@/stores', () => ({
  useNotificationStore: (selector: (state: unknown) => unknown) =>
    selector({
      showConfirmation: mocks.showConfirmation,
      showNotification: mocks.showNotification,
    }),
  useQuotaStore: (selector: (state: unknown) => unknown) => selector(mocks.quotaStoreState),
  useThemeStore: (selector: (state: unknown) => unknown) => selector({ resolvedTheme: 'light' }),
}));

const FULL_FILE_NAME = 'very-long-account-name@example.com.json';
const MASKED_FILE_NAME = 'ver***@example.com.json';

const testFile: AuthFileItem = {
  name: FULL_FILE_NAME,
  type: 'codex',
};

const successQuota: TestQuotaState = {
  status: 'success',
  windows: [],
  rateLimitResetCreditsAvailableCount: 2,
};

const authScopedSuccessQuota: TestQuotaState & { authFileKey: string } = {
  ...successQuota,
  authFileKey: `${FULL_FILE_NAME}::0`,
};

const getTestAuthFileKey = (file: AuthFileItem): string => `${file.name}::${file.authIndex ?? '-'}`;

const testConfig: QuotaConfig<TestQuotaState, TestQuotaData> = {
  type: 'codex',
  i18nPrefix: 'codex_quota',
  filterFn: () => true,
  fetchQuota: (file, t) => mocks.fetchQuota(file, t) as Promise<TestQuotaData>,
  storeSelector: (state) => state.codexQuota,
  storeSetter: 'setCodexQuota',
  buildLoadingState: () => ({ status: 'loading', windows: [] }),
  buildSuccessState: (data) => ({
    status: 'success',
    windows: [],
    rateLimitResetCreditsAvailableCount: data.resetCredits,
  }),
  buildErrorState: (message, status) => ({
    status: 'error',
    windows: [],
    error: message,
    errorStatus: status,
  }),
  buildFailureState: (message, status, _file, activeState) => ({
    ...(activeState ?? { windows: [] }),
    status: 'error',
    windows: activeState?.windows ?? [],
    error: message,
    errorStatus: status,
    failedAtMs: 1234,
  }),
  cardClassName: 'codex-card',
  controlsClassName: 'codex-controls',
  controlClassName: 'codex-control',
  gridClassName: 'codex-grid',
  resetQuota: (file, t) => mocks.resetQuota(file, t) as Promise<TestQuotaData>,
  canResetQuota: (_file, quota) =>
    quota?.status === 'success' && (quota.rateLimitResetCreditsAvailableCount ?? 0) > 0,
  renderQuotaItems: () => <div>quota loaded</div>,
};

const createScopedTestConfig = (): QuotaConfig<TestQuotaState, TestQuotaData> => ({
  ...testConfig,
  getStoreKey: getTestAuthFileKey,
  buildLoadingState: (file) => ({
    status: 'loading',
    windows: [],
    authFileKey: file ? getTestAuthFileKey(file) : undefined,
  }),
  buildSuccessState: (data, file) => ({
    status: 'success',
    windows: [],
    rateLimitResetCreditsAvailableCount: data.resetCredits,
    authFileKey: file ? getTestAuthFileKey(file) : undefined,
  }),
  buildErrorState: (message, status, file) => ({
    status: 'error',
    windows: [],
    error: message,
    errorStatus: status,
    authFileKey: file ? getTestAuthFileKey(file) : undefined,
  }),
  scopeState: (file, quota) => {
    if (!quota) return undefined;
    if (!quota.authFileKey) return quota;
    return quota.authFileKey === getTestAuthFileKey(file) ? quota : undefined;
  },
});

const getText = (node: ReactTestInstance): string =>
  node.children
    .map((child) => {
      if (typeof child === 'string' || typeof child === 'number') return String(child);
      return getText(child);
    })
    .join('');

const renderSection = (
  options: {
    config?: QuotaConfig<TestQuotaState, TestQuotaData>;
    files?: AuthFileItem[];
  } = {}
) => {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <QuotaSection
        config={options.config ?? testConfig}
        files={options.files ?? [testFile]}
        loading={false}
        disabled={false}
        accountDisplayMode="masked"
      />
    );
  });
  return renderer;
};

const findButtonByText = (renderer: ReactTestRenderer, text: string) => {
  const button = renderer.root.findAllByType('button').find((node) => getText(node).includes(text));
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
};

const findButtonsByText = (renderer: ReactTestRenderer, text: string) =>
  renderer.root.findAllByType('button').filter((node) => getText(node).includes(text));

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

let runLoadQuota:
  | ((targets: AuthFileItem[], setLoading?: (loading: boolean) => void) => Promise<void>)
  | undefined;

function QuotaLoaderHarness({
  config,
  onLoadQuota,
}: {
  config: QuotaConfig<TestQuotaState, TestQuotaData>;
  onLoadQuota: (loadQuota: typeof runLoadQuota) => void;
}) {
  const { loadQuota } = useQuotaLoader(config);
  useEffect(() => {
    onLoadQuota((targets, setLoading = vi.fn()) => loadQuota(targets, 'all', setLoading));
    return () => onLoadQuota(undefined);
  }, [loadQuota, onLoadQuota]);
  return null;
}

describe('QuotaSection account display mode', () => {
  beforeEach(() => {
    mocks.fetchQuota.mockReset();
    mocks.resetQuota.mockReset();
    mocks.showConfirmation.mockReset();
    mocks.showNotification.mockReset();
    mocks.quotaStoreState.codexQuota = {
      [FULL_FILE_NAME]: successQuota,
    };
    (mocks.quotaStoreState.setCodexQuota as ReturnType<typeof vi.fn>).mockClear();
  });

  it('uses masked names in single quota refresh notifications', async () => {
    mocks.fetchQuota.mockResolvedValue({ resetCredits: 1 });
    const renderer = renderSection();

    await act(async () => {
      findButtonByText(renderer, 'codex_quota.refresh_button').props.onClick();
      await Promise.resolve();
    });

    const message = String(mocks.showNotification.mock.calls[0]?.[0] ?? '');
    expect(message).toContain(MASKED_FILE_NAME);
    expect(message).not.toContain(FULL_FILE_NAME);
  });

  it('uses masked names in failed single quota refresh notifications', async () => {
    mocks.fetchQuota.mockRejectedValue(new Error('network failed'));
    const renderer = renderSection();

    await act(async () => {
      findButtonByText(renderer, 'codex_quota.refresh_button').props.onClick();
      await Promise.resolve();
    });

    const message = String(mocks.showNotification.mock.calls[0]?.[0] ?? '');
    expect(message).toContain(MASKED_FILE_NAME);
    expect(message).not.toContain(FULL_FILE_NAME);
  });

  it('keeps previous quota data when a single quota refresh fails', async () => {
    mocks.fetchQuota.mockRejectedValue(new Error('network failed'));
    mocks.quotaStoreState.codexQuota = {
      [FULL_FILE_NAME]: {
        ...successQuota,
        windows: ['api-only-window'],
        rateLimitResetCreditsAvailableCount: 2,
      },
    };
    const renderer = renderSection();

    await act(async () => {
      findButtonByText(renderer, 'codex_quota.refresh_button').props.onClick();
      await Promise.resolve();
    });

    expect(mocks.quotaStoreState.codexQuota).toMatchObject({
      [FULL_FILE_NAME]: {
        status: 'error',
        error: 'network failed',
        windows: ['api-only-window'],
        rateLimitResetCreditsAvailableCount: 2,
        failedAtMs: 1234,
      },
    });
  });

  it('uses masked names in quota reset confirmation and success notification', async () => {
    mocks.resetQuota.mockResolvedValue({ resetCredits: 1 });
    const renderer = renderSection();

    act(() => {
      findButtonByText(renderer, 'codex_quota.reset_action_button').props.onClick();
    });

    const confirmation = mocks.showConfirmation.mock.calls[0]?.[0] as {
      message: string;
      onConfirm: () => Promise<void>;
    };
    expect(confirmation.message).toContain(MASKED_FILE_NAME);
    expect(confirmation.message).not.toContain(FULL_FILE_NAME);

    await act(async () => {
      await confirmation.onConfirm();
    });

    const message = String(mocks.showNotification.mock.calls[0]?.[0] ?? '');
    expect(message).toContain(MASKED_FILE_NAME);
    expect(message).not.toContain(FULL_FILE_NAME);
  });

  it('uses masked names in failed quota reset notifications', async () => {
    mocks.resetQuota.mockRejectedValue(new Error('reset failed'));
    const renderer = renderSection();

    act(() => {
      findButtonByText(renderer, 'codex_quota.reset_action_button').props.onClick();
    });

    const confirmation = mocks.showConfirmation.mock.calls[0]?.[0] as {
      onConfirm: () => Promise<void>;
    };

    await act(async () => {
      await confirmation.onConfirm();
    });

    const message = String(mocks.showNotification.mock.calls[0]?.[0] ?? '');
    expect(message).toContain(MASKED_FILE_NAME);
    expect(message).not.toContain(FULL_FILE_NAME);
  });

  it('keeps previous quota data when quota reset fails', async () => {
    mocks.resetQuota.mockRejectedValue(new Error('reset failed'));
    mocks.quotaStoreState.codexQuota = {
      [FULL_FILE_NAME]: {
        ...successQuota,
        windows: ['api-only-window'],
        rateLimitResetCreditsAvailableCount: 2,
      },
    };
    const renderer = renderSection();

    act(() => {
      findButtonByText(renderer, 'codex_quota.reset_action_button').props.onClick();
    });

    const confirmation = mocks.showConfirmation.mock.calls[0]?.[0] as {
      onConfirm: () => Promise<void>;
    };

    await act(async () => {
      await confirmation.onConfirm();
    });

    expect(mocks.quotaStoreState.codexQuota).toMatchObject({
      [FULL_FILE_NAME]: {
        status: 'error',
        error: 'reset failed',
        windows: ['api-only-window'],
        rateLimitResetCreditsAvailableCount: 2,
        failedAtMs: 1234,
      },
    });
  });

  it('scopes same-name quota cache by auth file identity', () => {
    const scopedConfig = createScopedTestConfig();
    const files: AuthFileItem[] = [
      { ...testFile, authIndex: 0 },
      { ...testFile, authIndex: 1 },
    ];
    mocks.quotaStoreState.codexQuota = {
      [getTestAuthFileKey(files[0])]: authScopedSuccessQuota,
    };

    const renderer = renderSection({ config: scopedConfig, files });

    const quotaItems = renderer.root
      .findAllByType('div')
      .filter((node) => getText(node) === 'quota loaded');
    expect(quotaItems).toHaveLength(1);
    expect(findButtonsByText(renderer, 'codex_quota.reset_action_button')).toHaveLength(1);
  });

  it('stores bulk same-name quota results by auth file identity', async () => {
    const scopedConfig = createScopedTestConfig();
    const files: AuthFileItem[] = [
      { ...testFile, authIndex: 0 },
      { ...testFile, authIndex: 1 },
    ];
    mocks.quotaStoreState.codexQuota = {};
    mocks.fetchQuota.mockImplementation(async (file: AuthFileItem) => ({
      resetCredits: file.authIndex === 0 ? 1 : 2,
    }));

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <QuotaLoaderHarness
          config={scopedConfig}
          onLoadQuota={(nextLoadQuota) => {
            runLoadQuota = nextLoadQuota;
          }}
        />
      );
    });

    await act(async () => {
      await runLoadQuota?.(files);
    });

    expect(mocks.quotaStoreState.codexQuota).toMatchObject({
      [getTestAuthFileKey(files[0])]: {
        status: 'success',
        rateLimitResetCreditsAvailableCount: 1,
        authFileKey: getTestAuthFileKey(files[0]),
      },
      [getTestAuthFileKey(files[1])]: {
        status: 'success',
        rateLimitResetCreditsAvailableCount: 2,
        authFileKey: getTestAuthFileKey(files[1]),
      },
    });
    expect(
      (mocks.quotaStoreState.codexQuota as Record<string, unknown>)[FULL_FILE_NAME]
    ).toBeUndefined();

    act(() => {
      renderer.unmount();
    });
  });

  it('limits bulk quota refresh concurrency', async () => {
    const scopedConfig = createScopedTestConfig();
    const files: AuthFileItem[] = Array.from({ length: 7 }, (_, index) => ({
      ...testFile,
      authIndex: index,
      name: `${index}-${testFile.name}`,
    }));
    const resolvers: Array<() => void> = [];
    let activeRequests = 0;
    let maxActiveRequests = 0;

    mocks.quotaStoreState.codexQuota = {};
    mocks.fetchQuota.mockImplementation(async (file: AuthFileItem) => {
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);

      await new Promise<void>((resolve) => {
        resolvers.push(resolve);
      });

      activeRequests -= 1;
      return { resetCredits: file.authIndex ?? 0 };
    });

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <QuotaLoaderHarness
          config={scopedConfig}
          onLoadQuota={(nextLoadQuota) => {
            runLoadQuota = nextLoadQuota;
          }}
        />
      );
    });

    const loadPromise = runLoadQuota?.(files);
    await act(async () => {
      await flushMicrotasks();
    });

    expect(mocks.fetchQuota).toHaveBeenCalledTimes(4);
    expect(maxActiveRequests).toBe(4);

    while (mocks.fetchQuota.mock.calls.length < files.length) {
      resolvers.shift()?.();
      await act(async () => {
        await flushMicrotasks();
      });
    }

    resolvers.splice(0).forEach((resolve) => resolve());
    await act(async () => {
      await loadPromise;
    });

    expect(maxActiveRequests).toBe(4);
    expect(mocks.fetchQuota).toHaveBeenCalledTimes(files.length);

    act(() => {
      renderer.unmount();
    });
  });

  it('keeps previous scoped quota data when bulk quota refresh fails', async () => {
    const scopedConfig = createScopedTestConfig();
    const files: AuthFileItem[] = [{ ...testFile, authIndex: 0 }];
    const storeKey = getTestAuthFileKey(files[0]);
    mocks.quotaStoreState.codexQuota = {
      [storeKey]: {
        ...authScopedSuccessQuota,
        windows: ['api-only-window'],
        rateLimitResetCreditsAvailableCount: 2,
      },
    };
    mocks.fetchQuota.mockRejectedValue(new Error('bulk failed'));

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <QuotaLoaderHarness
          config={scopedConfig}
          onLoadQuota={(nextLoadQuota) => {
            runLoadQuota = nextLoadQuota;
          }}
        />
      );
    });

    await act(async () => {
      await runLoadQuota?.(files);
    });

    expect(mocks.quotaStoreState.codexQuota).toMatchObject({
      [storeKey]: {
        status: 'error',
        error: 'bulk failed',
        windows: ['api-only-window'],
        rateLimitResetCreditsAvailableCount: 2,
        failedAtMs: 1234,
      },
    });

    act(() => {
      renderer.unmount();
    });
  });
});

describe('QuotaSection core-snapshot observed state on mount', () => {
  beforeEach(() => {
    mocks.fetchQuota.mockReset();
    mocks.resetQuota.mockReset();
    mocks.showConfirmation.mockReset();
    mocks.showNotification.mockReset();
    // active store 为空：display 完全由 core 快照 observed 态驱动，模拟刚进页面。
    mocks.quotaStoreState.codexQuota = {};
    (mocks.quotaStoreState.setCodexQuota as ReturnType<typeof vi.fn>).mockClear();
  });

  const snapshotConfig: QuotaConfig<TestQuotaState, TestQuotaData> = {
    ...testConfig,
    buildObservedStateFromCoreSnapshot: (_file, entry) => {
      if (entry?.status === 'reauth_required') {
        return { status: 'error', windows: [], error: entry.error, errorStatus: 401 };
      }
      if (entry?.status === 'ok') {
        return { status: 'success', windows: [] };
      }
      return undefined;
    },
  };

  const snapshotFile: AuthFileItem = {
    name: 'snapshot@example.com.json',
    type: 'codex',
    auth_id: 'auth-snapshot',
  };

  const renderWithCoreSnapshot = (
    entry: CoreQuotaSnapshotEntry,
    onReauthAccount?: (file: AuthFileItem) => void
  ) => {
    const lookup = buildCoreQuotaSnapshotLookup([entry]);
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <QuotaSection
          config={snapshotConfig}
          files={[snapshotFile]}
          loading={false}
          disabled={false}
          accountDisplayMode="masked"
          coreQuotaSnapshotLookup={lookup}
          onReauthAccount={onReauthAccount}
        />
      );
    });
    return renderer;
  };

  it('renders quota from an ok core snapshot without any upstream fetch', () => {
    const renderer = renderWithCoreSnapshot({
      auth_id: 'auth-snapshot',
      name: snapshotFile.name,
      provider: 'codex',
      status: 'ok',
    });

    const quotaItems = renderer.root
      .findAllByType('div')
      .filter((node) => getText(node) === 'quota loaded');
    expect(quotaItems.length).toBeGreaterThan(0);
    // 硬红线：进页面展示额度全程未打真实上游。
    expect(mocks.fetchQuota).not.toHaveBeenCalled();
  });

  it('surfaces the reauth entry point from a reauth_required core snapshot without any upstream fetch', () => {
    const onReauth = vi.fn();
    const renderer = renderWithCoreSnapshot(
      {
        auth_id: 'auth-snapshot',
        name: snapshotFile.name,
        provider: 'codex',
        status: 'reauth_required',
        error: 'credential unauthorized',
      },
      onReauth
    );

    const reauthButton = findButtonByText(renderer, 'codex_reauth.button');
    act(() => {
      reauthButton.props.onClick();
    });
    expect(onReauth).toHaveBeenCalledTimes(1);
    // 硬红线：mount 到显示「要求重新认证」全程未打真实上游。
    expect(mocks.fetchQuota).not.toHaveBeenCalled();
  });
});
