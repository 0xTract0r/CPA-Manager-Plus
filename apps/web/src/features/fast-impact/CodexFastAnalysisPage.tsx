import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { authFilesApi } from '@/services/api/authFiles';
import { isDemoMode, prefixRouteBase } from '@/features/demo/demoMode';
import { useMonitoringAnalytics } from '@/features/monitoring/hooks/useMonitoringAnalytics';
import {
  buildMonitoringDetailUrl,
  getUsageRangeBounds,
  parseDateTimeLocalValue,
  USAGE_ANALYTICS_DEFAULT_FILTERS,
  USAGE_TIME_RANGES,
  type UsageAnalyticsFiltersState,
} from '@/features/usage-analytics/usageAnalyticsModel';
import {
  buildUsageAnalyticsSearchParams,
  buildUsageAnalyticsUiStateFromSearchParams,
} from '@/features/usage-analytics/usageAnalyticsUiState';
import type { AuthFileItem } from '@/types/authFile';
import { FastImpactPanel } from './FastImpactPanel';
import styles from './CodexFastAnalysisPage.module.scss';

const localDateTime = (ms: number) =>
  new Date(ms - new Date(ms).getTimezoneOffset() * 60000).toISOString().slice(0, -1);
const route = (path: string) => (isDemoMode() ? prefixRouteBase(path) : path);

