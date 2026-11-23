import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../assets/3d/north-wildwood-3d.js', import.meta.url), 'utf8');
function declaration(name) {
  const start = source.search(new RegExp('^  (?:async )?function ' + name + '\\(', 'm'));
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n  }', start) + 4);
}

let checks = 0;
for (const outcome of ['allocation-failure', 'native-failure', 'ready', 'no-water']) {
  const classes = new Set(), images = [], maps = [];
  let suspended = 0, allocations = 0, initialPlane = null;
  const native = { url: 'selected', image: {}, loaded: () => true };
  class Renderer {
    constructor() { maps.push(this); }
    on() {} off() {} once(_name, callback) { queueMicrotask(callback); }
    getPitch() { return 0; } getSource() { return native; }
    remove() { this.removed = true; } resize() {}
  }
  const c = vm.createContext({
    glMap: null, glMapPromise: null, glMapInitialization: null, glStyleReady: false,
    mapStylePromise: null, buildingDataPromise: null, floodPlaneLayer: null,
    floodPlaneSlotId: 'nw-flood-overlay', pendingFlood3dRequest: null, retryFloodRecovery3d: null,
    currentFloodLayer: outcome === 'no-water' ? null : { _url: 'selected' },
    Image: class { constructor() { images.push(this); } async decode() {} },
    window: { setTimeout, clearTimeout, matchMedia: () => ({ matches: false }) },
    document: { body: { dataset: {}, classList: { add: name => classes.add(name), remove: name => classes.delete(name) } }, getElementById: () => ({}) },
    map: { getCenter: () => ({ lng: 0, lat: 0 }), getZoom: () => 14, invalidateSize() {} },
    maplibregl: { Map: Renderer }, MAP_MAX_ZOOM: 22, GRAPHICS_FALLBACK_NOTICE: 'fallback',
    DEFAULT_PITCH: 0, DEFAULT_BEARING: 0, TERRAIN_EXAGGERATION: 4,
    townAddressMarker: null, townAddressPopup: null, console: { warn() {} },
    requestAnimationFrame: callback => queueMicrotask(callback), loadMapLibreRuntime: async () => {},
    load3dStyle: async () => ({}), disposePendingFloodFrame3d() {},
    waitForNativeFloodImage3d: async () => outcome !== 'native-failure',
    syncBuildings3d: async () => { if (initialPlane) await initialPlane.whenReady(); },
    suspendLeafletVisualLayers: () => { suspended++; }
  });
  for (const name of ['schedulePersistentNavControlSync', 'syncFloodPresentationMode', 'syncPersistentNavControl',
    'addCore3dLayers', 'wire3dInteractions', 'wire3dContextRecovery', 'syncBoundary3d', 'syncSatellite3d',
    'syncRoadLabels3d', 'syncParcels3d', 'syncNsi3d', 'updateDiagnostics']) c[name] = () => {};
  for (const name of ['createFlatFloodPlane', 'floodDrapeIds', 'ensure3dMap']) vm.runInContext(declaration(name), c);
  c.syncFloodLayer3d = () => {
    if (outcome === 'no-water') return;
    const plane = initialPlane = c.floodPlaneLayer = c.createFlatFloodPlane({ url: 'selected' });
    plane.gl = {
      getParameter: () => null, activeTexture() {}, getError: () => 0, NO_ERROR: 0,
      pixelStorei() {}, bindTexture() {}, texParameteri() {}, texImage2D() {}, generateMipmap() {},
      deleteTexture() {}, isContextLost: () => false,
      createTexture() { allocations++; return outcome === 'allocation-failure' ? null : {}; }
    };
    plane.texture = {};
    plane.updateGeometry = () => {};
    plane.loadTexture('selected');
    queueMicrotask(() => images[0].onload());
  };
  const renderer = await c.ensure3dMap();
  if (outcome === 'allocation-failure' || outcome === 'native-failure') {
    assert.equal(allocations, 1, 'Exercise the actual failed candidate GPU allocation');
    assert.equal(initialPlane.textureReady, outcome === 'native-failure');
    assert.equal(renderer, null, 'Failed initial water cannot be certified as a complete renderer');
    assert.equal(c.glMap, null);
    assert.equal(maps[0].removed, true);
    assert.equal(classes.has('map-3d-ready'), false);
    assert.equal(suspended, 0, 'A failed first flood plane must leave the working Leaflet visuals mounted');
  } else {
    assert.ok(renderer);
    assert.equal(classes.has('map-3d-ready'), true);
    assert.equal(suspended, 1);
    assert.equal(outcome === 'no-water' ? allocations : initialPlane.textureReady, outcome === 'no-water' ? 0 : true);
  }
  checks++;
}

