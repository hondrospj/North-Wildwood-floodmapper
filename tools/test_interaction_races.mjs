import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(process.argv[2] || new URL('../index.html', import.meta.url), 'utf8');
const names = ['switchOverlayMode', 'setParcelsEnabled', 'setNsiStructuresEnabled',
  'searchTownAddress', 'clearTownAddressLookup'];
const functions = names.map(name => {
  const match = html.match(new RegExp(`^    (?:async )?function ${name}\\([^\\n]*\\) \\{\\n.*?^    \\}`, 'ms'));
  assert.ok(match, name);
  return match[0];
}).join('\n');
let scriptCount = 0;
for (const match of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)) {
  if (/\bsrc\s*=|application\/ld\+json/.test(match[1])) continue;
  new vm.Script(match[2]);
  scriptCount++;
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { resolve, reject, promise };
}
function setup() {
  const layers = new Set(), elements = new Map();
  function el(id) {
    if (!elements.has(id)) {
      const classes = new Set();
      elements.set(id, {value: 'New Jersey Avenue', disabled: false, attrs: {},
        classList: {toggle(c, on) {if (on) classes.add(c); else classes.delete(c);}, contains(c) {return classes.has(c);}},
        setAttribute(k, v) {this.attrs[k] = v;}, focus() {}});
    }
    return elements.get(id);
  }
  const state = {layers, viewChanges: 0, status: '', popups: 0, buildingEnables: 0, renders: []};
  const context = vm.createContext({console,
    document: {getElementById: el, body: {classList: {contains() {return false;}}}},
    window: {NORTH_WILDWOOD_3D: {setAddressMarker() {}}},
    map: {hasLayer: l => layers.has(l), removeLayer: l => layers.delete(l), getZoom: () => 14,
      setView() {state.viewChanges++;}},
    ensureMap() {}, updateMapClickModeControl() {}, setMapClickMode() {}, toast() {},
    parcelLayerGeneration: 0, nsiLayerGeneration: 0, townAddressSearchGeneration: 0,
    parcelsLayer: null, nsiStructuresLayer: null, updateNsiStructureImpactLayer() {}, townAddressMarker: null,
    normalizeTownAddressQuery: v => v, getTownAddressDisplayName: () => 'North Wildwood',
    setTownAddressStatus: v => state.status = v, formatTownAddressLabel: () => 'New Jersey Avenue, North Wildwood',
    findParcelFeatureForLocation: async () => null, getShorelySafeAddressIcon: () => ({}),
    escapeTownAddressHtml: v => v, openPersistentFloodPopup() {state.popups++;},
    setBuildingsEnabled: async () => {state.buildingEnables++;}, openParcelFloodPrompt() {state.popups++;},
    fetchArcgisTownCandidates: async () => [{lat: 39.006, lon: -74.8}],
    fetchNominatimTownCandidates: async () => [], pickBestTownAddressCandidate: v => v[0],
    L: {latLng: (lat, lon) => ({lat, lon}), marker: latlng => ({latlng,
      addTo() {layers.add(this); return this;}, setLatLng(p) {this.latlng = p;}, setIcon() {}})},
    currentOverlayMode: 'depth', currentDataMode: 'observed', currentViewType: 'observed-day',
    currentTopTideIndex: null, currentHourIndex: 7, selectedObservedDate: '2016-01-23',
    currentSeriesHours: [{timeUtc: '2016-01-23T12:00:00Z', stageFt: 6.69}],
    stopPlayback() {}, updateModeButtons() {}, updateDataModeButtons() {}, clearFloodLayer() {}, renderTopTides() {},
    loadForecast: async () => {assert.fail('An overlay change must not load a forecast.');},
    renderHour: async i => state.renders.push(i)
  });
  vm.runInContext(functions, context);
  return {context, state, el};
}
let tests = 0;
for (const view of ['observed-day', 'top-tide']) {
  const {context: c, state} = setup();
  c.currentViewType = view; c.currentTopTideIndex = view === 'top-tide' ? 2 : null;
  const series = c.currentSeriesHours;
  await c.switchOverlayMode('dynamic');
  assert.equal(c.currentDataMode, 'observed'); assert.equal(c.currentViewType, view);
  assert.equal(c.selectedObservedDate, '2016-01-23'); assert.equal(c.currentSeriesHours, series);
  assert.equal(c.currentHourIndex, 7); assert.equal(c.currentTopTideIndex, view === 'top-tide' ? 2 : null);
  assert.deepEqual(state.renders, [7]);
  await c.switchOverlayMode('dynamic'); assert.deepEqual(state.renders, [7]);
  await c.switchOverlayMode('depth'); assert.deepEqual(state.renders, [7, 7]);
  tests++;
}
for (const [fn, toggle, loader, layerVar] of [
  ['setParcelsEnabled', 'parcelsToggle', 'ensureParcelAssets', 'parcelsLayer'],
  ['setNsiStructuresEnabled', 'nsiStructuresToggle', 'ensureNsiStructureAssets', 'nsiStructuresLayer']
]) {
  for (const action of ['off-before-load', 'on-off-on', 'late-failure', 'current-failure']) {
    const {context: c, state, el} = setup(), gate = deferred();
    const layer = {addTo() {state.layers.add(layer); return layer;}};
    c[loader] = async () => {await gate.promise; c[layerVar] = layer; return layer;};
    const enabling = c[fn](true);
    if (action === 'current-failure') {
      gate.reject(new Error('Asset unavailable'));
      await assert.rejects(enabling, /Asset unavailable/);
    } else {
      await c[fn](false);
      const latest = action === 'on-off-on' ? c[fn](true) : null;
      if (action === 'late-failure') gate.reject(new Error('Old load failed'));
      else gate.resolve();
      await enabling; if (latest) await latest;
      assert.equal(el(toggle).attrs['aria-checked'], latest ? 'true' : 'false');
      assert.equal(state.layers.has(layer), Boolean(latest));
      if (latest) {await c[fn](false); assert.equal(state.layers.has(layer), false);}
    }
    tests++;
  }
}
for (const phase of ['geocoding', 'parcel-matching']) {
  const {context: c, state, el} = setup(), gate = deferred(), entered = deferred();
  if (phase === 'geocoding') c.fetchArcgisTownCandidates = async () => {entered.resolve(); await gate.promise; return [{lat: 39.006, lon: -74.8}];};
  else c.findParcelFeatureForLocation = async () => {entered.resolve(); await gate.promise; return {};};
  const search = c.searchTownAddress('New Jersey Avenue');
  await entered.promise; c.clearTownAddressLookup();
  assert.equal(el('townAddressSearchBtn').disabled, false);
  gate.resolve(); await search;
  assert.equal(el('townAddressInput').value, ''); assert.equal(c.townAddressMarker, null);
  assert.equal(state.viewChanges, 0); assert.equal(state.popups, 0); assert.equal(state.status, '');
  assert.equal(state.buildingEnables, 0);
  tests++;
}
{
  const {context: c, state, el} = setup(), old = deferred(), latest = deferred(); let calls = 0;
  c.fetchArcgisTownCandidates = async () => {await (++calls === 1 ? old.promise : latest.promise); return [{lat: 39.006, lon: -74.8}];};
  const first = c.searchTownAddress('Old street'); c.clearTownAddressLookup();
  const second = c.searchTownAddress('New street'); old.resolve(); await first;
  assert.equal(el('townAddressSearchBtn').disabled, true, 'An old request must not unlock the current search.');
  assert.equal(state.viewChanges, 0);
  latest.resolve(); await second;
  assert.equal(state.viewChanges, 1); assert.equal(state.popups, 1);
  assert.equal(el('townAddressSearchBtn').disabled, false);
  c.clearTownAddressLookup(); assert.equal(c.townAddressMarker, null); assert.equal(state.layers.size, 0);
  tests++;
}
console.log(`${tests} interaction regression cases passed; ${scriptCount} inline scripts parsed.`);
