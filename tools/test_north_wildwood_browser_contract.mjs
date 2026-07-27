#!/usr/bin/env node
// Static and executable checks for the browser's 0.05-ft depth contract.

import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import path from "node:path";


const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = fs.readFileSync(path.join(HERE, "..", "index.html"), "utf8");
const OBSERVED_15MIN = JSON.parse(fs.readFileSync(path.join(HERE, "..", "observed15min.json"), "utf8"));
const TOP_TIDES = JSON.parse(fs.readFileSync(path.join(HERE, "..", "toptides.json"), "utf8"));

function extractFunction(name) {
  const start = SOURCE.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `Missing browser function ${name}`);
  const bodyStart = SOURCE.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < SOURCE.length; index += 1) {
    if (SOURCE[index] === "{") depth += 1;
    if (SOURCE[index] === "}") depth -= 1;
    if (depth === 0) return SOURCE.slice(start, index + 1);
  }
  throw new Error(`Unterminated browser function ${name}`);
}

const context = vm.createContext({
  Math,
  Number,
  MIN_STAGE: -4,
  MIN_DEPTH_STAGE: 0,
  MAX_STAGE: 14,
  STAGE_STEP: 0.05,
  MINOR_FLOOD_FT: 3.25,
  MODERATE_FLOOD_FT: 4.25,
  MAJOR_FLOOD_FT: 5.25,
  LOW_STAGE_VERTICAL_PENALTY_FT: 1.25,
  VERTICAL_PENALTY_EXPONENTIAL_DECAY_RATE: 1.5,
});
for (const name of (
  [
    "roundToCatalogPrecision",
    "floorToCatalogStep",
    "getOverlayStage",
    "getVerticalBathtubPenalty",
    "stageToCode",
  ]
)) {
  vm.runInContext(`${extractFunction(name)}; globalThis.${name} = ${name};`, context);
}

assert.equal(context.getOverlayStage(3.94), 3.9);
assert.equal(context.getOverlayStage(3.95), 3.95);
assert.equal(context.getOverlayStage(3.999), 3.95);
assert.equal(context.stageToCode(context.getOverlayStage(3.94)), "p0390");
assert.equal(context.stageToCode(context.getOverlayStage(3.95)), "p0395");
assert.equal(context.getVerticalBathtubPenalty(3.25), 1.25);
assert.equal(context.getVerticalBathtubPenalty(5.25), 0);

let previous = Infinity;
for (let stage = 3.25; stage <= 5.25 + 1e-9; stage += 0.05) {
  const penalty = context.getVerticalBathtubPenalty(stage);
  assert.ok(penalty <= previous + 1e-12, "Penalty must decrease monotonically");
  previous = penalty;
}

