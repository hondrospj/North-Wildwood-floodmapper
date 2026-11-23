import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
console.log('Launching isolated headless atomic-render audit');
const browser = await chromium.launch({ headless: true, timeout: 30000,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const result = { browser: browser.version(), checks: [], errors: [] };
const watchdog = setTimeout(() => { result.failure = 'The isolated browser audit exceeded its 180-second budget'; browser.close().catch(() => {}); }, 180000);
const output = process.env.NWW_AUDIT_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(), 'nww-atomic-3d-'));
fs.mkdirSync(output, { recursive: true });
console.log(`Evidence directory: ${output}`);
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(60000);
  page.on('pageerror', error => result.errors.push(error.message));
  await page.goto(process.env.NWW_TEST_URL || 'http://127.0.0.1:8765/index.html',
    { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => document.body.classList.contains('nw-app-ready') && floodFrameState === 'ready');
  console.log('Application ready');
  await page.evaluate(async () => { await switchDataMode('observed'); });
  console.log('Observed mode loaded');
  await page.evaluate(async () => { await loadObservedDay('2026-09-26'); });
  console.log('Static observed storm loaded');
  await page.evaluate(async () => { await NORTH_WILDWOOD_3D.ensure(); });
  console.log('MapLibre initialized');
  await page.waitForFunction(() => {
    const state = NORTH_WILDWOOD_3D.state(), gl = NORTH_WILDWOOD_3D.getMap();
    const source = gl?.getSource(state.floodDrapeSourceId);
    return state.ready && source?.loaded() && source.image && source.url === currentFloodLayer?._url;
  });
  const snapshot = () => page.evaluate(() => {
    const state = NORTH_WILDWOOD_3D.state(), gl = NORTH_WILDWOOD_3D.getMap();
    const plane = id => { const layer = gl.style.getLayer(id); return layer?.implementation || layer; };
    const active = plane(state.floodLayerId);
    const candidateId = state.floodLayerId === 'nw-flood-overlay' ? 'nw-flood-overlay-next' : 'nw-flood-overlay';
    const candidate = plane(candidateId);
    const activeNative = gl.getSource(state.floodDrapeSourceId);
    const candidateSourceId = state.floodDrapeSourceId.endsWith('-next') ? 'nw-flood-drape-source' : 'nw-flood-drape-source-next';
    const native = gl.getSource(candidateSourceId);
    const candidateDrapeId = state.floodDrapeLayerId.endsWith('-next') ? 'nw-flood-drape' : 'nw-flood-drape-next';
    return { index: currentHourIndex, url: currentFloodLayer?._url, activeId: state.floodLayerId,
      activeUrl: active?.committedUrl, nativeUrl: activeNative?.url,
      candidateId, candidateReady: !!candidate?.textureReady, candidateVisible: candidate?.visible,
      nativeReady: !!(native?.loaded() && native.image), nativeTexture: !!native?.texture?.texture,
      candidateDrapeOpacity: gl.getLayer(candidateDrapeId) ? gl.getPaintProperty(candidateDrapeId, 'raster-opacity') : null,
      activeNativeTexture: !!activeNative?.texture?.texture, heldNative: window.__atomicHeldNative?.length || 0,
      heldGpu: window.__atomicHeldGpu?.length || 0, done: !!window.__atomicDone };
  });
  const canvasProof = async label => {
    const bytes = await page.locator('#map3d canvas.maplibregl-canvas').screenshot({ path: path.join(output, label + '.png') });
    return { file: path.join(output, label + '.png'), sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  for (const held of ['native', 'gpu']) {
    const target = await page.evaluate(async () => {
      for (let index = 0; index < currentSeriesHours.length; index++) {
        const entry = currentSeriesHours[index], stage = getStageValue(entry);
        if (index === currentHourIndex || stage <= 1) continue;
        const record = await getHydraulicOverlayRecord(currentOverlayMode, getOverlayStage(stage),
          getHydraulicPhaseForEntry(entry, index, currentSeriesHours), entry, currentRawSeriesHours);
        if (record?.url && !record.url.startsWith('blob:') && record.url !== currentFloodLayer._url) return { index, url: record.url };
      }
      return null;
    });
    assert.ok(target, 'A different real wet static storm frame is required');
    console.log(`Starting delayed-${held}, target ${target.index}`);
    await page.evaluate(held => {
      const api = NORTH_WILDWOOD_3D, gl = api.getMap(), activeId = api.state().floodDrapeSourceId;
      window.__atomicHeldNative = []; window.__atomicHeldGpu = []; window.__atomicDone = false;
      if (held === 'native') {
        const prototype = Object.getPrototypeOf(gl.getSource(activeId));
        const load = prototype.load;
        prototype.load = async function (...args) {
          if (this.id.startsWith('nw-flood-drape-source') && this.id !== activeId) {
            await new Promise(resolve => window.__atomicHeldNative.push(resolve));
          }
          return load.apply(this, args);
        };
        window.__atomicRelease = () => {
          prototype.load = load;
          for (const resolve of window.__atomicHeldNative) resolve();
        };
      } else {
        const NativeImage = window.Image;
        const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
        window.Image = function (...args) {
          const image = new NativeImage(...args);
          if ((new Error().stack || '').includes('loadTexture')) {
            Object.defineProperty(image, 'src', {
              get() { return descriptor.get.call(image); },
              set(value) { window.__atomicHeldGpu.push(() => descriptor.set.call(image, value)); }
            });
          }
          return image;
        };
        window.Image.prototype = NativeImage.prototype;
        window.__atomicRelease = () => {
          window.Image = NativeImage;
          for (const resolve of window.__atomicHeldGpu) resolve();
        };
      }
    }, held);
    const before = await snapshot();
    const beforeCanvas = await canvasProof(`${held}-before`);
    await page.evaluate(index => { window.__atomicJob = renderHour(index).then(() => { window.__atomicDone = true; }); }, target.index);
    await page.waitForFunction(held => held === 'native'
      ? window.__atomicHeldNative.length > 0 : window.__atomicHeldGpu.length > 0, held);
    await page.waitForFunction(held => {
      const state = NORTH_WILDWOOD_3D.state(), gl = NORTH_WILDWOOD_3D.getMap();
      const candidateId = state.floodLayerId === 'nw-flood-overlay' ? 'nw-flood-overlay-next' : 'nw-flood-overlay';
      const layer = gl.style.getLayer(candidateId), candidate = layer?.implementation || layer;
      const sourceId = state.floodDrapeSourceId.endsWith('-next') ? 'nw-flood-drape-source' : 'nw-flood-drape-source-next';
      const source = gl.getSource(sourceId);
      return held === 'native' ? candidate?.textureReady : source?.texture?.texture;
    }, held);
    const pending = await snapshot();
    const pendingCanvas = await canvasProof(`${held}-pending`);
    for (const key of ['index', 'url', 'activeId', 'activeUrl', 'nativeUrl']) assert.equal(pending[key], before[key], key);
    assert.equal(pending.candidateVisible, false);
    assert.equal(pending.candidateDrapeOpacity, 0);
    assert.equal(pending.done, false);
    // Keep both committed images while the camera changes and the candidate is waiting.
    await page.evaluate(() => {
      const gl = NORTH_WILDWOOD_3D.getMap();
      gl.jumpTo({ pitch: 60 }); gl.jumpTo({ pitch: 0 });
    });
    const repitched = await snapshot();
    assert.equal(repitched.activeUrl, before.activeUrl);
    assert.equal(repitched.nativeUrl, before.nativeUrl);
    assert.equal(repitched.candidateVisible, false);
    await page.evaluate(() => window.__atomicRelease());
    await page.waitForFunction(() => window.__atomicDone);
    await page.evaluate(() => new Promise(resolve => {
      const gl = NORTH_WILDWOOD_3D.getMap(); gl.once('render', () => resolve()); gl.triggerRepaint();
    }));
    const after = await snapshot();
    const afterCanvas = await canvasProof(`${held}-committed`);
    assert.equal(after.index, target.index);
    assert.equal(after.activeUrl, after.url);
    assert.equal(after.nativeUrl, after.url);
    assert.equal(after.activeNativeTexture, true, 'The first post-commit native draw has a GPU texture');
    result.checks.push({ held, before, pending, repitched, after, canvas: { before: beforeCanvas, pending: pendingCanvas, after: afterCanvas } });
    console.log(`Passed delayed-${held}: previous pixels retained; native GPU texture ready on first draw`);
  }
  assert.deepEqual(result.errors, []);
} catch (error) {
  result.failure = error.stack;
  throw error;
} finally {
  clearTimeout(watchdog);
  await browser.close();
  fs.writeFileSync(path.join(output, 'atomic-3d-browser.json'), JSON.stringify(result, null, 2));
  console.log(`Evidence: ${path.join(output, 'atomic-3d-browser.json')}`);
  console.log(JSON.stringify(result, null, 2));
}
