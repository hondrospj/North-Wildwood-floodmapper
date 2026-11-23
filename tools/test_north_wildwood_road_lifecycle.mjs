import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../assets/road-impacts.js", import.meta.url), "utf8");

function fixture() {
  const pixels = new Uint8ClampedArray(20 * 4);
  for (let x = 5; x < 16; x++) pixels.set([27, 183, 245, 255], x * 4);
  pixels.set([99, 212, 113, 255], 10 * 4);
  const mounted = new Set(), panes = new Map(), bodyClasses = new Set();
  const elements = new Map(["roadImpactsToggle", "roadImpactsStatus", "roadImpactsKey"].map(id => [id, {
    classList: { toggle() {} }, setAttribute() {}, addEventListener() {}, hidden: true
  }]));
  const counts = { adds: 0, removes: 0, updates: 0, fetches: 0 };
  const bounds = { getWest: () => 0, getEast: () => .001, getSouth: () => 0, getNorth: () => 1 };
  const image = { complete: true, naturalWidth: 20, naturalHeight: 1, src: "frame-a" };
  const frame = { getElement: () => image, getBounds: () => bounds,
    _floodmapperFrame: { entry: { timeUtc: "2026-11-23T14:00:00Z" }, stage: 2, phase: "filling", overlayMode: "depth" } };
  const glSources = new Map(), glLayers = new Map();
  const gl = {
    getSource: id => glSources.get(id), getLayer: id => glLayers.get(id),
    addSource(id, options) { glSources.set(id, { data: options.data, setData(data) { this.data = data; } }); },
    addLayer(layer) { glLayers.set(layer.id, layer); },
    setLayoutProperty(id, key, value) { glLayers.get(id).layout[key] = value; }
  };
  let observeClass, leaflet;
  const ctx = {
    URL, Uint8ClampedArray, performance, console: { warn() {} }, APP_BASE: new URL("https://mapper.test/"),
    map: { hasLayer: layer => mounted.has(layer), removeLayer(layer) { counts.removes++; mounted.delete(layer); },
      getPane: name => panes.get(name), createPane: name => panes.set(name, { style: {} }) },
    currentFloodLayer: frame, floodFrameState: "ready", lastRenderToken: 1,
    currentSeriesHours: [{ stage: 2 }, { stage: 2 }], currentHourIndex: 0, currentOverlayMode: "depth", floodLatLngBounds: bounds,
    getSelectedStageNavd88: () => 2, getHydraulicPhaseForEntry: () => "filling",
    getPhysicsAssetForEntry: () => null, getDepthQueryGrid: async () => ({}),
    sampleDepthModel: async () => ({ depth: .75 }), getDepthQueryDisplayDepth: sample => sample.depth,
    fetchJson: async () => { counts.fetches++; return { type: "FeatureCollection", features: [{ type: "Feature",
      properties: { name: "Test Road" }, geometry: { type: "LineString", coordinates: [[0, .5], [.001, .5]] } }] }; },
    isWetRasterPixel: (values, offset) => values[offset + 3] > 0 && values[offset] !== 99,
    requestAnimationFrame: callback => queueMicrotask(callback),
    MutationObserver: class { constructor(callback) { observeClass = callback; } observe() {} },
    document: {
      body: { dataset: {}, classList: { contains: name => bodyClasses.has(name) } },
      getElementById: id => elements.get(id),
      createElement: () => ({ width: 0, height: 0, getContext: () => ({
        drawImage() {}, getImageData: () => ({ data: pixels })
      }) })
    },
    L: { canvas: () => ({}), geoJSON(data) {
      leaflet = { data, clearLayers() { counts.updates++; this.data = { type: "FeatureCollection", features: [] }; },
        addData(data) { this.data = data; }, addTo() { counts.adds++; mounted.add(this); return this; } };
      return leaflet;
    } },
    window: { NORTH_WILDWOOD_3D: { getMap: () => gl }, addEventListener() {} },
    clearFloodLayer() { ctx.currentFloodLayer = null; ctx.floodFrameState = "unavailable"; },
    async renderHour(index) {
      ctx.lastRenderToken++;
      ctx.floodFrameState = "loading";
      if (ctx.frameGate && !await ctx.frameGate()) { ctx.floodFrameState = "failed"; return false; }
      ctx.currentHourIndex = index;
      ctx.currentFloodLayer = { ...frame, _floodmapperFrame: { ...frame._floodmapperFrame,
        entry: { timeUtc: "2026-11-23T15:00:00Z" } } };
      ctx.floodFrameState = "ready";
    }
  };
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  ctx.installGridRoadImpacts({ compatibility: { hydraulicCatalog: "v29" }, assets: { roadImpactsPath: "roads.json" } });
  return { ctx, counts, pixels, frame, api: ctx.window.NORTH_WILDWOOD_ROAD_IMPACTS,
    state: () => ctx.document.body.dataset.roadImpactsState,
    leaflet: () => leaflet, mounted: () => mounted.has(leaflet), glSources, glLayers,
    classMutation: () => observeClass(),
    set3d(value) { value ? bodyClasses.add("map-3d-ready") : bodyClasses.delete("map-3d-ready"); observeClass(); } };
}

