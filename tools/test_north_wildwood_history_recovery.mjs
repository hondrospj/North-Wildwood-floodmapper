// Execute the real archive/mode functions with controlled transports and races.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = ['04-observation-archives', '21-forecast-and-observed-loading', '22-calendar-and-modes', '23-refresh-and-playback']
  .map(name => fs.readFileSync(new URL(`./app/runtime/${name}.js`, import.meta.url), 'utf8')).join('\n');
function extract(name) {
  const match = html.match(new RegExp(`^    (?:async )?function ${name}\\([^\\n]*\\) \\{\\n.*?^    \\}`, 'ms'));
  assert.ok(match, name);
  return match[0];
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function create(names, extra = {}) {
  const c = vm.createContext({ console: {warn() {}}, AbortController, Promise, Map, Set, ...extra });
  for (const name of names) vm.runInContext(extract(name), c);
  return c;
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const compact = { stationId: '01411360', days: [{d: '2026-01-01', p: 100}] };
let cases = 0;

// Both a request with no headers and a stalled body must yield to healthy
// compact data. The mock transport deliberately ignores AbortSignal.
for (const phase of ['headers', 'body']) {
  const hold = deferred();
  const timers = new Map();
  let nextTimer = 0, requests = 0, fallback = 0, signal;
  const c = create(['preloadObservedArchiveIndexText', 'ensureObserved15MinuteArchive'], {
    window: {
      setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, {fn, ms}); return id; },
      clearTimeout(id) { timers.delete(id); }
    },
    observedArchiveIndexTextPromise: null, observed15MinuteData: null, archiveGeneration: 0,
    OBSERVED_ARCHIVE_INDEX_URL: 'index.json', OBSERVED_15MIN_URL: 'compact.json',
    TOWN_CONFIG: {observed: {usgsGaugeId: '01411360'}},
    fetch(url, options) {
      requests++; signal = options.signal;
      return phase === 'headers' ? hold.promise : Promise.resolve({ok: true, text: () => hold.promise});
    },
    async fetchJson(url) { assert.equal(url, 'compact.json'); fallback++; return compact; },
    addArchiveShardDays(payload, source) { assert.equal(payload, compact); assert.equal(source, 'stone-harbor'); }
  });
  const warming = c.ensureObserved15MinuteArchive();
  await tick();
  assert.equal(requests, 1); assert.equal(fallback, 0);
  assert.equal(timers.size, 1); assert.equal([...timers.values()][0].ms, 15000);
  [...timers.values()][0].fn();
  assert.equal(await warming, compact);
  assert.equal(signal.aborted, true);
  assert.equal(c.observedArchiveIndexTextPromise, null);
  assert.equal(c.observed15MinuteData, compact);
  assert.equal(fallback, 1); assert.equal(timers.size, 0);
  // The failed prefetch must be retryable, and a later successful text fetch
  // must retain the downloaded text without a leftover deadline.
  c.fetch = async () => ({ok: true, text: async () => JSON.stringify(compact)});
  assert.equal(await c.preloadObservedArchiveIndexText(), JSON.stringify(compact));
  assert.equal(timers.size, 0);
  cases++;
}

