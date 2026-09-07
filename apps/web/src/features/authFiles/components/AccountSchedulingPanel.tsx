/**
 * 账号设置弹窗内的「调度旋钮」控件：设置/清除 tier_override 与 rate_scale，
 * 调用独立的 `PATCH /auth-files/account-scheduling` 端点（core §8.3/§8.4/§8.5，
 * 见 useAccountSchedulingControls 顶部注释）。
 *
 * Claude 专属：调用方（AuthFilesAccountSettingsModal）只在 isClaudeProvider 时
 * 挂载本组件，本组件自身不重复判断 provider（跟 fast 面板对 codex 的门控对称：
 * 那个用 isCodexProvider 挂 AccountFastImpactPanel，这个用 isClaudeProvider 挂
 * 本组件）。
 */
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select, type SelectOption } from '@/components/ui/Select';
import {
  useAccountSchedulingControls,
  type AccountTierOverrideChoice,
} from '@/features/authFiles/hooks/useAccountSchedulingControls';
import type { AuthFileAccountScheduling } from '@/types/authFile';
import styles from './AccountSchedulingPanel.module.scss';

export interface AccountSchedulingPanelProps {
  fileName: string;
  authIndex?: string | number | null;
  /** 打开弹窗时的 account_scheduling 基线（来自 auth-files 列表 entry）。 */
  initialScheduling?: AuthFileAccountScheduling | null;
  disabled?: boolean;
  /** 应用成功后回调（父页面据此刷新账号列表，让卡片徽标跟着变）。 */
  onApplied?: (view: AuthFileAccountScheduling) => void;
}

function formatRateScale(value: number | undefined | null): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '1';
}

/** 当前本地时间的 datetime-local 值，用作 first_production_at 输入的 `max`（禁未来）。 */
function nowDatetimeLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 把投影里的 RFC3339 锚点转成可读本地时间用于回显；非法/缺失回 null。 */
function formatAnchorDisplay(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toLocaleString();
}

