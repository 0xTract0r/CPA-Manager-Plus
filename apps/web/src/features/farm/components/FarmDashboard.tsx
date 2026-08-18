import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconSettings } from '@/components/ui/icons';
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
import { FarmContainerDetail, type FarmDetailTab } from './FarmContainerDetail';
import {
  FarmContainerTable,
  type FarmContainerFilter,
} from './FarmContainerTable';
import { FarmOverviewBar } from './FarmOverviewBar';
import { FarmResourcePanel } from './FarmResourcePanel';
import { FarmSectionDrawer, type FarmSection } from './FarmSectionDrawer';
import { FarmUsagePanel } from './FarmUsagePanel';
import styles from './FarmDashboard.module.scss';

const DRAWER_TRANSITION_MS = 370;

// 侧栏「农场」分组下持久子导航项 /farm/<section> → 对应右侧抽屉分区（纯函数，供
// useState 初始化器读取 URL 用；深链只覆盖账号/容器/资源/用量，config/alerts 不深链）。
function deriveFarmDeepLinkSection(pathname: string): FarmSection | null {
  const path = pathname.replace(/\/+$/, '');
  if (path.endsWith('/farm/accounts')) return 'accounts';
  if (path.endsWith('/farm/containers')) return 'containers';
  if (path.endsWith('/farm/resources')) return 'resources';
  if (path.endsWith('/farm/usage')) return 'usage';
  return null;
}

/**
 * 农场页信息架构主体。宿主页只需保留标题/副标题并渲染本组件；所有长表和配置
 * 都由单一 activeDrawer 管理，容器详情切换时等待上一 dialog 完成关闭，避免叠层。
 */
