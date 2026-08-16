import type { ReactNode } from 'react';
import { DataState } from './DataState';

interface AsyncPanelEmptyConfig {
  title: string;
  description?: string;
  action?: ReactNode;
  testId?: string;
  className?: string;
  /** 见 DataState 的 compact 说明：紧凑表单场景用一行 `.hint` 文案取代完整 EmptyState 卡片。 */
  compact?: boolean;
}

export interface AsyncPanelProps {
  /** 是否处于加载中；true 时优先于 error/empty/data 渲染 loading 态。 */
  loading: boolean;
  /** 错误文案；非空字符串（或非 null 的 ReactNode）时渲染 error 态，优先于 empty/data。 */
  error?: ReactNode | null;
  /**
   * 数据是否为空；loading/error 都不成立时，true 且提供了 `empty` 配置则渲染
   * empty 态，否则渲染 children（data 态）。部分面板（如 FarmResourcePanel）
   * 的"空"态是嵌在数据态内部（host 卡片仍需展示，只有容器列表本身为空），
   * 这类场景应始终传 `isEmpty={false}` 并在 children 内自行处理嵌套空态，
   * 不要依赖这里的整体替换语义。
   */
  isEmpty?: boolean;
  /** loading 态文案，通常是调用方已翻译好的 t('common.loading')。 */
  loadingLabel: ReactNode;
  loadingSpinnerSize?: number;
  /** FarmContainerTable 等表格场景用更大 padding + 居中的 loading 行。 */
  loadingCentered?: boolean;
  /** isEmpty=true 时必须提供；仅 loading/error 场景可省略。 */
  empty?: AsyncPanelEmptyConfig;
  /** 各态可选 data-testid，缺省时不渲染 data-testid（不破坏未打标记的既有面板行为）。 */
  loadingTestId?: string;
  errorTestId?: string;
  /** data 态（children）外层容器的 data-testid；缺省时不包一层 div，直接渲染 children。 */
  dataTestId?: string;
  className?: string;
  children: ReactNode;
}

/**
 * 四态编排组件（loading / error / empty / data），收敛 farm 页 5 处重复的
 * `{loading ? <spinner/> : error ? <error-box/> : empty ? <EmptyState/> : <Table/>}`
 * 写法（design.md 决策6「前端基建」）。只做态切换，具体每态的展示交给
 * <DataState>；data 态原样透传 children，行为与改造前逐字一致。
 */
export function AsyncPanel({
  loading,
  error,
  isEmpty,
  loadingLabel,
  loadingSpinnerSize,
  loadingCentered,
  empty,
  loadingTestId,
  errorTestId,
  dataTestId,
  className,
  children,
}: AsyncPanelProps) {
  if (loading) {
    return (
      <DataState
        variant="loading"
        label={loadingLabel}
        spinnerSize={loadingSpinnerSize}
        centered={loadingCentered}
        testId={loadingTestId}
        className={className}
      />
    );
  }

  if (error) {
    return <DataState variant="error" message={error} testId={errorTestId} className={className} />;
  }

  if (isEmpty && empty) {
    return (
      <DataState
        variant="empty"
        title={empty.title}
        description={empty.description}
        action={empty.action}
        testId={empty.testId}
        className={empty.className ?? className}
        compact={empty.compact}
      />
    );
  }

  if (dataTestId) {
    return <div data-testid={dataTestId}>{children}</div>;
  }
  return <>{children}</>;
}
