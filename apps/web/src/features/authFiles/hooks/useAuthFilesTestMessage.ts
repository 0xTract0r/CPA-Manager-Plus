/**
 * 「测试消息」弹窗状态与提交逻辑。
 *
 * 迁移自旧版 fork `apps/web/src/pages/AuthFilesPage.tsx` 里内联的
 * testMessage* 状态与 handleTestMessage/submitTestMessage/closeTestMessageModal
 * 三个回调（约第 261-275 行状态声明 + 第 908-1038 行回调实现）。旧版把这些逻辑
 * 直接写在页面组件里；cpamp 按本仓库既有的「每个弹窗一个 hook」惯例
 * （参考 useAuthFilesPrefixProxyEditor / useAuthFilesAccountSettings）拆成独立
 * hook，供 AuthFilesPage 消费、TestMessageModal 渲染。
 *
 * 核心行为对齐旧版：
 *  - 打开弹窗时按账号名拉一次 `GET /auth-files/models`（按账号名做内存缓存，
 *    避免重复请求），与账号自带的 `file.models` 合并去重得到模型下拉选项。
 *  - 模型下拉支持选中已知模型，或切到「自定义模型」手动输入任意 model id。
 *  - 提交时把选中的 model／自定义输入的 model 一起传给
 *    `POST /auth-files/test-message`（不再像 cpamp 现状那样固定不传 model）。
 *  - 常见失败（model_cooldown / usage_limit_reached / Claude 1M 额外用量）
 *    在弹窗内给出更友好的提示文案，其余走原始错误 message。
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { authFilesApi } from '@/services/api';
import { getErrorMessage } from '@/utils/helpers';
import type { AuthFileItem } from '@/types';

export const TEST_MESSAGE_CUSTOM_MODEL_VALUE = '__custom_model__';
export const DEFAULT_TEST_MESSAGE_TEXT = 'Reply with OK only.';
export const DEFAULT_TEST_MESSAGE_MAX_TOKENS = 16;

export type TestMessageResultState =
  | {
      status: 'success';
      title: string;
      outputPreview: string;
      meta: string[];
      raw: string;
    }
  | {
      status: 'error';
      title: string;
      message: string;
      raw: string;
    };

type AccountModelEntry = { id: string };

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const parseJsonIfPossible = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
};

const toPrettyJson = (value: unknown): string => {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const extractFirstString = (value: unknown, keys: Set<string>, depth = 0): string => {
  if (depth > 5 || value === null || value === undefined) return '';
  const parsed = parseJsonIfPossible(value);
  if (typeof parsed === 'string') return '';
  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      const found = extractFirstString(entry, keys, depth + 1);
      if (found) return found;
    }
    return '';
  }
  const record = asRecord(parsed);
  if (!record) return '';

  for (const [key, entry] of Object.entries(record)) {
    if (keys.has(key.toLowerCase()) && typeof entry === 'string' && entry.trim()) {
      return entry.trim();
    }
  }
  for (const entry of Object.values(record)) {
    const found = extractFirstString(entry, keys, depth + 1);
    if (found) return found;
  }
  return '';
};

const extractFirstNumber = (value: unknown, keys: Set<string>, depth = 0): number | null => {
  if (depth > 5 || value === null || value === undefined) return null;
  const parsed = parseJsonIfPossible(value);
  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      const found = extractFirstNumber(entry, keys, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  const record = asRecord(parsed);
  if (!record) return null;

  for (const [key, entry] of Object.entries(record)) {
    if (!keys.has(key.toLowerCase())) continue;
    const numeric = typeof entry === 'number' ? entry : Number(entry);
    if (Number.isFinite(numeric)) return numeric;
  }
  for (const entry of Object.values(record)) {
    const found = extractFirstNumber(entry, keys, depth + 1);
    if (found !== null) return found;
  }
  return null;
};

const normalizeModelId = (value: unknown): string => {
  if (typeof value === 'string') return value.trim();
  const record = asRecord(value);
  if (!record) return '';
  const raw = record.id ?? record.model ?? record.name ?? record.display_name;
  return typeof raw === 'string' ? raw.trim() : '';
};

/** 合并账号自带的 `file.models` 与 `GET /auth-files/models` 返回的模型列表，按出现顺序去重。 */
const resolveModelOptions = (
  file: AuthFileItem,
  accountModels: Record<string, AccountModelEntry[]> = {}
): string[] => {
  const rawFileModels = file.models ?? file['models'];
  const candidates = [
    ...(Array.isArray(rawFileModels) ? rawFileModels.map(normalizeModelId) : []),
    ...(accountModels[file.name] ?? []).map(normalizeModelId),
  ];
  const seen = new Set<string>();
  return candidates.reduce<string[]>((result, entry) => {
    const model = entry.trim();
    if (!model || seen.has(model)) return result;
    seen.add(model);
    result.push(model);
    return result;
  }, []);
};

