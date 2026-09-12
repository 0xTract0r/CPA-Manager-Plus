/**
 * cpamp 账号备注优先 UI 回归。
 *
 * 用法：
 *   CPAMP_UI_BASE=http://127.0.0.1:4173 \
 *   PLAYWRIGHT_MODULE=/path/to/playwright \
 *   node scripts/playwright-account-identity.smoke.mjs
 *
 * 产物：OUT_DIR 下的 trace.zip、逐页截图、console-network.json、result.json。
 * 默认只访问 demo 构建；农场接口由本脚本注入固定脱敏样本，不读取生产数据。
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = (process.env.CPAMP_UI_BASE || 'http://127.0.0.1:4173').replace(/\/$/, '');
const out = path.resolve(
  process.env.OUT_DIR ||
    path.join(path.dirname(new URL(import.meta.url).pathname), '../build/account-identity-smoke')
);

const now = Date.now();
const iso = (offsetMinutes = 0) => new Date(now + offsetMinutes * 60_000).toISOString();
const farmAccounts = [
  {
    name: 'farm-main.json',
    account: 'farm.owner+prod@example.test',
    note: '农场主力账号',
    status: 'active',
    disabled: false,
    farm_bound: true,
    farm_container_id: 'farm-container-01',
    farm_container_status: 'running',
    farm_env: 'test',
    farm_enrolled: true,
    device_id_source: 'container_synced',
    last_refresh: iso(-3),
    success: 420,
    failed: 2,
  },
  {
    name: 'farm-backup.json',
    account: 'backup.long+night@example.test',
    note: '农场夜间备用',
    status: 'active',
    disabled: false,
    farm_bound: false,
    farm_enrolled: true,
    device_id_source: 'synthetic',
    last_refresh: iso(-8),
    success: 120,
    failed: 1,
  },
  {
    name: 'farm-no-note.json',
    account: 'no.note+fallback@example.test',
    status: 'active',
    disabled: false,
    farm_bound: false,
    farm_enrolled: false,
    device_id_source: 'synthetic',
    last_refresh: iso(-15),
    success: 18,
    failed: 0,
  },
];

const farmContainers = [
  {
    id: 'farm-container-01',
    device_id_masked: 'f00dbabe12345678',
    status: 'running',
    health_reason: 'ok',
    last_keepalive_at: iso(-2),
    created_at: iso(-10_000),
    updated_at: iso(-1),
    success_rate_24h: 0.995,
    telemetry_alive: 'alive',
    account_auth_status: 'alive',
    account_auth_reason: 'ok',
    device_id_alignment: 'container_synced',
    binding: {
      env: 'test',
      account: 'farm.owner+prod@example.test',
      note: '农场主力账号',
      auth_index: 1,
      bound_at: iso(-9_000),
    },
    latest_resource: { ts: iso(-1), mem_used_bytes: 268_435_456, mem_pct: 25, cpu_pct: 8 },
  },
  {
    id: 'farm-container-free',
    device_id_masked: 'cafe1234567890ab',
    status: 'created',
    health_reason: 'not_started',
    created_at: iso(-120),
    updated_at: iso(-60),
  },
];

const farmPayload = (pathname) => {
  if (pathname.endsWith('/accounts')) return farmAccounts;
  if (pathname.endsWith('/account-state')) {
    return {
      accounts: farmAccounts.map((account, index) => ({
        account_id: account.name,
        auth_state: 'healthy',
        observed_at: iso(-index - 1),
      })),
    };
  }
  if (pathname.endsWith('/containers')) return farmContainers;
  if (pathname.endsWith('/resources')) {
    return {
      containers: [
        {
          container_id: 'farm-container-01',
          account_id: 'farm-main.json',
          mem_used_bytes: 268_435_456,
          mem_limit_bytes: 1_073_741_824,
          mem_pct: 25,
          cpu_pct: 8,
        },
      ],
      host: {
        mem_used_bytes: 4_294_967_296,
        mem_total_bytes: 17_179_869_184,
        mem_pct: 25,
        load1: 0.8,
        cpu_count: 8,
        note: '固定脱敏 UI 样本；整机指标包含非农场进程。',
      },
    };
  }
  if (pathname.endsWith('/usage')) {
    return {
      scope: 'cpa_account_cumulative',
      note: '固定脱敏 UI 样本，自 CPA 上次重启起累计。',
      items: [
        {
          container_id: 'farm-container-01',
          account_id: 'farm-main.json',
          account_email: 'farm.owner+prod@example.test',
          account_note: '农场主力账号',
          env: 'test',
          auth_index: 1,
          tokens: {
            input: 123_000,
            output: 42_000,
            cache_read: 18_000,
            reasoning: 9_000,
            total: 192_000,
            billable: 174_000,
          },
          cost_usd: 1.2345,
          requests: 420,
        },
      ],
    };
  }
  if (pathname.endsWith('/capacity')) {
    return {
      active_containers: 1,
      max_active_containers: 8,
      mem_available_bytes: 12_884_901_888,
      mem_available_threshold_bytes: 2_147_483_648,
      host_metrics_available: true,
      has_headroom: true,
      remaining_slots: 7,
      bottleneck: 'containers',
      auto_provision_enabled: true,
      proxy_coverage: { configured_accounts: 2, total_accounts: 3 },
      provisioning: [
        {
          account_id: 'farm-main.json',
          env: 'test',
          eligible: false,
          pending_reason: null,
          auto_provisioned: true,
        },
        {
          account_id: 'farm-backup.json',
          env: 'test',
          eligible: true,
          pending_reason: 'capacity_exhausted',
          auto_provisioned: false,
        },
      ],
    };
  }
  if (pathname.endsWith('/standby-summary')) {
    return {
      env: 'test',
      generated_at: iso(),
      disabled_accounts: {
        threshold_days: 7,
        count: 1,
        items: [
          {
            account_id: 'farm.owner+prod@example.test',
            note: '农场主力账号',
            disabled_since: iso(-11_000),
            age_days: 8,
            farm_enrolled: true,
          },
        ],
      },
      standby_containers: {
        count: 1,
        items: [
          {
            container_id: 'farm-container-standby',
            account_id: 'backup.long+night@example.test',
            note: '农场夜间备用',
            standby_since: iso(-180),
            status: 'standby',
          },
        ],
      },
      retired_volumes: { count: 0, disk_bytes: null, items: [] },
    };
  }
  if (pathname.endsWith('/overview')) {
    return {
      containers_by_status: { running: 1, created: 1 },
      total_containers: 2,
      active_containers: 1,
      bound_containers: 1,
      firing_alerts: 0,
      generated_at: iso(),
    };
  }
  if (pathname.endsWith('/alerts')) return { items: [], total: 0 };
  if (pathname.endsWith('/config')) return { auto_provision_enabled: true };
  return {};
};

await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  locale: 'zh-CN',
});
await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
const page = await context.newPage();
const consoleErrors = [];
const networkFailures = [];
const checks = [];

page.on('pageerror', (error) => consoleErrors.push(String(error)));
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
page.on('requestfailed', (request) => {
  if (request.failure()?.errorText !== 'net::ERR_ABORTED') {
    networkFailures.push({ url: request.url(), error: request.failure()?.errorText });
  }
});
page.on('response', (response) => {
  if (response.status() >= 400)
    networkFailures.push({ url: response.url(), status: response.status() });
});
await page.route('**/api/farm/**', async (route) => {
  const pathname = new URL(route.request().url()).pathname;
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(farmPayload(pathname)),
  });
});

const routeUrl = (route) => `${base}/#/demo${route}`;
const shot = (name) => path.join(out, name);

async function open(route, ready) {
  await page.goto('about:blank');
  await page.goto(routeUrl(route), { waitUntil: 'domcontentloaded' });
  await page.locator(ready).first().waitFor({ state: 'visible', timeout: 45_000 });
}

async function assertIdentity(testId, { note, masked, full }) {
  const identity = page.getByTestId(testId);
  await identity.waitFor({ state: 'visible', timeout: 30_000 });
  const visibleText = (await identity.innerText()).trim();
  if (note) assert(visibleText.includes(note), `${testId} 应显示备注 ${note}，实际 ${visibleText}`);
  assert(visibleText.includes(masked), `${testId} 应显示脱敏邮箱 ${masked}，实际 ${visibleText}`);
  assert(!visibleText.includes(full), `${testId} 不应默认显示完整邮箱`);
  const email = page.getByTestId(`${testId}-email`);
  await email.hover();
  const tooltip = page.getByTestId(`${testId}-email-tooltip`);
  await tooltip.waitFor({ state: 'visible', timeout: 10_000 });
  assert.equal((await tooltip.innerText()).trim(), full);
}

try {
  await open('/auth-files', '[data-testid^="auth-file-card-"]');
  const authSearch = page.locator('input[placeholder*="备注"]').first();
  await authSearch.fill('开发团队主账号');
  await page.getByTestId('auth-file-card-codex-team-01.json').waitFor();
  await assertIdentity('auth-file-identity-codex-team-01.json', {
    note: '开发团队主账号',
    masked: 'pl***@example.com',
    full: 'platform@example.com',
  });
  await authSearch.fill('这是一个用于验证窄屏截断');
  await page.getByTestId('auth-file-card-antigravity-scaled-04.json').waitFor();
  await authSearch.fill('Ops.Owner+Blue@Accounts.Example.Test');
  await page.getByTestId('auth-file-card-claude-scaled-02.json').waitFor();
  await page.screenshot({ path: shot('auth-files-desktop.png'), fullPage: true });
  checks.push('认证文件：备注主显、邮箱脱敏 tooltip、备注/完整邮箱搜索');

  await open('/quota', '[data-testid^="quota-account-identity-"]');
  const quotaSearch = page.locator('input[placeholder*="备注"]').first();
  await quotaSearch.fill('开发团队主账号');
  await page.getByTestId('quota-account-identity-codex-team-01.json').waitFor();
  await assertIdentity('quota-account-identity-codex-team-01.json', {
    note: '开发团队主账号',
    masked: 'pl***@example.com',
    full: 'platform@example.com',
  });
  await quotaSearch.fill('Ops.Owner+Blue@Accounts.Example.Test');
  await page.getByTestId('quota-account-identity-claude-scaled-02.json').waitFor();
  await page.screenshot({ path: shot('quota-desktop.png'), fullPage: true });
  checks.push('配额：备注主显、邮箱脱敏 tooltip、完整邮箱搜索');

  await open('/monitoring', 'input[placeholder*="备注"]');
  const monitoringSearch = page.locator('input[placeholder*="备注"]').first();
  await monitoringSearch.fill('开发团队主账号');
  await page.getByText('开发团队主账号', { exact: true }).first().waitFor({ timeout: 30_000 });
  const monitoringMasked = page.getByText('pl***@example.com', { exact: true }).first();
  await monitoringMasked.waitFor();
  assert.equal(await monitoringMasked.getAttribute('title'), 'platform@example.com');
  await page.screenshot({ path: shot('monitoring-desktop.png'), fullPage: true });
  checks.push('监控中心：备注搜索映射 auth index、备注/脱敏邮箱层级');

  await open('/usage-analytics?tab=credentials', '[data-testid^="usage-credential-identity-"]');
  const credentialIdentity = page
    .locator('[data-testid^="usage-credential-identity-"]')
    .filter({ hasText: '开发团队主账号' })
    .first();
  await credentialIdentity.waitFor();
  assert((await credentialIdentity.innerText()).includes('pl***@example.com'));
  await credentialIdentity.locator('span[aria-label="platform@example.com"]').hover();
  await page.getByRole('tooltip').filter({ hasText: 'platform@example.com' }).waitFor();
  const usageSearch = page.locator('input[placeholder*="备注"]').first();
  await usageSearch.fill('开发团队主账号');
  await credentialIdentity.waitFor();
  await page.screenshot({ path: shot('usage-credentials-desktop.png'), fullPage: true });
  checks.push('用量分析：凭据备注主显、邮箱脱敏、备注搜索');

  await open('/usage-analytics?tab=performance', '[data-testid="model-performance"]');
  const performanceIdentity = page
    .locator('[data-testid^="performance-account-identity-"]')
    .filter({ hasText: '开发团队主账号' })
    .first();
  await performanceIdentity.waitFor();
  assert((await performanceIdentity.innerText()).includes('pl***@example.com'));
  await page.screenshot({ path: shot('performance-desktop.png'), fullPage: true });
  checks.push('模型性能：备注并入账号主列、邮箱脱敏副显');

  await open('/codex-inspection/server', '[data-testid="codex-inspection-account-server-501"]');
  await assertIdentity('codex-inspection-account-server-501', {
    note: '开发团队主账号',
    masked: 'pl***@example.com',
    full: 'platform@example.com',
  });
  await page.screenshot({ path: shot('codex-inspection-desktop.png'), fullPage: true });
  checks.push('服务端巡检：当前备注再关联、邮箱脱敏 tooltip');

  await open('/monitoring/account-actions', '[data-testid="account-action-identity-201"]');
  await assertIdentity('account-action-identity-201', {
    note: '自动化备用池',
    masked: 'au***@example.com',
    full: 'automation+fallback@example.com',
  });
  const issueSearch = page.locator('input[placeholder*="备注"]').first();
  await issueSearch.fill('自动化备用池');
  await page.getByTestId('account-action-identity-201').waitFor();
  await page.screenshot({ path: shot('account-actions-desktop.png'), fullPage: true });
  checks.push('认证异常：备注/邮箱关联、备注搜索、邮箱默认脱敏');

  await open('/farm/accounts', '[data-testid="farm-account-row-farm-main.json"]');
  assert.equal(
    (await page.getByTestId('farm-account-primary-name-farm-main.json').innerText()).trim(),
    '农场主力账号'
  );
  const farmAccountEmail = page.getByTestId('farm-account-secondary-identity-farm-main.json');
  assert.equal((await farmAccountEmail.innerText()).trim(), 'fa***@example.test');
  await farmAccountEmail.hover();
  await page
    .getByTestId('farm-account-secondary-identity-farm-main.json-tooltip')
    .waitFor({ state: 'visible' });
  await page.getByTestId('farm-accounts-search').fill('农场主力账号');
  await page.getByTestId('farm-account-row-farm-main.json').waitFor();
  await page.screenshot({ path: shot('farm-accounts-desktop.png'), fullPage: true });
  checks.push('农场账号：备注搜索、脱敏邮箱与全文 tooltip');

  await open(
    '/farm/containers',
    '[data-testid="farm-container-binding-secondary-farm-container-01"]'
  );
  assert.equal(
    (await page.getByTestId('farm-container-binding-primary-farm-container-01').innerText()).trim(),
    '农场主力账号'
  );
  assert.equal(
    (
      await page.getByTestId('farm-container-binding-secondary-farm-container-01').innerText()
    ).trim(),
    'fa***@example.test'
  );
  await page.screenshot({ path: shot('farm-containers-desktop.png'), fullPage: true });
  checks.push('农场容器：绑定账号备注主显、邮箱脱敏');

  await open('/farm/usage', '[data-testid="farm-usage-identity-farm-container-01-farm-main.json"]');
  await assertIdentity('farm-usage-identity-farm-container-01-farm-main.json', {
    note: '农场主力账号',
    masked: 'fa***@example.test',
    full: 'farm.owner+prod@example.test',
  });
  await page.screenshot({ path: shot('farm-usage-desktop.png'), fullPage: true });
  checks.push('农场用量：备注主显、邮箱脱敏 tooltip');

  await open('/farm/resources', '[data-testid="farm-resource-account-farm-container-01"]');
  await assertIdentity('farm-resource-account-farm-container-01', {
    note: '农场主力账号',
    masked: 'fa***@example.test',
    full: 'farm.owner+prod@example.test',
  });
  await page.screenshot({ path: shot('farm-resources-desktop.png'), fullPage: true });
  checks.push('农场资源：account_id join 当前备注/邮箱');

  await open('/farm', '[data-testid="farm-capacity-account-farm-main.json"]');
  await assertIdentity('farm-capacity-account-farm-main.json', {
    note: '农场主力账号',
    masked: 'fa***@example.test',
    full: 'farm.owner+prod@example.test',
  });
  await page.getByTestId('farm-standby-summary-disabled-toggle').click();
  await page.getByTestId('farm-standby-disabled-account-farm.owner+prod@example.test').waitFor();
  await page.screenshot({ path: shot('farm-dashboard-desktop.png'), fullPage: true });
  checks.push('农场总览：容量/待机账号备注优先且邮箱脱敏');

  await page.setViewportSize({ width: 390, height: 844 });
  await open('/auth-files', '[data-testid^="auth-file-card-"]');
  const hasPageOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1
  );
  assert.equal(hasPageOverflow, false, '移动端账号身份不应撑出页面横向滚动');
  await page.screenshot({ path: shot('auth-files-mobile.png'), fullPage: true });
  checks.push('移动端：账号长备注/邮箱不造成页面横向溢出');

  assert.equal(consoleErrors.length, 0, JSON.stringify(consoleErrors));
  assert.equal(networkFailures.length, 0, JSON.stringify(networkFailures));
  await fs.writeFile(
    path.join(out, 'result.json'),
    JSON.stringify({ passed: true, checks, consoleErrors, networkFailures }, null, 2)
  );
  console.log(JSON.stringify({ passed: true, checks, out }));
} catch (error) {
  await page.screenshot({ path: shot('failure.png'), fullPage: true }).catch(() => {});
  await fs.writeFile(
    path.join(out, 'result.json'),
    JSON.stringify(
      { passed: false, error: String(error), checks, consoleErrors, networkFailures },
      null,
      2
    )
  );
  throw error;
} finally {
  await fs.writeFile(
    path.join(out, 'console-network.json'),
    JSON.stringify({ consoleErrors, networkFailures }, null, 2)
  );
  await context.tracing.stop({ path: path.join(out, 'trace.zip') });
  await browser.close();
}
