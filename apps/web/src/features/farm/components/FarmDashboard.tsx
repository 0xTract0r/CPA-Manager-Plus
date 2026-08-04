import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import {
  IconBot,
  IconChartLine,
  IconModelCluster,
  IconSettings,
} from '@/components/ui/icons';
import { useFarmStore } from '@/stores';
import type { FarmContainerView } from '@/types/farm';
import { useFarmBindings } from '../hooks/useFarmBindings';
import { useFarmContainers } from '../hooks/useFarmContainers';
import { useFarmRetire } from '../hooks/useFarmRetire';
import { FarmAccountsPanel } from './FarmAccountsPanel';
import { FarmAlertsPanel } from './FarmAlertsPanel';
import { FarmBindModal } from './FarmBindModal';
import { FarmCapacityPanel } from './FarmCapacityPanel';
import { FarmConfigPanel } from './FarmConfigPanel';
import { FarmContainerDetail } from './FarmContainerDetail';
import {
  FarmContainerTable,
  type FarmContainerFilter,
} from './FarmContainerTable';
import { FarmOperationCard } from './FarmOperationCard';
import { FarmOverviewBar } from './FarmOverviewBar';
import { FarmResourcePanel } from './FarmResourcePanel';
import { FarmSectionDrawer, type FarmSection } from './FarmSectionDrawer';
import { FarmUsagePanel } from './FarmUsagePanel';
import styles from './FarmDashboard.module.scss';

const DRAWER_TRANSITION_MS = 370;

/**
 * 农场页信息架构主体。宿主页只需保留标题/副标题并渲染本组件；所有长表和配置
 * 都由单一 activeDrawer 管理，容器详情切换时等待上一 dialog 完成关闭，避免叠层。
 */
