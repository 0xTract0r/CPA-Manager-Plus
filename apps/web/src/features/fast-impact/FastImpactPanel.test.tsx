import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AuthFileItem } from '@/types/authFile';
import {
  USAGE_ANALYTICS_DEFAULT_FILTERS,
  type UsageAnalyticsFiltersState,
} from '@/features/usage-analytics/usageAnalyticsModel';
import type { FastImpact, FastMetric, FastTier } from './types';
import { FastImpactPanel } from './FastImpactPanel';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const messages: Record<string, string> = {
        'fast_impact.readiness_title': 'Data availability',
        'fast_impact.known_since': 'Known since {{time}}',
        'fast_impact.account_fast_off': 'Fast currently off',
        'fast_impact.known_tier': 'Known tier',
        'fast_impact.default_requests': 'Default requests',
        'fast_impact.priority_requests': 'Fast requests',
        'fast_impact.legacy_unknown': 'Legacy unknown',
        'fast_impact.actual_outbound': 'Final outbound',
        'fast_impact.cannot_reconstruct': 'Cannot reconstruct',
        'fast_impact.no_comparable_title': 'No comparable sample',
        'fast_impact.no_comparable_fast_off':
          '{{defaultCount}} default, {{priorityCount}} Fast, {{unknownCount}} unknown',
        'fast_impact.no_comparable_fast_unknown':
          'Fast setting unknown: {{defaultCount}} default, {{unknownCount}} unknown',
        'fast_impact.coverage_chart_aria':
          '{{defaultCount}} default, {{priorityCount}} Fast, {{flexCount}} Flex, {{unknownCount}} unknown',
        'fast_impact.view_e2e': 'Use end-to-end TPS',
        'fast_impact.data_gap_details': 'View gaps ({{count}})',
        'fast_impact.comparison_details': 'View evidence ({{count}})',
        'fast_impact.comparison_chart_title': 'Speed comparison',
        'fast_impact.comparison_chart_hint': 'Matched loads only',
        'fast_impact.no_sample': 'No sample',
        'fast_impact.not_comparable': 'Not comparable',
      };
      let value = messages[key] || key.replace('fast_impact.', '');
      for (const [name, replacement] of Object.entries(options || {}))
        value = value.split(`{{${name}}}`).join(String(replacement));
      return value;
    },
  }),
}));

const metric = (samples: number, p50: number | null = null): FastMetric => ({
  samples,
  p25: p50,
  p50,
  p75: p50,
});
const tier = (attempts: number, visible = 0, e2e = 0, p50 = 42): FastTier => ({
  attempts,
  failed: 0,
  cancelled: 0,
  empty: 0,
  visible_tps: metric(visible, visible ? p50 : null),
  end_to_end_tps: metric(e2e, e2e ? p50 / 2 : null),
  first_visible_ms: metric(0),
  first_body_ms: metric(0),
  excluded: {},
  sources: {},
});
const filters: UsageAnalyticsFiltersState = {
  ...USAGE_ANALYTICS_DEFAULT_FILTERS,
  authIndex: 'codex-prod',
  provider: 'codex',
  model: 'all',
  status: 'all',
  performanceView: 'fast',
};
const account: AuthFileItem = {
  name: 'codex.json',
  note: 'CODEX-PRO-MAC',
  provider: 'codex',
  auth_index: 'codex-prod',
  account_settings: { fast: false } as AuthFileItem['account_settings'],
};
const productionShape = (): FastImpact => ({
  version: 1,
  metric_definition: '',
  from_ms: Date.UTC(2026, 7, 23),
  to_ms: Date.UTC(2026, 8, 22),
  mode: 'tier',
  metric: 'visible_tps',
  scanned: 23_978,
  matched: 23_978,
  complete: true,
  tier_coverage: {
    default_attempts: 532,
    priority_attempts: 0,
    flex_attempts: 0,
    unknown_attempts: 23_446,
    known_from_ms: Date.UTC(2026, 8, 22, 13),
  },
  models: [
    {
      query_model: 'gpt-6-astra',
      model_resolution: 'resolved',
      model: 'gpt-6-astra',
      attempts: 9_256,
      tiers: {
        default: tier(433, 0, 375),
        priority: tier(0),
        flex: tier(0),
        unknown: tier(8_823),
      },
      cohorts: [],
      selected_cohort: '',
      change_pct: null,
      status: 'missing_baseline',
      coverage: 0,
      excluded: { unknown_tier: 8_823 },
      observations: [],
      observations_truncated: false,
    },
  ],
});

describe('FastImpactPanel', () => {
  it('turns the legacy-data wall into an explained, collapsed readiness state', () => {
    const html = renderToStaticMarkup(
      <FastImpactPanel
        data={productionShape()}
        filters={filters}
        accounts={[account]}
        onFilters={vi.fn()}
        onRequests={vi.fn()}
      />
    );
    expect(html).toContain('Data availability');
    expect(html).toContain('23,446');
    expect(html).toContain('Fast currently off');
    expect(html).toContain('532 default, 0 Fast, 23,446 unknown');
    expect(html).toContain('aria-label="532 default, 0 Fast, 0 Flex, 23446 unknown"');
    expect(html).toContain('Use end-to-end TPS');
    expect(html).toContain('<details class=');
    expect(html).not.toContain('<details class="" open=""');
    expect(html).toContain('No sample');
    expect(html).not.toContain('>—<');
  });

  it('does not describe an unknown account setting as Fast enabled', () => {
    const unknownAccount = { ...account, account_settings: undefined };
    const html = renderToStaticMarkup(
      <FastImpactPanel
        data={productionShape()}
        filters={filters}
        accounts={[unknownAccount]}
        onFilters={vi.fn()}
        onRequests={vi.fn()}
      />
    );
    expect(html).toContain('Fast setting unknown: 532 default, 23,446 unknown');
    expect(html).not.toContain('no_comparable_no_fast');
  });

  it('shows a bar comparison and opens evidence when both sides have samples', () => {
    const value = productionShape();
    value.tier_coverage = {
      default_attempts: 10,
      priority_attempts: 10,
      flex_attempts: 0,
      unknown_attempts: 0,
    };
    value.models[0].tiers.default = tier(10, 8, 8, 50);
    value.models[0].tiers.priority = tier(10, 8, 8, 80);
    value.models[0].cohorts = [
      {
        key: 'high|<32k|<50%',
        effort: 'high',
        input_bucket: '<32k',
        cache_bucket: '<50%',
        default: tier(10, 8, 8, 50),
        priority: tier(10, 8, 8, 80),
        change_pct: 60,
        status: 'observed',
      },
    ];
    value.models[0].selected_cohort = 'high|<32k|<50%';
    value.models[0].change_pct = 60;
    const html = renderToStaticMarkup(
      <FastImpactPanel
        data={value}
        filters={filters}
        accounts={[account]}
        onFilters={vi.fn()}
        onRequests={vi.fn()}
      />
    );
    expect(html).toContain('fast-comparison-chart');
    expect(html).toContain('Speed comparison');
    expect(html).toMatch(/<details[^>]* open=""/);
    expect(html).not.toContain('No comparable sample');
  });
});
