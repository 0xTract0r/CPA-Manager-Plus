/**
 * 请求监控顶部首行对齐回归，需先启动管理页面。
 * CPAMP_UI_BASE=http://127.0.0.1:4178 PLAYWRIGHT_MODULE=/path/to/playwright \
 *   node scripts/playwright-monitor-toolbar.smoke.mjs
 *
 * 默认本地模式补入日志开关和自动补齐状态的组合；CPAMP_TOOLBAR_MODE=live 则只读真实接口。
 * 实例需要登录时从 CPA_MANAGER_ADMIN_KEY 读取密钥，密钥不会写入报告。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

process.umask(0o077);
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = (process.env.CPAMP_UI_BASE || 'http://127.0.0.1:4178').replace(/\/$/, '');
const mode = process.env.CPAMP_TOOLBAR_MODE || 'mock';
assert(['mock', 'live'].includes(mode), 'CPAMP_TOOLBAR_MODE must be mock or live');
if (mode === 'mock') {
  assert(
    ['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname),
    'Mock mode is local only'
  );
}
const out = path.resolve(process.env.OUT_DIR || 'build/monitor-toolbar-smoke');
await fs.mkdir(out, { recursive: true, mode: 0o700 });
const key = process.env.CPA_MANAGER_ADMIN_KEY || '';
const safeMessage = (value) => {
  const message = String(value);
  return (key ? message.replaceAll(key, '[redacted]') : message).replace(
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
    '[email]'
  );
};
const report = { mode, base: origin, cases: [], console: [], network: [], passed: false };
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_EXECUTABLE,
});
const context = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
});
await context.addInitScript(() => {
  localStorage.setItem(
    'cli-proxy-theme',
    JSON.stringify({ state: { theme: 'wool', resolvedTheme: 'light' }, version: 0 })
  );
  localStorage.setItem('cli-proxy-language', 'zh-CN');
});
let scenario = { logging: true, catchup: true };
if (mode === 'mock') {
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== new URL(origin).origin) {
      // 本地布局测试不依赖在线版本查询，也不读取外部或生产接口。
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    if (url.pathname === '/v0/management/usage/catchup-status') {
      return route.fulfill({
        json: {
          found: scenario.catchup,
          status: scenario.catchup
            ? {
                lastRunAtMs: Date.parse('2026-10-29T17:00:14Z'),
                lastAdded: 123456,
                lastStatus: 'ok',
                totalAdded: 123456,
                trigger: 'timer',
              }
            : null,
        },
      });
    }
    if (url.pathname === '/v0/management/config') {
      const response = await route.fetch();
      return route.fulfill({
        response,
        json: { ...(await response.json()), 'logging-to-file': scenario.logging },
      });
    }
    return route.continue();
  });
}
await context.tracing.start({ screenshots: true, snapshots: true });
const page = await context.newPage();
page.setDefaultTimeout(15000);
page.on('pageerror', (error) => report.console.push(safeMessage(error)));
page.on('console', (message) => {
  if (message.type() === 'error') report.console.push(safeMessage(message.text()));
});
page.on('requestfailed', (request) => {
  if (request.failure()?.errorText !== 'net::ERR_ABORTED')
    report.network.push({
      path: new URL(request.url()).pathname,
      error: request.failure()?.errorText,
    });
});
page.on('response', (response) => {
  if (response.status() >= 400)
    report.network.push({ path: new URL(response.url()).pathname, status: response.status() });
});
const layers = () => page.locator('.page-transition__layer[aria-hidden="false"]');
const bar = () =>
  layers()
    .locator('section')
    .filter({ has: page.getByRole('button', { name: '导出数据', exact: true }) })
    .first();
const scenarios =
  mode === 'mock'
    ? [
        { logging: true, catchup: true },
        { logging: true, catchup: false },
        { logging: false, catchup: true },
        { logging: false, catchup: false },
      ]
    : [{ logging: null, catchup: null }];
const widths = [
  1920, 1600, 1499, 1498, 1440, 1366, 1343, 1342, 1280, 1220, 1218, 1180, 1100, 1064, 1062, 1024,
  768, 390,
];

try {
  await page.goto(`${origin}/management.html#/`, { waitUntil: 'domcontentloaded' });
  if (key) {
    const password = page.locator('input[type="password"]').first();
    await password.waitFor({ state: 'visible' });
    await password.fill(key);
    await password.press('Enter');
  }
  await page.getByTestId('timezone-menu-toggle').waitFor({ state: 'visible', timeout: 30000 });
  await page.getByRole('link', { name: '请求监控', exact: true }).click();
  await bar().waitFor({ state: 'visible' });
  for (const item of scenarios) {
    scenario = item;
    if (mode === 'mock') {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await bar().waitFor({ state: 'visible' });
      await page.waitForFunction(({ logging, catchup }) => {
        const toolbar = document.querySelector('section[aria-label="操作"]');
        if (!toolbar) return false;
        return (
          toolbar.textContent.includes('打开日志查看') === logging &&
          toolbar.textContent.includes('自动补齐：') === catchup
        );
      }, item);
    }
    await page.evaluate(() => document.fonts.ready);
    for (const collapsed of [false, true]) {
      await page.setViewportSize({ width: 1600, height: 1000 });
      // MainLayout 的状态类在布局根上，依据最终 DOM 状态决定是否切换，避免依赖存储键名。
      const isCollapsed = (await page.locator('.sidebar-is-collapsed').count()) > 0;
      if (Boolean(isCollapsed) !== collapsed) await page.locator('.hamburger-container').click();
      for (const width of widths) {
        await page.setViewportSize({ width, height: 1000 });
        await page.waitForTimeout(100);
        const geometry = await bar().evaluate((el) => {
          const rect = (node) => {
            const box = node.getBoundingClientRect();
            return {
              x: box.x,
              y: box.y,
              width: box.width,
              height: box.height,
              cy: box.y + box.height / 2,
              bottom: box.bottom,
            };
          };
          const group = el.children[0];
          const meta = el.children[1];
          const firstAction = group.querySelector('button');
          const badge = [...meta.querySelectorAll('span')].find((node) =>
            /^(已连接|连接中|未连接|已断开)$/.test(node.textContent.trim())
          );
          if (!badge || !firstAction) throw new Error('Toolbar status or first action missing');
          const price = [...group.querySelectorAll('a')].find(
            (node) => node.textContent.trim() === '价格'
          );
          const bounds = rect(el);
          const childrenOverflow = [...el.querySelectorAll('button, a, span')].some((node) => {
            if (node.closest('[role="tooltip"]')) return false;
            const box = node.getBoundingClientRect();
            return (
              box.width > 0 && (box.left < bounds.x - 1 || box.right > bounds.x + bounds.width + 1)
            );
          });
          return {
            group: rect(group),
            meta: rect(meta),
            firstAction: rect(firstAction),
            badge: rect(badge),
            price: price ? rect(price) : null,
            columns: getComputedStyle(el).gridTemplateColumns.split(/\s+/).length,
            childrenOverflow,
            pageOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
          };
        });
        const detail = { width, collapsed, ...item, ...geometry };
        report.cases.push(detail);
        if (geometry.columns > 1) {
          assert(
            Math.abs(geometry.firstAction.cy - geometry.badge.cy) <= 2,
            `First row misaligned: ${JSON.stringify(detail)}`
          );
          if (geometry.price && Math.abs(geometry.price.cy - geometry.firstAction.cy) <= 2) {
            assert(
              Math.abs(geometry.price.cy - geometry.badge.cy) <= 2,
              `Price/status misaligned: ${JSON.stringify(detail)}`
            );
          }
        } else {
          assert(
            geometry.meta.y >= geometry.group.bottom - 1,
            `Stacked groups overlap: ${JSON.stringify(detail)}`
          );
        }
        assert(
          !geometry.childrenOverflow && !geometry.pageOverflow,
          `Toolbar overflow: ${JSON.stringify(detail)}`
        );
        if ([1366, 390].includes(width))
          await bar().screenshot({
            path: path.join(out, `${item.logging}-${item.catchup}-${collapsed}-${width}.png`),
          });
      }
    }
  }
  assert.deepEqual(report.console, []);
  assert.deepEqual(report.network, []);
  report.passed = true;
} catch (error) {
  report.error = safeMessage(error);
  await page.screenshot({
    path: path.join(out, 'failure.png'),
    mask: [page.locator('input[type="password"]'), page.locator('[data-email-visibility]')],
  });
  throw new Error(report.error);
} finally {
  await context.tracing.stop({ path: path.join(out, 'trace.zip') });
  await browser.close();
  await fs.writeFile(path.join(out, 'result.json'), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      passed: report.passed,
      cases: report.cases.length,
      console: report.console,
      network: report.network,
      error: report.error,
    })
  );
}
