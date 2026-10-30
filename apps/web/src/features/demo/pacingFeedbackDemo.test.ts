import { afterEach, expect, it, vi } from 'vitest';
import type { AuthFileAccountScheduling, AuthFileAccountSchedulingPatchRequest } from '@/types';
import captured from './pacingProductionSnapshot.json';

const capturedJson = JSON.stringify(captured);
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});
const setup = async () => {
  vi.useFakeTimers({
    toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  });
  vi.stubGlobal('window', { location: { search: '?pacing-feedback=1' } });
  vi.resetModules();
  const demo = await import('./pacingFeedbackDemo');
  const file = (id: string) =>
    demo.getPacingFeedbackFiles().files.find((item) => item.auth_index === id)!;
  const patch = (
    id: string,
    changes: Omit<AuthFileAccountSchedulingPatchRequest, 'name' | 'auth_index'>
  ) => {
    const result = demo.handlePacingFeedbackRequest(
      'patch',
      '/auth-files/account-scheduling',
      new URLSearchParams(),
      { name: `${id}.json`, auth_index: id, ...changes }
    ) as { account_scheduling: AuthFileAccountScheduling };
    return result.account_scheduling;
  };
  return { demo, file, patch };
};

it('settles at the old capacity before edits and never returns discarded credit', async () => {
  const { file, patch } = await setup();
  const snapshot = () => file('local-simulation').account_scheduling!.warmup_traffic_pacing!;
  const setCapacity = (capacity: number) =>
    patch('local-simulation', { limit_overrides: { request_capacity: capacity } })
      .warmup_traffic_pacing!;
  expect(snapshot().refill_per_hour).toBeCloseTo(500 / 24);
  expect(snapshot().daily_request_budget).toBe(500);
  expect(snapshot().admission_balance_eta_seconds).toBeCloseTo(12);
  vi.advanceTimersByTime(3600000);
  expect(snapshot().request_balance).toBe(8);
  expect(setCapacity(12).request_balance).toBe(8);
  vi.advanceTimersByTime(60000);
  expect(snapshot().request_balance).toBeCloseTo(8 + 500 / 24 / 60);
  expect(setCapacity(4).request_balance).toBe(4);
  expect(setCapacity(12).request_balance).toBe(4);
  vi.advanceTimersByTime(60000);
  expect(snapshot().request_balance).toBeCloseTo(4 + 500 / 24 / 60);
  expect(JSON.stringify(captured)).toBe(capturedJson);
});

it('provides eight production-shaped scenarios and keeps history provenance separate', async () => {
  const { demo, file } = await setup();
  const files = demo.getPacingFeedbackFiles().files;
  expect(files).toHaveLength(15);
  expect(new Set(files.map((item) => item.auth_index)).size).toBe(15);
  expect(files.slice(0, 2)).toEqual(captured.files.slice(0, 2));
  expect(file('local-account-1').availability_reason).toBe('reauth_required');
  expect(file('local-account-2').disabled).toBe(true);
  expect(file('local-account-3').account_scheduling!.limit_policy).toBeTruthy();
  expect(file('local-account-4').account_scheduling!.limit_policy).toBeTruthy();
  expect(
    file('local-account-3').account_scheduling!.warmup_traffic_pacing!.sent_attempts_60s
  ).toBeUndefined();
  expect(file('local-queue').account_scheduling!.warmup_traffic_pacing!.waiting_requests).toBe(3);
  expect(file('local-queue').account_scheduling!.warmup_traffic_pacing!.blocking_reasons).toContain(
    'concurrency'
  );
  expect(file('local-temporary').account_scheduling!.limit_policy!.temporary_status).toBe('active');
  expect(file('local-temporary').account_scheduling!.warmup_traffic_pacing!.concurrency_limit).toBe(
    2
  );
  expect(file('local-empty').account_scheduling!.warmup_traffic_pacing!.request_balance).toBe(0);
  for (const item of files) {
    const index = String(item.auth_index);
    const rows = demo.getPacingFeedbackAnalytics({
      from_ms: 0,
      to_ms: Date.now(),
      filters: { auth_indices: [index] },
      include: { events_page: { limit: 5 } },
    }).events!.items;
    expect(rows.every((row) => row.auth_index === index)).toBe(true);
    if (index.startsWith('local-account-')) {
      expect(rows).toEqual(
        captured.events
          .filter((row) => row.auth_index === index)
          .sort((a, b) => b.timestamp_ms - a.timestamp_ms)
          .slice(0, 5)
      );
    } else if (index === 'local-simulation') {
      expect(rows).toHaveLength(0);
    } else {
      if (
        !index.startsWith('local-speed-') &&
        !['local-no-anchor', 'local-custom-period', 'local-manual-mature'].includes(index)
      )
        expect(rows.length).toBeGreaterThanOrEqual(3);
      expect(rows.length).toBeLessThanOrEqual(5);
      expect(rows.every((row) => row.source === 'synthetic-local')).toBe(true);
    }
  }
  const snapshot = file('local-queue').account_scheduling!.warmup_traffic_pacing!;
  expect(snapshot.rolling_60s_requests).toBe(
    snapshot.sent_attempts_60s! + snapshot.unsent_reservations! + snapshot.recovered_holds!
  );
  vi.advanceTimersByTime(60000);
  expect(file('local-queue').account_scheduling!.warmup_traffic_pacing!.sent_attempts_60s).toBe(0);
});

