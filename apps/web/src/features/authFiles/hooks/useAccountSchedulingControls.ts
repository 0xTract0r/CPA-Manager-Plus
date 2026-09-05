/**
 * 账号设置弹窗内「调度旋钮」控件（tier_override / rate_scale）的状态与提交逻辑。
 *
 * 照搬本仓库既有「每个弹窗内独立动作一个 hook」惯例（参考
 * useFarmRotateProxy.ts 的「状态 + action + showNotification」范式、
 * useAuthFilesTestMessage.ts 的「own async submit + own error state」范式），
 * 而不是把这两个字段塞进 useAuthFilesAccountSettings.ts 的账号设置白名单 dirty/
 * save 流程——core 侧 `PATCH /auth-files/account-scheduling` 是与
 * `PATCH /auth-files/account-settings` 完全独立的端点（见 core
 * internal/api/handlers/management/auth_files_account_scheduling.go 顶部注释），
 * 返回体也是独立投影（`{name, account_scheduling}`），不适合塞进那个巨大 hook
 * 已有的 buildPatchRequest/accountSettingsDirty 组合逻辑。
 *
 * Claude 专属：账号级调度旋钮当前只对 claude 生效（core `claude:
 * max_20x|max_5x|pro`），调用方（AccountSchedulingPanel）按 isClaudeProvider
 * 门控是否渲染，本 hook 自身不重复判断 provider。
 *
 * 「用返回投影重渲染，别乐观更新」：`applyScheduling` 成功后用 core 回显的
 * `account_scheduling` 覆盖 `view`（以及据此重新派生的表单当前值），不是把用户
 * 刚提交的表单值直接当作新状态展示——core 侧的合法值归一化 / tier_source 回退
 * 语义都要以这份回显为准。
 */
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { authFilesApi } from '@/services/api';
import { getErrorMessage, isRecord } from '@/utils/helpers';
import { useNotificationStore } from '@/stores';
import type {
  AuthFileAccountScheduling,
  AuthFileAccountSchedulingPatchRequest,
} from '@/types/authFile';

/** claude tier_override 合法值 + 'auto' 哨兵（core `coreauth.LegalTierOverrideValues('claude')`）。 */
export type AccountTierOverrideChoice = 'auto' | 'max_20x' | 'max_5x' | 'pro';

const KNOWN_TIER_OVERRIDE_VALUES: ReadonlySet<string> = new Set([
  'max_20x',
  'max_5x',
  'pro',
]);

export interface UseAccountSchedulingControlsOptions {
  /** 账号 id / 文件名（用列表已有标识，同 name 语义）。 */
  fileName: string;
  /** 可选 auth_index（消歧）；当前调用方未下发也不影响功能。 */
  authIndex?: string | number | null;
  /**
   * 打开弹窗时的 account_scheduling 基线。注意：这来自 auth-files
   * 列表 entry（`file.account_scheduling`），不是 `GET /auth-files/account-settings`
   * 的返回体——该只读投影目前只挂在列表端点上。缺失/为 null 时按「auto + 默认
   * rate_scale=1」的空白基线处理，不臆造。
   */
  initialScheduling?: AuthFileAccountScheduling | null;
  /** 应用成功后的回调（例如触发账号列表 loadFiles()，让卡片徽标跟着刷新）。 */
  onApplied?: (view: AuthFileAccountScheduling) => void;
}

export interface UseAccountSchedulingControlsResult {
  tierOverride: AccountTierOverrideChoice;
  setTierOverride: (value: AccountTierOverrideChoice) => void;
  rateScaleText: string;
  setRateScaleText: (value: string) => void;
  /** rate_scale 输入框校验错误（非数字或 <= 0）；为 null 表示合法（含空串=清除）。 */
  rateScaleError: string | null;
  /**
   * first_production_at 输入框当前值，`<input type="datetime-local">` 的本地 wall-clock
   * 格式（`YYYY-MM-DDTHH:mm`）；空串表示「清除，回退自动打戳」。
   */
  firstProductionAtText: string;
  setFirstProductionAtText: (value: string) => void;
  /**
   * first_production_at 前端校验错误（非法日期 / 未来时间）；为 null 表示合法
   * （含空串=清除）。后端也会拦未来时间，这里是提交前的第一道拦截。
   */
  firstProductionAtError: string | null;
  /** 最近一次成功应用后 core 回显的投影；未应用过时等于打开弹窗时的基线。 */
  view: AuthFileAccountScheduling | null;
  /** 当前表单值是否偏离 view 派生出的基线（决定 Apply 按钮是否可点）。 */
  dirty: boolean;
  saving: boolean;
  /** 最近一次应用失败的可读错误（含 legal_values 拼接）；成功或未提交过为 null。 */
  errorMessage: string | null;
  /** 非法 tier_override 时 core 返回的合法值列表；其它情形为 null。 */
  legalTierValues: string[] | null;
  applyScheduling: () => Promise<void>;
}

