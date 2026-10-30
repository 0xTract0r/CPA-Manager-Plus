// 此模块只由 demoFixtures 真实现引用；正式构建将该入口 alias 到空实现。
import captured from './pacingProductionSnapshot.json';
import budgetPolicy from './pacingBudgetPolicySnapshot.json';
import type {
  AuthFileItem,
  AuthFileAccountSchedulingPatchRequest,
  AccountLimitPolicy,
  AccountLimitField,
  AccountWarmupControl,
} from '@/types';
import type {
  MonitoringAnalyticsRequest,
  MonitoringAnalyticsResponse,
  MonitoringAnalyticsEventRow,
} from '@/services/api/usageService';
import { LIMIT_FIELDS } from '../authFiles/model/accountLimitPolicy';

const clone = <T>(value: T): T => structuredClone(value);
export const isPacingFeedbackDemo = () =>
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('pacing-feedback') === '1';
export const getPacingPreviewMeta = () =>
  isPacingFeedbackDemo()
    ? {
        captured_at: captured.captured_at,
        source: `4 sanitized accounts + 11 synthetic scenarios; budget policy sampled ${budgetPolicy.read_at}; subsequent policy/status changes are local simulations`,
      }
    : null;

// 仅覆盖已只读核实的养号曲线，保留其余demo配置及调度键。
export const withPacingFeedbackConfig = (raw: Record<string, unknown>): Record<string, unknown> => {
  if (!isPacingFeedbackDemo()) return raw;
  const existing = raw['account-scheduling'];
  return {
    ...raw,
    'account-scheduling': {
      ...(existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {}),
      'warmup-curve': clone(budgetPolicy.warmup_curve),
    },
  };
};

type DemoAccount = {
  file: AuthFileItem;
  bucket: { last: number; capacity: number; balance: number };
  dailyBudget: number;
  temporaryDeadline: number;
  temporaryIssued: number;
  synthetic: boolean;
  pending: number;
  recovered: number;
  waiting: number;
  inflight: number;
  groups: number;
};

const demoAccounts = new Map<string, DemoAccount>();
const syntheticEvents: MonitoringAnalyticsEventRow[] = [];
const accountKey = (file: AuthFileItem) => String(file.auth_index);

// 以下速度投影只用于本地演示，正式 UI 始终读取服务端 effective_limits。
const demoProfiles = (
  scheduling: NonNullable<AuthFileItem['account_scheduling']>
): AccountWarmupControl['profiles'] => {
  const period = scheduling.warmup_control?.effective_period_days ?? 60;
  const mature = scheduling.warmup?.mature === true;
  const fraction = (scheduling.warmup?.age_days ?? 0) / period;
  const stage =
    budgetPolicy.warmup_curve.find((row) => fraction < row['max-age-days'] / 60) ??
    budgetPolicy.warmup_curve[4];
  const threshold = scheduling.warmup_traffic_pacing?.min_admission_requests ?? 4;
  return (['low', 'medium', 'high', 'extreme'] as const).map((id, index) => {
    const scale = [0.5, 1, 1.5, 2][index];
    return {
      id,
      rpm: mature
        ? budgetPolicy.mature_limits['rpm-limit']
        : Math.max(1, Math.round(stage['rpm-limit'] * scale)),
      daily_budget: mature ? 0 : Math.max(1, Math.round(stage['daily-budget'] * scale)),
      concurrency: mature
        ? budgetPolicy.mature_limits['concurrency-limit']
        : Math.min(4, Math.max(1, Math.ceil(stage['concurrency-limit'] * scale))),
      request_capacity: mature ? 8 : Math.max(threshold, Math.round(8 * scale)),
      max_active_bindings: mature ? 1 : [1, 1, 2, 4][index],
    };
  });
};
const refreshDemoControl = (account: DemoAccount) => {
  const scheduling = account.file.account_scheduling!;
  const control = scheduling.warmup_control!;
  const period = control.warmup_period_days ?? 60;
  const age = scheduling.warmup?.age_days;
  const restricted = Boolean(scheduling.limit_policy?.restricted_reasons.length);
  const mature = !restricted && (control.manual_mature || (age != null && age >= period));
  scheduling.warmup = {
    ...scheduling.warmup,
    mature,
    stage: mature
      ? 'mature'
      : age == null
        ? 'cold'
        : age / period < 7 / 60
          ? 'day0-7'
          : age / period < 14 / 60
            ? 'day7-14'
            : age / period < 30 / 60
              ? 'day14-30'
              : 'day30-60',
  };
  control.effective_period_days = period;
  control.profiles = demoProfiles(scheduling);
  if (control.speed_profile) {
    const profile = control.profiles.find((row) => row.id === control.speed_profile)!;
    for (const name of LIMIT_FIELDS) scheduling.limit_policy!.fields[name].baseline = profile[name];
    account.dailyBudget = profile.daily_budget;
    scheduling.rate_scale = 1;
    scheduling.warmup.daily_budget = profile.daily_budget;
  }
};