const getErrorPayload = (err: unknown): unknown => {
  const record = asRecord(err);
  return parseJsonIfPossible(record?.details ?? record?.data ?? getErrorMessage(err, '') ?? err);
};

const formatDuration = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
};

export type UseAuthFilesTestMessageResult = {
  /** 打开弹窗的目标账号；为空表示弹窗关闭。 */
  testMessageFile: AuthFileItem | null;
  testMessageModel: string;
  setTestMessageModel: (value: string) => void;
  testMessageText: string;
  setTestMessageText: (value: string) => void;
  testMessageMaxTokens: string;
  setTestMessageMaxTokens: (value: string) => void;
  testMessageResult: TestMessageResultState | null;
  testMessageRawExpanded: boolean;
  setTestMessageRawExpanded: (updater: (value: boolean) => boolean) => void;
  testMessageModelsLoading: boolean;
  testMessageModelsError: string;
  /** 已知模型选项（不含「自定义模型」哨兵值）。 */
  testMessageModelOptions: string[];
  testMessageSubmitting: boolean;
  testMessageSubmitDisabled: boolean;
  parsedTestMessageMaxTokens: number | null;
  /** 打开弹窗：设置初始默认值，并按需拉取该账号的模型列表。 */
  handleTestMessage: (file: AuthFileItem) => void;
  closeTestMessageModal: () => void;
  submitTestMessage: () => Promise<void>;
};

