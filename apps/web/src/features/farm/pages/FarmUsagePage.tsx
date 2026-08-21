import { useTranslation } from 'react-i18next';
import { FarmUsagePanel } from '../components/FarmUsagePanel';
import { FarmSubPage } from './FarmSubPage';

/**
 * 用量明细独立整页（/farm/usage）。原为农场页右侧抽屉，重构为独立路由页。
 * 用量面板自拉数据（useFarmUsage）。
 */
export function FarmUsagePage() {
  const { t } = useTranslation();
  return (
    <FarmSubPage
      title={t('farm.usage.detailTitle')}
      subtitle={t('farm.usage.subtitle', {
        defaultValue: '农场绑定账号在 CPA 侧的累计用量（自 CPA 上次重启起、内存态，不等同探针保活次数）。',
      })}
      testId="farm-usage-page"
    >
      <FarmUsagePanel hideHeading />
    </FarmSubPage>
  );
}
