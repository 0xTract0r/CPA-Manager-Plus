import { describe, expect, it } from 'vitest';
import { deriveMonitoringKpiLoadingState } from './monitoringCenterPageModel';

// 去闪烁核心派生：KPI 卡片「更新中」遮罩改用 overviewDataStale(切窗才 true、同窗后台刷新
// 恒 false)而非 monitoringLoading(每次后台刷新都翻 true)。这些用例锁死该行为，防回归。
describe('deriveMonitoringKpiLoadingState', () => {
  it('does not mark KPI cards as updating during same-window background refresh (overviewDataStale=false)', () => {
    // 同窗每 N 秒后台刷新：analytics.loading 可能为 true，但概览 scope 未变 → overviewDataStale=false。
    // 期望：kpiUpdating=false（不变灰、不转圈），数值静默原地更新。
    const state = deriveMonitoringKpiLoadingState({
      monitoringLoading: true,
      overviewDataStale: false,
      hasPresentationSnapshot: true,
    });
    expect(state.kpiUpdating).toBe(false);
    expect(state.kpiFirstLoad).toBe(false);
  });

  it('marks KPI cards as updating exactly once while switching time window (overviewDataStale=true)', () => {
    // 切时间窗：概览请求转场到新 scope → overviewDataStale=true，且已有旧概览快照可显示。
    // 期望：kpiUpdating=true（对旧快照显示一次「更新中」遮罩）。
    const state = deriveMonitoringKpiLoadingState({
      monitoringLoading: true,
      overviewDataStale: true,
      hasPresentationSnapshot: true,
    });
    expect(state.kpiUpdating).toBe(true);
    expect(state.kpiFirstLoad).toBe(false);
  });

  it('shows first-load skeleton (not the updating overlay) when there is no snapshot yet', () => {
    // 首屏还没有任何展示快照：走 kpiFirstLoad 骨架，绝不显示「更新中」遮罩。
    const state = deriveMonitoringKpiLoadingState({
      monitoringLoading: true,
      overviewDataStale: false,
      hasPresentationSnapshot: false,
    });
    expect(state.kpiFirstLoad).toBe(true);
    expect(state.kpiUpdating).toBe(false);
  });

  it('does not gray out on scope transition when no snapshot exists (first load takes precedence)', () => {
    // 首屏就切窗的极端时序：overviewDataStale 可能为 true 但还没有旧快照，此时应走骨架而非遮罩。
    const state = deriveMonitoringKpiLoadingState({
      monitoringLoading: true,
      overviewDataStale: true,
      hasPresentationSnapshot: false,
    });
    expect(state.kpiUpdating).toBe(false);
    expect(state.kpiFirstLoad).toBe(true);
  });

  it('settles to idle (no skeleton, no overlay) once a snapshot exists and nothing is transitioning', () => {
    const state = deriveMonitoringKpiLoadingState({
      monitoringLoading: false,
      overviewDataStale: false,
      hasPresentationSnapshot: true,
    });
    expect(state.kpiUpdating).toBe(false);
    expect(state.kpiFirstLoad).toBe(false);
  });
});