for (const outcome of ['ready', 'water-failed', 'retired-map', 'dependency-failed']) {
  const map = {}, c = vm.createContext({
    glMap: map, glStyleReady: true, preload3dGeneration: 0,
    floodPlaneLayer: { whenReady: async () => outcome !== 'water-failed' },
    loadMapLibreRuntime: async () => { if (outcome === 'dependency-failed') throw new Error('Dependency unavailable'); },
    load3dStyle: async () => {}, loadBuildingData: async () => {},
    ensure3dMap: async () => map,
    waitFor3dMapIdle: async () => { if (outcome === 'retired-map') c.glMap = null; },
    buildingData: null, TERRAIN_EXAGGERATION: 4, document: { body: { dataset: {} } }
  });
  vm.runInContext(declaration('preload3dAssets'), c);
  const job = c.preload3dAssets({ initialize: true });
  assert.equal(c.document.body.dataset.map3dFullyPreloaded, 'loading');
  if (outcome === 'ready') {
    const ready = await job;
    assert.equal(ready.initialized, true);
    assert.equal(c.document.body.dataset.map3dFullyPreloaded, 'interactive');
  } else {
    await assert.rejects(job);
    assert.equal(c.document.body.dataset.map3dFullyPreloaded, 'failed');
  }
  checks++;
}

function deferred() {
  let resolve;
  const promise = new Promise(ready => { resolve = ready; });
  return { promise, resolve };
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
for (const obsoleteReady of [false, true]) for (const currentState of ['loading', 'interactive']) {
  const water = [deferred(), deferred()], map = {};
  let waits = 0;
  const c = vm.createContext({
    glMap: map, glStyleReady: true, preload3dGeneration: 0,
    floodPlaneLayer: { whenReady: () => water[waits++].promise },
    loadMapLibreRuntime: async () => {}, load3dStyle: async () => {}, loadBuildingData: async () => {},
    ensure3dMap: async () => map, waitFor3dMapIdle: async () => {},
    buildingData: null, TERRAIN_EXAGGERATION: 4, document: { body: { dataset: {} } }
  });
  vm.runInContext(declaration('preload3dAssets'), c);
  const obsolete = c.preload3dAssets({ initialize: true });
  const rejected = assert.rejects(obsolete);
  await flush();
  const current = c.preload3dAssets({ initialize: true });
  await flush();
  assert.equal(waits, 2);
  assert.equal(c.preload3dGeneration, 2);
  assert.equal(c.document.body.dataset.map3dFullyPreloaded, 'loading');
  if (currentState === 'interactive') {
    water[1].resolve(true);
    await current;
  }
  water[0].resolve(obsoleteReady);
  await rejected;
  assert.equal(c.document.body.dataset.map3dFullyPreloaded, currentState,
    `Obsolete ${obsoleteReady ? 'success' : 'failure'} cannot overwrite a newer ${currentState} preload`);
  if (currentState === 'loading') {
    water[1].resolve(true);
    await current;
  }
  assert.equal(c.document.body.dataset.map3dFullyPreloaded, 'interactive');
  checks++;
}
console.log(`${checks} initial 3D water cases passed: real GPU failure retains Leaflet, successful/empty entry and truthful preload readiness.`);
