import { readAppSource } from './app_source.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const sourcePath = path.resolve(process.argv[2] || new URL('../candidate/index.html', import.meta.url).pathname);
const html = readAppSource(sourcePath);
const results = [];
function extract(name, optional = false) {
  const match = html.match(new RegExp('^    (?:async )?function ' + name + '\\([^\\n]*\\) \\{\\n.*?^    \\}', 'ms'));
  if (optional && !match) return null;
  assert.ok(match, `Missing function ${name}`);
  return match[0];
}
function load(context, names) { for (const name of names) vm.runInContext(extract(name), context, { filename: sourcePath + ':' + name }); }
function loadOptional(context, names) { for (const name of names) { const code = extract(name, true); if (code) vm.runInContext(code, context, { filename: sourcePath + ':' + name }); } }
function deferred() { let resolve; const promise = new Promise(yes => resolve = yes); return { promise, resolve }; }
async function flush() { for (let i = 0; i < 24; i++) await Promise.resolve(); }
async function test(name, run) { try { await run(); results.push({ name, passed: true }); } catch (error) { results.push({ name, passed: false, error: error.stack || String(error) }); } }

function renderFixture(initialIndex = 0, separateLoads = false) {
  const gate = deferred(), requests = [], labels = [], tasks = [], requestGates = [], slider = { value: String(initialIndex) };
  const oldLayer = { _floodmapperFrame: { stage: initialIndex } }, layers = new Set([oldLayer]);
  const context = vm.createContext({ console,
    currentSeriesHours: [0, 1, 2, 3].map(stage => ({ stage })), currentRawSeriesHours: [], currentHourIndex: initialIndex,
    currentOverlayMode: 'depth', currentDataMode: 'forecast', currentViewType: 'forecast', currentFloodLayer: oldLayer,
    pendingFloodLayer: null, lastRenderToken: 0, floodFrameState: 'ready', pendingTimelineSelection: null, timelineSelectionFrame: 0,
    requestedTimelineIndex: null, requestedTimelineSeries: null, requestedTimelineSelection: null,
    document: { getElementById: () => slider, body: { dataset: { initialFloodFrame: 'ready' }, classList: { contains: () => false, toggle() {} } } },
    map: { hasLayer: layer => layers.has(layer), removeLayer: layer => layers.delete(layer) },
    stopPlayback() {}, getStageValue: entry => entry?.stage ?? null, getOverlayStage: value => value,
    getHydraulicPhaseForEntry: () => 'slack', updatePersistentDepthQueryPopup() {}, setFloodFrameStatus() {}, updateSliderProgress() {},
    getPhysicsAssetForEntry: () => null, renderLegend() {}, buildNotes: () => '', toast() {},
    renderSelectionMeta: entry => labels.push(entry.stage), renderTimelineMeta() { slider.value = String(context.currentHourIndex); },
    updateNsiStructureImpactLayer() {}, preloadAroundHour() {}, scheduleOverlayCatalogWarmup() {},
    renderFloodFrameWithRetry: async (render, token) => { const ready = await render(); return ready && token === context.lastRenderToken; },
    setFloodLayer: async (_mode, stage, _phase, token) => {
      requests.push(stage); const frameGate = separateLoads ? deferred() : gate; requestGates.push(frameGate); const task = frameGate.promise.then(() => {
        if (token !== context.lastRenderToken) return false;
        context.currentFloodLayer = { _floodmapperFrame: { stage } }; return true;
      }); tasks.push(task); return task;
    },
    cancelAnimationFrame() {}, requestAnimationFrame() { throw Error('These selections commit immediately'); },
    reportFloodFrameFailure() { throw Error('Unexpected rendering failure'); },
  });
  loadOptional(context, ['getRequestedTimelineIndex', 'getTimelineSelectionIndex', 'getTimelineNavigationIndex']);
  load(context, ['cancelTimelineSelection', 'flushTimelineSelection', 'queueTimelineSelection', 'stepTimeline', 'stepSeriesBy', 'renderHour']);
  return { context, gate, requests, labels, slider, tasks, requestGates };
}
for (const row of [
  { name: 'Two forward timeline activations accumulate during a slow render', start: 0, directions: [1, 1], expected: 2 },
  { name: 'Two backward timeline activations accumulate during a slow render', start: 2, directions: [-1, -1], expected: 0 },
  { name: 'Opposite timeline activations return to the original displayed frame', start: 1, directions: [1, -1], expected: 1 },
]) {
  await test(row.name, async () => {
    const f = renderFixture(row.start);
    for (const direction of row.directions) f.context.stepTimeline(direction);
    f.gate.resolve(); await Promise.all(f.tasks); await flush();
    assert.equal(f.context.currentHourIndex, row.expected, 'Every activation must contribute to the final requested time');
    assert.equal(f.context.currentFloodLayer._floodmapperFrame.stage, row.expected);
    assert.equal(f.slider.value, String(row.expected));
    assert.equal(f.context.floodFrameState, 'ready');
  });
}
await test('Rapid observed keyboard/wheel steps also accumulate through stepSeriesBy', async () => {
  const f = renderFixture(0); f.context.currentDataMode = 'observed';
  const first = f.context.stepSeriesBy(1), second = f.context.stepSeriesBy(1);
  f.gate.resolve(); await Promise.all([first, second]); await flush();
  assert.equal(f.context.currentHourIndex, 2);
  assert.equal(f.context.currentFloodLayer._floodmapperFrame.stage, 2);
});