export function FarmDashboard() {
  const { t } = useTranslation();
  const isConfigured = useFarmStore((state) => state.isConfigured);
  const { containers, setContainers, loading, error, reload } = useFarmContainers();
  const { bindingPending, unbindingContainerId, bind, unbind } = useFarmBindings({
    setContainers,
    reload,
  });
  const { retiringContainerId, retire } = useFarmRetire({ setContainers, reload });

  const [activeDrawer, setActiveDrawer] = useState<FarmSection | null>(null);
  const [selectedContainer, setSelectedContainer] = useState<FarmContainerView | null>(null);
  const [containerFilter, setContainerFilter] = useState<FarmContainerFilter>('active');
  const [containerScrollTop, setContainerScrollTop] = useState(0);
  const [lastContainerId, setLastContainerId] = useState<string | null>(null);
  const [bindModalOpen, setBindModalOpen] = useState(false);
  const [preselectedContainerId, setPreselectedContainerId] = useState<string | null>(null);
  const [focusRestoreTarget, setFocusRestoreTarget] = useState<'container-row' | 'containers-trigger' | null>(
    null
  );
  const transitionTimerRef = useRef<number | null>(null);

  const clearTransitionTimer = useCallback(() => {
    if (transitionTimerRef.current !== null) {
      window.clearTimeout(transitionTimerRef.current);
      transitionTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearTransitionTimer, [clearTransitionTimer]);

  const openDrawer = useCallback((section: FarmSection) => {
    clearTransitionTimer();
    setActiveDrawer(section);
  }, [clearTransitionTimer]);

  const closeDrawer = useCallback(() => setActiveDrawer(null), []);

  const scheduleAfterDrawerClose = useCallback(
    (callback: () => void) => {
      clearTransitionTimer();
      setActiveDrawer(null);
      transitionTimerRef.current = window.setTimeout(() => {
        transitionTimerRef.current = null;
        callback();
      }, DRAWER_TRANSITION_MS);
    },
    [clearTransitionTimer]
  );

  const handleSelectContainer = useCallback(
    (container: FarmContainerView) => {
      const drawerBody = document
        .querySelector('[data-testid="farm-section-drawer-containers"]')
        ?.closest('.modal-body');
      setContainerScrollTop(drawerBody instanceof HTMLElement ? drawerBody.scrollTop : 0);
      setLastContainerId(container.id);
      scheduleAfterDrawerClose(() => setSelectedContainer(container));
    },
    [scheduleAfterDrawerClose]
  );

  const restoreContainerContext = useCallback(() => {
    setSelectedContainer(null);
    setFocusRestoreTarget(null);
    clearTransitionTimer();
    transitionTimerRef.current = window.setTimeout(() => {
      transitionTimerRef.current = null;
      setActiveDrawer('containers');
      setFocusRestoreTarget('container-row');
    }, DRAWER_TRANSITION_MS);
  }, [clearTransitionTimer]);

  const closeContainerDetail = useCallback(() => {
    setSelectedContainer(null);
    setFocusRestoreTarget(null);
    clearTransitionTimer();
    transitionTimerRef.current = window.setTimeout(() => {
      transitionTimerRef.current = null;
      setFocusRestoreTarget('containers-trigger');
    }, DRAWER_TRANSITION_MS);
  }, [clearTransitionTimer]);

  useEffect(() => {
    if (!focusRestoreTarget) return;

    let cancelled = false;
    let frameId = 0;
    let attempts = 0;

    const restoreFocus = () => {
      if (cancelled) return;

      const target =
        focusRestoreTarget === 'container-row' && lastContainerId
          ? document.querySelector<HTMLElement>(
              `[data-testid="farm-container-row-${CSS.escape(lastContainerId)}"]`
            )
          : document.querySelector<HTMLElement>('[data-testid="farm-containers-trigger"]');

      if (!target) {
        attempts += 1;
        if (attempts < 30) {
          frameId = window.requestAnimationFrame(restoreFocus);
        } else {
          setFocusRestoreTarget(null);
        }
        return;
      }

      if (focusRestoreTarget === 'container-row') {
        const drawerBody = document
          .querySelector('[data-testid="farm-section-drawer-containers"]')
          ?.closest('.modal-body');
        if (drawerBody instanceof HTMLElement) drawerBody.scrollTop = containerScrollTop;
      }

      target.focus();
      frameId = window.requestAnimationFrame(() => {
        if (document.activeElement === target) {
          setFocusRestoreTarget(null);
          return;
        }
        attempts += 1;
        if (attempts < 30) restoreFocus();
        else setFocusRestoreTarget(null);
      });
    };

    // Modal 在 open 后用零延时任务设置初始焦点。等待两轮绘制后再恢复，并在下一帧
    // 校验结果；若仍被抢焦点则短暂重试，避免依赖 rAF 与 setTimeout 的调度先后。
    frameId = window.requestAnimationFrame(() => {
      frameId = window.requestAnimationFrame(restoreFocus);
    });

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frameId);
    };
  }, [containerScrollTop, focusRestoreTarget, lastContainerId]);

  const openBindModal = useCallback(
    (container?: FarmContainerView) => {
      setPreselectedContainerId(container?.id ?? null);
      scheduleAfterDrawerClose(() => setBindModalOpen(true));
    },
    [scheduleAfterDrawerClose]
  );

  const closeBindModal = useCallback(() => {
    setBindModalOpen(false);
    clearTransitionTimer();
    transitionTimerRef.current = window.setTimeout(() => {
      transitionTimerRef.current = null;
      setActiveDrawer('containers');
    }, DRAWER_TRANSITION_MS);
  }, [clearTransitionTimer]);

  return (
    <div className={styles.dashboard} data-testid="farm-page">
      <section className={styles.connectionBar} aria-label={t('farm.ia.connectionStatus')}>
        <div className={styles.connectionCopy}>
          <span className={styles.connectionLabel}>{t('farm.ia.connectionStatus')}</span>
          <span
            className={`status-badge ${isConfigured ? 'success' : 'warning'} ${styles.connectionBadge}`}
            data-testid="farm-header-config-status"
          >
            {isConfigured ? t('farm.config.status_ready') : t('farm.config.status_missing')}
          </span>
        </div>
        <Button
          variant={isConfigured ? 'secondary' : 'primary'}
          size="sm"
          onClick={() => openDrawer('config')}
          aria-haspopup="dialog"
          aria-expanded={activeDrawer === 'config'}
          data-testid="farm-config-trigger"
        >
          <IconSettings size={16} />
          {isConfigured ? t('farm.ia.connectionSettings') : t('farm.ia.configureNow')}
        </Button>
      </section>

      {!isConfigured ? (
        <Card className={styles.notConfiguredCard}>
          <div data-testid="farm-not-configured">
            <EmptyState
              title={t('farm.containers.not_configured_title')}
              description={t('farm.ia.notConfiguredDesc')}
              action={
                <Button onClick={() => openDrawer('config')} data-testid="farm-config-empty-cta">
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
            {activeDrawer === 'alerts' ? null : (
              <FarmAlertsPanel mode="summary" onViewAll={() => openDrawer('alerts')} />
            )}
          </div>

          {/* 容量就绪度 + 「认证即自动供」状态（用户 2026-08-04 决策：容器供给改为
              全自动「认证即自动供」，裸「新建容器」入口移除，统一走「接入农场」）。 */}
          <FarmCapacityPanel />

          <section aria-labelledby="farm-operations-title">
            <div className={styles.sectionHeading}>
              <h2 id="farm-operations-title">{t('farm.ia.operationsTitle')}</h2>
              <p>{t('farm.ia.operationsDesc')}</p>
            </div>
            <div className={styles.operationsGrid} data-testid="farm-operations-grid">
              <FarmOperationCard
                section="accounts"
                icon={IconBot}
                title={t('farm.accounts.title')}
                description={t('farm.ia.accountsEntryDesc')}
                expanded={activeDrawer === 'accounts'}
                onOpen={() => openDrawer('accounts')}
              />
              <FarmOperationCard
                section="containers"
                icon={IconModelCluster}
                title={t('farm.containers.title')}
                description={t('farm.ia.containersEntryDesc')}
                expanded={activeDrawer === 'containers'}
                onOpen={() => openDrawer('containers')}
              />
              <FarmOperationCard
                section="resources"
                icon={IconChartLine}
                title={t('farm.resources.title')}
                description={t('farm.ia.resourcesEntryDesc')}
                expanded={activeDrawer === 'resources'}
                onOpen={() => openDrawer('resources')}
              />
              <FarmOperationCard
                section="usage"
                icon={IconChartLine}
                title={t('farm.usage.detailTitle')}
                description={t('farm.ia.usageEntryDesc')}
                expanded={activeDrawer === 'usage'}
                onOpen={() => openDrawer('usage')}
              />
            </div>
          </section>
        </div>
      )}

      <FarmSectionDrawer
        section="config"
        open={activeDrawer === 'config'}
        title={t('farm.config.title')}
        onClose={closeDrawer}
        width={760}
      >
        <div data-testid="farm-config-drawer">
          {activeDrawer === 'config' ? <FarmConfigPanel /> : null}
        </div>
      </FarmSectionDrawer>

      <FarmSectionDrawer
        section="alerts"
        open={activeDrawer === 'alerts'}
        title={t('farm.alerts.allTitle')}
        onClose={closeDrawer}
        width={840}
      >
        <div data-testid="farm-alerts-drawer">
          {activeDrawer === 'alerts' ? <FarmAlertsPanel mode="full" /> : null}
        </div>
      </FarmSectionDrawer>

      <FarmSectionDrawer
        section="accounts"
        open={activeDrawer === 'accounts'}
        title={t('farm.accounts.title')}
        onClose={closeDrawer}
      >
        <div data-testid="farm-accounts-drawer">
          {activeDrawer === 'accounts' ? <FarmAccountsPanel containers={containers} /> : null}
        </div>
      </FarmSectionDrawer>

      <FarmSectionDrawer
        section="containers"
        open={activeDrawer === 'containers'}
        title={t('farm.containers.title')}
        onClose={closeDrawer}
      >
        <div data-testid="farm-containers-drawer">
          {activeDrawer === 'containers' ? (
            <Card>
              <p className={styles.drawerDescription}>{t('farm.containers.desc')}</p>
              <FarmContainerTable
                containers={containers}
                loading={loading}
                error={error}
                unbindingContainerId={unbindingContainerId}
                retiringContainerId={retiringContainerId}
                onBind={openBindModal}
                onUnbind={unbind}
                onRetire={retire}
                onSelectContainer={handleSelectContainer}
                groupFilter={containerFilter}
                onGroupFilterChange={setContainerFilter}
              />
            </Card>
          ) : null}
        </div>
      </FarmSectionDrawer>

      <FarmSectionDrawer
        section="resources"
        open={activeDrawer === 'resources'}
        title={t('farm.resources.title')}
        onClose={closeDrawer}
      >
        <div data-testid="farm-resources-drawer">
          {activeDrawer === 'resources' ? <FarmResourcePanel /> : null}
        </div>
      </FarmSectionDrawer>

      <FarmSectionDrawer
        section="usage"
        open={activeDrawer === 'usage'}
        title={t('farm.usage.detailTitle')}
        onClose={closeDrawer}
      >
        <div data-testid="farm-usage-drawer">
          {activeDrawer === 'usage' ? <FarmUsagePanel /> : null}
        </div>
      </FarmSectionDrawer>

      <FarmBindModal
        open={bindModalOpen}
        submitting={bindingPending}
        containers={containers}
        preselectedContainerId={preselectedContainerId}
        onClose={closeBindModal}
        onSubmit={bind}
      />

      <FarmContainerDetail
        container={selectedContainer}
        onClose={closeContainerDetail}
        onBack={restoreContainerContext}
      />
    </div>
  );
}
