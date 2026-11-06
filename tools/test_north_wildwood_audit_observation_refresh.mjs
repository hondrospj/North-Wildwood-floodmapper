// Frozen OBS-01 reproduction plus freshness, quality, and Reload contracts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

const toolDir = path.dirname(fileURLToPath(import.meta.url));
const runtimeDir = process.env.NORTH_WILDWOOD_AUDIT_RUNTIME_ROOT || path.join(toolDir, 'app/runtime');
const configSource = fs.readFileSync(path.join(toolDir, 'app/town-config.js'), 'utf8');
const configStart = configSource.indexOf('TOWN_CONFIG = {') + 'TOWN_CONFIG = '.length;
const config = JSON.parse(configSource.slice(configStart, configSource.indexOf('\n};', configStart) + 2));
const parts = ['00-configuration', '02-data-and-datums', '03-time-series', '04-observation-archives',
  '06-inundation-catalog', '18-flood-frame-rendering', '19-observed-history', '21-forecast-and-observed-loading'];
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
};
const payload = rows => ({value: {timeSeries: [{variable: {noDataValue: -999999}, values: [{value:
  rows.map(([dateTime, value]) => ({dateTime, value: value === null ? null : String(value)}))
}]}]}});
let cases = 0;

function setup(now = '2026-11-02T17:00:00Z', date = '2026-11-02') {
  let nowMs = Date.parse(now);
  class TestDate extends Date {
    constructor(...args) {super(...(args.length ? args : [nowMs]));}
    static now() {return nowMs;}
  }
  const requests = [], responses = [], warnings = [];
  const c = vm.createContext({
    URL, Date: TestDate, Intl, Map, Set, Number, Math, Promise, archiveGeneration: 0,
    console: {warn(...args) {warnings.push(args);}},
    window: {location: {href: 'https://example.test/north-wildwood/'}}, config,
    clearExportAvailabilityCache() {}
  });
  for (const part of parts) vm.runInContext(fs.readFileSync(path.join(runtimeDir, `${part}.js`), 'utf8'), c, {filename: part});
  const run = source => vm.runInContext(source, c);
  // Replace the real fetch helper after loading its runtime definition.
  c.fetchJson = async (url, options) => {
    requests.push({url: String(url), options});
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return await (typeof next === 'function' ? next() : next);
  };
  run(`
    TOWN_CONFIG = config;
    MINOR_FLOOD_FT = config.thresholds.navd88.minor;
    MODERATE_FLOOD_FT = config.thresholds.navd88.moderate;
    MAJOR_FLOOD_FT = config.thresholds.navd88.major;
    DATUM_OFFSETS = config.datums.offsets;
  `);
  c.date = date;
  run(`
    const start = parseStoredLocalNyToDate(date + 'T00:00').getTime();
    const end = parseStoredLocalNyToDate(addDaysToDateKey(date, 1) + 'T00:00').getTime();
    const values = Array((end - start) / 900000).fill(null);
    values[0] = 117; values[1] = 116;
    const packed = {d: date, u: start / 1000, v: values, p: 117, c: 'none', q: 'MM'};
    observed15MinuteData = {stationId: config.observed.usgsGaugeId, intervalMinutes: 15,
      archiveEndDate: date, days: [packed]};
    observedData = buildObservedIndexFrom15MinuteArchive(observed15MinuteData);
    addArchiveShardDays(observed15MinuteData, 'stone-harbor');
  `);
  return {c, run, requests, responses, warnings, advance: ms => {nowMs += ms;},
    source: () => run('getObservedSourceHoursForDay(getObservedDayRecord(date))'),
    canonical: () => run('buildObservedCanonicalSeries(getObservedDayRecord(date), date)')};
}