await test('A superseded completion cannot erase the latest pending navigation target', async () => {
  const f = renderFixture(0, true);
  f.context.stepTimeline(1);
  f.context.stepTimeline(1);
  f.requestGates[0].resolve(); await flush();
  f.context.stepTimeline(1);
  assert.equal(f.requests.at(-1), 3, 'A late obsolete completion must not reset navigation to the committed index');
  for (const gate of f.requestGates) gate.resolve();
  await Promise.all(f.tasks); await flush();
  assert.equal(f.context.currentHourIndex, 3);
});

function dailyFixture(month, selectedDate, index) {
  const months = {
    '2016-01': Array.from({ length: 31 }, (_, i) => ({ observedDate: `2016-01-${String(i + 1).padStart(2, '0')}`, isDailyMaximum: true, stage: 4 })),
    '2016-02': Array.from({ length: 29 }, (_, i) => ({ observedDate: `2016-02-${String(i + 1).padStart(2, '0')}`, isDailyMaximum: true, stage: 4 })),
  };
  const allDays = Object.values(months).flat().map(entry => ({ date: entry.observedDate }));
  const loaded = [], displayed = [], slider = { value: String(index) };
  const context = vm.createContext({ console, currentSeriesHours: months[month].slice(), currentRawSeriesHours: [], currentHourIndex: index,
    currentViewType: 'observed-day', currentDataMode: 'observed', selectedObservedDate: selectedDate, playTimer: null,
    lastRenderToken: 0, selectionGeneration: 0, topTideEvents: [], pendingTimelineSelection: null,
    requestedTimelineIndex: null, requestedTimelineSeries: null, requestedTimelineSelection: null,
    getObservedDays: () => allDays, cancelPendingFloodFrame: () => ++context.lastRenderToken,
    ensureObservedArchiveForDate: async date => loaded.push(date), getObservedDayRecord: date => ({ date, peakNAVD88: 4 }),
    stopPlayback() {}, updateDataModeButtons() {}, buildTopTideEvents: () => [], buildObservedCanonicalSeries: () => [],
    getTimelineIntervalMinutes: () => 1440, buildObservedDailyMaximumSeries: key => months[key].slice(),
    formatStageForDisplay: value => value + ' ft', normalizeStageValue: value => value, syncSliderBounds() {},
    document: { getElementById: () => slider }, renderCalendar: async () => {}, renderTopTides() {},
    renderHour: async idx => { context.currentHourIndex = idx; displayed.push(context.currentSeriesHours[idx].observedDate); },
  });
  loadOptional(context, ['getRequestedTimelineIndex', 'getTimelineSelectionIndex', 'getTimelineNavigationIndex']);
  load(context, ['getChronologicalDateIndex', 'getNeighborObservedDate', 'loadObservedDay', 'stepSeriesBy']);
  return { context, loaded, displayed };
}
await test('Daily Max advances from the displayed month end to the following month', async () => {
  const f = dailyFixture('2016-01', '2016-01-05', 30);
  await f.context.stepSeriesBy(1);
  assert.equal(f.displayed.at(-1), '2016-02-01');
  assert.equal(f.loaded.at(-1), '2016-02-01');
});
await test('Daily Max moves backward from the displayed month start to the preceding month', async () => {
  const f = dailyFixture('2016-02', '2016-02-20', 0);
  await f.context.stepSeriesBy(-1);
  assert.equal(f.displayed.at(-1), '2016-01-31');
  assert.equal(f.loaded.at(-1), '2016-01-31');
});
await test('Ordinary within-month Daily Max navigation still advances one displayed day', async () => {
  const f = dailyFixture('2016-01', '2016-01-05', 9);
  await f.context.stepSeriesBy(1);
  assert.equal(f.displayed.at(-1), '2016-01-11');
  assert.equal(f.loaded.length, 0);
});