function holdDepth(test) {
  let reject, resolve, start;
  const started = new Promise(callback => { start = callback; });
  test.ctx.getDepthQueryGrid = () => new Promise((yes, no) => { resolve = yes; reject = no; start(); });
  return { started, reject: error => reject(error), resolve: value => resolve(value) };
}

// An obsolete sampling failure must not clear the retained frame's correct roads.
const stale = fixture();
await stale.api.setEnabled(true);
assert.equal(stale.api.state().sections, 2);
const held = holdDepth(stale);
const oldRefresh = stale.api.refresh();
await held.started;
let finishFrame;
stale.ctx.frameGate = () => new Promise(resolve => { finishFrame = resolve; });
const replacement = stale.ctx.renderHour(1);
held.reject(new Error("Obsolete sampling request failed"));
await oldRefresh;
assert.equal(stale.ctx.floodFrameState, "loading");
assert.equal(stale.api.state().sections, 2, "Old errors must preserve the displayed frame's road geometry");
assert.equal(stale.state(), "ready");
finishFrame(false);
await replacement;
assert.equal(stale.api.state().sections, 2, "A failed replacement must keep retained-frame roads");
assert.equal(stale.state(), "ready");

// Guard layer identity too, even when a replacement reuses the same token.
const changedLayer = fixture();
await changedLayer.api.setEnabled(true);
const changed = holdDepth(changedLayer);
const changedRefresh = changedLayer.api.refresh();
await changed.started;
changedLayer.ctx.currentFloodLayer = { ...changedLayer.frame };
changed.reject(new Error("Old layer sampling failed"));
await changedRefresh;
assert.equal(changedLayer.api.state().sections, 2);
assert.equal(changedLayer.state(), "ready");

// A current request's failure still clears geometry, reports failure, and retries.
const current = fixture();
await current.api.setEnabled(true);
current.ctx.getDepthQueryGrid = async () => { throw new Error("Current sampling failed"); };
await current.api.refresh();
assert.equal(current.api.state().sections, 0);
assert.equal(current.state(), "failed");
current.ctx.getDepthQueryGrid = async () => ({});
await current.api.refresh();
assert.equal(current.api.state().sections, 2);
assert.equal(current.state(), "ready");

// Unrelated app classes and valid data updates must keep a mounted Leaflet layer.
const sync = fixture();
assert.equal(sync.counts.fetches, 0);
await sync.api.setEnabled(true);
assert.equal(sync.counts.adds, 1);
sync.classMutation();
sync.classMutation();
assert.equal(sync.counts.removes, 0, "Unrelated app classes must not detach roads");
assert.equal(sync.counts.adds, 1, "Unrelated app classes must not reattach roads");
await sync.api.refresh();
assert.ok(sync.counts.updates > 0, "Mounted geometry must still receive real data updates");
assert.equal(sync.leaflet().data.features.length, 2);
assert.equal(sync.counts.adds, 1);
assert.equal(sync.counts.removes, 0);

// A cheap road refresh fits in one work slice. Yield for a long computation
// before publishing its successfully sampled sections.
const timing = fixture();
let yields = 0;
timing.ctx.requestAnimationFrame = callback => { yields++; queueMicrotask(callback); };
timing.ctx.performance = { now: () => 0 };
await timing.api.setEnabled(true);
assert.equal(yields, 0, "A cheap road refresh must not wait for an animation frame");
let time = 0;
timing.ctx.performance.now = () => time += 10;
await timing.api.refresh();
assert.ok(yields > 0, "An expensive road refresh gives the browser time to paint");
assert.equal(timing.api.state().sections, 2);

// Disable, 3D handoff and empty results must still remove/hide their overlays.
sync.set3d(true);
assert.equal(sync.mounted(), false);
assert.equal(sync.glSources.get("nw-road-impacts-source").data.features.length, 2);
assert.equal(sync.glLayers.get("nw-road-impacts").layout.visibility, "visible");
sync.set3d(false);
assert.equal(sync.mounted(), true);
await sync.api.setEnabled(false);
assert.equal(sync.mounted(), false);
sync.set3d(true);
assert.equal(sync.glLayers.get("nw-road-impacts").layout.visibility, "none");
assert.equal(sync.glSources.get("nw-road-impacts-source").data.features.length, 0);
sync.set3d(false);
await sync.api.setEnabled(true);
sync.pixels.fill(0);
await sync.api.refresh();
assert.equal(sync.api.state().sections, 0);
assert.equal(sync.mounted(), false);
assert.equal(sync.state(), "ready", "A valid empty road result remains ready");

console.log("Road lifecycle: obsolete failures, current failures/retry, stable Leaflet mounting, updates, disable/empty and 3D handoff passed");
