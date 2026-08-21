import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { IconChevronLeft } from '@/components/ui/icons';
import { useTimezone } from '@/hooks/useTimezone';
import styles from './FarmSubPage.module.scss';

interface FarmSubPageBackLink {
  to: string;
  label: ReactNode;
}

interface FarmSubPageProps {
  /** 页头主标题（h1）。 */
  title: ReactNode;
  /** 页头副标题/说明（可选）。 */
  subtitle?: ReactNode;
  /** 返回链接（如容器详情页「返回容器池」）。传入才渲染。 */
  backLink?: FarmSubPageBackLink;
  /** 页头右侧动作区（可选）。 */
  actions?: ReactNode;
  /** 页面根节点 data-testid。 */
  testId?: string;
  children: ReactNode;
}

/**
 * 农场子页统一整页外壳（抽屉重构 → 独立路由页）。每个农场子页（账号状态 / 容器池 /
 * 资源占用 / 用量明细 / 容器详情）都是自带页头/标题的完整一页，不再是右侧浮层抽屉。
 *
 * 顶层订阅全局时区（useTimezone）：TZ2 切换全局时区时，本页及其内部走
 * formatInTimezone/formatDateTimeUtc8 的时间展示会随之重渲染（为 TZ2 铺路）。
 */
export function FarmSubPage({
  title,
  subtitle,
  backLink,
  actions,
  testId,
  children,
}: FarmSubPageProps) {
  // 订阅全局时区，切换时区时触发本页重渲染，让内部时间展示跟随。
  useTimezone();

  return (
    <div className={styles.page} data-testid={testId}>
      <div className={styles.header}>
        {backLink ? (
          <Link className={styles.backLink} to={backLink.to} data-testid="farm-subpage-back">
            <IconChevronLeft size={16} aria-hidden="true" />
            <span>{backLink.label}</span>
          </Link>
        ) : null}
        <div className={styles.titleRow}>
          <h1 className={styles.title}>{title}</h1>
          {actions ? <div className={styles.actions}>{actions}</div> : null}
        </div>
        {subtitle ? <p className={styles.subtitle}>{subtitle}</p> : null}
      </div>
      {children}
    </div>
  );
}
