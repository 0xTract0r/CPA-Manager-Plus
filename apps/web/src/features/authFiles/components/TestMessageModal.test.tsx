import { act, type ReactNode } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import type { AuthFileItem } from '@/types';
import {
  TEST_MESSAGE_CUSTOM_MODEL_VALUE,
  type TestMessageResultState,
} from '@/features/authFiles/hooks/useAuthFilesTestMessage';
import { TestMessageModal, type TestMessageModalProps } from './TestMessageModal';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/components/ui/Modal', () => ({
  Modal: (props: { children: ReactNode; footer?: ReactNode; title?: ReactNode }) => (
    <div>
      <div>{props.title}</div>
      <div>{props.children}</div>
      <div>{props.footer}</div>
    </div>
  ),
}));

const file: AuthFileItem = {
  name: 'claude-account.json',
  type: 'claude',
};

type ModalHarness = {
  renderer: ReactTestRenderer;
  clickSubmit: () => Promise<void>;
  getSelect: () => ReturnType<ReactTestRenderer['root']['findByType']>;
  getText: () => string;
};

const baseProps = (overrides: Partial<TestMessageModalProps> = {}): TestMessageModalProps => ({
  testMessageFile: file,
  testMessageModel: 'model-a',
  setTestMessageModel: vi.fn(),
  testMessageText: 'Reply with OK only.',
  setTestMessageText: vi.fn(),
  testMessageMaxTokens: '16',
  setTestMessageMaxTokens: vi.fn(),
  testMessageResult: null,
  testMessageRawExpanded: false,
  setTestMessageRawExpanded: vi.fn(),
  testMessageModelsLoading: false,
  testMessageModelsError: '',
  testMessageModelOptions: ['model-a', 'model-b'],
  testMessageSubmitting: false,
  testMessageSubmitDisabled: false,
  parsedTestMessageMaxTokens: 16,
  closeTestMessageModal: vi.fn(),
  submitTestMessage: vi.fn().mockResolvedValue(undefined),
  onCopyText: vi.fn(),
  ...overrides,
});

const mountModal = (props: TestMessageModalProps): ModalHarness => {
  let renderer: ReactTestRenderer;
  act(() => {
    renderer = create(<TestMessageModal {...props} />);
  });

  const clickSubmit = async () => {
    const submitButton = renderer!.root
      .findAllByType(Button)
      .find((node) => node.props['data-testid'] === 'auth-file-test-message-submit');
    if (!submitButton) throw new Error('Submit button not found');
    await act(async () => {
      await submitButton.props.onClick();
    });
  };

  const getSelect = () => renderer!.root.findByType(Select);
  const getText = () => JSON.stringify(renderer!.toJSON());

  return { renderer: renderer!, clickSubmit, getSelect, getText };
};

describe('TestMessageModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the known model options plus a custom-model sentinel option', () => {
    const props = baseProps();
    const modal = mountModal(props);

    const select = modal.getSelect();
    const values = select.props.options.map((option: { value: string }) => option.value);

    expect(values).toEqual(['model-a', 'model-b', TEST_MESSAGE_CUSTOM_MODEL_VALUE]);
    expect(select.props.value).toBe('model-a');
    modal.renderer.unmount();
  });

  it('shows the manual model input when the current model is not in the known list', () => {
    const props = baseProps({ testMessageModel: 'unknown-model' });
    const modal = mountModal(props);

    const select = modal.getSelect();
    expect(select.props.value).toBe(TEST_MESSAGE_CUSTOM_MODEL_VALUE);

    const manualInput = modal.renderer.root
      .findAllByType(Input)
      .find((node) => node.props['data-testid'] === 'auth-file-test-message-model');
    expect(manualInput).toBeDefined();
    modal.renderer.unmount();
  });

  it('clears the model when switching the select to the custom-model sentinel', () => {
    const setTestMessageModel = vi.fn();
    const props = baseProps({ setTestMessageModel });
    const modal = mountModal(props);

    act(() => {
      modal.getSelect().props.onChange(TEST_MESSAGE_CUSTOM_MODEL_VALUE);
    });

    expect(setTestMessageModel).toHaveBeenCalledWith('');
    modal.renderer.unmount();
  });

  it('selects a known model directly from the dropdown', () => {
    const setTestMessageModel = vi.fn();
    const props = baseProps({ setTestMessageModel });
    const modal = mountModal(props);

    act(() => {
      modal.getSelect().props.onChange('model-b');
    });

    expect(setTestMessageModel).toHaveBeenCalledWith('model-b');
    modal.renderer.unmount();
  });

  it('submits the test message when the submit button is clicked', async () => {
    const submitTestMessage = vi.fn().mockResolvedValue(undefined);
    const props = baseProps({ submitTestMessage });
    const modal = mountModal(props);

    await modal.clickSubmit();

    expect(submitTestMessage).toHaveBeenCalledTimes(1);
    modal.renderer.unmount();
  });

  it('disables the submit button when testMessageSubmitDisabled is true', async () => {
    const submitTestMessage = vi.fn().mockResolvedValue(undefined);
    const props = baseProps({ submitTestMessage, testMessageSubmitDisabled: true });
    const modal = mountModal(props);

    const submitButton = modal.renderer.root
      .findAllByType(Button)
      .find((node) => node.props['data-testid'] === 'auth-file-test-message-submit');

    expect(submitButton?.props.disabled).toBe(true);
    modal.renderer.unmount();
  });

  it('renders a success result with output preview and meta', () => {
    const result: TestMessageResultState = {
      status: 'success',
      title: 'ok',
      outputPreview: 'OK',
      meta: ['Provider: anthropic', 'Model: model-a'],
      raw: '{"status":"ok"}',
    };
    const props = baseProps({ testMessageResult: result });
    const modal = mountModal(props);

    expect(modal.getText()).toContain('OK');
    expect(modal.getText()).toContain('Provider: anthropic');
    modal.renderer.unmount();
  });

  it('renders an error result message', () => {
    const result: TestMessageResultState = {
      status: 'error',
      title: 'failed',
      message: 'The account usage limit was reached.',
      raw: '{"error":"usage_limit_reached"}',
    };
    const props = baseProps({ testMessageResult: result });
    const modal = mountModal(props);

    expect(modal.getText()).toContain('The account usage limit was reached.');
    modal.renderer.unmount();
  });

  it('copies raw details when the copy button is clicked', () => {
    const onCopyText = vi.fn();
    const result: TestMessageResultState = {
      status: 'success',
      title: 'ok',
      outputPreview: 'OK',
      meta: [],
      raw: '{"status":"ok"}',
    };
    const props = baseProps({ testMessageResult: result, onCopyText });
    const modal = mountModal(props);

    const copyButton = modal.renderer.root
      .findAllByType(Button)
      .find((node) => node.props.children === 'common.copy');
    act(() => {
      copyButton?.props.onClick();
    });

    expect(onCopyText).toHaveBeenCalledWith('{"status":"ok"}');
    modal.renderer.unmount();
  });
});
