import { useMemo, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useTimezone } from '@/hooks/useTimezone';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/Table';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { AsyncPanel } from '@/components/ui/AsyncPanel';
import { HealthPill } from '@/components/ui/HealthPill';
import type { FarmContainerView } from '@/types/farm';
import { formatDateTimeUtc8, formatRelativeFromNow } from '@/utils/datetime';
import { useInterval } from '@/hooks/useInterval';
import { useFarmRetiredContainers } from '../hooks/useFarmRetiredContainers';
import { resolveBindingIdentity } from '../utils/identity';
import { ResponsiveTable } from './ResponsiveTable';
import {
  deviceAlignmentToBadgeVariant,
  farmHealthVariantToBadgeVariant,
  healthReasonToFarmHealthVariant,
  successRateToFarmHealthVariant,
} from '../utils/health';
import styles from './FarmContainerTable.module.scss';

interface FarmContainerTableProps {
  containers: FarmContainerView[];
  loading: boolean;
  error: string;
  unbindingContainerId: string | null;
  retiringContainerId: string | null;
  onBind: (container: FarmContainerView) => void;
  onUnbind: (container: FarmContainerView) => void;
  onRetire: (container: FarmContainerView) => void;
  // 行点击打开容器详情抽屉（P0-9 <FarmContainerDetail>）；可选——不传时行为
  // 与改造前一致（行不可点，只能靠 bind/unbind/retire 按钮操作）。
  onSelectContainer?: (container: FarmContainerView) => void;
  groupFilter?: FarmContainerFilter;
  onGroupFilterChange?: (filter: FarmContainerFilter) => void;
}

// design.md 容器生命周期：created(已入池未起) / starting(已起等 Poller 判回) /
// running / degraded / down / retired(已退役，软删归档) / orphaned(幽灵态，
// 见 types/farm.ts FARM_DEVICE_ID_SOURCES 附近注释)。徽标着色映射到既有
// status-badge 全局样式（只有 success/warning/error/muted 四档）：
// retired 归为中性归档态用 muted；orphaned 是需要 operator 收敛的异常态用
// warning，与 degraded 同色但各自行内文案已经区分（"异常" vs "幽灵态"）。
const STATUS_BADGE_VARIANT: Record<string, 'success' | 'warning' | 'error' | 'muted'> = {
  created: 'muted',
  starting: 'muted',
  running: 'success',
  degraded: 'warning',
  down: 'error',
  retired: 'muted',
  orphaned: 'warning',
};

// 过滤/分组桶：5 个具名分组（active/created/degraded/down/retired）+ 一个
// "全部"哨兵值。starting 归入 active（同属"容器进程已起"）。retired 桶实际是
// "归档态"集合：retired（软删归档）与 orphaned（幽灵态）都属 store.IsArchivedStatus
// （见 types/farm.ts），两者都会落进该桶——所以它的展示标签用「非活跃 / Inactive」
// 而非「已退役」，保证过滤标签与行内容（可能是已退役或幽灵态）语义自洽；行内
// 状态徽标仍按各自精确状态（已退役 / 幽灵态）着色区分。
type FarmContainerGroup = 'active' | 'created' | 'degraded' | 'down' | 'retired';
export type FarmContainerFilter = 'all' | FarmContainerGroup;

const FARM_CONTAINER_GROUPS: FarmContainerGroup[] = ['active', 'created', 'degraded', 'down', 'retired'];

function groupOfStatus(status: string): FarmContainerGroup {
  switch (status) {
    case 'created':
      return 'created';
    case 'degraded':
      return 'degraded';
    case 'down':
      return 'down';
    case 'retired':
    case 'orphaned':
      return 'retired';
    case 'running':
    case 'starting':
    default:
      return 'active';
  }
}

function formatPct(pct: number | undefined): string {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return '—';
  return `${pct.toFixed(1)}%`;
}

// device_id 对齐徽标（容器→账号方向，dto.go deviceIDAlignment 只产出这三值，
// 不会是 synthetic——那是账号→容器方向 FarmAccountEntry.device_id_source 专用
// 值，见 types/farm.ts FarmContainerView.device_id_alignment 注释）。着色映射
// 收敛进 utils/health.ts deviceAlignmentToBadgeVariant，供 FarmContainerDetail
// 共用；文案复用 FarmAccountsPanel 同款 i18n key
// （auth_files.account_settings_device_id_source_*）保证全站措辞一致。

