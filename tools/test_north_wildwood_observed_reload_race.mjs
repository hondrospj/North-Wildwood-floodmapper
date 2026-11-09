// Exercise real observed-history functions with requests held across Reload.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = ['19-observed-history', '21-forecast-and-observed-loading', '23-refresh-and-playback']
  .map(name => fs.readFileSync(new URL(`./app/runtime/${name}.js`, import.meta.url), 'utf8')).join('\n');
function extract(name) {
  const match = source.match(new RegExp(`^    (?:async )?function ${name}\\([^\\n]*\\) \\{\\n.*?^    \\}`, 'ms'));
  assert.ok(match, name);
  return match[0];
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}
const tick = () => new Promise(resolve => setImmediate(resolve));
let cases = 0;
function context(extra = {}) {
  const calls = [];
  const c = vm.createContext({
    Promise, Map, Set, console: {warn() {}}, archiveGeneration: 1,
    observedData: {archiveEndDate: '2026-10-31', days: [{date: '2026-10-31'}]},
    observed15MinuteData: null, observedDaysCache: null, observedMonthKeys: [], topTideEvents: [],
    getTodayNyDateKey: () => '2026-11-01',
    getObservedArchiveLatestDateKey: () => c.observedData?.archiveEndDate,
    addDaysToDateKey: () => '2026-11-01',
    compareDateKeys: (a, b) => a.localeCompare(b),
    fetchRecentUsgsObservedDays: async () => [{date: '2026-11-01', hours: [{navd88StageFt: 2}]}],
    addOrMergeObservedDayRecord(day) {
      calls.push('merge');
      c.observedData ||= {days: []};
      c.observedData.days.push(day);
    },
    ensureObservedDatePlaceholders() {calls.push('placeholders');},
    clearExportAvailabilityCache() {calls.push('cache');},
    historicTopTideEntries: [],
    ensureObserved15MinuteArchive: async () => ({days: []}),
    buildObservedIndexFrom15MinuteArchive: payload => payload,
    loadHistoricalTopTides: async () => {calls.push('crests');},
    mergeHistoricalCrestsIntoObservedIndex() {calls.push('merge-crests');},
    getObservedDays: () => c.observedData?.days || [],
    buildObservedMonthKeysFromDays: () => ['2026-11'],
    buildTopTideEvents: () => [], renderTopTides() {calls.push('render');},
    currentMonthKey: null, populateCalendarSelectors() {calls.push('selectors');},
    scheduleLewesArchiveIndexWarmup() {calls.push('schedule');},
    ...extra
  });
  for (const name of ['extendObservedArchiveThroughToday', 'loadObserved']) vm.runInContext(extract(name), c);
  return {c, calls};
}

for (const outcome of ['success', 'failure']) {
  const hold = deferred();
  const {c, calls} = context({fetchRecentUsgsObservedDays: () => hold.promise});
  const loading = c.loadObserved();
  await tick();
  c.archiveGeneration++;
  c.observedData = null;
  const latestCache = {tag: 'latest'};
  c.observedDaysCache = latestCache;
  if (outcome === 'success') hold.resolve([{date: '2026-11-01', hours: [{navd88StageFt: 8}]}]);
  else hold.reject(Error('Obsolete USGS request failed'));
  await loading;
  assert.equal(c.observedData, null, 'An obsolete USGS request must not recreate cleared history');
  assert.equal(c.observedDaysCache, latestCache, 'An obsolete load must not invalidate the latest cache');
  assert.deepEqual(calls, [], 'Neither successful nor failed stale backfill may continue placeholders or UI work');
  cases++;
}

for (const stage of ['index', 'crests']) {
  const hold = deferred();
  const {c, calls} = context();
  if (stage === 'index') {
    c.observedData = null;
    c.ensureObserved15MinuteArchive = () => hold.promise;
  } else {
    c.observedData.archiveEndDate = '2026-11-01';
    c.observedData.liveObservedRefresh = {generation: 1, date: '2026-11-01', nextRefreshAt: Infinity, promise: null};
    c.loadHistoricalTopTides = () => hold.promise;
  }
  const loading = c.loadObserved();
  await tick();
  c.archiveGeneration++;
  const fresh = {archiveEndDate: '2026-11-01', days: [{date: '2026-11-01', tag: 'fresh'}]};
  c.observedData = fresh;
  hold.resolve({archiveEndDate: '2026-10-31', days: [{date: '2026-10-31', tag: 'old'}]});
  await loading;
  assert.equal(c.observedData, fresh, `An obsolete ${stage} request must preserve the latest history`);
  assert.deepEqual(calls, [], `An obsolete ${stage} request must stop the follow-up chain`);
  cases++;
}

