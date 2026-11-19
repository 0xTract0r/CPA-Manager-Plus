/**
 * Loopback scheduling-demo account contract gate; defaults to all 15 fixture accounts.
 * CPAMP_UI_BASE=http://127.0.0.1:4187 OUT_DIR=<artifacts> PLAYWRIGHT_MODULE=/path/to/playwright node scripts/playwright-scheduling-demo-accounts.smoke.mjs
 * CPAMP_UI_CASES may select explicit diagnostic cases; report.full_matrix records partial runs.
 * CPAMP_EXPECTED_HTML_SHA256 optionally validates a packaged asset digest.
 * No source/API imports or response alteration; only APUS-01 and AC-13 may be saved once.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url),
  { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const out = path.resolve(process.env.OUT_DIR || '.tmp-scheduling-demo-accounts/latest');
await fs.mkdir(out, { recursive: true, mode: 0o700 });
const base = (process.env.CPAMP_UI_BASE || 'http://127.0.0.1:4187').replace(/\/$/, '');
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname), 'Loopback only');
assert.equal(new URL(base).origin, base, 'Use a bare loopback origin');
const expectedSha = process.env.CPAMP_EXPECTED_HTML_SHA256;
const allCases = [
  ['local-account-1', 'APUS-01'],
  ['local-account-2', 'APUS-03'],
  ['local-account-3', 'AC-13'],
  ['local-account-4', 'AC-16'],
  ['local-simulation', 'simulation'],
  ['local-queue', 'queue'],
  ['local-temporary', 'temporary'],
  ['local-empty', 'empty'],
  ...['low', 'medium', 'high', 'extreme'].map((x) => ['local-speed-' + x, 'speed-' + x]),
  ['local-no-anchor', 'no-anchor'],
  ['local-custom-period', 'custom-period'],
  ['local-manual-mature', 'manual-mature'],
];
const selected = process.env.CPAMP_UI_CASES?.split(',');
const cases = selected
  ? allCases.filter(([id, alias]) => selected.includes(id) || selected.includes(alias))
  : allCases;
assert(cases.length > 0, 'At least one known case required');
if (selected)
  assert(
    selected.every((x) => allCases.some(([id, alias]) => x === id || x === alias)),
    'Unknown case'
  );
const results = [],
  saveActions = [],
  consoleErrors = [],
  networkFailures = [],
  blocked = [],
  requests = [];
let browser, context, page, error, htmlSha;
const ready = () =>
  page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="account-scheduling-editor"]')
        ?.getAttribute('data-preview-ready') === 'true'
  );
const parseCard = (text) => {
  const n = (re) => {
    const m = text.match(re);
    assert(m, 'Numeric fixture card metric missing: ' + text);
    return Number(m[1].replaceAll(',', ''));
  };
  return {
    rpm: n(/([\d,]+)\s*次\/分钟/),
    concurrency: n(/并发\s*([\d,]+)/),
    daily: n(/每日\s*([\d,]+)\s*次/),
  };
};
const cards = async () => {
  const x = [];
  for (const id of ['low', 'medium', 'high', 'extreme']) {
    const input = page.getByTestId('speed-profile-' + id);
    assert(await input.isVisible());
    assert(await input.isEnabled());
    const label = page.locator('label').filter({ has: input });
    x.push({
      id,
      checked: await input.isChecked(),
      text: await label.innerText(),
      metrics: parseCard(await label.innerText()),
    });
  }
  return x;
};
async function open(id) {
  const search = page.getByRole('textbox', { name: '搜索凭证', exact: true });
  await search.fill(id);
  await page.getByTestId('auth-file-account-settings-' + id + '.json').click();
  await page.getByTestId('account-settings-open-limits').waitFor();
  await page.waitForFunction(() => document.querySelectorAll('[role="dialog"]').length === 1);
  await page.getByTestId('account-settings-open-limits').click();
  await page.getByTestId('account-scheduling-editor').waitFor();
  await page.waitForFunction(() => document.querySelectorAll('[role="dialog"]').length === 1);
  assert.equal(
    await page.getByTestId('account-limits-editor').getAttribute('data-account-name'),
    id + '.json'
  );
}
async function close() {
  await page.locator('.modal-close-floating').click();
  const confirm = page.getByRole('button', { name: '放弃并返回', exact: true });
  if (await confirm.count()) await confirm.click();
  await page.waitForFunction(() => document.querySelectorAll('[role="dialog"]').length === 0);
}
async function save(id, kind) {
  await page.waitForFunction(
    () => document.querySelector('[data-testid="apply-account-limits"]')?.disabled === false
  );
  saveActions.push({ id, kind, clicks: 1 });
  await page.getByTestId('apply-account-limits').click();
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="apply-account-limits"]')?.textContent?.includes('已保存')
  );
  await ready();
  assert(await page.getByTestId('apply-account-limits').isDisabled());
}
const shot = (name) => page.getByRole('dialog').screenshot({ path: path.join(out, name + '.png') });
try {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: 'zh-CN',
    serviceWorkers: 'block',
  });
  await context.addInitScript(() =>
    localStorage.setItem(
      'cli-proxy-language',
      JSON.stringify({ state: { language: 'zh-CN' }, version: 0 })
    )
  );
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(e.message));
  page.on('requestfailed', (r) => {
    if (r.failure()?.errorText !== 'net::ERR_ABORTED')
      networkFailures.push({ path: new URL(r.url()).pathname, error: r.failure()?.errorText });
  });
  page.on('response', (r) => {
    const x = { method: r.request().method(), path: new URL(r.url()).pathname, status: r.status() };
    requests.push(x);
    if (r.status() >= 400) networkFailures.push(x);
  });
  await context.route('**/*', (route) => {
    const r = route.request(),
      u = new URL(r.url());
    if (
      u.origin !== base ||
      r.method() !== 'GET' ||
      /^\/(?:v[01]|api|usage-service)(?:\/|$)/.test(u.pathname)
    ) {
      blocked.push({ origin: u.origin, path: u.pathname, method: r.method() });
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  const html = await page.goto(base + '/?pacing-feedback=1#/demo/auth-files', {
    waitUntil: 'domcontentloaded',
  });
  assert.equal(html.status(), 200);
  htmlSha = createHash('sha256')
    .update(await html.body())
    .digest('hex');
  if (expectedSha) assert.equal(htmlSha, expectedSha);
  await page.getByRole('textbox', { name: '搜索凭证', exact: true }).waitFor();
  for (const [id, alias] of cases) {
    let caseError,
      r = { id, alias };
    try {
      await open(id);
      const editor = page.getByTestId('account-scheduling-editor');
      assert.equal(
        await editor.getByText('当前服务端未提供调度预览，请升级后调整。', { exact: true }).count(),
        0,
        'No incomplete fixture contract allowed'
      );
      await ready();
      assert.equal(
        await editor.getByText('当前服务端未提供调度预览，请升级后调整。', { exact: true }).count(),
        0
      );
      assert(await page.getByTestId('warmup-mode-auto').isEnabled());
      assert(await page.getByTestId('warmup-mode-mature').isEnabled());
      assert(await page.getByTestId('editor-source-preset').isEnabled());
      assert(await page.getByTestId('editor-source-custom').isEnabled());
      const saved = await page.getByTestId('editor-current-saved').innerText(),
        recovery = await page.getByTestId('account-pacing-recovery').innerText(),
        mature = /成熟/.test(saved);
      r = {
        ...r,
        exactIdentity: true,
        previewReady: true,
        currentSaved: saved,
        recovery,
        mature,
        unsupported: false,
        enabledInputs: await editor
          .locator('input,select')
          .evaluateAll((es) => es.filter((e) => !e.matches(':disabled')).length),
      };
      r.defaultSource = (await page.getByTestId('editor-source-custom').isChecked())
        ? 'custom'
        : 'preset';
      if (!mature) {
        if (r.defaultSource === 'custom') {
          assert(await page.getByTestId('editor-custom-fields').isVisible());
          r.defaultCustomModes = {};
          for (const field of ['rpm', 'concurrency', 'request_capacity', 'max_active_bindings'])
            r.defaultCustomModes[field] = await page
              .getByTestId('editor-limit-mode-' + field)
              .inputValue();
          await page.getByTestId('editor-source-preset').check();
          await page.getByTestId('speed-profile-medium').check();
          await ready();
          r.cards = await cards();
          r.cardsContext = 'preset draft preview from default custom; no save';
          assert.equal(await page.getByTestId('editor-current-saved').innerText(), saved);
          await shot(alias + '-preset-preview');
          await page.getByRole('button', { name: '撤销更改', exact: true }).click();
          await ready();
          assert(await page.getByTestId('editor-source-custom').isChecked());
          assert.equal(await page.getByTestId('editor-current-saved').innerText(), saved);
        } else {
          r.cards = await cards();
          r.cardsContext = 'default preset';
        }
        assert.equal(r.cards.length, 4);
      } else {
        assert.equal(
          await page.getByTestId('speed-profile-picker').count(),
          0,
          'Mature policy must not invent four warmup speed cards'
        );
        r.cards = [];
      }
      const days = page.getByTestId('warmup-mode-days');
      if (await days.isVisible()) assert(await days.isEnabled());
      else {
        assert(await page.getByTestId('warmup-mode-mature').isChecked());
        await page.getByTestId('warmup-mode-auto').check();
        await ready();
        assert(await days.isVisible());
        assert(await days.isEnabled());
        await page.getByRole('button', { name: '撤销更改', exact: true }).click();
        await ready();
      }
      r.periodText = await editor.innerText();
      assert(!/候选周期\s*[—–]\s*天/.test(r.periodText), 'Effective fixture period must be known');
      assert(await page.getByTestId('apply-account-limits').isDisabled());
      await shot(alias + '-entry');
      if (alias === 'APUS-01') {
        assert.match(saved, /135\s*次\/分钟/);
        assert.match(saved, /并发\s*12/);
        assert.match(recovery, /重新授权|重新认证/);
        assert(mature);
        const wasManual = await page.getByTestId('warmup-mode-mature').isChecked();
        await page.getByTestId(wasManual ? 'warmup-mode-auto' : 'warmup-mode-mature').check();
        await save(id, 'lifecycle-only');
        const after = await page.getByTestId('editor-current-saved').innerText();
        assert.match(after, /135\s*次\/分钟/);
        assert.match(after, /并发\s*12/);
        assert.match(after, /成熟/);
        assert.match(
          await page.getByTestId('account-pacing-recovery').innerText(),
          /重新授权|重新认证/
        );
        r.savedLifecycle = {
          from: wasManual ? 'mature' : 'auto',
          to: wasManual ? 'auto' : 'mature',
          after,
          recovery: await page.getByTestId('account-pacing-recovery').innerText(),
        };
        await shot('APUS-01-lifecycle-saved');
        await close();
        await open(id);
        await ready();
        assert.match(await page.getByTestId('editor-current-saved').innerText(), /135\s*次\/分钟/);
        assert.match(await page.getByTestId('editor-current-saved').innerText(), /并发\s*12/);
        assert.equal(await page.getByTestId('warmup-mode-mature').isChecked(), !wasManual);
      }
      if (alias === 'APUS-03') {
        assert.match(recovery, /已停用/);
        r.disabledPreserved = true;
        assert(await page.getByTestId('warmup-mode-auto').isEnabled());
      }
      if (alias === 'AC-13') {
        const expected = r.cards.find((c) => c.id === 'high').metrics;
        await page.getByTestId('speed-profile-high').check();
        await save(id, 'high-profile');
        const after = await page.getByTestId('editor-current-saved').innerText();
        assert.match(after, new RegExp(expected.rpm + '\\s*次\\/分钟'));
        assert.match(after, new RegExp('并发\\s*' + expected.concurrency));
        assert(await page.getByTestId('speed-profile-high').isChecked());
        const high = page.locator('label').filter({ has: page.getByTestId('speed-profile-high') });
        assert.deepEqual(parseCard(await high.innerText()), expected);
        r.savedHigh = { expected, after };
        await shot('AC-13-high-saved');
        await close();
        await open(id);
        await ready();
        assert(await page.getByTestId('speed-profile-high').isChecked());
        assert.deepEqual(
          parseCard(
            await page
              .locator('label')
              .filter({ has: page.getByTestId('speed-profile-high') })
              .innerText()
          ),
          expected
        );
      }
      assert.equal(await page.getByTestId('apply-account-limits').count(), 1);
      r.status = 'PASS';
    } catch (e) {
      caseError = e;
      r.status = 'FAIL';
      r.error = String(e.stack || e);
      await shot(alias + '-failure').catch(() => {});
    } finally {
      results.push(r);
      if (await page.getByRole('dialog').count())
        await close().catch((e) => {
          caseError ??= e;
        });
    }
    if (caseError) console.log(JSON.stringify({ case: alias, status: 'FAIL', error: r.error }));
  }
  assert.equal(results.length, cases.length);
  assert(
    results.every((r) => r.status === 'PASS'),
    'Every selected default and synthetic account must pass'
  );
  const expectedSaves = cases
    .filter(([, alias]) => ['APUS-01', 'AC-13'].includes(alias))
    .map(([id]) => id)
    .sort();
  assert.equal(saveActions.length, expectedSaves.length);
  assert.deepEqual(saveActions.map((x) => x.id).sort(), expectedSaves);
  assert.equal(consoleErrors.length, 0);
  assert.equal(networkFailures.length, 0);
  assert.equal(blocked.length, 0);
} catch (e) {
  error = e;
} finally {
  await context?.tracing.stop({ path: path.join(out, 'accounts-trace.zip') }).catch(() => {});
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  const report = {
    schema_version: 1,
    agent: 'ui-test-runner',
    status: error || results.some((r) => r.status === 'FAIL') ? 'FAIL' : 'PASS',
    target: base + '/?pacing-feedback=1#/demo/auth-files',
    html_sha256: htmlSha,
    full_matrix: cases.length === allCases.length,
    executed_cases: cases.map(([, alias]) => alias),
    results,
    saveActions,
    error: error ? String(error.stack || error) : undefined,
    consoleErrors,
    networkFailures,
    blocked,
    requests,
    browser_closed: true,
    real_backend_requests: 0,
    model_requests: 0,
    production_requests: 0,
    coverage_gaps: [
      'Packaged demo with labelled fixtures; no real backend/provider behavior asserted',
      'No source import/API spy/response injection',
      'All accounts checked readonly except one lifecycle save on APUS-01 and one high-profile save on AC-13',
    ],
  };
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
  await fs.writeFile(
    path.join(out, 'console-network.json'),
    JSON.stringify({ consoleErrors, networkFailures, blocked, requests }, null, 2),
    { mode: 0o600 }
  );
  console.log(
    JSON.stringify({
      status: report.status,
      checked: results.length,
      results: results.map((r) => ({
        alias: r.alias,
        status: r.status,
        previewReady: r.previewReady,
        cards: r.cards?.length,
        currentSaved: r.currentSaved,
        savedLifecycle: r.savedLifecycle,
        savedHigh: r.savedHigh,
      })),
      saveActions,
      error: report.error,
      consoleErrors: consoleErrors.length,
      networkFailures: networkFailures.length,
      blocked: blocked.length,
      browser_closed: true,
      out,
    })
  );
  if (report.status === 'FAIL') process.exitCode = 1;
}
