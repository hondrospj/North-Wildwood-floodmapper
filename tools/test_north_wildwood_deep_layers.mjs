import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

// Optional repository root supports proving these cases against the baseline.
const root = path.resolve(process.argv[2] || new URL('..', import.meta.url).pathname);
const source25 = fs.readFileSync(path.join(root, 'tools/app/runtime/25-structures-and-parcels.js'), 'utf8');
const source10 = fs.readFileSync(path.join(root, 'tools/app/runtime/10-map-geometry-and-layers.js'), 'utf8');
const source27 = fs.readFileSync(path.join(root, 'tools/app/runtime/27-mobile-and-address.js'), 'utf8');
const source3d = fs.readFileSync(path.join(root, 'assets/3d/north-wildwood-3d.js'), 'utf8');
const results = [];
function extract(source, name) {
  const match = source.match(new RegExp('^    (?:async )?function ' + name + '\\([^\\n]*\\) \\{\\n.*?^    \\}', 'ms'));
  assert.ok(match, `Missing source function ${name}`);
  return match[0];
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
async function test(name, run) { try { await run(); results.push({ name, passed: true }); } catch (error) { results.push({ name, passed: false, error: error.stack }); } }

function fixture({ metadataGate, nsiGate, wrappers = false } = {}) {
  const layers = new Set(), images = [], timers = new Map(), notices = [], elements = new Map(), syncs = [];
  let nextTimer = 0, metadataRequests = 0, nsiRequests = 0;
  function element(id) {
    if (!elements.has(id)) {
      const classes = new Set(), listeners = new Map();
      elements.set(id, { attrs: {}, hidden: false, textContent: '',
        classList: { contains: name => classes.has(name), toggle(name, force = !classes.has(name)) { if (force) classes.add(name); else classes.delete(name); return force; } },
        setAttribute(name, value) { this.attrs[name] = value; },
        addEventListener(name, fn) { listeners.set(name, fn); },
        click() { listeners.get('click')?.({}); }
      });
    }
    return elements.get(id);
  }
  function overlay() {
    const handlers = new Map();
    const image = { naturalWidth: 0, naturalHeight: 0, complete: false, src: 'parcel.png', decode: async () => {} };
    const layer = { image, addCount: 0,
      on(type, fn) { if (!handlers.has(type)) handlers.set(type, new Set()); handlers.get(type).add(fn); return this; },
      off(type, fn) { handlers.get(type)?.delete(fn); return this; },
      addTo() { layers.add(this); this.addCount++; return this; },
      getElement: () => image,
      fire(type) { if (type === 'load') { image.complete = true; image.naturalWidth = 5465; image.naturalHeight = 7060; } for (const fn of [...handlers.get(type) || []]) fn(); },
      listenerCount: () => [...handlers.values()].reduce((count, values) => count + values.size, 0)
    };
    images.push(layer); return layer;
  }
  const features = [{ geometry: { type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]] }, properties: { centroidLat: 1, centroidLon: 1 } }];
  const map = { hasLayer: layer => layers.has(layer), removeLayer: layer => layers.delete(layer) };
  const context = vm.createContext({ console, Promise, Error, Number, Boolean,
    window: { setTimeout(fn, ms) { timers.set(++nextTimer, { fn, ms }); return nextTimer; }, clearTimeout: id => timers.delete(id) },
    document: { getElementById: element }, map, ensureMap() {}, toast: value => notices.push(value),
    parcelLoadPromise: null, parcelsLayer: null, parcelFeatures: [], parcelLayerGeneration: 0,
    nsiStructuresLayer: null, nsiStructureLoadPromise: null, nsiStructureFeatures: [], nsiStructureRenderer: null, nsiLayerGeneration: 0,
    mapQueryGeneration: 0, mapClickMode: 'depth', persistentFloodPopup: null,
    currentFloodLayer: null, currentSeriesHours: [{ stage: 4 }], currentHourIndex: 0,
    normalizeStageValue: value => value, getStageValue: entry => entry?.stage,
    PARCELS_URL: 'parcels.json', PARCEL_BOUNDARY_PNG_URL: 'parcel.png', NSI_STRUCTURES_URL: 'nsi.json',
    createHydraulicImageOverlay: overlay,
    async fetchJson(url) {
      if (url === 'nsi.json') { nsiRequests++; await nsiGate?.promise; return { metadata: { schema: 'nsi-2026-first-floor-v1' }, features: [] }; }
      metadataRequests++; await metadataGate?.promise; return { features };
    },
    L: { canvas: () => ({}), geoJSON: () => ({ addTo() { layers.add(this); return this; }, eachLayer() {} }) },
    updateMapClickModeControl() { element('mapClickDepthBtn').setAttribute('aria-pressed', String(context.mapClickMode === 'depth')); },
    updateNsiStructureImpactLayer() {}, setSatelliteEnabled() {}, updateRoadLayerAppearance() {}, setBuildingsEnabled: async () => {}
  });
  vm.runInContext(source25, context);
  // Use the production interaction setter and toggle error handlers as well.
  vm.runInContext(extract(source10, 'setMapClickMode'), context);
  vm.runInContext(extract(source27, 'wireLayerToggles'), context);
  context.wireLayerToggles();
  if (wrappers) {
    for (const name of ['Parcels', 'NsiStructures']) {
      const match = source3d.match(new RegExp('  var originalSet' + name + 'Enabled = set' + name + 'Enabled;\\n  set' + name + 'Enabled = async function \\(\\) \\{[\\s\\S]*?\\n  \\};'));
      assert.ok(match, `${name} 3D wrapper`);
      vm.runInContext(match[0], context);
    }
    context.syncParcels3d = () => syncs.push(['parcels', element('parcelsToggle').attrs['aria-checked']]);
    context.syncNsi3d = () => syncs.push(['nsi', element('nsiStructuresToggle').attrs['aria-checked']]);
    context.suspendLeafletVisualLayers = () => {};
  }
  return { context, element, layers, images, timers, notices, syncs,
    get metadataRequests() { return metadataRequests; }, get nsiRequests() { return nsiRequests; },
    expire() { for (const { fn, ms } of [...timers.values()]) { assert.equal(ms, 20000); fn(); } }
  };
}

