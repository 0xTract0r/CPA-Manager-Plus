import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '@/components/ui/Modal';
import { AsyncPanel } from '@/components/ui/AsyncPanel';
import { Button } from '@/components/ui/Button';
import { DataState } from '@/components/ui/DataState';
import { HealthPill, type HealthPillStatus } from '@/components/ui/HealthPill';
import { SegmentedTabs, type SegmentedTabItem } from '@/components/ui/SegmentedTabs';
import type { FarmContainerView, FarmEventView } from '@/types/farm';
import { formatDateTimeUtc8 } from '@/utils/datetime';
import { formatFileSize } from '@/utils/format';
import { formatDurationMs } from '@/utils/usage/latency';
import { formatUsd } from '@/utils/usage';
import { useFarmContainerDetail } from '../hooks/useFarmContainerDetail';
import { FarmTelemetryPanel } from './FarmTelemetryPanel';
import {
  deviceAlignmentToBadgeVariant,
  healthReasonToFarmHealthVariant,
  pctToFarmHealthVariant,
  successRateToFarmHealthVariant,
  type FarmHealthVariant,
} from '../utils/health';
// 注：FarmHealthVariant ('ok'|'warn'|'err'|'idle') 与 HealthPillStatus 字面量
// 集合逐字相同，下方直接把 healthReasonToFarmHealthVariant 等函数的返回值
// 传给 <HealthPill status=...>，不需要额外映射表/类型断言。
import {
  buildHistogram,
  mapSeriesToPoints,
  segmentToAreaPath,
  segmentToPolylinePoints,
  splitIntoSegments,
  type HistogramBucket,
} from '../utils/chart';
import styles from './FarmContainerDetail.module.scss';

// 账号·设备详情分区（用户已审批 IA 重设计，U11/决策②）：把此前 10 段纵向堆叠
// （遥测埋在第 8 段、要滚很久）并成 5 个 SegmentedTabs 分区。深链 initialTab
// 让账号面板的遥测入口能一键直达「遥测」分区，无需滚动。
export type FarmDetailTab = 'overview' | 'telemetry' | 'resources' | 'cadence' | 'events';

const FARM_DETAIL_TAB_IDBASE = 'farm-detail-tab';

interface FarmContainerDetailProps {
  container: FarmContainerView | null;
  onClose: () => void;
  onBack?: () => void;
  /** 返回按钮文案（默认「返回容器列表」）。账号面板入口传「返回账号列表」，
   *  让返回目标与来源列表一致（onBack 由 FarmDashboard 按来源恢复对应抽屉）。 */
  backLabel?: string;
  /**
   * 深链初始分区（默认 'overview'）。账号面板的 telemetry_alive 徽标 / ⋯管理菜单
   * 的「查看遥测」传 'telemetry' 直达遥测分区；容器表行点击走默认 'overview'。
   */
  initialTab?: FarmDetailTab;
}

const CHART_WIDTH = 320;
const CHART_HEIGHT = 64;

// probeCadence 未加载/无数据时的稳定空数组引用：直接写字面量 `[]` 会在每次
// render 产生新引用，导致依赖它的 useMemo（interval 时间轴/直方图）每次都
// 认为依赖变化而重新计算。提到模块级常量后引用稳定，行为（空输入→空输出）
// 不变。
const EMPTY_PROBE_INTERVALS: number[] = [];

const SEVERITY_TO_PILL: Record<FarmEventView['severity'], HealthPillStatus> = {
  critical: 'err',
  warning: 'warn',
  info: 'idle',
};

function formatPct(pct: number | undefined): string {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return '—';
  return `${pct.toFixed(1)}%`;
}

