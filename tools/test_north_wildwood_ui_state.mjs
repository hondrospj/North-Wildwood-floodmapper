import { readAppSource } from './app_source.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const sourcePath = path.resolve(process.argv[2] || new URL('../index.html', import.meta.url).pathname);
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

await test('Past date entry validates the calendar before looking up the archive', () => {
  const context = vm.createContext({ currentMonthKey: '2024-02' });
  load(context, ['pad2', 'parseTypedObservedDate']);
  for (const input of ['Feb 29, 2024', 'February 29 2024', '29 Feb. 2024', '02/29/2024',
    '2-29-24', '2024-2-29', '2024/2/29', '2/29']) {
    assert.equal(context.parseTypedObservedDate(input), '2024-02-29', input);
  }
  assert.equal(context.parseTypedObservedDate('Sept 5, 2026'), '2026-09-05');
  for (const input of ['Feb 30, 2026', '02/30/2026', '2026-02-30', '29 February 2026',
    'Apr 31, 2026', '2026-04-00', 'Janfoo 2, 2026', '2026-13-01']) {
    assert.equal(context.parseTypedObservedDate(input), null, input);
  }
});

await test('A typed Past date starts one request and leaves newer input focused', async () => {
  const calls = [], gates = [];
  const input = { value: '2026-02-18', blurs: 0, blur() { this.blurs++; } };
  const context = vm.createContext({
    selectionGeneration: 0, selectedObservedDate: '2026-02-17',
    document: { getElementById: () => input }, toast: assert.fail,
    formatSelectedObservedDate: value => `formatted ${value}`,
    parseTypedObservedDate: value => /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null,
    getObservedDays: () => ['2026-02-18', '2026-02-19'].map(date => ({ date })),
    async loadObservedDay(date) {
      const generation = ++context.selectionGeneration;
      const gate = deferred();
      calls.push(date);
      gates.push(gate);
      await gate.promise;
      if (generation !== context.selectionGeneration) return false;
      context.selectedObservedDate = date;
    },
  });
  load(context, ['submitTypedObservedDate']);
  const first = context.submitTypedObservedDate();
  await context.submitTypedObservedDate();
  assert.deepEqual(calls, ['2026-02-18']);
  gates[0].resolve();
  await first;
  assert.equal(input.value, 'formatted 2026-02-18');
  assert.equal(input.blurs, 1);
  input.value = '2026-02-19';
  const second = context.submitTypedObservedDate();
  input.value = '2026-02-2';
  gates[1].resolve();
  await second;
  assert.equal(input.value, '2026-02-2');
  assert.equal(input.blurs, 1);
});

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

await test('Daily Max commits the displayed date and tide context together', async () => {
  const f = renderFixture();
  const c = f.context;
  const dates = ['2016-01-01', '2016-01-02'];
  const canonical = [{ observedDate: dates[1], stage: 5 }];
  Object.assign(c, {
    currentViewType: 'observed-day', currentDataMode: 'observed', selectedObservedDate: dates[0],
    currentSeriesHours: dates.map((observedDate, i) => ({ observedDate, isDailyMaximum: true, stage: 4 + i })),
    getObservedDayRecord: date => ({ date, peakNAVD88: 5 }),
    buildObservedCanonicalSeries: () => canonical, renderCalendar: async () => {},
    topTideEvents: [], formatStageForDisplay: String, normalizeStageValue: Number
  });
  load(c, ['setObservedDaySelection']);
  const loading = c.renderHour(1);
  assert.equal(c.selectedObservedDate, dates[0], 'A pending raster must leave the displayed date intact');
  f.gate.resolve();
  await loading;
  assert.equal(c.selectedObservedDate, dates[1]);
  assert.equal(c.currentSelectedLabel, dates[1]);
  assert.equal(c.currentSelectedSubLabel, '5 peak');
  assert.equal(c.currentRawSeriesHours, canonical);
});

