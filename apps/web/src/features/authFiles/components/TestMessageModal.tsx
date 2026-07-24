/**
 * 「测试消息」弹窗：可选模型下拉（含「自定义模型」手动输入）+ 可改消息文案 +
 * max tokens + 结果展示（成功摘要 / 失败原因 / 原始 JSON 详情）。
 *
 * 迁移自旧版 fork `apps/web/src/pages/AuthFilesPage.tsx` 内联渲染的同名弹窗
 * （约第 1447-1626 行）。旧版把渲染直接写在页面组件里；cpamp 按本仓库既有的
 * 「每个弹窗一个组件」惯例（参考 AuthFilesPrefixProxyEditorModal /
 * AuthFilesAccountSettingsModal）拆成独立组件，状态与提交逻辑在
 * useAuthFilesTestMessage。
 */
import { useTranslation } from 'react-i18next';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select, type SelectOption } from '@/components/ui/Select';
import {
  TEST_MESSAGE_CUSTOM_MODEL_VALUE,
  type UseAuthFilesTestMessageResult,
} from '@/features/authFiles/hooks/useAuthFilesTestMessage';
import styles from '@/features/authFiles/AuthFilesPage.module.scss';

export type TestMessageModalProps = Pick<
  UseAuthFilesTestMessageResult,
  | 'testMessageFile'
  | 'testMessageModel'
  | 'setTestMessageModel'
  | 'testMessageText'
  | 'setTestMessageText'
  | 'testMessageMaxTokens'
  | 'setTestMessageMaxTokens'
  | 'testMessageResult'
  | 'testMessageRawExpanded'
  | 'setTestMessageRawExpanded'
  | 'testMessageModelsLoading'
  | 'testMessageModelsError'
  | 'testMessageModelOptions'
  | 'testMessageSubmitting'
  | 'testMessageSubmitDisabled'
  | 'parsedTestMessageMaxTokens'
  | 'closeTestMessageModal'
  | 'submitTestMessage'
> & {
  onCopyText: (text: string) => void | Promise<void>;
};

