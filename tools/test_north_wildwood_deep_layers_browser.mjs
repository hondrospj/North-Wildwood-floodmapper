import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Optional target and artifact directory allow the same real-click probes on
// the fixed build and the baseline, without writing artifacts into the repo.
const target = process.argv[2] || process.env.NWW_TEST_URL || 'http://127.0.0.1:9022/index.html';
const evidence = path.resolve(process.argv[3] || (process.env.NWW_AUDIT_OUTPUT
  ? path.join(process.env.NWW_AUDIT_OUTPUT, 'deep-layers', process.env.NWW_BROWSER || 'chromium')
  : path.join(os.tmpdir(), 'north-wildwood-deep-layers')));
const modulePath = process.env.PLAYWRIGHT_MODULE || 'playwright';
const playwright = await import(modulePath);
const name = process.env.NWW_BROWSER || 'chromium';
const engine = playwright[name === 'edge' ? 'chromium' : name];
assert.ok(engine, `Unknown browser profile: ${name}`);
await fs.mkdir(evidence, { recursive: true });
const browser = await engine.launch({ headless: true,
  ...(name === 'edge' ? {channel:'msedge'} : {}),
  ...(name === 'chromium' && process.env.NWW_CHROMIUM_CHANNEL ? {channel:process.env.NWW_CHROMIUM_CHANNEL} : {}),
  ...(name === 'chromium' && (process.env.CHROME_PATH || process.env.CHROME_EXECUTABLE) ? {executablePath:process.env.CHROME_PATH || process.env.CHROME_EXECUTABLE} : {}),
  ...(['chromium','edge'].includes(name) ? {args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']} : {})});
const results = [], errors = [];
async function open() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(target, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.classList.contains('nw-app-ready') && document.querySelector('#nwSiteLoader')?.hidden, null, { timeout: 30000 });
  return page;
}
async function test(name, run) {
  try { await run(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, error: error.stack }); }
}
async function state(page) {
  return page.evaluate(() => ({
    enabled: document.querySelector('#parcelsToggle').getAttribute('aria-checked'),
    imageWidth: parcelsLayer?.getElement?.()?.naturalWidth || 0,
    mode: mapClickMode,
    depthPressed: document.querySelector('#mapClickDepthBtn').getAttribute('aria-pressed')
  }));
}
try {
  await test('One transient parcel PNG failure reports the error and the next toggle retries successfully', async () => {
    const page = await open(); let requests = 0;
    await page.route('**/*NorthWildwoodParcelBoundaries*', async route => {
      requests++;
      if (requests === 1) await route.abort('failed'); else await route.continue();
    });
    await page.locator('#parcelsToggle').click();
    await page.waitForFunction(() => document.querySelector('#parcelsToggle').getAttribute('aria-checked') === 'false', null, { timeout: 5000 });
    assert.equal(requests, 1);
    assert.match(await page.locator('#toastMessage').textContent(), /Parcels.*try again/i);
    const failedState = await state(page);
    await page.screenshot({ path: path.join(evidence, 'parcel-failure.png') });
    await page.locator('#parcelsToggle').click();
    await page.waitForFunction(() => parcelsLayer?.getElement?.()?.naturalWidth > 0 && map.hasLayer(parcelsLayer), null, { timeout: 15000 });
    assert.equal(requests, 2); assert.equal((await state(page)).enabled, 'true');
    await page.screenshot({ path: path.join(evidence, 'parcel-retry.png') });
    results.push({ name: 'Parcel failure/retry states', passed: true, failedState, recoveredState: await state(page), requests });
    await page.close();
  });
  for (const layer of ['Parcels', 'NSI']) {
    await test(`${layer} asset completion preserves a later repeated Flood Depth selection`, async () => {
      const page = await open(); let release, reached;
      // Keep the interaction control available on the baseline as well, so
      // its failure proves the later mode reset rather than a hidden button.
      if (layer === 'Parcels') {
        await page.locator('#nsiStructuresToggle').click();
        await page.waitForFunction(() => nsiStructuresLayer && map.hasLayer(nsiStructuresLayer), null, { timeout: 15000 });
      } else {
        await page.locator('#parcelsToggle').click();
        await page.waitForFunction(() => parcelsLayer?.getElement?.()?.naturalWidth > 0, null, { timeout: 15000 });
      }
      const gate = new Promise(resolve => { release = resolve; });
      const requested = new Promise(resolve => { reached = resolve; });
      const pattern = layer === 'Parcels' ? '**/*NorthWildwoodParcels.geojson*' : '**/*NorthWildwoodNSI2026Structures.geojson*';
      await page.route(pattern, async route => { reached(); await gate; await route.continue(); });
      await page.locator(layer === 'Parcels' ? '#parcelsToggle' : '#nsiStructuresToggle').click();
      await Promise.race([requested, new Promise((_, reject) => setTimeout(() => reject(Error('The layer request did not start')), 10000))]);
      await page.locator('#mapClickDepthBtn').click(); await page.locator('#mapClickDepthBtn').click();
      assert.equal((await state(page)).mode, 'depth'); release();
      if (layer === 'Parcels') await page.waitForFunction(() => parcelsLayer?.getElement?.()?.naturalWidth > 0, null, { timeout: 15000 });
      else await page.waitForFunction(() => nsiStructuresLayer && map.hasLayer(nsiStructuresLayer), null, { timeout: 15000 });
      await page.waitForTimeout(100);
      assert.equal((await state(page)).mode, 'depth'); assert.equal((await state(page)).depthPressed, 'true');
      await page.screenshot({ path: path.join(evidence, `${layer.toLowerCase()}-depth-choice.png`) });
      await page.close();
    });
  }
  await test('Rapid on/off/on while the boundary PNG is pending keeps only the final enabled state', async () => {
    const page = await open(); let release, reached, requests = 0;
    const gate = new Promise(resolve => { release = resolve; }); const requested = new Promise(resolve => { reached = resolve; });
    await page.route('**/*NorthWildwoodParcelBoundaries*', async route => { requests++; reached(); await gate; await route.continue(); });
    await page.locator('#parcelsToggle').click(); await requested;
    await page.locator('#parcelsToggle').click(); await page.locator('#parcelsToggle').click();
    await page.locator('#mapClickDepthBtn').click(); release();
    await page.waitForFunction(() => parcelsLayer?.getElement?.()?.naturalWidth > 0 && map.hasLayer(parcelsLayer), null, { timeout: 15000 });
    assert.equal(requests, 1); assert.equal((await state(page)).enabled, 'true'); assert.equal((await state(page)).mode, 'depth');
    await page.locator('#parcelsToggle').click();
    assert.equal(await page.evaluate(() => map.hasLayer(parcelsLayer)), false);
    await page.close();
  });
  assert.deepEqual(errors, [], 'No unexpected browser JavaScript errors');
} finally {
  await fs.writeFile(path.join(evidence, 'results.json'), JSON.stringify({ browser:name,version:browser.version(),target,results,errors,passed:results.every(result=>result.passed)&&errors.length===0 }, null, 2));
  await browser.close();
}
for (const result of results) { console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.name}`); if (!result.passed) console.log(result.error); }
if (results.some(result => !result.passed)) process.exitCode = 1;
console.log(`Browser evidence: ${evidence}`);