assert.match(SOURCE, /candidateElevation > -100 && candidateElevation < 100/);
assert.match(SOURCE, /elevation >= 1000/);
assert.doesNotMatch(SOURCE, /<dt>Ground<\/dt>/);
assert.doesNotMatch(SOURCE, /<dt>Maximum depth penalty<\/dt>/);
assert.match(SOURCE, /<div class="depth-query-value">/);
assert.match(SOURCE, /id="satelliteToggle"/);
assert.match(SOURCE, /World_Imagery\/MapServer\/tile/);
assert.match(SOURCE, /payload\.valueType === "int16-le"/);
assert.match(SOURCE, /depthQueryPngPath/);
assert.match(SOURCE, /function loadDepthQueryPng\(/);
assert.match(SOURCE, /async function samplePackedDepthGrid\(/);
assert.match(SOURCE, /encodedElevation - 32768/);
assert.match(SOURCE, /connectionCode - 100/);
assert.match(SOURCE, /depthQueryGridPromise = null/);
assert.match(
  SOURCE,
  /depthQueryImagePromise = GeoTIFF\.fromUrl[\s\S]+depthQueryImagePromise = null/
);
assert.match(
  SOURCE,
  /Packed depth query failed; retrying through the COG/
);
assert.match(SOURCE, /id="downloadIntervalControl"/);
assert.match(SOURCE, /data-export-interval="hourly"/);
assert.match(SOURCE, /data-export-interval="15min"/);
assert.match(SOURCE, /data-export-interval="daily"/);
assert.match(SOURCE, /function buildExportRangeFrameItems\(/);
assert.match(SOURCE, /function buildQuarterHourRangeFrameItems\(/);
assert.match(SOURCE, /function buildDailyMaximumRangeFrameItems\(/);
assert.match(SOURCE, /getExportBaseName\(items\)/);
assert.match(SOURCE, /function getCurrentSelectionExportRange\(/);
assert.match(SOURCE, /const currentDate = getEntryESTDate\(getDownloadCurrentEntry\(\)\)/);
assert.match(SOURCE, /seedDownloadRangeToCurrentSelection\(force\)/);
assert.doesNotMatch(SOURCE, /seedDownloadRangeToCurrentForecast/);
assert.doesNotMatch(SOURCE, /\bstageColor\b/);
assert.match(SOURCE, /function getExportFrameDateTimeText\(/);
assert.match(SOURCE, /return `\$\{getExportFrameDateTimeText\(entry\)\}\\n\$\{getExportFrameWaterLevelText\(entry\)\}`/);
assert.doesNotMatch(extractFunction("getExportFrameTimestampText"), /15-Minute|Hourly|Daily maximum|Water level/);
assert.match(SOURCE, /data-export-legend-mode="depth"/);
assert.match(SOURCE, /class="export-depth-key-gradient"/);
assert.match(SOURCE, /<strong>Flood Depth<\/strong>/);
assert.match(SOURCE, /linear-gradient\(90deg,#18c8ff 0%,#00a6f2 20%,#1479df 40%,#1852bd 60%,#132f7d 80%,#041536 100%\)/);
assert.doesNotMatch(SOURCE, /Feet above ground/);
assert.doesNotMatch(SOURCE, /class="export-depth-key-disconnected"/);
assert.match(SOURCE, /function captureExportRoadLabelsCanvas\(/);
assert.match(SOURCE, /function normalizeExportRoadLabelCanvas\(/);
assert.match(SOURCE, /const isHalo = luminance >= 190/);
assert.match(SOURCE, /ctx\.drawImage\(roadLabelsCanvas[\s\S]+ctx\.drawImage\(chromeCanvas[\s\S]+drawExportTimestampOnCanvas/);
assert.match(SOURCE, /getPane\("roadsPane"\)\.style\.zIndex = 710/);
assert.match(SOURCE, /filter:grayscale\(1\) brightness\(\.06\) contrast\(4\.2\) drop-shadow/);
assert.match(SOURCE, /id="buildingsToggle"/);
assert.match(SOURCE, /function styleEsriBuildingForeground\(/);
assert.match(SOURCE, /makeEsriBuildingForegroundLayer\("buildingsPane"\)/);
assert.doesNotMatch(SOURCE, /Buildings are above the water/);
assert.doesNotMatch(SOURCE, /recorded high-tide floods?/);
assert.match(SOURCE, /<span>floods<\/span>/);
assert.match(SOURCE, /getPane\("buildingsPane"\)\.style\.zIndex = 620/);
assert.match(SOURCE, /getPane\("popupPane"\)\.style\.zIndex = 800/);
assert.match(SOURCE, /autoClose: false/);
assert.match(SOURCE, /closeOnClick: false/);
assert.doesNotMatch(extractFunction("renderHour"), /closePopup/);
assert.match(SOURCE, /See Flood History And Projections/);
assert.match(SOURCE, /id="floodHistoryPane"/);
assert.match(SOURCE, /\.flood-history-backdrop\{[^}]*place-items:center/);
assert.match(SOURCE, /id="floodProjectionScenarioSelect"/);
assert.doesNotMatch(SOURCE, /<summary>Method<\/summary>/);
assert.doesNotMatch(SOURCE, /flood-history-method/);
assert.doesNotMatch(SOURCE, /parcel elevation/);
assert.doesNotMatch(SOURCE, /class="house-sub"/);
assert.doesNotMatch(SOURCE, /house-alert-depth-cta/);
assert.doesNotMatch(SOURCE, /class="flood-milestones"/);
assert.doesNotMatch(SOURCE, /class="flood-scenario-chips"/);
assert.doesNotMatch(SOURCE, /independent high-tide exceedances/);
assert.match(SOURCE, /north-wildwood-flood-history-projections-v4/);
assert.match(SOURCE, /id="mapClickModeControl"/);
assert.match(SOURCE, /data-map-click-mode="building"/);
assert.match(SOURCE, /data-map-click-mode="depth"/);
assert.match(SOURCE, /id="mapClickBuildingBtn"[^>]+aria-label="Building info"/);
assert.match(SOURCE, /id="mapClickDepthBtn"[^>]+aria-label="Water depth"/);
assert.match(SOURCE, /mapClickMode === "building" && parcelInfoInteractionEnabled\(\)/);
assert.doesNotMatch(SOURCE, /Switch map taps to water depth/);
assert.doesNotMatch(SOURCE, /recorded high-tide floods/);
assert.match(SOURCE, /\.house-alert-cta\{[^}]*background:rgba\(125,249,255,\.09\)/);
assert.match(SOURCE, /id="north-wildwood-mobile-qa-20260726"/);
assert.match(SOURCE, /setImportant\(toggle, "top", "calc\(64px \+ env\(safe-area-inset-top, 0px\)\)"\)/);
assert.match(SOURCE, /setImportant\(key, "right", "48px"\)/);
assert.match(SOURCE, /maxWidth: viewportPopupWidth/);
assert.match(SOURCE, /window\.innerWidth - 28/);
assert.match(SOURCE, /autoPanPaddingTopLeft: mobilePopup \? L\.point\(10, 126\)/);
assert.match(SOURCE, /document\.body\.classList\.add\("persistent-flood-popup-open"\)/);
assert.match(SOURCE, /document\.body\.classList\.remove\("persistent-flood-popup-open"\)/);
assert.match(SOURCE, /\.flood-history-close\{[\s\S]+width:44px !important/);
assert.match(SOURCE, /\.flood-year-control input\[type="range"\]\{[\s\S]+min-height:30px !important/);
assert.match(SOURCE, /grid-template-columns:120px minmax\(0, 1fr\) !important/);
assert.match(SOURCE, /persistent-flood-popup-open #timelineBubble/);
assert.match(SOURCE, /\{ allowNearest: false \}/);
assert.match(SOURCE, /No parcel contains that building tap/);
assert.match(SOURCE, /requestIdleCallback/);
assert.match(SOURCE, /loadForecast\(null, \{ selectCurrent: true, forceRefresh: true \}\)/);

const selectedRangeContext = vm.createContext({
  Date,
  Math,
  Number,
  EXPORT_RANGE_MAX_MS: 84 * 60 * 60 * 1000,
  currentSeriesHours: [],
  currentEntry: null,
  fallbackRange: null,
});
selectedRangeContext.getDownloadCurrentEntry = () => selectedRangeContext.currentEntry;
selectedRangeContext.getEntryESTDate = entry => entry?.date || null;
selectedRangeContext.getCurrentForecastExportRange = () => selectedRangeContext.fallbackRange;
vm.runInContext(
  `${extractFunction("getCurrentSelectionExportRange")}; globalThis.getCurrentSelectionExportRange = getCurrentSelectionExportRange;`,
  selectedRangeContext
);

const sandyPeak = new Date("2012-10-30T00:45:00.000Z");
selectedRangeContext.currentEntry = { date: sandyPeak };
selectedRangeContext.currentSeriesHours = [
  { date: new Date("2012-10-29T04:00:00.000Z") },
  { date: sandyPeak },
  { date: new Date("2012-10-30T03:45:00.000Z") },
];
let selectedRange = selectedRangeContext.getCurrentSelectionExportRange();
assert.equal(selectedRange.firstDate.getTime(), sandyPeak.getTime(), "Export must start at the selected Sandy frame");
assert.equal(
  selectedRange.lastDate.getTime(),
  new Date("2012-10-30T03:45:00.000Z").getTime(),
  "Export must retain the remaining frames in the selected series"
);

const laterForecastFrame = new Date("2026-07-27T18:00:00.000Z");
selectedRangeContext.currentEntry = { date: laterForecastFrame };
selectedRangeContext.currentSeriesHours = [
  { date: new Date("2026-07-27T12:00:00.000Z") },
  { date: laterForecastFrame },
  { date: new Date("2026-07-28T00:00:00.000Z") },
  { date: new Date("2026-08-01T18:00:00.000Z") },
];
selectedRange = selectedRangeContext.getCurrentSelectionExportRange();
assert.equal(
  selectedRange.firstDate.getTime(),
  laterForecastFrame.getTime(),
  "Export must start at the selected forecast frame, not the first forecast frame"
);
assert.equal(
  selectedRange.lastDate.getTime(),
  new Date("2026-07-28T00:00:00.000Z").getTime(),
  "Export end must remain within the 84-hour limit"
);

for (const [date, targetHundredths, eventName, peakHour] of [
  ["2012-10-29", 673, "Hurricane Sandy", "20:45"],
  ["2016-01-23", 669, "Winter Storm Jonas", "09:00"]
]) {
  const day = OBSERVED_15MIN.days.find(item => item.d === date);
  assert.ok(day, `Missing ${eventName} quarter-hour archive`);
  assert.equal(day.v.length, 96, `${eventName} must contain 96 quarter-hour frames`);
  assert.equal(day.v.filter(Number.isFinite).length, 96, `${eventName} must not contain missing quarter-hour frames`);
  assert.equal(Math.max(...day.v), targetHundredths, `${eventName} peak calibration is wrong`);
  const peakIndex = day.v.indexOf(targetHundredths);
  const archivePeakTime = `${String(Math.floor(peakIndex / 4)).padStart(2, "0")}:${String((peakIndex % 4) * 15).padStart(2, "0")}`;
  assert.equal(archivePeakTime, peakHour);
  const event = TOP_TIDES.toptides.find(item => item.date === date);
  assert.ok(event, `Missing ${eventName} top-tide crest`);
  assert.equal(Math.round(Number(event.height_ft) * 100), targetHundredths);
}

console.log("North Wildwood browser depth and export contract checks passed");
