import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const playwright = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const name = process.env.NWW_BROWSER || 'chromium';
const isChromium = ['chromium', 'edge'].includes(name);
const browser = await playwright[name === 'edge' ? 'chromium' : name].launch({
  headless: true,
  ...(name === 'edge' ? {channel: 'msedge'} : {}),
  ...(name === 'chromium' && process.env.CHROME_PATH ? {executablePath: process.env.CHROME_PATH} : {}),
  ...(name === 'chromium' && process.env.NWW_CHROMIUM_CHANNEL ? {channel: process.env.NWW_CHROMIUM_CHANNEL} : {}),
  ...(isChromium ? {args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']} : {})
});
const url = process.env.NWW_TEST_URL || 'http://127.0.0.1:8765/index.html';
const output = process.env.NWW_AUDIT_OUTPUT;
const deadline = {timeout: 65000};
const result = {browser: name, version: browser.version(), cases: []};
const leaflet = /\/leaflet@1\.9\.4\/dist\/leaflet\.js$/;
const vector = /\/esri-leaflet-vector@4\.3\.2\/dist\/esri-leaflet-vector\.js$/;
const roads = /\/assets\/road-labels\.js(?:\?|$)/;

const snapshot = page => page.evaluate(() => {
  const currentMap = typeof map === 'undefined' ? null : map;
  const app = document.getElementById('app');
  return {
    ready: document.body.classList.contains('nw-app-ready'), loader: document.body.dataset.siteLoader,
    frame: document.body.dataset.initialFloodFrame, layers: document.body.dataset.deferredMapLayers,
    status: document.getElementById('nwLoaderStatus').textContent, inert: app.inert,
    retry: document.getElementById('nwLoaderRetry').getClientRects().length > 0,
    readyTiles: document.querySelectorAll('#map .basemap-color-layer img.leaflet-tile-loaded').length,
    center: currentMap?._loaded ? [currentMap.getCenter().lat, currentMap.getCenter().lng] : null,
    entries: typeof currentSeriesHours === 'undefined' ? 0 : currentSeriesHours.length,
    satellite: typeof satelliteLayer !== 'undefined' && Boolean(satelliteLayer && currentMap?.hasLayer(satelliteLayer)),
    roadLayer: typeof roadsLayer !== 'undefined' && Boolean(roadsLayer && currentMap?.hasLayer(roadsLayer)),
    roadPreference: document.getElementById('roadsToggle').getAttribute('aria-checked'),
    preview: document.getElementById('exportPreview')?.dataset.state,
    previewStatus: document.getElementById('exportPreviewStatus')?.textContent,
    exportMap: typeof exportMap !== 'undefined' && Boolean(exportMap),
    exportRoads: typeof exportRoadsLayer !== 'undefined' && Boolean(exportRoadsLayer)
  };
});

async function ready(page, row) {
  await page.waitForFunction(() => document.body?.dataset.siteLoader === 'complete', null, deadline);
  await page.locator('#nwSiteLoader').waitFor({state: 'hidden'});
  const state = await snapshot(page);
  row.states.push(state);
  assert.equal(state.ready, true);
  assert.equal(state.frame, 'ready');
  assert.equal(state.layers, 'active');
  assert.equal(state.inert, false);
  assert.equal(state.retry, false);
  assert.ok(state.center && state.entries > 0);
  return state;
}

async function retryVisible(page, row) {
  await page.locator('#nwLoaderRetry').waitFor({state: 'visible', ...deadline});
  const state = await snapshot(page);
  row.states.push(state);
  assert.equal(state.ready, false);
  assert.equal(state.loader, 'dependency-error');
  assert.equal(state.inert, true);
  assert.equal(state.retry, true);
  assert.match(state.status, /could not load/i);
}

async function preview(page) {
  await page.locator('#openDownloadModalBtn').click();
  await page.locator('#exportFormatPngBtn').click();
  await page.locator('#downloadBtn').click();
  await page.waitForFunction(() => ['ready', 'error', 'empty'].includes(document.getElementById('exportPreview').dataset.state), null, deadline);
  return snapshot(page);
}

const cases = {
  'healthy': async (page, row) => {
    await page.goto(url, {waitUntil: 'domcontentloaded', ...deadline});
    assert.equal((await ready(page, row)).roadLayer, true);
  },
  'vector-503': async (page, row) => optionalFailure(page, row, vector, true),
  'roads-503': async (page, row) => optionalFailure(page, row, roads, false),
  'required-503': async (page, row) => {
    let fail = true;
    await page.route(leaflet, route => fail ? unavailable(route) : route.continue());
    await page.goto(url, {waitUntil: 'commit', ...deadline});
    await retryVisible(page, row);
    fail = false;
    await page.locator('#nwLoaderRetry').click();
    assert.equal((await ready(page, row)).roadLayer, true);
    assert.equal(row.documents, 2);
  },
  'held-vector': async (page, row) => {
    let release;
    const held = new Promise(resolve => { release = resolve; });
    await page.route(vector, async route => {
      await held;
      await route.continue();
    });
    try {
      await Promise.all([page.waitForRequest(vector, deadline), page.goto(url, {waitUntil: 'commit', ...deadline})]);
      await retryVisible(page, row);
      assert.equal(row.responses.some(({url}) => vector.test(url)), false, 'Retry must become visible while the actual parser-blocking request is held');
      release();
      assert.equal((await ready(page, row)).roadLayer, true);
      assert.equal(row.documents, 1);
    } finally { release(); }
  },
  'fatal-startup': async (page, row) => {
    let fail = true;
    await page.route(/\/assets\/app\/town-config\.js(?:\?|$)/, async route => {
      if (!fail) return route.continue();
      const response = await route.fetch();
      const script = await response.text();
      return route.fulfill({response, body: `L.map = () => { throw new Error('Intentional required map construction failure'); };\n${script}`});
    });
    await page.goto(url, {waitUntil: 'domcontentloaded', ...deadline});
    await page.waitForFunction(() => document.body.dataset.siteLoader === 'dependency-error' || document.body?.dataset.siteLoader === 'complete', null, deadline);
    assert.equal((await snapshot(page)).loader, 'dependency-error', 'A caught fatal startup error must leave the retry available');
    await retryVisible(page, row);
    fail = false;
    await page.locator('#nwLoaderRetry').click();
    assert.equal((await ready(page, row)).roadLayer, true);
    assert.equal(row.documents, 2);
  }
};

function unavailable(route) {
  return route.fulfill({status: 503, contentType: 'text/plain', body: 'Intentional startup test HTTP 503'});
}

async function optionalFailure(page, row, pattern, raster) {
  let fail = true;
  await page.route(pattern, route => fail ? unavailable(route) : route.continue());
  await page.goto(url, {waitUntil: 'domcontentloaded', ...deadline});
  const started = await ready(page, row);
  assert.equal(started.roadLayer, false);
  assert.equal(started.roadPreference, 'true', 'Unavailable labels preserve the requested layer preference');
  assert.equal(row.responses.filter(({url, status}) => pattern.test(url) && status === 503).length, 1);
  if (raster) {
    await page.waitForFunction(() => document.querySelector('#map .basemap-color-layer img.leaflet-tile-loaded'), null, deadline);
    assert.ok((await snapshot(page)).readyTiles > 0, 'The raster fallback must actually paint tiles');
  }
  await page.locator('#satelliteToggle').click();
  assert.equal((await snapshot(page)).satellite, true, 'Independent Satellite control remains usable');
  await page.locator('#satelliteToggle').click();
  assert.equal((await snapshot(page)).satellite, false);

  if (raster) {
    const withRoads = await preview(page);
    row.states.push(withRoads);
    assert.equal(withRoads.preview, 'error');
    assert.match(withRoads.previewStatus, /turn off Road Names/);
    assert.equal(withRoads.exportMap, false, 'Reject requested unavailable road names before caching a partial export map');
    await page.keyboard.press('Escape');
    await page.locator('#downloadModal').waitFor({state: 'hidden'});
    await page.locator('#roadsToggle').click();
    const withoutRoads = await preview(page);
    row.states.push(withoutRoads);
    assert.equal(withoutRoads.preview, 'ready');
    assert.equal(withoutRoads.roadPreference, 'false');
    assert.equal(withoutRoads.exportMap, true);
    assert.equal(withoutRoads.exportRoads, false);
  }
  fail = false;
  await page.reload({waitUntil: 'domcontentloaded', ...deadline});
  assert.equal((await ready(page, row)).roadLayer, true, 'Reload should restore the normal vector road layer');
  assert.equal(row.documents, 2);
}

try {
  for (const id of (process.argv.length > 2 ? process.argv.slice(2) : Object.keys(cases))) {
    const context = await browser.newContext({viewport: {width: 1512, height: 945}, reducedMotion: 'reduce', timezoneId: 'America/New_York'});
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const row = {id, documents: 0, states: [], responses: [], pageErrors: []};
    result.cases.push(row);
    page.on('request', request => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) row.documents++;
    });
    page.on('response', response => {
      if (response.request().resourceType() === 'script') row.responses.push({url: response.url(), status: response.status()});
    });
    page.on('pageerror', error => row.pageErrors.push(error.message));
    try {
      await cases[id](page, row);
      row.passed = true;
      console.log(`PASS ${id}`);
    } catch (error) {
      row.failure = error.stack;
      row.states.push(await snapshot(page).catch(() => null));
      if (output) {
        await fs.mkdir(output, {recursive: true});
        await page.screenshot({path: path.join(output, `${name}-${id}-failure.png`)}).catch(() => {});
      }
      console.error(row.failure);
      process.exitCode = 1;
    } finally { await context.close(); }
  }
} finally {
  await browser.close();
  if (output) {
    await fs.mkdir(output, {recursive: true});
    await fs.writeFile(path.join(output, `${name}-startup-fallback.json`), JSON.stringify(result, null, 2) + '\n');
  }
}
