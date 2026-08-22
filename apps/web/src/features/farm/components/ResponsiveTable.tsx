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
   *  - `'farm-tablet'`：≤1180 都降级成卡片。列较多、又没有 sticky-right 兜底的
   *    宽表（账号表 5–6 列）在 769–1180 中等视口会横向溢出，把右侧列（操作）滚出
   *    可视区，且滚动区行内无可聚焦元素——键盘用户完全够不到（axe serious
   *    `scrollable-region-focusable`）。整表卡片化把每行铺成「标签（列头）+ 值」
   *    纵向卡片，彻底消除横滚与右缘裁切：所有数据完整可见、操作可达、无独立滚动区。
   *    上界取农场中等视口边界 `$breakpoint-tablet-max`(1180)，与 `@mixin farm-tablet`
   *    一致；≥1181（含 1440）维持原表格布局不受影响。
   *  - `'farm-usage'`：≤1400 降级成卡片。用量明细是 11 列（比账号表更宽），表格
   *    内容自然宽约 1075px，farm-tablet 的 1180 上界不够——1280 视口主内容可用宽仅
   *    ~970px（视口 − ~313px 侧栏/padding/scrollbar-gutter/面板 padding），表格会横滚
   *    把最右侧 Requests 列滚出屏外（axe serious `scrollable-region-focusable`）。故用
   *    比 farm-tablet 更高的独立上界 1400px（≥ 实测放得下临界 ~1388、又 < 1440 保住
   *    1440 表格档）：<1400 走卡片（含 1280），≥1401 走表格且真正放得下（含 1440）。
   *    断点推导见 ResponsiveTable.module.scss `$farm-usage-card-max` 注释。
   */
  breakpoint?: 'mobile' | 'farm-tablet' | 'farm-usage';
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
 * `breakpoint="farm-tablet"` 时把该降级上界抬到 ≤1180，传 `breakpoint="farm-usage"`
 * 时抬到 ≤1400（11 列用量表更宽，见上方 prop 注释）。纯样式
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
    breakpoint === 'farm-usage' ? styles.responsiveTableFarmUsage : null,
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
