import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const read = name => fs.readFileSync(new URL(name, root), "utf8");
const json = name => JSON.parse(read(name));
const configSource = read("tools/app/town-config.js");
const configStart = configSource.indexOf("TOWN_CONFIG = {") + "TOWN_CONFIG = ".length;
const config = JSON.parse(configSource.slice(configStart, configSource.indexOf("\n};", configStart) + 2));
const index = json("observed_archive_index.json");
const canonical = json("canonical_daily_v2.json");
const top = json("toptides.json");
const shard = json("observed_archive/stone-harbor/2026.json");
const slider = { value: "0" };
const context = vm.createContext({
  URL, Date, Intl, Map, Set, Number, Math, Promise, console,
  window: { location: { href: "https://cupajoe.live/shorelysafe/floodmapper/north-wildwood/" } },
  document: { body: { dataset: {} }, getElementById: () => slider },
  config, index, canonical, top, shard,
  clearExportAvailabilityCache() {}
});
for (const part of ["00-configuration", "01-physics-manifests", "02-data-and-datums", "03-time-series", "04-observation-archives",
  "06-inundation-catalog", "18-flood-frame-rendering", "19-observed-history", "20-timeline-rendering", "21-forecast-and-observed-loading",
  "22-calendar-and-modes", "23-refresh-and-playback"]) {
  vm.runInContext(read(`tools/app/runtime/${part}.js`), context, { filename: part });
}
const run = source => vm.runInContext(source, context);
const ensureObservedArchiveForDate = context.ensureObservedArchiveForDate;
run(`
  TOWN_CONFIG = config;
  MINOR_FLOOD_FT = config.thresholds.navd88.minor;
  MODERATE_FLOOD_FT = config.thresholds.navd88.moderate;
  MAJOR_FLOOD_FT = config.thresholds.navd88.major;
  DATUM_OFFSETS = config.datums.offsets;
  observed15MinuteData = index;
  historicTopTideEntries = top.toptides.map(normalizeTopTidesJsonEntry).filter(Boolean);
`);

const ranking = () => JSON.parse(run("JSON.stringify(buildTopTideEvents().map(event => [event.dateKey, event.peakStage]))"));
const freshRanking = ranking();
assert.equal(freshRanking.length, 10);
assert.deepEqual(freshRanking[8], ["2026-09-26", 5.77], "The indexed September crest must be ninth before Past is opened");
assert.equal(run("observedData"), null, "Ranking must not require constructing the full history");
assert.equal(run("observed15MinuteDaysByDate.size"), 0, "Ranking must not download a replay year");
run("currentTimelineIntervalMinutes = 1440");
assert.deepEqual(ranking(), freshRanking, "Daily Max must preserve the unloaded index ranking");
run("currentTimelineIntervalMinutes = 60");

// Exercise the actual click loader from an index-only Top 10. All historical
// data is local; count detailed archive requests separately from index loading.
const replayRequests = [];
const renderedStages = [];
context.replayRequests = replayRequests;
context.renderedStages = renderedStages;
run(`
  stopPlayback = () => {};
  cancelPendingFloodFrame = () => ++lastRenderToken;
  updateDataModeButtons = () => {};
  getOverlayRecord = async () => null;
  syncSliderBounds = () => {};
  renderCalendar = async () => {};
  renderTopTides = () => {};
  scheduleHistoricalTopTideWarmup = () => {};
  renderHour = async index => { renderedStages.push(getStageValue(currentSeriesHours[index])); };
  warmBackgroundData = async () => {
    observedData = buildObservedIndexFromCanonical(canonical);
    mergeObservedArchiveIndex(index, "stone-harbor");
    mergeHistoricalCrestsIntoObservedIndex();
    topTideEvents = buildTopTideEvents();
  };
  ensureObservedArchiveForDate = async date => {
    replayRequests.push(date);
    addArchiveShardDays(shard, "stone-harbor");
  };
  topTideEvents = buildTopTideEvents();
`);
await run("loadTopTideEvent(8)");
assert.deepEqual(replayRequests, ["2026-09-26"], "Selecting the indexed crest must load its replay on demand");
assert(run("currentRawSeriesHours.length") > 1, "The selected crest must become a detailed replay");
assert.equal(run("selectedObservedDate"), "2026-09-26");
assert.equal(run("currentTopTideIndex"), 8);
assert(renderedStages.length > 0);
assert.deepEqual(ranking(), freshRanking, "Loading the selected replay must not alter Top 10 dates or heights");
for (const interval of [15, 60, 1440]) {
  run(`currentTimelineIntervalMinutes = ${interval}`);
  assert.deepEqual(ranking(), freshRanking, `Rankings must remain stable at interval ${interval}`);
}