const addEditableAccount = (file: AuthFileItem, synthetic = false) => {
  const copy = clone(file);
  const scheduling = copy.account_scheduling!;
  const pacing = scheduling.warmup_traffic_pacing!;
  const baselines = {
    rpm: pacing.rpm_limit ?? 5,
    concurrency: pacing.concurrency_limit ?? 1,
    request_capacity: pacing.request_capacity ?? 8,
    max_active_bindings: pacing.max_active_binding_groups ?? 1,
  };
  scheduling.limit_policy = {
    fields: Object.fromEntries(
      LIMIT_FIELDS.map((name) => [
        name,
        {
          baseline: baselines[name],
          fixed: null,
          temporary: null,
          effective: baselines[name],
          source: 'baseline',
          min: name === 'request_capacity' ? (pacing.min_admission_requests ?? 4) : 1,
          max: { rpm: 60, concurrency: 4, request_capacity: 32, max_active_bindings: 8 }[name],
        },
      ])
    ) as AccountLimitPolicy['fields'],
    temporary_status: 'none',
    temporary_issued_at: null,
    temporary_expires_at: null,
    temporary_end_reason: null,
    restricted_reasons: [],
  };
  scheduling.warmup_control = {
    speed_profile: null,
    warmup_mode: 'auto',
    warmup_period_days: null,
    effective_period_days: 60,
    source: 'legacy',
    manual_mature: false,
    profiles: demoProfiles(scheduling),
  };
  const account: DemoAccount = {
    file: copy,
    bucket: {
      last: performance.now(),
      capacity: baselines.request_capacity,
      balance: pacing.request_balance ?? 0,
    },
    dailyBudget: pacing.daily_request_budget ?? 500,
    temporaryDeadline: 0,
    temporaryIssued: 0,
    synthetic,
    pending: 0,
    recovered: 0,
    waiting: 0,
    inflight: 0,
    groups: 0,
  };
  demoAccounts.set(accountKey(copy), account);
  return account;
};

// 原始捕获JSON不变。仅AC-13/AC-16叠加可编辑的本地策略与后续内存状态。
for (const file of captured.files.slice(2, 4)) {
  const copy = clone(file) as AuthFileItem;
  const sample = budgetPolicy.accounts.find((account) => account.alias === copy.note)!;
  const scheduling = copy.account_scheduling!;
  scheduling.first_production_at = sample.first_production_at;
  scheduling.warmup = {
    ...scheduling.warmup,
    stage: sample.stage,
    mature: sample.mature,
    age_days: sample.age_days,
    daily_budget: sample.daily_budget,
  };
  scheduling.effective_limits = {
    ...scheduling.effective_limits,
    token_daily_budget: sample.token_daily_budget,
  };
  addEditableAccount(copy);
}

const makeSynthetic = (id: string, note: string, tier: string) => {
  const file = clone(captured.files[2]) as AuthFileItem;
  Object.assign(file, { id, name: `${id}.json`, auth_index: id, note, label: note });
  file.account_scheduling!.subscription_tier = tier;
  return addEditableAccount(file, true);
};
const simulation = makeSynthetic('local-simulation', '本地模拟 · 配速与临时上限', 'max_5x');
simulation.bucket.balance = 4 - 12 * (simulation.dailyBudget / 24 / 3600);
simulation.bucket.last = 0;
const initialSimulationPolicy = clone(simulation.file.account_scheduling!.limit_policy!);
type StoryRequest = {
  ordinal: number;
  reserved: number;
  sent: number | null;
  completed: number | null;
};
const story = {
  now: 0,
  realLast: performance.now(),
  paused: false,
  fastForwarded: 0,
  run: 1,
  requests: [] as StoryRequest[],
  rejections: [] as { at: number; code: string }[],
  active: null as StoryRequest | null,
  groupLastActivity: null as number | null,
  waitStarted: 0 as number | null,
  retryAt: null as number | null,
};
const storyRate = simulation.dailyBudget / 24 / 3600;
const storyTargetRequests = 5;

const queued = makeSynthetic('local-queue', 'QA-QUEUE · 子代理排队', 'max_20x');
queued.bucket.balance = 6;
queued.pending = 1;
queued.waiting = 3;
queued.inflight = 1;
queued.groups = 1;