/**
 * 容器详情抽屉（design.md 决策6，tasks.md P0-9；IA 重设计 U11）：行点击 / 账号
 * 面板入口打开，聚合心跳/资源时序、生效间隔估算、device_id 对齐、探针 token
 * 趋势（标注非账单）、每容器遥测与事件时间线。设计系统当前没有独立 Drawer
 * 组件，复用既有 <Modal> 并通过 `className` 定制为右侧抽屉视觉（见 .module.scss
 * `:global(.modal)` 覆盖），不新增裸的模态基础组件。
 *
 * 信息架构：内容按 <SegmentedTabs> 分 5 区——概览 / 遥测 / 资源 / 节奏与用量 /
 * 事件（解决此前 10 段纵向堆叠、遥测埋在第 8 段要滚很久的 U11 痛点）。支持
 * initialTab 深链直达任一分区。抽屉初始焦点仍由 <Modal> 落在 drawerActions 的
 * 返回/关闭按钮（DOM 序在 tabs 之前），深链只改激活分区、不影响焦点陷阱。
 *
 * 三条底层请求（主详情/心跳时序/资源时序）用 Promise.allSettled 并行发起、
 * 独立捕获错误（见 useFarmContainerDetail）：只要主详情成功就打开抽屉正常
 * 渲染，心跳或资源时序其中一条失败只让对应图表区块落 block 级 error 态
 * （<DataState variant="error">），不连累已成功的主详情或另一条时序。
 */
