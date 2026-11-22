// Delayed Top 10 data belongs to a selection; committed frames also honor map tokens.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

const runtimeDir = process.env.NORTH_WILDWOOD_AUDIT_RUNTIME_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), 'app/runtime');
const source = fs.readFileSync(path.join(runtimeDir, '22-calendar-and-modes.js'), 'utf8');
const presentationSource = fs.readFileSync(path.join(runtimeDir, '05-presentation.js'), 'utf8');
function extract(name) {
  const match = source.match(new RegExp(`^    (?:async )?function ${name}\\([^\\n]*\\) \\{\\n.*?^    \\}`, 'ms'));
  assert.ok(match, name); return match[0];
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}
const tick = () => new Promise(resolve => setImmediate(resolve));
let cases = 0;

function setup(stage = 'archive') {
  const hold = deferred(), calls = {renders: [], lists: 0, warmups: 0, archive: 0};
  const oldEntry = {timeUtc: '2026-11-02T12:00:00Z', stageFt: 2, marker: 'previous forecast'};
  const events = [0, 1].map(i => {
    const entry = {timeUtc: `1962-03-0${6 + i}T12:00:00Z`, stageFt: 8 - i, marker: `historical tide ${i}`};
    return {dateKey: `1962-03-0${6 + i}`, entry, series: [entry], rank: i + 1, title: `1962 event ${i}`, peakStage: 8 - i, sourceType: 'historical'};
  });
  let firstRender = true;
  const c = vm.createContext({
    Promise, console, selectionGeneration: 0, lastRenderToken: 0, topTideEvents: events,
    observedData: stage === 'warmup' ? null : {}, currentDataMode: 'forecast', currentViewType: 'forecast', currentOverlayMode: 'depth',
    currentSeriesHours: [oldEntry], currentRawSeriesHours: [oldEntry], currentHourIndex: 0,
    getTimelineNavigationIndex: () => c.currentHourIndex,
    currentBaseModeBeforeTopTide: '', currentTopTideIndex: null, selectedObservedDate: '',
    currentSelectedLabel: 'Mean', currentSelectedSubLabel: '', currentRangeLabel: '', currentMonthKey: '',
    stopPlayback() {}, cancelPendingFloodFrame(invalidate = true) {if (invalidate) c.lastRenderToken++; return c.lastRenderToken;},
    updateDataModeButtons() {}, updateModeButtons() {}, toast() {}, setFloodFrameStatus() {},
    async loadReturnInterval() {}, async loadForecast() {},
    warmBackgroundData: () => stage === 'warmup' ? hold.promise : Promise.resolve(),
    getObservedArchiveSourceForDate: () => stage === 'lewes-index' ? 'lewes' : 'stone-harbor',
    ensureLewesArchiveIndex: () => stage === 'lewes-index' ? hold.promise : Promise.resolve(),
    getOverlayStage: value => value,
    getOverlayRecord: async () => stage === 'crest-image' ? {url: 'crest.png'} : null,
    preloadImage: () => stage === 'crest-image' ? hold.promise : Promise.resolve(),
    ensureObservedArchiveForDate() {calls.archive++; return stage === 'archive' ? hold.promise : Promise.resolve();},
    buildTopTideEvents: () => events, formatStageForDisplay: String,
    getTimelineIntervalMinutes: () => 60, syncSliderBounds() {}, getPeakHourIndex: () => 0,
    document: {getElementById: () => ({value: ''})},
    renderCalendar: () => stage === 'calendar' ? hold.promise : Promise.resolve(),
    renderTopTides() {calls.lists++;}, scheduleHistoricalTopTideWarmup() {calls.warmups++;},
    async renderHour(index) {
      ++c.lastRenderToken;
      const entry = c.currentSeriesHours[index];
      calls.renders.push(entry);
      if (stage === 'render' && firstRender) {firstRender = false; await hold.promise;}
      c.displayedEntry = entry;
    }
  });
  vm.runInContext(extract('loadTopTideEvent') + '\n' + extract('switchOverlayMode'), c);
  return {c, calls, hold, oldEntry, events};
}