const temporary = makeSynthetic('local-temporary', 'QA-TEMP · 临时覆盖生效', 'max_5x');
const temporaryPolicy = temporary.file.account_scheduling!.limit_policy!;
Object.assign(temporaryPolicy, {
  temporary_status: 'active',
  temporary_issued_at: new Date(Date.now() - 5 * 60000).toISOString(),
  temporary_expires_at: new Date(Date.now() + 10 * 60000).toISOString(),
});
for (const [name, value] of Object.entries({
  rpm: 8,
  concurrency: 2,
  request_capacity: 12,
  max_active_bindings: 2,
})) {
  temporaryPolicy.fields[name as AccountLimitField].temporary = value;
}
temporary.temporaryDeadline = performance.now() + 10 * 60000;
temporary.inflight = 1;
temporary.groups = 1;

const empty = makeSynthetic('local-empty', 'QA-EMPTY · 余额耗尽', 'pro');
empty.bucket.balance = 0;
empty.recovered = 1;

const speedScenarios = (['low', 'medium', 'high', 'extreme'] as const).map((speed, index) => {
  const account = makeSynthetic('local-speed-' + speed, '速度演示 · ' + speed, 'max_5x');
  const scheduling = account.file.account_scheduling!;
  scheduling.first_production_at = new Date(
    Date.now() - [2, 10, 20, 45][index] * 86400000
  ).toISOString();
  scheduling.warmup = { ...scheduling.warmup, age_days: [2, 10, 20, 45][index] };
  Object.assign(scheduling.warmup_control!, { speed_profile: speed, source: 'profile' });
  refreshDemoControl(account);
  return account;
});
const unanchored = makeSynthetic('local-no-anchor', '养号演示 · 尚未首投', 'pro');
unanchored.file.account_scheduling!.first_production_at = null;
unanchored.file.account_scheduling!.warmup = {
  ...unanchored.file.account_scheduling!.warmup,
  age_days: null,
  mature: false,
  stage: 'cold',
};
const customPeriod = makeSynthetic('local-custom-period', '养号演示 · 30 天', 'max_5x');
Object.assign(customPeriod.file.account_scheduling!.warmup_control!, {
  warmup_period_days: 30,
  effective_period_days: 30,
});
refreshDemoControl(customPeriod);
const manualMature = makeSynthetic('local-manual-mature', '养号演示 · 手动成熟', 'max_5x');
Object.assign(manualMature.file.account_scheduling!.warmup_control!, {
  warmup_mode: 'mature',
  manual_mature: true,
  speed_profile: 'medium',
  source: 'profile',
});
refreshDemoControl(manualMature);

// 订阅窗口严格使用现有core投影；百分比仅为模拟利用率，不是每日百分比硬上限。
const simulatedQuota = (fiveHour: number, sevenDay: number) => {
  const windows = {
    five_hour: {
      utilization_percent: fiveHour,
      headroom: 1 - fiveHour / 100,
      resets_at: new Date(Date.now() + 2 * 3600000).toISOString(),
    },
    seven_day: {
      utilization_percent: sevenDay,
      headroom: 1 - sevenDay / 100,
      resets_at: new Date(Date.now() + 4 * 86400000).toISOString(),
    },
  };
  const binding = fiveHour >= sevenDay ? 'five_hour' : 'seven_day';
  return {
    windows,
    binding_window: {
      window: binding,
      headroom: windows[binding].headroom,
      resets_at: windows[binding].resets_at,
    },
  };
};
// QA-TEMP演示有token日预算；独立local-simulation保持0（未启用），QA-EMPTY无窗口数据。
temporary.file.account_scheduling!.effective_limits = {
  ...temporary.file.account_scheduling!.effective_limits,
  token_daily_budget: 200000,
};
temporary.file.account_scheduling!.quota_utilization = simulatedQuota(38, 52);
simulation.file.account_scheduling!.effective_limits = {
  ...simulation.file.account_scheduling!.effective_limits,
  token_daily_budget: 0,
};
simulation.file.account_scheduling!.quota_utilization = simulatedQuota(5, 18);
empty.file.account_scheduling!.quota_utilization = null;