function warmContext(extra = {}) {
  const stats = {compact: 0, canonical: 0, loaded: 0, catalogs: 0};
  const c = create(['warmBackgroundData'], {
    archiveGeneration: 0, backgroundDataPromise: null, observedData: null, observed15MinuteData: null,
    observedDaysCache: null, observedMonthKeys: [], topTideEvents: [],
    async ensureObserved15MinuteArchive() { stats.compact++; throw Error('Offline'); },
    async ensureCanonicalDailyArchive() { stats.canonical++; throw Error('Offline'); },
    buildObservedIndexFromCanonical: payload => payload,
    buildObservedIndexFrom15MinuteArchive: payload => payload,
    mergeObservedArchiveIndex() {},
    async loadObserved() { stats.loaded++; },
    buildTopTideEvents: () => [], renderTopTides() { stats.catalogs++; },
    ...extra
  });
  return { c, stats };
}
{
  const {c, stats} = warmContext();
  assert.equal(await c.warmBackgroundData(), null);
  assert.equal(c.backgroundDataPromise, null, 'A resolved-null failure must not poison later history requests.');
  c.ensureObserved15MinuteArchive = async () => { stats.compact++; return compact; };
  c.ensureCanonicalDailyArchive = async () => { stats.canonical++; return {days: [{date:'2026-01-01'}]}; };
  const [a, b] = await Promise.all([c.warmBackgroundData(), c.warmBackgroundData()]);
  assert.equal(a, b); assert.ok(a.days.length); assert.equal(stats.loaded, 1);
  assert.equal(stats.compact, 2); assert.equal(stats.canonical, 2, 'Concurrent retries share one actual load.');
  assert.ok(c.backgroundDataPromise);
  cases++;
}
{
  const old = deferred(), latest = deferred();
  const {c} = warmContext({ensureObserved15MinuteArchive: () => old.promise});
  const stale = c.warmBackgroundData();
  c.archiveGeneration++; c.backgroundDataPromise = null;
  c.ensureObserved15MinuteArchive = () => latest.promise;
  const pending = c.warmBackgroundData();
  const newestRequest = c.backgroundDataPromise;
  old.resolve(null); await stale;
  assert.equal(c.backgroundDataPromise, newestRequest, 'An obsolete warmup must not clear the new in-flight request.');
  latest.resolve(compact); assert.ok(await pending);
  cases++;
}
{
  // A healthy canonical archive remains usable when both optimized-primary
  // sources fail: the held index reaches its deadline, compact rejects, and
  // the real warmup finishes with the already loaded canonical data.
  const held = deferred(), timers = new Map();
  let nextTimer = 0, canonicalLoads = 0;
  const canonical = {days: [{date:'2026-01-01', peakNAVD88:1}]};
  const {c, stats} = warmContext({
    observedArchiveIndexTextPromise: null, OBSERVED_ARCHIVE_INDEX_URL: 'index.json',
    OBSERVED_15MIN_URL: 'compact.json', TOWN_CONFIG: {observed: {usgsGaugeId:'01411360'}},
    window: {setTimeout(fn, ms) {const id = ++nextTimer; timers.set(id, {fn, ms}); return id;},
      clearTimeout(id) {timers.delete(id);}},
    fetch: () => held.promise, async fetchJson() {throw Error('Compact unavailable');},
    async ensureCanonicalDailyArchive() {canonicalLoads++; return canonical;}, addArchiveShardDays() {}
  });
  vm.runInContext(extract('preloadObservedArchiveIndexText')+'\n'+extract('ensureObserved15MinuteArchive'), c);
  const pending = c.warmBackgroundData(); await tick();
  assert.equal(canonicalLoads, 1); assert.equal(stats.loaded, 0);
  [...timers.values()][0].fn();
  assert.equal(await pending, canonical); assert.equal(stats.loaded, 1);
  assert.equal(timers.size, 0); cases++;
}

