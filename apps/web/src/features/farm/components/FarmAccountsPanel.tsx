import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useInterval } from '@/hooks/useInterval';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/Table';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { AsyncPanel } from '@/components/ui/AsyncPanel';
import { HealthPill, type HealthPillStatus } from '@/components/ui/HealthPill';
import { IconBot, IconInfo, IconShield } from '@/components/ui/icons';
import { useFarmAccounts } from '../hooks/useFarmAccounts';
import { useFarmAccountState } from '../hooks/useFarmAccountState';
import { useFarmContainers } from '../hooks/useFarmContainers';
import { useFarmOnboard } from '../hooks/useFarmOnboard';
import {
  accountAuthStatusToHealthPillStatus,
  farmHealthVariantToBadgeVariant,
  findAccountStateForAccount,
  healthReasonToFarmHealthVariant,
  isAccountStateStale,
} from '../utils/health';
import {
  FARM_ENVS,
  type FarmContainerView,
  type FarmDeviceIDSource,
  type FarmEnv,
} from '@/types/farm';
import { formatDateTimeUtc8 } from '@/utils/datetime';
import { formatDurationMs } from '@/utils/usage/latency';
import styles from './FarmAccountsPanel.module.scss';

// 容器注册表快照「陈旧」的前端展示阈值：本列只用它给「容器运行态」pill 的
// as-of（container.updated_at）补陈旧标记，不是判定逻辑本身——真正的健康
// 判定仍由后端 farmrunner.DecideStatus/CombineHealth 完成。Poller 轮询节拍
// 默认 60s（见 farmrunner 注释），10 分钟留了充分余量吸收单次轮询失败/网络
// 抖动，只在长时间没有任何注册表写入时才提示陈旧。
const CONTAINER_SNAPSHOT_STALE_THRESHOLD_MS = 10 * 60 * 1000;

// 陈旧判定用的「当前时刻」时钟节拍：React 19 render-purity 规则不允许在 render
// 期间直接读 Date.now()（会随机在任意一次重渲染悄悄改变陈旧结果）。改用一个
// 每 30s 刷新一次的 state 时钟（对齐本模块既有轮询节拍 FARM_OVERVIEW_POLL_
// INTERVAL_MS/FARM_ALERTS_POLL_INTERVAL_MS=30s），render 只读这个稳定值，
// 陈旧判定口径（10 分钟阈值）本身不变。
const STALE_CLOCK_TICK_MS = 30 * 1000;

// device_id 展示口径四态着色（spec「device_id 展示口径全站对齐」）：
// container_synced=真实容器同步(success)，drift=正在漂移待对账(warning)，
// synthetic=确认非农场绑定按账号派生合成(muted，正常态非异常)，
// unknown=后端无法确定绑定关系(muted，中性回退非异常)。
const DEVICE_ID_SOURCE_VARIANT: Record<FarmDeviceIDSource, 'success' | 'warning' | 'error' | 'muted'> = {
  container_synced: 'success',
  drift: 'warning',
  synthetic: 'muted',
  unknown: 'muted',
};

// 容器健康四态映射：running=ok，degraded/orphaned=warn（幽灵态待人工核实，非
// 已确认故障），down=err，created/starting/retired=idle（未激活/已退役，非
// 故障态）。口径与 FarmContainerTable 的 STATUS_BADGE_VARIANT 分组一致，只是
// 四值枚举（ok/warn/err/idle）替代旧 success/warning/error/muted 徽标枚举。
const CONTAINER_HEALTH_STATUS: Record<string, HealthPillStatus> = {
  running: 'ok',
  degraded: 'warn',
  orphaned: 'warn',
  down: 'err',
  created: 'idle',
  starting: 'idle',
  retired: 'idle',
};