export function TestMessageModal(props: TestMessageModalProps) {
  const { t } = useTranslation();
  const {
    testMessageFile,
    testMessageModel,
    setTestMessageModel,
    testMessageText,
    setTestMessageText,
    testMessageMaxTokens,
    setTestMessageMaxTokens,
    testMessageResult,
    testMessageRawExpanded,
    setTestMessageRawExpanded,
    testMessageModelsLoading,
    testMessageModelsError,
    testMessageModelOptions,
    testMessageSubmitting,
    testMessageSubmitDisabled,
    parsedTestMessageMaxTokens,
    closeTestMessageModal,
    submitTestMessage,
    onCopyText,
  } = props;

  const testMessageFileName = String(testMessageFile?.name ?? '').trim();
  const testMessageModelFromList = testMessageModelOptions.includes(testMessageModel.trim());
  const testMessageSelectValue =
    testMessageModelFromList && testMessageModel.trim()
      ? testMessageModel.trim()
      : TEST_MESSAGE_CUSTOM_MODEL_VALUE;
  const testMessageManualModelVisible =
    testMessageModelOptions.length === 0 || testMessageSelectValue === TEST_MESSAGE_CUSTOM_MODEL_VALUE;

  const testMessageModelSelectOptions: SelectOption[] = [
    ...testMessageModelOptions.map((model) => ({ value: model, label: model })),
    {
      value: TEST_MESSAGE_CUSTOM_MODEL_VALUE,
      label: t('auth_files.test_message_model_custom_option', {
        defaultValue: 'Custom model…',
      }),
    },
  ];

  return (
    <Modal
      open={Boolean(testMessageFile)}
      onClose={closeTestMessageModal}
      closeDisabled={testMessageSubmitting}
      width={640}
      title={t('auth_files.test_message_modal_title', {
        name: testMessageFileName,
        defaultValue: `Test message - ${testMessageFileName}`,
      })}
      footer={
        <>
          <Button variant="secondary" onClick={closeTestMessageModal} disabled={testMessageSubmitting}>
            {t('common.close')}
          </Button>
          <Button
            variant="primary"
            onClick={() => void submitTestMessage()}
            loading={testMessageSubmitting}
            disabled={testMessageSubmitDisabled}
            data-testid="auth-file-test-message-submit"
          >
            {t('auth_files.test_message_submit', { defaultValue: 'Send test message' })}
          </Button>
        </>
      }
    >
      <div className={styles.testMessageModal}>
        <div className={styles.testMessageFileName}>
          <span>{t('auth_files.test_message_account_label', { defaultValue: 'Account file' })}</span>
          <code title={testMessageFileName}>{testMessageFileName || '-'}</code>
        </div>

        <div className={styles.formGroup}>
          <label id="auth-file-test-message-model-label">
            {t('auth_files.test_message_model_label', { defaultValue: 'Model' })}
          </label>
          <div data-testid="auth-file-test-message-model-select">
            <Select
              value={testMessageSelectValue}
              options={testMessageModelSelectOptions}
              onChange={(value) => {
                setTestMessageModel(value === TEST_MESSAGE_CUSTOM_MODEL_VALUE ? '' : value);
              }}
              disabled={testMessageSubmitting || testMessageModelsLoading}
              ariaLabelledBy="auth-file-test-message-model-label"
            />
          </div>
          <div className="hint">
            {testMessageModelsLoading
              ? t('auth_files.test_message_model_loading', {
                  defaultValue: 'Loading this account model list...',
                })
              : testMessageModelsError
                ? t('auth_files.test_message_model_load_failed', {
                    defaultValue: 'Model list could not be loaded. Type a model id manually.',
                  })
                : testMessageModelOptions.length > 0
                  ? t('auth_files.test_message_model_hint', {
                      defaultValue: 'Pick from this account model list or enter a model id manually.',
                    })
                  : t('auth_files.test_message_model_hint_empty', {
                      defaultValue: 'No model list was reported. Enter a model id manually.',
                    })}
          </div>
        </div>

        {testMessageManualModelVisible && (
          <Input
            label={t('auth_files.test_message_model_manual_label', {
              defaultValue: 'Manual model ID',
            })}
            value={testMessageModel}
            onChange={(event) => setTestMessageModel(event.currentTarget.value)}
            disabled={testMessageSubmitting}
            data-testid="auth-file-test-message-model"
            placeholder={t('auth_files.test_message_model_placeholder', {
              defaultValue: 'Choose or enter a model',
            })}
          />
        )}

        <Input
          label={t('auth_files.test_message_max_tokens_label', {
            defaultValue: 'Max tokens',
          })}
          type="number"
          min={1}
          max={256}
          step={1}
          value={testMessageMaxTokens}
          onChange={(event) => setTestMessageMaxTokens(event.currentTarget.value)}
          disabled={testMessageSubmitting}
          error={
            parsedTestMessageMaxTokens === null
              ? t('auth_files.test_message_max_tokens_error', {
                  defaultValue: 'Enter a positive integer from 1 to 256.',
                })
              : undefined
          }
        />

        <div className={styles.formGroup}>
          <label htmlFor="auth-file-test-message-text">
            {t('auth_files.test_message_text_label', { defaultValue: 'Message' })}
          </label>
          <textarea
            id="auth-file-test-message-text"
            className={styles.textarea}
            rows={5}
            value={testMessageText}
            onChange={(event) => setTestMessageText(event.currentTarget.value)}
            disabled={testMessageSubmitting}
            placeholder={t('auth_files.test_message_text_placeholder', {
              defaultValue: 'Reply with OK only.',
            })}
          />
        </div>

        {testMessageResult && (
          <div
            className={`${styles.testMessageResult} ${
              testMessageResult.status === 'success'
                ? styles.testMessageResultSuccess
                : styles.testMessageResultError
            }`}
            data-testid={`auth-file-test-message-result-${testMessageResult.status}`}
          >
            <div className={styles.testMessageResultHeader}>
              <strong>{testMessageResult.title}</strong>
            </div>
            {testMessageResult.status === 'success' ? (
              <>
                <div className={styles.testMessagePreview}>
                  {testMessageResult.outputPreview ||
                    t('auth_files.test_message_empty_preview', {
                      defaultValue: 'The request succeeded with no output preview.',
                    })}
                </div>
                {testMessageResult.meta.length > 0 && (
                  <div className={styles.testMessageMeta}>
                    {testMessageResult.meta.map((entry) => (
                      <span key={entry}>{entry}</span>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div className={styles.testMessagePreview}>{testMessageResult.message}</div>
            )}
            {testMessageResult.raw && (
              <div className={styles.testMessageRaw}>
                <div className={styles.testMessageRawActions}>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => setTestMessageRawExpanded((value) => !value)}
                  >
                    {testMessageRawExpanded
                      ? t('auth_files.test_message_raw_hide', { defaultValue: 'Hide raw details' })
                      : t('auth_files.test_message_raw_show', { defaultValue: 'Show raw details' })}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => void onCopyText(testMessageResult.raw)}
                  >
                    {t('common.copy', { defaultValue: 'Copy' })}
                  </Button>
                </div>
                {testMessageRawExpanded && (
                  <pre className={styles.testMessageRawContent}>
                    <code>{testMessageResult.raw}</code>
                  </pre>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
