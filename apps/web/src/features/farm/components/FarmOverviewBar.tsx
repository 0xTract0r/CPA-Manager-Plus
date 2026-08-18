import { useMemo, type ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AsyncPanel } from '@/components/ui/AsyncPanel';
import {
  IconCheckCircle2,
  IconAlertTriangle,
  IconX,
  IconBot,
  IconDollarSign,
  IconTimer,
  type IconProps,
} from '@/components/ui/icons';
import type { FarmContainerView } from '@/types/farm';
import { formatDateTimeUtc8 } from '@/utils/datetime';
import { useFarmOverview } from '../hooks/useFarmOverview';
import styles from './FarmOverviewBar.module.scss';

interface FarmOverviewBarProps {
  // 「绑定账号」KPI 不来自 GET /api/farm/overview（该端点只聚合容器/事件计数，
  // 没有账号绑定视角）；复用 FarmPage 已经在轮询的容器列表就地统计
  // `binding` 非空的条数，避免为一个数字单独多拉一次 /accounts（还要按 env
  // 分别请求）。
  containers: FarmContainerView[];
}

type FarmOverviewKpiTone = 'ok' | 'warn' | 'err' | 'idle';

interface FarmOverviewKpiItem {
  key: string;
  icon: (props: IconProps) => ReactElement;
  tone: FarmOverviewKpiTone;
  label: string;
  value: string;
  testId: string;
  // 「未接入」占位态（后端本轮无诚实非零聚合路径的 KPI，如探针 cost）：置位时
  // 不渲染裸数值/裸横杠，改用中性 chip 明示「未接入」，避免首屏被误读成半成品。
  placeholder?: { chipLabel: string; title: string };
  // 可点导航：磁贴从静态数字升级为入口。`route` 跳转到对应筛选的容器池整页；
  // `anchor` 滚动到同页的告警区。带任一者时磁贴渲染成可聚焦的 button / a，并加
  // hover/focus 态。注意：本 app 用 createHashRouter，`#` 之后是路由命名空间，
  // 裸 hash 锚点会被当作路由跳转，anchor 分支必须 preventDefault 后手动滚动。
  action?:
    | { kind: 'route'; to: string; ariaLabel: string }
    | { kind: 'anchor'; href: string; ariaLabel: string };
}

/**
 * 首屏 KPI 概览带（design.md 决策6，tasks.md P0-9）：运行中/降级/离线容器、
 * 活跃告警、绑定账号、探针 cost、最近数据截至时间。前端聚合
 * GET /api/farm/overview + 本地容器列表统计。
 *
 * 诚实占位口径（design.md 决策4 + dto.go 注释：这些字段目前没有诚实的非零
 * 聚合路径，UI 不应把"没测出来"渲染成"确认为 0"）：
 * - 探针 cost：后端本轮恒 undefined。不渲染裸横杠数值（会被读作半成品），改用
 *   中性「未接入」chip + tooltip 说明待 P1 接入。
 * - device_id 漂移：后端本轮恒 0 占位、无可查询漂移历史。这里**不渲染**该 KPI
 *   （隐藏优于摆一个恒 0 的假确定值）；待 P1 有真实漂移历史时再加回。
 */
