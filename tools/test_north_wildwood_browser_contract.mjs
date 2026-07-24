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

for (const [date, targetHundredths, eventName, peakHour] of [
  ["2012-10-29", 673, "Hurricane Sandy", "20:45"],
  ["2016-01-23", 669, "Winter Storm Jonas", "09:00"]
]) {
  const day = OBSERVED_15MIN.days.find(item => item.d === date);
  assert.ok(day, `Missing ${eventName} quarter-hour archive`);
  assert.equal(day.v.length, 96, `${eventName} must contain 96 quarter-hour frames`);
  assert.equal(day.v.filter(Number.isFinite).length, 96, `${eventName} must not contain missing quarter-hour frames`);
  assert.equal(Math.max(...day.v), targetHundredths, `${eventName} peak calibration is wrong`);
  const event = TOP_TIDES.toptides.find(item => item.date === date);
  assert.equal(event?.event_name, eventName);
  assert.equal(event?.time_est, peakHour);
}

console.log("North Wildwood browser depth and export contract checks passed");
