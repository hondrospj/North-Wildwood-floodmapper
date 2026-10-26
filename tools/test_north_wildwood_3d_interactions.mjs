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

function toggleFixture({ initGate = deferred(), syncGate = null } = {}) {
  const toggle = { classList: classList(), attributes: {}, setAttribute(key, value) { this.attributes[key] = value; } };
  const body = { classList: classList() };
  const actions = [];
  const gl = { getPitch: () => 60 };
  const context = {
    buildingToggleGeneration: 0, mapQueryGeneration: 0, document: { body, getElementById: () => toggle },
    glMap: null, map: null, buildingsLayer: null,
    ensure3dMap: () => initGate.promise,
    setBuildingsEnabled: async value => toggle.classList.toggle('on', Boolean(value)),
    setMapClickMode: () => actions.push('building mode'),
    updateExportBuildingsLayer() {}, updateMapClickModeControl() {}, toast() {},
    syncBuildings3d: () => syncGate ? syncGate.promise : Promise.resolve(),
    focusEnabledBuildings3d: () => actions.push('focus camera'), suspendLeafletVisualLayers() {},
    window: { COUNTY_3D_BUILDINGS: { focus: async () => actions.push('focus buildings') } }
  };
  vm.createContext(context);
  vm.runInContext(wrapper('originalSetBuildingsEnabled', 'originalSetSatelliteEnabled'), context);
  return { context, toggle, actions, initGate, ready() { context.glMap = gl; body.classList.toggle('map-3d-ready', true); initGate.resolve(gl); } };
}
{
  const test = toggleFixture();
  const older = test.context.setBuildingsEnabled(true);
  await test.context.setBuildingsEnabled(false);
  test.ready(); await older;
  assert.equal(test.toggle.classList.contains('on'), false);
  assert.equal(test.toggle.attributes['aria-checked'], 'false');
  assert.deepEqual(test.actions, [], 'An obsolete enable cannot change mode or focus');
}
{
  const test = toggleFixture();
  const older = test.context.setBuildingsEnabled(true);
  await test.context.setBuildingsEnabled(false);
  const latest = test.context.setBuildingsEnabled(true);
  test.ready(); await Promise.all([older, latest]);
  assert.equal(test.toggle.classList.contains('on'), true);
  assert.deepEqual(test.actions, ['building mode', 'focus buildings', 'focus camera']);
}
for (const fail of ['null', 'reject']) {
  const test = toggleFixture();
  const older = test.context.setBuildingsEnabled(true);
  await test.context.setBuildingsEnabled(false);
  if (fail === 'null') test.initGate.resolve(null); else test.initGate.reject(Error('Obsolete failure'));
  await older;
  assert.equal(test.toggle.classList.contains('on'), false, 'An obsolete failure must not reject into the latest toggle handler');
}
{
  const syncGate = deferred(), started = deferred(), test = toggleFixture({ syncGate });
  test.context.syncBuildings3d = () => { started.resolve(); return syncGate.promise; };
  test.ready();
  const older = test.context.setBuildingsEnabled(true);
  await started.promise;
  const latest = test.context.setBuildingsEnabled(false);
  syncGate.resolve(); await Promise.all([older, latest]);
  assert.equal(test.toggle.classList.contains('on'), false);
  assert.ok(!test.actions.some(action => action.startsWith('focus')), 'No late focus after disable during building loading');
}
{
  const test = toggleFixture();
  const current = test.context.setBuildingsEnabled(true);
  test.initGate.resolve(null);
  await assert.rejects(current, /3D buildings could not start/, 'Current failures must still reach the UI');
  await test.context.setBuildingsEnabled(false);
  test.ready();
  test.context.ensure3dMap = async () => test.context.glMap;
  await test.context.setBuildingsEnabled(true);
  assert.equal(test.toggle.classList.contains('on'), true, 'A current initialization failure must allow a successful retry');
  assert.deepEqual(test.actions, ['building mode', 'focus buildings', 'focus camera']);
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
  assert.equal(test.toggle.classList.contains('on'), false);
  assert.ok(!test.actions.some(action => action.startsWith('focus')));
}