export function FarmContainerTable({
  containers,
  loading,
  error,
  unbindingContainerId,
  retiringContainerId,
  onBind,
  onUnbind,
  onRetire,
  onSelectContainer,
  groupFilter: controlledGroupFilter,
  onGroupFilterChange,
}: FarmContainerTableProps) {
  const { t, i18n } = useTranslation();
  // 订阅全局时区（TZ2/#49）：切换时区时本组件重渲染，内部 formatDateTimeUtc8 同步刷新。
  useTimezone();
  const [internalGroupFilter, setInternalGroupFilter] = useState<FarmContainerFilter>('all');
  const groupFilter = controlledGroupFilter ?? internalGroupFilter;
  const setGroupFilter = (value: FarmContainerFilter) => {
    if (controlledGroupFilter === undefined) setInternalGroupFilter(value);
    onGroupFilterChange?.(value);
  };

  // 密度改造：默认列的最近保活时间戳改「相对时间」（绝对值放 title 悬浮）。相对
  // 时间需要一个「当前时刻」——用每 60s tick 的 state 时钟，避免在 render 期直接读
  // Date.now() 破坏 React render 纯度（与 FarmAccountsPanel 同款处理）。
  const [nowMs, setNowMs] = useState(() => Date.now());
  useInterval(() => setNowMs(Date.now()), 60 * 1000);

  // 密度改造：'all' 视图下默认折叠已退役/幽灵（归档态）容器，避免几周前的死容器
  // 混进活跃池；operator 需要时用「显示已退役」开关展开。显式选中 'retired' 分组
  // 时不受此开关影响（那就是专门看归档的视图）。
  const [showRetired, setShowRetired] = useState(false);

  // "已退役"分组数据不在默认活跃轮询里（见 useFarmContainers 顶部注释），只
  // 在 operator 选中 retired 或 all 时才按需拉取，避免默认视图/绑定弹窗的
  // 可绑定容器列表被归档数据污染。
  const needsRetired = groupFilter === 'retired' || groupFilter === 'all';
  const {
    containers: retiredContainers,
    loading: retiredLoading,
    error: retiredError,
  } = useFarmRetiredContainers(needsRetired);

  const { rows, archivedCount } = useMemo(() => {
    if (groupFilter === 'retired') {
      return { rows: retiredContainers, archivedCount: 0 };
    }
    if (groupFilter === 'all') {
      const rowsById = new Map<string, FarmContainerView>();
      for (const container of [...containers, ...retiredContainers]) {
        if (!rowsById.has(container.id)) rowsById.set(container.id, container);
      }
      const merged = [...rowsById.values()];
      const isArchived = (c: FarmContainerView) =>
        c.status === 'retired' || c.status === 'orphaned';
      const archived = merged.filter(isArchived);
      return {
        rows: showRetired ? merged : merged.filter((c) => !isArchived(c)),
        archivedCount: archived.length,
      };
    }
    return {
      rows: containers.filter((c) => groupOfStatus(c.status) === groupFilter),
      archivedCount: 0,
    };
  }, [containers, retiredContainers, groupFilter, showRetired]);

  const isLoading = loading || (needsRetired && retiredLoading);
  const combinedError = error || (needsRetired ? retiredError : '');

  // 当前分组/状态过滤下无匹配行，但容器池本身并非真空（`containers` 是父级
  // 默认活跃视图）时，是"过滤后为空"而非"池空"——两者措辞不同，避免用户误以为
  // 整个容器池没有任何容器（同仓已有范式：codex_filtered_empty_title /
  // table_filtered_empty_title）。
  const isFilteredEmpty = rows.length === 0 && containers.length > 0;

  const filterOptions = [
    { value: 'all', label: t('farm.filter.all') },
    ...FARM_CONTAINER_GROUPS.map((group) => ({ value: group, label: t(`farm.group.${group}`) })),
  ];

  return (
    <div className={styles.tableWrap} data-testid="farm-container-table-wrap">
      <div className={styles.filterBar} data-testid="farm-container-filter">
        <span className={styles.filterLabel}>{t('farm.filter.statusLabel')}</span>
        <div data-testid="farm-container-status-select">
          <Select
            value={groupFilter}
            options={filterOptions}
            onChange={(value) => setGroupFilter(value as FarmContainerFilter)}
            ariaLabel={t('farm.filter.statusLabel')}
            fullWidth={false}
            className={styles.filterSelect}
            id="farm-container-status-select-control"
          />
        </div>
        {/* 密度改造：'all' 视图有归档容器时给出「显示已退役」开关，默认折叠。 */}
        {groupFilter === 'all' && archivedCount > 0 ? (
          <label className={styles.retiredToggle} data-testid="farm-container-show-retired">
            <input
              type="checkbox"
              checked={showRetired}
              onChange={(event) => setShowRetired(event.target.checked)}
            />
            <span>
              {t('farm.containers.show_retired', {
                defaultValue: '显示已退役',
              })}
              {' · '}
              {archivedCount}
            </span>
          </label>
        ) : null}
      </div>

      <AsyncPanel
        loading={isLoading}
        error={combinedError}
        isEmpty={rows.length === 0}
        loadingLabel={t('common.loading')}
        loadingSpinnerSize={20}
        loadingCentered
        loadingTestId="farm-containers-loading"
        errorTestId="farm-containers-error"
        empty={
          isFilteredEmpty
            ? {
                title: t('farm.containers.filtered_empty_title'),
                description: t('farm.containers.filtered_empty_desc'),
                testId: 'farm-containers-filtered-empty',
              }
            : {
                title: t('farm.containers.empty_title'),
                description: t('farm.containers.empty_desc'),
                testId: 'farm-containers-empty',
              }
        }
      >
        <ResponsiveTable>
        <Table data-testid="farm-container-table">
          <TableHeader>
            <TableRow>
              <TableHead>{t('farm.containers.column_device')}</TableHead>
              <TableHead>{t('farm.containers.column_status')}</TableHead>
              <TableHead>{t('farm.containers.column_health_reason')}</TableHead>
              <TableHead>{t('farm.containers.column_keepalive')}</TableHead>
              <TableHead>{t('farm.containers.column_resource')}</TableHead>
              <TableHead>{t('farm.containers.column_success_rate')}</TableHead>
              {/* 密度改造：低频列「设备对齐 / 下次探针预估」移入容器详情页
                  （farm-detail-device-id / farm-detail-next-estimate），默认列压到
                  7 列；设备对齐仅在漂移/未知等需处理态时压成设备列内的紧凑徽标提示。 */}
              <TableHead>{t('farm.containers.column_binding')}</TableHead>
              {/* U4：操作列固定在右侧（sticky-right），表格横向溢出时绑定/解绑/退役
                  按钮仍常驻视口内可点，不再被裁到屏外。 */}
              <TableHead alignRight className={styles.stickyActions}>
                {t('farm.containers.column_actions')}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((container) => {
              const statusVariant = STATUS_BADGE_VARIANT[container.status] ?? 'muted';
              const statusLabel = t(`farm.status.${container.status}`, {
                defaultValue: container.status,
              });
              const isUnbinding = unbindingContainerId === container.id;
              const isRetiring = retiringContainerId === container.id;
              const isArchived = container.status === 'retired' || container.status === 'orphaned';
              const isBound = Boolean(container.binding);

              // 健康原因徽标（P0-1 假降级修复的落地点：keepalive_stale_ok 与
              // 真正的 keepalive_stale/no_keepalive_data 用不同语义色区分）。
              const healthVariant = healthReasonToFarmHealthVariant(container.health_reason);
              const healthReasonLabel = container.health_reason
                ? t(`farm.healthReason.${container.health_reason}`, {
                    defaultValue: container.health_reason,
                  })
                : '—';

              const successRateVariant = successRateToFarmHealthVariant(container.success_rate_24h);

              const deviceAlignmentVariant = deviceAlignmentToBadgeVariant(container.device_id_alignment);
              // 只在漂移/未知等需处理态冒出设备对齐徽标；正常的 container_synced 不渲染以减噪。
              const showDeviceAlignmentBadge =
                Boolean(container.device_id_alignment) &&
                container.device_id_alignment !== 'container_synced';

              // #52 绑定账号列：备注名（binding.note）优先作为主标识，邮箱脱敏后降为
              // 次要标识。运营者主要用备注名认账号，裸邮箱既难认又是敏感信息。
              const bindingIdentity = container.binding
                ? resolveBindingIdentity(container.binding.note, container.binding.account)
                : null;

              // R5-2 改绑防误绑（回显上次绑定）：解绑过的 down 容器带 last_bound_account
              // 时，绑定列改显「上次绑定：<脱敏账号>（已解绑）」，让 operator 一眼看清该
              // 容器历史归属，而不是拿裸 device_id hex 当账号误认。走全站一致的
              // resolveBindingIdentity 脱敏口径（当作无备注的账号标识脱敏）。
              const lastBoundIdentity =
                !container.binding && container.last_bound_account
                  ? resolveBindingIdentity(undefined, container.last_bound_account)
                  : null;

              const handleRowClick = onSelectContainer
                ? () => onSelectContainer(container)
                : undefined;
              const handleRowKeyDown = onSelectContainer
                ? (event: KeyboardEvent<HTMLTableRowElement>) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    onSelectContainer(container);
                  }
                : undefined;
              const stopRowClick = (event: MouseEvent) => event.stopPropagation();
              const stopRowKeyDown = (event: KeyboardEvent) => event.stopPropagation();

              return (
                <TableRow
                  key={container.id}
                  data-testid={`farm-container-row-${container.id}`}
                  onClick={handleRowClick}
                  onKeyDown={handleRowKeyDown}
                  tabIndex={onSelectContainer ? 0 : undefined}
                  aria-label={onSelectContainer ? `${container.id} · ${statusLabel}` : undefined}
                  className={onSelectContainer ? styles.clickableRow : undefined}
                >
                  <TableCell data-label={t('farm.containers.column_device')}>
                    <div className={styles.deviceCell}>
                      <span className={styles.containerId}>{container.id}</span>
                      <div className={styles.deviceMetaRow}>
                        <span className={styles.deviceIdMasked}>{container.device_id_masked}</span>
                        {/* 设备对齐低频列压进设备格：只在漂移/未知等需处理态时冒出
                            紧凑徽标（正常的 container_synced 不渲染，减噪）；完整对齐口径
                            在容器详情页。title 悬浮点明这是「设备 ID 对齐」。 */}
                        {showDeviceAlignmentBadge ? (
                          <span
                            className={`status-badge ${deviceAlignmentVariant} ${styles.alignmentBadge}`}
                            title={t('farm.containers.column_device_alignment')}
                            data-testid={`farm-container-device-alignment-${container.id}`}
                          >
                            {t(
                              `auth_files.account_settings_device_id_source_${container.device_id_alignment}`,
                              { defaultValue: container.device_id_alignment }
                            )}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell data-label={t('farm.containers.column_status')}>
                    <span className={`status-badge ${statusVariant}`}>{statusLabel}</span>
                  </TableCell>
                  <TableCell
                    data-label={t('farm.containers.column_health_reason')}
                    data-testid={`farm-container-health-reason-cell-${container.id}`}
                  >
                    <HealthPill
                      status={healthVariant}
                      label={healthReasonLabel}
                      data-testid={`farm-container-health-reason-pill-${container.id}`}
                    />
                  </TableCell>
                  <TableCell data-label={t('farm.containers.column_keepalive')}>
                    {/* 密度改造：相对时间（「2 分钟前」）压缩行高，绝对值仍走全局时区
                        formatDateTimeUtc8 放 title 悬浮，保持全站时区口径一致。 */}
                    {container.last_keepalive_at ? (
                      <span
                        className={styles.mono}
                        title={formatDateTimeUtc8(container.last_keepalive_at, i18n.language)}
                      >
                        {formatRelativeFromNow(container.last_keepalive_at, nowMs, i18n.language)}
                      </span>
                    ) : (
                      <span className={styles.mono}>{t('farm.containers.never')}</span>
                    )}
                  </TableCell>
                  <TableCell data-label={t('farm.containers.column_resource')}>
                    {container.latest_resource ? (
                      <span
                        className={styles.mono}
                        title={formatDateTimeUtc8(container.latest_resource.ts, i18n.language)}
                      >
                        {formatPct(container.latest_resource.mem_pct)} mem ·{' '}
                        {formatPct(container.latest_resource.cpu_pct)} cpu
                      </span>
                    ) : (
                      <span className={styles.mono}>—</span>
                    )}
                  </TableCell>
                  <TableCell data-label={t('farm.containers.column_success_rate')}>
                    {typeof container.success_rate_24h === 'number' ? (
                      <span className={`status-badge ${farmHealthVariantToBadgeVariant(successRateVariant)}`}>
                        {(container.success_rate_24h * 100).toFixed(1)}%
                      </span>
                    ) : (
                      <span className={styles.mono}>—</span>
                    )}
                  </TableCell>
                  <TableCell data-label={t('farm.containers.column_binding')}>
                    {container.binding && bindingIdentity ? (
                      <div className={styles.bindingCell}>
                        <div className={styles.bindingPrimaryRow}>
                          {/* 主标识：备注名优先；无备注时回退脱敏邮箱。title 保留原始
                              邮箱供 operator 需要时悬浮查看。 */}
                          <span
                            className={styles.bindingAccount}
                            title={container.binding.account}
                            data-testid={`farm-container-binding-primary-${container.id}`}
                          >
                            {bindingIdentity.primary || t('farm.containers.no_binding')}
                          </span>
                          <span className={styles.chip}>
                            {t(`farm.env.${container.binding.env}`, {
                              defaultValue: container.binding.env,
                            })}
                          </span>
                        </div>
                        {/* 次要标识：有备注名时才展示脱敏邮箱（无备注名时主标识已是脱敏邮箱）。 */}
                        {bindingIdentity.hasNote && bindingIdentity.secondary ? (
                          <span
                            className={styles.bindingSecondary}
                            data-testid={`farm-container-binding-secondary-${container.id}`}
                          >
                            {bindingIdentity.secondary}
                          </span>
                        ) : null}
                      </div>
                    ) : lastBoundIdentity ? (
                      <div className={styles.bindingCell}>
                        <span
                          className={styles.bindingSecondary}
                          title={container.last_bound_account}
                          data-testid={`farm-container-last-bound-${container.id}`}
                        >
                          {t('farm.containers.last_bound_unbound', {
                            account: lastBoundIdentity.primary || container.last_bound_account,
                            defaultValue: '上次绑定：{{account}}（已解绑）',
                          })}
                        </span>
                      </div>
                    ) : (
                      <span className={styles.mono}>{t('farm.containers.no_binding')}</span>
                    )}
                  </TableCell>
                  <TableCell
                    alignRight
                    className={styles.stickyActions}
                    data-label={t('farm.containers.column_actions')}
                    onClick={onSelectContainer ? stopRowClick : undefined}
                    onKeyDown={onSelectContainer ? stopRowKeyDown : undefined}
                  >
                    <div className={styles.actions}>
                      {isArchived ? (
                        // 已归档容器不再提供任何行操作：不能重新绑定（设备已
                        // 不受农场管控），也不能再退役一次。
                        <span className={styles.mono}>—</span>
                      ) : isBound ? (
                        <Button
                          variant="danger"
                          size="sm"
                          loading={isUnbinding}
                          onClick={() => onUnbind(container)}
                          data-testid={`farm-unbind-button-${container.id}`}
                        >
                          {t('farm.containers.action_unbind')}
                        </Button>
                      ) : (
                        <>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => onBind(container)}
                            data-testid={`farm-bind-button-${container.id}`}
                          >
                            {t('farm.containers.action_bind')}
                          </Button>
                          <Button
                            variant="danger"
                            size="sm"
                            loading={isRetiring}
                            onClick={() => onRetire(container)}
                            data-testid={`farm-retire-button-${container.id}`}
                          >
                            {t('farm.actions.retire')}
                          </Button>
                        </>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        </ResponsiveTable>
      </AsyncPanel>
    </div>
  );
}