// The audited November 2 archive had 96 slots, only 00:00 and 00:15 EST
// populated. Its date equalled today even at noon; it still needs a live fetch.
{
  const {c, run, requests, responses, source, canonical} = setup();
  const hold = deferred();
  responses.push(hold.promise);
  assert.equal(source().filter(entry => Number.isFinite(entry.navd88StageFt)).length, 2);
  const first = c.extendObservedArchiveThroughToday();
  const concurrent = c.extendObservedArchiveThroughToday();
  await tick();
  assert.equal(requests.length, 1, 'An incomplete published current day must fetch live USGS exactly once');
  hold.resolve(payload([
    ['2026-11-02T00:00:00-05:00', 0], ['2026-11-02T00:06:00-05:00', -999999],
    ['2026-11-02T00:12:00-05:00', 1.2], ['2026-11-02T00:18:00-05:00', 1.8],
    ['2026-11-02T00:24:00-05:00', 2.4], ['2026-11-02T00:30:00-05:00', 3],
    ['2026-11-02T01:30:00-05:00', 4], ['2026-11-02T02:00:00-05:00', null],
    ['2026-11-02T02:06:00-05:00', '']
  ]));
  await Promise.all([first, concurrent]);
  const slots = canonical();
  assert.equal(slots.length, 96);
  assert.equal(slots[0].navd88StageFt, 0, 'A fresh valid zero must replace the packed reading');
  assert.equal(slots[0].isMeasuredQuarterHourArchive, true);
  assert.equal(slots[1].navd88StageFt, 1.5, 'Fresh interpolated IV data must replace a stale packed quarter hour');
  assert.equal(slots[1].isMeasuredQuarterHourArchive, false);
  assert.equal(slots[1].isInterpolatedTimelineFrame, true);
  assert.equal(slots[1].observationQuality, 'I');
  assert.equal(slots[1].interpolationSpanSeconds, 360);
  assert.equal(slots[1].sourceResolutionMinutes, 6);
  assert.equal(slots[1].sourceStationId, '01411360');
  assert.equal(slots[2].navd88StageFt, 3);
  assert.equal(slots[2].isMeasuredQuarterHourArchive, true);
  assert.equal(slots[3].isMissingTimelineFrame, true, 'A one-hour gap must remain missing');
  assert.equal(slots[3].navd88StageFt, null);
  assert.equal(slots[6].navd88StageFt, 4);
  assert.equal(slots[8].navd88StageFt, null, 'No-data sentinels and empty values cannot become observations');
  assert.equal(source()[1].navd88StageFt, 1.5, 'The source accessor itself must reconcile the packed cache');
  assert.equal(run('getObservedDayRecord(date).peakNAVD88'), 4);
  run('currentDatum = "mllw"');
  assert.equal(c.convertStageForDisplay(slots[1].navd88StageFt), 1.5 + config.datums.offsets.mllw);
  assert.equal(source()[1].navd88StageFt, 1.5, 'Datum display changes cannot alter source NAVD88 values');
  const url = new URL(requests[0].url);
  assert.equal(url.searchParams.get('sites'), '01411360');
  assert.equal(url.searchParams.get('parameterCd'), config.observed.usgsParameterCd);
  assert.equal(url.searchParams.get('startDT'), '2026-11-02T05:00:00Z');
  assert.equal(url.searchParams.get('endDT'), '2026-11-02T17:00:00Z');
  assert.equal(requests[0].options.timeoutMs, 15000);
  await c.extendObservedArchiveThroughToday();
  assert.equal(requests.length, 1, 'The success cooldown must prevent repeated UI loads from making a request storm');
  cases++;
}

// Reopening today's cached history must actually reach the refresh cooldown;
// selecting an older date must not request current USGS readings.
{
  const {c, requests, responses, advance, source} = setup();
  c.ensureObservedArchiveYear = async () => true;
  responses.push(new Error('Temporary USGS outage'));
  await c.ensureObservedArchiveForDate('2026-11-02');
  await c.ensureObservedArchiveForDate('2026-11-02');
  assert.equal(requests.length, 1);
  advance(60001);
  responses.push(payload([['2026-11-02T00:00:00-05:00', 5]]));
  await c.ensureObservedArchiveForDate('2026-11-02');
  assert.equal(requests.length, 2, 'Cached background history must not permanently suppress a live retry');
  assert.equal(source()[0].navd88StageFt, 5);
  advance(15 * 60000);
  await c.ensureObservedArchiveForDate('2026-11-01');
  assert.equal(requests.length, 2, 'Historical date navigation must not fetch live readings');
  cases++;
}

