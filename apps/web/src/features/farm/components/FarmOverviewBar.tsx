import { useMemo, type ReactElement } from 'react';
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
}

/**
 * 首屏 KPI 概览带（design.md 决策6，tasks.md P0-9）：运行中/降级/离线容器、
 * 活跃告警、绑定账号、探针 cost、最近数据截至时间。前端聚合
 * GET /api/farm/overview + 本地容器列表统计。
 *
 * 占位 KPI（探针 cost / device_id 漂移，后端本轮恒空/恒 0 占位）明确显示
 * "—/待P1"而非 0——design.md 决策4 与 dto.go 注释都强调这两个字段目前没有
 * 诚实的非零聚合路径，UI 不应该把"没测出来"渲染成"确认为 0"。
 */
export function FarmOverviewBar({ containers }: FarmOverviewBarProps) {
  const { t, i18n } = useTranslation();
  const { overview, loading, error } = useFarmOverview();

  const boundAccountsCount = useMemo(
    () => containers.filter((c) => Boolean(c.binding)).length,
    [containers]
  );

  const runningCount = overview?.containers_by_status?.running ?? 0;
  const degradedCount = overview?.containers_by_status?.degraded ?? 0;
  const downCount = overview?.containers_by_status?.down ?? 0;
  const activeAlerts = overview?.active_alerts ?? 0;
  const probeCostText =
    typeof overview?.probe_token_cost_total_24h === 'number'
      ? overview.probe_token_cost_total_24h.toLocaleString()
      : t('farm.overview.pendingP1', { defaultValue: '—/待P1' });
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
    },
    {
      key: 'alerts',
      icon: IconAlertTriangle,
      tone: activeAlerts > 0 ? 'err' : 'idle',
      label: t('farm.overview.activeAlerts', { defaultValue: '活跃告警' }),
      value: String(activeAlerts),
      testId: 'farm-overview-kpi-alerts',
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
      value: probeCostText,
      testId: 'farm-overview-kpi-probe-cost',
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
            return (
              <div
                key={item.key}
                className={`${styles.kpiTile} ${styles[item.tone]}`}
                data-testid={item.testId}
                data-tone={item.tone}
              >
                <Icon size={18} />
                <div className={styles.kpiText}>
                  <span className={styles.kpiValue}>{item.value}</span>
                  <span className={styles.kpiLabel}>{item.label}</span>
                </div>
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