it('edits AC-13 and AC-16 independently without changing captured facts', async () => {
  const { file, patch } = await setup();
  const ac13 = patch('local-account-3', {
    limit_overrides: { concurrency: 2, request_capacity: 12 },
  });
  expect(ac13.warmup_traffic_pacing!.concurrency_limit).toBe(2);
  expect(ac13.warmup_traffic_pacing!.request_capacity).toBe(12);
  expect(ac13.warmup_traffic_pacing!.request_balance).toBe(8);
  expect(file('local-account-4').account_scheduling!.warmup_traffic_pacing!.concurrency_limit).toBe(
    1
  );
  const ac16 = patch('local-account-4', {
    temporary_limits: { duration_minutes: 5, overrides: { rpm: 10 } },
  });
  expect(ac16.limit_policy!.fields.rpm.effective).toBe(10);
  vi.advanceTimersByTime(120000);
  patch('local-account-4', { limit_overrides: { rpm: 8 } });
  vi.advanceTimersByTime(180000);
  const expired = file('local-account-4').account_scheduling!;
  expect(expired.limit_policy!.temporary_status).toBe('expired');
  expect(expired.warmup_traffic_pacing!.rpm_limit).toBe(8);
  expect(
    patch('local-account-3', { limit_overrides: { concurrency: null, request_capacity: null } })
      .warmup_traffic_pacing!.concurrency_limit
  ).toBe(1);
  expect(JSON.stringify(captured)).toBe(capturedJson);
});

it('expires the preloaded temporary scenario and supports early termination', async () => {
  const { file, patch } = await setup();
  expect(file('local-temporary').account_scheduling!.warmup_traffic_pacing!.request_balance).toBe(
    8
  );
  expect(file('local-temporary').account_scheduling!.warmup_traffic_pacing!.request_capacity).toBe(
    12
  );
  vi.advanceTimersByTime(600000);
  const expired = file('local-temporary').account_scheduling!;
  expect(expired.limit_policy!.temporary_status).toBe('expired');
  expect(expired.warmup_traffic_pacing!.request_capacity).toBe(8);
  expect(expired.warmup_traffic_pacing!.request_balance).toBe(8);
  vi.setSystemTime(Date.now() - 3600000);
  expect(file('local-temporary').account_scheduling!.limit_policy!.temporary_status).toBe(
    'expired'
  );
  patch('local-account-3', {
    temporary_limits: { duration_minutes: 15, overrides: { concurrency: 2 } },
  });
  const ended = patch('local-account-3', { temporary_limits: null });
  expect(ended.limit_policy!.temporary_status).toBe('ended');
  expect(ended.warmup_traffic_pacing!.concurrency_limit).toBe(1);
});

