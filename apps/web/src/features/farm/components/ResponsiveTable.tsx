import type { HTMLAttributes, PropsWithChildren } from 'react';
import styles from './ResponsiveTable.module.scss';

interface ResponsiveTableProps extends HTMLAttributes<HTMLDivElement> {
  className?: string;
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
 * 在 mobile(≤768) 视口下，样式层（ResponsiveTable.module.scss）会把内部宽表整表
 * 降级成堆叠卡片，消除横向溢出与右缘半裁；桌面视口不改变原表格布局。纯样式与
 * 结构收敛——不改列定义 / 数据 / 交互，把此前 FarmContainerTable / FarmAccountsPanel
 * 各自重复的 table→card 降级块收敛到这里，组件本地只保留列/字段级微调。
 */
export function ResponsiveTable({
  children,
  className,
  ...rest
}: PropsWithChildren<ResponsiveTableProps>) {
  const cls = [styles.responsiveTable, className].filter(Boolean).join(' ');
  return (
    <div className={cls} {...rest}>
      {children}
    </div>
  );
}
