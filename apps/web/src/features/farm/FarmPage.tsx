/**
 * 农场页（Device Farm）在 cpamp 中的宿主页。
 *
 * B1a 打通数据层 + 路由 + 最小渲染；B1b 把 apps/web 的农场信息架构（FarmDashboard：
 * 连接状态条 / KPI 概览带 / 容量就绪度 / 操作卡网格 / 抽屉 / 容器详情 / 遥测面板）
 * 按 cpamp 设计系统原生化。宿主页只保留标题与副标题，主体交给 FarmDashboard。
 *
 * 外壳统一：/farm 总览与各农场子页（账号状态 / 容器池 / 资源占用 / 用量明细 /
 * 容器详情）复用同一个 FarmSubPage 整页外壳（统一 gutter、max-width/overflow 护栏、
 * 副标题 72ch、全局时区订阅），不再各自维护一份宿主布局，避免外壳漂移。
 *
 * 农场编排器是独立后端（独立 base URL + 独立 admin key，见 services/api/farmClient.ts），
 * 刻意不接 CPA managementKey / apiClient，编排器 401 不会把 cpamp 管理会话登出。
 */

import { useTranslation } from 'react-i18next';
import { FarmDashboard } from '@/features/farm/components/FarmDashboard';
import { FarmSubPage } from '@/features/farm/pages/FarmSubPage';

export function FarmPage() {
  const { t } = useTranslation();

  return (
    <FarmSubPage title={t('farm.title')} subtitle={t('farm.subtitle')}>
      <FarmDashboard />
    </FarmSubPage>
  );
}
