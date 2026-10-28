// Cross-platform regression matrix. Real app/data; all scenarios record evidence.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
const p = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const name = process.env.AUDIT_BROWSER || 'chromium';
const type = name === 'edge' ? p.chromium : p[name];
const output = path.resolve(process.env.AUDIT_OUTPUT || 'audit-results');
fs.mkdirSync(output, { recursive: true });
const browser = await type.launch({ headless: true,
  ...(name === 'edge' ? { channel: 'msedge' } : {}),
  ...(name === 'chromium' && process.env.NWW_CHROMIUM_CHANNEL ? {channel:process.env.NWW_CHROMIUM_CHANNEL} : {}),
  ...(name === 'chromium' && process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  ...(['chromium', 'edge'].includes(name) ? { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } : {})
});
const result = { browser: name, browserVersion: browser.version(), browserChannel: name==='chromium'?(process.env.NWW_CHROMIUM_CHANNEL||'chromium-headless-shell'):name, host: { platform: os.platform(), release: os.release(), arch: os.arch() },
  appRevision: process.env.GITHUB_SHA || 'working-tree', cases: [], observations: [] };
const url = process.env.NWW_TEST_URL || 'http://127.0.0.1:8771/index.html';
const profiles = [
  { id: 'desktop-1366', width: 1366, height: 768, dpr: 1, touch: false },
  { id: 'desktop-hidpi', width: 1920, height: 1080, dpr: 1.25, touch: false },
  { id: 'phone-portrait', width: 390, height: 844, dpr: 3, touch: true },
  { id: 'phone-landscape', width: 844, height: 390, dpr: 3, touch: true }
];
for (const profile of profiles) {
  const context = await browser.newContext({ viewport: { width: profile.width, height: profile.height }, deviceScaleFactor: profile.dpr,
    hasTouch: profile.touch, ...(name !== 'firefox' ? { isMobile: profile.touch } : {}), timezoneId: 'America/Los_Angeles', acceptDownloads: true });
  const page = await context.newPage(); page.setDefaultTimeout(25000);
  const errors = [], warnings = []; page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (['error', 'warning'].includes(m.type())) { warnings.push(m.text()); if (warnings.length > 12) warnings.shift(); } });
  const record = async (label, callback) => {
    const start = Date.now(); let timer;
    try { const actual = await Promise.race([callback(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Scenario exceeded 90 second audit budget')), 90000); })]); result.cases.push({ profile: profile.id, label, passed: true, milliseconds: Date.now() - start, actual }); }
    catch (e) {
      const screenshot = `${profile.id}-${label.replace(/[^a-z0-9]+/gi, '-')}.png`;
      try { await page.screenshot({ path: path.join(output, screenshot), timeout: 5000 }); } catch {}
      let state; try { state = await Promise.race([page.evaluate(() => ({ title: document.title, body: document.body.className,
        mode: typeof currentDataMode === 'undefined' ? null : currentDataMode,
        frame: typeof floodFrameState === 'undefined' ? null : floodFrameState,
        status: document.querySelector('#downloadStatus')?.textContent })), new Promise(resolve => setTimeout(() => resolve({ unavailable: true }), 5000))]); } catch {}
      result.cases.push({ profile: profile.id, label, passed: false, milliseconds: Date.now() - start,
        error: e.message, screenshot, state, warnings: [...warnings] });
    }
    clearTimeout(timer);
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(result, null, 2));
  };
  async function activate(selector) {
    const control = page.locator(selector);
    if (await control.evaluate(el => !!el.closest('#leftPanel')) && await page.locator('#mobileControlsToggle').isVisible() &&
        !await page.locator('body').evaluate(el => el.classList.contains('mobile-controls-open'))) await page.locator('#mobileControlsToggle').click();
    const group = await control.evaluate(el => el.closest('[data-nww-group]')?.dataset.nwwGroup);
    if (group && await page.locator('body').evaluate(el => el.classList.contains('mobile-controls-open'))) {
      const tab = page.locator(`#nwwMobileControlHeader [data-group="${group}"]`);
      if (await tab.getAttribute('aria-selected') !== 'true') await tab.click();
    }
    await control.click();
  }
  await record('startup', async () => {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForFunction(() => document.body.classList.contains('nw-app-ready') && !document.body.classList.contains('nw-app-loading') && floodFrameState === 'ready', {}, { timeout: 90000 });
    const state = await page.evaluate(() => ({ userAgent: navigator.userAgent, platform: navigator.platform, touch: navigator.maxTouchPoints,
      coarse: matchMedia('(pointer: coarse)').matches, width: innerWidth, height: innerHeight, visualWidth: visualViewport?.width,
      overflow: document.documentElement.scrollWidth > innerWidth + 1, stage: getStageValue(currentSeriesHours[currentHourIndex]),
      family: getComputedStyle(document.body).fontFamily, webgl2: !!document.createElement('canvas').getContext('webgl2') }));
    assert.equal(state.overflow, false); assert.ok(Number.isFinite(state.stage));
    await page.screenshot({ path: path.join(output, `${profile.id}-startup.png`) });
    return state;
  });
  if (!result.cases.at(-1).passed) { result.observations.push({ profile: profile.id, skipped: 'Startup unavailable; downstream scenarios excluded.' }); await context.close(); continue; }
  await record('physical-date-key-and-spring-validation', async () => {
    await activate('#openDownloadModalBtn');
    const input = page.locator('#downloadStartDateText');
    await input.fill('10/26/2026'); await input.press('End'); await input.press('ArrowLeft'); await input.press('ArrowLeft'); await input.press('Backspace'); await input.press('0');
    assert.equal(await input.inputValue(), '10/26/2026');
    await input.fill('03/07/2026'); await page.locator('#downloadStartDateText').press('Tab');
    await page.locator('#downloadStartTimeSelect').selectOption('02:30');
    await input.fill('03/08/2026'); await page.locator('#downloadStartDateText').press('Tab');
    assert.equal(await input.getAttribute('aria-invalid'), 'true');
    assert.equal(await page.evaluate(() => getRangeInputDate('downloadStartInput')), null);
    await page.locator('#downloadModalCloseBtn').click();
    return { physicalRoundtrip: true, springGapRejected: true };
  });
  await record('historical-export-availability-before-and-after-Past', async () => {
    async function range() {
      return page.evaluate(async () => { setDownloadModalOpen(true); await ensureExportArchiveAvailability(); setRangeInputDate('downloadStartInput', new Date('2026-01-01T04:00:00Z'));
        setRangeInputDate('downloadEndInput', new Date('2026-01-01T06:00:00Z'));
        const v = validateDownloadRangeForExport(); return { ok: v.ok, reason: v.reason, message: v.message }; });
    }
    const before = await range();
    await page.evaluate(async () => { setDownloadModalOpen(false); await switchDataMode('observed'); await switchDataMode('forecast'); });
    const after = await range(); await page.evaluate(() => setDownloadModalOpen(false));
    assert.equal(before.ok, true, JSON.stringify({ before, after }));
    assert.equal(after.ok, true, JSON.stringify({ before, after }));
    return { before, after };
  });
  await record('mode-and-datum-sequence', async () => {
    const sequence = await page.evaluate(async () => {
      const states = [];
      for (const mode of ['observed', 'return-interval', 'forecast']) {
        await switchDataMode(mode); states.push({ mode: currentDataMode, frame: floodFrameState, stage: getStageValue(currentSeriesHours[currentHourIndex]), series: currentSeriesHours.length });
      }
      document.getElementById('datumNavd88Btn').click(); const navd = convertStageForDisplay(getStageValue(currentSeriesHours[currentHourIndex]));
      document.getElementById('datumMllwBtn').click(); const mllw = convertStageForDisplay(getStageValue(currentSeriesHours[currentHourIndex]));
      return { states, navd, mllw };
    });
    assert.ok(sequence.states.every(s => s.frame === 'ready' && Number.isFinite(s.stage) && s.series > 0));
    assert.ok(Math.abs(sequence.mllw - sequence.navd - 2.75) < 0.02); return sequence;
  });
  await record('orientation-with-open-export', async () => {
    await activate('#openDownloadModalBtn');
    const next = profile.width < profile.height ? { width: profile.height, height: profile.width } : { width: profile.height, height: profile.width };
    await page.setViewportSize(next);
    const close = page.locator('#downloadModalCloseBtn'); await close.click({ trial: true });
    assert.equal(await page.locator('#downloadStartDateText').isVisible(), true);
    await close.click(); await page.setViewportSize({ width: profile.width, height: profile.height }); return { closeStillActionable: true };
  });
  if (!profile.touch) await record('3d-startup-and-building-toggle', async () => {
    const state = await page.evaluate(async () => {
      const map = await window.NORTH_WILDWOOD_3D.ensure();
      if (!map) return { renderer: '2d-fallback', state: document.body.dataset.map3d };
      const a = setBuildingsEnabled(true); const b = setBuildingsEnabled(false); await Promise.all([a, b]);
      return { renderer: '3d', state: document.body.dataset.map3d, buildingsOn: document.getElementById('buildingsToggle').classList.contains('on') };
    });
    if (state.renderer === '3d') assert.equal(state.buildingsOn, false); return state;
  });
  await record('uncaught-browser-errors', async () => { assert.deepEqual(errors, []); return { errors, warnings }; });
  result.observations.push({ profile: profile.id, warnings });
  await context.close();
}
await browser.close();
result.summary = { total: result.cases.length, passed: result.cases.filter(c => c.passed).length, failures: result.cases.filter(c => !c.passed).map(c => ({ profile: c.profile, label: c.label, error: c.error })) };
fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result.summary, null, 2));
process.exitCode = result.summary.failures.length ? 1 : 0;
