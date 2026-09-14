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
import { useState } from 'react';
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

/** 生效上限里的普通数值（rpm/突发/并发）：非有限数（含缺失）显示 "--"，不臆造。 */
function formatEffectiveLimitNumber(value: number | undefined, locale: string): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '--';
  try {
    return new Intl.NumberFormat(locale).format(value);
  } catch {
    return String(value);
  }
}

/**
 * 日预算类字段（daily_budget / token_daily_budget）：core 用 0 表示「无上限」
 * （通常是已走出养号曲线的成熟号），必须显示成 unlimitedText 而不是裸 0——
 * 裸 0 会被误读成「预算已耗尽/额度为 0」。缺失（非有限数）时保守显示 "--"，
 * 不等同于「无限制」（避免把「不知道」臆造成「没有上限」）。
 */
function formatEffectiveBudget(
  value: number | undefined,
  locale: string,
  unlimitedText: string
): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '--';
  if (value === 0) return unlimitedText;
  try {
    return new Intl.NumberFormat(locale).format(value);
  } catch {
    return String(value);
  }
}

/**
 * 解析 rate_scale 输入框文本为一个「可用于现算预览」的正有限数；空 / 非数字 /
 * <= 0 / 非有限（Infinity/NaN）一律返回 null——预览行据此整行不渲染，不臆造。
 * 与 useAccountSchedulingControls 内部的 parseRateScaleInput 同一套合法性判断，
 * 但这里只需要数值本身（不需要区分 clear/invalid），故不复用其判别式类型。
 */
