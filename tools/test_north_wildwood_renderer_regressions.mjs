import { readAppSource } from './app_source.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const sourcePath = path.resolve(process.argv[2] || new URL('../index.html', import.meta.url).pathname);
const source = readAppSource(sourcePath);
const results = [];
function extract(name) {
  const match = source.match(new RegExp('^    (?:async )?function ' + name + '\\([^\\n]*\\) \\{\\n.*?^    \\}', 'ms'));
  assert.ok(match, `Missing function ${name}`);
  return match[0];
}
function load(context, names) {
  for (const name of names) vm.runInContext(extract(name), context, { filename: sourcePath + ':' + name });
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function test(name, run) {
  try { await run(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, error: error.stack || String(error) }); }
}

await test('Returning to the displayed slider time supersedes an in-flight different frame', async () => {
  const gate = deferred(), started = deferred(), labels = [], slider = { value: '0' };
  const oldLayer = { id: 'frame-0' }, alternateLayer = { id: 'frame-1' };
  const layers = new Set([oldLayer]);
  const context = vm.createContext({ console,
    currentSeriesHours: [{ stage: 0 }, { stage: 1 }], currentRawSeriesHours: [], currentHourIndex: 0,
    lastRenderToken: 0, currentFloodLayer: oldLayer, pendingFloodLayer: null, floodFrameState: 'ready',
    timelineSelectionFrame: 0, pendingTimelineSelection: null, currentDataMode: 'forecast', currentOverlayMode: 'depth',
    document: { getElementById: () => slider, body: { dataset: { initialFloodFrame: 'ready' }, classList: { contains: () => false, toggle() {} } } },
    map: { hasLayer: layer => layers.has(layer), removeLayer: layer => layers.delete(layer) },
    getStageValue: entry => entry.stage, getOverlayStage: stage => stage, getHydraulicPhaseForEntry: () => 'slack',
    updatePersistentDepthQueryPopup() {}, setFloodFrameStatus() {}, updateSliderProgress() {},
    getPhysicsAssetForEntry: () => null, buildNotes: () => '', toast() {}, renderLegend() {},
    renderSelectionMeta: entry => labels.push(entry.stage), renderTimelineMeta() { slider.value = String(context.currentHourIndex); },
    updateNsiStructureImpactLayer() {}, preloadAroundHour() {}, scheduleOverlayCatalogWarmup() {},
    renderFloodFrameWithRetry: async (render, token) => { const ok = await render(); return ok && token === context.lastRenderToken; },
    setFloodLayer: async (_mode, stage, _phase, token) => {
      if (stage === 1) { started.resolve(); await gate.promise; }
      if (token !== context.lastRenderToken) return false;
      context.currentFloodLayer = stage === 1 ? alternateLayer : oldLayer;
      return true;
    },
    requestAnimationFrame() { throw Error('This test commits selections immediately'); }, cancelAnimationFrame() {},
    reportFloodFrameFailure() { throw Error('Unexpected frame failure'); },
    scheduleRasterObjectUrlCleanup() {}, renderedFloodPixelCache: null,
  });
  load(context, ['cancelPendingFloodFrame', 'cancelTimelineSelection', 'renderHour', 'flushTimelineSelection', 'queueTimelineSelection']);
  const first = context.renderHour(1);
  await started.promise;
  assert.equal(context.currentHourIndex, 0, 'The displayed index should remain committed while its replacement loads');
  slider.value = '0';
  context.queueTimelineSelection(0, true);
  await Promise.resolve();
  gate.resolve();
  await first;
  // A replacement render of frame 0 may complete in the next promise continuation.
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(context.currentHourIndex, 0, 'The delayed frame must not override the final slider request');
  assert.equal(context.currentFloodLayer, oldLayer, 'The final displayed raster must correspond to the final slider request');
  assert.equal(slider.value, '0');
  assert.equal(context.floodFrameState, 'ready', 'Returning to a valid displayed frame must leave the map ready');
  assert.ok(!labels.includes(1), 'The superseded frame must never publish its timestamp');
});

