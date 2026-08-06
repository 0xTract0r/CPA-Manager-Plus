import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
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
import { AccountAuthBadge } from '@/components/ui/AccountAuthBadge';
import { ContainerRuntimeBadge } from '@/components/ui/ContainerRuntimeBadge';
import { IconBot, IconInfo, IconShield, IconTimer } from '@/components/ui/icons';
import { useFarmAccounts } from '../hooks/useFarmAccounts';
import { useFarmAccountState } from '../hooks/useFarmAccountState';
import { useFarmContainers } from '../hooks/useFarmContainers';
import { useFarmOnboard } from '../hooks/useFarmOnboard';
import { useFarmProbeCadenceSeries } from '../hooks/useFarmProbeCadenceSeries';
import { CadenceSparkline } from './CadenceSparkline';
import {
  FARM_ACCOUNT_AUTH_STATES,
  accountAuthStateToFarmHealthVariant,
  classifyContainerLifecycle,
  containerLifecycleToFarmHealthVariant,
  deriveAccountAuthState,
  farmHealthVariantToBadgeVariant,
  findAccountStateForAccount,
  healthReasonToFarmHealthVariant,
  isAccountStateStale,
  provisioningStateToFarmHealthVariant,
} from '../utils/health';
import {
  matchesFarmAccountFilter,
  type FarmAccountAuthFilter,
} from '../utils/accountFilter';
import {
  compareFarmAccountRows,
  type FarmAccountSortKey,
  type FarmAccountSortRow,
  type FarmAccountSortState,
  type SortDirection,
} from '../utils/accountSort';
import {
  type FarmContainerView,
  type FarmDeviceIDSource,
  type FarmEnv,
} from '@/types/farm';
import { formatDateTimeUtc8 } from '@/utils/datetime';
import { formatDurationMs } from '@/utils/usage/latency';
import styles from './FarmAccountsPanel.module.scss';

// 容器注册表快照「陈旧」的前端展示阈值：本列只用它给「容器运行态」徽标的
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

// C5「请求节奏 sparkline」：至少要 2 个间隔样本才画得出折线（单点画不出节奏
// 形状）；不足时改显文案，不渲染空图。
const CADENCE_SPARKLINE_MIN_SAMPLES = 2;

/**
 * 账号健康区：复用 GET /api/farm/accounts?env=<env>（编排器透传 CPA 该
 * 环境既有 GET /auth-files 健康列表），operator 借此在挑账号绑定前先看清哪些
 * 账号可用；同时展示最近刷新时间、供给状态与请求节奏，帮助定位需要人工介入的账号。
 *
 * P2「账号健康状态栏 + 请求节奏 UX 重做」（C1~C5，用户点2+点4）：
 *   C1 双平面视觉分离：账号认证态用 <AccountAuthBadge>（证件/盾牌族），容器
 *      运行态用 <ContainerRuntimeBadge>（胶囊 + 运行态点族），形状/图标/排版
 *      三维度一眼可辨，不再两列共用同一个 HealthPill。
 *   C2 账号态 5 态：deriveAccountAuthState 从后端 account_auth_status + 账号自带
 *      权威布尔派生 healthy/needs_reauth/auto_quarantined/operator_disabled/
 *      unknown，不在前端重算 token 活死；reauth 动作移出本面板（只显示状态，
 *      动作留认证文件页）。
 *   C3 容器态补 pending/退役/幽灵区分（classifyContainerLifecycle）+ join
 *      provisioning_state，让「供给中·等住宅代理/容量」可见。
 *   C4 账号→容器因果叙事：账号隔离/需重认证 且 容器降级/离线时，副行渲染一句
 *      「账号已隔离(终态) → 该容器已停保活」muted 叙事。
 *   C5 请求节奏心智模型：常驻一句指数分布随机说明 + intervals sparkline + 默认
 *      窗口(灰标) vs 实测均值(实标)分层。
 */