it('preserves error scenarios, identity checks and atomic local failures', async () => {
  const { demo, file, patch } = await setup();
  const before = clonePolicy(file('local-account-3').account_scheduling!.limit_policy);
  window.location.search = '?pacing-feedback=1&pacing-scenario=save-error';
  expect(() => patch('local-account-3', { limit_overrides: { concurrency: 2 } })).toThrow(
    'save failure'
  );
  window.location.search = '?pacing-feedback=1';
  expect(() =>
    patch('local-account-3', {
      limit_overrides: { concurrency: 2 },
      temporary_limits: { duration_minutes: 15, overrides: { rpm: 100 } },
    })
  ).toThrow('Invalid local limit');
  expect(clonePolicy(file('local-account-3').account_scheduling!.limit_policy)).toBe(before);
  expect(() =>
    demo.handlePacingFeedbackRequest(
      'patch',
      '/auth-files/account-scheduling',
      new URLSearchParams(),
      { name: 'local-account-3.json', auth_index: 'local-account-4', limit_overrides: { rpm: 8 } }
    )
  ).toThrow('identity mismatch');
  window.location.search = '?pacing-feedback=1&pacing-scenario=error';
  expect(() =>
    demo.handlePacingFeedbackRequest(
      'get',
      '/auth-files/warmup-pacing',
      new URLSearchParams({ name: 'local-simulation.json', auth_index: 'local-simulation' })
    )
  ).toThrow('refresh failure');
  expect(JSON.stringify(captured)).toBe(capturedJson);
});
const clonePolicy = (policy: unknown) => JSON.stringify(policy);

it('overlays the sampled 60-day curve on GET config without replacing other demo settings', async () => {
  const { demo } = await setup();
  const policy = (await import('./pacingBudgetPolicySnapshot.json')).default;
  const existing = {
    'account-scheduling': { 'health-gate': { enabled: true }, 'rate-scale': 0.5 },
    routing: { strategy: 'round-robin' },
  };
  const overlaid = demo.withPacingFeedbackConfig(existing);
  expect(overlaid).toEqual({
    ...existing,
    'account-scheduling': {
      ...existing['account-scheduling'],
      'warmup-curve': policy.warmup_curve,
    },
  });
  expect(existing['account-scheduling']).not.toHaveProperty('warmup-curve');
  const { handleDemoApiRequest } = await import('./demoApi');
  window.location.search = '';
  const normal = await handleDemoApiRequest<Record<string, unknown>>('get', '/config');
  window.location.search = '?pacing-feedback=1';
  const config = await handleDemoApiRequest<Record<string, unknown>>('get', '/config');
  expect(config).toEqual({
    ...normal,
    'account-scheduling': {
      ...((normal['account-scheduling'] as object) || {}),
      'warmup-curve': policy.warmup_curve,
    },
  });
  expect(
    policy.warmup_curve.map((stage) => [stage['min-age-days'], stage['max-age-days']])
  ).toEqual([
    [0, 7],
    [7, 14],
    [14, 30],
    [30, 45],
    [45, 60],
  ]);
});

it('uses the new read-only age/first-production sample without changing the original capture', async () => {
  const { file } = await setup();
  const ac13 = file('local-account-3').account_scheduling!;
  const ac16 = file('local-account-4').account_scheduling!;
  expect(ac13.first_production_at).toBe('2026-09-15T06:32:42Z');
  expect(ac13.warmup?.age_days).toBe(8);
  expect(ac16.first_production_at).toBe('2026-09-11T15:44:47Z');
  expect(ac16.warmup?.age_days).toBe(11);
  expect(ac13.effective_limits?.token_daily_budget).toBe(0);
  expect(ac16.effective_limits?.token_daily_budget).toBe(0);
  expect(JSON.stringify(captured)).toBe(capturedJson);
});