export function useAuthFilesTestMessage(options: {
  messageTesting: Record<string, boolean>;
  setMessageTesting: (updater: (prev: Record<string, boolean>) => Record<string, boolean>) => void;
  loadFiles: () => Promise<void>;
}): UseAuthFilesTestMessageResult {
  const { messageTesting, setMessageTesting, loadFiles } = options;
  const { t } = useTranslation();

  const [testMessageFile, setTestMessageFile] = useState<AuthFileItem | null>(null);
  const [testMessageModel, setTestMessageModel] = useState('');
  const [testMessageText, setTestMessageText] = useState(DEFAULT_TEST_MESSAGE_TEXT);
  const [testMessageMaxTokens, setTestMessageMaxTokens] = useState(
    String(DEFAULT_TEST_MESSAGE_MAX_TOKENS)
  );
  const [testMessageResult, setTestMessageResult] = useState<TestMessageResultState | null>(null);
  const [testMessageRawExpanded, setTestMessageRawExpanded] = useState(false);
  const [testMessageAccountModels, setTestMessageAccountModels] = useState<
    Record<string, AccountModelEntry[]>
  >({});
  const [testMessageModelsLoading, setTestMessageModelsLoading] = useState(false);
  const [testMessageModelsError, setTestMessageModelsError] = useState('');

  const testMessageModelsCacheRef = useRef<Map<string, AccountModelEntry[]>>(new Map());
  const testMessageModelsRequestRef = useRef(0);

  const testMessageFileName = String(testMessageFile?.name ?? '').trim();
  const testMessageSubmitting = testMessageFileName
    ? messageTesting[testMessageFileName] === true
    : false;

  const testMessageModelOptions = useMemo(
    () =>
      testMessageFile ? resolveModelOptions(testMessageFile, testMessageAccountModels) : [],
    [testMessageAccountModels, testMessageFile]
  );

  const parsedTestMessageMaxTokens = useMemo(() => {
    const value = Number(testMessageMaxTokens);
    if (!Number.isFinite(value)) return null;
    if (!Number.isInteger(value) || value < 1 || value > 256) return null;
    return value;
  }, [testMessageMaxTokens]);

  const testMessageSubmitDisabled =
    testMessageSubmitting ||
    !testMessageFileName ||
    !testMessageModel.trim() ||
    !testMessageText.trim() ||
    parsedTestMessageMaxTokens === null;

  const describeTestMessageError = useCallback(
    (err: unknown) => {
      const payload = getErrorPayload(err);
      const fallback = getErrorMessage(err, '');
      const raw = toPrettyJson(payload) || fallback;
      const codeFromPayload = extractFirstString(
        payload,
        new Set(['code', 'type', 'error_code', 'error_type'])
      );
      const messageFromPayload = extractFirstString(
        payload,
        new Set(['message', 'detail', 'reason', 'error_description'])
      );
      const searchable = `${codeFromPayload} ${messageFromPayload} ${fallback} ${raw}`.toLowerCase();
      const resetSeconds = extractFirstNumber(
        payload,
        new Set([
          'reset_seconds',
          'reset_in_seconds',
          'resets_in_seconds',
          'retry_after',
          'retry_after_seconds',
          'cooldown_seconds',
        ])
      );
      const duration = resetSeconds !== null ? formatDuration(resetSeconds) : '';

      if (searchable.includes('model_cooldown')) {
        return {
          message: duration
            ? t('auth_files.test_message_error_model_cooldown_with_duration', {
                duration,
                defaultValue: `The selected model is cooling down. Try again in ${duration}.`,
              })
            : t('auth_files.test_message_error_model_cooldown', {
                defaultValue:
                  'The selected model is cooling down. Try again later or choose another model.',
              }),
          raw,
        };
      }

      if (
        searchable.includes('long_context_extra_usage_required') ||
        searchable.includes('extra usage is required for long context requests')
      ) {
        return {
          message: t('auth_files.test_message_error_claude_extra_usage', {
            defaultValue:
              'Claude Sonnet 1M requires Claude extra usage even on Max plans. Enable extra usage for this account or choose an Opus 1M model.',
          }),
          raw,
        };
      }

      if (searchable.includes('usage_limit_reached')) {
        return {
          message: duration
            ? t('auth_files.test_message_error_usage_limit_with_duration', {
                duration,
                defaultValue: `The account usage limit was reached. Try again in ${duration}.`,
              })
            : t('auth_files.test_message_error_usage_limit', {
                defaultValue:
                  'The account usage limit was reached. Try another account or wait for quota reset.',
              }),
          raw,
        };
      }

      return {
        message:
          messageFromPayload ||
          fallback ||
          t('auth_files.test_message_error_unknown', {
            defaultValue: 'The test request failed. See raw details below.',
          }),
        raw,
      };
    },
    [t]
  );

  const handleTestMessage = useCallback(
    (file: AuthFileItem) => {
      const accountName = String(file.name ?? '').trim();
      const cachedModels = testMessageModelsCacheRef.current.get(accountName);
      const initialAccountModels = cachedModels
        ? { ...testMessageAccountModels, [accountName]: cachedModels }
        : testMessageAccountModels;
      const models = resolveModelOptions(file, initialAccountModels);

      setTestMessageFile(file);
      setTestMessageModel(models[0] ?? '');
      setTestMessageText(DEFAULT_TEST_MESSAGE_TEXT);
      setTestMessageMaxTokens(String(DEFAULT_TEST_MESSAGE_MAX_TOKENS));
      setTestMessageResult(null);
      setTestMessageRawExpanded(false);
      setTestMessageModelsError('');

      if (!accountName) {
        setTestMessageModelsLoading(false);
        return;
      }
      if (cachedModels) {
        setTestMessageAccountModels((prev) => ({ ...prev, [accountName]: cachedModels }));
        setTestMessageModelsLoading(false);
        return;
      }

      const requestId = testMessageModelsRequestRef.current + 1;
      testMessageModelsRequestRef.current = requestId;
      setTestMessageModelsLoading(true);
      void authFilesApi
        .getModelsForAuthFile(accountName)
        .then((accountModels) => {
          if (testMessageModelsRequestRef.current !== requestId) return;
          testMessageModelsCacheRef.current.set(accountName, accountModels);
          const nextAccountModels = { [accountName]: accountModels };
          setTestMessageAccountModels((prev) => ({ ...prev, ...nextAccountModels }));
          const resolved = resolveModelOptions(file, nextAccountModels);
          if (resolved.length > 0) {
            setTestMessageModel((current) =>
              current.trim() && resolved.includes(current.trim()) ? current : resolved[0]
            );
          }
        })
        .catch((err: unknown) => {
          if (testMessageModelsRequestRef.current !== requestId) return;
          setTestMessageModelsError(getErrorMessage(err, ''));
        })
        .finally(() => {
          if (testMessageModelsRequestRef.current === requestId) {
            setTestMessageModelsLoading(false);
          }
        });
    },
    [testMessageAccountModels]
  );

  const closeTestMessageModal = useCallback(() => {
    if (testMessageSubmitting) return;
    testMessageModelsRequestRef.current += 1;
    setTestMessageFile(null);
    setTestMessageResult(null);
    setTestMessageRawExpanded(false);
    setTestMessageModelsLoading(false);
    setTestMessageModelsError('');
  }, [testMessageSubmitting]);

  const submitTestMessage = useCallback(async () => {
    const name = testMessageFileName;
    const model = testMessageModel.trim();
    const message = testMessageText.trim();
    if (!name || !model || !message || parsedTestMessageMaxTokens === null) return;

    setMessageTesting((prev) => ({ ...prev, [name]: true }));
    setTestMessageResult(null);
    setTestMessageRawExpanded(false);
    try {
      const result = await authFilesApi.testMessage({
        name,
        model,
        message,
        max_tokens: parsedTestMessageMaxTokens,
      });
      const preview = String(result.output_preview ?? '').trim();
      const meta = [
        result.provider
          ? t('auth_files.test_message_result_provider', {
              provider: result.provider,
              defaultValue: `Provider: ${result.provider}`,
            })
          : '',
        result.model
          ? t('auth_files.test_message_result_model', {
              model: result.model,
              defaultValue: `Model: ${result.model}`,
            })
          : '',
        typeof result.latency_ms === 'number'
          ? t('auth_files.test_message_result_latency', {
              latency: Math.round(result.latency_ms),
              defaultValue: `Latency: ${Math.round(result.latency_ms)} ms`,
            })
          : '',
      ].filter(Boolean);
      setTestMessageResult({
        status: 'success',
        title: t('auth_files.test_message_success', { name }),
        outputPreview: preview,
        meta,
        raw: toPrettyJson(result),
      });
      await loadFiles();
    } catch (err) {
      const detail = describeTestMessageError(err);
      setTestMessageResult({
        status: 'error',
        title: t('auth_files.test_message_failed', { name }),
        message: detail.message,
        raw: detail.raw,
      });
    } finally {
      setMessageTesting((prev) => ({ ...prev, [name]: false }));
    }
  }, [
    describeTestMessageError,
    loadFiles,
    parsedTestMessageMaxTokens,
    setMessageTesting,
    t,
    testMessageFileName,
    testMessageModel,
    testMessageText,
  ]);

  return {
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
    handleTestMessage,
    closeTestMessageModal,
    submitTestMessage,
  };
}
