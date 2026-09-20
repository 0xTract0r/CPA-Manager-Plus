/**
 * 隔离配速 UI gate。先 build:demo，preview:demo，再执行：
 * CPAMP_UI_BASE=http://127.0.0.1:4173 PLAYWRIGHT_MODULE=/path/to/playwright-core node scripts/playwright-warmup-pacing.smoke.mjs
 * 测试端正式构建：CPAMP_UI_MODE=live CPAMP_STORAGE_STATE=/private/test-session.json CPAMP_UI_BASE=http://test-host:18427
 * live 仅浏览器拦截 auth-files，禁止模型请求及管理写操作，不向后端写入 fixture。
 * trace 可能包含登录态请求头，OUT_DIR 必须作为私有验收产物保管。
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(
  await fs.readFile(path.join(root, '../src/features/demo/pacingFixtures.json'), 'utf8')
);
const base = (process.env.CPAMP_UI_BASE || 'http://127.0.0.1:4173').replace(/\/$/, '');
const live = process.env.CPAMP_UI_MODE === 'live';
assert(
  !live || process.env.CPAMP_STORAGE_STATE,
  'Live mode requires an isolated test storageState'
);
const out = path.resolve(
  process.env.OUT_DIR || path.join(root, '../../../.tmp-warmup-pacing-smoke')
);
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const checks = [];
const consoleErrors = [];
const networkFailures = [];
const blockedRequests = [];
let failed;
const translations = {};
for (const language of ['zh-CN', 'zh-TW', 'en', 'ru'])
  translations[language] = JSON.parse(
    await fs.readFile(path.join(root, `../src/i18n/locales/${language}.json`), 'utf8')
  );
const recordFailure = (request) => {
  const failure = request.failure()?.errorText;
  if (failure !== 'net::ERR_ABORTED')
    networkFailures.push({ path: new URL(request.url()).pathname, error: failure });
};
async function closeModal(page, entry) {
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.waitForFunction(
    (id) => document.activeElement?.getAttribute('data-testid') === id,
    await entry.getAttribute('data-testid')
  );
}
async function assertFits(locator, width) {
  const box = await locator.boundingBox();
  assert(box && box.x >= 0 && box.x + box.width <= width + 1, 'Element exceeds viewport');
  assert(
    await locator.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    'Horizontal overflow'
  );
}
try {
  for (const theme of ['wool', 'white', 'dark']) {
    for (const width of [1440, 390]) {
      const name = `${theme}-${width}`;
      const context = await browser.newContext({
        viewport: { width, height: 1000 },
        locale: 'zh-CN',
        ...(live ? { storageState: process.env.CPAMP_STORAGE_STATE } : {}),
      });
      await context.addInitScript(
        ({ theme }) => {
          localStorage.setItem('cli-proxy-theme', JSON.stringify({ state: { theme }, version: 0 }));
          localStorage.setItem(
            'cli-proxy-language',
            JSON.stringify({ state: { language: 'zh-CN' }, version: 0 })
          );
        },
        { theme }
      );
      await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      const page = await context.newPage();
      page.on('pageerror', (error) => consoleErrors.push({ case: name, message: error.message }));
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push({ case: name, message: message.text() });
      });
      page.on('requestfailed', recordFailure);
      page.on('response', (response) => {
        if (response.status() >= 400)
          networkFailures.push({
            path: new URL(response.url()).pathname,
            status: response.status(),
          });
      });
      await page.route('**/*', async (route) => {
        const req = route.request();
        const pathname = new URL(req.url()).pathname;
        if (
          /\/v1\/(messages|chat\/completions|responses)|\/test-message|\/api-call/.test(pathname) ||
          (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method()) &&
            /\/v0\/management\//.test(pathname))
        ) {
          blockedRequests.push({ path: pathname, method: req.method() });
          return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
        }
        if (live && /\/v0\/management\/auth-files\/?$/.test(pathname))
          return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(fixtures),
          });
        if (!live && /\/api\/farm\//.test(pathname))
          return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
        return route.continue();
      });
      try {
        await page.goto(
          `${base}/${live ? '#/auth-files' : '?pacing-fixtures=1#/demo/auth-files'}`,
          { waitUntil: 'domcontentloaded' }
        );
        const pro = page.getByTestId('auth-file-pacing-pacing-pro.json');
        await pro.waitFor({ state: 'visible', timeout: 45000 });
        if ((await page.locator('html').getAttribute('data-theme')) !== theme) {
          await page
            .getByRole('button', { name: translations['zh-CN'].theme.switch, exact: true })
            .click();
          await page
            .getByRole('menuitemradio', { name: translations['zh-CN'].theme[theme], exact: true })
            .click();
        }
        assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
        assert.equal(await page.getByTestId('auth-file-pacing-pacing-mature.json').count(), 0);
        assert.equal(
          await page.getByTestId('auth-file-pacing-pacing-max5.json').getAttribute('data-level'),
          'empty'
        );
        assert.equal(await pro.getAttribute('data-level'), 'low');
        assert.equal(
          await page.getByTestId('auth-file-pacing-pacing-max20.json').getAttribute('data-level'),
          'ready'
        );
        assert.equal(
          await page
            .getByTestId('auth-file-pacing-pacing-threshold.json')
            .getAttribute('data-level'),
          'ready'
        );
        assert.equal(
          await page.getByTestId('auth-file-tier-override-pacing-max20.json').count(),
          1
        );
        const row = page.getByTestId('auth-file-claude-tier-row-pacing-pro.json');
        await assertFits(row, width);
        for (const id of [
          'auth-file-tier-badge-pacing-pro.json',
          'auth-file-warmup-badge-pacing-pro.json',
          'auth-file-pacing-pacing-pro.json',
        ]) {
          const metrics = await page.getByTestId(id).evaluate((element) => {
            const style = getComputedStyle(element);
            return {
              height: element.getBoundingClientRect().height,
              font: style.fontSize,
              radius: style.borderRadius,
            };
          });
          assert.deepEqual(metrics, { height: 17, font: '10px', radius: '5px' });
        }
        const colors = [];
        for (const id of ['pro', 'max5', 'max20']) {
          const badge = page.getByTestId(`auth-file-tier-badge-pacing-${id}.json`);
          const icon = await badge.locator('svg').boundingBox();
          assert(icon && icon.width === 10 && icon.height === 10);
          colors.push(await badge.evaluate((element) => getComputedStyle(element).color));
        }
        assert.equal(new Set(colors).size, 3);
        await page.screenshot({ path: path.join(out, `${name}-list.png`), fullPage: true });
        await pro.click();
        const dialog = page.getByRole('dialog');
        await dialog.waitFor();
        await assertFits(dialog, width);
        assert.equal(await dialog.locator('[data-tier="pro"]').count(), 1);
        assert.match(await page.getByTestId('pacing-balance').innerText(), /2.55\s*\/ 8/);
        assert.match(await page.getByTestId('warmup-pacing-detail').innerText(), /尚未发送的预约/);
        const snapshotText = await dialog.innerText();
        await page.waitForTimeout(1050);
        assert.equal(
          await dialog.innerText(),
          snapshotText,
          'Snapshot must not imply a local countdown'
        );
        await page.keyboard.press('Tab');
        assert(
          await page
            .getByRole('button', { name: translations['zh-CN'].common.close, exact: true })
            .evaluate((element) => element === document.activeElement)
        );
        await page.screenshot({ path: path.join(out, `${name}-detail.png`), fullPage: false });
        await closeModal(page, pro);
        if (theme === 'wool') {
          for (const [scenario, expected] of [
            ['disabled', '已关闭'],
            ['unknown', '未知'],
            ['error', '读取失败'],
            ['uninitialized', '未初始化'],
          ]) {
            const entry = page.getByTestId(`auth-file-pacing-pacing-${scenario}.json`);
            assert.equal(await entry.getAttribute('data-level'), 'unknown');
            assert((await entry.innerText()).includes(expected));
            await entry.click();
            await dialog.waitFor();
            assert((await dialog.getByRole('status').innerText()).includes(expected));
            assert((await page.getByTestId('pacing-balance').innerText()).startsWith('—'));
            assert.equal(await dialog.getByRole('progressbar').count(), 0);
            await page.screenshot({
              path: path.join(out, `${name}-${scenario}.png`),
              fullPage: false,
            });
            await closeModal(page, entry);
          }
          const max = page.getByTestId('auth-file-pacing-pacing-max20.json');
          await max.click();
          await dialog.waitFor();
          assert.equal(await dialog.getByRole('progressbar').getAttribute('aria-valuemax'), '12');
          assert((await dialog.innerText()).includes('活跃独立会话组已达上限'));
          assert((await dialog.innerText()).includes('仍需检查其他限制'));
          await closeModal(page, max);
        }
        checks.push({ case: name, result: 'passed' });
      } finally {
        await context.tracing.stop({ path: path.join(out, `${name}-trace.zip`) });
        await context.close();
      }
    }
  }
  // 文案以真实页面渲染确认，不向部署端注入演示控制按钮。
  for (const language of ['zh-TW', 'en', 'ru']) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 1000 },
      ...(live ? { storageState: process.env.CPAMP_STORAGE_STATE } : {}),
    });
    await context.addInitScript((language) => {
      localStorage.setItem(
        'cli-proxy-language',
        JSON.stringify({ state: { language }, version: 0 })
      );
    }, language);
    const page = await context.newPage();
    page.on('pageerror', (error) => consoleErrors.push({ case: language, message: error.message }));
    page.on('console', (message) => {
      if (message.type() === 'error')
        consoleErrors.push({ case: language, message: message.text() });
    });
    page.on('requestfailed', recordFailure);
    page.on('response', (response) => {
      if (response.status() >= 400)
        networkFailures.push({ path: new URL(response.url()).pathname, status: response.status() });
    });
    await page.route('**/*', async (route) => {
      const req = route.request();
      const pathname = new URL(req.url()).pathname;
      if (
        /\/v1\/(messages|chat\/completions|responses)|\/test-message|\/api-call/.test(pathname) ||
        (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method()) &&
          /\/v0\/management\//.test(pathname))
      ) {
        blockedRequests.push({ path: pathname, method: req.method() });
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      }
      if (live && /\/v0\/management\/auth-files\/?$/.test(pathname))
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(fixtures),
        });
      if (!live && /\/api\/farm\//.test(pathname))
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      return route.continue();
    });
    await page.goto(`${base}/${live ? '#/auth-files' : '?pacing-fixtures=1#/demo/auth-files'}`);
    await page
      .getByTestId('auth-file-pacing-pacing-pro.json')
      .waitFor({ state: 'visible', timeout: 45000 });
    if (!live) {
      await page
        .getByRole('button', { name: translations['zh-CN'].language.switch, exact: true })
        .click();
      await page
        .getByRole('menuitemradio')
        .filter({ hasText: { 'zh-TW': '繁體中文', en: 'English', ru: 'Русский' }[language] })
        .click();
    }
    await page.getByTestId('auth-file-pacing-pacing-pro.json').click();
    await page.getByRole('dialog').waitFor();
    assert(
      (await page.getByRole('dialog').innerText()).includes(
        translations[language].auth_files.pacing.title
      )
    );
    assert(!(await page.getByRole('dialog').innerText()).includes('auth_files.pacing.'));
    await assertFits(page.getByRole('dialog'), 390);
    await page.screenshot({ path: path.join(out, `${language}-390.png`), fullPage: false });
    checks.push({ case: language, result: 'passed' });
    await context.close();
  }
  assert.equal(blockedRequests.length, 0, 'UI must not attempt model or management write requests');
  assert.equal(consoleErrors.length, 0, 'Console errors recorded');
  assert.equal(networkFailures.length, 0, 'Network failures recorded');
} catch (error) {
  failed = error;
} finally {
  await browser.close();
  await fs.writeFile(
    path.join(out, 'console-network.json'),
    JSON.stringify({ consoleErrors, networkFailures, blockedRequests }, null, 2)
  );
  await fs.writeFile(
    path.join(out, 'result.json'),
    JSON.stringify(
      {
        mode: live ? 'live-page-browser-fixtures' : 'isolated-demo',
        checks,
        passed: !failed,
        error: failed?.message,
      },
      null,
      2
    )
  );
}
if (failed) throw failed;
console.log(JSON.stringify({ passed: true, checks: checks.length, out }));
