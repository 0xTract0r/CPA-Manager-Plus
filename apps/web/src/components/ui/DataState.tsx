import type { ReactNode } from 'react';
import { LoadingSpinner } from './LoadingSpinner';
import { EmptyState } from './EmptyState';

/**
 * 单一状态的纯展示组件：loading / error / empty 三选一渲染。不含数据态——
 * 数据态就是调用方自己的正常渲染内容，见 <AsyncPanel> 编排四态切换逻辑。
 * 从 farm 五处（FarmAccountsPanel/FarmContainerTable/FarmResourcePanel/
 * FarmUsagePanel/FarmBindModal）逐字重复的三态 JSX 里抽出。
 */
export type DataStateVariant = 'loading' | 'error' | 'empty';

interface DataStateLoadingProps {
  variant: 'loading';
  label: ReactNode;
  spinnerSize?: number;
  centered?: boolean;
  testId?: string;
  className?: string;
}

interface DataStateErrorProps {
  variant: 'error';
  message: ReactNode;
  testId?: string;
  className?: string;
}

interface DataStateEmptyProps {
  variant: 'empty';
  title: string;
  description?: string;
  action?: ReactNode;
  testId?: string;
  className?: string;
  /**
   * true 时不渲染带边框/图标的完整 <EmptyState>，改为一行 `.hint` 弱化文案。
   * 供 FarmBindModal 这类紧凑表单场景使用——那里的"空"态原本就是一行提示
   * 文案（如"该环境下无可用账号"），套完整 EmptyState 卡片会在弹窗里显得
   * 过重，视觉上不等价于改造前。
   */
  compact?: boolean;
}

export type DataStateProps = DataStateLoadingProps | DataStateErrorProps | DataStateEmptyProps;

export function DataState(props: DataStateProps) {
  if (props.variant === 'loading') {
    const { label, spinnerSize = 16, centered, testId, className } = props;
    const rowClassName = [
      'async-loading-row',
      centered ? 'async-loading-row--center' : '',
      className ?? '',
    ]
      .filter(Boolean)
      .join(' ');
    return (
      <div className={rowClassName} data-testid={testId}>
        <LoadingSpinner size={spinnerSize} />
        <span>{label}</span>
      </div>
    );
  }

  if (props.variant === 'error') {
    const { message, testId, className } = props;
    const boxClassName = ['error-box', className ?? ''].filter(Boolean).join(' ');
    return (
      <div className={boxClassName} data-testid={testId}>
        {message}
      </div>
    );
  }

  const { title, description, action, testId, className, compact } = props;
  if (compact) {
    return (
      <div className={['hint', className ?? ''].filter(Boolean).join(' ')} data-testid={testId}>
        {title}
      </div>
    );
  }
  const content = <EmptyState title={title} description={description} action={action} />;
  // 未指定 testId/className 时不额外包一层 div——原始三处写法（
  // FarmAccountsPanel/FarmResourcePanel host 之外的分支）里 <EmptyState> 就是
  // 直接渲染，不套壳，保持 DOM 结构逐字一致。
  if (!testId && !className) return content;
  return (
    <div data-testid={testId} className={className}>
      {content}
    </div>
  );
}