function parsePreviewRateScale(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const numeric = Number(trimmed);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

/**
 * 镜像 core `scaleLimitRPM`/`scaleLimitRPMInt`（sdk/cliproxy/auth/account_rate_scale.go
 * + account_effective_limits.go）：rpm 上限只四舍五入，不做「正值下限钳到 1」；
 * base <= 0（未配置上限）原样透传，不参与缩放。
 */
function scaleRpmLike(base: number, scale: number): number {
  if (base <= 0) return base;
  return Math.round(base * scale);
}

/**
 * 镜像 core `scaleLimitInt`（同上文件）：四舍五入后正值下限钳到 1（乘子再小也不会
 * 把账号焊死在永久 0 上限）；base <= 0（0 = 无限制/未配置）原样透传，不参与缩放。
 * 突发 / 并发 / 日预算三个字段都走这条路径。
 */
function scaleIntLike(base: number, scale: number): number {
  if (base <= 0) return base;
  const scaled = Math.round(base * scale);
  return scaled < 1 ? 1 : scaled;
}

/**
 * 反推「突发（burst）」的 PRE-scale 基准值。warmup 投影不下发 burst 基准（core
 * 该字段只在 effective_limits 里，且已经乘过*当前已保存*的 rate_scale），只能
 * 用 `effective_limits.burst / 已保存的 rate_scale` 近似反推——注意这是估算，
 * 如果已保存 rate_scale 曾经小到让 core 的「正值下限钳到 1」生效，反推值会比
 * 真实基准偏大，仅供预览参考，不作为权威值。
 * `effective_limits.burst === 0`（无限制，未参与缩放）时原样返回 0，不除。
 * 已保存 rate_scale 缺失/非有限/<= 0（除零风险）时返回 null，调用方据此不渲染
 * 突发这一项（显示 "--"），不臆造。
 */
function deriveBaseBurst(
  effectiveBurst: number | undefined,
  savedRateScale: number | undefined
): number | null {
  if (typeof effectiveBurst !== 'number' || !Number.isFinite(effectiveBurst)) return null;
  if (effectiveBurst === 0) return 0;
  if (typeof savedRateScale !== 'number' || !Number.isFinite(savedRateScale) || savedRateScale <= 0) {
    return null;
  }
  return Math.round(effectiveBurst / savedRateScale);
}

/** rate_scale 输入框正下方「客户端实时预览」的现算结果；任一字段为 null 时该字段渲染 "--"。 */
interface RateScalePreview {
  rpm: number;
  burst: number | null;
  concurrency: number;
  dailyBudget: number;
}

/**
 * 现算「这个乘子会带来的生效上限」——rate_scale 输入框正下方的实时预览，纯客户端
 * 估算，不等保存、不发请求。基准值必须来自 warmup（PRE-scale 原始值，见
 * AuthFileAccountWarmup 类型注释）；warmup 整块缺失（老 core 未投影）时返回 null，
 * 调用方据此整行不渲染（优雅降级，与 effective_limits 同款约定）。
 */
function computeRateScalePreview(
  warmup: AuthFileAccountScheduling['warmup'] | null | undefined,
  effectiveLimits: AuthFileAccountScheduling['effective_limits'] | null | undefined,
  savedRateScale: number | undefined,
  inputScale: number
): RateScalePreview | null {
  const rpmBase = warmup?.rpm_limit;
  const concurrencyBase = warmup?.concurrency_limit;
  const dailyBudgetBase = warmup?.daily_budget;
  if (
    typeof rpmBase !== 'number' ||
    !Number.isFinite(rpmBase) ||
    typeof concurrencyBase !== 'number' ||
    !Number.isFinite(concurrencyBase) ||
    typeof dailyBudgetBase !== 'number' ||
    !Number.isFinite(dailyBudgetBase)
  ) {
    return null;
  }
  const baseBurst = deriveBaseBurst(effectiveLimits?.burst, savedRateScale);
  return {
    rpm: scaleRpmLike(rpmBase, inputScale),
    burst: baseBurst == null ? null : scaleIntLike(baseBurst, inputScale),
    concurrency: scaleIntLike(concurrencyBase, inputScale),
    dailyBudget: scaleIntLike(dailyBudgetBase, inputScale),
  };
}

/** 把一个 Date 格式化成 `<input type="datetime-local">` 的本地 wall-clock 值（分钟精度）。 */
function toDatetimeLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 当前本地时间的 datetime-local 值，用作 first_production_at 输入的 `max`（禁未来）。 */
function nowDatetimeLocal(): string {
  return toDatetimeLocal(new Date());
}

/**
 * 把候选投影里的 RFC3339 时间戳转成 datetime-local 输入值（分钟精度）。缺失 /
 * null / 非法一律回 null（调用方据此不渲染该候选按钮，优雅降级），不臆造时间。
 */
function rfc3339ToDatetimeLocal(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return toDatetimeLocal(new Date(ms));
}

/** 首次投产锚点的「一键候选」视图模型（最近活动 / 首次认证 / 当前时间）。 */
interface AnchorCandidate {
  key: string;
  testId: string;
  labelText: string;
  /** 点选后写入输入框的 datetime-local 值。 */
  datetimeLocal: string;
  /** 按钮上展示的可读时间（`YYYY-MM-DD HH:mm`）。 */
  displayText: string;
  variant: 'primary' | 'secondary' | 'ghost';
}

export function AccountSchedulingPanel(props: AccountSchedulingPanelProps) {
  const { fileName, authIndex, initialScheduling, disabled = false, onApplied } = props;
  const { t, i18n } = useTranslation();
  const locale = i18n?.language || i18n?.resolvedLanguage || 'en';
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

  // 「清除锚点」是破坏性且不可撤销的（清空 = 回落自动铸造，丢弃当前锚点值且找不回
  // 原值），做成两步确认防手滑：第一次点武装成「确认清除?」，第二次点才真正清空。
  // 任何让输入值改变的动作（手动改日期 / 设为当前时间）都会解除武装。
  // 空值时根本不渲染「清除」按钮（没有可清的值），改为在原位显示「当前已是自动」状态
  // 文字——避免出现一个变灰的按钮让用户误以为「无法恢复默认」。
  const hasFirstProductionValue = firstProductionAtText.trim() !== '';
  const [clearArmed, setClearArmed] = useState(false);
  const showClearConfirm = clearArmed && hasFirstProductionValue && !controlsDisabled;

  const handleFirstProductionChange = (value: string) => {
    setClearArmed(false);
    setFirstProductionAtText(value);
  };
  const handleSetNow = () => {
    handleFirstProductionChange(nowDatetimeLocal());
  };
  const handleClearClick = () => {
    if (!showClearConfirm) {
      setClearArmed(true);
      return;
    }
    setClearArmed(false);
    setFirstProductionAtText('');
  };

  const clearTooltip = t('auth_files.account_settings_scheduling_first_production_at_clear_tooltip', {
    defaultValue:
      'Clearing resets the anchor to auto (re-stamped with the actual time on the next successful serve). It does not restore the previous value.',
  });

  // 「候选锚点一键选择」：把这个账号真实拥有的、贴近服务锚点语义的时间戳摆出来，
  // 点一下就把日期输入设成该值（走现有 Apply → PATCH set 路径），免手打/猜。候选值
  // 来自只读投影 `initialScheduling.anchor_candidates`（账号事实，不随 tier/rate 编辑
  // 变化，也不因一次 Apply 后 echo 省略而丢失，所以读原始基线 prop 而非可变 view）。
  // 主候选是 high-water 的「最近活动」（last_activity_at）——底层是 CLI 设备版本高水位、
  // 仅版本升级时更新，非逐次服务：只用过一个版本的号 ≈ 首次服务，升级过的老号可能偏晚。
  // 某候选缺失时不渲染那个按钮；「当前时间」永远有（前端本地算，不依赖投影）。刻意不含
  // 「Anthropic 账号创建时间」——那会虚高成熟度、skip 养号（封号风险）。
  const anchorCandidateSource = initialScheduling?.anchor_candidates;
  const anchorCandidates: AnchorCandidate[] = [];
  const lastActivityLocal = rfc3339ToDatetimeLocal(anchorCandidateSource?.last_activity_at);
  if (lastActivityLocal) {
    anchorCandidates.push({
      key: 'last-activity',
      testId: 'account-settings-scheduling-first-production-at-candidate-last-activity',
      // 最贴锚点语义 → 推荐候选，用 primary 变体高亮。后端投影是 high-water 的
      // last_activity_at（CLI 设备版本高水位、仅版本升级时更新），只用过一个版本的号
      // ≈ 首次服务，升级过的老号可能偏晚。
      labelText: t('auth_files.account_settings_scheduling_first_production_at_candidate_last_activity', {
        defaultValue: 'Last activity',
      }),
      datetimeLocal: lastActivityLocal,
      displayText: lastActivityLocal.replace('T', ' '),
      variant: 'primary',
    });
  }
  const firstAuthLocal = rfc3339ToDatetimeLocal(anchorCandidateSource?.first_auth_at);
  if (firstAuthLocal) {
    anchorCandidates.push({
      key: 'first-auth',
      testId: 'account-settings-scheduling-first-production-at-candidate-first-auth',
      labelText: t('auth_files.account_settings_scheduling_first_production_at_candidate_first_auth', {
        defaultValue: 'First authenticated',
      }),
      datetimeLocal: firstAuthLocal,
      displayText: firstAuthLocal.replace('T', ' '),
      variant: 'secondary',
    });
  }
  // 「当前时间」候选恒在（不依赖投影数据）。
  const nowLocal = nowDatetimeLocal();
  anchorCandidates.push({
    key: 'now',
    testId: 'account-settings-scheduling-first-production-at-candidate-now',
    labelText: t('auth_files.account_settings_scheduling_first_production_at_candidate_now', {
      defaultValue: 'Current time',
    }),
    datetimeLocal: nowLocal,
    displayText: nowLocal.replace('T', ' '),
    variant: 'ghost',
  });

  // 锚点状态回显基于「待应用的输入值」而非 view：清空输入后立即显示「自动」，不残留
  // 已应用但尚未清除的旧锚点，避免和输入框 / 清除动作自相矛盾。有值 → 显示当前锚点；
  // 空值 → 由「设为当前时间」旁的内联「当前已是自动」文字承载（见下方 fieldActions），
  // 状态行只留 warmup。warmup 仍来自 view（服务端计算的既有养号状态）。
  const anchorStatusText = hasFirstProductionValue
    ? t('auth_files.account_settings_scheduling_first_production_at_current', {
        value: firstProductionAtText.replace('T', ' '),
        defaultValue: 'Current anchor: {{value}}',
      })
    : null;
  const autoStatusText = t('auth_files.account_settings_scheduling_first_production_at_auto', {
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

  // 「当前生效上限」：rate_scale 已经乘完的实际上限，免用户自己心算「乘子 ×
  // 基础上限」。additive 投影，老 core 未下发时 effective_limits 整体缺失，
  // 此时不渲染这块（不展示空/0 误导用户）。
  const effectiveLimits = view?.effective_limits ?? null;
  const hasEffectiveLimits = effectiveLimits != null && typeof effectiveLimits === 'object';
  const effectiveUnlimitedText = t('auth_files.account_settings_scheduling_effective_unlimited', {
    defaultValue: 'unlimited',
  });
  const effectiveLimitsText = hasEffectiveLimits
    ? t('auth_files.account_settings_scheduling_effective_limits_label', {
        rpm: formatEffectiveLimitNumber(effectiveLimits?.rpm, locale),
        burst: formatEffectiveLimitNumber(effectiveLimits?.burst, locale),
        concurrency: formatEffectiveLimitNumber(effectiveLimits?.concurrency, locale),
        dailyBudget: formatEffectiveBudget(effectiveLimits?.daily_budget, locale, effectiveUnlimitedText),
        tokenDailyBudget: formatEffectiveBudget(
          effectiveLimits?.token_daily_budget,
          locale,
          effectiveUnlimitedText
        ),
        defaultValue:
          'Effective limits: rpm {{rpm}} · burst {{burst}} · concurrency {{concurrency}} · daily budget {{dailyBudget}} · token daily budget {{tokenDailyBudget}}',
      })
    : null;
  // 养号号（pacing_applies=true）：这里的 rpm 只是上限，实际 rpm 可能被动态
  // 压速进一步降低，加一行小字提示避免用户误以为 rpm 就是恒定实际速率。
  const showEffectivePacingNote = hasEffectiveLimits && effectiveLimits?.pacing_applies === true;

  // rate_scale 输入框正下方的「客户端实时预览」：随输入现算「这个乘子会带来的
  // 生效上限」，不用保存就能看到（与 footer 那个读「已保存值」的 effective_limits
  // 并存不冲突，标「未保存」区分）。输入非法（空/<=0/非有限）或 warmup 基准缺失
  // （老 core 未投影）时整行不渲染，不臆造。
  const previewInputScale = parsePreviewRateScale(rateScaleText);
  const ratePreview =
    previewInputScale != null
      ? computeRateScalePreview(warmup, effectiveLimits, view?.rate_scale, previewInputScale)
      : null;
  const ratePreviewText = ratePreview
    ? t('auth_files.account_settings_scheduling_rate_scale_preview', {
        rpm: formatEffectiveLimitNumber(ratePreview.rpm, locale),
        burst: formatEffectiveLimitNumber(ratePreview.burst ?? undefined, locale),
        concurrency: formatEffectiveLimitNumber(ratePreview.concurrency, locale),
        dailyBudget: formatEffectiveBudget(ratePreview.dailyBudget, locale, effectiveUnlimitedText),
        defaultValue:
          'Preview (unsaved): rpm {{rpm}} · burst {{burst}} · concurrency {{concurrency}} · daily budget {{dailyBudget}}',
      })
    : null;

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
          />
          {/* 实时预览：随输入现算「这个乘子会带来的生效上限」，不用保存/不发请求就能看到。
              客户端估算（标「未保存」区分 footer 那个读已保存值的 effective_limits），输入
              非法或 warmup 基准缺失（老 core 未投影）时整行不渲染，不臆造。 */}
          {ratePreviewText && (
            <div className="hint" data-testid="account-settings-scheduling-rate-scale-preview">
              {ratePreviewText}
            </div>
          )}
          {/* 「恢复默认」按钮移出 Input 的 48px 绝对定位 rightElement 悬浮槽（那会盖住
              数字步进器），改放输入框下方独立一行的常规 flow 布局。 */}
          <div className={styles.fieldActions}>
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
          </div>
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
          onChange={(e) => handleFirstProductionChange(e.target.value)}
          hint={t('auth_files.account_settings_scheduling_first_production_at_hint', {
            defaultValue:
              'Empty = auto warm-up as a new account (the default for new accounts). To migrate an account that was already serving in production before adaptive scheduling, set its real serve time by picking a candidate above: "Last activity" = derived from this account\'s CLI device-version changes (for an account that only ever used one version this ≈ its first serve; for an upgraded older account it may be later than the true first serve); "First authenticated" = the current identity assignment time (updated after an identity rotation), not strictly the first-ever authentication; "Current time" = stamp now. Setting it earlier than reality makes the account look overly mature and skips warm-up (ban risk) — when unsure, use "Last activity" or "Current time", or leave it empty. "Clear" resets it back to auto.',
          })}
          error={firstProductionAtError ?? undefined}
        />
        {/* 候选锚点一键选择：展示该账号真实拥有的时间戳（最近活动 / 首次认证 /
            当前时间），点一下就把日期输入设成对应值，免手打/猜。每个按钮显示
            含义标签 + 具体时间，让用户看清在选什么；点选走现有 Apply → PATCH set。 */}
        <div
          className={styles.candidates}
          data-testid="account-settings-scheduling-first-production-at-candidates"
        >
          <span className={styles.candidatesLabel}>
            {t('auth_files.account_settings_scheduling_first_production_at_candidates_label', {
              defaultValue: 'Pick a timestamp this account already has:',
            })}
          </span>
          <div className={styles.candidateButtons}>
            {anchorCandidates.map((candidate) => (
              <Button
                key={candidate.key}
                type="button"
                variant={candidate.variant}
                size="xs"
                data-testid={candidate.testId}
                title={`${candidate.labelText} · ${candidate.displayText}`}
                disabled={controlsDisabled}
                onClick={() => handleFirstProductionChange(candidate.datetimeLocal)}
              >
                {candidate.labelText}
                <span className={styles.candidateTime}> · {candidate.displayText}</span>
              </Button>
            ))}
          </div>
        </div>
        {/* 「设为当前时间」和「清除」都移出 Input 的绝对定位 rightElement 悬浮槽（那会
            盖住原生日期/日历选择器），改放输入框下方独立一行；清除做成两步确认（破坏性、
            不可撤销）以区别于设为当前时间与手动选日期。空值时不渲染「清除」按钮，改在
            原位显示「当前已是自动」状态文字，避免变灰按钮被误读成坏掉的「恢复」。 */}
        <div className={styles.fieldActions}>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            data-testid="account-settings-scheduling-first-production-at-set-now"
            disabled={controlsDisabled}
            onClick={handleSetNow}
          >
            {t('auth_files.account_settings_scheduling_first_production_at_set_now', {
              defaultValue: 'Set to now',
            })}
          </Button>
          {hasFirstProductionValue ? (
            <Button
              type="button"
              variant={showClearConfirm ? 'danger' : 'ghost'}
              size="xs"
              data-testid="account-settings-scheduling-first-production-at-clear"
              title={clearTooltip}
              disabled={controlsDisabled}
              onClick={handleClearClick}
            >
              {showClearConfirm
                ? t('auth_files.account_settings_scheduling_first_production_at_clear_confirm', {
                    defaultValue: 'Confirm clear?',
                  })
                : t('auth_files.account_settings_scheduling_first_production_at_clear', {
                    defaultValue: 'Clear',
                  })}
            </Button>
          ) : (
            <span
              className={styles.autoStatus}
              data-testid="account-settings-scheduling-first-production-at-auto-status"
            >
              {autoStatusText}
            </span>
          )}
        </div>
        <div
          className={styles.effectiveState}
          data-testid="account-settings-scheduling-first-production-at-status"
        >
          {hasFirstProductionValue && anchorStatusText && <span>{anchorStatusText}</span>}
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
        <div className={styles.effectiveState} data-testid="account-settings-scheduling-effective">
          <span>
            {t('auth_files.account_settings_scheduling_effective_rate', {
              rate: effectiveRateScaleText,
              defaultValue: 'Effective rate scale: {{rate}}',
            })}
          </span>
          {/* effective_limits 是 additive 投影，老 core 未下发时 effectiveLimitsText
              为 null，这块连同下面的养号压速提示一起不渲染（优雅降级）。 */}
          {effectiveLimitsText && (
            <span data-testid="account-settings-scheduling-effective-limits">
              {effectiveLimitsText}
            </span>
          )}
          {showEffectivePacingNote && (
            <span data-testid="account-settings-scheduling-effective-limits-pacing-note">
              {t('auth_files.account_settings_scheduling_effective_pacing_note', {
                defaultValue:
                  'Warm-up account: actual rpm may be further reduced by dynamic pacing.',
              })}
            </span>
          )}
        </div>
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