function nsiFixture() {
  const feature = { properties: { address: 'Example structure', localGroundNavd88Ft: 4, foundationHeightFt: 1 } };
  let popup = null, currentStyle = null, directClick = null;
  const oldLayer = { _floodmapperFrame: { stage: 8 } }, layers = new Set([oldLayer]), slider = { value: '0' };
  const point = { feature, setStyle(style) { currentStyle = style; }, on(type, fn) { if (type === 'click') directClick = fn; } };
  const markerGroup = { eachLayer(fn) { fn(point); } };
  const context = vm.createContext({ console, mapClickMode: 'building', currentSeriesHours: [{ stage: 8 }, { stage: 1 }, { stage: null }],
    currentRawSeriesHours: [], currentHourIndex: 0, currentOverlayMode: 'depth', currentDataMode: 'observed', lastRenderToken: 0,
    currentFloodLayer: oldLayer, pendingFloodLayer: null, renderedFloodPixelCache: null, floodFrameState: 'ready',
    persistentDepthQueryContext: null, persistentFloodPopup: null, nsiStructuresLayer: markerGroup,
    nsiStructureLoadPromise: null, nsiStructureFeatures: [], nsiStructureRenderer: null, NSI_STRUCTURES_URL: 'test-structures.json',
    requestedTimelineIndex: null, requestedTimelineSeries: null, requestedTimelineSelection: null, mapQueryGeneration: 0,
    document: { getElementById: id => id === 'hourSlider' ? slider : { classList: { contains: () => true } },
      body: { dataset: { initialFloodFrame: 'ready' }, classList: { contains: () => false, toggle() {}, add() {}, remove() {} } } },
    map: { hasLayer: layer => layers.has(layer), removeLayer(layer) { layers.delete(layer); if (layer === popup) { context.persistentFloodPopup = null; context.persistentDepthQueryContext = null; } } },
    parcelInfoInteractionEnabled: () => true, findNsiStructureFeatureForLocation: () => feature,
    getStageValue: entry => entry?.stage ?? null, getOverlayStage: value => value, getHydraulicPhaseForEntry: () => 'slack',
    escapeTownAddressHtml: value => String(value), toast() {}, setFloodFrameStatus() {}, updateSliderProgress() {},
    cancelTimelineSelection() {}, renderSelectionMeta() {}, renderTimelineMeta() {}, hasDisplayedLongGaugeOutage: () => false,
    scheduleRasterObjectUrlCleanup() {},
    openPersistentFloodPopup(_latlng, text) {
      context.persistentDepthQueryContext = null;
      popup = { html: text, setContent(value) { this.html = value; }, update() {} };
      context.persistentFloodPopup = popup; layers.add(popup); return popup;
    },
    fetchJson: async () => ({ metadata: { schema: 'nsi-2026-first-floor-v1' }, features: [feature] }),
    L: { canvas: () => ({}), geoJSON(payload, options) { options.onEachFeature(feature, point); return markerGroup; } },
  });
  loadOptional(context, ['openNsiStructurePopup', 'openNsiStructureFloodPopup']);
  load(context, ['normalizeStageValue', 'formatWaterDepth', 'finiteStructureNumber', 'getNsiFirstOccupiedFloorNavd88', 'getSelectedStageNavd88',
    'getNsiStructureImpactStyle', 'formatNsiImpactStatus', 'buildNsiStructurePopup', 'handleDepthQueryClick', 'updatePersistentDepthQueryPopup',
    'updateNsiStructureImpactLayer', 'ensureNsiStructureAssets', 'clearFloodLayer', 'renderHour']);
  return { context, feature, layers, slider, get popup() { return popup; }, get style() { return currentStyle; }, get directClick() { return directClick; } };
}
for (const method of ['map-near-point', 'direct-marker']) {
  await test(`A ${method} NSI popup follows the newly displayed water level`, async () => {
    const f = nsiFixture();
    if (method === 'direct-marker') {
      f.context.nsiStructuresLayer = null;
      await f.context.ensureNsiStructureAssets();
      assert.equal(typeof f.directClick, 'function');
      f.directClick({ latlng: { lat: 39.01, lng: -74.8 }, originalEvent: {} });
    } else await f.context.handleDepthQueryClick({ latlng: { lat: 39.01, lng: -74.8 } });
    assert.match(f.popup.html, /3\.0 ft above/);
    f.context.currentHourIndex = 1;
    f.context.currentFloodLayer = { _floodmapperFrame: { stage: 1 } };
    f.context.updatePersistentDepthQueryPopup();
    assert.match(f.popup.html, /4\.0 ft below/, 'The popup must describe the newly committed stage');
    f.context.currentHourIndex = 2;
    f.context.currentFloodLayer = null;
    f.context.floodFrameState = 'unavailable';
    f.context.updatePersistentDepthQueryPopup();
    assert.match(f.popup.html, /Choose a water level|unavailable|N\/A/i, 'The previous flood level must not remain when data are unavailable');
  });
}
await test('Missing observed data replaces old structural-impact colors with the unknown style', async () => {
  const f = nsiFixture();
  f.context.updateNsiStructureImpactLayer();
  assert.equal(f.style.fillColor, '#fb7185');
  await f.context.renderHour(2);
  assert.equal(f.context.currentFloodLayer, null);
  assert.equal(f.context.getSelectedStageNavd88(), null);
  const expected = f.context.getNsiStructureImpactStyle(f.feature.properties, null);
  assert.equal(f.style.fillColor, expected.fillColor);
  assert.equal(f.style.fillColor, '#64748b');
});