function clickFixture() {
  const handlers = {}, requests = [], opened = [], popups = new Set();
  let buildings = true;
  class FakePopup {
    setLngLat() { return this; } setHTML() { return this; } addTo() { return this; }
    on(name, callback) { this[name] = callback; return this; }
    remove() { this.close?.(); }
  }
  const context = {
    glMap: { on(name, ...args) { if (name === 'click') handlers.click = args.at(-1); }, getLayer: () => true, queryRenderedFeatures: () => [{ properties: { modeledFirstFloorNavd88Ft: 7 } }] },
    glPopup: null, lastGlPopupHtml: '', mapQueryGeneration: 0, lastRenderToken: 1, mapClickMode: 'building',
    persistentFloodPopup: null, map: { on() {}, hasLayer: value => popups.has(value), removeLayer: value => popups.delete(value) },
    document: { body: { classList: { contains: () => true } } }, maplibregl: { Popup: FakePopup },
    window: { addEventListener() {} }, layerVisible: () => buildings,
    findParcelFeatureForLocation: () => { const request = deferred(); requests.push(request); return request.promise; },
    openParcelFloodPrompt: feature => opened.push(feature.id), openFallbackBuildingPopup: () => opened.push('fallback'),
    handleDepthQueryClick: () => { ++context.mapQueryGeneration; opened.push('depth'); },
    L: { latLng: (lat, lng) => ({ lat, lng }) }, sync3dViewToLeaflet() {}, syncLeafletViewTo3d() {}, syncGlPopupLayout() {}
  };
  load(context, ['wire3dInteractions', 'showGlPopup', 'closeGlPopup']); context.wire3dInteractions();
  return { context, requests, opened, click: () => handlers.click({ lngLat: { lat: 39.006, lng: -74.8 }, point: { x: 100, y: 100 } }), disable() { buildings = false; } };
}
for (const supersede of ['new click', 'mode', 'frame', 'disable', 'close button', 'programmatic close']) {
  for (const result of ['parcel', 'missing', 'failed']) {
    const test = clickFixture();
    if (supersede.includes('close')) test.context.showGlPopup({ lat: 39, lng: -74.8 }, 'Existing card', 300);
    const older = test.click();
    if (supersede === 'new click') {
      const latest = test.click(); test.requests[1].resolve({ id: 'latest parcel' }); await latest;
    } else if (supersede === 'mode') {
      test.context.mapClickMode = 'depth'; await test.click();
    } else if (supersede === 'frame') ++test.context.lastRenderToken;
    else if (supersede === 'disable') test.disable();
    else if (supersede === 'close button') test.context.glPopup.remove();
    else test.context.closeGlPopup();
    if (result === 'failed') test.requests[0].reject(Error('Old request failed'));
    else test.requests[0].resolve(result === 'parcel' ? { id: 'obsolete parcel' } : null);
    await older;
    assert.deepEqual(test.opened, supersede === 'new click' ? ['latest parcel'] : supersede === 'mode' ? ['depth'] : [], `${supersede}/${result} must discard the obsolete result and fallback`);
  }
}
for (const result of ['parcel', 'missing', 'failed']) {
  const test = clickFixture(), pending = test.click();
  if (result === 'failed') test.requests[0].reject(Error('Current parcel request failed'));
  else test.requests[0].resolve(result === 'parcel' ? { id: 'current parcel' } : null);
  await pending;
  assert.deepEqual(test.opened, [result === 'parcel' ? 'current parcel' : 'fallback']);
}

// Fallback building comparisons close on navigation/unavailable frames, but
// remain open for redraws of the same committed frame and ordinary opacity changes.
{
  const active = new Set();
  const context = {
    fallbackBuildingPopup: null, fallbackBuildingRenderToken: null, lastRenderToken: 10, floodFrameState: 'ready',
    glPopup: null, persistentFloodPopup: null,
    map: { hasLayer: value => active.has(value), removeLayer(value) { active.delete(value); value.removed?.(); if (context.persistentFloodPopup === value) context.persistentFloodPopup = null; } },
    buildBuildingPopupHtml: () => 'building card',
    openPersistentFloodPopup() { const popup = { once(name, callback) { if (name === 'remove') this.removed = callback; } }; active.add(popup); context.persistentFloodPopup = popup; return popup; },
    updatePersistentDepthQueryPopup() {},
    clearFloodLayer() { context.floodFrameState = 'unavailable'; }, syncFloodLayer3d() {}
  };
  load(context, ['openFallbackBuildingPopup', 'closeOutdatedFallbackBuildingPopup']);
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

console.log('3D interaction regressions passed: missing floor/stage values, latest Buildings toggle, parcel click cancellation, and popup frame lifetime.');