function attachModeControls(c, mode = 'forecast') {
  const nodes = new Map();
  const classList = () => {
    const values = new Set();
    return {toggle(name, active) {if (active) values.add(name); else values.delete(name);},
      contains: name => values.has(name)};
  };
  c.document = {body: {dataset: {}, classList: classList()}, getElementById(id) {
    if (!nodes.has(id)) {
      const attributes = new Map();
      nodes.set(id, {classList: classList(), dataset: {}, style: {}, hidden: false, value: '', textContent: '',
        setAttribute(name, value) {attributes.set(name, String(value));},
        getAttribute(name) {return attributes.get(name) ?? null;}});
    }
    return nodes.get(id);
  }};
  Object.assign(c, {
    getForecastScenarioLabel: () => 'Mean', getReturnIntervalLabel: () => '10-Year',
    setObservedCalendarOpen() {}, updateForecastScenarioButtons() {}, updateReturnIntervalButtons() {},
    updateObservedResolutionUI() {}, updateDownloadModeCopy() {}, syncLeftPanelLayout() {},
    getForecastSourceForNotice: () => null, getForecastFreshness: () => ({state: null}), scheduleForecastFreshnessNotice() {},
    renderSelectionMeta() {}, renderTimelineMeta() {}, renderTimelineDays() {}, setFloodFrameStatus() {}
  });
  const update = presentationSource.match(/^    function updateDataModeButtons\([^\n]*\) \{\n.*?^    \}/ms);
  assert.ok(update);
  vm.runInContext(update[0] + '\n' + extract('switchDataMode'), c);
  c.currentDataMode = mode;
  c.currentFloodLayer = null;
  c.currentViewType = mode === 'observed' ? 'observed-day' : mode;
  c.currentBaseModeBeforeTopTide = 'prior-base-mode';
  const entry = {timeUtc: '2026-11-02T12:00:00Z', stageFt: 2, marker: `previous ${mode}`};
  c.currentSeriesHours = [entry]; c.currentRawSeriesHours = [entry]; c.displayedEntry = entry;
  c.updateDataModeButtons();
  return {
    assertMode(expected) {
      assert.equal(c.currentDataMode, expected);
      for (const [name, id] of [['forecast', 'forecastDataBtn'], ['observed', 'observedDataBtn'], ['return-interval', 'returnIntervalDataBtn']]) {
        assert.equal(nodes.get(id).classList.contains('active'), expected === name, `${id} must match the committed mode`);
        assert.equal(nodes.get(id).getAttribute('aria-pressed'), String(expected === name), `${id} must expose the committed mode to assistive technology`);
      }
      assert.equal(nodes.get('dataModePill').textContent, expected === 'forecast' ? 'Mean' : expected === 'observed' ? 'Observed' : '10-Year');
      assert.equal(nodes.get('forecastScenarioCard').hidden, expected !== 'forecast');
      assert.equal(nodes.get('returnIntervalCard').style.display, expected === 'return-interval' ? '' : 'none');
      assert.equal(nodes.get('calendarCard').classList.contains('active'), expected === 'observed');
      assert.equal(nodes.get('leftPanel').dataset.dataMode, expected);
      assert.equal(c.document.body.classList.contains('observed-mode'), expected === 'observed');
      assert.equal(c.document.body.classList.contains('return-interval-mode'), expected === 'return-interval');
    },
    assertOverlay(expected) {
      for (const [name, id] of [['depth', 'depthModeBtn'], ['dynamic', 'dynamicModeBtn']]) {
        assert.equal(nodes.get(id).classList.contains('active'), expected === name, `${id} must match the committed overlay`);
        assert.equal(nodes.get(id).getAttribute('aria-pressed'), String(expected === name), `${id} must expose the committed overlay to assistive technology`);
      }
    }
  };
}

function navigationStubs(c) {
  const loads = {forecast: 0, observed: 0, 'return-interval': 0, history: 0};
  const apply = mode => {
    loads[mode]++;
    const entry = {timeUtc: '2026-11-02T12:00:00Z', stageFt: 2, marker: `reselected ${mode}`};
    c.currentRawSeriesHours = [entry]; c.currentSeriesHours = [entry]; c.currentHourIndex = 0;
    c.currentViewType = mode === 'observed' ? 'observed-day' : mode;
    c.currentTopTideIndex = null; c.currentSelectedLabel = mode;
  };
  c.loadForecast = async () => apply('forecast');
  c.loadReturnInterval = async () => apply('return-interval');
  c.loadObservedDay = async () => apply('observed');
  c.warmBackgroundData = async () => {loads.history++; c.observedData = {};};
  c.getLatestObservedDate = () => '2026-11-02';
  return loads;
}