it('uses existing token/window contracts for synthetic enabled, disabled and unknown examples', async () => {
  const { demo, file } = await setup();
  const enabled = file('local-temporary').account_scheduling!;
  const disabled = file('local-simulation').account_scheduling!;
  expect(enabled.effective_limits?.token_daily_budget).toBe(200000);
  expect(disabled.effective_limits?.token_daily_budget).toBe(0);
  const quota = enabled.quota_utilization as {
    windows: Record<string, { utilization_percent: number; headroom: number; resets_at: string }>;
    binding_window: { window: string; headroom: number; resets_at: string };
  };
  expect(Object.keys(quota).sort()).toEqual(['binding_window', 'windows']);
  expect(Object.keys(quota.windows).sort()).toEqual(['five_hour', 'seven_day']);
  expect(quota.windows.five_hour.utilization_percent).toBe(38);
  expect(quota.windows.seven_day.utilization_percent).toBe(52);
  for (const window of Object.values(quota.windows)) {
    expect(Object.keys(window).sort()).toEqual(['headroom', 'resets_at', 'utilization_percent']);
    expect(window.headroom).toBeCloseTo(1 - window.utilization_percent / 100);
    expect(Date.parse(window.resets_at)).toBeGreaterThan(Date.now());
  }
  expect(quota.binding_window).toEqual({
    window: 'seven_day',
    headroom: 0.48,
    resets_at: quota.windows.seven_day.resets_at,
  });
  expect(file('local-empty').account_scheduling!.quota_utilization).toBeNull();
  const files = demo.getPacingFeedbackFiles().files;
  expect(files.map((account) => account.auth_index)).toEqual([
    'local-account-1',
    'local-account-2',
    'local-account-3',
    'local-account-4',
    'local-simulation',
    'local-queue',
    'local-temporary',
    'local-empty',
    'local-speed-low',
    'local-speed-medium',
    'local-speed-high',
    'local-speed-extreme',
    'local-no-anchor',
    'local-custom-period',
    'local-manual-mature',
  ]);
  const counts = files.map(
    (account) =>
      demo.getPacingFeedbackAnalytics({
        from_ms: 0,
        to_ms: Date.now(),
        filters: { auth_indices: [String(account.auth_index)] },
        include: { events_page: { limit: 5 } },
      }).events!.items.length
  );
  expect(counts.slice(0, 4).reduce((sum, count) => sum + count, 0)).toBe(15);
  expect(counts.slice(4).reduce((sum, count) => sum + count, 0)).toBe(12);
});