export function CodexFastAnalysisPage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [now, setNow] = useState(Date.now);
  const [accounts, setAccounts] = useState<AuthFileItem[]>([]);
  const [metaReady, setMetaReady] = useState(false);
  const [metaError, setMetaError] = useState('');
  const parsed = buildUsageAnalyticsUiStateFromSearchParams(params).filters;
  const accountId = params.get('auth_index')?.trim() || 'all';
  // 独立页只接收账号、时间及比较选项，不继承全局提供商/成功状态等筛选。
  const filters: UsageAnalyticsFiltersState = {
    ...USAGE_ANALYTICS_DEFAULT_FILTERS,
    authIndex: accountId,
    provider: 'codex',
    performanceView: 'fast',
    timeRange: parsed.timeRange,
    customRange: parsed.customRange,
    fastMetric: parsed.fastMetric,
    fastMode: parsed.fastMode,
  };
  const bounds = getUsageRangeBounds(filters, now);
  const account = accounts.find((a) => String(a.auth_index ?? a.authIndex) === accountId);
  const invalidProvider = account && (account.provider || account.type) !== 'codex';
  const validAccount = accountId !== 'all' && !invalidProvider && metaReady && !metaError;
  const analytics = useMonitoringAnalytics({
    fromMs: validAccount ? bounds?.fromMs : null,
    toMs: bounds?.toMs,
    filters: { auth_indices: [accountId], providers: ['codex'] },
    include: { fast_impact: true },
    fastImpactOptions: {
      mode: filters.fastMode || 'tier',
      metric: filters.fastMetric || 'visible_tps',
    },
    throttleMs: 0,
  });
  useEffect(() => {
    let cancelled = false;
    authFilesApi
      .list()
      .then((result) => {
        if (!cancelled) {
          setAccounts(result.files);
          setMetaReady(true);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setMetaError(String(error));
          setMetaReady(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const updateFilters = (patch: Partial<UsageAnalyticsFiltersState>) => {
    const next = buildUsageAnalyticsSearchParams({
      activeTab: 'performance',
      filters: { ...filters, ...patch },
    });
    next.delete('tab');
    next.delete('view');
    next.delete('provider');
    setParams(next);
  };
  const accountLabel = account?.note || account?.label || account?.name || accountId;
  const error = metaError || (invalidProvider ? t('fast_impact.codex_only') : analytics.error);
  const stats = analytics.data?.fast_impact;
  return (
    <div className={styles.page} data-testid="codex-fast-analysis-page">
      <nav className={styles.breadcrumb} aria-label={t('fast_impact.breadcrumb')}>
        <Link to={route('/auth-files')}>{t('fast_impact.accounts_page')}</Link>
        <span>/</span>
        <span>Codex</span>
        <span>/</span>
        <span aria-current="page">{t('fast_impact.analysis_short')}</span>
      </nav>
      <header className={styles.header}>
        <div>
          <h1>{t('fast_impact.title')}</h1>
          <p>{t('fast_impact.page_hint')}</p>
        </div>
        <div className={styles.actions}>
          <Button
            variant="secondary"
            size="sm"
            disabled={analytics.loading || !validAccount}
            onClick={() => {
              if (filters.timeRange === 'custom') void analytics.refresh({ force: true });
              else setNow(Date.now());
            }}
          >
            {t('common.refresh')}
          </Button>
          <Link className={styles.back} to={route('/auth-files')}>
            ← {t('fast_impact.back_accounts')}
          </Link>
        </div>
      </header>
      <section className={styles.scope} aria-label={t('fast_impact.account')}>
        <div className={styles.identity}>
          <span className={styles.provider}>Codex</span>
          <div>
            <span className={styles.caption}>{t('fast_impact.current_account')}</span>
            <strong>{accountId === 'all' ? t('fast_impact.select_account') : accountLabel}</strong>
          </div>
        </div>
        <div className={styles.scopeNote}>{t('fast_impact.scope_note')}</div>
      </section>
      <section className={styles.content}>
        {!bounds ? <p role="alert">{t('fast_impact.invalid_range')}</p> : null}
        <FastImpactPanel
          data={validAccount && !analytics.dataStale ? stats : undefined}
          filters={filters}
          accounts={accounts}
          accountScoped
          mock={isDemoMode()}
          controlsPrefix={
            <label>
              {t('usage_analytics.filter_time_range')}
              <Select
                value={filters.timeRange}
                options={USAGE_TIME_RANGES.map((value) => ({
                  value,
                  label: t(`usage_analytics.range_${value}`),
                }))}
                ariaLabel={t('usage_analytics.filter_time_range')}
                onChange={(timeRange) =>
                  updateFilters({
                    timeRange: timeRange as UsageAnalyticsFiltersState['timeRange'],
                    customRange: filters.customRange || { startMs: now - 86400000, endMs: now },
                  })
                }
              />
            </label>
          }
          afterControls={
            filters.timeRange === 'custom' &&
            filters.customRange && (
              <form
                className={styles.range}
                key={`${filters.customRange.startMs}-${filters.customRange.endMs}`}
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = new FormData(event.currentTarget);
                  const startMs = parseDateTimeLocalValue(String(form.get('start')));
                  const endMs = parseDateTimeLocalValue(String(form.get('end')));
                  if (startMs != null && endMs != null && startMs < endMs)
                    updateFilters({ customRange: { startMs, endMs } });
                }}
              >
                <label>
                  {t('fast_impact.start_time')}
                  <input
                    name="start"
                    type="datetime-local"
                    step="0.001"
                    required
                    defaultValue={localDateTime(filters.customRange.startMs)}
                  />
                </label>
                <span>—</span>
                <label>
                  {t('fast_impact.end_time')}
                  <input
                    name="end"
                    type="datetime-local"
                    step="0.001"
                    required
                    defaultValue={localDateTime(filters.customRange.endMs)}
                  />
                </label>
                <Button variant="secondary" size="sm" type="submit">
                  {t('fast_impact.apply_range')}
                </Button>
              </form>
            )
          }
          busy={!metaReady || analytics.loading || analytics.dataStale}
          error={error}
          onFilters={updateFilters}
          onRequests={(row, requestId) => {
            if (!bounds) return;
            const target = new URL(
              buildMonitoringDetailUrl(
                { bucketMs: bounds.fromMs, bucketEndMs: bounds.toMs },
                filters
              ),
              'http://local'
            );
            target.searchParams.delete('model');
            target.searchParams.set(
              row.model_resolution === 'unresolved' ? 'unresolved_model' : 'resolved_model',
              row.query_model || row.model
            );
            if (requestId) target.searchParams.set('request_id', requestId);
            navigate(`${route(target.pathname)}${target.search}`);
          }}
        />
      </section>
    </div>
  );
}