function deriveTierChoice(
  view: AuthFileAccountScheduling | null | undefined
): AccountTierOverrideChoice {
  if (!view || view.tier_source !== 'override') return 'auto';
  const tier = String(view.subscription_tier || '').trim();
  // 防御式回退：未知档位（老 core / 非 claude 混入）不臆造选中一个已知项。
  return KNOWN_TIER_OVERRIDE_VALUES.has(tier) ? (tier as AccountTierOverrideChoice) : 'auto';
}

function deriveRateScaleText(view: AuthFileAccountScheduling | null | undefined): string {
  const value = view?.rate_scale;
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '1';
}

type ParsedRateScale =
  | { kind: 'clear' }
  | { kind: 'value'; value: number }
  | { kind: 'invalid' };

function parseRateScaleInput(text: string): ParsedRateScale {
  const trimmed = text.trim();
  if (!trimmed) return { kind: 'clear' };
  const numeric = Number(trimmed);
  if (!Number.isFinite(numeric) || numeric <= 0) return { kind: 'invalid' };
  return { kind: 'value', value: numeric };
}

/** 把毫秒时间戳格式化成 `<input type="datetime-local">` 的本地 wall-clock 值（分钟精度）。 */
function msToDatetimeLocal(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 把投影里的 first_production_at（RFC3339）派生成 datetime-local 输入值。缺失 /
 * null / 非法一律回退空串（= 未锚定，按自动打戳处理），不臆造时间。
 */
function deriveFirstProductionAtInput(
  view: AuthFileAccountScheduling | null | undefined
): string {
  const raw = view?.first_production_at;
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const ms = Date.parse(trimmed);
  return Number.isNaN(ms) ? '' : msToDatetimeLocal(ms);
}

type ParsedFirstProductionAt =
  | { kind: 'empty' }
  | { kind: 'value'; rfc3339: string }
  | { kind: 'invalid' }
  | { kind: 'future' };

/**
 * 解析 datetime-local 输入：空 = 清除；非法日期 = invalid；未来时间 = future
 * （前端第一道拦截，后端也拦）；否则转成 RFC3339（UTC）用于提交。
 */
function parseFirstProductionAtInput(text: string, nowMs: number): ParsedFirstProductionAt {
  const trimmed = text.trim();
  if (!trimmed) return { kind: 'empty' };
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) return { kind: 'invalid' };
  if (ms > nowMs) return { kind: 'future' };
  return { kind: 'value', rfc3339: new Date(ms).toISOString() };
}

/** 从 400 响应体里提取 `legal_values`（core 返回 `{error, legal_values: string[]}`）。 */
function extractLegalTierValues(data: unknown): string[] | null {
  if (!isRecord(data)) return null;
  const raw = data.legal_values;
  if (!Array.isArray(raw)) return null;
  const values = raw.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
  return values.length > 0 ? values : null;
}