// 合成历史只挂在后4个模拟账号下，绝不混进前4个账号的真实采样历史。
for (const [position, account] of [simulation, queued, temporary, empty].entries()) {
  if (account === simulation) continue;
  const count = [3, 5, 4, 3][position];
  const at = Date.now();
  for (let index = 0; index < count; index++) {
    const localRefusal = account === queued && index === 0;
    syntheticEvents.push({
      event_hash: `${accountKey(account.file)}-event-${index + 1}`,
      request_id: `${accountKey(account.file)}-request-${index + 1}`,
      timestamp_ms: at - (15 + index * 25) * 1000,
      model: 'claude',
      endpoint: '/v1/messages',
      method: 'POST',
      path: '/v1/messages',
      auth_index: accountKey(account.file),
      account_snapshot: String(account.file.note),
      auth_label_snapshot: String(account.file.note),
      auth_file_snapshot: account.file.name,
      auth_provider_snapshot: 'claude',
      source: 'synthetic-local',
      source_hash: 'synthetic-local',
      api_key_hash: 'synthetic-local',
      input_tokens: localRefusal ? 0 : 160 + index * 35,
      output_tokens: localRefusal ? 0 : 220 + index * 20,
      cached_tokens: localRefusal ? 0 : 18500 + index * 1100,
      cache_read_tokens: localRefusal ? 0 : 18000 + index * 1000,
      cache_creation_tokens: localRefusal ? 0 : 500 + index * 100,
      reasoning_tokens: 0,
      total_tokens: localRefusal ? 0 : 18880 + index * 1155,
      latency_ms: localRefusal ? 6 : 2400 + index * 300,
      failed: localRefusal,
      fail_status_code: localRefusal ? 429 : 200,
      ...(localRefusal
        ? {
            header_error_kind: 'local_admission',
            header_error_code: 'account_concurrency_exceeded',
          }
        : {}),
    });
  }
}

const settleBucket = (account: DemoAccount, at: number) => {
  const bucket = account.bucket;
  const current = Math.max(bucket.last, at);
  bucket.balance = Math.min(
    bucket.capacity,
    bucket.balance + ((current - bucket.last) / 1000) * (account.dailyBudget / 24 / 3600)
  );
  bucket.last = current;
};
const expire = (account: DemoAccount, now = performance.now()) => {
  const policy = account.file.account_scheduling!.limit_policy!;
  const expired = policy.temporary_status === 'active' && now >= account.temporaryDeadline;
  // 自动到期按实际边界切换容量；人工改限先按旧容量结算，增容不回补历史丢弃额度。
  settleBucket(account, expired ? account.temporaryDeadline : now);
  if (expired) {
    policy.temporary_status = 'expired';
    policy.temporary_end_reason = 'expired';
    LIMIT_FIELDS.forEach((name) => {
      policy.fields[name].temporary = null;
    });
  }
  LIMIT_FIELDS.forEach((name) => {
    const field = policy.fields[name];
    field.effective = field.temporary ?? field.fixed ?? field.baseline;
    field.source =
      field.temporary != null ? 'temporary' : field.fixed != null ? 'fixed' : 'baseline';
  });
  account.bucket.capacity = policy.fields.request_capacity.effective!;
  account.bucket.balance = Math.min(account.bucket.balance, account.bucket.capacity);
  settleBucket(account, now);
};
const storyScenario = () => new URLSearchParams(window.location.search).get('pacing-scenario');
const storyGroupActive = () =>
  story.groupLastActivity !== null && story.now - story.groupLastActivity < 300000;
const storySentWithin = (duration: number) =>
  story.requests.filter((request) => request.sent !== null && request.sent > story.now - duration);
