import { useTranslation } from 'react-i18next';
import { FarmResourcePanel } from '../components/FarmResourcePanel';
import { FarmSubPage } from './FarmSubPage';

/**
 * 资源占用独立整页（/farm/resources）。原为农场页右侧抽屉，重构为独立路由页。
 * 资源面板自拉数据（useFarmResources）。
 */
export function FarmResourcesPage() {
  const { t } = useTranslation();
  return (
    <FarmSubPage
      title={t('farm.resources.title')}
      subtitle={t('farm.resources.subtitle', {
        defaultValue: '农场容器与宿主机的内存 / CPU 占用（含整机非农场进程口径说明）。',
      })}
      testId="farm-resources-page"
    >
      <FarmResourcePanel hideHeading />
    </FarmSubPage>
  );
}