{
  const {c, calls} = context();
  await c.loadObserved();
  assert.equal(c.observedData.archiveEndDate, '2026-11-01');
  assert.equal(c.observedData.days.at(-1).date, '2026-11-01');
  assert.deepEqual(calls, ['merge', 'placeholders', 'cache', 'crests', 'merge-crests', 'render', 'selectors', 'schedule']);
  assert.equal(c.currentMonthKey, '2026-11');
  cases++;
}

{
  const hold = deferred();
  const {c} = context({
    backgroundDataPromise: null, observed15MinuteData: null,
    ensureCanonicalDailyArchive: async () => ({days: [{date: '2026-10-31'}]}),
    buildObservedIndexFromCanonical: payload => payload,
    mergeObservedArchiveIndex() {},
  });
  c.loadObserved = () => hold.promise;
  vm.runInContext(extract('warmBackgroundData'), c);
  const old = c.warmBackgroundData();
  await tick();
  c.archiveGeneration++;
  const fresh = {days: [{date: '2026-11-01', tag: 'fresh'}]};
  c.observedData = fresh;
  const freshRequest = Promise.resolve(fresh);
  c.backgroundDataPromise = freshRequest;
  hold.resolve();
  assert.equal(await old, null, 'An obsolete warmup must not report newer history as its own success');
  assert.equal(c.observedData, fresh);
  assert.equal(c.backgroundDataPromise, freshRequest);
  cases++;
}

for (const outcome of ['success', 'failure']) {
  const old = deferred(), latest = deferred();
  let requests = 0;
  const c = vm.createContext({Promise, archiveGeneration: 1,
    historicTopTideEntries: [], historicalTopTidesPromise: null, TOP_TIDES_URL: 'toptides.json',
    fetchJson: () => ++requests === 1 ? old.promise : latest.promise,
    normalizeTopTidesJsonEntry: value => value
  });
  vm.runInContext(extract('loadHistoricalTopTides'), c);
  const loadingOld = c.loadHistoricalTopTides();
  c.archiveGeneration++; c.historicalTopTidesPromise = null;
  const loadingLatest = c.loadHistoricalTopTides();
  const latestPromise = c.historicalTopTidesPromise;
  latest.resolve({toptides: [{date: '2026-11-01', tag: 'fresh'}]});
  await loadingLatest;
  const freshEntries = c.historicTopTideEntries;
  if (outcome === 'success') old.resolve({toptides: [{date: '2026-10-31', tag: 'old'}]});
  else old.reject(Error('Old crest request failed'));
  await assert.rejects(loadingOld, outcome === 'success' ? /superseded by Reload/ : /Old crest/);
  assert.equal(c.historicTopTideEntries, freshEntries, 'An old crest request must not replace or clear newer crests');
  assert.equal(c.historicalTopTidesPromise, latestPromise, 'An old failed request must not clear a newer crest promise');
  cases++;
}

{
  const held = deferred(), calls = [];
  const c = vm.createContext({Promise, archiveGeneration: 1, topTideEvents: [],
    console: {warn() {calls.push('warn');}},
    loadHistoricalTopTides: () => held.promise,
    ensureObserved15MinuteArchive: async () => ({}),
    buildTopTideEvents() {calls.push('rank'); return [];},
    renderTopTides() {calls.push('render');}
  });
  vm.runInContext(extract('scheduleTopTidesListWarmup'), c);
  c.scheduleTopTidesListWarmup();
  c.archiveGeneration++;
  const fresh = [{date: '2026-11-01'}]; c.topTideEvents = fresh;
  held.resolve([]);
  await tick();
  assert.equal(c.topTideEvents, fresh);
  assert.deepEqual(calls, [], 'An old list warmup must not rank or render after Reload');
  cases++;
}

console.log(`${cases} observed Reload-race regression cases passed.`);
