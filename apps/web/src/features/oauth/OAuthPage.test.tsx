import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { OAuthPage } from './OAuthPage';
import {
  isOAuthProviderAttemptCurrent,
  isOAuthPollingScopeCurrent,
  resolvePluginOAuthProviderId,
  shouldShowPluginOAuthProvider,
} from './oauthProviderHelpers';

const { pageMocks } = vi.hoisted(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  return {
    pageMocks: {
      apiBase: 'http://cpa-a.local:8317',
      managementKey: 'manager-key',
      location: {
        pathname: '/oauth',
        search: '?accountReauth=session-a',
        hash: '',
      },
      startAuth: vi.fn(),
      getAuthStatus: vi.fn(),
      submitCallback: vi.fn(),
      authFilesList: vi.fn(),
      showNotification: vi.fn(),
      completeReauth: vi.fn(),
      publishMutationRevision: vi.fn(),
    },
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('react-router-dom', () => ({
  useLocation: () => pageMocks.location,
  useNavigate: () => vi.fn(),
}));

vi.mock('@/stores', () => {
  const readAuthState = () => ({
    connectionStatus: 'connected' as const,
    apiBase: pageMocks.apiBase,
    managementKey: pageMocks.managementKey,
    supportsPlugin: false,
  });
  const useAuthStore = Object.assign(
    (selector: (state: ReturnType<typeof readAuthState>) => unknown) => selector(readAuthState()),
    { getState: readAuthState }
  );

  return {
    publishAccountCredentialMutationRevision: pageMocks.publishMutationRevision,
    useAuthStore,
    useNotificationStore: () => ({ showNotification: pageMocks.showNotification }),
    useThemeStore: (selector: (state: { resolvedTheme: 'light' }) => unknown) =>
      selector({ resolvedTheme: 'light' }),
  };
});

vi.mock('@/services/api', () => ({
  oauthApi: {
    startAuth: pageMocks.startAuth,
    getAuthStatus: pageMocks.getAuthStatus,
    submitCallback: pageMocks.submitCallback,
  },
  authFilesApi: {
    list: pageMocks.authFilesList,
  },
  pluginsApi: {
    list: vi.fn(async () => ({ plugins: [] })),
  },
}));

vi.mock('@/services/api/vertex', () => ({
  vertexApi: { importCredential: vi.fn() },
}));

vi.mock('@/utils/clipboard', () => ({
  copyToClipboard: vi.fn(async () => true),
}));

vi.mock('@/features/plugins/pluginResources', () => ({
  getPluginTitle: () => 'Plugin',
  resolvePluginAssetURL: () => '',
}));

vi.mock('@/features/monitoring/codexInspection', () => ({
  createCodexInspectionConnectionFingerprint: (apiBase: string, managementKey: string) =>
    `${apiBase}:${managementKey}`,
}));

vi.mock('@/features/accounts/model/accountReauthSession', () => ({
  completeAccountOAuthReauthSessionFromSearch: pageMocks.completeReauth,
  readAccountOAuthReauthSessionId: (search: string) =>
    new URLSearchParams(search).get('accountReauth'),
}));

const createDeferred = <T,>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
};

const readText = (value: unknown): string => {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(readText).join('');
  if (value && typeof value === 'object' && 'props' in value) {
    return readText((value as { props?: { children?: unknown } }).props?.children);
  }
  return '';
};

const findCodexOAuthButton = (renderer: ReactTestRenderer) => {
  const button = renderer.root
    .findAllByType(Button)
    .find((node) => readText(node.props.children) === 'auth_login.codex_oauth_button');
  if (!button) throw new Error('Codex OAuth button not found');
  return button;
};

const findCallbackButton = (renderer: ReactTestRenderer) => {
  const button = renderer.root
    .findAllByType(Button)
    .find((node) => readText(node.props.children) === 'auth_login.oauth_callback_button');
  if (!button) throw new Error('OAuth callback button not found');
  return button;
};

describe('OAuthPage request lifecycle', () => {
  let renderer: ReactTestRenderer | null = null;

  beforeEach(() => {
    pageMocks.apiBase = 'http://cpa-a.local:8317';
    pageMocks.managementKey = 'manager-key';
    pageMocks.location = {
      pathname: '/oauth',
      search: '?accountReauth=session-a',
      hash: '',
    };
    pageMocks.startAuth.mockReset();
    pageMocks.getAuthStatus.mockReset();
    pageMocks.submitCallback.mockReset();
    pageMocks.authFilesList.mockReset();
    pageMocks.authFilesList.mockResolvedValue({ files: [] });
    pageMocks.showNotification.mockReset();
    pageMocks.completeReauth.mockReset();
    pageMocks.publishMutationRevision.mockReset();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('window', {
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      },
      cancelAnimationFrame: vi.fn(),
      setInterval: vi.fn(() => 1),
      clearInterval: vi.fn(),
      setTimeout: vi.fn(() => 1),
      clearTimeout: vi.fn(),
      open: vi.fn(),
    });
  });

  afterEach(async () => {
    if (renderer) {
      await act(async () => renderer?.unmount());
      renderer = null;
    }
    vi.unstubAllGlobals();
  });

  it('discards a late start response and clears loading after the connection changes', async () => {
    const deferred = createDeferred<{ url: string; state: string }>();
    pageMocks.startAuth.mockReturnValueOnce(deferred.promise);

    await act(async () => {
      renderer = create(<OAuthPage />);
      await Promise.resolve();
    });

    await act(async () => {
      void findCodexOAuthButton(renderer!).props.onClick();
      await Promise.resolve();
    });
    expect(findCodexOAuthButton(renderer!).props.loading).toBe(true);

    pageMocks.apiBase = 'http://cpa-b.local:8317';
    await act(async () => {
      renderer!.update(<OAuthPage />);
      await Promise.resolve();
    });
    expect(findCodexOAuthButton(renderer!).props.loading).toBeFalsy();

    await act(async () => {
      deferred.resolve({ url: 'https://oauth.example/old', state: 'old-state' });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(readText(renderer!.toJSON())).not.toContain('https://oauth.example/old');
    expect(pageMocks.getAuthStatus).not.toHaveBeenCalled();
  });

  it('associates an empty standard callback with the field and announces request errors separately', async () => {
    pageMocks.location.search = '';
    pageMocks.startAuth.mockResolvedValueOnce({
      url: 'https://oauth.example/fixture',
      state: 'fixture-state',
    });
    const focus = vi.fn();
    const getElementById = vi.fn(() => ({ focus }));
    vi.stubGlobal('document', { getElementById });
    await act(async () => {
      renderer = create(<OAuthPage />);
    });
    await act(async () => {
      await findCodexOAuthButton(renderer!).props.onClick();
    });

    const field = () => {
      const node = renderer!.root.findAllByType(Input)
        .find((input) => input.props.label === 'auth_login.oauth_callback_label');
      if (!node) throw new Error('OAuth callback input not found');
      return node.findByType('input');
    };
    const region = () => renderer!.root.findByProps({ role: 'status', 'aria-atomic': 'true' });

    expect(readText(region())).toBe('');
    await act(async () => {
      await findCallbackButton(renderer!).props.onClick();
    });
    expect(pageMocks.submitCallback).not.toHaveBeenCalled();
    expect(field().props['aria-invalid']).toBe(true);
    const errorID = field().props['aria-describedby'].split(' ').find((id: string) => id.endsWith('-error'));
    expect(readText(renderer!.root.findByProps({ id: errorID }))).toBe('auth_login.oauth_callback_required');
    expect(getElementById).toHaveBeenCalledWith(field().props.id);
    expect(focus).toHaveBeenCalledOnce();
    expect(readText(region())).toBe('');

    await act(async () => {
      field().props.onChange({ target: { value: 'http://127.0.0.1/callback?code=synthetic&state=fixture-state' } });
    });
    expect(field().props['aria-invalid']).not.toBe(true);
    pageMocks.submitCallback.mockRejectedValueOnce(new Error('Synthetic request failure'));
    await act(async () => {
      await findCallbackButton(renderer!).props.onClick();
    });
    expect(pageMocks.submitCallback).toHaveBeenCalledOnce();
    expect(field().props['aria-invalid']).not.toBe(true);
    expect(readText(region())).toContain('auth_login.oauth_callback_status_error');
    expect(readText(region())).toContain('Synthetic request failure');
    expect(pageMocks.showNotification).not.toHaveBeenCalled();
    expect(focus).toHaveBeenCalledOnce();
  });

  it.each(['connection change', 'new attempt'])(
    'does not leave focus pending for the next callback form after a %s',
    async (transition) => {
      pageMocks.location.search = '';
      pageMocks.startAuth
        .mockResolvedValueOnce({ url: 'https://oauth.example/first', state: 'first-state' })
        .mockResolvedValueOnce({ url: 'https://oauth.example/second', state: 'second-state' });
      const frames: FrameRequestCallback[] = [];
      window.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => frames.push(callback));
      const oldFocus = vi.fn();
      const newFocus = vi.fn();
      let currentInput = { focus: oldFocus };
      vi.stubGlobal('document', { getElementById: vi.fn(() => currentInput) });

      await act(async () => {
        renderer = create(<OAuthPage />);
      });
      await act(async () => {
        await findCodexOAuthButton(renderer!).props.onClick();
      });
      await act(async () => {
        await findCallbackButton(renderer!).props.onClick();
      });

      if (transition === 'connection change') {
        pageMocks.apiBase = 'http://cpa-b.local:8317';
        await act(async () => renderer!.update(<OAuthPage />));
      }
      await act(async () => {
        await findCodexOAuthButton(renderer!).props.onClick();
      });
      expect(pageMocks.startAuth).toHaveBeenCalledTimes(2);
      expect(renderer!.root.findAllByType('div').some(
        (node) => node.props.children === 'https://oauth.example/second'
      )).toBe(true);
      expect(findCallbackButton(renderer!)).toBeDefined();
      currentInput = { focus: newFocus };
      for (const frame of frames) frame(1);

      expect(newFocus).not.toHaveBeenCalled();
      expect(oldFocus).toHaveBeenCalledOnce();
      expect(pageMocks.submitCallback).not.toHaveBeenCalled();
    }
  );

  it('discards a late callback response after the connection changes', async () => {
    const callbackDeferred = createDeferred<void>();
    pageMocks.startAuth.mockResolvedValueOnce({
      url: 'https://oauth.example/current',
      state: 'current-state',
    });
    pageMocks.submitCallback.mockReturnValueOnce(callbackDeferred.promise);

    await act(async () => {
      renderer = create(<OAuthPage />);
      await Promise.resolve();
    });
    await act(async () => {
      await findCodexOAuthButton(renderer!).props.onClick();
      await Promise.resolve();
    });

    const callbackInput = renderer!.root
      .findAllByType(Input)
      .find((node) => node.props.label === 'auth_login.oauth_callback_label');
    if (!callbackInput) throw new Error('OAuth callback input not found');
    await act(async () => {
      callbackInput.props.onChange({
        target: { value: 'http://127.0.0.1/callback?code=code&state=current-state' },
      });
      await Promise.resolve();
    });
    let callbackPromise!: Promise<void>;
    act(() => {
      callbackPromise = Promise.resolve(findCallbackButton(renderer!).props.onClick());
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(pageMocks.submitCallback).toHaveBeenCalledTimes(1);
    expect(findCallbackButton(renderer!).props.loading).toBe(true);

    pageMocks.apiBase = 'http://cpa-b.local:8317';
    await act(async () => {
      renderer!.update(<OAuthPage />);
      await Promise.resolve();
    });
    expect(
      renderer!.root
        .findAllByType(Button)
        .some((node) => readText(node.props.children) === 'auth_login.oauth_callback_button')
    ).toBe(false);

    await act(async () => {
      callbackDeferred.resolve();
      await callbackPromise;
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(pageMocks.showNotification).not.toHaveBeenCalledWith(
      'auth_login.oauth_callback_success',
      'success'
    );
  });
});

const builtInProviderIds = new Set(['codex', 'anthropic', 'antigravity', 'kimi', 'xai', 'devin', 'meta']);

describe('plugin OAuth provider helpers', () => {
  it('uses explicit plugin OAuth provider ids when present', () => {
    expect(resolvePluginOAuthProviderId({ id: 'legacy-plugin', oauthProvider: 'custom' })).toBe(
      'custom'
    );
    expect(resolvePluginOAuthProviderId({ id: 'legacy-plugin' })).toBe('legacy-plugin');
  });

  it('hides plugin OAuth entries that resolve to built-in providers', () => {
    expect(
      shouldShowPluginOAuthProvider(
        {
          id: 'custom-plugin',
          oauthProvider: 'codex',
          supportsOAuth: true,
        },
        builtInProviderIds
      )
    ).toBe(false);
    expect(
      shouldShowPluginOAuthProvider(
        {
          id: 'custom-plugin',
          oauthProvider: 'devin',
          supportsOAuth: true,
        },
        builtInProviderIds
      )
    ).toBe(false);
    expect(
      shouldShowPluginOAuthProvider(
        {
          id: 'custom-plugin',
          oauthProvider: 'meta',
          supportsOAuth: true,
        },
        builtInProviderIds
      )
    ).toBe(false);
    expect(
      shouldShowPluginOAuthProvider(
        {
          id: 'custom-plugin',
          oauthProvider: 'custom-provider',
          supportsOAuth: true,
        },
        builtInProviderIds
      )
    ).toBe(true);
  });

  it('invalidates an OAuth polling attempt after its connection or reauth session changes', () => {
    const started = {
      connectionFingerprint: 'connection-a',
      accountReauthSessionId: 'session-a',
      search: '?accountReauth=session-a',
    };

    expect(isOAuthPollingScopeCurrent(started, { ...started })).toBe(true);
    expect(
      isOAuthPollingScopeCurrent(started, {
        ...started,
        connectionFingerprint: 'connection-b',
      })
    ).toBe(false);
    expect(
      isOAuthPollingScopeCurrent(started, {
        ...started,
        accountReauthSessionId: 'session-b',
        search: '?accountReauth=session-b',
      })
    ).toBe(false);
  });

  it('invalidates stale provider attempts after a newer start or scope change', () => {
    const scope = {
      connectionFingerprint: 'connection-a',
      accountReauthSessionId: 'session-a',
      search: '?accountReauth=session-a',
    };
    const attempt = { scope, version: 1 };

    expect(isOAuthProviderAttemptCurrent(attempt, { ...scope }, 1)).toBe(true);
    expect(isOAuthProviderAttemptCurrent(attempt, { ...scope }, 2)).toBe(false);
    expect(
      isOAuthProviderAttemptCurrent(attempt, { ...scope, connectionFingerprint: 'connection-b' }, 1)
    ).toBe(false);
  });
});
