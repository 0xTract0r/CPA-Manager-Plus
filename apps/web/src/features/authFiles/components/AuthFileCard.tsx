import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { SelectionCheckbox } from '@/components/ui/SelectionCheckbox';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import {
  IconBot,
  IconDownload,
  IconInfo,
  IconKey,
  IconModelCluster,
  IconRefreshCw,
  IconSettings,
  IconShield,
  IconTrash2,
} from '@/components/ui/icons';
import { ProviderStatusBar } from '@/components/providers/ProviderStatusBar';
import type { AuthFileItem, ClaudeQuotaState, CodexQuotaState } from '@/types';
import { resolveAuthProvider } from '@/utils/quota';
import {
  normalizeRecentRequestAuthIndex,
  normalizeRecentRequestBuckets,
  normalizeUsageTotal,
  statusBarDataFromRecentRequests,
} from '@/utils/recentRequests';
import { formatDateTime, formatFileSize, formatUnixTimestamp } from '@/utils/format';
import {
  QUOTA_PROVIDER_TYPES,
  formatModified,
  getAuthFileAutoQuarantined,
  getAuthFileQuarantineReason,
  getAuthFileQuarantinedAt,
  getAuthFileStatusMessage,
  getTypeColor,
  getTypeLabel,
  isAuthFileMissingProxyUrl,
  isAuthFileReauthRequired,
  isRuntimeOnlyAuthFile,
  normalizeProviderKey,
  parsePriorityValue,
  type QuotaProviderType,
  type ResolvedTheme,
} from '@/features/authFiles/constants';
import type { AuthFileStatusBarData } from '@/features/authFiles/hooks/useAuthFilesStatusBarCache';
import type { AntigravitySubscriptionState } from '@/features/authFiles/hooks/useAntigravitySubscriptions';
import type { AuthFileCodexStatusBadge } from '@/features/authFiles/model/authFilesPageModel';
import type { QuotaCooldownInfo } from '@/services/api/usageService';
import {
  resolveAuthFileOAuthProvider,
  supportsAuthFileReauthCallback,
  type AuthFileReauthState,
} from '@/features/authFiles/hooks/useAuthFilesReauth';
import { AccountSpeedReadings } from '@/features/authFiles/components/AccountSpeedReadings';
import { AccountSessionSummary } from '@/features/authFiles/components/AccountSessionSummary';
import { deriveSubscriptionTierBadge } from '@/features/authFiles/model/accountSessionSummary';
import { AuthFileQuotaSection } from '@/features/authFiles/components/AuthFileQuotaSection';
import styles from '@/features/authFiles/AuthFilesPage.module.scss';
import reauthStyles from '@/features/authFiles/components/AuthFileReauthInline.module.scss';

const HEALTHY_STATUS_MESSAGES = new Set(['ok', 'healthy', 'ready', 'success', 'available']);

// P7（account-session-count-display）：细粒度订阅等级徽标的英文 defaultValue
// 兜底文案（i18n 资源未加载/未翻译时的最后一道回退），键与
// deriveSubscriptionTierBadge 返回的 tier 值一一对应，人类可读而非裸枚举值。
const SUBSCRIPTION_TIER_BADGE_DEFAULT_LABELS: Record<string, string> = {
  max_20x: 'Max 20x',
  max_5x: 'Max 5x',
  pro: 'Pro',
  plus: 'Plus',
  unknown: 'Unknown',
};

export type AuthFileCardProps = {
  file: AuthFileItem;
  compact: boolean;
  selected: boolean;
  resolvedTheme: ResolvedTheme;
  disableControls: boolean;
  deleting: string | null;
  statusUpdating: Record<string, boolean>;
  /** 迁移自旧版：逐账号「刷新状态」按钮的 loading 态，key 为 file.name。 */
  statusRefreshing?: Record<string, boolean>;
  /** 迁移自旧版：逐账号「测试消息」按钮的 loading 态，key 为 file.name。 */
  messageTesting?: Record<string, boolean>;
  statusBarCache: Map<string, AuthFileStatusBarData>;
  codexStatusBadges?: AuthFileCodexStatusBadge[];
  codexNeedsReauth?: boolean;
  codexDisplayQuota?: CodexQuotaState;
  /** core `GET /quota/snapshots` observed 兜底状态；Claude 没有请求头 usage snapshot 源，只靠 core 快照。 */
  claudeDisplayQuota?: ClaudeQuotaState;
  antigravitySubscription?: AntigravitySubscriptionState;
  onRefreshAntigravitySubscription?: (file: AuthFileItem) => void;
  quotaCooldown?: QuotaCooldownInfo;
  onShowModels: (file: AuthFileItem) => void;
  onReauth?: (file: AuthFileItem) => void;
  /**
   * 迁移自旧版：非 codex OAuth 账号的通用「重新认证」inline 流程状态与回调。
   * codex 仍走既有 CodexReauthDialog（onReauth），这些 props 只服务通用流程。
   */
  reauthState?: AuthFileReauthState;
  onReauthenticate?: (file: AuthFileItem) => void;
  onCopyReauthLink?: (fileName: string) => void;
  onCancelReauth?: (fileName: string) => void;
  onChangeReauthCallbackUrl?: (fileName: string, callbackUrl: string) => void;
  onSubmitReauthCallback?: (fileName: string) => void;
  /** 迁移自旧版：逐账号手动触发一次状态检查刷新（core /auth-files/refresh-status）。 */
  onRefreshStatus?: (file: AuthFileItem) => void;
  /** 迁移自旧版：逐账号发送一次测试消息，验证账号是否能正常出请求。 */
  onTestMessage?: (file: AuthFileItem) => void;
  onDownload: (name: string) => void;
  /** 打开统一「账号设置」弹窗（含基础路由配置 / 身份模型 / 出站指纹 / 身份变更审计）。 */
  onOpenAccountSettings: (file: AuthFileItem) => void;
  onDelete: (name: string) => void;
  onToggleStatus: (file: AuthFileItem, enabled: boolean) => void;
  onToggleSelect: (name: string) => void;
};

