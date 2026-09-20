/**
 * 配速审查回归：同名账号身份 + 刷新 + 小数门槛 + 自动主题。
 * 只使用本地 build:demo/preview:demo。API fixture 走内存 handler，无真实账号或模型请求。
 * CPAMP_UI_BASE=http://127.0.0.1:4178 PLAYWRIGHT_MODULE=/path/to/playwright-core node apps/web/scripts/playwright-warmup-pacing-boundaries.smoke.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.dirname(fileURLToPath(import.meta.url));
const base = process.env.CPAMP_UI_BASE || 'http://127.0.0.1:4178';
assert(
  ['127.0.0.1', 'localhost'].includes(new URL(base).hostname),
  'Boundary smoke requires a local isolated demo'
);
const out = path.resolve(
  process.env.OUT_DIR || path.join(root, '../../../.tmp-warmup-pacing-boundaries')
);
const zh = JSON.parse(await fs.readFile(path.join(root, '../src/i18n/locales/zh-CN.json'), 'utf8'));
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  locale: 'zh-CN',
});
await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
const page = await context.newPage();
const consoleErrors = [],
  networkFailures = [],
  blockedRequests = [];
let failure;
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
page.on('pageerror', (error) => consoleErrors.push(error.message));
page.on('requestfailed', (request) => {
  if (request.failure()?.errorText !== 'net::ERR_ABORTED')
    networkFailures.push({
      path: new URL(request.url()).pathname,
      error: request.failure()?.errorText,
    });
});
page.on('response', (response) => {
  if (response.status() >= 400)
    networkFailures.push({ path: new URL(response.url()).pathname, status: response.status() });
});
await page.route('**/*', async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (
    url.origin !== new URL(base).origin ||
    /\/api\//.test(url.pathname) ||
    /\/v[01]\//.test(url.pathname)
  ) {
    blockedRequests.push({ path: url.pathname, method: request.method() });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  }
  return route.continue();
});
const entry = (index) =>
  page.locator(`[data-auth-file-key="${encodeURIComponent(`pacing-shared.json\0${index}`)}"]`);
try {
  await page.goto(`${base}/?pacing-fixtures=boundary#/demo/auth-files`, {
    waitUntil: 'domcontentloaded',
  });
  await entry('second').waitFor({ state: 'visible', timeout: 45000 });
  assert.equal(await page.getByTestId('auth-file-pacing-pacing-shared.json').count(), 2);
  assert.match(await entry('first').innerText(), /0\.99\/8/);
  assert.equal(await entry('first').getAttribute('data-level'), 'empty');
  assert.match(await entry('second').innerText(), /11\.99\/16/);
  assert.equal(await entry('second').getAttribute('data-level'), 'low');
  await page.screenshot({ path: path.join(out, 'same-name-boundaries-list.png') });
  await entry('second').click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  assert.match(await page.getByTestId('pacing-balance').innerText(), /11\.99\s*\/ 16/);
  assert.equal(await dialog.locator('[data-tier="max_20x"]').count(), 1);
  await page.screenshot({ path: path.join(out, 'second-account-11-99.png') });
  // 触发既有刷新处理器，验证打开的弹窗关联新列表的同一账号；不创建测试写接口。
  await page.evaluate(() => {
    const url = new URL(location.href);
    url.searchParams.set('pacing-revision', '2');
    history.replaceState(null, '', url);
  });
  await page
    .getByRole('button', { name: zh.header.refresh_all, exact: true })
    .evaluate((element) => element.click());
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="pacing-balance"]')?.textContent?.includes('2.01')
  );
  assert.match(await page.getByTestId('pacing-balance').innerText(), /2\.01\s*\/ 16/);
  assert.equal(await dialog.locator('[data-tier="max_20x"]').count(), 1);
  await page.screenshot({ path: path.join(out, 'second-account-refreshed-2-01.png') });
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  await entry('first').click();
  await dialog.waitFor();
  assert.match(await page.getByTestId('pacing-balance').innerText(), /0\.99\s*\/ 8/);
  assert.equal(await dialog.locator('[data-tier="pro"]').count(), 1);
  await page.screenshot({ path: path.join(out, 'first-account-0-99.png') });
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: zh.theme.switch, exact: true }).click();
  assert.equal(await page.getByRole('menuitemradio').count(), 4);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.getByRole('menuitemradio', { name: zh.theme.auto, exact: true }).click();
  await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'white');
  await entry('first').click();
  await dialog.waitFor();
  await page.screenshot({ path: path.join(out, 'auto-theme-light.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'dark');
  await page.screenshot({ path: path.join(out, 'auto-theme-dark.png') });
  assert.equal(consoleErrors.length, 0);
  assert.equal(networkFailures.length, 0);
  assert.equal(blockedRequests.length, 0, 'Demo should make no real API/model request');
} catch (error) {
  failure = error;
} finally {
  await context.tracing.stop({ path: path.join(out, 'trace.zip') });
  await browser.close();
  await fs.writeFile(
    path.join(out, 'console-network.json'),
    JSON.stringify({ consoleErrors, networkFailures, blockedRequests }, null, 2)
  );
  await fs.writeFile(
    path.join(out, 'result.json'),
    JSON.stringify(
      {
        passed: !failure,
        checks: [
          'same-name-second-account',
          'same-account-after-refresh',
          '0.999-displays-0.99',
          '11.999-displays-11.99',
          'auto-light-resolves-white',
          'auto-dark-resolves-dark',
        ],
        error: failure?.message,
      },
      null,
      2
    )
  );
}
if (failure) throw failure;
console.log(JSON.stringify({ passed: true, out }));