function intervalContext(extra = {}) {
  const calls = {loads: [], renders: []};
  const c = create(['setTimelineIntervalMinutes'], {
    selectionGeneration: 10, lastRenderToken: 20, overlayPreloadGeneration: 0,
    currentTimelineIntervalMinutes: 60,
    switchDataMode() {},
    currentSeriesHours: [{observedDate: '2026-10-01', timeUtc: '2026-10-01T01:00Z'}],
    currentHourIndex: 0, currentDataMode: 'observed', currentViewType: 'top-tide', currentTopTideIndex: 0,
    currentFloodLayer: {}, floodFrameState: 'ready', document: {body: {dataset: {}}}, setFloodFrameStatus() {},
    selectedObservedDate: '2026-10-01',
    getTimelineIntervalMinutes: () => c.currentTimelineIntervalMinutes, getTimelineNavigationIndex: () => c.currentHourIndex,
    stopPlayback() {}, toast() {}, updateTimelineIntervalUI() {}, updateDataModeButtons() {}, renderTopTides() {},
    cancelPendingFloodFrame() { return ++c.lastRenderToken; },
    ensureObservedArchiveForDate: async () => {},
    async loadForecast(entry, options) { calls.loads.push({kind:'forecast', entry, options}); },
    async loadReturnInterval(entry, options) { calls.loads.push({kind:'return-interval', entry, options}); },
    async loadObservedDay(date, _index, entry) { calls.loads.push({kind:'observed',date,entry}); },
    buildTopTideEvents: () => [{dateKey:'2026-10-01'}],
    async loadTopTideEvent() { calls.loads.push({kind:'top-tide'}); },
    async renderHour(index) { calls.renders.push(index); }, refreshCurrentDisplayText() {},
    ...extra
  });
  return {c, calls};
}
for (const change of ['mode', 'frame', 'reload', 'late-failure']) {
  const hold = deferred();
  const {c, calls} = intervalContext({ensureObservedArchiveForDate: () => hold.promise});
  const pending = c.setTimelineIntervalMinutes(15);
  if (change !== 'frame') c.selectionGeneration++;
  c.lastRenderToken++;
  c.currentDataMode = 'forecast'; c.currentViewType = 'forecast';
  c.currentHourIndex = 100;
  const latestSeries = [{timeUtc:'2026-10-27T18:00Z'}]; c.currentSeriesHours = latestSeries;
  if (change === 'late-failure') hold.reject(Error('Obsolete archive failed'));
  else hold.resolve();
  assert.equal(await pending, false);
  assert.equal(c.currentHourIndex, 100); assert.equal(c.currentSeriesHours, latestSeries);
  assert.deepEqual(calls.loads, []); assert.deepEqual(calls.renders, []);
  cases++;
}
{
  const {c, calls} = intervalContext({async ensureObservedArchiveForDate() {throw Error('Current archive offline');}});
  const series = c.currentSeriesHours;
  assert.equal(await c.setTimelineIntervalMinutes(15), false);
  assert.equal(c.currentTimelineIntervalMinutes, 60, 'A failed interval load must preserve the displayed interval.');
  assert.equal(c.currentSeriesHours, series); assert.equal(c.floodFrameState, 'ready');
  assert.deepEqual(calls.loads, []); assert.deepEqual(calls.renders, []);
  cases++;
}
for (const nextInterval of [15, 60]) {
  const next = {observedDate:'2026-10-02', timeUtc:'2026-10-02T10:15Z'};
  const {c,calls} = intervalContext({currentViewType:'observed-day',currentTimelineIntervalMinutes:1440});
  c.currentSeriesHours = [c.currentSeriesHours[0], next];
  c.getTimelineNavigationIndex = () => 1;
  await c.setTimelineIntervalMinutes(nextInterval);
  assert.deepEqual(calls.loads, [{kind:'observed',date:next.observedDate,entry:next}],
    'Changing cadence while another daily maximum loads must use the requested date and time');
  cases++;
}
for (const mode of ['forecast', 'return-interval']) {
  const {c, calls} = intervalContext({currentDataMode: mode, currentViewType: mode});
  await c.setTimelineIntervalMinutes(15);
  assert.equal(calls.loads.length, 1); assert.equal(calls.loads[0].kind, mode);
  assert.equal(calls.loads[0].options.generation, c.selectionGeneration);
  assert.deepEqual(calls.renders, [0]);
  cases++;
}
{
  const hold = deferred(), nodes = new Map();
  let status;
  const c = create(['switchDataMode'], {
    lastRenderToken: 1, selectionGeneration: 1, currentDataMode: 'forecast', currentViewType: 'forecast',
    currentRawSeriesHours: [{tag:'forecast'}], currentSeriesHours: [{tag:'forecast'}], currentHourIndex: 4,
    currentTopTideIndex: null, currentSelectedLabel: 'Mean', currentSelectedSubLabel: 'Mean', currentRangeLabel: 'forecast',
    currentFloodLayer: {}, selectedObservedDate: null,
    document: {getElementById(id) { if (!nodes.has(id)) nodes.set(id, {}); return nodes.get(id); }},
    stopPlayback() {}, toast() {}, updateDataModeButtons() {}, renderTopTides() {},
    cancelPendingFloodFrame(invalidate = true) {if (invalidate) c.lastRenderToken++; return c.lastRenderToken;},
    syncSliderBounds() {}, renderSelectionMeta() {}, renderTimelineMeta() {}, renderTimelineDays() {},
    setFloodFrameStatus(message) { status = message; }, warmBackgroundData: () => hold.promise,
    async renderCalendar() {}, getLatestObservedDate: () => '2026-10-26',
    async loadObservedDay() { c.currentSeriesHours = [{tag:'observed'}]; }, scheduleHistoricalTopTideWarmup() {}
  });
  const pending = c.switchDataMode('observed');
  assert.equal(c.currentDataMode, 'observed'); assert.equal(c.currentViewType, 'observed-day');
  assert.equal(c.currentSeriesHours.length, 0);
  assert.equal(nodes.get('stageSubText').textContent, 'Loading observed history…');
  assert.match(status, /Loading observed history.*Previous flood map shown/);
  hold.resolve(); await pending; assert.equal(c.currentSeriesHours[0].tag, 'observed');
  // The same active Past control must retry after an unavailable history,
  // rather than requiring a detour to Forecast or a browser reload.
  c.currentSeriesHours = []; c.currentRawSeriesHours = [];
  let retries = 0;
  c.warmBackgroundData = async () => {retries++;};
  await c.switchDataMode('observed');
  assert.equal(retries, 1); assert.equal(c.currentSeriesHours[0].tag, 'observed');
  cases++;
}
for (const outcome of ['success', 'failure', 'superseded']) {
  const hold = deferred(), nodes = new Map(), rendered = [], status = [];
  const old = [{timeUtc: '2026-01-02T12:00:00Z', stageFt: 2.8}];
  const forecast = [{timeUtc: '2026-11-08T18:00:00Z', stageFt: 1.2}];
  const newer = [{timeUtc: '2026-02-01T12:00:00Z', stageFt: 4}];
  const getForecastScenarioHours = (data, scenario) => data?.scenarioForecasts?.[scenario]?.hours ||
    (scenario === 'mean' ? data?.hours || [] : []);
  let requests = 0;
  const c = create(['loadForecast', 'switchDataMode', 'switchOverlayMode', 'setTimelineIntervalMinutes'], {
    lastRenderToken: 1, selectionGeneration: 1, currentDataMode: 'observed', currentViewType: 'observed-day',
    currentRawSeriesHours: old, currentSeriesHours: old, currentHourIndex: 0, currentTopTideIndex: null,
    currentOverlayMode: 'depth', currentTimelineIntervalMinutes: 60, overlayPreloadGeneration: 0,
    currentSelectedLabel: 'Observed', currentSelectedSubLabel: '', currentRangeLabel: '',
    currentFloodLayer: {entry: old[0]}, forecastData: null, physicsForecastManifests: {},
    getForecastFreshness:() => ({state:null}), getForecastSourceForNotice:() => null, scheduleForecastFreshnessNotice() {},
    FORECAST_URL: 'forecast.json', FORECAST_SCENARIOS: {mean: {}, highEnd: {}},
    currentForecastScenario: 'mean', withFreshJsonUrl: url => url,
    getForecastScenarioHours, getStageValue: entry => entry.stageFt, entryTimeMs: entry => Date.parse(entry.timeUtc),
    physicsForecastApplies: () => false,
    fetchJson() { requests++; return hold.promise; },
    document: {getElementById(id) { if (!nodes.has(id)) nodes.set(id, {}); return nodes.get(id); }},
    getTimelineIntervalMinutes: () => c.currentTimelineIntervalMinutes, getTimelineNavigationIndex: () => c.currentHourIndex, updateTimelineIntervalUI() {},
    getForecastScenarioLabel: () => 'Mean', getForecastScenarioPercentileLabel: () => '',
    cancelPendingFloodFrame(invalidate = true) { if (invalidate) c.lastRenderToken++; return c.lastRenderToken; },
    stopPlayback() {}, toast() {}, updateModeButtons() {}, updateDataModeButtons() {}, renderTopTides() {},
    syncSliderBounds() {}, renderSelectionMeta() {}, renderTimelineMeta() {}, renderTimelineDays() {},
    loadTopTideEvent() {}, loadPhysicsForecast: async () => null, getPhysicsForecastDisplaySeries: () => null,
    clearExportAvailabilityCache() {}, getActiveForecastHours: () => getForecastScenarioHours(c.forecastData, c.currentForecastScenario),
    buildForecastCanonicalSeries: entries => entries, buildForecastDisplaySeries: entries => entries,
    formatHourEntryTime: entry => entry.timeUtc, getPeakHourIndex: () => 0,
    clearFloodLayer() { c.currentFloodLayer = null; },
    setFloodFrameStatus(message) { status.push(message); },
    async loadReturnInterval() { c.currentSeriesHours = newer; return true; },
    async renderHour(index) { rendered.push([c.currentViewType, c.currentOverlayMode, c.currentTimelineIntervalMinutes, c.currentSeriesHours[index]]); }
  });
  const loading = c.switchDataMode('forecast');
  assert.equal(c.currentSeriesHours.length, 0, 'Pending forecast cannot relabel the prior Past series');
  assert.equal(nodes.get('stageSubText').textContent, 'Loading forecast…');
  assert.equal(c.currentFloodLayer.entry, old[0]);
  const renderToken = c.lastRenderToken;
  await c.switchOverlayMode('dynamic');
  await c.setTimelineIntervalMinutes(15);
  await c.switchDataMode('forecast');
  assert.equal(c.lastRenderToken, renderToken, 'Presentation settings keep the pending data request current');
  assert.equal(requests, 1);
  assert.deepEqual(rendered, []);
  if (outcome === 'superseded') await c.switchDataMode('return-interval');
  if (outcome === 'failure') hold.reject(Error('Active Forecast failed'));
  else hold.resolve({hours: forecast});
  await loading;
  if (outcome === 'success') {
    assert.deepEqual(rendered, [['forecast', 'dynamic', 15, forecast[0]]]);
    const partial = c.forecastData;
    const high = [{...forecast[0], stageFt: 2}];
    c.currentForecastScenario = 'highEnd';
    c.fetchJson = async () => ({scenarioForecasts: {highEnd: {hours: high}}});
    assert.equal(await c.loadForecast(), false);
    assert.equal(c.forecastData, partial, 'An incomplete retry must retain the earlier usable Mean forecast');
    const complete = {hours: forecast, scenarioForecasts: {highEnd: {hours: high}}};
    c.fetchJson = async () => complete;
    await c.loadForecast();
    assert.equal(c.forecastData, complete);
    assert.equal(c.currentSeriesHours[0], high[0]);
    c.fetchJson = async () => ({...complete, forecastEndUtc:'2026-11-08T19:00:00Z'});
    assert.equal(await c.loadForecast(null, {forceRefresh:true}), false);
    assert.equal(c.forecastData, complete, 'An invalid coverage window cannot replace fully usable cached scenarios');
    cases += 2;
  }
  if (outcome === 'failure') {
    assert.equal(c.currentFloodLayer, null);
    assert.equal(nodes.get('stageSubText').textContent, 'Forecast could not load');
    assert.match(status.at(-1), /Forecast could not load/);
  }
  if (outcome === 'superseded') {
    assert.deepEqual(rendered, [['return-interval', 'dynamic', 15, newer[0]]]);
    assert.equal(c.forecastData, null, 'The superseded request may not update the forecast cache');
  }
  assert.equal(c.loadForecast.pendingSelectionGeneration, null);
  cases++;
}
console.log(`${cases} history deadline, retry, pending-mode and selection-race regression cases passed.`);