function rasterFixture(limit = 2) {
  const images = [], timers = new Map(); let timerId = 0;
  class FakeImage {
    constructor() { this.complete = true; this.naturalWidth = 2; this.naturalHeight = 2; images.push(this); }
    set src(value) { this.url = value; }
    get src() { return this.url; }
    async decode() {}
  }
  const context = vm.createContext({ console, Image: FakeImage,
    drainageRasterImageCache: new Map(), DRAINAGE_RASTER_IMAGE_CACHE_LIMIT: limit,
    retainRasterObjectUrl: () => () => {},
    window: { setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); } },
  });
  load(context, ['getDrainageRasterImage']);
  return { context, images, timers };
}
await test('A failed raster decode can be retried successfully', async () => {
  const { context, images } = rasterFixture();
  const failed = context.getDrainageRasterImage('raster-A.png');
  images[0].onerror();
  assert.equal(await failed, null);
  const retry = context.getDrainageRasterImage('raster-A.png');
  assert.equal(images.length, 2, 'A failed cached promise must not prevent a new image request');
  images[1].onload();
  assert.equal(await retry, images[1]);
});
await test('Failure of an evicted request cannot delete the newer request for its URL', async () => {
  const { context, images } = rasterFixture(2);
  const first = context.getDrainageRasterImage('raster-A.png');
  const b = context.getDrainageRasterImage('raster-B.png');
  const c = context.getDrainageRasterImage('raster-C.png');
  assert.ok(!context.drainageRasterImageCache.has('raster-A.png'), 'Fixture must evict the original pending request');
  const replacement = context.getDrainageRasterImage('raster-A.png');
  assert.equal(images.length, 4);
  images[0].onerror();
  assert.equal(await first, null);
  assert.equal(context.drainageRasterImageCache.get('raster-A.png'), replacement,
    'A late failure must only delete its own cached promise');
  images[3].onload();
  assert.equal(await replacement, images[3]);
  assert.equal(await context.getDrainageRasterImage('raster-A.png'), images[3]);
  assert.equal(images.length, 4, 'The recovered image must remain cached');
  images[1].onload(); images[2].onload();
  await Promise.all([b, c]);
});

function physicsFixture(pixel = [0, 0, 0, 255]) {
  const popups = [], notices = [], layers = new Set();
  const entries = [{ physicsFrame: { query: { url: 'physics-A.png' } }, stage: 1 }, { physicsFrame: { query: { url: 'physics-B.png' } }, stage: 3 }];
  const document = {
    body: { dataset: {}, classList: { contains: () => false, add() {}, remove() {}, toggle() {} } },
    getElementById: () => null,
    createElement: () => ({ getContext: () => ({ drawImage() {}, getImageData: () => ({ data: Uint8ClampedArray.from(pixel) }) }) }),
  };
  const context = vm.createContext({ console, document, currentSeriesHours: entries, currentHourIndex: 0,
    currentDataMode: 'forecast', currentOverlayMode: 'depth', mapClickMode: 'depth', floodFrameState: 'ready', lastRenderToken: 0, mapQueryGeneration: 0,
    currentFloodLayer: { _floodmapperFrame: { entry: entries[0], stage: 1, dataMode: 'forecast' } },
    persistentFloodPopup: null, persistentDepthQueryContext: null, pendingFloodLayer: null, setFloodFrameStatus() {},
    renderedFloodPixelCache: null, scheduleRasterObjectUrlCleanup() {},
    requestedTimelineSelection: null, cancelTimelineSelection() {}, updateNsiStructureImpactLayer() {},
    getPhysicsAssetForEntry: entry => entry?.physicsFrame || null,
    getActivePhysicsManifest: () => ({ boundsWgs84: [[39, -75], [40, -74]], cycleId: 'test-cycle' }),
    preloadPhysicsQueryImage: async () => ({ naturalWidth: 2, naturalHeight: 2 }),
    escapeTownAddressHtml: value => String(value), buildDepthQueryValueHtml: value => String(value),
    map: { hasLayer: layer => layers.has(layer), removeLayer(layer) { layers.delete(layer); layer.removed = true; } },
    openPersistentFloodPopup(latlng, html) {
      const popup = { latlng, html, removed: false, setContent(value) { this.html = value; }, update() {}, remove() { this.removed = true; layers.delete(this); } };
      popups.push(popup); layers.add(popup); context.persistentFloodPopup = popup; context.persistentDepthQueryContext = null; return popup;
    },
    toast: value => notices.push(value), getStageValue: entry => entry?.stage ?? null,
    sampleRenderedFloodPixel: () => null, getHydraulicPhaseForEntry: () => 'slack',
    getDepthQueryDisplayDepth: () => 3, buildDepthQueryPopupHtml: value => '<div class="depth-query-popup">' + (value == null ? 'N/A' : value) + '</div>',
  });
  load(context, ['formatWaterDepth', 'samplePhysicsDepth', 'handleDepthQueryClick', 'updatePersistentDepthQueryPopup']);
  return { context, popups, notices, layers };
}
await test('A physics point outside coverage is unavailable, while a covered dry pixel remains dry', async () => {
  const outside = physicsFixture();
  await outside.context.handleDepthQueryClick({ latlng: { lat: 41, lng: -74.5 } });
  const outsideText = outside.popups.map(p => p.html).join(' ') + ' ' + outside.notices.join(' ');
  assert.doesNotMatch(outsideText, /Dry in this exact time step/i, 'No coverage is not evidence that a point is dry');
  assert.doesNotMatch(outsideText, /(?:^|[>\s])0(?:\.0+)?\s*(?:in|ft)(?:[<\s]|$)/i, 'No coverage must not display a numeric zero depth');
  assert.match(outsideText, /N\/A|unavailable|outside|coverage/i, 'The user should receive an unavailable/no-coverage result');
  const dry = physicsFixture([0, 0, 0, 255]);
  await dry.context.handleDepthQueryClick({ latlng: { lat: 39.75, lng: -74.75 } });
  assert.equal(dry.popups.length, 1);
  assert.match(dry.popups[0].html, /Dry in this exact time step/i);
  assert.match(dry.popups[0].html, /0\s*in/);
});
await test('A physics popup cannot keep showing its old depth after a committed frame change', async () => {
  const { context, popups, layers } = physicsFixture([1, 48, 1, 255]); // 304 mm, approximately 1 ft.
  await context.handleDepthQueryClick({ latlng: { lat: 39.75, lng: -74.75 } });
  assert.equal(popups.length, 1);
  const popup = popups[0], initialHtml = popup.html;
  assert.ok(layers.has(popup));
  context.floodFrameState = 'loading';
  context.updatePersistentDepthQueryPopup();
  context.currentHourIndex = 1;
  context.currentFloodLayer = { _floodmapperFrame: { entry: context.currentSeriesHours[1], stage: 3, dataMode: 'forecast' } };
  context.floodFrameState = 'ready';
  context.updatePersistentDepthQueryPopup();
  const closed = popup.removed || !layers.has(popup);
  const updated = popup.html !== initialHtml;
  assert.ok(closed || updated, 'The old physics depth must be removed or refreshed when the committed frame changes');
});

