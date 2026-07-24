import { act, createElement } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthFileItem } from '@/types';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    startAuth: vi.fn(),
    getAuthStatus: vi.fn(),
    cancelAuth: vi.fn(),
    submitCallback: vi.fn(),
    isOAuthCancelSuccessful: vi.fn(),
    showNotification: vi.fn(),
    showConfirmation: vi.fn(),
    loadFiles: vi.fn(),
    onReauthHistoryChanged: vi.fn(),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/services/api/oauth', () => ({
  oauthApi: {
    startAuth: mocks.startAuth,
    getAuthStatus: mocks.getAuthStatus,
    cancelAuth: mocks.cancelAuth,
    submitCallback: mocks.submitCallback,
  },
  isOAuthCancelSuccessful: mocks.isOAuthCancelSuccessful,
}));

vi.mock('@/stores', () => ({
  useNotificationStore: (
    selector: (state: {
      showNotification: typeof mocks.showNotification;
      showConfirmation: typeof mocks.showConfirmation;
    }) => unknown
  ) =>
    selector({
      showNotification: mocks.showNotification,
      showConfirmation: mocks.showConfirmation,
    }),
}));

import {
  resolveAuthFileOAuthProvider,
  supportsAuthFileReauthCallback,
  useAuthFilesReauth,
} from './useAuthFilesReauth';

type Harness = {
  getCurrent: () => ReturnType<typeof useAuthFilesReauth>;
  unmount: () => void;
};

const mountHook = (): Harness => {
  let hook: ReturnType<typeof useAuthFilesReauth> | null = null;
  let renderer: ReactTestRenderer | null = null;

  function HookHarness() {
    hook = useAuthFilesReauth({
      loadFiles: mocks.loadFiles,
      onReauthHistoryChanged: mocks.onReauthHistoryChanged,
    });
    return null;
  }

  act(() => {
    renderer = create(createElement(HookHarness));
  });

  return {
    getCurrent: () => {
      if (!hook) throw new Error('Failed to mount useAuthFilesReauth test harness');
      return hook;
    },
    unmount: () => {
      if (!renderer) return;
      act(() => {
        renderer?.unmount();
      });
    },
  };
};

const buildFile = (overrides: Partial<AuthFileItem> = {}): AuthFileItem => ({
  name: 'claude-account.json',
  type: 'claude',
  ...overrides,
});

const runConfirmation = async () => {
  const calls = mocks.showConfirmation.mock.calls;
  const call = calls[calls.length - 1];
  expect(call).toBeDefined();
  const options = call?.[0] as { onConfirm: () => Promise<void> };
  await act(async () => {
    await options.onConfirm();
  });
};

beforeEach(() => {
  mocks.startAuth.mockReset();
  mocks.getAuthStatus.mockReset();
  mocks.cancelAuth.mockReset();
  mocks.submitCallback.mockReset();
  mocks.isOAuthCancelSuccessful.mockReset();
  mocks.showNotification.mockReset();
  mocks.showConfirmation.mockReset();
  mocks.loadFiles.mockReset();
  mocks.onReauthHistoryChanged.mockReset();

  mocks.startAuth.mockResolvedValue({ url: 'https://auth.example/claude', state: 'state-abc' });
  mocks.getAuthStatus.mockResolvedValue({ status: 'wait' });
  mocks.cancelAuth.mockResolvedValue({ status: 'ok', cancelled: true });
  mocks.submitCallback.mockResolvedValue({ status: 'ok' });
  mocks.isOAuthCancelSuccessful.mockReturnValue(true);
  mocks.loadFiles.mockResolvedValue(undefined);
});

describe('resolveAuthFileOAuthProvider', () => {
  it('maps known auth-file providers to their OAuth provider', () => {
    expect(resolveAuthFileOAuthProvider(buildFile({ type: 'claude' }))).toBe('anthropic');
    expect(resolveAuthFileOAuthProvider(buildFile({ type: 'gemini' }))).toBe('gemini-cli');
    expect(resolveAuthFileOAuthProvider(buildFile({ type: 'xai' }))).toBe('xai');
    expect(resolveAuthFileOAuthProvider(buildFile({ type: 'codex' }))).toBe('codex');
    expect(resolveAuthFileOAuthProvider(buildFile({ provider: 'antigravity' }))).toBe('antigravity');
  });

  it('returns null for non-OAuth providers', () => {
    expect(resolveAuthFileOAuthProvider(buildFile({ type: 'aistudio' }))).toBeNull();
    expect(resolveAuthFileOAuthProvider(buildFile({ type: 'qwen' }))).toBeNull();
  });
});

