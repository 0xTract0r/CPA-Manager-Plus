import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { FarmContainerView } from '@/types/farm';
import { FarmAccountsPanel } from '../components/FarmAccountsPanel';
import type { FarmDetailTab } from '../components/FarmContainerDetailContent';
import { FarmSubPage } from './FarmSubPage';

/**
 * 账号状态独立整页（/farm/accounts）。原为农场页右侧抽屉，重构为独立路由页。
 * 账号面板自己拉取账号/容器数据；遥测徽标 / ⋯管理菜单的详情入口不再弹抽屉，
 * 改为导航到容器详情整页 /farm/containers/:id（可带 ?tab= 深链到指定分区）。
 */
export function FarmAccountsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const openDetail = useCallback(
    (container: FarmContainerView, initialTab: FarmDetailTab) => {
      navigate(`/farm/containers/${encodeURIComponent(container.id)}?tab=${initialTab}`);
    },
    [navigate]
  );

  return (
    <FarmSubPage
      title={t('farm.accounts.title')}
      subtitle={t('farm.accounts.desc')}
      testId="farm-accounts-page"
    >
      <FarmAccountsPanel hideHeading onOpenDetail={openDetail} />
    </FarmSubPage>
  );
}
