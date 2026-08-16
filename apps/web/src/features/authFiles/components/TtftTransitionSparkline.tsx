import { useMemo } from 'react';
import {
  mapSeriesToPoints,
  segmentToPolylinePoints,
  splitIntoSegments,
} from '@/features/farm/utils/chart';
import type {
  SpeedSeriesPoint,
  TierTransition,
} from '@/features/authFiles/model/accountSpeedSeries';
import styles from './TtftTransitionSparkline.module.scss';

/**
 * TTFT 切换点 sparkline（Phase 3-C）：把窗口内事件按 timestamp_ms 升序的 ttft_ms 序列
 * 画成轻量内联 SVG 折线，并在首个 default→priority（开 fast）翻转处标注竖线 + 圆点。
 * 复用 farm 的 utils/chart 纯几何映射（不引图表库），几何量程按整段自适应。
 *
 * 有 default→priority 切换时：切换点前段用中性/default 描边，切换点起用 priority 强调色，
 * 让「开 fast 那一刻起 TTFT 明显下降」可视化。无切换时整段中性描边。
 * ttft 非法值（null）在 mapSeriesToPoints 里成为空洞并被 splitIntoSegments 拆段，不连假线。
 */

const WIDTH = 208;
const HEIGHT = 44;
const PADDING = 3;

export interface TtftTransitionSparklineProps {
  /** 按 timestamp_ms 升序的逐事件序列。 */
  series: SpeedSeriesPoint[];
  /** 首个 default→priority 切换点；无则不标注。 */
  transition: TierTransition | null;
  /** 无障碍标签。 */
  ariaLabel: string;
  'data-testid'?: string;
}

export function TtftTransitionSparkline({
  series,
  transition,
  ariaLabel,
  'data-testid': testId,
}: TtftTransitionSparklineProps) {
  const points = useMemo(
    () => mapSeriesToPoints(series.map((p) => p.ttftMs), WIDTH, HEIGHT, { padding: PADDING }),
    [series]
  );

  const neutralSegments = useMemo(
    () => (transition ? [] : splitIntoSegments(points)),
    [points, transition]
  );

  const beforeSegments = useMemo(
    () => (transition ? splitIntoSegments(points.slice(0, transition.index + 1)) : []),
    [points, transition]
  );

  const afterSegments = useMemo(
    () => (transition ? splitIntoSegments(points.slice(transition.index)) : []),
    [points, transition]
  );

  const markerX = useMemo(() => {
    if (!transition || series.length < 2) return null;
    const stepX = (WIDTH - PADDING * 2) / (series.length - 1);
    return PADDING + transition.index * stepX;
  }, [transition, series.length]);

  const markerPoint =
    transition && points[transition.index] ? points[transition.index] : null;

  return (
    <svg
      width={WIDTH}
      height={HEIGHT}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className={styles.sparkline}
      data-testid={testId}
      data-has-transition={transition ? 'true' : 'false'}
      role="img"
      aria-label={ariaLabel}
    >
      {neutralSegments.map((segment, i) => (
        <polyline
          key={`neutral-${i}`}
          points={segmentToPolylinePoints(segment)}
          fill="none"
          className={styles.strokeNeutral}
        />
      ))}
      {beforeSegments.map((segment, i) => (
        <polyline
          key={`before-${i}`}
          points={segmentToPolylinePoints(segment)}
          fill="none"
          className={styles.strokeDefault}
        />
      ))}
      {afterSegments.map((segment, i) => (
        <polyline
          key={`after-${i}`}
          points={segmentToPolylinePoints(segment)}
          fill="none"
          className={styles.strokePriority}
        />
      ))}
      {markerX !== null && (
        <line
          x1={markerX}
          x2={markerX}
          y1={PADDING}
          y2={HEIGHT - PADDING}
          className={styles.markerLine}
          data-testid="ttft-transition-marker"
        />
      )}
      {markerPoint && (
        <circle cx={markerPoint.x} cy={markerPoint.y} r={2.6} className={styles.markerDot} />
      )}
    </svg>
  );
}
