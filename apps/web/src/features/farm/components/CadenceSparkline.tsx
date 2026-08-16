import { useMemo } from 'react';
import { mapSeriesToPoints, splitIntoSegments, segmentToPolylinePoints } from '../utils/chart';
import styles from './CadenceSparkline.module.scss';

/**
 * 探针到达间隔 sparkline（P2-C5「请求节奏 sparkline」）。轻量内联 SVG 折线，
 * 每个点是相邻两次探针的一次间隔（秒，按到达顺序）——保序不保跨度，专门呈现
 * 「节奏形状」而非精确时间轴（与容器详情抽屉的完整时间轴/直方图同源，这里是
 * 账号面板的紧凑摘要版）。复用 utils/chart.ts 的纯几何映射，不引图表库。
 *
 * 只在有 >=2 个间隔样本时才有意义（单点画不出折线）；样本不足时调用方应改显
 * 文案而非渲染空图。points 数 <=1 时组件回退渲染空 svg（不报错）。
 */

const SPARKLINE_WIDTH = 96;
const SPARKLINE_HEIGHT = 24;

export interface CadenceSparklineProps {
  /** 探针到达间隔序列（秒）。 */
  intervals: number[];
  /** 无障碍标签（如「最近 N 次探针到达间隔」+ 均值）。 */
  ariaLabel: string;
  'data-testid'?: string;
}

export function CadenceSparkline({ intervals, ariaLabel, 'data-testid': testId }: CadenceSparklineProps) {
  const segments = useMemo(() => {
    const points = mapSeriesToPoints(intervals, SPARKLINE_WIDTH, SPARKLINE_HEIGHT);
    return splitIntoSegments(points);
  }, [intervals]);

  return (
    <svg
      width={SPARKLINE_WIDTH}
      height={SPARKLINE_HEIGHT}
      viewBox={`0 0 ${SPARKLINE_WIDTH} ${SPARKLINE_HEIGHT}`}
      className={styles.sparkline}
      data-testid={testId}
      role="img"
      aria-label={ariaLabel}
    >
      {segments.map((segment, i) => (
        <polyline
          key={i}
          points={segmentToPolylinePoints(segment)}
          fill="none"
          className={styles.stroke}
        />
      ))}
    </svg>
  );
}
