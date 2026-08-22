import type { HTMLAttributes, PropsWithChildren } from 'react';
import styles from './ResponsiveTable.module.scss';

interface ResponsiveTableProps extends HTMLAttributes<HTMLDivElement> {
  className?: string;
  /**
   * 卡片降级触发的视口上界（farm 设计系统收敛 E2 扩展）。
   *
   *  - `'mobile'`（默认）：≤768 才把宽表降级成堆叠卡片；桌面与中等视口维持原
   *    表格布局，超宽由 <Table> 内建 `.scroll` 横滚 + 组件自有策略（如
   *    FarmContainerTable 的 sticky-right 操作列）兜底。FarmContainerTable 用此
   *    档——它的操作列吸附在横滚区右可视缘，中等视口横滚时按钮仍常驻可点，无需
   *    整表卡片化。
   *  - `'farm-tablet'`：≤1180 都降级成卡片。列很多、又没有 sticky-right 兜底的
   *    宽表（账号表、用量表 11 列）在 769–1180 中等视口会横向溢出，把右侧列
   *    （操作 / Cost / Requests）滚出可视区，且滚动区行内无可聚焦元素——键盘用户
   *    完全够不到（axe serious `scrollable-region-focusable`）。整表卡片化把每行
   *    铺成「标签（列头）+ 值」纵向卡片，彻底消除横滚与右缘裁切：所有数据完整
   *    可见、操作可达、无独立滚动区。上界取农场中等视口边界
   *    `$breakpoint-tablet-max`(1180)，与 `@mixin farm-tablet` 一致；≥1181（含
   *    1440）维持原表格布局不受影响。
   */
  breakpoint?: 'mobile' | 'farm-tablet';
}

/**
 * 共享窄视口表格降级原语（farm 设计系统收敛 E2）。
 *
 * 用法：把 <Table> 包一层。
 *
 *   <ResponsiveTable>
 *     <Table>…</Table>
 *   </ResponsiveTable>
 *
 * 默认在 mobile(≤768) 视口下，样式层（ResponsiveTable.module.scss）会把内部宽表
 * 整表降级成堆叠卡片，消除横向溢出与右缘半裁；桌面视口不改变原表格布局。传
 * `breakpoint="farm-tablet"` 时把该降级上界抬到 ≤1180（见上方 prop 注释）。纯样式
 * 与结构收敛——不改列定义 / 数据 / 交互，把此前 FarmContainerTable /
 * FarmAccountsPanel 各自重复的 table→card 降级块收敛到这里，组件本地只保留列/
 * 字段级微调。
 */
export function ResponsiveTable({
  children,
  className,
  breakpoint = 'mobile',
  ...rest
}: PropsWithChildren<ResponsiveTableProps>) {
  const cls = [
    styles.responsiveTable,
    breakpoint === 'farm-tablet' ? styles.responsiveTableFarmTablet : null,
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={cls} {...rest}>
      {children}
    </div>
  );
}