function queryFixture() {
  const opened = [], parcels = [], notices = [];
  const context = vm.createContext({ console, mapClickMode: 'depth', currentSeriesHours: [{ stage: 5 }], currentHourIndex: 0,
    lastRenderToken: 0, floodFrameState: 'ready', mapQueryGeneration: 0, persistentFloodPopup: null,
    map: { hasLayer: () => false }, updateMapClickModeControl() {}, getPhysicsAssetForEntry: () => null,
    sampleDepthModel: async () => ({ elevation: 3, connectionStage: 4 }),
    openDepthQueryPopup(latlng, sample) { opened.push({ latlng, sample }); },
    parcelInfoInteractionEnabled: () => true, document: { getElementById: () => ({ classList: { contains: () => true } }) },
    findNsiStructureFeatureForLocation: () => null, findParcelFeatureForLocation: async () => ({}),
    openParcelFloodPrompt(feature, latlng) { parcels.push({ feature, latlng }); }, toast: value => notices.push(value),
  });
  load(context, ['setMapClickMode', 'handleDepthQueryClick']);
  return { context, opened, parcels, notices };
}
await test('An unchanged ordinary depth query still opens its result', async () => {
  const f = queryFixture();
  await f.context.handleDepthQueryClick({ latlng: { lat: 39.01, lng: -74.8 } });
  assert.equal(f.opened.length, 1);
  assert.equal(f.opened[0].sample.elevation, 3);
});
await test('Switching to Building Info cancels a pending ordinary depth query', async () => {
  const f = queryFixture(), gate = deferred(), began = deferred();
  f.context.sampleDepthModel = async () => { began.resolve(); return gate.promise; };
  const query = f.context.handleDepthQueryClick({ latlng: { lat: 39.01, lng: -74.8 } });
  await began.promise; f.context.setMapClickMode('building'); gate.resolve({ elevation: 3 }); await query;
  assert.equal(f.context.mapClickMode, 'building');
  assert.equal(f.opened.length, 0, 'An obsolete depth result must not reopen after the user switches interaction modes');
});
await test('Switching away and back cannot resurrect an older depth query', async () => {
  const f = queryFixture(), gate = deferred(), began = deferred();
  f.context.sampleDepthModel = async () => { began.resolve(); return gate.promise; };
  const query = f.context.handleDepthQueryClick({ latlng: { lat: 39.01, lng: -74.8 } });
  await began.promise;
  f.context.setMapClickMode('building'); f.context.setMapClickMode('depth');
  gate.resolve({ elevation: 3 }); await query;
  assert.equal(f.context.mapClickMode, 'depth');
  assert.equal(f.opened.length, 0, 'Mode equality alone must not make an invalidated request current again');
});

await test('Switching to Flood Depth cancels a pending parcel lookup', async () => {
  const f = queryFixture(), gate = deferred(), began = deferred(); f.context.mapClickMode = 'building';
  f.context.findParcelFeatureForLocation = async () => { began.resolve(); return gate.promise; };
  const query = f.context.handleDepthQueryClick({ latlng: { lat: 39.01, lng: -74.8 } });
  await began.promise; f.context.setMapClickMode('depth'); gate.resolve({ properties: {} }); await query;
  assert.equal(f.parcels.length, 0, 'A lookup for the previous interaction mode must not open a building popup');
});

for (const row of results) { console.log(`${row.passed ? 'PASS' : 'FAIL'} ${row.name}`); if (!row.passed) console.log(row.error); }
console.log(`${results.filter(row => row.passed).length}/${results.length} UI state regression cases passed: ${sourcePath}`);
if (results.some(row => !row.passed)) process.exitCode = 1;