it('runs a consistent 1x story: new group, tool continuations, local refusal, bounded retry and idle refill', async () => {
  const { demo, file } = await setup();
  const snapshot = () => file('local-simulation').account_scheduling!.warmup_traffic_pacing!;
  const history = () =>
    demo.getPacingFeedbackAnalytics({
      from_ms: 0,
      to_ms: Date.now(),
      filters: { auth_indices: ['local-simulation'] },
      include: { events_page: { limit: 5 } },
    }).events!.items;
  const initial = snapshot().request_balance!;
  expect(snapshot()).toMatchObject({
    sent_attempts_60s: 0,
    pending_requests: 0,
    waiting_requests: 1,
    inflight: 0,
    rolling_24h_requests: 0,
    request_capacity: 8,
    min_admission_requests: 4,
    rpm_limit: 5,
    concurrency_limit: 1,
  });
  expect(history()).toHaveLength(0);
  vi.advanceTimersByTime(12000);
  expect(snapshot()).toMatchObject({
    pending_requests: 1,
    inflight: 1,
    waiting_requests: 0,
    sent_attempts_60s: 0,
    rolling_60s_requests: 1,
    rolling_24h_requests: 1,
  });
  expect(snapshot().request_balance).toBeCloseTo(3);
  vi.advanceTimersByTime(1000);
  expect(snapshot()).toMatchObject({ pending_requests: 0, inflight: 1, sent_attempts_60s: 1 });
  expect(history()).toHaveLength(0);
  vi.advanceTimersByTime(47000);
  const rejected = snapshot();
  expect(rejected).toMatchObject({
    sent_attempts_60s: 4,
    rolling_24h_requests: 4,
    pending_requests: 0,
    inflight: 0,
    waiting_requests: 0,
  });
  expect(rejected.request_balance).toBeCloseTo(initial + 60 * (500 / 24 / 3600) - 4);
  expect(demo.getPacingStoryState()!.phase).toBe('retry_later');
  expect(history()).toHaveLength(5);
  expect(history().filter((row) => row.failed)).toMatchObject([
    {
      fail_status_code: 429,
      header_error_kind: 'local_admission',
      input_tokens: 0,
      total_tokens: 0,
    },
  ]);
  expect(file('local-simulation').success).toBe(4);
  expect(file('local-simulation').failed).toBe(0);
  vi.advanceTimersByTime(105000);
  expect(snapshot()).toMatchObject({
    waiting_requests: 1,
    inflight: 0,
    pending_requests: 0,
    sent_attempts_60s: 0,
    rolling_24h_requests: 4,
  });
  vi.advanceTimersByTime(19801);
  expect(snapshot()).toMatchObject({
    waiting_requests: 0,
    pending_requests: 1,
    inflight: 1,
    rolling_24h_requests: 5,
  });
  expect(snapshot().request_balance).toBeCloseTo(0, 4);
  vi.advanceTimersByTime(5000);
  expect(snapshot()).toMatchObject({
    waiting_requests: 0,
    pending_requests: 0,
    inflight: 0,
    sent_attempts_60s: 1,
    rolling_24h_requests: 5,
  });
  expect(demo.getPacingStoryState()).toMatchObject({ phase: 'refilling', completed: 5, total: 5 });
  expect(file('local-simulation').success).toBe(5);
  expect(
    history().every((row) => row.timestamp_ms <= Date.now() && row.source === 'synthetic-local')
  ).toBe(true);
  vi.advanceTimersByTime(3600000);
  expect(snapshot()).toMatchObject({
    request_balance: 8,
    sent_attempts_60s: 0,
    rolling_24h_requests: 5,
    active_binding_groups: 0,
  });
});

it('pauses without false ETA, advances only the story clock, replays only its account and never emits future history', async () => {
  const { demo, file } = await setup();
  const snapshot = () => file('local-simulation').account_scheduling!.warmup_traffic_pacing!;
  demo.controlPacingStory('pause');
  const paused = snapshot().request_balance;
  vi.advanceTimersByTime(60000);
  expect(snapshot().request_balance).toBe(paused);
  expect(snapshot().admission_balance_eta_seconds).toBeNull();
  expect(snapshot().refill_per_hour).toBeCloseTo(500 / 24);
  expect(Date.parse(snapshot().observed_at)).toBe(Date.now());
  demo.controlPacingStory('advance');
  expect(demo.getPacingStoryState()).toMatchObject({
    paused: true,
    elapsed_seconds: 60,
    fast_forwarded_seconds: 60,
    phase: 'retry_later',
  });
  expect(snapshot().rolling_24h_requests).toBe(4);
  const rows = demo.getPacingFeedbackAnalytics({
    from_ms: 0,
    to_ms: Date.now(),
    filters: { auth_indices: ['local-simulation'] },
  }).events!.items;
  expect(rows.every((row) => row.timestamp_ms <= Date.now())).toBe(true);
  const otherHistory = demo.getPacingFeedbackAnalytics({
    from_ms: 0,
    to_ms: Date.now(),
    filters: { auth_indices: ['local-account-3'] },
  }).events!.items;
  expect(otherHistory).toEqual(
    captured.events
      .filter((row) => row.auth_index === 'local-account-3')
      .sort((a, b) => b.timestamp_ms - a.timestamp_ms)
      .slice(0, 5)
  );
  demo.controlPacingStory('resume');
  vi.advanceTimersByTime(1000);
  expect(demo.getPacingStoryState()!.elapsed_seconds).toBe(61);
  demo.controlPacingStory('replay');
  expect(snapshot()).toMatchObject({
    sent_attempts_60s: 0,
    rolling_24h_requests: 0,
    waiting_requests: 1,
    pending_requests: 0,
    inflight: 0,
  });
  expect(demo.getPacingStoryState()).toMatchObject({
    paused: false,
    elapsed_seconds: 0,
    completed: 0,
  });
  expect(file('local-queue').account_scheduling!.warmup_traffic_pacing!.waiting_requests).toBe(3);
  expect(JSON.stringify(captured)).toBe(capturedJson);
});