// Presentation controls belong to the pending historical selection, even when
// its preceding committed selection is still the forecast.
{
  const {c, calls, hold, oldEntry} = setup();
  const pending = c.loadTopTideEvent(0); await tick();
  await c.switchOverlayMode('dynamic');
  hold.resolve(true);
  await pending;
  assert.notEqual(c.currentSeriesHours[0], oldEntry, 'The requested historical data must commit with the chosen overlay');
  assert.equal(c.displayedEntry.marker, 'historical tide 0');
  assert.equal(c.currentOverlayMode, 'dynamic');
  assert.equal(c.currentViewType, 'top-tide');
  assert.equal(c.currentSelectedLabel, 'Flood #1');
  assert.equal(c.currentTopTideIndex, 0);
  assert.equal(calls.lists, 1); assert.equal(calls.warmups, 1);
  cases++;
}

// An obsolete presentation-specific crest prewarm is optional, including when
// the user changes overlay before that image fails. Data ownership survives.
{
  const {c, calls, hold} = setup('crest-image');
  const pending = c.loadTopTideEvent(0); await tick();
  await c.switchOverlayMode('dynamic');
  hold.reject(new Error('The previous Depth prewarm failed'));
  await pending;
  assert.equal(c.currentViewType, 'top-tide');
  assert.equal(c.currentOverlayMode, 'dynamic');
  assert.equal(c.displayedEntry.marker, 'historical tide 0');
  assert.equal(calls.renders.length, 1);
  cases++;
}

// A background catalog refresh may change ranks while the first request waits;
// its identity is the clicked date, not the current occupant of the old rank.
{
  const {c, hold, events} = setup('warmup');
  const pending = c.loadTopTideEvent(0); await tick();
  c.topTideEvents = [events[1], events[0]];
  hold.resolve(true); await pending;
  assert.equal(c.selectedObservedDate, events[0].dateKey);
  assert.equal(c.displayedEntry.marker, 'historical tide 0');
  cases++;
}

// Every asynchronous boundary is guarded; a late failure from an obsolete
// request is ignored while an active failure still reaches the caller.
for (const stage of ['warmup', 'lewes-index', 'archive', 'crest-image', 'calendar', 'render']) {
  for (const outcome of ['success', 'failure']) {
    for (const cancellation of ['render-token', 'selection-generation']) {
      const {c, calls, hold} = setup(stage);
      const pending = c.loadTopTideEvent(0); await tick();
      if (cancellation === 'render-token') {
        c.lastRenderToken++;
        // Before the historical series commits, real source/date navigation
        // advances the selection generation too. A presentation-only token
        // change is not navigation. After commit, a newer frame alone suffices.
        if (!['calendar', 'render'].includes(stage)) c.selectionGeneration++;
      }
      else c.selectionGeneration++;
      const latest = [{marker: `newer ${stage} ${outcome}`}];
      c.currentSeriesHours = latest; c.currentRawSeriesHours = latest;
      c.currentSelectedLabel = 'New selection'; c.currentViewType = 'observed-day'; c.currentTopTideIndex = null;
      const renders = calls.renders.length;
      if (outcome === 'success') hold.resolve(true);
      else hold.reject(new Error(`Obsolete ${stage} failure`));
      assert.equal(await pending, false, `${stage} must stop after ${cancellation}`);
      assert.equal(c.currentSeriesHours, latest, `${stage} must preserve the newer series`);
      assert.equal(c.currentRawSeriesHours, latest);
      assert.equal(c.currentSelectedLabel, 'New selection');
      assert.equal(c.currentViewType, 'observed-day');
      assert.equal(c.currentTopTideIndex, null);
      assert.equal(calls.renders.length, renders, `${stage} must not render after cancellation`);
      assert.equal(calls.lists, 0); assert.equal(calls.warmups, 0);
      cases++;
    }
  }
}
for (const stage of ['warmup', 'lewes-index', 'archive', 'calendar', 'render']) {
  const {c, hold} = setup(stage);
  const pending = c.loadTopTideEvent(0); await tick();
  hold.reject(new Error(`Active ${stage} failure`));
  await assert.rejects(pending, new RegExp(`Active ${stage} failure`));
  cases++;
}