const storyDue = () => {
  const previous = story.requests[story.requests.length - 1];
  return story.retryAt ?? (previous?.sent == null ? 0 : previous.sent + 11000);
};
const storyRequiredBalance = () => (storyGroupActive() ? 1 : 4);
const nextStoryAdmission = () => {
  if (story.requests.length >= storyTargetRequests || storyScenario() === 'reauth') return Infinity;
  const policy = simulation.file.account_scheduling!.limit_policy!;
  const creditsAt =
    story.now +
    (Math.max(0, storyRequiredBalance() - simulation.bucket.balance) / storyRate) * 1000;
  const sent = storySentWithin(60000);
  const rpmAt =
    sent.length >= policy.fields.rpm.effective!
      ? sent[sent.length - policy.fields.rpm.effective!].sent! + 60000
      : story.now;
  return Math.max(storyDue(), creditsAt, rpmAt, story.now);
};
const advanceStory = (target: number) => {
  // 只有五个顺序请求；推进到事件边界，快进不跳过预约、扣额、30秒期限或窗口清理。
  while (story.now < target) {
    expire(simulation, story.now);
    const request = story.active;
    const readyAt = nextStoryAdmission();
    const queuedDeadline =
      story.waitStarted === null ? Infinity : Math.max(story.now, story.waitStarted + 30000);
    const eventAt = request
      ? request.sent === null
        ? request.reserved + 1000
        : request.sent + 3000
      : story.requests.length >= storyTargetRequests || storyScenario() === 'reauth'
        ? Infinity
        : story.waitStarted === null
          ? Math.max(story.now, storyDue())
          : Math.min(readyAt, queuedDeadline);
    const policy = simulation.file.account_scheduling!.limit_policy!;
    const expiryAt =
      policy.temporary_status === 'active' && simulation.temporaryDeadline > story.now
        ? simulation.temporaryDeadline
        : Infinity;
    const groupExpiry =
      !request && storyGroupActive() ? story.groupLastActivity! + 300000 : Infinity;
    const next = Math.min(target, eventAt, expiryAt, groupExpiry);
    expire(simulation, next);
    story.now = next;
    if (eventAt <= next + 1e-7) {
      if (!request) {
        const currentReady = nextStoryAdmission();
        if (currentReady > next + 30000 || (queuedDeadline <= next && currentReady > next + 1e-7)) {
          story.rejections.push({
            at: next,
            code:
              queuedDeadline <= next
                ? 'wait_timeout'
                : simulation.bucket.balance + 1e-9 < storyRequiredBalance()
                  ? 'request_balance'
                  : 'rpm',
          });
          story.retryAt = Math.max(next + 12000, currentReady - 20000);
          story.waitStarted = null;
        } else if (
          currentReady <= next + 1e-7 &&
          simulation.bucket.balance + 1e-9 >= storyRequiredBalance()
        ) {
          simulation.bucket.balance = Math.max(0, simulation.bucket.balance - 1);
          story.active = {
            ordinal: story.requests.length + 1,
            reserved: next,
            sent: null,
            completed: null,
          };
          story.requests.push(story.active);
          story.groupLastActivity = next;
          story.waitStarted = null;
          story.retryAt = null;
        } else if (story.waitStarted === null) {
          story.waitStarted = next;
        }
      } else if (request.sent === null) {
        request.sent = next;
        story.groupLastActivity = next;
      } else {
        request.completed = next;
        story.active = null;
        story.groupLastActivity = next;
      }
    }
  }
};
const syncStory = () => {
  const now = performance.now();
  const elapsed = story.paused ? 0 : Math.max(0, now - story.realLast);
  story.realLast = now;
  advanceStory(story.now + elapsed);
};
export const getPacingStoryState = () => {
  if (!isPacingFeedbackDemo()) return null;
  syncStory();
  const completed = story.requests.filter((request) => request.completed !== null).length;
  const phase =
    storyScenario() === 'reauth'
      ? 'reauth'
      : story.active
        ? story.active.sent === null
          ? 'reserved'
          : 'sending'
        : completed === storyTargetRequests
          ? 'refilling'
          : story.retryAt !== null && story.now < story.retryAt
            ? 'retry_later'
            : story.now < storyDue()
              ? 'tool'
              : storyGroupActive()
                ? 'waiting_continuation'
                : 'waiting_new';
  return {
    paused: story.paused,
    account_file_name: simulation.file.name,
    elapsed_seconds: Math.floor(story.now / 1000),
    fast_forwarded_seconds: story.fastForwarded / 1000,
    phase,
    completed,
    total: storyTargetRequests,
  };
};
export const controlPacingStory = (action: 'pause' | 'resume' | 'replay' | 'advance') => {
  if (!isPacingFeedbackDemo()) return;
  syncStory();
  if (action === 'pause') story.paused = true;
  if (action === 'resume') story.paused = false;
  if (action === 'advance') {
    advanceStory(story.now + 60000);
    story.fastForwarded += 60000;
  }
  if (action === 'replay') {
    Object.assign(story, {
      now: 0,
      paused: false,
      fastForwarded: 0,
      run: story.run + 1,
      requests: [],
      rejections: [],
      active: null,
      groupLastActivity: null,
      waitStarted: 0,
      retryAt: null,
    });
    Object.assign(simulation.bucket, { last: 0, capacity: 8, balance: 4 - 12 * storyRate });
    simulation.file.account_scheduling!.limit_policy = clone(initialSimulationPolicy);
    simulation.temporaryDeadline = 0;
    simulation.temporaryIssued = 0;
  }
  story.realLast = performance.now();
};
const storyHistory = (): MonitoringAnalyticsEventRow[] => [
  ...story.requests
    .filter((request) => request.completed !== null)
    .map((request) => {
      const read = request.ordinal === 1 ? 0 : 18000 + request.ordinal * 1000;
      const write = request.ordinal === 1 ? 18000 : 500;
      return {
        event_hash: `local-simulation-run-${story.run}-event-${request.ordinal}`,
        request_id: `local-simulation-run-${story.run}-request-${request.ordinal}`,
        timestamp_ms: Date.now() - (story.now - request.completed!),
        model: 'claude',
        endpoint: '/v1/messages',
        method: 'POST',
        path: '/v1/messages',
        auth_index: 'local-simulation',
        account_snapshot: String(simulation.file.note),
        auth_label_snapshot: String(simulation.file.note),
        auth_file_snapshot: simulation.file.name,
        auth_provider_snapshot: 'claude',
        source: 'synthetic-local',
        source_hash: 'synthetic-local',
        api_key_hash: 'synthetic-local',
        input_tokens: 160,
        output_tokens: 220,
        cache_read_tokens: read,
        cache_creation_tokens: write,
        cached_tokens: read + write,
        reasoning_tokens: 0,
        total_tokens: 380 + read + write,
        latency_ms: 3000,
        failed: false,
        fail_status_code: 200,
      };
    }),
  ...story.rejections.map((rejection, index) => ({
    event_hash: `local-simulation-run-${story.run}-rejection-${index}`,
    request_id: `local-simulation-run-${story.run}-rejection-${index}`,
    timestamp_ms: Date.now() - (story.now - rejection.at),
    model: 'claude',
    endpoint: '/v1/messages',
    method: 'POST',
    path: '/v1/messages',
    auth_index: 'local-simulation',
    account_snapshot: String(simulation.file.note),
    auth_label_snapshot: String(simulation.file.note),
    auth_file_snapshot: simulation.file.name,
    auth_provider_snapshot: 'claude',
    source: 'synthetic-local',
    source_hash: 'synthetic-local',
    api_key_hash: 'synthetic-local',
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    cached_tokens: 0,
    reasoning_tokens: 0,
    total_tokens: 0,
    latency_ms: 0,
    failed: true,
    fail_status_code: 429,
    header_error_kind: 'local_admission',
    header_error_code: rejection.code,
  })),
];