// Fresh primary data still passes through the established crest override, and
// must never replace a surrogate day with another gauge's cadence or datum.
{
  const {c, run, responses, source} = setup();
  run(`observedData.days[0].officialCrestEntry = {navd88StageFt: 8, sourceSite: '01411360',
    sourceStationShort: 'Stone Harbor', crestTimeKnown: true, timeUtc: date + 'T05:15:00Z'};`);
  responses.push(payload([['2026-11-02T00:00:00-05:00', 1], ['2026-11-02T00:30:00-05:00', 2]]));
  await c.extendObservedArchiveThroughToday();
  assert.equal(source()[1].navd88StageFt, 8);
  assert.equal(source()[1].observationQuality, 'C');
  assert.equal(source()[1].isOfficialCrestFrame, true);
  run(`const record = observedData.days[0]; record.isLewesSurrogate = true;
    record.officialCrestEntry = null;
    record.lewesCompactDay = {u: Date.parse(date + 'T05:00:00Z') / 1000, v: [100, 200]};
    observedDaysCache = null;`);
  assert.equal(source()[0].sourceStationId, config.observed.surrogate.stationId);
  assert.equal(source()[0].isLewesSurrogate, true);
  assert.equal(source()[0].isLiveObservedBackfill, undefined);
  assert.equal(source()[0].sourceResolutionMinutes, 60);
  assert.equal(source()[0].navd88StageFt, run('decodeSurrogateHundredths(100)'));
  cases++;
}

// Corrections with the same sample count must win. Short responses and failed
// refreshes retain prior good readings; failures retry after a shorter cooldown.
{
  const {c, run, requests, responses, advance, source} = setup();
  responses.push(payload([['2026-11-02T00:00:00-05:00', 1], ['2026-11-02T00:30:00-05:00', 3]]));
  await c.extendObservedArchiveThroughToday();
  advance(15 * 60000);
  responses.push(payload([['2026-11-02T00:30:00-05:00', -1]]));
  await c.extendObservedArchiveThroughToday();
  assert.equal(source().find(entry => entry.timeUtc === '2026-11-02T05:30:00.000Z').navd88StageFt, -1);
  assert.equal(source()[0].navd88StageFt, 1, 'A shorter valid response must retain earlier measured samples');
  const hours = run('getObservedDayRecord(date).timelineRawHours');
  advance(15 * 60000);
  responses.push(new Error('USGS offline'));
  await c.extendObservedArchiveThroughToday();
  assert.deepEqual(run('getObservedDayRecord(date).timelineRawHours'), hours);
  await c.extendObservedArchiveThroughToday();
  assert.equal(requests.length, 3, 'Failure cooldown must bound retries');
  advance(60001);
  responses.push(payload([['2026-11-02T00:30:00-05:00', 2]]));
  await c.extendObservedArchiveThroughToday();
  assert.equal(requests.length, 4);
  assert.equal(source().find(entry => entry.timeUtc === '2026-11-02T05:30:00.000Z').navd88StageFt, 2);
  cases++;
}

// A failed catchup creates calendar placeholders, then retries its original
// missing range rather than treating those placeholders as a complete archive.
{
  const {c, run, requests, responses, advance} = setup('2026-11-02T17:00:00Z', '2026-10-31');
  responses.push(new Error('Offline catchup'));
  await c.extendObservedArchiveThroughToday();
  assert.equal(run('observedData.archiveEndDate'), '2026-11-02');
  assert.equal(run('getObservedDayRecord("2026-11-01").generatedPlaceholderDay'), true);
  advance(60001);
  responses.push(payload([['2026-11-01T12:00:00-05:00', 2]]));
  await c.extendObservedArchiveThroughToday();
  assert.equal(new URL(requests[0].url).searchParams.get('startDT'), '2026-10-31T04:00:00Z');
  assert.equal(new URL(requests[1].url).searchParams.get('startDT'), '2026-10-31T04:00:00Z');
  assert.equal(run('getObservedDayRecord("2026-11-01").hours[0].navd88StageFt'), 2);
  assert.equal(run('getObservedDayRecord("2026-11-01").generatedPlaceholderDay'), false);
  cases++;
}

// The previous published day can end before noon. Preserve its indexed
// peak if only the index has loaded and the IV response contains its tail.
{
  const {c, run, requests, responses, advance, canonical} = setup('2026-11-06T14:35:00Z', '2026-11-05');
  run('observed15MinuteDaysByDate.delete(date); observedData.days[0].peakNAVD88 = 5;');
  responses.push(payload([
    ['2026-11-05T23:42:00-05:00', -1.82], ['2026-11-05T23:48:00-05:00', -1.83]
  ]));
  await c.extendObservedArchiveThroughToday();
  assert.equal(new URL(requests[0].url).searchParams.get('startDT'), '2026-11-05T05:00:00Z');
  assert.equal(canonical().at(-1).navd88StageFt, -1.825);
  assert.equal(canonical().at(-1).observationQuality, 'I');
  assert.equal(run('getObservedDayRecord(date).peakNAVD88'), 5);
  c.ensureObservedArchiveYear = async () => true;
  advance(15 * 60000);
  responses.push(payload([['2026-11-05T23:48:00-05:00', -1.81]]));
  await c.ensureObservedArchiveForDate('2026-11-05');
  assert.equal(new URL(requests[1].url).searchParams.get('startDT'), '2026-11-05T05:00:00Z');
  assert.equal(canonical().at(-1).navd88StageFt, -1.815);
  assert.equal(run('getObservedDayRecord(date).peakNAVD88'), 5);
  cases++;
}