export function FarmDashboard() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const isConfigured = useFarmStore((state) => state.isConfigured);
  const orchestratorBaseUrl = useFarmStore((state) => state.orchestratorBaseUrl);
  const farmAdminKey = useFarmStore((state) => state.farmAdminKey);
  const { containers, setContainers, loading, error, reload } = useFarmContainers();
  const { bindingPending, unbindingContainerId, bind, unbind } = useFarmBindings({
    setContainers,
    reload,
  });
  const { retiringContainerId, retire } = useFarmRetire({ setContainers, reload });

  // 默认零配置模式（未设置高级覆盖）下农场页始终可用，不再需要"未配置"空态。
  // 只有 operator 显式填了高级覆盖（连别的编排器）但配置无效或连不上时，才
  // 用"未就绪"卡片替换整页内容并引导去检查设置。
  const hasOverride = Boolean(orchestratorBaseUrl || farmAdminKey);
  const overrideUnhealthy = hasOverride && (!isConfigured || Boolean(error));

  // 头部连接徽标必须如实反映后端真实健康，不再在同源模式下恒显绿色（去假绿）。
  // 同源模式从主容器查询（useFarmContainers）已有的 loading/error 状态派生，不新发请求：
  //   - loading（首次加载未回）                                   → 连接中（中性 muted）
  //   - error（服务端反代 503 / 编排器 502 / 鉴权 401 / 网络失败）→ 代理不可用（红），原因经 title 暴露
  //   - 成功                                                     → 同源代理已连通（绿）
  // 高级覆盖模式（override）沿用既有 ready/error 逻辑不变。
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

  // 农场 ↔ /farm/<section> 导航会重挂载本页（PageTransition 按 location.key 分层重挂），
  // 因此用 useState 初始化器在挂载时直接从 URL 读取初始抽屉——无需 effect 同步（规避
  // setState-in-effect 级联渲染），也天然支持浏览器前进/后退与刷新深链。config/alerts 等
  // 非深链抽屉仍由内部交互置位，URL 无 section 段时初始为 null。
  const [activeDrawer, setActiveDrawer] = useState<FarmSection | null>(() =>
    deriveFarmDeepLinkSection(location.pathname)
  );
  const [selectedContainer, setSelectedContainer] = useState<FarmContainerView | null>(null);
  const [containerFilter, setContainerFilter] = useState<FarmContainerFilter>('all');
  const [containerScrollTop, setContainerScrollTop] = useState(0);
  const [lastContainerId, setLastContainerId] = useState<string | null>(null);
  const [bindModalOpen, setBindModalOpen] = useState(false);
  const [preselectedContainerId, setPreselectedContainerId] = useState<string | null>(null);
  // IA 重设计：统一详情的深链初始分区 + 来源（账号表 / 容器表）。来源决定
  // 「返回」和关闭后恢复到哪个抽屉/触发器，复用既有 scheduleAfterDrawerClose 时序。
  const [detailInitialTab, setDetailInitialTab] = useState<FarmDetailTab>('overview');
  const [detailOrigin, setDetailOrigin] = useState<'containers' | 'accounts'>('containers');
  // 首屏「管理入口」触发器网格已整块移除（提升为侧栏持久子导航项），农场首屏
  // 不再有账号/容器触发器可回焦——回焦目标只剩「容器详情返回容器抽屉时聚焦原
  // 容器行」这一种（container-row），故不再有 *-trigger 分支。
  const [focusRestoreTarget, setFocusRestoreTarget] = useState<'container-row' | null>(null);
  const transitionTimerRef = useRef<number | null>(null);

  const clearTransitionTimer = useCallback(() => {
    if (transitionTimerRef.current !== null) {
      window.clearTimeout(transitionTimerRef.current);
      transitionTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearTransitionTimer, [clearTransitionTimer]);

  // 关闭深链抽屉时回到农场首屏 URL（/farm），去掉尾部 /farm/<section> 段；这样再次
  // 点击同一侧栏项才会产生真实导航并重新打开（同址点击不会触发导航），浏览器历史也保持
  // 与抽屉状态一致。非深链抽屉（config/alerts，URL 无 section 段）时为无副作用 no-op。
  // routeBase 前缀（demo 站点）通过只裁剪尾部 section 段、保留其余路径而天然兼容。
  const resetFarmDeepLinkUrl = useCallback(() => {
    const path = location.pathname;
    const base = path.replace(/\/(accounts|containers|resources|usage)\/*$/, '');
    if (base !== path) {
      navigate(base || '/farm', { replace: true });
    }
  }, [location.pathname, navigate]);

  const openDrawer = useCallback((section: FarmSection) => {
    clearTransitionTimer();
    setActiveDrawer(section);
  }, [clearTransitionTimer]);

  const closeDrawer = useCallback(() => {
    setActiveDrawer(null);
    resetFarmDeepLinkUrl();
  }, [resetFarmDeepLinkUrl]);

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
      setDetailOrigin('containers');
      setDetailInitialTab('overview');
      scheduleAfterDrawerClose(() => setSelectedContainer(container));
    },
    [scheduleAfterDrawerClose]
  );

  // 账号面板 → 统一详情深链入口（IA 重设计）：遥测徽标 / ⋯管理菜单触发。复用
  // 与容器表行点击完全相同的 scheduleAfterDrawerClose 编排（关账号抽屉 → 370ms
  // 后开详情），只是来源标记为 'accounts' 且可深链到指定分区（如遥测）。
  const handleOpenAccountDetail = useCallback(
    (container: FarmContainerView, initialTab: FarmDetailTab) => {
      setLastContainerId(container.id);
      setDetailOrigin('accounts');
      setDetailInitialTab(initialTab);
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
      // 返回到来源抽屉：容器表来源恢复容器抽屉 + 聚焦原容器行；账号表来源恢复
      // 账号抽屉（由 Modal 自行落初始焦点，无单一"行"可聚焦）。
      setActiveDrawer(detailOrigin);
      if (detailOrigin === 'containers') setFocusRestoreTarget('container-row');
    }, DRAWER_TRANSITION_MS);
  }, [clearTransitionTimer, detailOrigin]);

  const closeContainerDetail = useCallback(() => {
    setSelectedContainer(null);
    setFocusRestoreTarget(null);
    clearTransitionTimer();
    // 首屏入口卡已迁移到侧栏持久子导航项，农场首屏不再有账号/容器触发器可回焦；
    // 关闭详情直接回农场首屏 URL（若来自侧栏深链会一并清除 /farm/<section> 段）。
    resetFarmDeepLinkUrl();
  }, [clearTransitionTimer, resetFarmDeepLinkUrl]);

  useEffect(() => {
    if (!focusRestoreTarget) return;

    let cancelled = false;
    let frameId = 0;
    let attempts = 0;

    const restoreFocus = () => {
      if (cancelled) return;

      // focusRestoreTarget 只剩 'container-row' 一种（见 state 声明处注释），回焦
      // 目标即原容器行；lastContainerId 缺失时无行可聚焦，交给下面的重试兜底。
      const target = lastContainerId
        ? document.querySelector<HTMLElement>(
            `[data-testid="farm-container-row-${CSS.escape(lastContainerId)}"]`
          )
        : null;

      if (!target) {
        attempts += 1;
        if (attempts < 30) {
          frameId = window.requestAnimationFrame(restoreFocus);
        } else {
          setFocusRestoreTarget(null);
        }
        return;
      }

      const drawerBody = document
        .querySelector('[data-testid="farm-section-drawer-containers"]')
        ?.closest('.modal-body');
      if (drawerBody instanceof HTMLElement) drawerBody.scrollTop = containerScrollTop;

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
          onClick={() => openDrawer('config')}
          aria-haspopup="dialog"
          aria-expanded={activeDrawer === 'config'}
          data-testid="farm-config-trigger"
        >
          <IconSettings size={16} />
          {t('farm.ia.connectionSettings')}
        </Button>
      </section>

      {overrideUnhealthy ? (
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

          {/* 原「管理入口」操作卡网格（账号状态/容器池/资源/用量）已整块移除，
              提升为左侧栏农场分组下的持久子导航项（/farm/<section> 深链打开右侧抽屉），
              农场首屏聚焦健康 / 告警 / 容量。 */}
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
        // 账号健康表 7 列信息密度高，desktop-1440 下内容约 1181px 宽，超过默认
        // 1120px 抽屉的滚动区（约 1068px）会在抽屉内产生横向滚动。加宽到 1280px
        // （滚动区约 1228px）容纳整表，消除该横向滚动；窄视口仍由 Modal 的
        // max-width:100% 与抽屉 tablet/mobile 断点收敛，不会溢出视口。
        width={1280}
      >
        <div data-testid="farm-accounts-drawer">
          {activeDrawer === 'accounts' ? (
            <FarmAccountsPanel containers={containers} onOpenDetail={handleOpenAccountDetail} />
          ) : null}
        </div>
      </FarmSectionDrawer>

      <FarmSectionDrawer
        section="containers"
        open={activeDrawer === 'containers'}
        title={t('farm.containers.title')}
        onClose={closeDrawer}
        // 容器池表 10 列，比账号健康表（7 列，见下方 accounts 抽屉注释）更宽，
        // 默认 1120px 抽屉会把右三列（下次探测预估/绑定账号/操作）横向裁出
        // 可视区且无明显滚动提示，操作列的绑定/解绑/退役按钮默认不可见不可点
        // （1440×900 真机实测）。加宽到 1440px 容纳整表；仍超出时由 Table
        // 内建 .scroll（overflow-x:auto，见 Table.module.scss）兜底横向滚动，
        // 窄视口由 Modal 的 max-width:100% 与抽屉 tablet/mobile 断点收敛。
        width={1440}
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
        backLabel={
          detailOrigin === 'accounts'
            ? t('farm.ia.backToAccounts')
            : t('farm.ia.backToContainers')
        }
        initialTab={detailInitialTab}
      />
    </div>
  );
}