const simulatedFile = (account: DemoAccount) => {
  if (account === simulation) {
    syncStory();
    expire(account, story.now);
  } else expire(account);
  const file = clone(account.file);
  const scheduling = file.account_scheduling!;
  const policy = scheduling.limit_policy!;
  const pacing = scheduling.warmup_traffic_pacing!;
  const threshold = pacing.min_admission_requests ?? 4;
  const refillPerHour = account.dailyBudget / 24;
  const blocking: string[] = [];
  if (account.bucket.balance < threshold) blocking.push('request_balance');
  Object.assign(pacing, {
    observed_at: new Date().toISOString(),
    request_balance: account.bucket.balance,
    request_capacity: policy.fields.request_capacity.effective,
    admission_balance_eta_seconds: Math.max(
      0,
      (threshold - account.bucket.balance) / (refillPerHour / 3600)
    ),
    refill_per_hour: refillPerHour,
    daily_request_budget: account.dailyBudget,
    rpm_limit: policy.fields.rpm.effective,
    concurrency_limit: policy.fields.concurrency.effective,
    max_active_binding_groups: policy.fields.max_active_bindings.effective,
  });
  if (account === simulation) {
    const pending = story.active && story.active.sent === null ? 1 : 0;
    const sent = storySentWithin(60000).length;
    const waiting =
      story.waitStarted !== null && !story.active && storyScenario() !== 'reauth' ? 1 : 0;
    Object.assign(pacing, {
      sent_attempts_60s: sent,
      unsent_reservations: pending,
      pending_requests: pending,
      recovered_holds: 0,
      waiting_requests: waiting,
      rolling_60s_requests: sent + pending,
      rolling_24h_requests: storySentWithin(86400000).length + pending,
      inflight: story.active ? 1 : 0,
      active_binding_groups: storyGroupActive() ? 1 : 0,
    });
    if (story.paused) pacing.admission_balance_eta_seconds = null;
    if (waiting && simulation.bucket.balance < storyRequiredBalance()) {
      blocking.length = 0;
      blocking.push('request_balance');
    } else if (simulation.bucket.balance >= storyRequiredBalance()) blocking.length = 0;
    if (sent + pending >= policy.fields.rpm.effective!) blocking.push('rpm');
    if (story.active && policy.fields.concurrency.effective! <= 1) blocking.push('concurrency');
    file.success = story.requests.filter((request) => request.completed !== null).length;
    file.failed = 0;
    scheduling.sessions_total = story.requests.length ? 1 : 0;
    scheduling.sessions_active = storyGroupActive() ? 1 : 0;
    scheduling.sessions_closed = scheduling.sessions_total - scheduling.sessions_active;
    if (policy.temporary_issued_at) {
      policy.temporary_issued_at = new Date(
        Date.now() - (story.now - simulation.temporaryIssued)
      ).toISOString();
      policy.temporary_expires_at = new Date(
        Date.now() - (story.now - simulation.temporaryDeadline)
      ).toISOString();
    }
  } else if (account.synthetic) {
    const sent = syntheticEvents.filter(
      (row) =>
        row.auth_index === accountKey(file) &&
        row.timestamp_ms > Date.now() - 60000 &&
        row.header_error_kind !== 'local_admission'
    ).length;
    const occupancy = sent + account.pending + account.recovered;
    Object.assign(pacing, {
      sent_attempts_60s: sent,
      unsent_reservations: account.pending,
      pending_requests: account.pending,
      recovered_holds: account.recovered,
      waiting_requests: account.waiting,
      rolling_60s_requests: occupancy,
      inflight: account.inflight,
      active_binding_groups: account.groups,
    });
    if (occupancy >= policy.fields.rpm.effective!) blocking.push('rpm');
    if (account.inflight >= policy.fields.concurrency.effective!) blocking.push('concurrency');
    if (account.groups >= policy.fields.max_active_bindings.effective!)
      blocking.push('active_groups');
  }
  if (scheduling.warmup?.mature === true) {
    Object.assign(pacing, {
      status: 'not_applicable',
      reason: 'mature',
      request_balance: null,
      refill_per_hour: null,
      admission_balance_eta_seconds: null,
    });
    blocking.length = 0;
  } else if (scheduling.warmup_control?.manual_mature === false) {
    pacing.status = 'active';
    pacing.reason = 'observed';
  }
  pacing.blocking_reasons = blocking;
  scheduling.effective_limits = {
    ...scheduling.effective_limits,
    rpm: policy.fields.rpm.effective!,
    concurrency: policy.fields.concurrency.effective!,
    daily_budget: scheduling.warmup?.mature ? 0 : account.dailyBudget,
    pacing_applies: scheduling.warmup?.mature !== true,
  };
  if (
    accountKey(file) === 'local-simulation' &&
    new URLSearchParams(window.location.search).get('pacing-scenario') === 'reauth'
  ) {
    file.unavailable = true;
    file.availability_reason = 'reauth_required';
  }
  return file;
};