interface FarmAccountsPanelProps {
  /** 页面级容器快照；传入后不再启动本面板自己的轮询。 */
  containers?: FarmContainerView[];
}

export function FarmAccountsPanel({ containers: sharedContainers }: FarmAccountsPanelProps = {}) {
  const { t, i18n } = useTranslation();
  // C8「筛选维度改造」：环境（test/prod）对本部署无意义——编排器当前只服务 test，
  // 生产账号不会出现在这个列表里。env 固定为 test 仅用于底层拉取，不再作为可见
  // 筛选维度；对 operator 有意义的「账号认证态」+「备注/账号名搜索」改为客户端筛选。
  const env: FarmEnv = 'test';
  // 默认筛选改为「正常」（绑定 + 健康）——用户拍板：账号面板默认只看正常账号，
  // 异常/未绑定的按需切筛选查看，避免正常态被一堆异常淹没。
  const [authFilter, setAuthFilter] = useState<FarmAccountAuthFilter>('normal');
  const [query, setQuery] = useState('');
  // 列排序：默认按认证态严重度降序（异常优先），operator 一眼看到最需处理的账号。
  const [sort, setSort] = useState<FarmAccountSortState>({ key: 'authState', direction: 'desc' });
  const { accounts, loading, error, reload } = useFarmAccounts(env);
  const { onboardingAccountId, onboard } = useFarmOnboard({ reload });
  // 两平面徽标的数据源：containers 列表带 account_auth_status/account_auth_reason
  // （已绑定账号才有）+ health_reason（容器运行态列真实 reason）；account-state
  // 列表只用来补 as-of 时间戳/陈旧标记。
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

  // C5：只对「已接入农场 + running/degraded」的容器批量取探针间隔序列（只有这些
  // 容器才有下一次探针/间隔样本），画每行 sparkline。扇出边界见
  // useFarmProbeCadenceSeries 顶部注释——集合变化才拉一次，不接轮询。
  const cadenceContainerIds = useMemo(() => {
    const ids: string[] = [];
    for (const account of accounts) {
      if (!account.farm_bound || !account.farm_container_id) continue;
      const c = containersById.get(account.farm_container_id);
      if (c && (c.status === 'running' || c.status === 'degraded')) {
        ids.push(account.farm_container_id);
      }
    }
    return ids;
  }, [accounts, containersById]);
  const { seriesById: cadenceSeriesById } = useFarmProbeCadenceSeries(cadenceContainerIds);

  // C8 认证态筛选下拉选项：'正常'(复合) + 'all' + 6 态，态标签复用 C1-C5 已有的
  // authState_* 文案。'正常' 置顶——它是默认筛选，也是最常用视图。
  const authFilterOptions = useMemo(
    () => [
      {
        value: 'normal',
        label: t('farm.accounts.filter_auth_state_normal', { defaultValue: '正常（绑定+健康）' }),
      },
      {
        value: 'all',
        label: t('farm.accounts.filter_auth_state_all', { defaultValue: '全部认证态' }),
      },
      ...FARM_ACCOUNT_AUTH_STATES.map((state) => ({
        value: state,
        label: t(`farm.accountHealth.authState_${state}`, { defaultValue: state }),
      })),
    ],
    [t]
  );

  // 每账号排序/筛选描述子（认证态用与徽标同源的 deriveAccountAuthState 派生，此处
  // 集中算一次供筛选 + 排序共用，不改动下方每行徽标/节奏的既有内联计算，保持
  // C1-C5 逻辑不动）。契约字段 farm_bound / device_id_source 在此消费。
  const sortRowByName = useMemo(() => {
    const map = new Map<string, FarmAccountSortRow>();
    for (const account of accounts) {
      const normalizedStatus = (account.status || 'active').trim().toLowerCase();
      const joined =
        account.farm_bound && account.farm_container_id
          ? containersById.get(account.farm_container_id)
          : undefined;
      const authState = deriveAccountAuthState({
        authStatus: joined?.account_auth_status,
        authReason: joined?.account_auth_reason,
        autoQuarantined: Boolean(account.auto_quarantined),
        disabled: account.disabled || normalizedStatus === 'disabled',
        hasReauthUrl: Boolean(account.reauth_url),
        // 契约字段：farm_bound=false 的 Claude 账号 → unprovisioned 异常态。
        farmBound: account.farm_bound,
      });
      const sortName = account.note?.trim() || account.account?.trim() || account.name;
      // 用量近似：农场 accounts 端点无 token 用量，取请求活跃度（近期请求量与
      // 成功/失败计数的较大者）作为「用量」排序代理。
      const usage = Math.max(
        account.recent_requests ?? 0,
        (account.success ?? 0) + (account.failed ?? 0)
      );
      map.set(account.name, {
        name: sortName,
        authState,
        farmBound: account.farm_bound,
        deviceIdSource: account.device_id_source,
        usage,
        lastRefresh: account.last_refresh,
      });
    }
    return map;
  }, [accounts, containersById]);

  // C8 客户端筛选：认证态复用 sortRowByName 的派生态；关键词在 note/account/name
  // 三处做大小写不敏感子串匹配。'normal' 复合筛选（绑定 + 健康）由 matchesFarmAccountFilter 承载。
  const filteredAccounts = useMemo(() => {
    return accounts.filter((account) => {
      const derived = sortRowByName.get(account.name);
      return matchesFarmAccountFilter(
        {
          note: account.note,
          account: account.account,
          name: account.name,
          authState: derived?.authState ?? 'unknown',
          farmBound: account.farm_bound,
        },
        { authState: authFilter, query }
      );
    });
  }, [accounts, sortRowByName, authFilter, query]);

  // 按当前列排序（纯函数比较，稳定次序 tiebreak 见 accountSort.ts）。
  const sortedAccounts = useMemo(() => {
    const fallback: FarmAccountSortRow = {
      name: '',
      authState: 'unknown',
      usage: 0,
    };
    return [...filteredAccounts].sort((a, b) =>
      compareFarmAccountRows(
        sortRowByName.get(a.name) ?? fallback,
        sortRowByName.get(b.name) ?? fallback,
        sort
      )
    );
  }, [filteredAccounts, sortRowByName, sort]);

  // 列头点击切换排序：同列翻转方向；换列时用该列的默认方向（严重度/用量类默认降序，
  // 名称/来源/时间类默认升序）。
  const handleSort = (key: FarmAccountSortKey) => {
    setSort((prev) => {
      if (prev.key === key) {
        return { key, direction: prev.direction === 'asc' ? 'desc' : 'asc' };
      }
      const descFirst: FarmAccountSortKey[] = ['authState', 'usage', 'lastRefresh'];
      const direction: SortDirection = descFirst.includes(key) ? 'desc' : 'asc';
      return { key, direction };
    });
  };
  const ariaSortFor = (key: FarmAccountSortKey): 'ascending' | 'descending' | 'none' =>
    sort.key === key ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none';
  const sortIndicatorFor = (key: FarmAccountSortKey): string =>
    sort.key === key ? (sort.direction === 'asc' ? '▲' : '▼') : '↕';

  // 双列列头文案同时复用为徽标 dimension 值（拼进 aria-label），保证可见列头与
  // 朗读维度语义一致，只算一次而非每行重复 t() 调用。
  const accountHealthColumnLabel = t('farm.accountHealth.accountHealthColumn', {
    defaultValue: '账号认证态',
  });
  const containerHealthColumnLabel = t('farm.accountHealth.containerHealthColumn', {
    defaultValue: '容器运行态',
  });
  const cadenceColumnLabel = t('farm.accountHealth.cadenceColumn', { defaultValue: '请求节奏' });
  const actionsColumnLabel = t('farm.accountHealth.actionsColumn', { defaultValue: '操作' });

  // 可排序列头：把列文案（可含图标）包进一个 button，点击切换排序；aria-sort 落在
  // th 上供辅助技术朗读当前排序方向。
  const renderSortHead = (key: FarmAccountSortKey, label: ReactNode, testKey: string) => (
    <TableHead aria-sort={ariaSortFor(key)}>
      <button
        type="button"
        className={`${styles.sortHeaderButton} ${sort.key === key ? styles.sortHeaderActive : ''}`}
        onClick={() => handleSort(key)}
        data-testid={`farm-accounts-sort-${testKey}`}
        aria-label={t('farm.accounts.sort_by_column', {
          column: typeof label === 'string' ? label : testKey,
          defaultValue: '点击按此列排序',
        })}
      >
        <span className={styles.sortHeaderLabel}>{label}</span>
        <span className={styles.sortIndicator} aria-hidden="true">
          {sortIndicatorFor(key)}
        </span>
      </button>
    </TableHead>
  );

  return (
    <div className={styles.panel} data-testid="farm-accounts-panel">
      {/* 容量分配模型正名（spec REQ-5）：住宅 IP 是容量真源、device_id 廉价无
          上限、激活需三件齐备。帮 operator 一眼理解容器池为何受限、何时能接新账号。 */}
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
        {/* C8：把无意义的 test/prod 环境下拉换成「账号认证态」筛选 + 「备注/账号名」
            搜索这两个对 operator 真正有用的客户端筛选维度。 */}
        <div className={styles.filterControls} data-testid="farm-accounts-filters">
          <div data-testid="farm-accounts-auth-filter">
            <Select
              value={authFilter}
              options={authFilterOptions}
              onChange={(value) => setAuthFilter(value as FarmAccountAuthFilter)}
              ariaLabel={t('farm.accounts.filter_auth_state_label', {
                defaultValue: '按账号认证态筛选',
              })}
              fullWidth={false}
              className={styles.filterSelect}
              id="farm-accounts-auth-filter-control"
            />
          </div>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('farm.accounts.filter_search_placeholder', {
              defaultValue: '搜索备注 / 账号…',
            })}
            aria-label={t('farm.accounts.filter_search_label', {
              defaultValue: '按备注或账号名搜索',
            })}
            className={`input ${styles.filterSearch}`}
            data-testid="farm-accounts-search"
          />
        </div>
      </div>
      <p className={styles.desc}>{t('farm.accounts.desc')}</p>

      {/* C5 常驻心智模型：保活探针指数分布随机触发，只有区间与均值、无精确倒计时。
          放面板级、始终可见，防止「请求节奏」列的默认区间被误读成精确倒计时。 */}
      <div className={styles.cadenceModelNote} data-testid="farm-cadence-model-note">
        <IconTimer size={14} aria-hidden="true" />
        <span>{t('farm.accountHealth.cadenceModelNote')}</span>
      </div>

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
              {renderSortHead('name', t('farm.accounts.column_name'), 'name')}
              {/* C1：账号认证态列头配盾牌图标（身份语义）。图标纯装饰
                  （aria-hidden），列语义由可见文字承载。按认证态严重度排序。 */}
              {renderSortHead(
                'authState',
                <span className={styles.columnHeadWithIcon}>
                  <IconShield size={14} aria-hidden="true" />
                  {accountHealthColumnLabel}
                </span>,
                'auth-state'
              )}
              {/* C1：容器运行态列头配运行时图标，与身份平面盾牌区分。按绑定态排序。 */}
              {renderSortHead(
                'bind',
                <span className={styles.columnHeadWithIcon}>
                  <IconBot size={14} aria-hidden="true" />
                  {containerHealthColumnLabel}
                </span>,
                'bind'
              )}
              {/* 请求节奏列：按用量（请求活跃度）排序。 */}
              {renderSortHead('usage', cadenceColumnLabel, 'usage')}
              {renderSortHead(
                'deviceIdSource',
                t('farm.accountHealth.deviceIdSourceColumn', {
                  defaultValue: 'Device ID source',
                }),
                'device-id-source'
              )}
              {renderSortHead('lastRefresh', t('farm.accountHealth.lastRefresh'), 'last-refresh')}
              <TableHead>{actionsColumnLabel}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredAccounts.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} data-testid="farm-accounts-filter-empty">
                  <span className={styles.filterEmpty}>
                    {t('farm.accounts.filter_no_match', {
                      defaultValue: '没有账号匹配当前筛选条件。',
                    })}
                  </span>
                </TableCell>
              </TableRow>
            ) : null}
            {sortedAccounts.map((account) => {
              const normalizedStatus = (account.status || 'active').trim().toLowerCase();
              const isAutoQuarantined = Boolean(account.auto_quarantined);
              const isDisabled = account.disabled || normalizedStatus === 'disabled';
              const showDisabledTag = account.disabled && normalizedStatus !== 'disabled';
              const reauthNeeded = Boolean(account.reauth_url);

              // 主行显示 note（如 "AC04"），email/文件名降为副行小字；note 为空
              // 时回退显示 account（CPA 邮箱）或 name（auth 文件名）。
              const trimmedNote = account.note?.trim();
              const secondaryIdentity = account.account?.trim() || account.name;
              const primaryDisplayName = trimmedNote || secondaryIdentity;
              const showSecondaryIdentity =
                Boolean(trimmedNote) && secondaryIdentity !== primaryDisplayName;

              // 已绑定容器（用于两平面 join + cadence）。
              const joinedContainer =
                account.farm_bound && account.farm_container_id
                  ? containersById.get(account.farm_container_id)
                  : undefined;

              // ---------------------------------------------------------
              // C1+C2 账号认证态平面（5 态）：deriveAccountAuthState 从后端
              // account_auth_status + 账号自带权威布尔派生展示态，不在前端重算
              // token 活死。未绑定账号没有容器可关联，authStatus 缺失，仍能靠
              // auto_quarantined/disabled/reauth_url 布尔派生出精确态而非一律 unknown。
              // ---------------------------------------------------------
              const authStatusRaw = joinedContainer?.account_auth_status;
              const authReasonRaw = joinedContainer?.account_auth_reason;
              const authState = deriveAccountAuthState({
                authStatus: authStatusRaw,
                authReason: authReasonRaw,
                autoQuarantined: isAutoQuarantined,
                disabled: isDisabled,
                hasReauthUrl: reauthNeeded,
                // 契约字段：未绑定 Claude 账号 → unprovisioned（不可出站异常态）。
                farmBound: account.farm_bound,
              });
              const authVariant = accountAuthStateToFarmHealthVariant(authState);
              const authLabel = t(`farm.accountHealth.authState_${authState}`, {
                defaultValue: authState,
              });
              // 隔离详情（隔离态副行提示用）。
              const quarantineReasonLabel = account.quarantine_reason
                ? t(`farm.accountHealth.quarantineReason_${account.quarantine_reason}`, {
                    defaultValue: account.quarantine_reason,
                  })
                : t('farm.accountHealth.quarantineReasonUnknown', { defaultValue: 'unknown reason' });
              const quarantineAtLabel = account.quarantined_at
                ? formatDateTimeUtc8(account.quarantined_at, i18n.language)
                : t('farm.accountHealth.quarantineTimeUnknown', { defaultValue: 'unknown time' });
              // 账号态副行的可见 reason 文案（按 5 态给不同细节）：
              // - auto_quarantined：隔离原因 + 时间。
              // - needs_reauth：凭证失效说明（无按钮，动作留认证文件页，C2）。
              // - 其余态：徽标 label 本身已足够，不再堆 reason。
              let authDetailLabel: string | undefined;
              if (authState === 'auto_quarantined') {
                authDetailLabel = t('farm.accountHealth.quarantineDetail', {
                  reason: quarantineReasonLabel,
                  at: quarantineAtLabel,
                  defaultValue: '{{reason}} · {{at}}',
                });
              } else if (authState === 'needs_reauth') {
                authDetailLabel = t('farm.accountHealth.reauthHint', {
                  defaultValue: '凭证已失效——请在「认证文件」页对该账号重新授权',
                });
              } else if (authState === 'unprovisioned') {
                authDetailLabel = t('farm.accountHealth.unprovisionedHint', {
                  defaultValue: '未绑定容器·不可出站——接入农场后才能经住宅代理请求',
                });
              }
              // 账号态副行详情只在非健康态展示（healthy 的 label 已够）。
              const showAuthDetail = authState !== 'healthy' && Boolean(authDetailLabel);

              const accountStateRow = findAccountStateForAccount(accountStates, account.name);
              const authAsOf = accountStateRow?.observed_at;
              const authStale = isAccountStateStale(authAsOf);

              // ---------------------------------------------------------
              // C3 容器运行态平面：classifyContainerLifecycle 把 status 折算成
              // running/pending/degraded/down/retired/ghost/unbound，运行态点样式
              // 据此区分「供给中/已退役/幽灵态」，不再压成同一个 idle 灰点。
              // ---------------------------------------------------------
              const containerStatus = account.farm_bound ? account.farm_container_status : undefined;
              const containerLifecycle = classifyContainerLifecycle(containerStatus);
              const containerVariant = containerLifecycleToFarmHealthVariant(containerLifecycle);
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
              const showContainerReasonBadge = Boolean(
                containerReasonLabel && containerReasonRaw !== 'ok'
              );
              const containerReasonVariant = containerReasonRaw
                ? healthReasonToFarmHealthVariant(containerReasonRaw)
                : containerVariant;
              const containerReasonBadgeVariant = farmHealthVariantToBadgeVariant(
                containerReasonVariant
              );
              const containerAsOf = joinedContainer?.updated_at;
              const containerStale = joinedContainer
                ? nowMs - new Date(joinedContainer.updated_at).getTime() >
                  CONTAINER_SNAPSHOT_STALE_THRESHOLD_MS
                : false;
              const containerHealthTestId = `farm-container-health-${account.name}`;

              // ---------------------------------------------------------
              // C3 provisioning_state join：让「供给中·等住宅代理/容量」对
              // operator 可见，对冲「以为新建不了容器」的误解——真相往往是正在
              // 排队供给。只在有派生态时展示；已绑定账号一般已 provisioned，重点
              // 是让未绑定但在供给队列里的账号显出「正在供给·等什么」。
              // ---------------------------------------------------------
              const provisioningState = account.provisioning_state;
              const showProvisioning = Boolean(provisioningState);
              const provisioningVariant = provisioningStateToFarmHealthVariant(provisioningState);
              const provisioningBadgeVariant = farmHealthVariantToBadgeVariant(provisioningVariant);
              const provisioningLabel = provisioningState
                ? t(`farm.accountHealth.provisioningState_${provisioningState}`, {
                    defaultValue: provisioningState,
                  })
                : undefined;

              // ---------------------------------------------------------
              // C4 账号→容器因果叙事：账号态=隔离/需重认证 且 容器态=降级/离线/
              // 幽灵时，副行渲染一句 muted 因果——是账号侧问题导致容器停保活，
              // 帮 operator 一眼看清根因在账号而非容器本身。
              // ---------------------------------------------------------
              const accountImpaired =
                authState === 'auto_quarantined' || authState === 'needs_reauth';
              const containerImpaired =
                containerLifecycle === 'degraded' ||
                containerLifecycle === 'down' ||
                containerLifecycle === 'ghost';
              const showCausalNarrative =
                account.farm_bound && accountImpaired && containerImpaired;
              const causalNarrative = showCausalNarrative
                ? t(`farm.accountHealth.causal_${authState}`, {
                    defaultValue:
                      authState === 'auto_quarantined'
                        ? '账号已隔离(终态) → 该容器已停保活'
                        : '账号需重新认证 → 该容器已停保活',
                  })
                : undefined;

              // ---------------------------------------------------------
              // C5 请求节奏：默认窗口(灰标) vs 实测均值(实标)分层 + intervals
              // sparkline。measured 优先用 probe-cadence 精确均值，回退容器视图
              // 分桶近似；default 区间标注为默认配置，防被误读成精确预测。
              // ---------------------------------------------------------
              const cadenceEstimate = joinedContainer?.next_keepalive_estimate;
              const lastKeepaliveAt = joinedContainer?.last_keepalive_at;
              const cadenceSeries = joinedContainer
                ? cadenceSeriesById.get(joinedContainer.id)
                : undefined;
              const measuredAvgSeconds =
                cadenceSeries?.avgObservedSeconds ?? cadenceEstimate?.avg_observed_seconds_24h;
              const cadenceIntervals = cadenceSeries?.intervals ?? [];
              const showSparkline = cadenceIntervals.length >= CADENCE_SPARKLINE_MIN_SAMPLES;
              const successCount = account.success ?? 0;
              const failedCount = account.failed ?? 0;
              const recentRequestsCount = account.recent_requests ?? 0;
              const hasRequestOutcome =
                successCount > 0 || failedCount > 0 || recentRequestsCount > 0;

              // 「已认证但未接入农场」按钮门控：farm_bound=false 即未接入；disabled
              // 账号是 operator 主动关闭，不提供一键接入入口。
              const canOnboard = !account.farm_bound && !account.disabled;
              const isOnboarding = onboardingAccountId === account.name;

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

                  {/* C1+C2 账号认证态平面：证件/盾牌族徽标（5 态）。 */}
                  <TableCell
                    data-testid={`farm-account-health-cell-${account.name}`}
                    data-label={accountHealthColumnLabel}
                    data-auth-state={authState}
                  >
                    <div className={styles.planeCell}>
                      <AccountAuthBadge
                        state={authState}
                        status={authVariant}
                        label={authLabel}
                        dimension={accountHealthColumnLabel}
                        reason={authDetailLabel}
                        data-testid={`farm-account-health-pill-${account.name}`}
                      />
                      {showAuthDetail || authStale ? (
                        <div
                          className={styles.secondaryLine}
                          data-testid={`farm-account-auth-secondary-${account.name}`}
                        >
                          {showAuthDetail ? (
                            <span
                              className={`${styles.authDetailText} ${styles[`authDetail_${authVariant}`]}`}
                              data-testid={`farm-account-auth-reason-${account.name}`}
                            >
                              {authDetailLabel}
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

                  {/* C1+C3+C4 容器运行态平面：胶囊 + 运行态点族徽标 + 供给态 + 因果叙事。 */}
                  <TableCell
                    data-testid={`farm-container-health-cell-${account.name}`}
                    data-label={containerHealthColumnLabel}
                    data-lifecycle={containerLifecycle}
                    data-degraded-hint={showDegradedHint ? 'true' : undefined}
                  >
                    <div className={styles.planeCell}>
                      <ContainerRuntimeBadge
                        lifecycle={containerLifecycle}
                        status={containerVariant}
                        label={containerHealthLabel}
                        dimension={containerHealthColumnLabel}
                        reason={containerReasonLabel}
                        data-testid={containerHealthTestId}
                      />
                      {/* C3 供给态：让「供给中·等住宅代理/容量」可见。 */}
                      {showProvisioning ? (
                        <span
                          className={`status-badge ${provisioningBadgeVariant} ${styles.provisioningBadge}`}
                          data-testid={`farm-account-provisioning-${account.name}`}
                          data-provisioning-state={provisioningState}
                        >
                          {provisioningLabel}
                        </span>
                      ) : null}
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
                      {/* C4 因果叙事：账号侧问题导致容器停保活。 */}
                      {causalNarrative ? (
                        <p
                          className={styles.causalNarrative}
                          data-testid={`farm-account-causal-${account.name}`}
                        >
                          {causalNarrative}
                        </p>
                      ) : null}
                    </div>
                  </TableCell>

                  {/* C5 请求节奏：口径徽标 + 上次 + 实测均值(实标)/默认区间(灰标) + sparkline。 */}
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
                              {/* 实测均值：实标（强调），这是真实观测。 */}
                              <div className={styles.cadenceRow}>
                                <span className={styles.cadenceMeasuredLabel}>
                                  {t('farm.accountHealth.cadenceMeasuredAvg', {
                                    defaultValue: '实测均值',
                                  })}
                                </span>
                                <span
                                  className={styles.cadenceMeasuredValue}
                                  data-testid={`farm-account-cadence-measured-${account.name}`}
                                >
                                  {typeof measuredAvgSeconds === 'number'
                                    ? formatDurationMs(measuredAvgSeconds * 1000, { maxUnits: 1 })
                                    : t('farm.accountHealth.cadenceNoMeasured', {
                                        defaultValue: '样本不足',
                                      })}
                                </span>
                              </div>
                              {/* intervals sparkline：最近 N 次探针到达间隔的节奏形状。 */}
                              {showSparkline ? (
                                <div className={styles.cadenceSparklineRow}>
                                  <CadenceSparkline
                                    intervals={cadenceIntervals}
                                    ariaLabel={t('farm.accountHealth.cadenceSparklineAria', {
                                      count: cadenceIntervals.length,
                                      defaultValue: '最近 {{count}} 次探针到达间隔',
                                    })}
                                    data-testid={`farm-account-cadence-sparkline-${account.name}`}
                                  />
                                  <span className={styles.cadenceSparklineCaption}>
                                    {t('farm.accountHealth.cadenceSparklineCaption', {
                                      count: cadenceIntervals.length,
                                      defaultValue: '最近 {{count}} 次间隔',
                                    })}
                                  </span>
                                </div>
                              ) : null}
                              {/* 默认区间：灰标（弱化），明确是默认配置、非精确预测。 */}
                              <div className={styles.cadenceRow}>
                                <span className={styles.cadenceDefaultLabel}>
                                  {t('farm.accountHealth.cadenceDefaultRange', {
                                    defaultValue: '默认区间',
                                  })}
                                </span>
                                <span
                                  className={styles.cadenceDefaultValue}
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

                  {/* C2 操作列：reauth 动作已移出账号健康面板（状态由账号认证态徽标
                      承载，重新授权动作留「认证文件」页）。本列只保留 onboard。 */}
                  <TableCell data-label={actionsColumnLabel}>
                    <div className={styles.actionsCell}>
                      {canOnboard ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          loading={isOnboarding}
                          onClick={() => onboard(account.name, env)}
                          className={styles.onboardButton}
                          aria-label={t('farm.accountHealth.onboardAction', {
                            defaultValue: 'Onboard to farm',
                          })}
                          title={t('farm.accountHealth.onboardAction', {
                            defaultValue: 'Onboard to farm',
                          })}
                          data-testid={`farm-account-onboard-${account.name}`}
                        >
                          {isOnboarding
                            ? t('farm.accountHealth.onboarding', { defaultValue: 'Onboarding…' })
                            : t('farm.accountHealth.onboardActionShort', { defaultValue: 'Onboard' })}
                        </Button>
                      ) : (
                        <span className={styles.mono}>—</span>
                      )}
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
