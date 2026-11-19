/**
 * Local dev:demo only. Records real UI actions and the existing demo API; no altered responses.
 * CPAMP_UI_BASE=http://127.0.0.1:4187 PLAYWRIGHT_MODULE=/path/to/playwright-core
 * CPAMP_UI_CASES=baseline,save,life,layout,save-failure,unsupported OUT_DIR=<evidence>
 * node scripts/playwright-scheduling-editor.smoke.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.CPAMP_UI_BASE || 'http://127.0.0.1:4187';
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname), 'Loopback demo only');
const out = path.resolve(process.env.OUT_DIR || '.tmp-scheduling-editor/latest');
await fs.mkdir(out, { recursive: true });
const selected = process.env.CPAMP_UI_CASES?.split(',');
const results = [],
  consoleErrors = [],
  networkFailures = [],
  blocked = [];
const browser = await chromium.launch({ headless: true });
async function run(name, fn, { width = 1440, theme = 'wool', scenario = '' } = {}) {
  if (selected && !selected.includes(name)) return;
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: 'zh-CN' });
  await context.addInitScript(() => {
    localStorage.setItem(
      'cli-proxy-language',
      JSON.stringify({ state: { language: 'zh-CN' }, version: 0 })
    );
  });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push({ case: name, message: m.text() });
  });
  page.on('pageerror', (e) => consoleErrors.push({ case: name, message: e.message }));
  page.on('requestfailed', (r) => {
    if (r.failure()?.errorText !== 'net::ERR_ABORTED')
      networkFailures.push({
        case: name,
        path: new URL(r.url()).pathname,
        error: r.failure()?.errorText,
      });
  });
  page.on('response', (r) => {
    if (r.status() >= 400)
      networkFailures.push({ case: name, path: new URL(r.url()).pathname, status: r.status() });
  });
  await context.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.origin !== new URL(base).origin || /^\/v[01]\//.test(u.pathname)) {
      blocked.push({ case: name, path: u.pathname, origin: u.origin });
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  let error;
  const at = Date.now();
  const shot = (suffix) => page.screenshot({ path: path.join(out, `${name}-${suffix}.png`) });
  const open = async (id = 'local-speed-low') => {
    await page.getByRole('textbox', { name: '搜索凭证', exact: true }).fill(id);
    await page.getByTestId(`auth-file-account-settings-${id}.json`).click();
    await page.getByTestId('account-settings-open-limits').waitFor();
    await page.waitForFunction(() => document.querySelectorAll('[role="dialog"]').length === 1);
    await page.getByTestId('account-settings-open-limits').click();
    await page.getByTestId('account-scheduling-editor').waitFor();
    await page.waitForFunction(() => document.querySelectorAll('[role="dialog"]').length === 1);
    assert.equal(
      await page.getByTestId('account-limits-editor').getAttribute('data-account-name'),
      `${id}.json`
    );
  };
  const ready = async () =>
    page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="account-scheduling-editor"]')
          ?.getAttribute('data-preview-ready') === 'true'
    );
  const canSave = () =>
    page.waitForFunction(
      () => document.querySelector('[data-testid="apply-account-limits"]')?.disabled === false
    );
  const save = async () => {
    await canSave();
    await page.getByTestId('apply-account-limits').click();
    await page.waitForFunction(() =>
      document
        .querySelector('[data-testid="apply-account-limits"]')
        ?.textContent?.includes('已保存')
    );
    assert(await page.getByTestId('apply-account-limits').isDisabled());
  };
  const audits = () =>
    page.evaluate(() => ({
      saves: window.__editorAudit.saves,
      previews: window.__editorAudit.previews,
    }));
  try {
    await page.goto(
      `${base}/?pacing-feedback=1${scenario ? '&pacing-scenario=' + scenario : ''}#/demo/auth-files`,
      { waitUntil: 'domcontentloaded' }
    );
    await page.getByRole('textbox', { name: '搜索凭证', exact: true }).waitFor();
    await page.evaluate(async (value) => {
      const { useThemeStore } = await import('/src/stores/useThemeStore.ts');
      useThemeStore.getState().setTheme(value);
    }, theme);
    await page.waitForFunction(
      (value) => document.documentElement.getAttribute('data-theme') === value,
      theme
    );
    await page.evaluate(async () => {
      // 保留Vite实际加载URL的查询参数，避免导入第二份API实例而漏记保存。
      const loaded = [...new Set(performance.getEntriesByType('resource')
        .map((entry) => entry.name)
        .filter((name) => new URL(name).pathname === '/src/services/api/authFiles.ts'))];
      if (loaded.length !== 1)
        throw new Error('Expected one actual loaded API module URL; found ' + loaded.length);
      const moduleUrl = loaded[0];
      const { authFilesApi: api } = await import(moduleUrl);
      const saves = [],
        previews = [];
      const save = api.updateAccountScheduling,
        preview = api.previewAccountScheduling;
      api.updateAccountScheduling = async (request) => {
        saves.push(structuredClone(request));
        return save(request);
      };
      api.previewAccountScheduling = async (request, signal) => {
        previews.push(structuredClone(request));
        return preview(request, signal);
      };
      window.__editorAudit = { api, saves, previews, moduleUrl };
    });
    await fn({ page, open, ready, canSave, save, audits, shot, width });
  } catch (e) {
    error = e;
    await shot('failure').catch(() => {});
  } finally {
    await context.tracing.stop({ path: path.join(out, name + '-trace.zip') });
    await context.close();
    results.push({
      case: name,
      passed: !error,
      error: error ? String(error.stack || error) : undefined,
      elapsed_ms: Date.now() - at,
    });
  }
}
try {
  await run('baseline', async ({ page, open, ready, audits, shot }) => {
    await open('local-account-3');
    await ready();
    assert(await page.getByTestId('editor-source-preset').isChecked());
    for (const id of ['low', 'medium', 'high', 'extreme'])
      assert(!(await page.getByTestId('speed-profile-' + id).isChecked()));
    assert.equal(await page.getByTestId('editor-custom-fields').count(), 0);
    assert.equal(await page.getByTestId('editor-change-preview').count(), 0);
    assert.equal((await audits()).saves.length, 0);
    const boxes = await Promise.all(
      ['low', 'medium', 'high', 'extreme'].map((id) =>
        page
          .getByTestId('speed-profile-' + id)
          .locator('..')
          .locator('..')
          .boundingBox()
      )
    );
    assert(
      boxes.every((b) => b && Math.abs(b.y - boxes[0].y) < 1),
      'Desktop shows all four speeds in one row'
    );
    const footer = await page.getByTestId('editor-save-footer').boundingBox();
    assert(
      boxes.every((b) => b.y + b.height <= footer.y),
      'All four desktop speeds are above the save footer'
    );
    await shot('default-legacy-auto');
  });
  await run('save', async ({ page, open, ready, save, audits, shot }) => {
    await open();
    await ready();
    assert.match(await page.getByTestId('speed-profile-picker').innerText(), /次\/分钟/);
    for (const card of await page.getByTestId('speed-profile-picker').locator('label').all())
      assert.match(await card.innerText(), /每日\s*[\d,]+\s*次/);
    assert.equal(await page.getByText('按使用场景调整', { exact: true }).count(), 0);
    await page.getByTestId('speed-profile-high').check();
    await save();
    let a = await audits();
    assert.equal(a.saves.length, 1);
    assert.equal(a.saves[0].speed_profile, 'high');
    for (const key of ['rate_scale', 'limit_overrides', 'temporary_limits'])
      assert(!(key in a.saves[0]));
    assert.equal(await page.getByText('已保存，仅对此账号生效。', { exact: true }).count(), 0);
    await ready();
    await shot('saved');
    await page.getByTestId('speed-profile-low').check();
    await canSaveLocal(page);
    assert.match(await page.getByTestId('apply-account-limits').innerText(), /保存更改/);
    await page.getByRole('button', { name: '撤销更改', exact: true }).click();
    assert(await page.getByTestId('speed-profile-high').isChecked());
    assert.equal((await audits()).saves.length, 1);
    await ready();
    await shot('reedit-discard');
  });
  await run('life', async ({ page, open, ready, save, shot }) => {
    await open();
    await ready();
    await page.getByTestId('warmup-mode-days').check();
    await page.getByTestId('warmup-period-days').fill('30');
    await canSaveLocal(page);
    await shot('period-preview');
    await page.getByTestId('warmup-mode-mature').check();
    await page.getByTestId('editor-mature-policy').waitFor();
    assert.equal(await page.getByTestId('speed-profile-low').count(), 0);
    await save();
    await page.getByTestId('editor-source-custom').check();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="editor-limit-mode-request_capacity"]')?.disabled ===
        true
    );
    assert(await page.getByTestId('editor-limit-mode-request_capacity').isDisabled());
    assert(!(await page.getByTestId('editor-limit-mode-rpm').isDisabled()));
    await shot('mature-custom');
  });
  await run(
    'layout',
    async ({ page, open, ready, shot, width }) => {
      await open();
      await ready();
      const editor = page.getByTestId('account-limits-editor');
      const box = await editor.boundingBox();
      assert(box && box.x >= 0 && box.x + box.width <= width);
      assert(await editor.evaluate((e) => e.scrollWidth <= e.clientWidth + 1));
      assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
      await page.getByTestId('speed-profile-extreme').scrollIntoViewIfNeeded();
      assert(await page.getByTestId('speed-profile-extreme').isVisible());
      await shot('390-dark');
      await page.getByTestId('editor-source-custom').check();
      await page.getByTestId('editor-custom-fields').waitFor();
      assert(await editor.evaluate((e) => e.scrollWidth <= e.clientWidth + 1));
      await page.getByTestId('apply-account-limits').scrollIntoViewIfNeeded();
      assert(await page.getByTestId('apply-account-limits').isVisible());
      await shot('390-custom');
    },
    { width: 390, theme: 'dark' }
  );
  await run(
    'save-failure',
    async ({ page, open, ready, canSave, audits, shot }) => {
      await open();
      await ready();
      await page.getByTestId('speed-profile-high').check();
      await canSave();
      await page.getByTestId('apply-account-limits').click();
      await page.getByRole('alert').filter({ hasText: '保存失败' }).waitFor();
      assert(await page.getByTestId('speed-profile-high').isChecked());
      assert.equal((await audits()).saves.length, 1);
      await shot('draft-retained');
    },
    { scenario: 'save-error' }
  );
  await run(
    'unsupported',
    async ({ page, open, audits, shot }) => {
      await open();
      await page.getByText('当前服务端未提供调度预览，请升级后调整。', { exact: true }).waitFor();
      assert(await page.getByTestId('apply-account-limits').isDisabled());
      assert.equal((await audits()).saves.length, 0);
      await shot('no-fabricated-preview');
    },
    { scenario: 'preview-unsupported' }
  );
} finally {
  await browser.close();
  const passed =
    results.every((r) => r.passed) &&
    !consoleErrors.length &&
    !networkFailures.length &&
    !blocked.length;
  const report = {
    schema_version: 1,
    target: base,
    passed,
    results,
    consoleErrors,
    networkFailures,
    blocked,
    browser_closed: true,
    coverage_gaps: [
      'Chromium only',
      'demo-only; real backend and production acceptance are separate',
      'Fault cases use explicitly labelled demo scenarios; API wrappers record without altering responses',
    ],
  };
  await fs.writeFile(path.join(out, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed, out, results }));
  if (!passed) process.exitCode = 1;
}
async function canSaveLocal(page) {
  await page.waitForFunction(
    () => document.querySelector('[data-testid="apply-account-limits"]')?.disabled === false
  );
}
