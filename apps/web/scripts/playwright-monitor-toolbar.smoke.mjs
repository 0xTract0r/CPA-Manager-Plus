/**
 * 请求监控自适应同排/换行回归，需先启动管理页面。
 * CPAMP_UI_BASE=http://127.0.0.1:4178 PLAYWRIGHT_MODULE=/path/to/playwright \
 *   node scripts/playwright-monitor-toolbar.smoke.mjs
 *
 * 默认mock覆盖开关组合；preview直接检查人类本地预览（不拦截API/注入存储）；live只读实服。
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
assert(
  ['mock', 'preview', 'live'].includes(mode),
  'CPAMP_TOOLBAR_MODE must be mock, preview or live'
);
if (mode !== 'live') {
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
if (mode !== 'preview')
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
    : [{ logging: mode === 'preview' ? true : null, catchup: mode === 'preview' ? true : null }];
const widths =
  mode === 'preview'
    ? [1920, 1366, 390]
    : [
        2560, 1920, 1600, 1499, 1498, 1440, 1366, 1343, 1342, 1280, 1220, 1218, 1180, 1100, 1064,
        1062, 1024, 911, 768, 390,
      ];

try {
  if (mode === 'preview') {
    const configResponse = await context.request.get(`${origin}/v0/management/config`);
    const catchupResponse = await context.request.get(
      `${origin}/v0/management/usage/catchup-status`
    );
    assert.equal(configResponse.status(), 200);
    assert.equal(catchupResponse.status(), 200);
    const config = await configResponse.json();
    const catchup = await catchupResponse.json();
    assert.equal(config['logging-to-file'], true, 'Direct preview must provide logging config');
    assert.equal(catchup.found, true, 'Direct preview must provide catchup data');
    assert.equal(catchup.status?.lastStatus, 'ok');
    assert(Number.isFinite(catchup.status?.lastRunAtMs));
    assert(Number.isFinite(catchup.status?.lastAdded));
    report.defaultPreview = {
      loggingToFile: config['logging-to-file'],
      found: catchup.found,
      lastRunAtMs: catchup.status.lastRunAtMs,
      lastStatus: catchup.status.lastStatus,
      lastAdded: catchup.status.lastAdded,
    };
  }
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
  if (mode === 'preview') {
    await bar().getByRole('link', { name: '打开日志查看', exact: true }).waitFor();
    await page.waitForFunction(() => {
      const status = document.querySelector('[data-testid="monitoring-toolbar-status"]');
      return status?.textContent.includes('自动补齐：') && !status.textContent.includes('--');
    });
    const catchupLabel = bar()
      .locator('span')
      .filter({ hasText: /^自动补齐：/ })
      .last();
    assert(
      (await catchupLabel.innerText())
        .replace(/\s+/g, '')
        .includes(`补${report.defaultPreview.lastAdded}条`)
    );
  }
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
          toolbar.textContent.includes('自动补齐：') === catchup &&
          !document
            .querySelector('[data-testid="monitoring-toolbar-status"]')
            ?.textContent.includes('--')
        );
      }, item);
    }
    await page.evaluate(() => document.fonts.ready);
    for (const collapsed of [false, true]) {
      await page.setViewportSize({ width: 1600, height: 1000 });
      // MainLayout 的状态类在布局根上，依据最终 DOM 状态决定是否切换，避免依赖存储键名。
      const isCollapsed = (await page.locator('.sidebar-is-collapsed').count()) > 0;
      if (Boolean(isCollapsed) !== collapsed) {
        await page.locator('.hamburger-container').click();
        await page.waitForTimeout(350);
      }
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
          const group = el.querySelector('[data-testid="monitoring-toolbar-actions"]');
          const meta = el.querySelector('[data-testid="monitoring-toolbar-status"]');
          const logs = el.querySelector('[data-testid="monitoring-toolbar-logs"]');
          if (!group || !meta) throw new Error('Toolbar action/status layer missing');
          const firstAction = group.querySelector('button');
          const badge = [...meta.querySelectorAll('span')].find((node) =>
            /^(已连接|连接中|未连接|已断开)$/.test(node.textContent.trim())
          );
          if (!badge || !firstAction) throw new Error('Toolbar status or first action missing');
          const price = [...group.querySelectorAll('a')].find(
            (node) => node.textContent.trim() === '价格'
          );
          const bounds = rect(el);
          const itemRects = (nodes) => [...nodes].map(rect).filter((box) => box.width > 0);
          const actionItems = itemRects(group.querySelectorAll('button, a'));
          const statusNodes = [...meta.querySelectorAll('div[class*="statusMeta"] > span')];
          const statusItems = itemRects(statusNodes);
          const rowCount = (items) => {
            const rows = [];
            for (const item of items) {
              if (!rows.some((y) => Math.abs(y - item.y) <= 2)) rows.push(item.y);
            }
            return rows.length;
          };
          const css = getComputedStyle(el);
          const innerWidth =
            bounds.width -
            parseFloat(css.paddingLeft) -
            parseFloat(css.paddingRight) -
            parseFloat(css.borderLeftWidth) -
            parseFloat(css.borderRightWidth);
          const innerLeft =
            bounds.x + parseFloat(css.paddingLeft) + parseFloat(css.borderLeftWidth);
          const columnGap = parseFloat(getComputedStyle(meta).columnGap);
          const actionColumnGap = parseFloat(getComputedStyle(group).columnGap);
          const actionSingleRowWidth =
            actionItems.reduce((sum, item) => sum + item.width, 0) +
            Math.max(0, actionItems.length - 1) * actionColumnGap;
          const statusSingleRowWidth =
            statusItems.reduce((sum, item) => sum + item.width, 0) +
            Math.max(0, statusItems.length - 1) * columnGap;
          const metaSingleRowWidth =
            statusSingleRowWidth + (logs ? rect(logs).width + columnGap : 0);
          const neededSingleRowWidth =
            actionSingleRowWidth + metaSingleRowWidth + parseFloat(css.columnGap);
          const ordinaryStatusNodes = statusNodes.filter((node) => !node.contains(badge));
          const failure = statusNodes.find((node) => node.className.includes('statusMetaWarn'));
          const catchup = statusNodes.find((node) =>
            node.className.includes('usageCatchUpToneGood')
          );
          const toneHighlighted = (node, channel) => {
            if (!node) return null;
            const style = getComputedStyle(node);
            const channels = style.color.match(/[\d.]+/g)?.map(Number);
            return (
              style.backgroundColor !== 'rgba(0, 0, 0, 0)' &&
              channels &&
              channels[channel] > channels[1 - channel] &&
              channels[channel] > channels[2]
            );
          };
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
            logs: logs ? rect(logs) : null,
            firstAction: rect(firstAction),
            badge: rect(badge),
            price: price ? rect(price) : null,
            toolbar: bounds,
            innerWidth,
            innerLeft,
            actionSingleRowWidth,
            metaSingleRowWidth,
            neededSingleRowWidth,
            sameRow: Math.abs(rect(group).y - rect(meta).y) <= 2,
            rowGap: parseFloat(css.rowGap),
            firstStatusX: statusItems[0]?.x,
            statusPillsVisible: ordinaryStatusNodes.every(
              (node) =>
                getComputedStyle(node).backgroundColor !== 'rgba(0, 0, 0, 0)' &&
                parseFloat(getComputedStyle(node).paddingLeft) >= 8
            ),
            originalStatusWeight: ordinaryStatusNodes.every(
              (node) => Number(getComputedStyle(node).fontWeight) >= 600
            ),
            failureHighlighted: toneHighlighted(failure, 0),
            catchupHighlighted: toneHighlighted(catchup, 1),
            actionRows: rowCount(actionItems),
            statusRows: rowCount(statusItems),
            statusSingleRowWidth,
            compactViewport: el.parentElement.getBoundingClientRect().width <= 768,
            childrenOverflow,
            pageOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
          };
        });
        const detail = { width, collapsed, ...item, ...geometry };
        report.cases.push(detail);
        assert(
          Math.abs(geometry.group.x - geometry.innerLeft) <= 2,
          `Actions must start at the left edge: ${JSON.stringify(detail)}`
        );
        if (geometry.neededSingleRowWidth <= geometry.innerWidth - 2) {
          assert(
            geometry.sameRow,
            `All controls fit but toolbar is still split: ${JSON.stringify(detail)}`
          );
        } else if (geometry.neededSingleRowWidth > geometry.innerWidth + 2) {
          assert(
            !geometry.sameRow,
            `Insufficient room must move the status group: ${JSON.stringify(detail)}`
          );
        }
        if (geometry.sameRow) {
          assert.equal(
            geometry.actionRows,
            1,
            `Wide actions must use one row: ${JSON.stringify(detail)}`
          );
          assert.equal(
            geometry.statusRows,
            1,
            `Wide status must use one row: ${JSON.stringify(detail)}`
          );
          assert(
            Math.abs(geometry.firstAction.cy - geometry.badge.cy) <= 2,
            `Wide toolbar items must align vertically: ${JSON.stringify(detail)}`
          );
          assert(
            geometry.group.x + geometry.group.width <= geometry.meta.x - 6,
            `Wide groups must not overlap: ${JSON.stringify(detail)}`
          );
        } else {
          assert(
            Math.abs(geometry.meta.x - geometry.innerLeft) <= 2 &&
              Math.abs(geometry.firstStatusX - geometry.innerLeft) <= 2,
            `Wrapped status must start at the left edge: ${JSON.stringify(detail)}`
          );
          assert(
            Math.abs(geometry.meta.y - geometry.group.bottom - geometry.rowGap) <= 2,
            `Wrapped status must follow actions without extra empty rows: ${JSON.stringify(detail)}`
          );
        }
        assert(
          geometry.statusPillsVisible && geometry.originalStatusWeight,
          `Status must keep the original pills and weight: ${JSON.stringify(detail)}`
        );
        assert(
          geometry.failureHighlighted !== false,
          `Failure highlight missing: ${JSON.stringify(detail)}`
        );
        if (item.catchup === true)
          assert.equal(
            geometry.catchupHighlighted,
            true,
            `Catchup highlight missing: ${JSON.stringify(detail)}`
          );
        if (item.logging !== null) assert.equal(Boolean(geometry.logs), item.logging);
        if (geometry.metaSingleRowWidth <= geometry.innerWidth - 2) {
          assert.equal(
            geometry.statusRows,
            1,
            `Status group fits a full row but wraps prematurely: ${JSON.stringify(detail)}`
          );
          if (geometry.logs)
            assert(
              Math.abs(geometry.logs.cy - geometry.badge.cy) <= 2,
              `Logs must stay with status when the group fits: ${JSON.stringify(detail)}`
            );
        }
        assert(
          !geometry.childrenOverflow && !geometry.pageOverflow,
          `Toolbar overflow: ${JSON.stringify(detail)}`
        );
        if ([2560, 1920, 1366, 911, 390].includes(width))
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