export function useAccountSchedulingControls(
  options: UseAccountSchedulingControlsOptions
): UseAccountSchedulingControlsResult {
  const { fileName, authIndex, initialScheduling, onApplied } = options;
  const { t } = useTranslation();
  const showNotification = useNotificationStore((state) => state.showNotification);

  const [view, setView] = useState<AuthFileAccountScheduling | null>(initialScheduling ?? null);
  const [tierOverride, setTierOverride] = useState<AccountTierOverrideChoice>(() =>
    deriveTierChoice(initialScheduling)
  );
  const [rateScaleText, setRateScaleText] = useState<string>(() =>
    deriveRateScaleText(initialScheduling)
  );
  const [firstProductionAtText, setFirstProductionAtText] = useState<string>(() =>
    deriveFirstProductionAtInput(initialScheduling)
  );
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [legalTierValues, setLegalTierValues] = useState<string[] | null>(null);

  const parsedRateScale = parseRateScaleInput(rateScaleText);
  const rateScaleError =
    parsedRateScale.kind === 'invalid'
      ? t('auth_files.account_settings_scheduling_rate_scale_invalid', {
          defaultValue: 'Rate scale must be a number greater than 0, or empty to clear it.',
        })
      : null;

  const parsedFirstProductionAt = parseFirstProductionAtInput(firstProductionAtText, Date.now());
  const firstProductionAtError =
    parsedFirstProductionAt.kind === 'invalid'
      ? t('auth_files.account_settings_scheduling_first_production_at_invalid', {
          defaultValue: 'Enter a valid date and time.',
        })
      : parsedFirstProductionAt.kind === 'future'
        ? t('auth_files.account_settings_scheduling_first_production_at_future_error', {
            defaultValue: "First production date can't be in the future.",
          })
        : null;

  const baselineTier = deriveTierChoice(view);
  const baselineRateText = deriveRateScaleText(view);
  const baselineFirstProductionAt = deriveFirstProductionAtInput(view);
  const firstProductionAtDirty =
    firstProductionAtText.trim() !== baselineFirstProductionAt.trim();
  const dirty =
    tierOverride !== baselineTier ||
    rateScaleText.trim() !== baselineRateText.trim() ||
    firstProductionAtDirty;

  const applyScheduling = useCallback(async () => {
    if (parsedRateScale.kind === 'invalid') return;
    if (parsedFirstProductionAt.kind === 'invalid' || parsedFirstProductionAt.kind === 'future') {
      return;
    }

    setSaving(true);
    setErrorMessage(null);
    setLegalTierValues(null);
    try {
      const request: AuthFileAccountSchedulingPatchRequest = {
        name: fileName,
        tier_override: tierOverride === 'auto' ? null : tierOverride,
        rate_scale: parsedRateScale.kind === 'value' ? parsedRateScale.value : null,
      };
      if (authIndex !== undefined && authIndex !== null && String(authIndex).trim() !== '') {
        request.auth_index = authIndex;
      }
      // first_production_at 是 tri-state：只在用户改动过时才带进请求（省略=不变），
      // 避免调整 tier/rate 时误把已有（可能是自动打戳的）锚点覆写成手工值。
      // 改动后：空 = null（清除，回退自动打戳）；有值 = RFC3339（≤ 现在）。
      if (firstProductionAtDirty) {
        request.first_production_at =
          parsedFirstProductionAt.kind === 'value' ? parsedFirstProductionAt.rfc3339 : null;
      }

      const response = await authFilesApi.updateAccountScheduling(request);
      const nextView = response.account_scheduling;
      // 用返回投影重渲染，不乐观地把表单值直接当作新状态。
      setView(nextView);
      setTierOverride(deriveTierChoice(nextView));
      setRateScaleText(deriveRateScaleText(nextView));
      setFirstProductionAtText(deriveFirstProductionAtInput(nextView));
      showNotification(
        t('auth_files.account_settings_scheduling_saved_success', {
          name: fileName,
          defaultValue: 'Scheduling overrides saved for {{name}}.',
        }),
        'success'
      );
      onApplied?.(nextView);
    } catch (err: unknown) {
      const apiErr = err as { data?: unknown };
      const legalValues = extractLegalTierValues(apiErr?.data);
      const baseMessage = getErrorMessage(
        err,
        t('auth_files.account_settings_scheduling_save_failed', {
          defaultValue: 'Failed to save scheduling overrides.',
        })
      );
      const fullMessage = legalValues
        ? t('auth_files.account_settings_scheduling_legal_values', {
            message: baseMessage,
            values: legalValues.join(', '),
            defaultValue: '{{message}} Legal values: {{values}}.',
          })
        : baseMessage;
      if (legalValues) setLegalTierValues(legalValues);
      setErrorMessage(fullMessage);
      showNotification(fullMessage, 'error');
    } finally {
      setSaving(false);
    }
  }, [
    authIndex,
    fileName,
    firstProductionAtDirty,
    onApplied,
    parsedFirstProductionAt,
    parsedRateScale,
    showNotification,
    t,
    tierOverride,
  ]);

  return {
    tierOverride,
    setTierOverride,
    rateScaleText,
    setRateScaleText,
    rateScaleError,
    firstProductionAtText,
    setFirstProductionAtText,
    firstProductionAtError,
    view,
    dirty,
    saving,
    errorMessage,
    legalTierValues,
    applyScheduling,
  };
}