/**
 * 账号健康区：复用 GET /api/farm/accounts?env=<env>（编排器透传 CPA 该
 * 环境既有 GET /auth-files 健康列表，见 handlers.go handleListAccounts），
 * operator 借此在挑账号绑定前先看清哪些账号可用；同时展示最近刷新时间、
 * 重新授权入口与禁用状态，帮助定位需要人工介入的账号。
 *
 * P7 两项改动（本文件本次交付）：
 *   1. 账号行主行展示 note（如 "AC04"），email/文件名降为副行小字，note
 *      为空时回退显示 email（P7-2）。
 *   2. 「重新授权」不再在本页内嵌 OAuth 回调状态机（原 useFarmReauth 那套
 *      starting/polling/callback 轮询已整体移除），改为静态「需要重新
 *      授权」badge + 深链跳到 /auth-files 对应账号（P7-4）。
 *   3. 「账号健康」列改为「账号认证态」：数据源从 CPA 透传的 account.status/
 *      auto_quarantined 换成 FO2 两平面判定结果
 *      （FarmContainerView.account_auth_status/account_auth_reason，与
 *      「容器运行态」列各自独立推导，见 utils/health.ts
 *      accountAuthStatusToHealthPillStatus 顶部注释）；两列的风险 reason
 *      从 HealthPill 的 title tooltip 升级为可见 badge，并各自补 as-of
 *      时间戳 + 陈旧标记（用户②）。
 */
interface FarmAccountsPanelProps {
  /** 页面级容器快照；传入后不再启动本面板自己的 15 秒轮询。 */
  containers?: FarmContainerView[];
}