it('uses a manually edited effective RPM without increasing refill or exceeding the window', async () => {
  const { demo, file, patch } = await setup();
  patch('local-simulation', { limit_overrides: { rpm: 1, concurrency: 2 } });
  vi.advanceTimersByTime(13000);
  const active = file('local-simulation').account_scheduling!.warmup_traffic_pacing!;
  expect(active.inflight).toBe(1);
  expect(active.concurrency_limit).toBe(2);
  expect(active.blocking_reasons).not.toContain('concurrency');
  vi.advanceTimersByTime(167000);
  const snapshot = file('local-simulation').account_scheduling!.warmup_traffic_pacing!;
  expect(snapshot.rpm_limit).toBe(1);
  const denied = demo
    .getPacingFeedbackAnalytics({
      from_ms: 0,
      to_ms: Date.now(),
      filters: { auth_indices: ['local-simulation'] },
    })
    .events!.items.filter((row) => row.failed);
  expect(denied.length).toBeGreaterThan(0);
  expect(denied.every((row) => row.header_error_code === 'rpm')).toBe(true);
  expect(snapshot.refill_per_hour).toBeCloseTo(500 / 24);
  expect(snapshot.sent_attempts_60s! + snapshot.unsent_reservations!).toBeLessThanOrEqual(1);
  const rows = demo
    .getPacingFeedbackAnalytics({
      from_ms: 0,
      to_ms: Date.now(),
      filters: { auth_indices: ['local-simulation'] },
      include: { events_page: { limit: 5 } },
    })
    .events!.items.filter((row) => !row.failed);
  expect(rows.length).toBeGreaterThanOrEqual(2);
  for (let index = 1; index < rows.length; index++)
    expect(rows[index - 1].timestamp_ms - rows[index].timestamp_ms).toBeGreaterThanOrEqual(60000);
});

it('projects four speeds and warm-up scenarios with isolated atomic updates', async () => {
  const { file, patch } = await setup();
  const before = JSON.stringify(file('local-account-4').account_scheduling!.warmup_control);
  const custom = patch('local-account-3', { speed_profile: 'high', warmup_period_days: 30 });
  expect(custom.warmup_control).toMatchObject({
    speed_profile: 'high',
    warmup_period_days: 30,
    effective_period_days: 30,
    source: 'profile',
  });
  expect(custom.warmup_control!.profiles.map((row) => row.id)).toEqual([
    'low',
    'medium',
    'high',
    'extreme',
  ]);
  expect(JSON.stringify(file('local-account-4').account_scheduling!.warmup_control)).toBe(before);
  const anchor = custom.first_production_at;
  const mature = patch('local-account-3', { warmup_mode: 'mature' });
  expect(mature.warmup?.mature).toBe(true);
  expect(mature.warmup_traffic_pacing?.reason).toBe('mature');
  expect(mature.first_production_at).toBe(anchor);
  const automatic = patch('local-account-3', { warmup_mode: 'auto' });
  expect(automatic.warmup?.mature).toBe(false);
  expect(automatic.warmup_control?.warmup_period_days).toBe(30);
  expect(automatic.first_production_at).toBe(anchor);
  const legacy = patch('local-account-3', { limit_overrides: { concurrency: 2 } });
  expect(legacy.warmup_control?.speed_profile).toBeNull();
  expect(legacy.warmup_control?.source).toBe('legacy');
  expect(file('local-no-anchor').account_scheduling!.warmup?.age_days).toBeNull();
  expect(() => patch('local-account-3', { speed_profile: 'low', rate_scale: 1 })).toThrow(
    'Mixed speed'
  );
  expect(() => patch('local-account-3', { warmup_period_days: 366 })).toThrow('Invalid period');
});