export const getPacingFeedbackFiles = () => ({
  files: [
    ...captured.files.map((file) => {
      const account = demoAccounts.get(String(file.auth_index));
      return account ? simulatedFile(account) : (clone(file) as AuthFileItem);
    }),
    ...[
      simulation,
      queued,
      temporary,
      empty,
      ...speedScenarios,
      unanchored,
      customPeriod,
      manualMature,
    ].map(simulatedFile),
  ],
});
export const getPacingFeedbackAnalytics = (
  request?: MonitoringAnalyticsRequest
): MonitoringAnalyticsResponse => {
  syncStory();
  const indices = request?.filters?.auth_indices || [];
  const items = [...captured.events, ...syntheticEvents, ...storyHistory()]
    .filter((row) => indices.includes(String(row.auth_index)))
    .sort((a, b) => b.timestamp_ms - a.timestamp_ms)
    .slice(0, Math.min(5, request?.include?.events_page?.limit ?? 5));
  return {
    generated_at_ms: Date.now(),
    granularity: 'hour',
    events: { items: items as MonitoringAnalyticsEventRow[], next_before_ms: 0, has_more: false },
  };
};
export function handlePacingFeedbackRequest(
  method: string,
  pathname: string,
  params: URLSearchParams,
  data?: unknown
) {
  if (!isPacingFeedbackDemo()) return undefined;
  if (pathname === '/auth-files/warmup-pacing' && method === 'get') {
    const file = getPacingFeedbackFiles().files.find(
      (file) =>
        file.name === params.get('name') && String(file.auth_index) === params.get('auth_index')
    );
    if (!file) throw Object.assign(new Error('Local fixture account missing'), { status: 404 });
    if (
      file.auth_index === 'local-simulation' &&
      new URLSearchParams(window.location.search).get('pacing-scenario') === 'error'
    )
      throw new Error('Local simulated refresh failure');
    return {
      name: file.name,
      auth_index: String(file.auth_index),
      disabled: file.disabled,
      status: file.status,
      unavailable: file.unavailable,
      availability_reason: file.availability_reason,
      account_scheduling: file.account_scheduling,
    };
  }
  if (pathname === '/auth-files/account-scheduling' && method === 'patch') {
    const request = data as AuthFileAccountSchedulingPatchRequest;
    const account = demoAccounts.get(String(request.auth_index));
    if (!account || account.file.name !== request.name)
      throw new Error('Local editable account identity mismatch');
    if (new URLSearchParams(window.location.search).get('pacing-scenario') === 'save-error')
      throw new Error('Local simulated save failure');
    if (account === simulation) {
      syncStory();
      expire(account, story.now);
    } else expire(account);
    const legacy =
      request.rate_scale !== undefined ||
      request.limit_overrides !== undefined ||
      request.temporary_limits !== undefined;
    if (request.speed_profile !== undefined && legacy)
      throw new Error('Mixed speed and legacy limits');
    if (
      request.speed_profile != null &&
      !['low', 'medium', 'high', 'extreme'].includes(request.speed_profile)
    )
      throw new Error('Invalid profile');
    if (
      request.warmup_period_days != null &&
      (!Number.isSafeInteger(request.warmup_period_days) ||
        request.warmup_period_days < 1 ||
        request.warmup_period_days > 365)
    )
      throw new Error('Invalid period');
    if (request.warmup_mode != null && !['auto', 'mature'].includes(request.warmup_mode))
      throw new Error('Invalid warmup mode');
    const policy = clone(account.file.account_scheduling!.limit_policy!);
    let temporaryDeadline = account.temporaryDeadline;
    let temporaryIssued = account.temporaryIssued;
    const apply = (
      values: Partial<Record<AccountLimitField, number | null>>,
      kind: 'fixed' | 'temporary'
    ) => {
      for (const [key, value] of Object.entries(values)) {
        const field = policy.fields[key as AccountLimitField];
        if (
          !field ||
          (value !== null &&
            (!Number.isSafeInteger(value) || value < field.min! || value > field.max!)) ||
          (kind === 'temporary' && value === null)
        )
          throw new Error('Invalid local limit');
        field[kind] = value;
      }
    };
    if (request.limit_overrides !== undefined)
      apply(
        request.limit_overrides ?? Object.fromEntries(LIMIT_FIELDS.map((name) => [name, null])),
        'fixed'
      );
    if (request.temporary_limits !== undefined) {
      LIMIT_FIELDS.forEach((name) => {
        policy.fields[name].temporary = null;
      });
      if (request.temporary_limits === null) {
        policy.temporary_status = 'ended';
        policy.temporary_end_reason = 'manual';
      } else {
        if (
          ![5, 15, 30].includes(request.temporary_limits.duration_minutes) ||
          !Object.keys(request.temporary_limits.overrides).length
        )
          throw new Error('Invalid duration');
        apply(request.temporary_limits.overrides, 'temporary');
        policy.temporary_status = 'active';
        policy.temporary_end_reason = null;
        policy.temporary_issued_at = new Date().toISOString();
        policy.temporary_expires_at = new Date(
          Date.now() + request.temporary_limits.duration_minutes * 60000
        ).toISOString();
        temporaryIssued = account === simulation ? story.now : performance.now();
        temporaryDeadline = temporaryIssued + request.temporary_limits.duration_minutes * 60000;
      }
    }
    const scheduling = account.file.account_scheduling!;
    const control = scheduling.warmup_control!;
    if (legacy) {
      control.speed_profile = null;
      control.source = 'legacy';
    }
    if (request.speed_profile !== undefined) {
      control.speed_profile = request.speed_profile;
      control.source = request.speed_profile ? 'profile' : 'legacy';
      if (request.speed_profile) {
        for (const name of LIMIT_FIELDS) {
          policy.fields[name].fixed = null;
          policy.fields[name].temporary = null;
        }
        policy.temporary_status = 'none';
        policy.temporary_expires_at = null;
        policy.temporary_issued_at = null;
        temporaryDeadline = 0;
      }
    }
    if (request.warmup_mode !== undefined) {
      control.warmup_mode = request.warmup_mode ?? 'auto';
      control.manual_mature = control.warmup_mode === 'mature';
    }
    if (request.warmup_period_days !== undefined)
      control.warmup_period_days = request.warmup_period_days;
    if (request.first_production_at !== undefined) {
      scheduling.first_production_at = request.first_production_at;
      scheduling.warmup = {
        ...scheduling.warmup,
        age_days: request.first_production_at
          ? Math.max(0, (Date.now() - Date.parse(request.first_production_at)) / 86400000)
          : null,
      };
    }
    if (request.rate_scale !== undefined) scheduling.rate_scale = request.rate_scale ?? 1;
    if (request.tier_override !== undefined) {
      scheduling.tier_source = request.tier_override ? 'override' : 'auto';
      if (request.tier_override) scheduling.subscription_tier = request.tier_override;
    }
    account.file.account_scheduling!.limit_policy = policy;
    account.temporaryDeadline = temporaryDeadline;
    account.temporaryIssued = temporaryIssued;
    if (
      request.speed_profile !== undefined ||
      request.warmup_mode !== undefined ||
      request.warmup_period_days !== undefined ||
      request.first_production_at !== undefined
    )
      refreshDemoControl(account);
    return {
      name: account.file.name,
      auth_index: account.file.auth_index,
      account_scheduling: simulatedFile(account).account_scheduling,
    };
  }
  return undefined;
}
