/**
 * 农场页（Device Farm）在 cpamp 中的宿主页。
 *
 * B1a 打通数据层 + 路由 + 最小渲染；B1b 把 apps/web 的农场信息架构（FarmDashboard：
 * 连接状态条 / KPI 概览带 / 容量就绪度 / 操作卡网格 / 抽屉 / 容器详情 / 遥测面板）
 * 按 cpamp 设计系统原生化。宿主页只保留标题与副标题，主体交给 FarmDashboard。
 *
 * 农场编排器是独立后端（独立 base URL + 独立 admin key，见 services/api/farmClient.ts），
 * 刻意不接 CPA managementKey / apiClient，编排器 401 不会把 cpamp 管理会话登出。
 */

import { useTranslation } from 'react-i18next';
import { FarmDashboard } from '@/features/farm/components/FarmDashboard';
import styles from './FarmPage.module.scss';

export function FarmPage() {
  const { t } = useTranslation();

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1 className={styles.pageTitle}>{t('farm.title')}</h1>
        <p className={styles.subtitle}>{t('farm.subtitle')}</p>
      </div>

      <FarmDashboard />
    </div>
  );
}
