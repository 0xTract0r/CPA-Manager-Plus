import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AuthFileItem } from '@/types/authFile';
import { USAGE_ANALYTICS_DEFAULT_FILTERS, type UsageAnalyticsFiltersState } from '@/features/usage-analytics/usageAnalyticsModel';
import zhCN from '@/i18n/locales/zh-CN.json';
import type { FastImpact, FastMetric, FastTier } from './types';
import { FastImpactPanel } from './FastImpactPanel';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string, options?: Record<string, unknown>) => {
    let value = (zhCN.fast_impact as Record<string, string>)[key.replace('fast_impact.', '')] || key;
    for (const [name, replacement] of Object.entries(options || {})) value = value.split(`{{${name}}}`).join(String(replacement));
    return value;
  } }),
}));
const metric = (samples: number, p50: number | null = null): FastMetric => ({ samples, p25: p50, p50, p75: p50 });
const tier = (attempts: number, samples = 0, speed = 42): FastTier => ({
  attempts, failed: 0, cancelled: 0, empty: 0,
  visible_tps: metric(0), end_to_end_tps: metric(samples, samples ? speed : null),
  first_visible_ms: metric(0), first_body_ms: metric(0), excluded: {}, sources: {},
});
const filters: UsageAnalyticsFiltersState = { ...USAGE_ANALYTICS_DEFAULT_FILTERS,
  authIndex: 'codex-prod', provider: 'codex', model: 'all', status: 'all',
  performanceView: 'fast', fastMetric: 'end_to_end_tps', fastMode: 'tier',
};
const account: AuthFileItem = { name: 'codex.json', note: 'CODEX-PRO-MAC', provider: 'codex', auth_index: 'codex-prod',
  account_settings: { fast: false } as AuthFileItem['account_settings'],
};
const data = (): FastImpact => ({ version: 1, metric_definition: '', from_ms: Date.UTC(2026, 8, 3), to_ms: Date.UTC(2026, 9, 3),
  mode: 'tier', metric: 'end_to_end_tps', scanned: 1000, matched: 1000, complete: true,
  tier_coverage: { default_attempts: 100, priority_attempts: 0, flex_attempts: 0, unknown_attempts: 900 },
  models: [{ query_model: 'gpt-6-astra', model_resolution: 'resolved', model: 'gpt-6-astra', attempts: 1000,
    tiers: { default: tier(100, 90), priority: tier(0), flex: tier(0), unknown: tier(900) },
    cohorts: [], selected_cohort: '', change_pct: null, status: 'missing_baseline', coverage: 0, excluded: {}, observations: [], observations_truncated: false,
  }],
});
const matched = (samples = 8): FastImpact => {
  const value = data();
  value.models[0].tiers.priority = tier(100, 90, 150);
  value.tier_coverage!.priority_attempts = 100;
  value.models[0].cohorts = [{ key: 'high|32k|50%', effort: 'high', input_bucket: '32k', cache_bucket: '50%',
    default: tier(10, samples, 25), priority: tier(10, samples, 40), change_pct: 60, status: 'preliminary' }];
  value.models[0].selected_cohort = 'high|32k|50%';
  value.models[0].change_pct = 60;
  return value;
};
const render = (value: FastImpact, props = {}) => renderToStaticMarkup(<FastImpactPanel data={value} filters={filters} accounts={[account]} onFilters={vi.fn()} onRequests={vi.fn()} {...props} />);

describe('FastImpactPanel simplified experience', () => {
  it('keeps only the account selector, names the fixed metric, and shows a one-sided fact without a dash wall', () => {
    const html = render(data());
    expect((html.match(/aria-haspopup="listbox"/g) || [])).toHaveLength(1);
    expect(html).toContain('整体处理速度（含等待和思考）');
    expect(html).toContain('尚无极速请求，暂不能比较');
    expect(html).toContain('42');
    expect(html).not.toContain('>—<');
    expect(html).not.toContain('<table');
    expect(html).not.toContain('速度指标');
    expect(html).not.toContain('对比方式');
    expect(html).toContain('搜索模型');
    expect(html).toContain('最常使用');
    expect(html).not.toMatch(/<details[^>]* open=/);
  });
  it('uses selected cohort values and samples instead of all-model aggregates', () => {
    const html = render(matched());
    expect(html).toContain('快 60%');
    expect(html).toContain('普通 8 条 · 极速 8 条');
    expect(html).toContain('初步结果');
    expect(html).not.toContain('150 <small>');
    expect(html).toContain('25 <small>');
    expect(html).toContain('40 <small>');
  });
  it('does not imply comparison when both aggregate sides exist without a common load', () => {
    const value = matched(); value.models[0].cohorts = []; value.models[0].selected_cohort = '';
    const html = render(value);
    expect(html).toContain('两组请求差异较大');
    expect(html).not.toContain('快 60%');
    expect(html).not.toContain('token/s</small>');
  });
  it('suppresses percentages for fewer than five matched samples', () => {
    const html = render(matched(4));
    expect(html).toContain('样本不足，暂不计算提升');
    expect(html).not.toContain('快 60%');
  });
  it('does not draw comparable bars when matching information is missing', () => {
    const value = matched();
    value.models[0].cohorts[0].status = 'low_comparability';
    value.models[0].cohorts[0].change_pct = null;
    const html = render(value);
    expect(html).toContain('缺少思考强度或缓存信息');
    expect(html).not.toContain('快 60%');
    expect(html).not.toContain('token/s</small>');
  });
  it('suppresses percentages when the server query was incomplete', () => {
    const value = matched(); value.complete = false;
    const html = render(value);
    expect(html).toContain('查询范围不完整');
    expect(html).not.toContain('快 60%');
  });
  it('collapses unknown-only models instead of rendering empty model cards', () => {
    const value = data(); value.models[0].tiers.default = tier(0);
    value.tier_coverage!.default_attempts = 0;
    const html = render(value);
    expect(html).toContain('这些历史请求没有记录实际模式');
    expect(html).not.toContain('data-testid="fast-model-row"');
  });
  it('does not display an old metric as overall speed or old data while loading', () => {
    const value = matched(); value.metric = 'visible_tps';
    expect(render(value)).not.toContain('快 60%');
    expect(render(matched(), { busy: true })).not.toContain('快 60%');
  });
  it('labels snapshot settings separately from current settings', () => {
    expect(render(data(), { snapshotAt: 1 })).toContain('快照时设置');
    expect(render(data(), { accounts: [{ ...account, account_settings: undefined }] })).toContain('暂时无法读取');
  });
  it('renders complete activity counts including empty intervals, without fabricating observations', () => {
    const value = matched();
    value.activity = [
      { from_ms: 1, to_ms: 2, default_attempts: 10, priority_attempts: 2, unknown_attempts: 4, flex_attempts: 0 },
      { from_ms: 2, to_ms: 3, default_attempts: 0, priority_attempts: 0, unknown_attempts: 0, flex_attempts: 0 },
    ];
    const html = render(value);
    expect(html).toContain('fast-activity-chart');
    expect(html).toContain('普通 10 · 极速 2 · 模式未记录 4');
    expect(html).toContain('无请求');
    expect(html).toContain('disabled=""');
    expect(html).toContain('不会改变上方对比');
    expect(html).not.toContain('恢复原时间范围');
    expect(render(data())).not.toContain('fast-activity-chart');
  });
});
