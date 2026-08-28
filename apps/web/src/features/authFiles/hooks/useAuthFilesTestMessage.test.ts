import { act, createElement, useEffect } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthFileItem } from '@/types';

const { mocks } = vi.hoisted(() => {
  return {
    mocks: {
      getModelsForAuthFile: vi.fn(),
      testMessage: vi.fn(),
      loadFiles: vi.fn(),
    },
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (options && typeof options.name === 'string') {
        return `${key}:${options.name}`;
      }
      return key;
    },
  }),
}));

vi.mock('@/services/api', () => ({
  authFilesApi: {
    getModelsForAuthFile: mocks.getModelsForAuthFile,
    testMessage: mocks.testMessage,
  },
}));

import { useAuthFilesTestMessage } from './useAuthFilesTestMessage';

type UseAuthFilesTestMessageHarness = {
  getCurrent: () => ReturnType<typeof useAuthFilesTestMessage>;
  unmount: () => void;
};

const mountHook = (
  messageTesting: Record<string, boolean> = {}
): UseAuthFilesTestMessageHarness => {
  const hookRef: {
    current: ReturnType<typeof useAuthFilesTestMessage> | null;
  } = { current: null };
  let renderer: ReactTestRenderer | null = null;
  let currentMessageTesting = messageTesting;

  const setMessageTesting = (
    updater: (prev: Record<string, boolean>) => Record<string, boolean>
  ) => {
    currentMessageTesting = updater(currentMessageTesting);
    act(() => {
      renderer?.update(createElement(HookHarness));
    });
  };

  function HookHarness() {
    const value = useAuthFilesTestMessage({
      messageTesting: currentMessageTesting,
      setMessageTesting,
      loadFiles: mocks.loadFiles,
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
      if (!hookRef.current) {
        throw new Error('Failed to mount useAuthFilesTestMessage test harness');
      }
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

beforeEach(() => {
  mocks.getModelsForAuthFile.mockReset();
  mocks.testMessage.mockReset();
  mocks.loadFiles.mockReset();

  mocks.getModelsForAuthFile.mockResolvedValue([]);
  mocks.testMessage.mockResolvedValue({ status: 'ok' });
  mocks.loadFiles.mockResolvedValue(undefined);
});

describe('useAuthFilesTestMessage handleTestMessage', () => {
  it('opens the modal for the target file and defaults to the first known model', () => {
    const hook = mountHook();
    const file = buildFile({ models: ['model-a', 'model-b'] });

    act(() => {
      hook.getCurrent().handleTestMessage(file);
    });

    expect(hook.getCurrent().testMessageFile).toBe(file);
    expect(hook.getCurrent().testMessageModel).toBe('model-a');
    expect(hook.getCurrent().testMessageModelOptions).toEqual(['model-a', 'model-b']);
    hook.unmount();
  });

  it('fetches account models and merges them into the model options', async () => {
    mocks.getModelsForAuthFile.mockResolvedValue([{ id: 'remote-model' }]);
    const hook = mountHook();
    const file = buildFile();

    await act(async () => {
      hook.getCurrent().handleTestMessage(file);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.getModelsForAuthFile).toHaveBeenCalledWith('claude-account.json');
    expect(hook.getCurrent().testMessageModelOptions).toEqual(['remote-model']);
    expect(hook.getCurrent().testMessageModel).toBe('remote-model');
    hook.unmount();
  });

  it('does not refetch account models for the same account on a second open (cache hit)', async () => {
    mocks.getModelsForAuthFile.mockResolvedValue([{ id: 'remote-model' }]);
    const hook = mountHook();
    const file = buildFile();

    await act(async () => {
      hook.getCurrent().handleTestMessage(file);
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => {
      hook.getCurrent().closeTestMessageModal();
    });

    act(() => {
      hook.getCurrent().handleTestMessage(file);
    });

    expect(mocks.getModelsForAuthFile).toHaveBeenCalledTimes(1);
    expect(hook.getCurrent().testMessageModelOptions).toEqual(['remote-model']);
    hook.unmount();
  });
});

describe('useAuthFilesTestMessage submitTestMessage', () => {
  it('sends the selected model to testMessage and reports success', async () => {
    mocks.testMessage.mockResolvedValue({
      status: 'ok',
      provider: 'anthropic',
      model: 'model-a',
      latency_ms: 123,
      output_preview: 'OK',
    });
    const hook = mountHook();
    const file = buildFile({ models: ['model-a'] });

    act(() => {
      hook.getCurrent().handleTestMessage(file);
    });

    await act(async () => {
      await hook.getCurrent().submitTestMessage();
    });

    expect(mocks.testMessage).toHaveBeenCalledWith({
      name: 'claude-account.json',
      model: 'model-a',
      message: 'Reply with OK only.',
      max_tokens: 16,
    });
    expect(mocks.loadFiles).toHaveBeenCalledTimes(1);
    expect(hook.getCurrent().testMessageResult).toMatchObject({
      status: 'success',
      outputPreview: 'OK',
    });
    hook.unmount();
  });

  it('sends a custom manual model id when the user types one', async () => {
    const hook = mountHook();
    const file = buildFile();

    act(() => {
      hook.getCurrent().handleTestMessage(file);
    });

    act(() => {
      hook.getCurrent().setTestMessageModel('custom-model-id');
    });

    await act(async () => {
      await hook.getCurrent().submitTestMessage();
    });

    expect(mocks.testMessage).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'custom-model-id' })
    );
    hook.unmount();
  });

  it('does not submit when max tokens is out of range', async () => {
    const hook = mountHook();
    const file = buildFile({ models: ['model-a'] });

    act(() => {
      hook.getCurrent().handleTestMessage(file);
    });

    act(() => {
      hook.getCurrent().setTestMessageMaxTokens('0');
    });

    expect(hook.getCurrent().parsedTestMessageMaxTokens).toBeNull();
    expect(hook.getCurrent().testMessageSubmitDisabled).toBe(true);

    await act(async () => {
      await hook.getCurrent().submitTestMessage();
    });

    expect(mocks.testMessage).not.toHaveBeenCalled();
    hook.unmount();
  });

  it('reports a friendly message for model_cooldown errors', async () => {
    mocks.testMessage.mockRejectedValue({
      message: 'model_cooldown',
      details: { code: 'model_cooldown', reset_seconds: 30 },
    });
    const hook = mountHook();
    const file = buildFile({ models: ['model-a'] });

    act(() => {
      hook.getCurrent().handleTestMessage(file);
    });

    await act(async () => {
      await hook.getCurrent().submitTestMessage();
    });

    expect(hook.getCurrent().testMessageResult).toMatchObject({
      status: 'error',
    });
    const result = hook.getCurrent().testMessageResult;
    if (result?.status === 'error') {
      expect(result.message).toContain('test_message_error_model_cooldown_with_duration');
    }
    hook.unmount();
  });
});

describe('useAuthFilesTestMessage closeTestMessageModal', () => {
  it('clears the modal state', () => {
    const hook = mountHook();
    const file = buildFile({ models: ['model-a'] });

    act(() => {
      hook.getCurrent().handleTestMessage(file);
    });
    expect(hook.getCurrent().testMessageFile).toBe(file);

    act(() => {
      hook.getCurrent().closeTestMessageModal();
    });

    expect(hook.getCurrent().testMessageFile).toBeNull();
    hook.unmount();
  });

  it('does not close while a submit is in progress', () => {
    const hook = mountHook({ 'claude-account.json': true });
    const file = buildFile({ models: ['model-a'] });

    act(() => {
      hook.getCurrent().handleTestMessage(file);
    });

    act(() => {
      hook.getCurrent().closeTestMessageModal();
    });

    expect(hook.getCurrent().testMessageFile).toBe(file);
    hook.unmount();
  });
});