export function AccountSchedulingPanel(props: AccountSchedulingPanelProps) {
  const { fileName, authIndex, initialScheduling, disabled = false, onApplied } = props;
  const { t } = useTranslation();
  const {
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
  } = useAccountSchedulingControls({ fileName, authIndex, initialScheduling, onApplied });

  const tierOptions: SelectOption[] = [
    {
      value: 'auto',
      label: t('auth_files.account_settings_scheduling_tier_auto', { defaultValue: 'Auto' }),
    },
    {
      value: 'max_20x',
      label: t('auth_files.subscription_tier_badge_max_20x', { defaultValue: 'Max 20x' }),
    },
    {
      value: 'max_5x',
      label: t('auth_files.subscription_tier_badge_max_5x', { defaultValue: 'Max 5x' }),
    },
    {
      value: 'pro',
      label: t('auth_files.subscription_tier_badge_pro', { defaultValue: 'Pro' }),
    },
  ];

  const isOverride = view?.tier_source === 'override';
  const effectiveRateScaleText = formatRateScale(view?.rate_scale);
  const controlsDisabled = disabled || saving;

  const anchorDisplay = formatAnchorDisplay(view?.first_production_at);
  const anchorStatusText = anchorDisplay
    ? t('auth_files.account_settings_scheduling_first_production_at_current', {
        value: anchorDisplay,
        defaultValue: 'Current anchor: {{value}}',
      })
    : t('auth_files.account_settings_scheduling_first_production_at_auto', {
        defaultValue: 'Auto (stamped on first serve)',
      });

  const warmup = view?.warmup;
  const warmupParts: string[] = [];
  if (warmup) {
    const stage = typeof warmup.stage === 'string' ? warmup.stage.trim() : '';
    if (stage) {
      warmupParts.push(
        t('auth_files.account_settings_scheduling_warmup_stage', {
          stage,
          defaultValue: 'Stage: {{stage}}',
        })
      );
    }
    if (typeof warmup.mature === 'boolean') {
      warmupParts.push(
        warmup.mature
          ? t('auth_files.account_settings_scheduling_warmup_mature', { defaultValue: 'Mature' })
          : t('auth_files.account_settings_scheduling_warmup_warming', {
              defaultValue: 'Warming up',
            })
      );
    }
    warmupParts.push(
      typeof warmup.age_days === 'number' && Number.isFinite(warmup.age_days)
        ? t('auth_files.account_settings_scheduling_warmup_age', {
            days: warmup.age_days,
            defaultValue: 'Age: {{days}}d',
          })
        : t('auth_files.account_settings_scheduling_warmup_age_unknown', {
            defaultValue: 'Age: not anchored',
          })
    );
  }
  const warmupStatusText = warmupParts.join(' · ');

  return (
    <div className={styles.panel} data-testid="account-settings-scheduling-panel">
      <div className={styles.panelHeader}>
        <strong>
          {t('auth_files.account_settings_scheduling_title', {
            defaultValue: 'Adaptive scheduling overrides',
          })}
        </strong>
        <span
          className={`status-badge ${isOverride ? 'success' : 'muted'}`}
          data-testid="account-settings-scheduling-tier-status"
        >
          {isOverride
            ? t('auth_files.account_settings_scheduling_tier_manual_badge', {
                defaultValue: 'Manual tier override',
              })
            : t('auth_files.account_settings_scheduling_tier_auto_badge', {
                defaultValue: 'Auto-detected tier',
              })}
        </span>
      </div>

      <div className={styles.controlsGrid}>
        <div className={styles.row}>
          <label htmlFor="account-scheduling-tier-select">
            {t('auth_files.account_settings_scheduling_tier_label', {
              defaultValue: 'Subscription tier override',
            })}
          </label>
          <Select
            id="account-scheduling-tier-select"
            value={tierOverride}
            options={tierOptions}
            onChange={(value) => setTierOverride(value as AccountTierOverrideChoice)}
            disabled={controlsDisabled}
            ariaLabel={t('auth_files.account_settings_scheduling_tier_label', {
              defaultValue: 'Subscription tier override',
            })}
            fullWidth
          />
          <div className="hint">
            {t('auth_files.account_settings_scheduling_tier_hint', {
              defaultValue:
                'Auto detects the tier from the upstream plan. Picking a tier forces it for scheduling regardless of what auto-detection would resolve to; pick Auto to clear the override.',
            })}
          </div>
        </div>

        <div className={styles.row}>
          <Input
            label={t('auth_files.account_settings_scheduling_rate_scale_label', {
              defaultValue: 'Rate scale',
            })}
            type="number"
            step={0.1}
            min={0}
            placeholder="1.0"
            value={rateScaleText}
            disabled={controlsDisabled}
            data-testid="account-settings-scheduling-rate-scale-input"
            onChange={(e) => setRateScaleText(e.target.value)}
            hint={t('auth_files.account_settings_scheduling_rate_scale_hint', {
              defaultValue: 'Test-only rate multiplier; 1.0 = no effect.',
            })}
            error={rateScaleError ?? undefined}
            rightElement={
              <Button
                type="button"
                variant="ghost"
                size="xs"
                data-testid="account-settings-scheduling-rate-scale-reset"
                disabled={controlsDisabled || rateScaleText.trim() === ''}
                onClick={() => setRateScaleText('')}
              >
                {t('auth_files.account_settings_scheduling_rate_scale_reset', {
                  defaultValue: 'Reset to default',
                })}
              </Button>
            }
          />
        </div>
      </div>

      <div className={styles.row}>
        <Input
          label={t('auth_files.account_settings_scheduling_first_production_at_label', {
            defaultValue: 'First production date (warm-up anchor)',
          })}
          type="datetime-local"
          max={nowDatetimeLocal()}
          value={firstProductionAtText}
          disabled={controlsDisabled}
          data-testid="account-settings-scheduling-first-production-at-input"
          onChange={(e) => setFirstProductionAtText(e.target.value)}
          hint={t('auth_files.account_settings_scheduling_first_production_at_hint', {
            defaultValue:
              'Only for migrating an account that was already serving in production before adaptive scheduling to its real first-serve date. Setting it earlier than reality makes the account look overly mature and skips warm-up (ban risk). If unsure, leave empty = auto warm-up as a new account.',
          })}
          error={firstProductionAtError ?? undefined}
          rightElement={
            <Button
              type="button"
              variant="ghost"
              size="xs"
              data-testid="account-settings-scheduling-first-production-at-clear"
              disabled={controlsDisabled || firstProductionAtText.trim() === ''}
              onClick={() => setFirstProductionAtText('')}
            >
              {t('auth_files.account_settings_scheduling_first_production_at_clear', {
                defaultValue: 'Clear / restore auto',
              })}
            </Button>
          }
        />
        <div
          className={styles.effectiveState}
          data-testid="account-settings-scheduling-first-production-at-status"
        >
          <span>{anchorStatusText}</span>
          {warmupStatusText && <span>{warmupStatusText}</span>}
        </div>
      </div>

      {errorMessage && (
        <div className="error-box" data-testid="account-settings-scheduling-error">
          {errorMessage}
          {legalTierValues && legalTierValues.length > 0 && (
            <span data-testid="account-settings-scheduling-legal-values">
              {' '}
              {legalTierValues.join(', ')}
            </span>
          )}
        </div>
      )}

      <div className={styles.footer}>
        <span className={styles.effectiveState} data-testid="account-settings-scheduling-effective">
          {t('auth_files.account_settings_scheduling_effective_rate', {
            rate: effectiveRateScaleText,
            defaultValue: 'Effective rate scale: {{rate}}',
          })}
        </span>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => void applyScheduling()}
          loading={saving}
          disabled={
            controlsDisabled || !dirty || Boolean(rateScaleError) || Boolean(firstProductionAtError)
          }
          data-testid="account-settings-scheduling-apply"
        >
          {t('auth_files.account_settings_scheduling_apply', { defaultValue: 'Apply scheduling' })}
        </Button>
      </div>
    </div>
  );
}