await test('Parcel matching loads metadata without requesting its boundary image', async () => {
  const f = fixture();
  assert.ok(await f.context.findParcelFeatureForLocation(1, 1));
  assert.equal(f.metadataRequests, 1); assert.equal(f.layers.size, 0); assert.equal(f.timers.size, 0);
});
await test('A failed parcel image reports failure and a healthy toggle retry loads a new image', async () => {
  const f = fixture(); f.element('parcelsToggle').click(); await flush();
  const failed = f.images[0]; failed.fire('error'); await flush();
  assert.equal(f.element('parcelsToggle').attrs['aria-checked'], 'false');
  assert.equal(f.layers.has(failed), false); assert.equal(f.timers.size, 0);
  assert.match(f.notices.at(-1), /Parcels.*try again/i);
  assert.ok(await f.context.findParcelFeatureForLocation(1, 1), 'Matching must remain usable after an image failure');
  f.element('parcelsToggle').click(); await flush(); const replacement = f.images.at(-1);
  assert.notEqual(replacement, failed, 'Retry must replace the failed HTML image');
  replacement.fire('load'); await flush();
  assert.equal(f.element('parcelsToggle').attrs['aria-checked'], 'true');
  assert.equal(f.layers.has(replacement), true); assert.equal(f.metadataRequests, 1);
  assert.equal(f.timers.size, 0); assert.equal(replacement.listenerCount(), 0);
});
await test('Enabling Parcels waits for image decode rather than resolving after GeoJSON', async () => {
  const f = fixture(), decode = deferred(); let settled = false;
  const pending = f.context.setParcelsEnabled(true).then(() => { settled = true; }); await flush();
  assert.equal(settled, false); f.images[0].image.decode = () => decode.promise; f.images[0].fire('load'); await flush();
  assert.equal(settled, false); decode.resolve(); await pending; assert.equal(settled, true);
});
await test('A stalled image times out and a late retired-image event cannot evict a successful retry', async () => {
  const f = fixture(); f.element('parcelsToggle').click(); await flush(); const retired = f.images[0];
  f.expire(); await flush(); assert.equal(f.element('parcelsToggle').attrs['aria-checked'], 'false');
  assert.match(f.notices.at(-1), /too long/); assert.equal(retired.image.src, '');
  f.element('parcelsToggle').click(); await flush(); const replacement = f.images.at(-1); replacement.fire('load'); await flush();
  retired.fire('error'); retired.fire('load'); await flush();
  assert.equal(f.context.parcelsLayer, replacement); assert.equal(f.layers.has(replacement), true);
  assert.equal(f.element('parcelsToggle').attrs['aria-checked'], 'true');
});
await test('The same deadline bounds stalled image decoding and isolates its late completion', async () => {
  const f = fixture(), decode = deferred(); f.element('parcelsToggle').click(); await flush();
  const retired = f.images[0]; retired.image.decode = () => decode.promise; retired.fire('load'); await flush();
  f.expire(); await flush(); f.element('parcelsToggle').click(); await flush();
  const replacement = f.images.at(-1); replacement.fire('load'); await flush(); decode.resolve(); await flush();
  assert.equal(f.context.parcelsLayer, replacement); assert.equal(f.layers.has(retired), false);
  assert.equal(f.element('parcelsToggle').attrs['aria-checked'], 'true');
});
await test('An image decode rejection uses the normal failure UI and releases its handlers', async () => {
  const f = fixture(); f.element('parcelsToggle').click(); await flush(); const layer = f.images[0];
  layer.image.decode = async () => { throw Error('Corrupt image'); }; layer.fire('load'); await flush();
  assert.equal(f.element('parcelsToggle').attrs['aria-checked'], 'false'); assert.equal(layer.listenerCount(), 0); assert.equal(f.layers.size, 0);
});
await test('Disabling before metadata arrives cannot start a boundary-image request', async () => {
  const metadataGate = deferred(), f = fixture({ metadataGate }); const pending = f.context.setParcelsEnabled(true);
  await f.context.setParcelsEnabled(false); metadataGate.resolve(); await pending;
  assert.equal(f.layers.size, 0); assert.equal(f.timers.size, 0); assert.equal(f.element('parcelsToggle').attrs['aria-checked'], 'false');
});
await test('Rapid on/off/on shares the pending image and only the latest toggle owns completion', async () => {
  const f = fixture(); const old = f.context.setParcelsEnabled(true); await flush(); const layer = f.images[0];
  await f.context.setParcelsEnabled(false); const latest = f.context.setParcelsEnabled(true); await flush();
  assert.equal(f.images.length, 1); assert.equal(f.layers.has(layer), true); layer.fire('load'); await Promise.all([old, latest]);
  assert.equal(f.element('parcelsToggle').attrs['aria-checked'], 'true'); assert.equal(f.layers.has(layer), true);
});
await test('A shared image failure after rapid on/off/on belongs only to the latest enable', async () => {
  const f = fixture(); f.element('parcelsToggle').click(); await flush(); const layer = f.images[0];
  f.element('parcelsToggle').click(); f.element('parcelsToggle').click(); await flush();
  layer.fire('error'); await flush();
  assert.equal(f.element('parcelsToggle').attrs['aria-checked'], 'false'); assert.equal(f.layers.size, 0);
  assert.equal(f.notices.filter(value => /Parcels could not/.test(value)).length, 1, 'The retired enable must not show a second failure');
});
await test('A late image error after disable cannot display an obsolete failure or undo a new retry', async () => {
  const f = fixture(); f.element('parcelsToggle').click(); await flush(); const retired = f.images[0];
  f.element('parcelsToggle').click(); await flush(); const count = f.notices.length; retired.fire('error'); await flush();
  assert.equal(f.notices.length, count); assert.equal(f.element('parcelsToggle').attrs['aria-checked'], 'false');
  f.element('parcelsToggle').click(); await flush(); f.images.at(-1).fire('load'); await flush();
  assert.equal(f.element('parcelsToggle').attrs['aria-checked'], 'true');
});
for (const name of ['Parcels', 'NsiStructures']) {
  for (const wrappers of [false, true]) {
    await test(`${name}${wrappers ? ' through its 3D wrapper' : ''} preserves a newer explicit repeated Flood Depth choice`, async () => {
      const gate = deferred(), f = fixture(name === 'Parcels' ? { metadataGate: gate, wrappers } : { nsiGate: gate, wrappers });
      const pending = f.context[`set${name}Enabled`](true);
      assert.equal(f.context.mapClickMode, 'building', 'Enable chooses its default synchronously');
      f.context.setMapClickMode('depth'); f.context.setMapClickMode('depth'); gate.resolve(); await flush();
      if (name === 'Parcels') { f.images.at(-1).fire('load'); }
      await pending; assert.equal(f.context.mapClickMode, 'depth');
      assert.equal(f.element('mapClickDepthBtn').attrs['aria-pressed'], 'true');
    });
  }
}
await test('Overlapping NSI and parcel completion cannot replace the latest explicit depth mode', async () => {
  const metadataGate = deferred(), nsiGate = deferred(), f = fixture({ metadataGate, nsiGate, wrappers: true });
  const parcel = f.context.setParcelsEnabled(true), nsi = f.context.setNsiStructuresEnabled(true);
  f.context.setMapClickMode('depth'); nsiGate.resolve(); await nsi; metadataGate.resolve(); await flush();
  f.images.at(-1).fire('load'); await parcel; assert.equal(f.context.mapClickMode, 'depth');
});
await test('A retired enable completing through the 3D wrapper syncs the current disabled state', async () => {
  const f = fixture({ wrappers: true }); const pending = f.context.setParcelsEnabled(true); await flush();
  await f.context.setParcelsEnabled(false); f.images[0].fire('load'); await pending;
  assert.equal(f.layers.size, 0); assert.deepEqual(f.syncs.at(-1), ['parcels', 'false']);
});

for (const result of results) { console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.name}`); if (!result.passed) console.log(result.error); }
console.log(`${results.filter(result => result.passed).length}/${results.length} deep layer cases passed: ${root}`);
if (results.some(result => !result.passed)) process.exitCode = 1;