// A detailed archive failure retains the indexed peak without claiming that
// the date-only value is an official, timed storm-tide crest.
run(`
  currentTimelineIntervalMinutes = 60;
  observed15MinuteDaysByDate = new Map();
  observedDaysCache = null;
  topTideEvents = buildTopTideEvents();
`);
const failedArchiveRequests = [];
context.ensureObservedArchiveForDate = ensureObservedArchiveForDate;
context.fetchJson = async url => {
  failedArchiveRequests.push(url);
  throw new Error("Archive is offline");
};
context.console = { ...console, warn() {} };
await run("loadTopTideEvent(8)");
assert.equal(failedArchiveRequests.length, 2, "Both the year shard and compact fallback must fail in this regression");
assert.equal(run("currentSeriesHours.length"), 1);
assert.equal(run("currentSeriesHours[0].isDailyPeakOnly"), true);
assert.deepEqual(ranking(), freshRanking, "Unavailable replay must retain indexed ranking");
const timelineElements = new Map();
context.document.getElementById = id => {
  if (!timelineElements.has(id)) timelineElements.set(id, { classList: { toggle() {}, remove() {} } });
  return timelineElements.get(id);
};
run(`
  updateTimelineAccessibility = () => {};
  renderTimelineDays = () => {};
  updateDownloadSummary = () => {};
`);
context.requestAnimationFrame = () => {};
run("renderTimelineMeta(currentSeriesHours[0])");
assert.match(timelineElements.get("timelineMeta").textContent, /Only the daily peak water level/);
assert.doesNotMatch(timelineElements.get("timelineMeta").textContent, /storm-tide crest/);

// A successful gauge response can contain numeric no-data sentinels. They are
// missing readings, while a real zero and a below-zero tide remain valid.
context.usgsPayload = { value: { timeSeries: [
  { variable: { noDataValue: -999999 }, values: [{ value: [
    { value: "-999999", dateTime: "2026-10-26T10:00:00-04:00" },
    { value: "0", dateTime: "2026-10-26T11:00:00-04:00" },
    { value: "-1.25", dateTime: "2026-10-26T12:00:00-04:00" },
    { value: null, dateTime: "2026-10-26T13:00:00-04:00" },
    { value: "", dateTime: "2026-10-26T14:00:00-04:00" },
    { value: " ", dateTime: "2026-10-26T15:00:00-04:00" }
  ] }] },
  { variable: { noDataValue: "-12345" }, values: [{ value: [
    { value: "-12345", dateTime: "2026-10-26T16:00:00-04:00" },
    { value: "1.5", dateTime: "2026-10-26T17:00:00-04:00" }
  ] }] },
  { variable: {}, values: [{ value: [
    { value: "0", dateTime: "2026-10-27T01:00:00-04:00" }
  ] }] }
] } };
const liveDays = JSON.parse(run("JSON.stringify(normalizeUsgsIvObservedDays(usgsPayload))"));
assert.deepEqual(liveDays[0].hours.map(hour => hour.navd88StageFt), [0, -1.25, 1.5]);
assert.equal(liveDays[0].peakNAVD88, 1.5);
assert.equal(liveDays[1].hours[0].navd88StageFt, 0, "An absent noDataValue must not reject valid zero");
const missingSlots = run("buildQuarterHourTimelineSeries(normalizeUsgsIvObservedDays(usgsPayload)[0].hours, { kind: 'observed', startMs: Date.parse('2026-10-26T14:00Z'), endMs: Date.parse('2026-10-26T17:00Z'), maxGapMinutes: 30 })");
assert.equal(missingSlots[0].isMissingTimelineFrame, true, "The sentinel hour must remain a missing frame");
assert.equal(missingSlots[0].navd88StageFt, null);
assert.equal(missingSlots[4].navd88StageFt, 0, "The valid zero hour must remain a measured frame");

// The post-paint list warmup may load the small day index, never a year shard.
const refreshSource = read("tools/app/runtime/23-refresh-and-playback.js");
const warmupSource = refreshSource.slice(refreshSource.indexOf("    function scheduleTopTidesListWarmup()"),
  refreshSource.indexOf("    function scheduleBackgroundDataWarmup()"));
const calls = [];
let releaseIndex;
const heldIndex = new Promise(resolve => { releaseIndex = resolve; });
const warmup = vm.createContext({
  console, Promise, topTideEvents: [],
  loadHistoricalTopTides: async () => { calls.push("crests"); },
  ensureObserved15MinuteArchive: async () => { calls.push("index"); await heldIndex; },
  ensureObservedArchiveYear: async () => { throw new Error("Replay must stay on demand"); },
  buildTopTideEvents: () => { calls.push("rank"); return freshRanking; },
  renderTopTides: () => calls.push("render")
});
vm.runInContext(warmupSource, warmup);
warmup.scheduleTopTidesListWarmup();
assert.deepEqual(calls, ["crests", "index"]);
releaseIndex();
await new Promise(resolve => setImmediate(resolve));
assert.deepEqual(calls, ["crests", "index", "rank", "render"]);
calls.length = 0;
warmup.ensureObserved15MinuteArchive = async () => { throw new Error("Offline index"); };
warmup.scheduleTopTidesListWarmup();
await new Promise(resolve => setImmediate(resolve));
assert.deepEqual(calls, ["crests", "rank", "render"], "The existing crest list must survive index failure");

console.log("North Wildwood stable Top 10, on-demand replay, and USGS missing-value regressions passed");
