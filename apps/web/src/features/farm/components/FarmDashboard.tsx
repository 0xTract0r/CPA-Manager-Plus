import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconSettings } from '@/components/ui/icons';
import { useFarmStore } from '@/stores';
import { useFarmContainers } from '../hooks/useFarmContainers';
import { FarmAlertsPanel } from './FarmAlertsPanel';
import { FarmCapacityPanel } from './FarmCapacityPanel';
import { FarmConfigPanel } from './FarmConfigPanel';
import { FarmOverviewBar } from './FarmOverviewBar';
import styles from './FarmDashboard.module.scss';

/**
 * 设备农场总览（/farm 首页）。
 *
 * 农场信息架构从「右侧抽屉覆盖」重构为独立路由整页后，本组件只保留总览：连接
 * 状态条 + 连接设置（内联展开，替代原 config 抽屉）+ KPI 概览带 + 告警（摘要，
 * 「查看全部」内联展开）+ 容量就绪度。账号状态 / 容器池 / 资源占用 / 用量明细 /
 * 容器详情都已迁到各自的独立路由页（见 features/farm/pages/ 与侧栏农场分组子项）。
 *
 * 农场编排器是独立后端（独立 base URL + 独立 admin key），刻意不接 CPA
 * managementKey / apiClient，编排器 401 不会把 cpamp 管理会话登出。
 */
export function FarmDashboard() {
  const { t } = useTranslation();
  const isConfigured = useFarmStore((state) => state.isConfigured);
  const orchestratorBaseUrl = useFarmStore((state) => state.orchestratorBaseUrl);
  const farmAdminKey = useFarmStore((state) => state.farmAdminKey);
  // 总览只需要容器快照（KPI 概览带）+ 连接徽标的 loading/error 派生，不发额外请求。
  const { containers, loading, error } = useFarmContainers();

  // 默认零配置模式（未设置高级覆盖）下农场页始终可用。只有 operator 显式填了
  // 高级覆盖（连别的编排器）但配置无效或连不上时，才用「未就绪」卡片替换总览。
  const hasOverride = Boolean(orchestratorBaseUrl || farmAdminKey);
  const overrideUnhealthy = hasOverride && (!isConfigured || Boolean(error));

  // 头部连接徽标如实反映后端真实健康（去假绿）。同源模式从主容器查询已有的
  // loading/error 派生；高级覆盖模式沿用既有 ready/error 逻辑。
  const connectionBadge: {
    variant: 'success' | 'warning' | 'error' | 'muted';
    label: string;
    reason?: string;
  } = hasOverride
    ? overrideUnhealthy
      ? { variant: 'warning', label: t('farm.config.status_override_error') }
      : { variant: 'success', label: t('farm.config.status_override_ready') }
    : error
      ? { variant: 'error', label: t('farm.config.status_same_origin_error'), reason: error }
      : loading
        ? { variant: 'muted', label: t('farm.config.status_same_origin_loading') }
        : { variant: 'success', label: t('farm.config.status_same_origin') };

  // 连接设置从右侧抽屉降级为内联展开的高级覆盖卡（默认收起）。
  const [configOpen, setConfigOpen] = useState(false);
  // 告警从摘要「查看全部」抽屉降级为内联展开的完整列表。
  const [showAllAlerts, setShowAllAlerts] = useState(false);

  return (
    <div className={styles.dashboard} data-testid="farm-page">
      <section className={styles.connectionBar} aria-label={t('farm.ia.connectionStatus')}>
        <div className={styles.connectionCopy}>
          <span className={styles.connectionLabel}>{t('farm.ia.connectionStatus')}</span>
          <span
            className={`status-badge ${connectionBadge.variant} ${styles.connectionBadge}`}
            data-testid="farm-header-config-status"
            title={connectionBadge.reason}
          >
            {connectionBadge.label}
          </span>
        </div>
        <Button
          variant={overrideUnhealthy ? 'primary' : 'secondary'}
          size="sm"
          onClick={() => setConfigOpen((open) => !open)}
          aria-expanded={configOpen}
          aria-controls="farm-config-inline"
          data-testid="farm-config-trigger"
        >
          <IconSettings size={16} />
          {t('farm.ia.connectionSettings')}
        </Button>
      </section>

      {configOpen ? (
        <Card>
          <div id="farm-config-inline" data-testid="farm-config-inline">
            <FarmConfigPanel />
          </div>
        </Card>
      ) : null}

      {overrideUnhealthy ? (
        <Card className={styles.notConfiguredCard}>
          <div data-testid="farm-not-configured">
            <EmptyState
              title={t('farm.containers.not_configured_title')}
              description={t('farm.ia.notConfiguredDesc')}
              action={
                <Button onClick={() => setConfigOpen(true)} data-testid="farm-config-empty-cta">
                  {t('farm.ia.configureNow')}
                </Button>
              }
            />
          </div>
        </Card>
      ) : (
        <div className={styles.configuredContent}>
          <div className={styles.firstScreen} data-testid="farm-first-screen">
            <FarmOverviewBar containers={containers} />
            {/* 告警区锚点：FarmOverviewBar 的「活跃告警」磁贴用 #farm-alerts-region
                原生 hash 滚动到这里。scroll-margin 让锚点不被上方内容压住。 */}
            <div id="farm-alerts-region" className={styles.alertsRegion}>
            {showAllAlerts ? (
              <Card>
                <div data-testid="farm-alerts-inline">
                  <div className={styles.inlineAlertsHeader}>
                    <span className={styles.inlineAlertsTitle}>{t('farm.alerts.allTitle')}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowAllAlerts(false)}
                      data-testid="farm-alerts-collapse"
                    >
                      {t('farm.ia.collapseAlerts', { defaultValue: '收起' })}
                    </Button>
                  </div>
                  <FarmAlertsPanel mode="full" />
                </div>
              </Card>
            ) : (
              <FarmAlertsPanel mode="summary" onViewAll={() => setShowAllAlerts(true)} />
            )}
            </div>
          </div>

          {/* 容量就绪度 + 「认证即自动供」状态。 */}
          <FarmCapacityPanel />
        </div>
      )}
    </div>
  );
}
