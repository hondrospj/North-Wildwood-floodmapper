// Chromium CDP generates real browser pointercancel and lostpointercapture events.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  ...(process.env.NWW_CHROMIUM_CHANNEL ? { channel: process.env.NWW_CHROMIUM_CHANNEL } : {}),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, hasTouch: true, timezoneId: 'America/New_York' });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
const result = { browser: browser.version(), errors: [], checks: [] };
page.on('pageerror', error => result.errors.push(error.message));

const click = id => page.locator('#' + id).click({ timeout: 30000 });
const selectedBounds = () => page.evaluate(() => {
  const bounds = FLOODMAPPER_EXPORT_AREA.getBounds();
  return bounds && [bounds.getSouth(), bounds.getWest(), bounds.getNorth(), bounds.getEast()];
});
const pickerRectangle = () => page.evaluate(() => {
  let bounds = null;
  areaTestMap.eachLayer(layer => {
    if (layer instanceof L.Rectangle) {
      const rectangle = layer.getBounds();
      bounds = [rectangle.getSouth(), rectangle.getWest(), rectangle.getNorth(), rectangle.getEast()];
    }
  });
  return bounds;
});
const events = () => page.evaluate(() => areaTestEvents);
const draw = async (endType, parts) => {
  await click('exportExtentCustomBtn');
  await page.locator('#exportAreaModal').waitFor({ state: 'visible' });
  const priorRectangle = await pickerRectangle();
  await click('exportAreaDrawBtn');
  await page.evaluate(() => { areaTestEvents.length = 0; });
  const map = await page.locator('#exportAreaMap').boundingBox();
  const points = parts.map(([x, y]) => ({ x: Math.round(map.x + map.width * x),
    y: Math.round(map.y + map.height * y), id: 7 }));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [points[0]] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [points[1]] });
  await page.waitForFunction(() => areaTestEvents.some(event => event.type === 'pointermove'));
  const duringDrag = await pickerRectangle();
  await cdp.send('Input.dispatchTouchEvent', { type: endType, touchPoints: [] });
  await page.waitForFunction(() => areaTestEvents.some(event => event.type === 'lostpointercapture'));
  const completedRectangle = await pickerRectangle();
  const pointerEvents = await events();
  const drawing = await page.locator('#exportAreaDrawBtn').getAttribute('aria-pressed');
  await click('exportAreaApplyBtn');
  return { priorRectangle, duringDrag, completedRectangle, pointerEvents, drawing, selected: await selectedBounds() };
};

try {
  await page.goto(process.env.NWW_TEST_URL || 'http://127.0.0.1:8765/index.html',
    { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => document.body.classList.contains('nw-app-ready') && floodFrameState === 'ready', null,
    { timeout: 90000 });
  // Observe the Leaflet layers and browser-delivered events without replacing app behavior.
  await page.evaluate(() => {
    window.areaTestEvents = [];
    L.Map.addInitHook(function () {
      const element = this.getContainer();
      if (element.id !== 'exportAreaMap') return;
      window.areaTestMap = this;
      for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) {
        element.addEventListener(type, event => areaTestEvents.push({ type, trusted: event.isTrusted }));
      }
    });
  });
  if (await page.locator('#roadsToggle').getAttribute('aria-checked') === 'true') await click('roadsToggle');
  await click('openDownloadModalBtn');
  await click('downloadBtn');
  await click('exportExtentCustomBtn');
  await click('exportAreaVisibleBtn');
  const visibleArea = await pickerRectangle();
  await click('exportAreaApplyBtn');
  const initial = await selectedBounds();
  assert.ok(initial);
  assert.deepEqual(initial, visibleArea, 'Use visible area commits the Leaflet viewport');
  result.checks.push('Use visible area commits the Leaflet viewport');

  const cancelled = await draw('touchCancel', [[0.27, 0.29], [0.72, 0.72]]);
  const completed = await draw('touchEnd', [[0.22, 0.37], [0.78, 0.68]]);
  result.area = { initial, cancelled, completed };
  for (const attempt of [cancelled, completed]) {
    assert.notDeepEqual(attempt.duringDrag, attempt.priorRectangle, 'The rectangle follows an active drag');
    assert.ok(attempt.pointerEvents.every(event => event.trusted), 'All drawing input came from browser events');
  }
  assert.ok(cancelled.pointerEvents.some(event => event.type === 'pointercancel'));
  assert.ok(!cancelled.pointerEvents.some(event => event.type === 'pointerup'));
  assert.equal(cancelled.drawing, 'true');
  assert.deepEqual(cancelled.completedRectangle, initial, 'A cancelled drag restores the selected rectangle');
  assert.deepEqual(cancelled.selected, initial, 'Use this area keeps the prior custom selection after a cancelled drag');
  result.checks.push('Trusted pointercancel restores the prior custom selection');

  const releaseEvents = completed.pointerEvents.map(event => event.type);
  assert.ok(releaseEvents.includes('pointerup') && releaseEvents.indexOf('pointerup') < releaseEvents.indexOf('lostpointercapture'));
  assert.equal(completed.drawing, 'false');
  assert.deepEqual(completed.selected, completed.completedRectangle);
  assert.notDeepEqual(completed.selected, initial, 'The completed drawing survives release of pointer capture');
  result.checks.push('Trusted pointerup commits the new drawing and the following lostpointercapture preserves it');
  assert.deepEqual(result.errors, []);
} catch (error) {
  result.failure = error.stack;
  process.exitCode = 1;
} finally {
  await browser.close();
  if (process.env.NWW_AUDIT_OUTPUT) {
    const output = process.env.NWW_AUDIT_OUTPUT;
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, 'export-area-touch-cancel.json'), JSON.stringify(result, null, 2));
  }
  console.log(JSON.stringify(result, null, 2));
}
