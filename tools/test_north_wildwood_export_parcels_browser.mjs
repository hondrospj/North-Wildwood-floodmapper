import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setNativeExportRange } from './helpers/north_wildwood_deep_export_browser.mjs';

const playwright = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const name = process.env.NWW_BROWSER || 'chromium';
const browser = await playwright[name === 'edge' ? 'chromium' : name].launch({ headless: true,
  ...(name === 'edge' ? { channel: 'msedge' } : {}),
  ...(name === 'chromium' && process.env.NWW_CHROMIUM_CHANNEL ? { channel: process.env.NWW_CHROMIUM_CHANNEL } : {}),
  ...(name === 'chromium' && process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  ...(['chromium', 'edge'].includes(name) ? { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'America/New_York' });
const page = await context.newPage();
const result = { browser: name, version: browser.version(), requests: [], checks: [], errors: [] };
page.on('pageerror', error => result.errors.push(error.message));

const click = id => page.locator('#' + id).click({ timeout: 30000 });
const waitForPreview = () => page.waitForFunction(() => ['ready', 'error'].includes(exportPreview.dataset.state),
  null, { timeout: 90000 });
const readState = () => page.evaluate(() => ({
  preview: exportPreview.dataset.state,
  status: exportPreviewStatus.textContent,
  retryVisible: !exportPreviewRetryBtn.hidden,
  enabled: parcelsToggle.getAttribute('aria-checked') === 'true',
  liveWidth: parcelsLayer?.getElement()?.naturalWidth ?? 0,
  exportWidth: exportParcelsLayer?.getElement()?.naturalWidth ?? 0,
  exportSrc: exportParcelsLayer?.getElement()?.src.split(':')[0] ?? null
}));

let available = true;
await context.route('**/NorthWildwoodParcelBoundaries.png*', async route => {
  result.requests.push({ resourceType: route.request().resourceType(), status: available ? 200 : 503 });
  if (available) {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), 'cache-control': 'no-store' } });
  } else await route.fulfill({ status: 503, body: 'Parcel image temporarily unavailable' });
});

try {
  await page.goto(process.env.NWW_TEST_URL || 'http://127.0.0.1:8765/index.html',
    { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => document.body.classList.contains('nw-app-ready') && floodFrameState === 'ready',
    null, { timeout: 90000 });
  if (await page.locator('#roadsToggle').getAttribute('aria-checked') === 'true') await click('roadsToggle');
  await click('parcelsToggle');
  await page.waitForFunction(() => Boolean(parcelsLayer?.getElement()?.naturalWidth), null, { timeout: 30000 });
  result.live = await readState();

  available = false;
  await click('openDownloadModalBtn');
  await waitForPreview();
  result.outage = await readState();
  assert.ok(result.requests.some(request => request.status === 503), 'The independent export request must fail');
  assert.equal(result.outage.enabled, true);
  assert.equal(result.outage.liveWidth, result.live.liveWidth);
  assert.equal(result.outage.preview, 'error', 'An export missing requested parcels cannot appear ready');
  assert.match(result.outage.status, /parcel boundaries/i);
  assert.equal(result.outage.retryVisible, true);
  result.checks.push('Export-only 503 leaves the live parcel layer intact and offers Preview Retry');

  available = true;
  await click('exportPreviewRetryBtn');
  await page.waitForFunction(() => exportPreview.dataset.state === 'ready', null, { timeout: 90000 });
  result.recovered = await readState();
  assert.equal(result.recovered.exportWidth, result.live.liveWidth);
  assert.equal(result.recovered.exportSrc, 'blob');
  result.checks.push('Preview Retry loads and decodes a snapshot of the requested parcel image');

  const timestamp = await page.evaluate(() =>
    getForecastExportEntries().find(entry => Number.isFinite(entryTimeMs(entry)))?.timeUtc);
  assert.ok(timestamp);
  await setNativeExportRange(page, timestamp, timestamp);
  await click('exportFormatPngBtn');
  await click('downloadBtn');
  const requestCount = result.requests.length;
  available = false;
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 90000 }), click('downloadBtn')]);
  assert.equal(await download.failure(), null);
  const image = fs.readFileSync(await download.path());
  assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(result.requests.length, requestCount, 'PNG capture must reuse the image bytes without a network request');
  result.png = { name: download.suggestedFilename(), bytes: image.length };
  result.checks.push('Native PNG capture retains the recovered parcel bytes during a renewed outage');
  assert.deepEqual(result.errors, []);
} catch (error) {
  result.failure = error.stack;
  process.exitCode = 1;
} finally {
  await browser.close();
  if (process.env.NWW_AUDIT_OUTPUT) {
    const output = process.env.NWW_AUDIT_OUTPUT;
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, 'export-parcels.json'), JSON.stringify(result, null, 2));
  }
  console.log(JSON.stringify(result, null, 2));
}
