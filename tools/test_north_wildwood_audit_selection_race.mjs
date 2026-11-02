// HISTORY-01: delayed Top 10 history must honor both selection and map tokens.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

const runtimeDir = process.env.NORTH_WILDWOOD_AUDIT_RUNTIME_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), 'app/runtime');
const source = fs.readFileSync(path.join(runtimeDir, '22-calendar-and-modes.js'), 'utf8');
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
    currentBaseModeBeforeTopTide: '', currentTopTideIndex: null, selectedObservedDate: '',
    currentSelectedLabel: 'Mean', currentSelectedSubLabel: '', currentRangeLabel: '', currentMonthKey: '',
    stopPlayback() {}, cancelPendingFloodFrame() {return ++c.lastRenderToken;},
    updateDataModeButtons() {}, updateModeButtons() {}, toast() {},
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

// Exact audit trigger: switch Depth/Stages while the historical shard waits.
{
  const {c, calls, hold, oldEntry} = setup();
  const pending = c.loadTopTideEvent(0); await tick();
  await c.switchOverlayMode('dynamic');
  hold.resolve(true);
  assert.equal(await pending, false);
  assert.equal(c.currentSeriesHours[0], oldEntry, 'An overlay-cancelled archive must preserve the current timeline');
  assert.equal(c.displayedEntry, oldEntry);
  assert.equal(c.currentViewType, 'forecast');
  assert.equal(c.currentSelectedLabel, 'Mean');
  assert.equal(c.currentTopTideIndex, null);
  assert.equal(calls.lists, 0); assert.equal(calls.warmups, 0);
  cases++;
}

// Every asynchronous boundary is guarded; a late failure from an obsolete
// request is ignored while an active failure still reaches the caller.
for (const stage of ['warmup', 'lewes-index', 'archive', 'crest-image', 'calendar', 'render']) {
  for (const outcome of ['success', 'failure']) {
    for (const cancellation of ['render-token', 'selection-generation']) {
      const {c, calls, hold} = setup(stage);
      const pending = c.loadTopTideEvent(0); await tick();
      if (cancellation === 'render-token') c.lastRenderToken++;
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

console.log(`${cases} audit historical-selection cancellation and reverse-order cases passed.`);