// A newer top-tide request wins when two archive responses finish in reverse
// order; the older response must not rebuild the event catalog or labels.
for (const outcome of ['success', 'failure']) {
  const {c, calls, events} = setup('none');
  const old = deferred(), latest = deferred();
  c.ensureObservedArchiveForDate = date => date === events[0].dateKey ? old.promise : latest.promise;
  const oldRequest = c.loadTopTideEvent(0); await tick();
  const latestRequest = c.loadTopTideEvent(1); await tick();
  latest.resolve(true); await latestRequest;
  const latestSeries = c.currentSeriesHours;
  assert.equal(c.currentTopTideIndex, 1);
  assert.equal(c.displayedEntry.marker, 'historical tide 1');
  if (outcome === 'success') old.resolve(true);
  else old.reject(new Error('Old archive failed'));
  assert.equal(await oldRequest, false);
  assert.equal(c.currentSeriesHours, latestSeries);
  assert.equal(c.currentSelectedLabel, 'Flood #2');
  assert.equal(calls.renders.length, 1);
  assert.equal(calls.lists, 1); assert.equal(calls.warmups, 1);
  cases++;
}

// A normal delayed selection still renders once, even though renderHour
// advances lastRenderToken itself; its completion can safely warm the catalog.
{
  const {c, calls, hold, events} = setup();
  const pending = c.loadTopTideEvent(0); await tick(); hold.resolve(true); await pending;
  assert.equal(c.currentSeriesHours[0].marker, events[0].entry.marker);
  assert.equal(c.displayedEntry.marker, events[0].entry.marker);
  assert.equal(c.currentViewType, 'top-tide');
  assert.equal(calls.renders.length, 1);
  assert.equal(calls.lists, 1); assert.equal(calls.warmups, 1);
  cases++;
}

// Before the historical selection commits, keep the real active mode, pill,
// cards, and panel classes aligned with the map and timeline. An asset preload
// failure is optional; other active failures leave the prior selection intact.
for (const mode of ['forecast', 'observed', 'return-interval']) {
  for (const stage of ['warmup', 'lewes-index', 'archive', 'crest-image']) {
    for (const outcome of ['cancelled-success', 'cancelled-failure', 'active-failure', 'active-success']) {
      const {c, calls, hold} = setup(stage);
      const controls = attachModeControls(c, mode);
      const previousSeries = c.currentSeriesHours, previousView = c.currentViewType;
      const pending = c.loadTopTideEvent(0); await tick();
      controls.assertMode(mode);
      assert.equal(c.currentBaseModeBeforeTopTide, 'prior-base-mode');
      assert.equal(c.currentViewType, previousView); assert.equal(c.currentSeriesHours, previousSeries);
      assert.equal(c.loadTopTideEvent.pendingSelectionGeneration, c.selectionGeneration);
      if (outcome.startsWith('cancelled')) {
        c.selectionGeneration++;
        c.lastRenderToken++;
      }
      if (outcome.endsWith('failure')) hold.reject(new Error(`Mode-state ${stage} failure`));
      else hold.resolve(true);
      const commits = outcome === 'active-success' || (outcome === 'active-failure' && stage === 'crest-image');
      if (outcome === 'active-failure' && stage !== 'crest-image') await assert.rejects(pending, /Mode-state/);
      else if (outcome.startsWith('cancelled')) assert.equal(await pending, false);
      else await pending;
      assert.equal(c.loadTopTideEvent.pendingSelectionGeneration, null);
      controls.assertMode(commits ? 'observed' : mode);
      assert.equal(c.currentViewType, commits ? 'top-tide' : previousView);
      assert.equal(c.currentBaseModeBeforeTopTide, commits ? mode : 'prior-base-mode');
      if (!commits) {
        assert.equal(c.currentSeriesHours, previousSeries);
        assert.equal(c.displayedEntry, previousSeries[0]);
        assert.equal(calls.warmups, 0);
      }
      cases++;
    }
  }
}