// Older requests complete after Reload in reverse order, including a late
// network failure. Neither may change fresh data or the new pending request.
for (const outcome of ['success', 'failure']) {
  const {c, run, requests, responses, source} = setup();
  const old = deferred(), latest = deferred();
  responses.push(old.promise, latest.promise);
  const oldRequest = c.extendObservedArchiveThroughToday();
  run(`archiveGeneration++; observedData = buildObservedIndexFrom15MinuteArchive(observed15MinuteData); observedDaysCache = null;`);
  const latestRequest = c.extendObservedArchiveThroughToday();
  const latestState = run('observedData.liveObservedRefresh');
  latest.resolve(payload([['2026-11-02T00:00:00-05:00', 7]]));
  await latestRequest;
  const freshData = run('observedData'), freshCache = run('getObservedDays()');
  if (outcome === 'success') old.resolve(payload([['2026-11-02T00:00:00-05:00', 99]]));
  else old.reject(new Error('Obsolete USGS response failed'));
  assert.equal(await oldRequest, false);
  assert.equal(run('observedData'), freshData);
  assert.equal(run('observedDaysCache'), freshCache);
  assert.equal(run('observedData.liveObservedRefresh'), latestState);
  assert.equal(source()[0].navd88StageFt, 7);
  assert.equal(requests.length, 2);
  cases++;
}

// Replacing an archive in the same generation is also a cancellation boundary.
{
  const {c, run, responses} = setup();
  const old = deferred(); responses.push(old.promise);
  const request = c.extendObservedArchiveThroughToday();
  run('observedData = {archiveEndDate: date, days: [{date, hours: [], marker: "replacement"}]}; observedDaysCache = null;');
  const replacement = run('observedData');
  old.resolve(payload([['2026-11-02T00:00:00-05:00', 99]]));
  assert.equal(await request, false);
  assert.equal(run('observedData'), replacement);
  assert.equal(run('observedData.days[0].marker'), 'replacement');
  cases++;
}

// A new NY date expires yesterday's cooldown. DST keeps both repeated 01:00
// readings distinct by UTC, and never creates nonexistent spring 02:00 slots.
{
  const {c, run, requests, responses, advance} = setup('2026-11-02T23:30:00-05:00');
  responses.push(payload([])); await c.extendObservedArchiveThroughToday();
  run('observedData.liveObservedRefresh.nextRefreshAt = Infinity');
  advance(60 * 60000); responses.push(payload([])); await c.extendObservedArchiveThroughToday();
  assert.equal(requests.length, 2);
  assert.equal(new URL(requests[1].url).searchParams.get('startDT'), '2026-11-02T05:00:00Z');
  cases++;
}
for (const fixture of [
  {date: '2026-11-01', now: '2026-11-01T18:00:00Z', slots: 100,
    rows: [['2026-11-01T01:00:00-04:00', 1], ['2026-11-01T01:00:00-05:00', 2]]},
  {date: '2026-03-08', now: '2026-03-08T18:00:00Z', slots: 92,
    rows: [['2026-03-08T01:54:00-05:00', 1], ['2026-03-08T03:00:00-04:00', 2]]}
]) {
  const {c, responses, canonical} = setup(fixture.now, fixture.date);
  responses.push(payload(fixture.rows)); await c.extendObservedArchiveThroughToday();
  const slots = canonical(); assert.equal(slots.length, fixture.slots);
  for (const [iso, stage] of fixture.rows.filter(([iso]) => iso.includes(':00:00'))) {
    const entry = slots.find(slot => slot.timeUtc === new Date(iso).toISOString());
    assert.equal(entry.navd88StageFt, stage);
    assert.equal(entry.isMeasuredQuarterHourArchive, true);
  }
  if (fixture.slots === 92) assert.equal(slots.some(entry => entry.displayTimeEST.slice(11, 13) === '02'), false);
  cases++;
}

console.log(`${cases} audit observation-refresh, cache precedence, quality, and cancellation cases passed.`);