export function FarmAccountsPanel({ containers: sharedContainers }: FarmAccountsPanelProps = {}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [env, setEnv] = useState<FarmEnv>('test');
  const { accounts, loading, error, reload } = useFarmAccounts(env);
  const { onboardingAccountId, onboard } = useFarmOnboard({ reload });
  // 两平面徽标的两个数据源：containers 列表带 account_auth_status/
  // account_auth_reason（已绑定账号才有，按 farm_container_id 关联）+
  // health_reason（容器运行态列真实 reason）；account-state 列表只用来补
  // as-of 时间戳/陈旧标记（见 utils/health.ts findAccountStateForAccount/
  // isAccountStateStale 顶部注释——状态判定本身信 containers 列表，不在前端
  // 重新实现 farmrunner.DecideAccountAuthPlane）。
  const { containers: independentlyLoadedContainers } = useFarmContainers({
    enabled: sharedContainers === undefined,
  });
  const containers = sharedContainers ?? independentlyLoadedContainers;
  const { accountStates } = useFarmAccountState(env);
  // 容器运行态 as-of 陈旧判定用的稳定「当前时刻」，见 STALE_CLOCK_TICK_MS 注释。
  const [nowMs, setNowMs] = useState(() => Date.now());
  useInterval(() => setNowMs(Date.now()), STALE_CLOCK_TICK_MS);
  const containersById = useMemo(() => {
    const map = new Map<string, (typeof containers)[number]>();
    for (const c of containers) map.set(c.id, c);
    return map;
  }, [containers]);

  const envOptions = FARM_ENVS.map((value) => ({ value, label: t(`farm.env.${value}`) }));

  // 双列列头文案同时复用为 <HealthPill dimension> 值（拼进 aria-label，如
  // 「账号认证态: 存活」），保证可见列头与朗读维度语义一致，只算一次而非
  // 每行重复 t() 调用。
  const accountHealthColumnLabel = t('farm.accountHealth.accountHealthColumn', {
    defaultValue: '账号认证态',
  });
  const containerHealthColumnLabel = t('farm.accountHealth.containerHealthColumn', {
    defaultValue: '容器运行态',
  });
  // 用户B「请求节奏可见」新增列；用户③「接入农场」按钮从容器运行态格移出后，
  // 末列由「重新授权」升级为承载多种操作的「操作」列（onboard + 重新授权）。
  const cadenceColumnLabel = t('farm.accountHealth.cadenceColumn', { defaultValue: '请求节奏' });
  const actionsColumnLabel = t('farm.accountHealth.actionsColumn', { defaultValue: '操作' });

  return (
    <div className={styles.panel} data-testid="farm-accounts-panel">
      {/* 容量分配模型正名（spec REQ-5「文档与农场页 SHALL 明确」的农场页半边）：
          住宅 IP 是容量真源、device_id 廉价无上限、激活需三件齐备。放在账号面板
          顶部、紧邻「接入农场」操作语境，帮 operator 一眼理解容器池为何受限、
          何时能接新账号。 */}
      <div className={styles.capacityNotice} data-testid="farm-capacity-model-callout">
        <div className={styles.capacityNoticeHeader}>
          <IconInfo size={14} />
          <span>{t('farm.capacityModel.title')}</span>
        </div>
        <ul className={styles.capacityNoticeList}>
          <li>{t('farm.capacityModel.ipSource')}</li>
          <li>{t('farm.capacityModel.deviceIdCheap')}</li>
          <li>{t('farm.capacityModel.activationRule')}</li>
        </ul>
      </div>

      <div className={styles.header}>
        <div className={styles.title}>{t('farm.accounts.title')}</div>
        <div data-testid="farm-accounts-env-select">
          <Select
            value={env}
            options={envOptions}
            onChange={(value) => setEnv(value as FarmEnv)}
            ariaLabel={t('farm.bind_modal.env_label')}
            fullWidth={false}
            className={styles.envSelect}
            id="farm-accounts-env-select-control"
          />
        </div>
      </div>
      <p className={styles.desc}>{t('farm.accounts.desc')}</p>

      <AsyncPanel
        loading={loading}
        error={error}
        isEmpty={accounts.length === 0}
        loadingLabel={t('common.loading')}
        loadingTestId="farm-accounts-loading"
        errorTestId="farm-accounts-error"
        empty={{
          title: t('farm.accounts.empty_title'),
          description: t('farm.accounts.empty_desc'),
          testId: 'farm-accounts-empty',
        }}
      >
        <Table data-testid="farm-accounts-table">
          <TableHeader>
            <TableRow>
              <TableHead>{t('farm.accounts.column_name')}</TableHead>
              <TableHead>
                {/* 用户①：维度图标 + 列头，明确区分「账号认证态」不是「容器运行态」
                    的重复。图标为纯装饰（aria-hidden），列语义由可见文字承载。 */}
                <span className={styles.columnHeadWithIcon}>
                  <IconShield size={14} aria-hidden="true" />
                  {accountHealthColumnLabel}
                </span>
              </TableHead>
              <TableHead>
                <span className={styles.columnHeadWithIcon}>
                  <IconBot size={14} aria-hidden="true" />
                  {containerHealthColumnLabel}
                </span>
              </TableHead>
              <TableHead>{cadenceColumnLabel}</TableHead>
              <TableHead>
                {t('farm.accountHealth.deviceIdSourceColumn', {
                  defaultValue: 'Device ID source',
                })}
              </TableHead>
              <TableHead>{t('farm.accountHealth.lastRefresh')}</TableHead>
              <TableHead>{actionsColumnLabel}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {accounts.map((account) => {
              const normalizedStatus = (account.status || 'active').trim().toLowerCase();

              // 自动隔离态（T3 telemetry-farm-ux-hardening）：优先按
              // account.auto_quarantined 布尔判定，不单独按 status 字符串分支——
              // core 侧复核指出两者可能短暂不一致（清隔离锁与 status 落库非原子），
              // 布尔更稳。
              const isAutoQuarantined = Boolean(account.auto_quarantined);
              // 隔离详情文案（用于「需要重新授权」badge 旁的隔离提示）。
              const quarantineReasonLabel = account.quarantine_reason
                ? t(`farm.accountHealth.quarantineReason_${account.quarantine_reason}`, {
                    defaultValue: account.quarantine_reason,
                  })
                : t('farm.accountHealth.quarantineReasonUnknown', { defaultValue: 'unknown reason' });
              const quarantineAtLabel = account.quarantined_at
                ? formatDateTimeUtc8(account.quarantined_at, i18n.language)
                : t('farm.accountHealth.quarantineTimeUnknown', { defaultValue: 'unknown time' });
              const quarantineTooltip = isAutoQuarantined
                ? t('farm.accountHealth.quarantineTooltip', {
                    reason: quarantineReasonLabel,
                    at: quarantineAtLabel,
                    defaultValue:
                      'Auto-quarantined: {{reason}} · {{at}}. Please re-authenticate to restore this account.',
                  })
                : undefined;
              const showDisabledTag = account.disabled && normalizedStatus !== 'disabled';

              // ---------------------------------------------------------
              // P7-2：账号行主行显示 note，email/文件名降为副行；note 为空
              // 时回退显示 account（CPA 邮箱）或 name（auth 文件名）。
              // ---------------------------------------------------------
              const trimmedNote = account.note?.trim();
              const secondaryIdentity = account.account?.trim() || account.name;
              const primaryDisplayName = trimmedNote || secondaryIdentity;
              const showSecondaryIdentity = Boolean(trimmedNote) && secondaryIdentity !== primaryDisplayName;

              // ---------------------------------------------------------
              // 用户②：账号认证态平面（与容器运行态各自独立），源数据是
              // 已绑定容器上的 account_auth_status/account_auth_reason
              // （FO2 两平面，见 dto.go containerView 注释）；未绑定账号
              // 没有容器可关联，恒回退 unknown（不默认绿也不默认红）。
              // ---------------------------------------------------------
              const joinedContainer =
                account.farm_bound && account.farm_container_id
                  ? containersById.get(account.farm_container_id)
                  : undefined;
              const authStatusRaw = joinedContainer?.account_auth_status;
              const authReasonRaw = joinedContainer?.account_auth_reason;
              const authPillStatus = accountAuthStatusToHealthPillStatus(authStatusRaw);
              const authLabel = t(`farm.accountHealth.authStatus_${authStatusRaw ?? 'unknown'}`, {
                defaultValue: authStatusRaw ?? 'unknown',
              });
              // reason 只在 dead 态给出具体原因（account_disabled/
              // account_auto_quarantined/account_token_dead）；unknown 态
              // 的原始 reason（可能是空串或字面 "stale"）不是给人看的措辞，
              // 不直接展示，unknown 本身已经足够诚实。
              const authReasonLabel =
                authStatusRaw === 'dead' && authReasonRaw
                  ? t(`farm.accountHealth.authReason_${authReasonRaw}`, { defaultValue: authReasonRaw })
                  : undefined;
              const accountStateRow = findAccountStateForAccount(accountStates, account.name);
              const authAsOf = accountStateRow?.observed_at;
              const authStale = isAccountStateStale(authAsOf);

              // ---------------------------------------------------------
              // 容器运行态平面（既有列，本轮升级 reason 来源）：状态本身仍
              // 用账号视图自带的 farm_container_status（未绑定回退
              // idle/Unbound）；reason 从 containers 列表 join 拿真实
              // health_reason（含 FO2 的 account_state_unknown/stale/
              // not_wired 三个新 reason），取不到时（如 join 未命中）回退
              // 「有 LLM 请求但无遥测」不对称归因提示。
              // ---------------------------------------------------------
              const containerStatus = account.farm_bound ? account.farm_container_status : undefined;
              const containerHealthStatus: HealthPillStatus = containerStatus
                ? CONTAINER_HEALTH_STATUS[containerStatus] ?? 'idle'
                : 'idle';
              const containerHealthLabel = containerStatus
                ? t(`farm.status.${containerStatus}`, { defaultValue: containerStatus })
                : t('farm.accountHealth.unbound', { defaultValue: 'Unbound' });
              const hasLlmTraffic = (account.recent_requests ?? 0) > 0 || (account.success ?? 0) > 0;
              const showDegradedHint =
                account.farm_bound && account.farm_container_status === 'degraded' && hasLlmTraffic;
              const containerReasonRaw = joinedContainer?.health_reason;
              const containerReasonLabel = containerReasonRaw
                ? t(`farm.healthReason.${containerReasonRaw}`, { defaultValue: containerReasonRaw })
                : showDegradedHint
                  ? t('farm.accountHealth.degradedHint')
                  : undefined;
              // 只在非「健康」时才把 reason 升级成可见 badge——ok 态的 reason
              // 只是「ok」本身，跟 pill 的可见 label 重复，不值得再占一格。
              const showContainerReasonBadge = Boolean(
                containerReasonLabel && containerReasonRaw !== 'ok'
              );
              // reason badge 颜色需跟随 pill 的健康四态派生（原先硬编码
              // status-badge warning，红 pill 如 container_exited_or_missing 时
              // 颜色会跟 err 态不一致）：有真实 health_reason 时按
              // healthReasonToFarmHealthVariant 判定；没有真实 reason（走
              // showDegradedHint 兜底文案分支）时该提示本身描述的就是当前
              // containerHealthStatus（degraded→warn），直接复用 pill 自身状态。
              const containerReasonVariant = containerReasonRaw
                ? healthReasonToFarmHealthVariant(containerReasonRaw)
                : containerHealthStatus;
              const containerReasonBadgeVariant = farmHealthVariantToBadgeVariant(
                containerReasonVariant
              );
              const containerAsOf = joinedContainer?.updated_at;
              const containerStale = joinedContainer
                ? nowMs - new Date(joinedContainer.updated_at).getTime() >
                  CONTAINER_SNAPSHOT_STALE_THRESHOLD_MS
                : false;
              // testid 固定为 farm-container-health-<name>，不随 showDegradedHint
              // 分支切换，保证真机断言可稳定定位该 pill；degraded 提示改由
              // TableCell 的 data-degraded-hint 属性单独标记，不覆盖主 testid。
              const containerHealthTestId = `farm-container-health-${account.name}`;

              // ---------------------------------------------------------
              // 用户B「请求节奏可见」：把探针保活节奏从容器详情抽屉最深处上浮
              // 到账号面板每行。数据全部取自已 join 的容器视图
              // （last_keepalive_at + next_keepalive_estimate，见 types/farm.ts），
              // 不额外按容器逐个拉 probe-cadence——避免账号列表页每行一次网络
              // 扇出；更精确的 per-interval 均值仍保留在容器详情抽屉
              // （GET .../probe-cadence 的 next_expected_window）。这里的
              // avg_observed_seconds_24h 是分桶近似均值，对面板摘要够用。
              // scope 固定标注「探针保活到达」，与账号 CPA 累计用量口径分开
              // （对齐 FarmProbeCadenceView.scope 注释），不把两个时钟混成一个数字。
              // ---------------------------------------------------------
              const cadenceEstimate = joinedContainer?.next_keepalive_estimate;
              const lastKeepaliveAt = joinedContainer?.last_keepalive_at;
              const cadenceAvgObservedSeconds = cadenceEstimate?.avg_observed_seconds_24h;
              const successCount = account.success ?? 0;
              const failedCount = account.failed ?? 0;
              const recentRequestsCount = account.recent_requests ?? 0;
              // 探针到达/请求成败只对已接入农场（有容器绑定）的账号有意义；未接入
              // 账号没有农场探针，不在「探针保活到达」口径下展示成败，避免口径混淆。
              const hasRequestOutcome =
                successCount > 0 || failedCount > 0 || recentRequestsCount > 0;

              // 「已认证但未接入农场」按钮门控（design.md 决策5 / P0-10）：
              // farm_bound=false 即未接入；disabled 账号是 operator 主动
              // 关闭，不提供一键接入入口（避免把停用账号又拉回农场）。
              const canOnboard = !account.farm_bound && !account.disabled;
              const isOnboarding = onboardingAccountId === account.name;

              // 重新授权门控（P7-4）：account.reauth_url 非空即代表 CPA 认为
              // 该账号可重新授权（经验上仅 anthropic provider 会返回该字段），
              // 门控条件与此前一致，只是不再内嵌 OAuth 回调状态机——改为跳到
              // 账号管理页（/auth-files）对应账号，由那边既有 useAuthFilesReauth
              // 承接实际授权流程，本页不重复维护第二套。
              const reauthNeeded = Boolean(account.reauth_url);

              return (
                <TableRow key={account.name} data-testid={`farm-account-row-${account.name}`}>
                  <TableCell data-label={t('farm.accounts.column_name')}>
                    <div className={styles.nameCell}>
                      <div className={styles.nameCellPrimary}>
                        <span data-testid={`farm-account-primary-name-${account.name}`}>
                          {primaryDisplayName}
                        </span>
                        {showDisabledTag ? (
                          <span
                            className={`status-badge muted ${styles.disabledTag}`}
                            data-testid={`farm-account-disabled-tag-${account.name}`}
                          >
                            {t('farm.accountHealth.disabledBadge', { defaultValue: 'Disabled' })}
                          </span>
                        ) : null}
                      </div>
                      {showSecondaryIdentity ? (
                        <span
                          className={`${styles.mono} ${styles.nameCellSecondary}`}
                          data-testid={`farm-account-secondary-identity-${account.name}`}
                        >
                          {secondaryIdentity}
                        </span>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell
                    data-testid={`farm-account-health-cell-${account.name}`}
                    data-label={accountHealthColumnLabel}
                  >
                    <div className={styles.planeCell}>
                      <HealthPill
                        status={authPillStatus}
                        label={authLabel}
                        dimension={accountHealthColumnLabel}
                        reason={authReasonLabel}
                        data-testid={`farm-account-health-pill-${account.name}`}
                      />
                      {/* 用户②：健康态单格默认只留 1 个 pill；仅异常（有 dead
                          reason）或陈旧时才展开这 1 行 muted 副信息，健康且新鲜的
                          行不再堆叠「截至<时间>」as-of 与陈旧噪声。 */}
                      {authReasonLabel || authStale ? (
                        <div
                          className={styles.secondaryLine}
                          data-testid={`farm-account-auth-secondary-${account.name}`}
                        >
                          {authReasonLabel ? (
                            <span
                              className={`status-badge error ${styles.reasonBadge}`}
                              data-testid={`farm-account-auth-reason-${account.name}`}
                            >
                              {authReasonLabel}
                            </span>
                          ) : null}
                          {authStale ? (
                            <span
                              className={`status-badge warning ${styles.staleBadge}`}
                              data-testid={`farm-account-auth-stale-${account.name}`}
                            >
                              {t('farm.accountHealth.staleBadge', { defaultValue: '陈旧' })}
                            </span>
                          ) : null}
                          <span
                            className={styles.asOfInline}
                            data-testid={`farm-account-auth-asof-${account.name}`}
                          >
                            {t('farm.accountHealth.asOf', { defaultValue: '截至' })}{' '}
                            {authAsOf
                              ? formatDateTimeUtc8(authAsOf, i18n.language)
                              : t('farm.accountHealth.neverObserved', { defaultValue: '从未采集' })}
                          </span>
                        </div>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell
                    data-testid={`farm-container-health-cell-${account.name}`}
                    data-label={containerHealthColumnLabel}
                    data-degraded-hint={showDegradedHint ? 'true' : undefined}
                  >
                    <div className={styles.planeCell}>
                      {/* 用户③：「接入农场」按钮已从本格移出并入末尾「操作」列，
                          容器运行态格回归"只展示状态"，不再内嵌操作按钮。 */}
                      <HealthPill
                        status={containerHealthStatus}
                        label={containerHealthLabel}
                        dimension={containerHealthColumnLabel}
                        reason={containerReasonLabel}
                        data-testid={containerHealthTestId}
                      />
                      {/* 用户②：与账号认证态格一致——默认只留 1 个 pill，仅非 ok
                          reason 或陈旧时才展开这 1 行 muted 副信息。 */}
                      {showContainerReasonBadge || containerStale ? (
                        <div
                          className={styles.secondaryLine}
                          data-testid={`farm-container-health-secondary-${account.name}`}
                        >
                          {showContainerReasonBadge ? (
                            <span
                              className={`status-badge ${containerReasonBadgeVariant} ${styles.reasonBadge}`}
                              data-testid={`farm-container-health-reason-${account.name}`}
                            >
                              {containerReasonLabel}
                            </span>
                          ) : null}
                          {containerStale ? (
                            <span
                              className={`status-badge warning ${styles.staleBadge}`}
                              data-testid={`farm-container-health-stale-${account.name}`}
                            >
                              {t('farm.accountHealth.staleBadge', { defaultValue: '陈旧' })}
                            </span>
                          ) : null}
                          <span
                            className={styles.asOfInline}
                            data-testid={`farm-container-health-asof-${account.name}`}
                          >
                            {t('farm.accountHealth.asOf', { defaultValue: '截至' })}{' '}
                            {containerAsOf
                              ? formatDateTimeUtc8(containerAsOf, i18n.language)
                              : '—'}
                          </span>
                        </div>
                      ) : null}
                    </div>
                  </TableCell>
                  {/* 用户B「请求节奏可见」：把探针保活节奏上浮到账号每行，
                      scope 标注「探针保活到达」，与账号 CPA 累计用量口径分开。 */}
                  <TableCell
                    data-testid={`farm-account-cadence-cell-${account.name}`}
                    data-label={cadenceColumnLabel}
                  >
                    <div className={styles.cadenceCell}>
                      <span className={styles.scopeBadge}>
                        {t('farm.accountHealth.cadenceScopeBadge', {
                          defaultValue: '口径：探针保活到达',
                        })}
                      </span>
                      {account.farm_bound && joinedContainer ? (
                        <>
                          <div className={styles.cadenceRow}>
                            <span className={styles.cadenceLabel}>
                              {t('farm.accountHealth.cadenceLast', { defaultValue: '上次' })}
                            </span>
                            <span className={styles.mono}>
                              {lastKeepaliveAt
                                ? formatDateTimeUtc8(lastKeepaliveAt, i18n.language)
                                : t('farm.containers.never')}
                            </span>
                          </div>
                          {cadenceEstimate ? (
                            <>
                              <div className={styles.cadenceRow}>
                                <span className={styles.cadenceLabel}>
                                  {t('farm.accountHealth.cadenceAvgInterval', {
                                    defaultValue: '平均间隔',
                                  })}
                                </span>
                                <span className={styles.mono}>
                                  {typeof cadenceAvgObservedSeconds === 'number'
                                    ? formatDurationMs(cadenceAvgObservedSeconds * 1000, {
                                        maxUnits: 1,
                                      })
                                    : '—'}
                                </span>
                              </div>
                              <div className={styles.cadenceRow}>
                                <span className={styles.cadenceLabel}>
                                  {t('farm.accountHealth.cadenceNextWindow', {
                                    defaultValue: '下次',
                                  })}
                                </span>
                                {/* 数据缺口（本片不做）：per-容器真实生效间隔现都用
                                    默认 600/1800/5400，min~max 是「默认配置区间」，
                                    经 title 注明非每容器实际生效值。 */}
                                <span
                                  className={styles.mono}
                                  title={t('farm.accountHealth.cadenceDefaultRangeNote', {
                                    defaultValue:
                                      '配置区间为默认值（600/1800/5400s），非每容器实际生效值',
                                  })}
                                >
                                  {formatDurationMs(cadenceEstimate.min_seconds * 1000, {
                                    maxUnits: 1,
                                  })}{' '}
                                  ~{' '}
                                  {formatDurationMs(cadenceEstimate.max_seconds * 1000, {
                                    maxUnits: 1,
                                  })}
                                </span>
                                {/* 用户B 强制标注：keepalive 是指数分布随机，精确
                                    唤醒时刻机制上不存在。 */}
                                <span
                                  className={styles.jitterBadge}
                                  data-testid={`farm-account-cadence-jitter-${account.name}`}
                                >
                                  {t('farm.accountHealth.cadenceJitterBadge', {
                                    defaultValue: '随机抖动·非精确',
                                  })}
                                </span>
                              </div>
                            </>
                          ) : (
                            <p className={styles.cadenceHint}>
                              {t('farm.accountHealth.cadenceNoEstimate', {
                                defaultValue: '该状态无下次探针',
                              })}
                            </p>
                          )}
                          {hasRequestOutcome ? (
                            <div
                              className={styles.cadenceOutcome}
                              data-testid={`farm-account-cadence-outcome-${account.name}`}
                            >
                              <span className={styles.cadenceLabel}>
                                {t('farm.accountHealth.cadenceOutcomeLabel', {
                                  defaultValue: '近期请求',
                                })}
                              </span>
                              <span className={styles.cadenceOutcomeSuccess}>
                                {t('farm.accountHealth.cadenceSuccess', { defaultValue: '成功' })}{' '}
                                {successCount}
                              </span>
                              <span className={styles.cadenceOutcomeFailed}>
                                {t('farm.accountHealth.cadenceFailed', { defaultValue: '失败' })}{' '}
                                {failedCount}
                              </span>
                            </div>
                          ) : null}
                        </>
                      ) : (
                        <span className={styles.cadenceMuted}>
                          {t('farm.accountHealth.cadenceNotBound', {
                            defaultValue: '未接入农场',
                          })}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell
                    data-testid={`farm-account-device-id-source-${account.name}`}
                    data-label={t('farm.accountHealth.deviceIdSourceColumn', {
                      defaultValue: 'Device ID source',
                    })}
                  >
                    <div className={styles.deviceSourceCell}>
                      <span
                        className={`status-badge ${DEVICE_ID_SOURCE_VARIANT[account.device_id_source] ?? 'muted'}`}
                      >
                        {t(`auth_files.account_settings_device_id_source_${account.device_id_source}`, {
                          defaultValue: account.device_id_source,
                        })}
                      </span>
                      {account.farm_bound && account.farm_container_id ? (
                        <div
                          className={styles.deviceSourceMeta}
                          data-testid={`farm-account-device-id-meta-${account.name}`}
                        >
                          <span className={styles.mono}>{account.farm_container_id}</span>
                          {account.farm_env ? (
                            <span className={styles.chip}>
                              {t(`farm.env.${account.farm_env}`, { defaultValue: account.farm_env })}
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell data-label={t('farm.accountHealth.lastRefresh')}>
                    <span className={`${styles.mono} ${styles.refreshTimestamp}`}>
                      {account.last_refresh
                        ? formatDateTimeUtc8(account.last_refresh, i18n.language)
                        : t('farm.containers.never')}
                    </span>
                  </TableCell>
                  <TableCell data-label={actionsColumnLabel}>
                    {/* 用户③：末列升级为「操作」列，承载 onboard + 重新授权两类
                        动作，纵向堆叠；容器运行态格因此只剩状态展示。 */}
                    <div className={styles.actionsCell}>
                      {canOnboard ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          loading={isOnboarding}
                          onClick={() => onboard(account.name, env)}
                          className={styles.onboardButton}
                          // 可见文案用紧凑版（onboardActionShort），但无障碍名称与悬浮
                          // 提示仍用完整语义文案，避免视觉紧凑化丢失屏幕阅读器/鼠标
                          // 悬浮上下文。
                          aria-label={t('farm.accountHealth.onboardAction', { defaultValue: 'Onboard to farm' })}
                          title={t('farm.accountHealth.onboardAction', { defaultValue: 'Onboard to farm' })}
                          data-testid={`farm-account-onboard-${account.name}`}
                        >
                          {isOnboarding
                            ? t('farm.accountHealth.onboarding', { defaultValue: 'Onboarding…' })
                            : t('farm.accountHealth.onboardActionShort', { defaultValue: 'Onboard' })}
                        </Button>
                      ) : null}
                      {reauthNeeded ? (
                      <div className={styles.reauthCell}>
                        {/* 隔离态引导重新认证（T3）：紧邻 badge 上方提示"已被自动隔离，
                            请重新认证"，帮助 operator 一眼理解为何这个账号出现在需要
                            处理的列表里。 */}
                        {isAutoQuarantined ? (
                          <span
                            className={styles.quarantineNotice}
                            data-testid={`farm-account-quarantine-notice-${account.name}`}
                            title={quarantineTooltip}
                          >
                            {t('farm.accountHealth.quarantineReauthNotice', {
                              defaultValue: 'This account was auto-quarantined. Please re-authenticate.',
                            })}
                          </span>
                        ) : null}
                        {/* 静态「需要重新授权」状态（P7-4）：不再内嵌 OAuth 回调状态机
                            （原 starting/polling/callback 轮询已整体移除），本页只
                            负责标注状态，实际授权动作交给账号管理页对应账号卡片。 */}
                        <span
                          className={`status-badge warning ${styles.reauthNeededBadge}`}
                          data-testid={`farm-account-reauth-needed-${account.name}`}
                        >
                          {t('farm.accountHealth.reauthNeededBadge', {
                            defaultValue: 'Re-authentication required',
                          })}
                        </span>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() =>
                            navigate(`/auth-files?highlight=${encodeURIComponent(account.name)}`)
                          }
                          data-testid={`farm-account-reauth-link-${account.name}`}
                        >
                          {t('farm.accountHealth.reauthAction', { defaultValue: 'Re-authenticate' })}
                        </Button>
                      </div>
                    ) : isAutoQuarantined ? (
                      // 隔离但当前 provider 未提供 reauth_url 的兜底文案（经验上只有
                      // anthropic/claude 账号会拿到该字段）：非错误态本身的再次报错，
                      // 只是提示 operator 这里暂无一键入口，需要另寻恢复路径，故用
                      // 中性 muted 文案而非错误色。
                      <span
                        className={styles.quarantineNoticeMuted}
                        data-testid={`farm-account-quarantine-no-url-${account.name}`}
                      >
                        {t('farm.accountHealth.quarantineNoReauthUrl', {
                          defaultValue:
                            'This account was auto-quarantined, but no re-authentication entry is available.',
                        })}
                      </span>
                      ) : !canOnboard ? (
                        // 三类动作都不适用时才占位 —；canOnboard 时按钮已渲染，不再补 —。
                        <span className={styles.mono}>—</span>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </AsyncPanel>
    </div>
  );
}