describe('supportsAuthFileReauthCallback', () => {
  it('is true for providers that accept a manual callback URL', () => {
    expect(supportsAuthFileReauthCallback('anthropic')).toBe(true);
    expect(supportsAuthFileReauthCallback('gemini-cli')).toBe(true);
    expect(supportsAuthFileReauthCallback('xai')).toBe(true);
  });

  it('is false for providers without callback support or when null', () => {
    expect(supportsAuthFileReauthCallback('kimi')).toBe(false);
    expect(supportsAuthFileReauthCallback(null)).toBe(false);
  });
});

describe('useAuthFilesReauth startReauth', () => {
  it('confirms first, then starts OAuth with auth_name and enters polling', async () => {
    const hook = mountHook();
    const file = buildFile({ type: 'anthropic', name: 'claude-primary.json' });

    act(() => {
      void hook.getCurrent().startReauth(file);
    });

    expect(mocks.showConfirmation).toHaveBeenCalledTimes(1);
    expect(mocks.startAuth).not.toHaveBeenCalled();

    await runConfirmation();

    expect(mocks.startAuth).toHaveBeenCalledWith('anthropic', {
      authName: 'claude-primary.json',
      projectId: undefined,
    });
    const state = hook.getCurrent().reauthStates['claude-primary.json'];
    expect(state?.status).toBe('polling');
    expect(state?.url).toBe('https://auth.example/claude');
    expect(state?.state).toBe('state-abc');

    hook.unmount();
  });

  it('passes the gemini project_id when re-authenticating a gemini account', async () => {
    const hook = mountHook();
    const file = buildFile({
      type: 'gemini',
      name: 'gemini-work.json',
      project_id: 'gcp-project-42',
    });

    act(() => {
      void hook.getCurrent().startReauth(file);
    });
    await runConfirmation();

    expect(mocks.startAuth).toHaveBeenCalledWith('gemini-cli', {
      authName: 'gemini-work.json',
      projectId: 'gcp-project-42',
    });

    hook.unmount();
  });

  it('records an error state and notifies when starting OAuth fails', async () => {
    mocks.startAuth.mockRejectedValue(new Error('network down'));
    const hook = mountHook();
    const file = buildFile({ type: 'anthropic', name: 'claude-primary.json' });

    act(() => {
      void hook.getCurrent().startReauth(file);
    });
    await runConfirmation();

    const state = hook.getCurrent().reauthStates['claude-primary.json'];
    expect(state?.status).toBe('error');
    expect(state?.error).toBe('network down');
    expect(mocks.showNotification).toHaveBeenCalledWith(
      expect.stringContaining('auth_files.reauth_failed'),
      'error'
    );

    hook.unmount();
  });
});

describe('useAuthFilesReauth submitReauthCallback', () => {
  it('submits the callback URL for the polling provider', async () => {
    const hook = mountHook();
    const file = buildFile({ type: 'anthropic', name: 'claude-primary.json' });

    act(() => {
      void hook.getCurrent().startReauth(file);
    });
    await runConfirmation();

    act(() => {
      hook.getCurrent().updateReauthCallbackUrl('claude-primary.json', 'https://cb/?code=xyz');
    });

    await act(async () => {
      await hook.getCurrent().submitReauthCallback('claude-primary.json');
    });

    expect(mocks.submitCallback).toHaveBeenCalledWith('anthropic', 'https://cb/?code=xyz');
    expect(hook.getCurrent().reauthStates['claude-primary.json']?.callbackStatus).toBe('success');

    hook.unmount();
  });

  it('warns and does not submit when the callback URL is empty', async () => {
    const hook = mountHook();
    const file = buildFile({ type: 'anthropic', name: 'claude-primary.json' });

    act(() => {
      void hook.getCurrent().startReauth(file);
    });
    await runConfirmation();

    await act(async () => {
      await hook.getCurrent().submitReauthCallback('claude-primary.json');
    });

    expect(mocks.submitCallback).not.toHaveBeenCalled();
    expect(mocks.showNotification).toHaveBeenCalledWith(
      'auth_login.oauth_callback_required',
      'warning'
    );

    hook.unmount();
  });
});

describe('useAuthFilesReauth cancelReauth', () => {
  it('cancels the in-flight OAuth session and clears the file state', async () => {
    const hook = mountHook();
    const file = buildFile({ type: 'anthropic', name: 'claude-primary.json' });

    act(() => {
      void hook.getCurrent().startReauth(file);
    });
    await runConfirmation();
    expect(hook.getCurrent().reauthStates['claude-primary.json']?.status).toBe('polling');

    await act(async () => {
      await hook.getCurrent().cancelReauth('claude-primary.json');
    });

    expect(mocks.cancelAuth).toHaveBeenCalledWith('state-abc');
    expect(hook.getCurrent().reauthStates['claude-primary.json']).toBeUndefined();

    hook.unmount();
  });
});
