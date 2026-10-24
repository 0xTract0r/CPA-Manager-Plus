/**
 * 重启/身份轮换前后的农场存活时间回归（当前 demo 构建 + 脱敏 API fixture）。
 * CPAMP_UI_BASE=http://127.0.0.1:4183 PLAYWRIGHT_MODULE=/path/to/playwright
 * node scripts/playwright-farm-lifetime.smoke.mjs
 * 产物：OUT_DIR 下截图、trace、console/network 与断言摘要；不连接生产。
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.CPAMP_UI_BASE || 'http://127.0.0.1:4183';
const out = path.resolve(process.env.OUT_DIR || 'build/farm-lifetime-smoke');
const fixedNow = new Date('2026-10-25T00:00:00Z');
const accounts = [
  { name: 'lifetime-one.json', days: 40, first_production_at: '2026-09-15T00:00:00Z' },
  { name: 'lifetime-two.json', days: 44, first_production_at: '2026-09-11T00:00:00Z' },
];
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const checks = [];
const errors = [];
const networkFailures = [];
let failure;
try {
  for (const width of [1440, 768, 390]) {
    const context = await browser.newContext({
      viewport: { width, height: 1000 },
      locale: 'zh-CN',
    });
    await context.addInitScript(() => {
      if (!['http:', 'https:'].includes(location.protocol)) return;
      localStorage.setItem(
        'cli-proxy-language',
        JSON.stringify({ state: { language: 'zh-CN' }, version: 0 })
      );
    });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    const page = await context.newPage();
    await page.clock.setFixedTime(fixedNow);
    page.on('pageerror', (e) => errors.push({ width, error: e.message }));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push({ width, error: message.text() });
    });
    page.on('requestfailed', (request) => {
      if (request.failure()?.errorText !== 'net::ERR_ABORTED')
        networkFailures.push({
          width,
          path: new URL(request.url()).pathname,
          error: request.failure()?.errorText,
        });
    });
    page.on('response', (response) => {
      if (response.status() >= 400)
        networkFailures.push({
          width,
          path: new URL(response.url()).pathname,
          status: response.status(),
        });
    });
    let mode = 'before';
    await page.route('**/api/farm/**', async (route) => {
      assert.equal(route.request().method(), 'GET', 'UI gate must not mutate farm state');
      const pathname = new URL(route.request().url()).pathname;
      let body = {};
      if (pathname.endsWith('/accounts')) {
        body =
          mode === 'empty'
            ? []
            : accounts.map(({ name, first_production_at }) => ({
                name,
                account: name.replace('.json', '@example.test'),
                note: name,
                provider: 'claude',
                status: 'active',
                disabled: false,
                auto_quarantined: false,
                farm_bound: true,
                farm_enrolled: true,
                farm_container_id: `c-${name}`,
                farm_container_status: 'running',
                farm_env: 'test',
                device_id_source: 'container_synced',
                account_registered_at: '2026-08-01T00:00:00Z',
                first_production_at,
                first_identity_at:
                  mode === 'before' ? '2026-09-10T00:00:00Z' : '2026-10-24T00:00:00Z',
                created_at: mode === 'before' ? '2026-09-10T00:00:00Z' : fixedNow.toISOString(),
                last_refresh: fixedNow.toISOString(),
              }));
      } else if (pathname.endsWith('/containers')) {
        body =
          mode === 'empty'
            ? []
            : accounts.map(({ name }) => ({
                id: `c-${name}`,
                status: 'running',
                health_reason: 'ok',
                account_auth_status: 'alive',
                telemetry_alive: 'alive',
                device_id_alignment: 'container_synced',
                created_at: '2026-09-10T00:00:00Z',
                updated_at: fixedNow.toISOString(),
                binding: {
                  env: 'test',
                  account: name.replace('.json', '@example.test'),
                  account_id: name,
                },
              }));
      } else if (pathname.endsWith('/account-state')) body = { accounts: [] };
      else if (pathname.endsWith('/alerts')) body = { items: [], total: 0 };
      else if (pathname.endsWith('/config')) body = { auto_provision_enabled: false };
      else if (pathname.endsWith('/usage')) body = { items: [] };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    });
    try {
      for (const nextMode of ['before', 'after', 'empty']) {
        mode = nextMode;
        await page.goto(`${base}/#/demo/farm/accounts`, { waitUntil: 'domcontentloaded' });
        if (mode !== 'empty') {
          for (const { name, days } of accounts) {
            const toggle = page.getByTestId(`farm-account-expand-${name}`);
            await toggle.waitFor({ state: 'visible' });
            await toggle.click();
            const alive = page.getByTestId(`farm-account-alive-${name}`);
            await alive.waitFor({ state: 'visible' });
            assert.match(await alive.innerText(), new RegExp(`^${days}(天|d)`));
          }
        } else {
          await page.waitForFunction(
            () =>
              document.body.innerText.includes('暂无') || document.body.innerText.includes('没有')
          );
          assert.equal(await page.locator('[data-testid^="farm-account-row-"]').count(), 0);
        }
        assert(
          !/0001-01-01|1\/1\/1/.test(await page.locator('body').innerText()),
          'Go zero time rendered'
        );
        assert(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
          'Page overflows viewport'
        );
        await page.screenshot({ path: path.join(out, `${width}-${mode}.png`), fullPage: true });
        checks.push({ width, mode, pass: true });
        await page.goto('about:blank');
      }
    } finally {
      await context.tracing.stop({ path: path.join(out, `${width}-trace.zip`) });
      await context.close();
    }
  }
  assert.deepEqual(errors, [], 'Browser console errors');
  assert.deepEqual(networkFailures, [], 'Network failures');
} catch (error) {
  failure = error;
} finally {
  await browser.close();
  await fs.writeFile(
    path.join(out, 'result.json'),
    JSON.stringify({ pass: !failure, checks, error: failure?.message }, null, 2)
  );
  await fs.writeFile(
    path.join(out, 'console-network.json'),
    JSON.stringify({ errors, networkFailures }, null, 2)
  );
}
if (failure) throw failure;
console.log(`PASS ${checks.length} cases; artifacts: ${out}`);