function dailyFixture(month, selectedDate, index, cadence = 1440) {
  const months = {
    '2016-01': Array.from({ length: 31 }, (_, i) => ({ observedDate: `2016-01-${String(i + 1).padStart(2, '0')}`, isDailyMaximum: true, stage: 4 })),
    '2016-02': Array.from({ length: 29 }, (_, i) => ({ observedDate: `2016-02-${String(i + 1).padStart(2, '0')}`, isDailyMaximum: true, stage: 4 })),
  };
  const dayHours = observedDate => [0, 1, 2].map(hour => ({ observedDate, hour, stage: hour === 1 ? 5 : 4 }));
  const allDays = Object.values(months).flat().map(entry => ({ date: entry.observedDate }));
  const loaded = [], displayed = [], slider = { value: String(index) };
  const context = vm.createContext({ console, currentSeriesHours: cadence === 1440 ? months[month].slice() : dayHours(selectedDate),
    currentRawSeriesHours: [], currentHourIndex: index,
    currentViewType: 'observed-day', currentDataMode: 'observed', selectedObservedDate: selectedDate, playTimer: null,
    playbackGeneration: 0, playbackObservedDaysAdvanced: 0, PLAYBACK_DAY_CONFIRMATION_INTERVAL: 1,
    pausePlaybackForDayConfirmation() { context.confirmationOpened = true; },
    lastRenderToken: 0, selectionGeneration: 0, topTideEvents: [], pendingTimelineSelection: null,
    requestedTimelineIndex: null, requestedTimelineSeries: null, requestedTimelineSelection: null,
    getObservedDays: () => allDays, cancelPendingFloodFrame: () => ++context.lastRenderToken,
    ensureObservedArchiveForDate: async date => loaded.push(date), getObservedDayRecord: date => ({ date, peakNAVD88: 4 }),
    stopPlayback() {}, updateDataModeButtons() {}, buildTopTideEvents: () => [], buildObservedCanonicalSeries: day => dayHours(day.date),
    getTimelineIntervalMinutes: () => cadence, buildObservedDailyMaximumSeries: key => months[key].slice(),
    sampleCanonicalHydraulicSeries: series => series, getPeakHourIndex: () => 1,
    formatStageForDisplay: value => value + ' ft', normalizeStageValue: value => value, syncSliderBounds() {},
    document: { getElementById: () => slider }, renderCalendar: async () => {}, renderTopTides() {},
    renderHour: async idx => { context.currentHourIndex = idx; displayed.push(context.currentSeriesHours[idx].observedDate); },
  });
  loadOptional(context, ['getRequestedTimelineIndex', 'getTimelineSelectionIndex', 'getTimelineNavigationIndex']);
  loadOptional(context, ['setObservedDaySelection']);
  load(context, ['getChronologicalDateIndex', 'getNeighborObservedDate', 'loadObservedDay', 'stepSeriesBy', 'stepPlaybackForward']);
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

for (const direction of [-1, 1]) {
  await test(`Cross-day ${direction} commits only the adjacent boundary frame`, async () => {
    const f = dailyFixture('2016-01', '2016-01-02', direction < 0 ? 0 : 2, 60);
    const c = f.context;
    if (direction > 0) c.playTimer = {};
    const date = direction < 0 ? '2016-01-01' : '2016-01-03';
    await (direction > 0 ? c.stepPlaybackForward() : c.stepSeriesBy(direction));
    assert.deepEqual(f.displayed, [date]);
    assert.equal(c.selectedObservedDate, date);
    assert.equal(c.currentHourIndex, direction < 0 ? 2 : 0);
    assert.equal(c.playbackObservedDaysAdvanced, direction > 0 ? 1 : 0);
    assert.equal(Boolean(c.confirmationOpened), direction > 0);
  });

  for (const [before, after] of [[60, 1440], [1440, 15]]) {
    await test(`Cross-day ${direction} uses cadence ${after} selected while archive cadence ${before} is loading`, async () => {
      const f = before === 1440
        ? dailyFixture(direction < 0 ? '2016-02' : '2016-01', direction < 0 ? '2016-02-01' : '2016-01-31', direction < 0 ? 0 : 30)
        : dailyFixture('2016-01', '2016-01-02', direction < 0 ? 0 : 2, before);
      const c = f.context;
      const gate = deferred();
      const started = deferred();
      c.ensureObservedArchiveForDate = () => { started.resolve(); return gate.promise; };
      const crossing = c.stepSeriesBy(direction);
      await started.promise;
      c.getTimelineIntervalMinutes = () => after;
      gate.resolve();
      await crossing;
      const expectedDate = before === 1440
        ? (direction < 0 ? '2016-01-31' : '2016-02-01')
        : (direction < 0 ? '2016-01-01' : '2016-01-03');
      assert.deepEqual(f.displayed, [expectedDate]);
      if (after !== 1440) assert.equal(c.currentHourIndex, direction < 0 ? 2 : 0);
    });
  }

  await test(`A superseded cross-day ${direction} cannot navigate or prompt in the newer mode`, async () => {
    const f = dailyFixture('2016-01', '2016-01-02', direction < 0 ? 0 : 2, 60);
    const c = f.context;
    const gate = deferred();
    const started = deferred();
    c.ensureObservedArchiveForDate = () => { started.resolve(); return gate.promise; };
    if (direction > 0) c.playTimer = {};
    const crossing = direction > 0 ? c.stepPlaybackForward() : c.stepSeriesBy(direction);
    await started.promise;
    ++c.selectionGeneration;
    ++c.playbackGeneration;
    c.currentViewType = 'forecast';
    c.currentDataMode = 'forecast';
    c.currentSeriesHours = [{ observedDate: '2016-02-01' }, { observedDate: '2016-02-02' }];
    c.currentHourIndex = 0;
    gate.resolve();
    await crossing;
    assert.deepEqual(f.displayed, []);
    assert.equal(c.currentHourIndex, 0);
    assert.equal(c.playbackObservedDaysAdvanced, 0);
    assert.equal(c.confirmationOpened, undefined);
  });
}

await test('Map data popups reserve the direction wheel where the viewport has space', () => {
  const elements = {
    rightRail: { getBoundingClientRect: () => ({ width: 280 }) },
    nwDefaultNavControl: { getBoundingClientRect: () => ({ left: 668, width: 92 }) }
  };
  let options;
  const context = vm.createContext({
    document: { getElementById: id => elements[id], documentElement: {}, body: { classList: { contains: () => false, add() {} } } },
    window: { innerWidth: 1024, innerHeight: 576 },
    map: { hasLayer: () => false }, persistentFloodPopup: null, persistentDepthQueryContext: null,
    getComputedStyle: () => ({ getPropertyValue: () => '120px' }),
    isCompactFloodmapperLayout: () => false,
    wireShortLeafletPopup() {},
    L: {
      point: (x, y) => ({ x, y }),
      popup(value) {
        options = value;
        return { setLatLng() { return this; }, setContent() { return this; }, addTo() { return this; }, once() {} };
      }
    }
  });
  load(context, ['openPersistentFloodPopup']);
  const popupTypes = ['nsi-structure-popup', 'house-alert-popup', 'depth-query-popup'];
  for (const className of popupTypes) {
    context.openPersistentFloodPopup({}, `<div class="${className}">Reading</div>`, 360);
    assert.equal(options.autoPanPaddingBottomRight.x, 368, 'Reserve the compass footprint with a 12px gap');
  }
  context.openPersistentFloodPopup({}, '<div class="town-address-popup">Address</div>', 360);
  assert.equal(options.autoPanPaddingBottomRight.x, 310, 'Other popups preserve normal map padding');
  context.window.innerWidth = 390;
  context.window.innerHeight = 844;
  context.isCompactFloodmapperLayout = () => true;
  elements.nwDefaultNavControl.getBoundingClientRect = () => ({ left: 300, width: 78, height: 160, bottom: 236 });
  context.openPersistentFloodPopup({}, '<div class="house-alert-popup">Building</div>', 460);
  assert.equal(options.autoPanPaddingBottomRight.x, 10, 'The narrow map cannot fit the popup beside the compass');
  assert.equal(options.autoPanPaddingTopLeft.y, 248, 'A wide popup goes below the phone controls');
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
    cancelPendingTownAddressLookup: () => false,
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
      popup = { html: text, getContent() { return this.html; }, setContent(value) { this.html = value; }, update() {} };
      context.persistentFloodPopup = popup; layers.add(popup); return popup;
    },
    fetchJson: async () => ({ metadata: { schema: 'nsi-2026-first-floor-v1' }, features: [feature] }),
    L: { canvas: () => ({}), geoJSON(payload, options) { options.onEachFeature(feature, point); return markerGroup; } },
  });
  loadOptional(context, ['openNsiStructurePopup', 'openNsiStructureFloodPopup']);
  load(context, ['normalizeStageValue', 'formatWaterDepth', 'finiteStructureNumber', 'getNsiFirstOccupiedFloorNavd88', 'getSelectedStageNavd88',
    'getNsiStructureImpactStyle', 'formatNsiImpactStatus', 'buildNsiStructurePopup', 'beginMapQuery', 'handleDepthQueryClick', 'updatePersistentDepthQueryPopup', 'updatePropertyPopup', 'deferPropertyPopupUpdate',
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
  const context = vm.createContext({ console: { error() {} }, mapClickMode: 'depth', currentSeriesHours: [{ stage: 5 }], currentHourIndex: 0,
    lastRenderToken: 0, floodFrameState: 'ready', mapQueryGeneration: 0, persistentFloodPopup: null,
    cancelPendingTownAddressLookup: () => false,
    map: { hasLayer: () => false }, updateMapClickModeControl() {}, getPhysicsAssetForEntry: () => null,
    sampleDepthModel: async () => ({ elevation: 3, connectionStage: 4 }),
    openDepthQueryPopup(latlng, sample) { opened.push({ latlng, sample }); },
    parcelInfoInteractionEnabled: () => true, document: { getElementById: () => ({ classList: { contains: () => true } }) },
    findNsiStructureFeatureForLocation: () => null, findParcelFeatureForLocation: async () => ({}),
    openParcelFloodPrompt(feature, latlng) { parcels.push({ feature, latlng }); }, toast: value => notices.push(value),
  });
  load(context, ['setMapClickMode', 'beginMapQuery', 'handleDepthQueryClick']);
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

await test('An old depth failure stays silent after a newer Building result', async () => {
  const f = queryFixture();
  const point = { latlng: { lat: 39.01, lng: -74.8 } };
  let fail;
  f.context.sampleDepthModel = () => new Promise((_, reject) => { fail = reject; });
  const query = f.context.handleDepthQueryClick(point);
  f.context.setMapClickMode('building');
  await f.context.handleDepthQueryClick(point);
  assert.equal(f.parcels.length, 1);
  fail(Error('Older depth request failed'));
  await query;
  assert.deepEqual(f.notices, []);
  f.context.setMapClickMode('depth');
  f.context.sampleDepthModel = async () => { throw Error('Current depth request failed'); };
  await f.context.handleDepthQueryClick(point);
  assert.deepEqual(f.notices, ['Depth query is temporarily unavailable.']);
});

for (const row of results) { console.log(`${row.passed ? 'PASS' : 'FAIL'} ${row.name}`); if (!row.passed) console.log(row.error); }
console.log(`${results.filter(row => row.passed).length}/${results.length} UI state regression cases passed: ${sourcePath}`);
if (results.some(row => !row.passed)) process.exitCode = 1;