export function FarmOverviewBar({ containers }: FarmOverviewBarProps) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { overview, loading, error } = useFarmOverview();

  const boundAccountsCount = useMemo(
    () => containers.filter((c) => Boolean(c.binding)).length,
    [containers]
  );

  const runningCount = overview?.containers_by_status?.running ?? 0;
  const degradedCount = overview?.containers_by_status?.degraded ?? 0;
  const downCount = overview?.containers_by_status?.down ?? 0;
  const activeAlerts = overview?.active_alerts ?? 0;
  // 探针 cost 本轮后端恒 undefined（无诚实聚合路径）：wired=false 时不渲染裸数值，
  // 走「未接入」中性 chip 占位；未来后端补上聚合后自然回退到数值展示。
  const probeCostWired = typeof overview?.probe_token_cost_total_24h === 'number';
  const probeCostValue = probeCostWired
    ? (overview?.probe_token_cost_total_24h as number).toLocaleString()
    : '';
  const generatedAtText = overview?.generated_at
    ? formatDateTimeUtc8(overview.generated_at, i18n.language)
    : '—';

  const items: FarmOverviewKpiItem[] = [
    {
      key: 'running',
      icon: IconCheckCircle2,
      tone: 'ok',
      label: t('farm.overview.running', { defaultValue: '运行中容器' }),
      value: String(runningCount),
      testId: 'farm-overview-kpi-running',
    },
    {
      key: 'degraded',
      icon: IconAlertTriangle,
      tone: degradedCount > 0 ? 'warn' : 'idle',
      label: t('farm.overview.degraded', { defaultValue: '降级容器' }),
      value: String(degradedCount),
      testId: 'farm-overview-kpi-degraded',
    },
    {
      key: 'down',
      icon: IconX,
      tone: downCount > 0 ? 'err' : 'idle',
      label: t('farm.overview.down', { defaultValue: '离线容器' }),
      value: String(downCount),
      testId: 'farm-overview-kpi-down',
      // 磁贴可点：跳到容器池整页并预置「离线」筛选。
      action: {
        kind: 'route',
        to: '/farm/containers?filter=down',
        ariaLabel: t('farm.overview.downLink', { defaultValue: '查看离线容器' }),
      },
    },
    {
      key: 'alerts',
      icon: IconAlertTriangle,
      tone: activeAlerts > 0 ? 'err' : 'idle',
      label: t('farm.overview.activeAlerts', { defaultValue: '活跃告警' }),
      value: String(activeAlerts),
      testId: 'farm-overview-kpi-alerts',
      // 磁贴可点：滚动到同页告警区。
      action: {
        kind: 'anchor',
        href: '#farm-alerts-region',
        ariaLabel: t('farm.overview.alertsLink', { defaultValue: '查看活跃告警' }),
      },
    },
    {
      key: 'bound',
      icon: IconBot,
      tone: 'idle',
      label: t('farm.overview.boundAccounts', { defaultValue: '绑定账号' }),
      value: String(boundAccountsCount),
      testId: 'farm-overview-kpi-bound',
    },
    {
      key: 'probeCost',
      icon: IconDollarSign,
      tone: 'idle',
      label: t('farm.overview.probeCost', { defaultValue: '探针 cost (24h)' }),
      value: probeCostValue,
      testId: 'farm-overview-kpi-probe-cost',
      placeholder: probeCostWired
        ? undefined
        : {
            chipLabel: t('farm.overview.probeCostNotWired', { defaultValue: '未接入' }),
            title: t('farm.overview.probeCostNotWiredHint', {
              defaultValue: '探针 token cost 聚合待 P1 接入，当前无诚实数据来源',
            }),
          },
    },
  ];

  return (
    <div className={styles.bar} data-testid="farm-overview-bar">
      <AsyncPanel
        loading={loading}
        error={error}
        loadingLabel={t('common.loading')}
        loadingTestId="farm-overview-loading"
        errorTestId="farm-overview-error"
      >
        <div className={styles.kpiRow}>
          {items.map((item) => {
            const Icon = item.icon;
            const tileClass = `${styles.kpiTile} ${styles[item.tone]}${
              item.action ? ` ${styles.kpiTileClickable}` : ''
            }`;
            const tileInner = (
              <>
                <Icon size={18} />
                <div className={styles.kpiText}>
                  {item.placeholder ? (
                    <span
                      className={styles.kpiPlaceholderChip}
                      title={item.placeholder.title}
                      data-testid={`${item.testId}-placeholder`}
                    >
                      {item.placeholder.chipLabel}
                    </span>
                  ) : (
                    <span className={styles.kpiValue}>{item.value}</span>
                  )}
                  <span className={styles.kpiLabel}>{item.label}</span>
                </div>
              </>
            );

            // 可点磁贴：route → button（编程式导航到筛选整页）；anchor → a（拦截默认
            // 导航后手动 scrollIntoView 到同页告警区）。不可点磁贴保持静态 div。
            if (item.action?.kind === 'route') {
              const to = item.action.to;
              return (
                <button
                  key={item.key}
                  type="button"
                  className={tileClass}
                  data-testid={item.testId}
                  data-tone={item.tone}
                  aria-label={item.action.ariaLabel}
                  onClick={() => navigate(to)}
                >
                  {tileInner}
                </button>
              );
            }
            if (item.action?.kind === 'anchor') {
              const targetId = item.action.href.replace(/^#/, '');
              return (
                <a
                  key={item.key}
                  href={item.action.href}
                  className={tileClass}
                  data-testid={item.testId}
                  data-tone={item.tone}
                  aria-label={item.action.ariaLabel}
                  onClick={(e) => {
                    // 本 app 用 createHashRouter：裸 hash 锚点会被路由当作未匹配
                    // 相对路由落入 catch-all 跳回首页，而不是滚到同页告警区。
                    // 因此拦掉默认导航，手动滚动，绕开 HashRouter。
                    e.preventDefault();
                    document
                      .getElementById(targetId)
                      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }}
                >
                  {tileInner}
                </a>
              );
            }
            return (
              <div
                key={item.key}
                className={tileClass}
                data-testid={item.testId}
                data-tone={item.tone}
              >
                {tileInner}
              </div>
            );
          })}
        </div>
        <div className={styles.generatedAt} data-testid="farm-overview-generated-at">
          <IconTimer size={14} />
          <span>
            {t('farm.overview.generatedAt', { defaultValue: '数据截至' })}: {generatedAtText}
          </span>
          <span className={styles.generatedAtNote}>
            {t('farm.overview.generatedAtNote', {
              defaultValue: '（本次 API 响应生成时间，非精确的 Poller 最近巡检时刻）',
            })}
          </span>
        </div>
      </AsyncPanel>
    </div>
  );
}