const resolveQuotaType = (file: AuthFileItem): QuotaProviderType | null => {
  const provider = resolveAuthProvider(file);
  if (!QUOTA_PROVIDER_TYPES.has(provider as QuotaProviderType)) return null;
  return provider as QuotaProviderType;
};

const getProjectIdValue = (file: AuthFileItem): string => {
  const raw =
    file.project_id ?? file.projectId ?? file.gemini_virtual_project ?? file.geminiVirtualProject;
  return typeof raw === 'string' ? raw.trim() : '';
};

export function AuthFileCard(props: AuthFileCardProps) {
  const { t } = useTranslation();
  const {
    file,
    compact,
    selected,
    resolvedTheme,
    disableControls,
    deleting,
    statusUpdating,
    statusRefreshing = {},
    messageTesting = {},
    statusBarCache,
    codexStatusBadges = [],
    codexNeedsReauth = false,
    codexDisplayQuota,
    claudeDisplayQuota,
    antigravitySubscription,
    onRefreshAntigravitySubscription,
    quotaCooldown,
    onShowModels,
    onReauth,
    reauthState,
    onReauthenticate,
    onCopyReauthLink,
    onCancelReauth,
    onChangeReauthCallbackUrl,
    onSubmitReauthCallback,
    onRefreshStatus,
    onTestMessage,
    onDownload,
    onOpenAccountSettings,
    onDelete,
    onToggleStatus,
    onToggleSelect,
  } = props;

  const recentBuckets = normalizeRecentRequestBuckets(file.recent_requests ?? file.recentRequests);
  const fileStats = {
    success: normalizeUsageTotal(file.success),
    failure: normalizeUsageTotal(file.failed),
  };
  const isRuntimeOnly = isRuntimeOnlyAuthFile(file);
  const resolvedProvider = resolveAuthProvider(file);
  const providerKey = normalizeProviderKey(String(file.type ?? file.provider ?? 'unknown'));
  const isAntigravity = resolvedProvider === 'antigravity';
  const isAistudio = providerKey === 'aistudio';
  const showModelsButton = !isRuntimeOnly || isAistudio;
  const typeColor = getTypeColor(providerKey, resolvedTheme);
  const typeLabel = getTypeLabel(t, providerKey);

  const quotaType = resolveQuotaType(file);
  const showQuotaLayout = Boolean(quotaType) && !isRuntimeOnly && !compact;

  const providerCardClass =
    quotaType === 'antigravity'
      ? styles.antigravityCard
      : quotaType === 'claude'
        ? styles.claudeCard
        : quotaType === 'codex'
          ? styles.codexCard
          : quotaType === 'kimi'
            ? styles.kimiCard
            : '';

  const rawAuthIndex = file['auth_index'] ?? file.authIndex;
  const authIndexKey = normalizeRecentRequestAuthIndex(rawAuthIndex);
  const statusData =
    (authIndexKey && statusBarCache.get(authIndexKey)) ||
    statusBarDataFromRecentRequests(recentBuckets);
  const rawStatusMessage = getAuthFileStatusMessage(file);
  const hasStatusWarning =
    Boolean(rawStatusMessage) && !HEALTHY_STATUS_MESSAGES.has(rawStatusMessage.toLowerCase());

  // 自动隔离态（同款迁移自 apps/web telemetry-farm-ux-hardening T3）：优先按
  // file.auto_quarantined 布尔判定，不单独按 status_message 文本分支——core 侧
  // 复核指出该字段与 status_message/unavailable 可能短暂不一致（清隔离锁与
  // status 落库非原子），布尔更稳，且徽标此前完全没读这个字段，会显示假绿。
  const isAutoQuarantined = getAuthFileAutoQuarantined(file);
  // 「需重新认证」纵深防御信号（reauth_url / reauth_required）：即便账号未被隔离、
  // unavailable 尚未置 true，只要带 reauth 信号也必须显式呈现「需重新认证」而非假绿。
  // 本卡片的 hasStatusWarning 仅由 status_message 文本推导，不含结构化 reauth 信号，
  // 故这里单独接线，避免带 reauth_url 的死 token 账号在卡片上仍显绿色启用态。
  const isReauthRequired = isAuthFileReauthRequired(file);
  const quarantineReasonRaw = getAuthFileQuarantineReason(file);
  const quarantineReasonLabel = quarantineReasonRaw
    ? t(`auth_files.quarantine_reason_${quarantineReasonRaw}`, {
        defaultValue: quarantineReasonRaw,
      })
    : t('auth_files.quarantine_reason_unknown', { defaultValue: 'unknown reason' });
  const quarantinedAtRaw = getAuthFileQuarantinedAt(file);
  const quarantinedAtLabel = quarantinedAtRaw
    ? formatDateTime(quarantinedAtRaw)
    : t('auth_files.quarantine_time_unknown', { defaultValue: 'unknown time' });
  const quarantineBadgeTitle = isAutoQuarantined
    ? t('auth_files.quarantine_badge_title', {
        reason: quarantineReasonLabel,
        at: quarantinedAtLabel,
        defaultValue:
          'Auto-quarantined: {{reason}} · {{at}}. Please re-authenticate to restore this account.',
      })
    : '';
  // 无健康数据（成功/失败均为 0）时不占整块 HEALTH 面板，改成一行紧凑占位。
  const hasStatusData = statusData.totalSuccess + statusData.totalFailure > 0;

  // 卡片头部健康 pill（点⑤）：把原本埋在卡片中部 HEALTH 面板的近期请求成败数据
  // 提到头部，一眼可见，不用滚动。复用同一 statusData，语义分层：
  //  - warning：隔离 / 需重认证 / 有近期失败 / 结构化告警。
  //  - healthy：有近期成功且无上述告警。
  //  - neutral：无近期数据（或虚拟占位卡不渲染）。
  const headerHealthTone: 'healthy' | 'warning' | 'neutral' = isRuntimeOnly
    ? 'neutral'
    : isAutoQuarantined || isReauthRequired || hasStatusWarning || statusData.totalFailure > 0
      ? 'warning'
      : statusData.totalSuccess > 0
        ? 'healthy'
        : 'neutral';
  const headerHealthPillClass =
    headerHealthTone === 'healthy'
      ? styles.healthPillHealthy
      : headerHealthTone === 'warning'
        ? styles.healthPillWarning
        : styles.healthPillNeutral;
  const headerHealthPillText = hasStatusData
    ? t('auth_files.card_health_pill_counts', {
        success: statusData.totalSuccess,
        failure: statusData.totalFailure,
        defaultValue: '✓ {{success}} · ✗ {{failure}}',
      })
    : t('auth_files.card_health_pill_no_data', { defaultValue: 'No recent data' });
  const headerHealthPillTitle = t('auth_files.card_health_pill_title', {
    success: statusData.totalSuccess,
    failure: statusData.totalFailure,
    defaultValue: 'Recent request health: {{success}} success / {{failure}} failure',
  });

  // 隔离/异常原因常驻可见文本的第二行：接线 recent_requests 的 Failed 计数
  // （与卡片下方 HEALTH 面板同一数据源 statusData.totalFailure，避免展示口径
  // 不一致）。core 未投影具体 last_error 码，这里只做「原因 + 失败次数」两级，
  // 不臆造更细的错误码。
  const recentFailureCount = statusData.totalFailure;
  const recentFailureCountLabel =
    recentFailureCount > 0
      ? t('auth_files.recent_failure_count', {
          failures: recentFailureCount,
          defaultValue: 'Recent failures: {{failures}}',
        })
      : '';

  // 缺失 proxy_url（住宅代理）告警：core#26/#27 把空 proxy_url 账号标为不可用并下发 warnings。
  // 对照旧版卡片，用醒目橙色徽标 + tooltip 提示，避免请求直连暴露真实 IP。
  const missingProxyUrl = isAuthFileMissingProxyUrl(file);
  const missingProxyBadgeTitle = missingProxyUrl
    ? t('auth_files.proxy_url_missing_marker', {
        defaultValue:
          'Missing proxy_url: this account is unavailable until a residential proxy is set, otherwise requests would expose your real IP.',
      })
    : '';

  // 迁移自旧版：逐账号「刷新状态」「测试消息」按钮的可用性判定。
  // 两者都只对非虚拟且已启用的账号开放；刷新状态额外要求当前处于告警态才展示，
  // 避免对健康账号也铺满操作按钮。
  const canRefreshStatus = !isRuntimeOnly && hasStatusWarning && !file.disabled && Boolean(onRefreshStatus);
  const canTestMessage = !isRuntimeOnly && !file.disabled && Boolean(onTestMessage);
  const isStatusRefreshing = statusRefreshing[file.name] === true;
  const isMessageTesting = messageTesting[file.name] === true;

  // 通用 OAuth 重认证：仅对非 runtime 的 OAuth 账号开放，且显式排除 codex —— codex
  // 继续走既有的 CodexReauthDialog（onReauth + codexNeedsReauth 按钮），避免同一账号
  // 出现两个重认证入口而互相干扰。回调补全 UI 只对支持回调的 provider 展示。
  const oauthReauthProvider = resolveAuthFileOAuthProvider(file);
  const canReauthenticate =
    Boolean(oauthReauthProvider) &&
    oauthReauthProvider !== 'codex' &&
    !isRuntimeOnly &&
    Boolean(onReauthenticate);
  const reauthInProgress =
    reauthState?.status === 'starting' || reauthState?.status === 'polling';
  const supportsReauthCallback =
    reauthState?.status === 'polling' && supportsAuthFileReauthCallback(reauthState.provider);
  const reauthButtonTitle = reauthInProgress
    ? t('auth_files.reauth_waiting', {
        defaultValue: 'Waiting for re-authentication to complete',
      })
    : t('auth_files.reauth_button', { defaultValue: 'Re-authenticate' });
  const refreshStatusButtonTitle = t('auth_files.status_refresh_button', {
    defaultValue: 'Refresh status',
  });
  const testMessageButtonTitle = t('auth_files.test_message_button', {
    defaultValue: 'Test message',
  });

  const priorityValue = parsePriorityValue(file.priority ?? file['priority']);
  const projectIdValue = getProjectIdValue(file);
  const noteValue = typeof file.note === 'string' ? file.note.trim() : '';
  const subscription =
    isAntigravity && !isRuntimeOnly ? antigravitySubscription : undefined;
  const subscriptionData = subscription?.status === 'success' ? subscription.data : undefined;
  const isSubscriptionLoading = subscription?.status === 'loading';
  const subscriptionPlanLabel =
    subscriptionData?.plan === 'free'
      ? t('antigravity_subscription.plan_free')
      : subscriptionData?.plan === 'pro'
        ? t('antigravity_subscription.plan_pro')
        : subscriptionData?.plan === 'ultra'
          ? t('antigravity_subscription.plan_ultra')
          : subscriptionData?.plan === 'ultra-lite'
            ? t('antigravity_subscription.plan_ultra_lite')
            : subscriptionData
              ? subscriptionData.tierName ||
                subscriptionData.tierId ||
                t('antigravity_subscription.plan_unknown')
              : '';
  const subscriptionBadgeLabel =
    isSubscriptionLoading
      ? t('antigravity_subscription.loading_short')
      : subscription?.status === 'error'
      ? t('antigravity_subscription.error_badge')
      : subscriptionData
        ? t('antigravity_subscription.plan_badge', {
            plan: subscriptionPlanLabel,
          })
        : '';
  const subscriptionTitle =
    subscription?.status === 'error'
      ? subscription.error || t('common.unknown_error')
      : subscriptionData?.tierName && subscriptionData.tierId
        ? `${subscriptionData.tierName} (${subscriptionData.tierId})`
        : subscriptionData?.tierName || subscriptionData?.tierId || subscriptionBadgeLabel;
  const subscriptionBadgeClass =
    isSubscriptionLoading
      ? styles.subscriptionBadgeLoading
      : subscription?.status === 'error'
      ? styles.subscriptionBadgeError
      : subscriptionData?.plan === 'free'
        ? styles.subscriptionBadgeFree
        : subscriptionData?.plan === 'unknown'
          ? styles.subscriptionBadgeUnknown
          : styles.subscriptionBadgePaid;
  const subscriptionErrorMessage =
    subscription?.status === 'error'
      ? subscription.error || t('common.unknown_error')
      : '';
  const showSubscriptionRefreshButton =
    isAntigravity &&
    !isRuntimeOnly &&
    !subscriptionBadgeLabel &&
    Boolean(onRefreshAntigravitySubscription);
  // isAutoQuarantined 优先级高于 disabled/hasStatusWarning 等健康兜底判定
  // （仅次于 isRuntimeOnly 虚拟占位卡）：被隔离的账号即使 status_message 仍是
  // 健康文案，也必须显示「已隔离」而不是假绿，这正是本次要修的 bug。
  const stateLabel = isRuntimeOnly
    ? t('auth_files.type_virtual') || '虚拟认证文件'
    : isAutoQuarantined
      ? t('auth_files.health_status_quarantined', { defaultValue: 'Quarantined' })
      : isReauthRequired
        ? t('auth_files.health_status_reauth_required', {
            defaultValue: 'Re-authentication required',
          })
        : file.disabled
          ? t('auth_files.health_status_disabled')
          : hasStatusWarning
            ? t('auth_files.health_status_warning')
            : rawStatusMessage
              ? t('auth_files.health_status_healthy')
              : t('auth_files.status_toggle_label');
  const stateBadgeClass = isRuntimeOnly
    ? styles.stateBadgeVirtual
    : isAutoQuarantined
      ? styles.stateBadgeQuarantined
      : isReauthRequired
        ? styles.stateBadgeWarning
        : file.disabled
          ? styles.stateBadgeDisabled
          : hasStatusWarning
            ? styles.stateBadgeWarning
            : styles.stateBadgeActive;
  const codexStatusBadgeClassByTone = {
    danger: styles.codexStatusBadgeDanger,
    warning: styles.codexStatusBadgeWarning,
    info: styles.codexStatusBadgeInfo,
  } satisfies Record<AuthFileCodexStatusBadge['tone'], string>;

  // 风控命中计数：只读契约字段，未提供（undefined）或 <=0 时不渲染徽章。
  const cyberPolicyFlagCount =
    typeof file.cyber_policy_flag_count === 'number' && file.cyber_policy_flag_count > 0
      ? file.cyber_policy_flag_count
      : 0;
  const lastCyberPolicyAtRaw =
    typeof file.last_cyber_policy_at === 'string' ? file.last_cyber_policy_at.trim() : '';
  const lastCyberPolicyAtLabel = lastCyberPolicyAtRaw ? formatDateTime(lastCyberPolicyAtRaw) : '';

  // codex `fast`（service_tier=priority）已开启徽标：只读内联 account_settings.fast，
  // 仅对 codex 账号展示；复用现有 codexStatusBadge/info pill 样式，不新造样式体系。
  const inlineAccountSettings = file.account_settings ?? file.accountSettings;
  const isFastEnabled = resolvedProvider === 'codex' && inlineAccountSettings?.fast === true;

  // Phase 2 账号级速度读数（中位首 token · 耗时 · TPS）。codex 账号优先展示；其它 provider
  // 只要有近期成功请求（success 计数或 HEALTH 面板成功数）也展示，从而把 per-account
  // analytics 拉取限制在「可能有数据」的活跃账号上，避免对全部账号盲发请求。
  const isCodexAccount = resolvedProvider === 'codex';
  const hasRecentActivity = fileStats.success > 0 || statusData.totalSuccess > 0;
  const showSpeedReadings = !isRuntimeOnly && (isCodexAccount || hasRecentActivity);

  // P7（account-session-count-display）：细粒度订阅等级徽标——只对 core 实际
  // 投影该字段的 provider（claude/codex）展示，null 时（其它 provider，或
  // account_scheduling 整体缺失）不渲染，避免刷屏一堆无信息量的占位。
  const subscriptionTierBadge = deriveSubscriptionTierBadge(
    resolvedProvider,
    file.account_scheduling
  );
  const subscriptionTierBadgeLabel = subscriptionTierBadge
    ? t(`auth_files.subscription_tier_badge_${subscriptionTierBadge.tier}`, {
        defaultValue: SUBSCRIPTION_TIER_BADGE_DEFAULT_LABELS[subscriptionTierBadge.tier],
      })
    : '';
  // 会话计数区块展示给所有非虚拟账号（不像速度读数那样限定"有活跃流量"——
  // 会话数本身就是"有没有活跃/近期会话"的答案，空态由组件内部呈现，不需要
  // 卡片层面预先过滤）。loading 复用逐账号「刷新状态」的既有 loading 信号：
  // 该请求正在刷新这条账号记录，展示上把会话数据块降级为"统计中…"占位，
  // 避免继续渲染即将被替换的旧计数。
  const showSessionSummary = !isRuntimeOnly;
  const isSessionSummaryLoading = statusRefreshing[file.name] === true;

  return (
    <div
      className={`${styles.fileCard} ${compact ? styles.fileCardCompact : ''} ${providerCardClass} ${selected ? styles.fileCardSelected : ''} ${file.disabled ? styles.fileCardDisabled : ''}`}
    >
      <div className={styles.fileCardLayout}>
        <div className={styles.fileCardMain}>
          <div className={styles.cardHeader}>
            {!isRuntimeOnly && (
              <SelectionCheckbox
                checked={selected}
                onChange={() => onToggleSelect(file.name)}
                className={styles.cardSelection}
                aria-label={
                  selected ? t('auth_files.batch_deselect') : t('auth_files.batch_select_all')
                }
                title={selected ? t('auth_files.batch_deselect') : t('auth_files.batch_select_all')}
              />
            )}
            <div className={styles.cardHeaderContent}>
              <div className={styles.cardBadgeRow}>
                <span
                  className={styles.typeBadge}
                  style={{
                    backgroundColor: typeColor.bg,
                    color: typeColor.text,
                    ...(typeColor.border ? { border: typeColor.border } : {}),
                  }}
                >
                  {typeLabel}
                </span>
                <span
                  className={`${styles.stateBadge} ${stateBadgeClass}`}
                  title={isAutoQuarantined ? quarantineBadgeTitle : undefined}
                  data-testid={
                    isAutoQuarantined
                      ? 'auth-file-quarantined-badge'
                      : isReauthRequired
                        ? 'auth-file-reauth-required-badge'
                        : undefined
                  }
                >
                  {stateLabel}
                </span>
                {!isRuntimeOnly && (
                  <span
                    className={`${styles.healthPill} ${headerHealthPillClass}`}
                    title={headerHealthPillTitle}
                    data-testid={`auth-file-health-pill-${file.name}`}
                  >
                    {headerHealthPillText}
                  </span>
                )}
                {missingProxyUrl && (
                  <span
                    className={`${styles.stateBadge} ${styles.stateBadgeWarning}`}
                    title={missingProxyBadgeTitle}
                  >
                    <IconInfo className={styles.actionIcon} size={12} />
                    {t('auth_files.proxy_url_missing_badge', { defaultValue: 'Missing proxy' })}
                  </span>
                )}
                {subscriptionBadgeLabel && (
                  <span
                    className={`${styles.subscriptionBadge} ${subscriptionBadgeClass}`}
                    title={subscriptionTitle}
                  >
                    {isSubscriptionLoading && (
                      <LoadingSpinner size={10} className={styles.subscriptionBadgeSpinner} />
                    )}
                    {subscriptionBadgeLabel}
                  </span>
                )}
                {showSubscriptionRefreshButton && (
                  <button
                    type="button"
                    className={styles.subscriptionRefreshButton}
                    title={t('antigravity_subscription.refresh_button')}
                    onClick={() => onRefreshAntigravitySubscription?.(file)}
                    disabled={disableControls}
                  >
                    {t('antigravity_subscription.refresh_short')}
                  </button>
                )}
                {subscriptionTierBadge && (
                  <span
                    className={`${styles.tierBadge} ${subscriptionTierBadge.known ? styles.tierBadgeKnown : styles.tierBadgeUnknown}`}
                    title={t('auth_files.subscription_tier_badge_title', {
                      tier: subscriptionTierBadgeLabel,
                      defaultValue: 'Subscription tier: {{tier}}',
                    })}
                    data-testid={`auth-file-tier-badge-${file.name}`}
                    data-tier={subscriptionTierBadge.tier}
                  >
                    {subscriptionTierBadgeLabel}
                  </span>
                )}
                {codexStatusBadges.map((badge) => {
                  const label = t(badge.labelKey, {
                    defaultValue: badge.defaultLabel,
                    ...badge.labelParams,
                  });
                  const title = badge.titleKey
                    ? t(badge.titleKey, {
                        defaultValue: badge.defaultTitle ?? badge.defaultLabel,
                        ...badge.labelParams,
                      })
                    : (badge.defaultTitle ?? label);

                  return (
                    <span
                      key={badge.kind}
                      className={`${styles.codexStatusBadge} ${codexStatusBadgeClassByTone[badge.tone]}`}
                      title={title}
                    >
                      {label}
                    </span>
                  );
                })}
                {isFastEnabled && (
                  <span
                    className={`${styles.codexStatusBadge} ${styles.codexStatusBadgeInfo}`}
                    title={t('auth_files.account_settings_fast_badge_title', {
                      defaultValue:
                        'Codex fast mode is enabled for this account: about 1.5x faster generation at about 2.2x weekly quota consumption.',
                    })}
                    data-testid="auth-file-fast-badge"
                  >
                    {t('auth_files.account_settings_fast_badge', { defaultValue: 'Fast on' })}
                  </span>
                )}
                {quotaCooldown && (
                  <span
                    className={`${styles.codexStatusBadge} ${styles.codexStatusBadgeInfo} ${styles.quotaCooldownBadge}`}
                    title={t('auth_files.quota_cooldown_badge_title', {
                      recoverAt: formatUnixTimestamp(quotaCooldown.recoverAtMs),
                      owner: quotaCooldown.owner || 'cpamp_usage_429',
                      defaultValue:
                        'This auth file is in a CPAMP-managed quota cooldown and will be recovered automatically. It is not the native CPA disabled state. Owner: {{owner}}. Expected recovery: {{recoverAt}}.',
                    })}
                  >
                    {t('auth_files.quota_cooldown_badge', {
                      recoverAt: formatUnixTimestamp(quotaCooldown.recoverAtMs),
                      defaultValue: 'Cooldown until {{recoverAt}}',
                    })}
                  </span>
                )}
                {cyberPolicyFlagCount > 0 && (
                  <span
                    className={`${styles.codexStatusBadge} ${styles.codexStatusBadgeDanger}`}
                    title={t('auth_files.cyber_policy_flag_badge_title', {
                      count: cyberPolicyFlagCount,
                      lastAt: lastCyberPolicyAtLabel || '-',
                      defaultValue:
                        'This auth file has been flagged by cyber policy risk control {{count}} time(s). Last hit: {{lastAt}}.',
                    })}
                  >
                    <IconShield className={styles.actionIcon} size={12} />
                    {t('auth_files.cyber_policy_flag_badge', {
                      count: cyberPolicyFlagCount,
                      defaultValue: 'Risk control x{{count}}',
                    })}
                  </span>
                )}
                {canReauthenticate && reauthInProgress && (
                  <span
                    className={reauthStyles.reauthPendingBadge}
                    title={t('auth_files.reauth_waiting', {
                      defaultValue: 'Waiting for re-authentication to complete',
                    })}
                    data-testid="auth-file-reauth-pending-badge"
                  >
                    <LoadingSpinner size={10} />
                    {t('auth_files.reauth_pending_badge', {
                      defaultValue: 'Re-authenticating',
                    })}
                  </span>
                )}
              </div>
              <span className={styles.fileName} title={file.name}>
                {file.name}
              </span>
              {!compact && noteValue && (
                <div className={styles.noteText} title={noteValue}>
                  <span className={styles.noteLabel}>{t('auth_files.note_display')}</span>
                  <span className={styles.noteValue}>{noteValue}</span>
                </div>
              )}
            </div>
            {/* 头部操作区（点⑤）：把「账号设置」入口从卡片底部提到头部，一眼可点，
                不用滚到底部动作区。 */}
            {!isRuntimeOnly && (
              <div className={styles.cardHeaderActions}>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => onOpenAccountSettings(file)}
                  className={styles.iconButton}
                  title={t('auth_files.account_settings_button', {
                    defaultValue: 'Account settings',
                  })}
                  aria-label={t('auth_files.account_settings_button', {
                    defaultValue: 'Account settings',
                  })}
                  data-testid={`auth-file-account-settings-${file.name}`}
                  disabled={disableControls}
                >
                  <IconSettings className={styles.actionIcon} size={16} />
                </Button>
              </div>
            )}
          </div>

          <div className={`${styles.cardMeta} ${compact ? styles.cardMetaCompact : ''}`}>
            <div className={styles.metaItem}>
              <span className={styles.metaLabel}>{t('auth_files.file_size')}</span>
              <span className={styles.metaValue}>
                {file.size ? formatFileSize(file.size) : '-'}
              </span>
            </div>
            <div className={styles.metaItem}>
              <span className={styles.metaLabel}>{t('auth_files.file_modified')}</span>
              <span className={styles.metaValue}>{formatModified(file)}</span>
            </div>
            {priorityValue !== undefined && (
              <div className={`${styles.metaItem} ${styles.priorityBadge}`}>
                <span className={styles.metaLabel}>{t('auth_files.priority_display')}</span>
                <span className={`${styles.metaValue} ${styles.priorityValue}`}>
                  {priorityValue}
                </span>
              </div>
            )}
            {projectIdValue && (
              <div className={styles.metaItem} title={projectIdValue}>
                <span className={styles.metaLabel}>{t('auth_files.project_id_display')}</span>
                <span className={styles.metaValue}>{projectIdValue}</span>
              </div>
            )}
          </div>

          {canReauthenticate &&
            (reauthState?.status === 'polling' ||
              (reauthState?.status === 'error' && reauthState.error) ||
              supportsReauthCallback) && (
              <div className={reauthStyles.reauthInline} data-testid="auth-file-reauth-inline">
                {reauthState?.status === 'polling' && (
                  <div className={reauthStyles.reauthActionRow}>
                    {reauthState.url && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className={reauthStyles.reauthActionButton}
                        onClick={() => onCopyReauthLink?.(file.name)}
                        disabled={disableControls}
                        data-testid="auth-file-reauth-copy-link"
                      >
                        {t('auth_files.reauth_copy_link', { defaultValue: 'Copy link' })}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className={reauthStyles.reauthActionButton}
                      onClick={() => onCancelReauth?.(file.name)}
                      disabled={disableControls}
                      data-testid="auth-file-reauth-cancel"
                    >
                      {t('auth_files.reauth_cancel', { defaultValue: 'Cancel' })}
                    </Button>
                  </div>
                )}

                {reauthState?.status === 'error' && reauthState.error && (
                  <div className={reauthStyles.reauthPersistentError} role="alert">
                    <span className={reauthStyles.reauthPersistentErrorTitle}>
                      {t('auth_files.reauth_failed_badge', {
                        defaultValue: 'Re-authentication failed',
                      })}
                    </span>
                    <span className={reauthStyles.reauthPersistentErrorMessage}>
                      {reauthState.error}
                    </span>
                  </div>
                )}

                {supportsReauthCallback && (
                  <div className={reauthStyles.reauthCallbackSection}>
                    <Input
                      label={t('auth_login.oauth_callback_label')}
                      hint={t('auth_login.oauth_callback_hint')}
                      value={reauthState.callbackUrl || ''}
                      onChange={(e) => onChangeReauthCallbackUrl?.(file.name, e.target.value)}
                      placeholder={t('auth_login.oauth_callback_placeholder')}
                      disabled={disableControls || Boolean(reauthState.callbackSubmitting)}
                      error={
                        reauthState.callbackStatus === 'error'
                          ? reauthState.callbackError
                          : undefined
                      }
                    />
                    <div className={reauthStyles.reauthCallbackActions}>
                      <Button
                        variant="secondary"
                        size="sm"
                        className={reauthStyles.reauthActionButton}
                        onClick={() => onSubmitReauthCallback?.(file.name)}
                        loading={Boolean(reauthState.callbackSubmitting)}
                        disabled={disableControls}
                        data-testid="auth-file-reauth-submit-callback"
                      >
                        {t('auth_login.oauth_callback_button')}
                      </Button>
                      {reauthState.callbackStatus === 'success' && (
                        <span className={reauthStyles.reauthCallbackSuccess}>
                          {t('auth_login.oauth_callback_status_success')}
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

          {isAutoQuarantined && (
            <div
              className={styles.healthStatusMessage}
              title={quarantineBadgeTitle}
              data-testid={`auth-file-quarantine-notice-${file.name}`}
            >
              <IconShield className={styles.messageIcon} size={14} />
              <div className={styles.healthStatusMessageBody}>
                <span>{quarantineBadgeTitle}</span>
                {recentFailureCountLabel && (
                  <span
                    className={styles.healthStatusMessageMeta}
                    data-testid={`auth-file-recent-failure-count-${file.name}`}
                  >
                    {recentFailureCountLabel}
                  </span>
                )}
              </div>
            </div>
          )}

          {rawStatusMessage && hasStatusWarning && !isAutoQuarantined && (
            <div className={styles.healthStatusMessage} title={rawStatusMessage}>
              <IconInfo className={styles.messageIcon} size={14} />
              <div className={styles.healthStatusMessageBody}>
                <span>{rawStatusMessage}</span>
                {recentFailureCountLabel && (
                  <span
                    className={styles.healthStatusMessageMeta}
                    data-testid={`auth-file-recent-failure-count-${file.name}`}
                  >
                    {recentFailureCountLabel}
                  </span>
                )}
              </div>
            </div>
          )}

          {subscriptionErrorMessage && (
            <div className={styles.subscriptionError} title={subscriptionErrorMessage}>
              <IconInfo className={styles.messageIcon} size={14} />
              <span>
                {t('antigravity_subscription.load_failed', {
                  message: subscriptionErrorMessage,
                })}
              </span>
            </div>
          )}

          <div className={`${styles.cardInsights} ${compact ? styles.cardInsightsCompact : ''}`}>
            <div className={`${styles.cardStats} ${compact ? styles.cardStatsCompact : ''}`}>
              <div className={`${styles.statPill} ${styles.statSuccess}`}>
                <span className={styles.statLabel}>{t('stats.success')}</span>
                <span className={styles.statValue}>{fileStats.success}</span>
              </div>
              <div className={`${styles.statPill} ${styles.statFailure}`}>
                <span className={styles.statLabel}>{t('stats.failure')}</span>
                <span className={styles.statValue}>{fileStats.failure}</span>
              </div>
            </div>

            {hasStatusData ? (
              <div className={`${styles.statusPanel} ${compact ? styles.statusPanelCompact : ''}`}>
                <div className={styles.statusPanelLabel}>
                  <span>{t('auth_files.health_status_label')}</span>
                </div>
                <ProviderStatusBar statusData={statusData} styles={styles} />
              </div>
            ) : (
              <div className={styles.statusPanelEmpty}>
                <span className={styles.statusPanelLabel}>
                  {t('auth_files.health_status_label')}
                </span>
                <span className={styles.statusPanelEmptyValue}>--</span>
              </div>
            )}

            {showQuotaLayout && quotaType && (
              <AuthFileQuotaSection
                file={file}
                quotaType={quotaType}
                disableControls={disableControls}
                quotaOverride={
                  quotaType === 'codex'
                    ? (codexDisplayQuota ?? null)
                    : quotaType === 'claude'
                      ? (claudeDisplayQuota ?? null)
                      : undefined
                }
              />
            )}

            {showSpeedReadings && (
              <AccountSpeedReadings
                accountName={file.name}
                authIndex={authIndexKey}
                compact={compact}
              />
            )}

            {showSessionSummary && (
              <AccountSessionSummary
                accountScheduling={file.account_scheduling}
                loading={isSessionSummaryLoading}
                compact={compact}
              />
            )}
          </div>

          <div className={styles.cardActions}>
            <div className={styles.cardActionsMain}>
              {(showModelsButton || !isRuntimeOnly) && (
                <div className={styles.cardUtilityActions}>
                  {showModelsButton && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => onShowModels(file)}
                      className={`${styles.primaryActionButton} ${styles.modelsActionButton}`}
                      title={t('auth_files.models_button', { defaultValue: '模型' })}
                      aria-label={t('auth_files.models_button', { defaultValue: '模型' })}
                      disabled={disableControls}
                    >
                      <span className={styles.modelsActionIconWrap}>
                        <IconModelCluster className={styles.actionIcon} size={16} />
                      </span>
                    </Button>
                  )}
                  {!isRuntimeOnly && (
                    <>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => onDownload(file.name)}
                        className={styles.iconButton}
                        title={t('auth_files.download_button')}
                        disabled={disableControls}
                      >
                        <IconDownload className={styles.actionIcon} size={16} />
                      </Button>
                      {canRefreshStatus && (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => onRefreshStatus?.(file)}
                          className={styles.iconButton}
                          title={refreshStatusButtonTitle}
                          aria-label={refreshStatusButtonTitle}
                          disabled={disableControls || isStatusRefreshing}
                        >
                          {isStatusRefreshing ? (
                            <LoadingSpinner size={14} />
                          ) : (
                            <IconRefreshCw className={styles.actionIcon} size={16} />
                          )}
                        </Button>
                      )}
                      {canTestMessage && (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => onTestMessage?.(file)}
                          className={styles.iconButton}
                          title={testMessageButtonTitle}
                          aria-label={testMessageButtonTitle}
                          disabled={disableControls || isMessageTesting}
                        >
                          {isMessageTesting ? (
                            <LoadingSpinner size={14} />
                          ) : (
                            <IconBot className={styles.actionIcon} size={16} />
                          )}
                        </Button>
                      )}
                      {codexNeedsReauth && onReauth ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => onReauth(file)}
                          className={styles.iconButton}
                          title={t('codex_reauth.button')}
                          aria-label={t('codex_reauth.button')}
                          disabled={disableControls}
                        >
                          <IconRefreshCw className={styles.actionIcon} size={16} />
                        </Button>
                      ) : null}
                      {canReauthenticate && (
                        <Button
                          variant={
                            hasStatusWarning || isAutoQuarantined || isReauthRequired
                              ? 'primary'
                              : 'secondary'
                          }
                          size="sm"
                          onClick={() => onReauthenticate?.(file)}
                          className={styles.iconButton}
                          title={reauthButtonTitle}
                          aria-label={reauthButtonTitle}
                          data-testid="auth-file-action-reauth"
                          disabled={disableControls || reauthInProgress}
                        >
                          <IconKey className={styles.actionIcon} size={16} />
                        </Button>
                      )}
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() => onDelete(file.name)}
                        className={styles.iconButton}
                        title={t('auth_files.delete_button')}
                        disabled={disableControls || deleting === file.name}
                      >
                        {deleting === file.name ? (
                          <LoadingSpinner size={14} />
                        ) : (
                          <IconTrash2 className={styles.actionIcon} size={16} />
                        )}
                      </Button>
                    </>
                  )}
                </div>
              )}
            </div>
            {!isRuntimeOnly && (
              <div
                className={styles.statusToggle}
                title={isAutoQuarantined ? quarantineBadgeTitle : undefined}
                data-testid={`auth-file-status-toggle-${file.name}`}
              >
                <span className={styles.statusToggleLabel}>
                  {t('auth_files.status_toggle_label')}
                </span>
                <ToggleSwitch
                  // ariaLabel 始终用中性的 status_toggle_label：开关现在总是可点
                  // （见下方 checked/disabled），不再有「隔离态只读」这回事，所以
                  // 不应该继续按 isAutoQuarantined 切到「已禁用/只读」的错误文案。
                  ariaLabel={t('auth_files.status_toggle_label')}
                  // Path B（开关回归可点）：开关只反映/操作 file.disabled 本身的
                  // operator 意图，不再因 isAutoQuarantined 被强制显示为「关」或
                  // 禁用；隔离状态改由上方徽标（quarantineBadgeTitle）独立呈现。
                  // 这样「停用」操作不会误清隔离标记，「启用」也不会被隔离态挡住。
                  checked={!file.disabled}
                  disabled={disableControls || statusUpdating[file.name] === true}
                  onChange={(value) => onToggleStatus(file, value)}
                />
              </div>
            )}
          </div>

        </div>
      </div>
    </div>
  );
}