export function FarmContainerDetail({
  container,
  onClose,
  onBack,
  backLabel,
  initialTab = 'overview',
}: FarmContainerDetailProps) {
  const { t, i18n } = useTranslation();
  const containerId = container?.id ?? null;

  // 激活分区。组件常驻挂载（container=null 时 Modal 内部返回 null，但本组件
  // 不卸载），故不能只靠 useState 初值——需在「打开新容器 / 深链目标分区变化」
  // 时重置到 initialTab。用 React 官方「渲染期依据变化派生 state」模式（追踪
  // 上一次 detailKey 并在渲染中比较、直接 setState），而非在 effect 里 setState
  // （避免级联渲染，满足 react-hooks/set-state-in-effect）。containerId 为空
  // （抽屉关闭）时只推进 key、不重置激活分区（避免关闭动画期间分区抖动），
  // 下次真正打开再重置——因此「关闭后原样重开同一容器+同一深链分区」也能正确
  // 重置（key 在关闭那一帧已从 'id::tab' 推进为 '::tab'，重开时必再变化）。
  const detailKey = `${containerId ?? ''}::${initialTab}`;
  const [activeTab, setActiveTab] = useState<FarmDetailTab>(initialTab);
  const [prevDetailKey, setPrevDetailKey] = useState(detailKey);
  if (detailKey !== prevDetailKey) {
    setPrevDetailKey(detailKey);
    if (containerId) setActiveTab(initialTab);
  }

  const {
    detail,
    keepalive,
    resources,
    probeCadence,
    usage,
    loading,
    error,
    keepaliveError,
    resourcesError,
    probeCadenceError,
    usageError,
  } = useFarmContainerDetail(containerId);

  const successRatePoints = useMemo(() => {
    const values = (keepalive?.buckets ?? []).map((b) =>
      b.sample_count > 0 ? b.success_rate * 100 : null
    );
    return mapSeriesToPoints(values, CHART_WIDTH, CHART_HEIGHT, { min: 0, max: 100 });
  }, [keepalive]);

  const latencyPoints = useMemo(() => {
    const values = (keepalive?.buckets ?? []).map((b) => b.avg_latency_ms ?? null);
    return mapSeriesToPoints(values, CHART_WIDTH, CHART_HEIGHT);
  }, [keepalive]);

  const memPoints = useMemo(() => {
    const values = (resources?.buckets ?? []).map((b) => b.avg_mem_bytes ?? null);
    return mapSeriesToPoints(values, CHART_WIDTH, CHART_HEIGHT);
  }, [resources]);

  const cpuPoints = useMemo(() => {
    const values = (resources?.buckets ?? []).map((b) => b.avg_cpu_pct ?? null);
    return mapSeriesToPoints(values, CHART_WIDTH, CHART_HEIGHT, { min: 0, max: 100 });
  }, [resources]);

  // 用户④「请求间隔 DTO」：探针到达间隔时间轴（按样本顺序，不是按时间跨度
  // 等距——每个点就是相邻探针的一次间隔，保序但不保跨度）+ 直方图（分布
  // 形状，不保序）。两者是对同一组 intervals_seconds 的两种不同问法，见
  // utils/chart.ts buildHistogram 顶部注释。
  const probeIntervals = probeCadence?.intervals_seconds ?? EMPTY_PROBE_INTERVALS;
  const intervalTimelinePoints = useMemo(
    () => mapSeriesToPoints(probeIntervals, CHART_WIDTH, CHART_HEIGHT),
    [probeIntervals]
  );
  const intervalHistogram = useMemo(() => buildHistogram(probeIntervals), [probeIntervals]);
  const intervalHistogramMaxCount = Math.max(1, ...intervalHistogram.map((b) => b.count));

  const open = Boolean(container);
  const healthVariant = healthReasonToFarmHealthVariant(detail?.health_reason);
  const successRate24hVariant = successRateToFarmHealthVariant(detail?.success_rate_24h);

  const tabItems: ReadonlyArray<SegmentedTabItem<FarmDetailTab>> = [
    { id: 'overview', label: t('farm.detail.tab_overview', { defaultValue: '概览' }) },
    { id: 'telemetry', label: t('farm.detail.tab_telemetry', { defaultValue: '遥测' }) },
    { id: 'resources', label: t('farm.detail.tab_resources', { defaultValue: '资源' }) },
    { id: 'cadence', label: t('farm.detail.tab_cadence', { defaultValue: '节奏与用量' }) },
    { id: 'events', label: t('farm.detail.tab_events', { defaultValue: '事件' }) },
  ];

  const panelProps = (tab: FarmDetailTab) => ({
    role: 'tabpanel' as const,
    id: `farm-detail-panel-${tab}`,
    'aria-labelledby': `${FARM_DETAIL_TAB_IDBASE}-${tab}`,
    'data-testid': `farm-detail-panel-${tab}`,
    className: styles.tabPanel,
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        // 真机走查点②：标题此前只裸显容器 ID，operator 一眼看不出这是哪个账号
        // 的详情。改成语义标题「账号·设备详情」+ 绑定账号标识（无绑定时显式
        // 兜底文案，不留空）+ 已有设备脱敏短识；容器 ID 降级为末尾小字保留
        // （排障仍用得到，只是不再充当标题主语）。
        container ? (
          <div className={styles.titleRow}>
            <span className={styles.titleId}>
              {t('farm.detail.titleLabel', { defaultValue: '账号 · 设备详情' })}
            </span>
            <span className={styles.titleAccount}>
              {container.binding?.account ||
                t('farm.detail.titleAccountUnbound', { defaultValue: '未绑定账号' })}
            </span>
            <span className={styles.titleMasked}>{container.device_id_masked}</span>
            <span className={styles.titleContainerId}>{container.id}</span>
          </div>
        ) : undefined
      }
      width={720}
      className={styles.drawer}
    >
      {!container ? null : (
        <div
          className={styles.body}
          data-testid="farm-container-detail-drawer"
          data-container-id={container.id}
        >
          <div className={styles.drawerActions}>
            {onBack ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={onBack}
                data-testid="farm-container-detail-back"
              >
                {backLabel ?? t('farm.ia.backToContainers')}
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              onClick={onClose}
              data-testid="farm-container-detail-close"
            >
              {t('common.close')}
            </Button>
          </div>
          <div data-testid={`farm-container-detail-${container.id}`}>
          <AsyncPanel
            loading={loading}
            error={error}
            loadingLabel={t('common.loading')}
            loadingTestId="farm-container-detail-loading"
            errorTestId="farm-container-detail-error"
          >
            {!detail ? null : (
              <>
                {/* 5 分区标签（IA 重设计）：概览 / 遥测 / 资源 / 节奏与用量 / 事件。
                    复用设计系统无障碍 <SegmentedTabs>（键盘方向键/roving tabindex），
                    不自造 tab。DOM 序在 drawerActions 之后，Modal 初始焦点仍落返回/
                    关闭按钮，深链切分区不破坏焦点陷阱。 */}
                <div className={styles.tabsRow} data-testid="farm-detail-tabs">
                  <SegmentedTabs
                    items={tabItems}
                    activeTab={activeTab}
                    ariaLabel={t('farm.detail.tabsAria', { defaultValue: '容器详情分区' })}
                    onChange={setActiveTab}
                    idBase={FARM_DETAIL_TAB_IDBASE}
                  />
                </div>

                {activeTab === 'overview' ? (
                  <div {...panelProps('overview')}>
                    {/* 健康摘要 */}
                    <section className={styles.section} data-testid="farm-detail-health">
                      <h3 className={styles.sectionTitle}>
                        {t('farm.detail.healthSection', { defaultValue: '健康状态' })}
                      </h3>
                      <div className={styles.healthRow}>
                        <HealthPill
                          status={healthVariant}
                          label={t(`farm.status.${detail.status}`, { defaultValue: detail.status })}
                          data-testid="farm-detail-status-pill"
                        />
                        <span className={styles.reasonText}>
                          {t(`farm.healthReason.${detail.health_reason ?? ''}`, {
                            defaultValue: detail.health_reason || '—',
                          })}
                        </span>
                      </div>
                    </section>

                    {/* 心跳 sparkline + latency */}
                    <section className={styles.section} data-testid="farm-detail-keepalive">
                      <h3 className={styles.sectionTitle}>
                        {t('farm.detail.keepaliveSection', {
                          defaultValue: '心跳成功率与延迟（近24h，1h 分桶）',
                        })}
                      </h3>
                      {keepaliveError ? (
                        <DataState
                          variant="error"
                          message={keepaliveError}
                          testId="farm-detail-keepalive-error"
                        />
                      ) : (
                        <>
                          <div className={styles.chartRow}>
                            <div className={styles.chartCol}>
                              <span className={styles.chartLabel}>
                                {t('farm.detail.successRate', { defaultValue: '成功率' })}{' '}
                                <span
                                  className={styles.chartValueBadge}
                                  data-variant={successRate24hVariant}
                                >
                                  {typeof detail.success_rate_24h === 'number'
                                    ? `${(detail.success_rate_24h * 100).toFixed(1)}%`
                                    : '—'}
                                </span>
                              </span>
                              <SparklineChart
                                segments={splitIntoSegments(successRatePoints)}
                                testId="farm-detail-success-rate-chart"
                              />
                            </div>
                            <div className={styles.chartCol}>
                              <span className={styles.chartLabel}>
                                {t('farm.detail.avgLatency', { defaultValue: '平均延迟 (ms)' })}
                              </span>
                              <SparklineChart
                                segments={splitIntoSegments(latencyPoints)}
                                testId="farm-detail-latency-chart"
                              />
                            </div>
                          </div>
                          {(keepalive?.buckets.length ?? 0) === 0 ? (
                            <p className={styles.hintText}>
                              {t('farm.detail.noKeepaliveSamples', {
                                defaultValue: '窗口内无心跳样本（空窗口是正常返回，不代表出错）。',
                              })}
                            </p>
                          ) : null}
                        </>
                      )}
                    </section>

                    {/* 生效间隔配置 + 下次估算 */}
                    <section className={styles.section} data-testid="farm-detail-next-estimate">
                      <h3 className={styles.sectionTitle}>
                        {t('farm.detail.nextEstimateSection', { defaultValue: '下次探针估算' })}
                      </h3>
                      {detail.next_keepalive_estimate ? (
                        <div className={styles.estimateBox}>
                          <span>
                            {t('farm.detail.estimateRange', { defaultValue: '配置区间' })}:{' '}
                            {formatDurationMs(detail.next_keepalive_estimate.min_seconds * 1000, {
                              maxUnits: 1,
                            })}{' '}
                            ~{' '}
                            {formatDurationMs(detail.next_keepalive_estimate.max_seconds * 1000, {
                              maxUnits: 1,
                            })}{' '}
                            (
                            {t('farm.detail.estimateBase', { defaultValue: '基准' })}{' '}
                            {formatDurationMs(detail.next_keepalive_estimate.base_seconds * 1000, {
                              maxUnits: 1,
                            })}
                            )
                          </span>
                          <span>
                            {t('farm.detail.estimateObserved', { defaultValue: '近24h实测均值' })}:{' '}
                            {typeof detail.next_keepalive_estimate.avg_observed_seconds_24h === 'number'
                              ? formatDurationMs(
                                  detail.next_keepalive_estimate.avg_observed_seconds_24h * 1000,
                                  { maxUnits: 1 }
                                )
                              : t('farm.overview.pendingP1', { defaultValue: '—/待P1' })}
                          </span>
                          <p className={styles.hintText}>{detail.next_keepalive_estimate.note}</p>
                        </div>
                      ) : (
                        <p className={styles.hintText}>
                          {t('farm.detail.noEstimate', {
                            defaultValue: '该状态不再有下一次探针（非 running/degraded 容器）。',
                          })}
                        </p>
                      )}
                    </section>

                    {/* device_id 对齐卡 */}
                    <section className={styles.section} data-testid="farm-detail-device-id">
                      <h3 className={styles.sectionTitle}>
                        {t('farm.detail.deviceIdSection', { defaultValue: 'device_id 对齐' })}
                      </h3>
                      <div className={styles.deviceIdRow}>
                        <span
                          className={`status-badge ${deviceAlignmentToBadgeVariant(detail.device_id_alignment)}`}
                        >
                          {t(
                            `auth_files.account_settings_device_id_source_${detail.device_id_alignment ?? 'unknown'}`,
                            { defaultValue: detail.device_id_alignment ?? t('farm.accountHealth.unbound') }
                          )}
                        </span>
                        <span className={styles.mono}>{detail.device_id_masked}</span>
                      </div>
                      <p className={styles.hintText}>
                        {t('farm.detail.deviceIdDriftGap', {
                          defaultValue:
                            '漂移历史时间线属于 P1（container_deviceid_checks 迁移，暂未落地），这里只展示当前一次对齐判定，不是完整历史。',
                        })}
                      </p>
                    </section>
                  </div>
                ) : null}

                {activeTab === 'telemetry' ? (
                  <div {...panelProps('telemetry')}>
                    {/* 用户⑤：每容器遥测内容（自报 beacon）——declared vs on-wire
                        自洽卡（on-wire 待抓取灰置）+ 时间线 + 通道分布 + 新鲜度。
                        保留 on-wire 未接入的诚实边界横幅（面板内自带），不删。
                        detail 继承 FarmContainerView，非空分支内直接传。 */}
                    <FarmTelemetryPanel container={detail} />
                  </div>
                ) : null}

                {activeTab === 'resources' ? (
                  <div {...panelProps('resources')}>
                    {/* 资源 area 图 */}
                    <section className={styles.section} data-testid="farm-detail-resources">
                      <h3 className={styles.sectionTitle}>
                        {t('farm.detail.resourcesSection', {
                          defaultValue: '资源占用（近24h，1h 分桶）',
                        })}
                      </h3>
                      {resourcesError ? (
                        <DataState
                          variant="error"
                          message={resourcesError}
                          testId="farm-detail-resources-error"
                        />
                      ) : (
                        <>
                          <div className={styles.chartRow}>
                            <div className={styles.chartCol}>
                              <span className={styles.chartLabel}>
                                {t('farm.resources.mem', { defaultValue: '内存' })}
                                {detail.latest_resource?.mem_used_bytes !== undefined
                                  ? ` · ${formatFileSize(detail.latest_resource.mem_used_bytes)}`
                                  : ''}
                              </span>
                              <AreaChart
                                segments={splitIntoSegments(memPoints)}
                                testId="farm-detail-mem-chart"
                              />
                            </div>
                            <div className={styles.chartCol}>
                              <span className={styles.chartLabel}>
                                {t('farm.resources.cpu', { defaultValue: 'CPU' })}
                                {typeof detail.latest_resource?.cpu_pct === 'number'
                                  ? ` · ${formatPct(detail.latest_resource.cpu_pct)}`
                                  : ''}
                              </span>
                              <AreaChart
                                segments={splitIntoSegments(cpuPoints)}
                                testId="farm-detail-cpu-chart"
                                variant={pctToFarmHealthVariant(detail.latest_resource?.cpu_pct)}
                              />
                            </div>
                          </div>
                          {(resources?.buckets.length ?? 0) === 0 ? (
                            <p className={styles.hintText}>
                              {t('farm.detail.noResourceSamples', {
                                defaultValue: '窗口内无资源样本（空窗口是正常返回，不代表出错）。',
                              })}
                            </p>
                          ) : null}
                        </>
                      )}
                    </section>
                  </div>
                ) : null}

                {activeTab === 'cadence' ? (
                  <div {...panelProps('cadence')}>
                    {/* 用户④「请求间隔 DTO」：探针保活节奏 vs 账号 CPA 累计用量，
                        两栏各标口径（scope），消除两时钟混淆（sorrygml40「一绑定
                        就163次」曾把账号累计请求数误当成探针触发次数）。 */}
                    <section className={styles.section} data-testid="farm-detail-probe-cadence">
                      <h3 className={styles.sectionTitle}>
                        {t('farm.detail.probeCadenceSection', {
                          defaultValue: '探针保活节奏（到达间隔）',
                        })}
                      </h3>
                      <span
                        className={styles.scopeBadge}
                        data-testid="farm-detail-probe-cadence-scope"
                      >
                        {t('farm.detail.probeCadenceScopeBadge', { defaultValue: '口径：探针到达间隔' })}
                      </span>
                      {probeCadenceError ? (
                        <DataState
                          variant="error"
                          message={probeCadenceError}
                          testId="farm-detail-probe-cadence-error"
                        />
                      ) : (
                        <>
                          {probeCadence?.note ? <p className={styles.hintText}>{probeCadence.note}</p> : null}
                          <div className={styles.estimateBox}>
                            <span>
                              {t('farm.detail.probeCadenceLastFired', { defaultValue: '最近一次探针' })}:{' '}
                              {probeCadence?.last_fired_at
                                ? formatDateTimeUtc8(probeCadence.last_fired_at, i18n.language)
                                : t('farm.containers.never')}
                            </span>
                            <span>
                              {t('farm.detail.probeCadenceSampleCount', { defaultValue: '样本数' })}:{' '}
                              {probeCadence?.sample_count ?? 0}
                            </span>
                          </div>
                          {probeIntervals.length === 0 ? (
                            <p className={styles.hintText} data-testid="farm-detail-probe-cadence-empty">
                              {t('farm.detail.probeCadenceIntervalsEmpty', {
                                defaultValue:
                                  '窗口内暂无探针间隔样本（空窗口是正常返回，不代表出错）。',
                              })}
                            </p>
                          ) : (
                            <>
                              <div className={styles.chartCol}>
                                <span className={styles.chartLabel}>
                                  {t('farm.detail.probeCadenceTimelineTitle', {
                                    defaultValue: '间隔时间轴（按到达顺序，秒）',
                                  })}
                                </span>
                                <SparklineChart
                                  segments={splitIntoSegments(intervalTimelinePoints)}
                                  testId="farm-detail-probe-cadence-timeline"
                                />
                              </div>
                              <div className={styles.chartCol}>
                                <span className={styles.chartLabel}>
                                  {t('farm.detail.probeCadenceHistogramTitle', {
                                    defaultValue: '间隔分布直方图',
                                  })}
                                </span>
                                <div
                                  className={styles.histogramRow}
                                  data-testid="farm-detail-probe-cadence-histogram"
                                >
                                  {intervalHistogram.map((bucket, i) => (
                                    <HistogramBar
                                      key={i}
                                      bucket={bucket}
                                      maxCount={intervalHistogramMaxCount}
                                    />
                                  ))}
                                </div>
                              </div>
                            </>
                          )}
                          {probeCadence?.next_expected_window ? (
                            <div className={styles.estimateBox}>
                              <span>
                                {t('farm.detail.probeCadenceNextWindow', { defaultValue: '下次预计窗口' })}
                                :{' '}
                                {formatDurationMs(
                                  probeCadence.next_expected_window.min_seconds * 1000,
                                  { maxUnits: 1 }
                                )}{' '}
                                ~{' '}
                                {formatDurationMs(
                                  probeCadence.next_expected_window.max_seconds * 1000,
                                  { maxUnits: 1 }
                                )}
                                {typeof probeCadence.next_expected_window.avg_observed_seconds_24h ===
                                'number'
                                  ? ` (${t('farm.detail.estimateObserved', { defaultValue: '近24h实测均值' })} ${formatDurationMs(
                                      probeCadence.next_expected_window.avg_observed_seconds_24h * 1000,
                                      { maxUnits: 1 }
                                    )})`
                                  : ''}
                              </span>
                              <p className={styles.hintText}>{probeCadence.next_expected_window.note}</p>
                            </div>
                          ) : null}
                        </>
                      )}
                    </section>

                    <section className={styles.section} data-testid="farm-detail-cpa-usage">
                      <h3 className={styles.sectionTitle}>
                        {t('farm.detail.cpaUsageSection', { defaultValue: '账号 CPA 累计用量' })}
                      </h3>
                      <span className={styles.scopeBadge} data-testid="farm-detail-cpa-usage-scope">
                        {t('farm.detail.cpaUsageScopeBadge', { defaultValue: '口径：账号 CPA 累计' })}
                      </span>
                      {usageError ? (
                        <DataState
                          variant="error"
                          message={usageError}
                          testId="farm-detail-cpa-usage-error"
                        />
                      ) : usage ? (
                        <div className={styles.estimateBox}>
                          <span>
                            {t('farm.detail.cpaUsageRequests', { defaultValue: '累计请求数' })}:{' '}
                            {usage.requests.toLocaleString()}
                          </span>
                          <span>
                            {t('farm.detail.cpaUsageTokensTotal', { defaultValue: '累计 Token' })}:{' '}
                            {usage.tokens.total.toLocaleString()}
                          </span>
                          <span>
                            {t('farm.detail.cpaUsageCost', { defaultValue: '累计费用（USD）' })}:{' '}
                            {formatUsd(usage.cost_usd)}
                          </span>
                          <p className={styles.hintText}>
                            {t('farm.detail.cpaUsageVsProbeHint', {
                              defaultValue:
                                '此处请求数是账号在 CPA 侧的累计计数，不等于上方探针到达次数，两者口径独立，不能相加或替代。',
                            })}
                          </p>
                        </div>
                      ) : (
                        <p className={styles.hintText} data-testid="farm-detail-cpa-usage-empty">
                          {t('farm.detail.cpaUsageNotFound', {
                            defaultValue:
                              '本容器绑定账号暂无用量数据（可能尚未产生任何请求，或用量聚合暂不可用）。',
                          })}
                        </p>
                      )}
                    </section>

                    {/* 探针 token 趋势 */}
                    <section className={styles.section} data-testid="farm-detail-probe-tokens">
                      <h3 className={styles.sectionTitle}>
                        {t('farm.detail.probeTokenSection', { defaultValue: '探针 token 趋势' })}
                      </h3>
                      <p className={styles.probeTokenBadge}>
                        {t('farm.detail.probeTokenNotBilling', {
                          defaultValue: '探针 token ≠ 账单：这里只反映保活探针自身消耗，不是账号真实计费用量。',
                        })}
                      </p>
                      <p className={styles.hintText}>
                        {t('farm.detail.probeTokenGap', {
                          defaultValue:
                            '本轮聚合读取路径未接入 tokens_total 求和（见交付说明 gaps），暂无法诚实展示趋势图，待 P1/store 层补聚合列后接入。',
                        })}
                      </p>
                    </section>
                  </div>
                ) : null}

                {activeTab === 'events' ? (
                  <div {...panelProps('events')}>
                    {/* 状态/告警事件时间线 */}
                    <section className={styles.section} data-testid="farm-detail-events">
                      <h3 className={styles.sectionTitle}>
                        {t('farm.detail.eventsSection', { defaultValue: '状态 / 告警事件' })}
                      </h3>
                      {detail.open_events.length === 0 ? (
                        <p className={styles.hintText}>
                          {t('farm.detail.noOpenEvents', { defaultValue: '当前没有仍在 firing 的事件。' })}
                        </p>
                      ) : (
                        <ul className={styles.eventList}>
                          {detail.open_events.map((event) => (
                            <li key={event.id} className={styles.eventItem}>
                              <HealthPill
                                status={SEVERITY_TO_PILL[event.severity]}
                                label={t(`farm.healthReason.${event.reason}`, {
                                  defaultValue: event.reason,
                                })}
                              />
                              <span className={styles.mono}>{formatDateTimeUtc8(event.ts, i18n.language)}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                      <p className={styles.hintText}>
                        {t('farm.detail.eventsHistoryGap', {
                          defaultValue: '只展示当前仍 firing 的事件，暂非完整历史时间线（见交付说明 gaps）。',
                        })}
                      </p>
                    </section>
                  </div>
                ) : null}
              </>
            )}
          </AsyncPanel>
          </div>
        </div>
      )}
    </Modal>
  );
}

function SparklineChart({
  segments,
  testId,
}: {
  segments: ReturnType<typeof splitIntoSegments>;
  testId: string;
}) {
  if (segments.length === 0) {
    return (
      <svg
        width={CHART_WIDTH}
        height={CHART_HEIGHT}
        className={styles.chartSvg}
        data-testid={testId}
        role="img"
        aria-label=""
      />
    );
  }
  return (
    <svg
      width={CHART_WIDTH}
      height={CHART_HEIGHT}
      className={styles.chartSvg}
      data-testid={testId}
      role="img"
      aria-hidden="true"
    >
      {segments.map((segment, i) => (
        <polyline
          key={i}
          points={segmentToPolylinePoints(segment)}
          fill="none"
          className={styles.sparklineStroke}
        />
      ))}
    </svg>
  );
}

function AreaChart({
  segments,
  testId,
  variant,
}: {
  segments: ReturnType<typeof splitIntoSegments>;
  testId: string;
  variant?: FarmHealthVariant;
}) {
  return (
    <svg
      width={CHART_WIDTH}
      height={CHART_HEIGHT}
      className={styles.chartSvg}
      data-testid={testId}
      data-variant={variant}
      role="img"
      aria-hidden="true"
    >
      {segments.map((segment, i) => {
        const path = segmentToAreaPath(segment, CHART_HEIGHT);
        if (!path) return null;
        return <path key={i} d={path} className={styles.areaFill} />;
      })}
    </svg>
  );
}

/**
 * 探针到达间隔直方图的单个条形（用户④「请求间隔 DTO」）。用 CSS 高度百分比
 * 而非 SVG——分桶数少（默认 8 桶）、不需要坐标几何映射，纯 flex+div 已经
 * 足够清晰，避免为一个简单条形图重新实现 SVG path 计算（对齐 design.md
 * 「可用轻量能力，不引重型图表库」的既有取舍，见 utils/chart.ts 顶部注释）。
 */
function HistogramBar({ bucket, maxCount }: { bucket: HistogramBucket; maxCount: number }) {
  const heightPct = maxCount > 0 ? Math.max(4, (bucket.count / maxCount) * 100) : 0;
  const rangeLabel = `${formatDurationMs(bucket.rangeStart * 1000, { maxUnits: 1 })} ~ ${formatDurationMs(
    bucket.rangeEnd * 1000,
    { maxUnits: 1 }
  )}`;
  return (
    <div className={styles.histogramBarCol} title={`${rangeLabel}: ${bucket.count}`}>
      <div className={styles.histogramBarTrack}>
        <div
          className={styles.histogramBar}
          style={{ height: `${heightPct}%` }}
          data-testid="farm-detail-probe-cadence-histogram-bar"
        />
      </div>
      <span className={styles.histogramBarCount}>{bucket.count}</span>
    </div>
  );
}
