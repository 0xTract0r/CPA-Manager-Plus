import { act, createElement, useEffect } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthFileItem } from '@/types';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    subscribers: new Set<(next: { apiBase: string; managementKey: string }, previous: { apiBase: string; managementKey: string }) => void>(),
    scope: { apiBase: 'http://localhost:12345', managementKey: 'fixture-key' },
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
  useAuthStore: {
    getState: () => mocks.scope,
    subscribe: (listener: (typeof mocks.subscribers extends Set<infer L> ? L : never)) => {
      mocks.subscribers.add(listener);
      return () => mocks.subscribers.delete(listener);
    },
  },
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
  const hookRef: { current: ReturnType<typeof useAuthFilesReauth> | null } = {
    current: null,
  };
  let renderer: ReactTestRenderer | null = null;

  function HookHarness() {
    const value = useAuthFilesReauth({
      loadFiles: mocks.loadFiles,
      onReauthHistoryChanged: mocks.onReauthHistoryChanged,
    });
    useEffect(() => {
      hookRef.current = value;
    });
    return null;
  }

  act(() => {
    renderer = create(createElement(HookHarness));
  });

  return {
    getCurrent: () => {
      if (!hookRef.current)
        throw new Error('Failed to mount useAuthFilesReauth test harness');
      return hookRef.current;
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
      ...mocks.scope,
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
      ...mocks.scope,
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

    expect(mocks.submitCallback).toHaveBeenCalledWith('anthropic', 'https://cb/?code=xyz', mocks.scope);
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
  it('ignores an OAuth callback resolved after switching management connections', async () => {
    const hook = mountHook();
    const file = buildFile({ type: 'anthropic' });
    const original = mocks.scope;
    let finish!: (result: { status: 'ok' }) => void;
    mocks.submitCallback.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    try {
      await act(async () => hook.getCurrent().startReauth(file));
      await runConfirmation();
      act(() => hook.getCurrent().updateReauthCallbackUrl(file.name, 'https://callback.invalid/?code=fixture'));
      let request!: Promise<void>;
      await act(async () => { request = hook.getCurrent().submitReauthCallback(file.name); });
      expect(mocks.submitCallback).toHaveBeenCalledWith(
        'anthropic', 'https://callback.invalid/?code=fixture', original
      );
      act(() => {
        mocks.scope = { ...original, apiBase: 'http://localhost:12346' };
        for (const listener of mocks.subscribers) listener(mocks.scope, original);
      });
      await act(async () => { finish({ status: 'ok' }); await request; });
      expect(hook.getCurrent().reauthStates[file.name]).toBeUndefined();
      expect(mocks.showNotification).not.toHaveBeenCalledWith('auth_login.oauth_callback_success', 'success');
    } finally {
      hook.unmount();
      mocks.scope = original;
    }
  });

  it('does not start an old confirmation after switching management connections', async () => {
    const hook = mountHook();
    const original = mocks.scope;
    try {
      await act(async () => hook.getCurrent().startReauth(buildFile()));
      act(() => {
        mocks.scope = { ...original, apiBase: 'http://localhost:12346' };
        for (const listener of mocks.subscribers) listener(mocks.scope, original);
      });
      await runConfirmation();
      expect(mocks.startAuth).not.toHaveBeenCalled();
    } finally {
      hook.unmount();
      mocks.scope = original;
    }
  });

  it('keeps the poll terminal state when late GET, DELETE and callback responses arrive', async () => {
    vi.useFakeTimers();
    const hook = mountHook();
    const file = buildFile({ type: 'anthropic' });
    let resolveOldPoll!: (status: { status: 'error'; error: string }) => void;
    let resolveDelete!: (status: { status: 'ok'; cancelled: boolean }) => void;
    let resolveCallback!: (status: { status: 'ok' }) => void;
    mocks.getAuthStatus.mockImplementationOnce(() => new Promise(resolve => { resolveOldPoll = resolve; }))
      .mockResolvedValueOnce({ status: 'ok' });
    mocks.cancelAuth.mockImplementationOnce(() => new Promise(resolve => { resolveDelete = resolve; }));
    mocks.submitCallback.mockImplementationOnce(() => new Promise(resolve => { resolveCallback = resolve; }));
    try {
      await act(async () => hook.getCurrent().startReauth(file));
      await runConfirmation();
      act(() => hook.getCurrent().updateReauthCallbackUrl(file.name, 'https://callback.invalid/?code=fixture'));
      let cancelled!: Promise<void>;
      let callback!: Promise<void>;
      await act(async () => {
        callback = hook.getCurrent().submitReauthCallback(file.name);
        cancelled = hook.getCurrent().cancelReauth(file.name);
        await vi.advanceTimersByTimeAsync(6000);
      });
      expect(hook.getCurrent().reauthStates[file.name]?.status).toBe('success');
      expect(hook.getCurrent().reauthStates[file.name]?.callbackSubmitting).toBe(false);
      await act(async () => {
        resolveOldPoll({ status: 'error', error: 'old poll' });
        resolveDelete({ status: 'ok', cancelled: true });
        resolveCallback({ status: 'ok' });
        await Promise.all([cancelled, callback]);
      });
      expect(hook.getCurrent().reauthStates[file.name]?.status).toBe('success');
      expect(mocks.showNotification).not.toHaveBeenCalledWith('auth_login.oauth_callback_success', 'success');
      expect(mocks.showNotification).not.toHaveBeenCalledWith('auth_files.reauth_cancelled', 'info');
      await act(async () => hook.getCurrent().cancelReauth(file.name));
      expect(hook.getCurrent().reauthStates[file.name]).toBeUndefined();
      expect(mocks.cancelAuth).toHaveBeenCalledTimes(1);
    } finally {
      hook.unmount();
      vi.useRealTimers();
    }
  });

  it('keeps polling the same attempt when cancellation is refused', async () => {
    vi.useFakeTimers();
    const hook = mountHook();
    const file = buildFile();
    try {
      mocks.cancelAuth.mockResolvedValue({ status: 'ok', cancelled: false });
      mocks.isOAuthCancelSuccessful.mockReturnValue(false);
      mocks.getAuthStatus.mockResolvedValueOnce({ status: 'wait' })
        .mockResolvedValueOnce({ status: 'ok' });
      await act(async () => hook.getCurrent().startReauth(file));
      await runConfirmation();
      await act(async () => hook.getCurrent().cancelReauth(file.name));
      expect(hook.getCurrent().reauthStates[file.name]?.status).toBe('polling');
      expect(mocks.showNotification).toHaveBeenCalledWith('auth_files.reauth_cancel_failed', 'error');
      await act(async () => vi.advanceTimersByTimeAsync(3000));
      expect(hook.getCurrent().reauthStates[file.name]?.status).toBe('polling');
      await act(async () => vi.advanceTimersByTimeAsync(3000));
      expect(hook.getCurrent().reauthStates[file.name]?.status).toBe('success');
      expect(mocks.getAuthStatus.mock.calls).toEqual([
        ['state-abc', mocks.scope], ['state-abc', mocks.scope],
      ]);
      expect(mocks.loadFiles).toHaveBeenCalledTimes(1);
      await act(async () => vi.advanceTimersByTimeAsync(3000));
      expect(mocks.getAuthStatus).toHaveBeenCalledTimes(2);
    } finally {
      hook.unmount();
      vi.useRealTimers();
    }
  });

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

    expect(mocks.cancelAuth).toHaveBeenCalledWith('state-abc', mocks.scope);
    expect(hook.getCurrent().reauthStates['claude-primary.json']).toBeUndefined();

    hook.unmount();
  });
});