await test('Data selection closes a physics popup before awaiting replacement data', async () => {
  const { context, popups, layers } = physicsFixture([1, 48, 1, 255]);
  load(context, ['cancelPendingFloodFrame']);
  await context.handleDepthQueryClick({ latlng: { lat: 39.75, lng: -74.75 } });
  const popup = popups[0];
  assert.ok(layers.has(popup));
  context.cancelPendingFloodFrame(); // data loaders await their network requests after this call
  assert.equal(context.floodFrameState, 'loading');
  assert.ok(popup.removed || !layers.has(popup), 'A popup for the previous frame must not remain over loading or failed data');
  assert.equal(context.persistentDepthQueryContext, null);
});

await test('Clearing unavailable flood data also closes an existing physics popup', async () => {
  const { context, popups, layers } = physicsFixture([1, 48, 1, 255]);
  load(context, ['clearFloodLayer']);
  await context.handleDepthQueryClick({ latlng: { lat: 39.75, lng: -74.75 } });
  const popup = popups[0];
  assert.ok(layers.has(popup));
  context.clearFloodLayer();
  assert.equal(context.floodFrameState, 'unavailable');
  assert.equal(context.currentFloodLayer, null);
  assert.ok(popup.removed || !layers.has(popup), 'A stale physics value must not survive removal of flood data');
  assert.equal(context.persistentDepthQueryContext, null);
});

await test('A delayed physics depth query cannot open an obsolete popup after navigation', async () => {
  const { context, popups } = physicsFixture();
  const gate = deferred(), started = deferred();
  context.samplePhysicsDepth = async () => { started.resolve(); return gate.promise; };
  const query = context.handleDepthQueryClick({ latlng: { lat: 39.75, lng: -74.75 } });
  await started.promise;
  context.lastRenderToken += 1;
  context.currentHourIndex = 1;
  context.currentFloodLayer = { _floodmapperFrame: { entry: context.currentSeriesHours[1], stage: 3, dataMode: 'forecast' } };
  gate.resolve({ wet: true, depthM: 0.3048 });
  await query;
  assert.equal(popups.length, 0, 'An obsolete response must not open a popup over the new timestep');
  assert.equal(context.persistentDepthQueryContext, null);
});

for (const result of results) {
  console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.name}`);
  if (!result.passed) console.log(result.error);
}
console.log(`${results.filter(result => result.passed).length}/${results.length} renderer regression cases passed: ${sourcePath}`);
if (results.some(result => !result.passed)) process.exitCode = 1;