// Explicitly reselecting the currently active mode while history waits means
// cancel that history request. The same idle click remains a request-free no-op.
for (const mode of ['forecast', 'observed', 'return-interval']) {
  for (const stage of ['warmup', 'lewes-index', 'archive', 'crest-image']) {
    for (const outcome of ['success', 'failure']) {
      const {c, calls, hold} = setup(stage);
      const controls = attachModeControls(c, mode);
      const pending = c.loadTopTideEvent(0); await tick();
      const tideGeneration = c.selectionGeneration;
      const loads = navigationStubs(c);
      await c.switchDataMode(mode);
      assert.equal(loads[mode], 1, 'An active-mode click must navigate when a historical selection is pending');
      assert(c.selectionGeneration > tideGeneration);
      controls.assertMode(mode);
      const latestSeries = c.currentSeriesHours, renders = calls.renders.length, warmups = calls.warmups;
      if (outcome === 'success') hold.resolve(true); else hold.reject(new Error('Reselected mode cancelled history'));
      assert.equal(await pending, false);
      assert.equal(c.currentSeriesHours, latestSeries);
      assert.equal(c.currentSeriesHours[0].marker, `reselected ${mode}`);
      assert.equal(c.currentViewType, mode === 'observed' ? 'observed-day' : mode);
      assert.equal(calls.renders.length, renders); assert.equal(calls.warmups, warmups);
      assert.equal(c.loadTopTideEvent.pendingSelectionGeneration, null);
      controls.assertMode(mode);
      const idleGeneration = c.selectionGeneration, idleToken = c.lastRenderToken;
      await c.switchDataMode(mode);
      assert.equal(loads[mode], 1, 'An idle active-mode click must retain the existing no-request fast path');
      assert.equal(c.selectionGeneration, idleGeneration); assert.equal(c.lastRenderToken, idleToken);
      cases++;
    }
  }
}

// An older completion/failure cannot clear the newer request's owner stamp.
// The still-pending newer request must remain cancellable by an active-mode click.
for (const oldOutcome of ['success', 'failure']) {
  for (const latestOutcome of ['success', 'failure']) {
    const {c, calls, events} = setup('none');
    const controls = attachModeControls(c);
    const old = deferred(), latest = deferred();
    c.ensureObservedArchiveForDate = date => date === events[0].dateKey ? old.promise : latest.promise;
    const oldRequest = c.loadTopTideEvent(0); await tick();
    const latestRequest = c.loadTopTideEvent(1); await tick();
    const owner = c.loadTopTideEvent.pendingSelectionGeneration;
    if (oldOutcome === 'success') old.resolve(true); else old.reject(new Error('Obsolete owner failed'));
    assert.equal(await oldRequest, false);
    assert.equal(c.loadTopTideEvent.pendingSelectionGeneration, owner, 'Older finally must not clear the newer owner');
    controls.assertMode('forecast');
    const loads = navigationStubs(c); await c.switchDataMode('forecast');
    assert.equal(loads.forecast, 1);
    const latestSeries = c.currentSeriesHours, renders = calls.renders.length;
    if (latestOutcome === 'success') latest.resolve(true); else latest.reject(new Error('Cancelled newer owner failed'));
    assert.equal(await latestRequest, false);
    assert.equal(c.currentSeriesHours, latestSeries); assert.equal(calls.renders.length, renders);
    assert.equal(c.loadTopTideEvent.pendingSelectionGeneration, null);
    controls.assertMode('forecast');
    cases++;
  }
}

// The visual and accessible selection must agree before initialization, across
// every combination of modes, and when the optional modeled button is absent.
let accessibleCases = 0;
{
  const template = fs.readFileSync(new URL('./app/index.template.html', import.meta.url), 'utf8');
  for (const [id, active] of [['forecastDataBtn', true], ['observedDataBtn', false], ['returnIntervalDataBtn', false],
    ['depthModeBtn', true], ['dynamicModeBtn', false]]) {
    const tag = template.match(new RegExp(`<button id="${id}"[^>]*>`))?.[0];
    assert.ok(tag, id);
    assert.equal(tag.match(/aria-pressed="([^"]*)"/)?.[1], String(active), `${id} starts with its visual selected state`);
  }
  accessibleCases++;
}
{
  const {c} = setup('none'), controls = attachModeControls(c);
  const update = presentationSource.match(/^    function updateModeButtons\([^\n]*\) \{\n.*?^    \}/ms);
  assert.ok(update);
  c.renderLegend = () => {};
  vm.runInContext(update[0], c);
  for (const mode of ['forecast', 'observed', 'return-interval']) {
    for (const overlay of ['depth', 'dynamic', 'depth']) {
      c.currentDataMode = mode;
      c.currentOverlayMode = overlay;
      c.updateDataModeButtons(); c.updateModeButtons();
      controls.assertMode(mode); controls.assertOverlay(overlay);
      accessibleCases++;
    }
  }
  const getElementById = c.document.getElementById;
  c.document.getElementById = id => id === 'returnIntervalDataBtn' ? null : getElementById(id);
  c.currentDataMode = 'forecast';
  assert.doesNotThrow(() => c.updateDataModeButtons(), 'The optional modeled button remains optional');
  accessibleCases++;
}

console.log(`${cases} audit historical-selection cancellation and reverse-order cases passed.`);
console.log(`${accessibleCases} accessible mode-state cases passed.`);
