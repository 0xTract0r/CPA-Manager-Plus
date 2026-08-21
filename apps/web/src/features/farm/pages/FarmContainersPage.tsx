import { useCallback, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { FarmContainerView } from '@/types/farm';
import { FarmBindModal } from '../components/FarmBindModal';
import {
  FarmContainerTable,
  type FarmContainerFilter,
} from '../components/FarmContainerTable';

// 深链入口（如 FarmOverviewBar「离线容器」磁贴 → /farm/containers?filter=down）
// 允许的初始筛选值；非法值回退到 'all'，防止 URL 被塞任意串。
const FARM_CONTAINER_FILTER_VALUES: readonly FarmContainerFilter[] = [
  'all',
  'active',
  'created',
  'degraded',
  'down',
  'retired',
];

function parseInitialFilter(raw: string | null): FarmContainerFilter {
  return FARM_CONTAINER_FILTER_VALUES.includes(raw as FarmContainerFilter)
    ? (raw as FarmContainerFilter)
    : 'all';
}
import { useFarmBindings } from '../hooks/useFarmBindings';
import { useFarmContainers } from '../hooks/useFarmContainers';
import { useFarmRetire } from '../hooks/useFarmRetire';
import { FarmSubPage } from './FarmSubPage';

/**
 * 容器池独立整页（/farm/containers）。原为农场页右侧抽屉，重构为独立路由页。
 * 行点击不再弹容器详情抽屉，改为导航到容器详情整页 /farm/containers/:id。
 * 绑定/解绑/退役动作与绑定弹窗沿用既有数据层（useFarmBindings/useFarmRetire）。
 */
export function FarmContainersPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { containers, setContainers, loading, error, reload } = useFarmContainers();
  const { bindingPending, unbindingContainerId, bind, unbind } = useFarmBindings({
    setContainers,
    reload,
  });
  const { retiringContainerId, retire } = useFarmRetire({ setContainers, reload });

  // 初始筛选支持 ?filter= 深链（KPI 磁贴导航来源）；之后由表格筛选控件接管。
  const [searchParams] = useSearchParams();
  const [containerFilter, setContainerFilter] = useState<FarmContainerFilter>(() =>
    parseInitialFilter(searchParams.get('filter'))
  );
  const [bindModalOpen, setBindModalOpen] = useState(false);
  const [preselectedContainerId, setPreselectedContainerId] = useState<string | null>(null);

  const openBindModal = useCallback((container?: FarmContainerView) => {
    setPreselectedContainerId(container?.id ?? null);
    setBindModalOpen(true);
  }, []);

  const closeBindModal = useCallback(() => setBindModalOpen(false), []);

  const openContainerDetail = useCallback(
    (container: FarmContainerView) => {
      navigate(`/farm/containers/${encodeURIComponent(container.id)}`);
    },
    [navigate]
  );

  return (
    <FarmSubPage
      title={t('farm.containers.title')}
      subtitle={t('farm.containers.desc')}
      testId="farm-containers-page"
    >
      <FarmContainerTable
        containers={containers}
        loading={loading}
        error={error}
        unbindingContainerId={unbindingContainerId}
        retiringContainerId={retiringContainerId}
        onBind={openBindModal}
        onUnbind={unbind}
        onRetire={retire}
        onSelectContainer={openContainerDetail}
        groupFilter={containerFilter}
        onGroupFilterChange={setContainerFilter}
      />

      <FarmBindModal
        open={bindModalOpen}
        submitting={bindingPending}
        containers={containers}
        preselectedContainerId={preselectedContainerId}
        onClose={closeBindModal}
        onSubmit={bind}
      />
    </FarmSubPage>
  );
}
