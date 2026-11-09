import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../assets/3d/north-wildwood-3d.js', import.meta.url), 'utf8');
function extract(name) {
  const start = source.search(new RegExp('^  (?:async )?function ' + name + '\\(', 'm'));
  assert.ok(start >= 0, `Missing function ${name}`);
  return source.slice(start, source.indexOf('\n  }', start) + 4);
}
function wrapper(first, next) {
  const start = source.indexOf('  var ' + first + ' =');
  const end = source.indexOf('  var ' + next + ' =', start);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}
function load(context, names) {
  vm.createContext(context);
  for (const name of names) vm.runInContext(extract(name), context);
  return context;
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function classList() {
  const values = new Set();
  return { contains: name => values.has(name), toggle(name, value) { value ? values.add(name) : values.delete(name); } };
}

// Unknown elevations must never be coerced to a real zero-foot occupied floor.
const popup = load({
  getSelectedStageNavd88: () => 5,
  escapeTownAddressHtml: value => String(value).replaceAll('<', '&lt;'),
  formatWaterDepth: value => value.toFixed(1) + ' ft'
}, ['finiteBuildingNumber', 'buildBuildingPopupHtml']);
for (const value of [null, undefined, '', '  ', false, [], {}, NaN, Infinity, 'unavailable']) {
  const html = popup.buildBuildingPopupHtml({ modeledFirstFloorNavd88Ft: value, foundationHeightFt: value });
  assert.match(html, /Estimated occupied-floor elevation is unavailable/);
  assert.doesNotMatch(html, /Current water is/);
  assert.match(html, /<strong>—<\/strong>/);
}
const actualBuildings = JSON.parse(fs.readFileSync(new URL('../assets/3d/NorthWildwoodBuildings3D.geojson', import.meta.url), 'utf8'));
const actualUnknown = actualBuildings.features.find(feature => feature.properties.modeledFirstFloorNavd88Ft === null);
assert.ok(actualUnknown, 'Exercise a real unmatched building footprint');
assert.doesNotMatch(popup.buildBuildingPopupHtml(actualUnknown.properties), /Current water is/);
for (const value of [null, undefined, '', ' ', NaN, Infinity]) {
  popup.getSelectedStageNavd88 = () => value;
  assert.match(popup.buildBuildingPopupHtml({ modeledFirstFloorNavd88Ft: 0 }), /Choose a water level/);
}
popup.getSelectedStageNavd88 = () => 0;
assert.match(popup.buildBuildingPopupHtml({ modeledFirstFloorNavd88Ft: '0', foundationHeightFt: 0 }), /at the estimated occupied floor/);
popup.getSelectedStageNavd88 = () => 5;
assert.match(popup.buildBuildingPopupHtml({ modeledFirstFloorNavd88Ft: 0 }), /5.0 ft above/);

// The Esri wrapper's child renderer does not exist until metadata is ready.
const configuration = fs.readFileSync(new URL('./app/runtime/00-configuration.js', import.meta.url), 'utf8');
const geometryRuntime = fs.readFileSync(new URL('./app/runtime/10-map-geometry-and-layers.js', import.meta.url), 'utf8');
const disableBuildingInfo = geometryRuntime.match(/^    function disableBuildingInfo\([\s\S]+?^    }/m)?.[0];
assert.ok(disableBuildingInfo, 'Exercise the shared building interaction cleanup');
const buildingLayerFactory = configuration.match(/^    function makeEsriBuildingForegroundLayer\([\s\S]+?^    }/m)?.[0];
assert.ok(buildingLayerFactory, 'Exercise the actual Esri foreground layer factory');

function esriLayerFixture(ready = false) {
  const renderer = {};
  const operations = [];
  const pending = new Set();
  const map = {
    addLayer(layer) { assert.equal(layer, renderer); operations.push('attach'); },
    removeLayer(layer) { assert.equal(layer, renderer); operations.push('detach'); }
  };
  const esriLayer = {
    _ready: ready,
    _maplibreGL: ready ? renderer : undefined,
    onAdd(targetMap) {
      const attach = () => targetMap.addLayer(this._maplibreGL);
      if (this._ready) attach();
      else this.once('ready', attach);
    },
    onRemove(targetMap) { targetMap.removeLayer(this._maplibreGL); },
    once(event, callback) { assert.equal(event, 'ready'); pending.add(callback); },
    off(event, callback) { assert.equal(event, 'ready'); pending.delete(callback); }
  };
  const L = { esri: { Vector: { vectorTileLayer: () => esriLayer } } };
  const layer = vm.runInNewContext(buildingLayerFactory + '\nmakeEsriBuildingForegroundLayer()', {
    window: { L }, L, ESRI_API_KEY: '', ESRI_OSM_VECTOR_TILE_URL: 'test', styleEsriBuildingForeground() {}
  });
  return {
    layer, map, operations, pending,
    finishLoading() {
      esriLayer._ready = true;
      esriLayer._maplibreGL = renderer;
      for (const callback of pending) {
        pending.delete(callback);
        callback.call(esriLayer);
      }
    }
  };
}

for (const reenable of [false, true]) {
  const test = esriLayerFixture();
  test.layer.onAdd(test.map);
  assert.equal(test.pending.size, 1);
  test.layer.onRemove(test.map);
  assert.equal(test.pending.size, 0, 'Removing a pending layer cancels its exact ready handler');
  if (reenable) test.layer.onAdd(test.map);
  test.finishLoading();
  assert.deepEqual(test.operations, reenable ? ['attach'] : [], 'Late readiness honors only the latest toggle');
  if (reenable) {
    test.layer.onRemove(test.map);
    assert.deepEqual(test.operations, ['attach', 'detach']);
  }
}
{
  const test = esriLayerFixture(true);
  test.layer.onAdd(test.map);
  test.layer.onRemove(test.map);
  assert.equal(test.pending.size, 0);
  assert.deepEqual(test.operations, ['attach', 'detach'], 'A ready layer attaches and detaches immediately');
}

function toggleFixture({ pitch = 0, parcels = false, structures = false } = {}) {
  const toggle = { classList: classList(), attributes: {}, setAttribute(key, value) { this.attributes[key] = value; } };
  const body = { classList: classList() };
  const visibleLayers = new Set();
  const otherToggles = {
    parcelsToggle: { classList: { contains: () => parcels } },
    nsiStructuresToggle: { classList: { contains: () => structures } }
  };
  const actions = [];
  const gl = { getPitch: () => pitch, jumpTo: () => actions.push('camera move') };
  const context = {
    buildingToggleGeneration: 0, buildingVisibilityPreference: null, mapQueryGeneration: 0, mapClickMode: 'depth',
    document: { body, getElementById: id => id === 'buildingsToggle' ? toggle : otherToggles[id], querySelector: () => ({ click: () => actions.push('view toggle') }) },
    glMap: null, glStyleReady: false, buildingsLayer: null,
    map: { hasLayer: layer => visibleLayers.has(layer), removeLayer(layer) { visibleLayers.delete(layer); layer.removed?.(); } },
    fallbackBuildingPopup: null, persistentFloodPopup: null, persistentDepthQueryContext: null,
    map3dReady: () => context.glStyleReady,
    ensure3dMap() { throw Error('Buildings must not initialize the native renderer'); },
    setBuildingsEnabled: async value => {
      actions.push(value ? 'Leaflet on' : 'Leaflet off');
      toggle.classList.toggle('on', Boolean(value));
      toggle.setAttribute('aria-checked', String(Boolean(value)));
    },
    setMapClickMode: mode => { context.mapClickMode = mode; actions.push(`${mode} mode`); },
    updateExportBuildingsLayer() {}, updateMapClickModeControl() {}, toast() {},
    syncBuildings3d: async () => actions.push('sync buildings'),
    focusEnabledBuildings3d: () => actions.push('focus camera'), suspendLeafletVisualLayers() {},
    window: { COUNTY_3D_BUILDINGS: { focus: async () => actions.push('focus buildings') } }
  };
  vm.createContext(context);
  vm.runInContext(disableBuildingInfo, context);
  vm.runInContext(wrapper('originalSetBuildingsEnabled', 'originalSetSatelliteEnabled'), context);
  return {
    context, toggle, actions, visibleLayers,
    ready() {
      context.glMap = gl;
      context.glStyleReady = true;
      body.classList.toggle('map-3d-ready', true);
    }
  };
}
{
  const test = toggleFixture();
  await test.context.setBuildingsEnabled(true);
  assert.equal(test.toggle.attributes['aria-checked'], 'true');
  assert.equal(test.context.glMap, null, 'The Buildings switch works before native map startup');
  await test.context.setBuildingsEnabled(false);
  assert.equal(test.toggle.attributes['aria-checked'], 'false');
  assert.deepEqual(test.actions, ['Leaflet on', 'Leaflet off']);
  assert.equal(test.context.buildingVisibilityPreference, false, 'Explicit off owns the next manual 3D entry');
}
for (const pitch of [0, 60]) {
  const test = toggleFixture({ pitch });
  test.ready();
  await test.context.setBuildingsEnabled(true);
  assert.equal(test.toggle.attributes['aria-checked'], 'true');
  await test.context.setBuildingsEnabled(false);
  assert.equal(test.toggle.attributes['aria-checked'], 'false');
  assert.equal(test.context.glMap.getPitch(), pitch);
  assert.deepEqual(test.actions, ['building mode', 'sync buildings', 'depth mode', 'sync buildings'],
    'Buildings selects Building Info and updates native layers without touching the camera');
}
for (const structures of [true, false]) {
  const test = toggleFixture({ pitch: 60, parcels: true, structures });
  test.ready();
  await test.context.setBuildingsEnabled(true);
  const popup = { removed() { test.context.fallbackBuildingPopup = null; } };
  test.context.fallbackBuildingPopup = popup;
  test.visibleLayers.add(popup);
  await test.context.setBuildingsEnabled(false);
  assert.equal(test.context.mapClickMode, structures ? 'building' : 'parcel');
  assert.ok(!test.visibleLayers.has(popup), 'A native fallback roof popup must close when its Buildings layer turns off');
}
{
  const syncGate = deferred(), started = deferred(), test = toggleFixture();
  test.context.syncBuildings3d = () => { started.resolve(); return syncGate.promise; };
  test.ready();
  const older = test.context.setBuildingsEnabled(true);
  await started.promise;
  const latest = test.context.setBuildingsEnabled(false);
  syncGate.resolve();
  await Promise.all([older, latest]);
  assert.equal(test.toggle.classList.contains('on'), false);
  assert.equal(test.context.buildingVisibilityPreference, false);
  assert.deepEqual(test.actions, ['building mode', 'depth mode']);
}
{
  const test = toggleFixture();
  test.ready();
  const sync = test.context.syncBuildings3d;
  test.context.syncBuildings3d = async () => { throw Error('Building asset failed'); };
  await assert.rejects(test.context.setBuildingsEnabled(true), /Building asset failed/, 'Current failures reach the UI');
  test.context.syncBuildings3d = sync;
  await test.context.setBuildingsEnabled(false, { rollback: true });
  assert.equal(test.context.buildingVisibilityPreference, true, 'Failure rollback preserves the explicit on preference');
  await test.context.setBuildingsEnabled(true);
  assert.equal(test.toggle.classList.contains('on'), true, 'A current asset failure permits a successful retry');
  assert.deepEqual(test.actions.filter(action => action === 'sync buildings'), ['sync buildings', 'sync buildings']);
}
{
  const test = toggleFixture(), failedSync = deferred(), started = deferred();
  let calls = 0;
  test.ready();
  test.context.syncBuildings3d = () => {
    if (++calls === 1) { started.resolve(); return failedSync.promise; }
    return Promise.resolve();
  };
  const older = test.context.setBuildingsEnabled(true);
  await started.promise;
  await test.context.setBuildingsEnabled(false);
  failedSync.reject(Error('Obsolete building asset failure'));
  await older;
  assert.equal(test.toggle.classList.contains('on'), false, 'An obsolete failure cannot roll back the latest choice');
  assert.deepEqual(test.actions, ['building mode', 'depth mode']);
}

const clickedFootprintId = 'clicked-footprint';
const matchedParcel = id => ({ id, properties: { nsi2026FootprintId: clickedFootprintId } });

function clickFixture(pitch = 60) {
  const handlers = {}, requests = [], opened = [], queriedLayers = [], popups = new Set();
  const visibleLayer = pitch > 10 ? 'nw-3d-buildings' : 'nw-2d-buildings';
  let buildings = true;
  class FakePopup {
    setLngLat() { return this; } setHTML() { return this; } addTo() { return this; }
    getElement() { return null; }
    on(name, callback) { this[name] = callback; return this; }
    remove() { this.close?.(); }
  }
  const context = {
    glMap: {
      on(name, ...args) { if (name === 'click') handlers.click = args.at(-1); },
      getLayer: () => true,
      getLayoutProperty: id => id === visibleLayer ? 'visible' : 'none',
      getPitch: () => pitch,
      queryRenderedFeatures(point, { layers }) {
        queriedLayers.push(...layers);
        return layers.includes(visibleLayer)
          ? [{ properties: { footprintId: clickedFootprintId, modeledFirstFloorNavd88Ft: 7 } }]
          : [];
      }
    },
    glPopup: null, lastGlPopupHtml: '', mapQueryGeneration: 0, lastRenderToken: 1, mapClickMode: 'building',
    persistentFloodPopup: null, map: { on() {}, hasLayer: value => popups.has(value), removeLayer: value => popups.delete(value) },
    document: { body: { classList: { contains: () => true } } }, maplibregl: { Popup: FakePopup },
    window: { addEventListener() {} }, layerVisible: () => buildings,
    resolveClickedBuildingParcel3d: feature => {
      const request = deferred(); requests.push(request);
      return request.promise.then(parcel => ({feature, point: [-74.8, 39.006], parcel}));
    },
    openParcelFloodPrompt: feature => opened.push(feature.id), openFallbackBuildingPopup: () => opened.push('fallback'),
    beginMapQuery: () => ++context.mapQueryGeneration,
    handleDepthQueryClick: () => { ++context.mapQueryGeneration; opened.push('depth'); },
    L: { latLng: (lat, lng) => ({ lat, lng }) }, sync3dViewToLeaflet() {}, syncLeafletViewTo3d() {}, syncGlPopupLayout() {}
  };
  load(context, ['resize3dView', 'wire3dInteractions', 'showGlPopup', 'closeGlPopup', 'buildingsShouldRenderForCamera']); context.wire3dInteractions();
  return { context, requests, opened, queriedLayers, click: () => handlers.click({ lngLat: { lat: 39.006, lng: -74.8 }, point: { x: 100, y: 100 } }), disable() { buildings = false; } };
}
for (const supersede of ['new click', 'mode', 'frame', 'disable', 'close button', 'programmatic close']) {
  for (const result of ['parcel', 'missing', 'failed']) {
    const test = clickFixture();
    if (supersede.includes('close')) test.context.showGlPopup({
      getLatLng: () => ({ lat: 39, lng: -74.8 }), getContent: () => 'Existing card', once() {}
    }, 300);
    const older = test.click();
    if (supersede === 'new click') {
      const latest = test.click(); test.requests[1].resolve(matchedParcel('latest parcel')); await latest;
    } else if (supersede === 'mode') {
      test.context.mapClickMode = 'depth'; await test.click();
    } else if (supersede === 'frame') ++test.context.lastRenderToken;
    else if (supersede === 'disable') test.disable();
    else if (supersede === 'close button') test.context.glPopup.remove();
    else test.context.closeGlPopup();
    if (result === 'failed') test.requests[0].reject(Error('Old request failed'));
    else test.requests[0].resolve(result === 'parcel' ? matchedParcel('obsolete parcel') : null);
    await older;
    assert.deepEqual(test.opened, supersede === 'new click' ? ['latest parcel'] : supersede === 'mode' ? ['depth'] : [], `${supersede}/${result} must discard the obsolete result and fallback`);
  }
}
for (const result of ['parcel', 'missing', 'failed']) {
  const test = clickFixture(), pending = test.click();
  if (result === 'failed') test.requests[0].reject(Error('Current parcel request failed'));
  else test.requests[0].resolve(result === 'parcel' ? matchedParcel('current parcel') : null);
  await pending;
  assert.deepEqual(test.opened, [result === 'parcel' ? 'current parcel' : 'fallback']);
}

{
  const test = clickFixture(0), pending = test.click();
  assert.deepEqual(test.queriedLayers, ['nw-2d-buildings']);
  test.requests[0].resolve(matchedParcel('flat parcel'));
  await pending;
  assert.deepEqual(test.opened, ['flat parcel'], 'Flat footprints open Building Info at the current pitch');
}

// Fallback building comparisons close on navigation/unavailable frames, but
// remain open for redraws of the same committed frame and ordinary opacity changes.
{
  const active = new Set();
  const context = {
    fallbackBuildingPopup: null, fallbackBuildingRenderToken: null, pendingFlood3dRequest: null, lastRenderToken: 10, floodFrameState: 'ready',
    glPopup: null, persistentFloodPopup: null,
    map: { hasLayer: value => active.has(value), removeLayer(value) { active.delete(value); value.removed?.(); if (context.persistentFloodPopup === value) context.persistentFloodPopup = null; } },
    buildBuildingPopupHtml: () => 'building card',
    openPersistentFloodPopup() { const popup = { once(name, callback) { if (name === 'remove') this.removed = callback; } }; active.add(popup); context.persistentFloodPopup = popup; return popup; },
    updatePersistentDepthQueryPopup() {},
    clearFloodLayer() { context.floodFrameState = 'unavailable'; }, syncFloodLayer3d() {}
  };
  load(context, ['openFallbackBuildingPopup', 'closeOutdatedFallbackBuildingPopup', 'discardObsoleteFloodFrame3d']);
  const updateStart = source.indexOf('  var originalUpdatePersistentDepthQueryPopup =');
  vm.runInContext(source.slice(updateStart, source.indexOf('  window.NORTH_WILDWOOD_3D =', updateStart)), context);
  vm.runInContext(wrapper('originalClearFloodLayer', 'originalApplyOverlayOpacity'), context);
  const first = context.openFallbackBuildingPopup({ lat: 39, lng: -74.8 }, {});
  context.updatePersistentDepthQueryPopup();
  assert.ok(active.has(first), 'A same-frame redraw must preserve the fallback card');
  ++context.lastRenderToken;
  context.floodFrameState = 'loading';
  context.updatePersistentDepthQueryPopup();
  assert.ok(!active.has(first), 'Time navigation must close a frame-specific building comparison');
  assert.equal(context.fallbackBuildingPopup, null);
  context.floodFrameState = 'ready';
  const second = context.openFallbackBuildingPopup({ lat: 39, lng: -74.8 }, {});
  context.clearFloodLayer();
  assert.ok(!active.has(second), 'An unavailable frame must also close the fallback card');
  context.floodFrameState = 'ready';
  const third = context.openFallbackBuildingPopup({ lat: 39, lng: -74.8 }, {});
  context.map.removeLayer(third);
  assert.equal(context.fallbackBuildingPopup, null, 'Closing a card releases its lifetime record');
}

console.log('3D interaction regressions passed: missing floor/stage values, deferred Esri layer removal, camera-independent Buildings toggle, flat parcel clicks, parcel click cancellation, and popup frame lifetime.');
