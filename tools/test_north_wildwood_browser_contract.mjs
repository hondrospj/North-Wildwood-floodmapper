#!/usr/bin/env node
// Static and executable checks for the browser's 0.1-ft connected-depth contract.

import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import path from "node:path";


const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = fs.readFileSync(path.join(HERE, "..", "index.html"), "utf8");
const OBSERVED_15MIN = JSON.parse(fs.readFileSync(path.join(HERE, "..", "observed15min.json"), "utf8"));
const OBSERVED_INDEX = JSON.parse(fs.readFileSync(path.join(HERE, "..", "observed_archive_index.json"), "utf8"));
const LEWES_INDEX = JSON.parse(fs.readFileSync(path.join(HERE, "..", "lewes_archive_index.json"), "utf8"));
const TOP_TIDES = JSON.parse(fs.readFileSync(path.join(HERE, "..", "toptides.json"), "utf8"));
const BUNDLED_HYDRAULIC_ROOT = path.join(HERE, "..", "assets", "hydraulic-v29");
const HYDRAULIC_ASSET_MANIFEST = JSON.parse(fs.readFileSync(
  path.join(BUNDLED_HYDRAULIC_ROOT, "NorthWildwoodHydraulicAssetManifest.json"),
  "utf8"
));

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
  MAX_STAGE: 20,
  STAGE_STEP: 0.1,
  MINOR_FLOOD_FT: 3.25,
  MODERATE_FLOOD_FT: 4.25,
  MAJOR_FLOOD_FT: 5.25,
  MINOR_VERTICAL_PENALTY_FT: 0.75,
  MODERATE_VERTICAL_PENALTY_FT: 0.25,
  MAJOR_VERTICAL_PENALTY_FT: 0,
});
for (const name of (
  [
    "roundToCatalogPrecision",
    "floorToCatalogStep",
    "getOverlayStage",
    "normalizeHydraulicPhase",
    "getHydraulicStatePhase",
    "getVerticalBathtubPenalty",
    "getPenaltyRemainingFraction",
    "getPenalizedConnectedDepth",
    "getDepthQueryDisplayDepth",
    "formatDepthQueryValue",
    "stageToCode",
  ]
)) {
  vm.runInContext(`${extractFunction(name)}; globalThis.${name} = ${name};`, context);
}

vm.runInContext(
  `${extractFunction("stripExportTimeZoneLabel")}; globalThis.stripExportTimeZoneLabel = stripExportTimeZoneLabel;`,
  context
);

assert.equal(context.stripExportTimeZoneLabel("Jul 29, 2026 · 9:00 PM GMT-4"), "Jul 29, 2026 · 9:00 PM");
assert.equal(context.stripExportTimeZoneLabel("Jul 29, 2026 · 9:00 PM EDT"), "Jul 29, 2026 · 9:00 PM");
assert.equal(context.stripExportTimeZoneLabel("Jul 29, 2026 · 9:00 PM ET"), "Jul 29, 2026 · 9:00 PM");

assert.equal(context.getOverlayStage(3.94), 3.9);
assert.equal(context.getOverlayStage(3.95), 3.9);
assert.equal(context.getOverlayStage(3.999), 3.9);
assert.equal(context.stageToCode(context.getOverlayStage(3.94)), "p0390");
assert.equal(context.stageToCode(context.getOverlayStage(3.95)), "p0390");
assert.match(SOURCE, /const STAGE_STEP = 0\.1;/);
assert.equal(context.getVerticalBathtubPenalty(3.25), 0.75);
assert.equal(context.getVerticalBathtubPenalty(3.24), 0);
assert.equal(context.getVerticalBathtubPenalty(4.25), 0.25);
assert.equal(context.getVerticalBathtubPenalty(5.25), 0);
assert.equal(context.getPenaltyRemainingFraction(3.75, "draining-release-15"), 2 / 3);
assert.equal(context.getPenaltyRemainingFraction(3.75, "draining-release-30"), 1 / 3);
assert.equal(context.getPenaltyRemainingFraction(4.75, "draining-release-15"), 1 / 2);
assert.equal(context.getPenaltyRemainingFraction(4.75, "draining-release-30"), 0);
assert.equal(context.formatDepthQueryValue(0.1), "0.0-0.1ft");
assert.equal(context.formatDepthQueryValue(0.10001), "0.10 ft");

const fillingContext = vm.createContext({
  Math,
  Number,
  Boolean,
  Infinity,
  Uint8ClampedArray,
  Uint32Array,
  STAGE_STEP: 0.1,
  MINOR_FLOOD_FT: 3.25,
  MODERATE_FLOOD_FT: 4.25,
  MAJOR_FLOOD_FT: 5.25,
  MINOR_VERTICAL_PENALTY_FT: 0.75,
  MODERATE_VERTICAL_PENALTY_FT: 0.25,
  MAJOR_VERTICAL_PENALTY_FT: 0,
  DRAINAGE_DEPTH_BREAKS_FT: [0.10, 0.25, 0.50, 1.00, 1.50, 2.00, 2.50, 3.00, 4.00, 5.00],
  DRAINAGE_DEPTH_COLORS: [
    [125, 249, 255], [93, 231, 255], [56, 211, 255], [27, 183, 245],
    [22, 140, 235], [21, 107, 224], [24, 83, 198], [23, 62, 168],
    [19, 47, 132], [11, 30, 91], [5, 14, 51]
  ],
  DRAINAGE_STAGE_COLORS: [[244, 167, 66], [231, 76, 60], [125, 60, 152]],
});
for (const name of [
  "normalizeHydraulicPhase",
  "getVerticalBathtubPenalty",
  "getPenaltyRemainingFraction",
  "getPenalizedConnectedDepth",
  "isDisconnectedRasterPixel",
  "isWetRasterPixel",
  "getDrainageDepthColor",
  "getDrainageStageColor",
  "getFillingStageFraction",
  "getFillingTransitionBlend",
  "isDevelopedRasterPixel",
  "isFillingTransitionCandidate",
  "isShallowFillingTransitionPixel",
  "getFillingTransitionPixelDepth",
  "buildFillingTransitionQueue",
  "applyFillingTransitionPixels",
]) {
  vm.runInContext(`${extractFunction(name)}; globalThis.${name} = ${name};`, fillingContext);
}
assert.ok(Math.abs(fillingContext.getFillingStageFraction(3.74, 3.7) - 0.4) < 1e-9);
assert.equal(fillingContext.getFillingStageFraction(3.69, 3.7), 0);
assert.equal(fillingContext.getFillingStageFraction(3.81, 3.7), 1);
assert.ok(Math.abs(fillingContext.getFillingTransitionBlend(0.4) - 0.896) < 1e-12);
assert.equal(fillingContext.getFillingTransitionBlend(0.5), 1);

const greenPixel = [99, 212, 113, 205];
const shallowPixel = [125, 249, 255, 225];
const mediumPixel = [27, 183, 245, 225];
const packedQueryPixel = (groundFt, connectionStageFt) => {
  const encodedGround = Math.round(groundFt * 10) + 32768;
  return [
    Math.floor(encodedGround / 256),
    encodedGround % 256,
    Math.round(connectionStageFt * 10) + 50,
    255,
  ];
};
const lowerTransitionPixels = new Uint8ClampedArray([
  ...shallowPixel,
  ...greenPixel,
  0, 0, 0, 0,
  ...greenPixel,
  ...greenPixel,
  ...greenPixel,
]);
const upperTransitionPixels = new Uint8ClampedArray([
  ...shallowPixel,
  ...mediumPixel,
  ...mediumPixel,
  ...mediumPixel,
  ...shallowPixel,
  ...shallowPixel,
]);
const developedTransitionPixels = new Uint8ClampedArray([
  0, 5, 0, 255,
  0, 10, 255, 255,
  0, 20, 255, 255,
  0, 30, 255, 255,
  0, 40, 255, 255,
  0, 50, 0, 255,
]);
const queryTransitionPixels = new Uint8ClampedArray([
  ...packedQueryPixel(3.0, 3.0),
  ...packedQueryPixel(3.1, 3.7),
  ...packedQueryPixel(3.2, 3.7),
  ...packedQueryPixel(3.3, 3.7),
  ...packedQueryPixel(3.0, 3.7),
  ...packedQueryPixel(3.0, 3.7),
]);
assert.equal(fillingContext.applyFillingTransitionPixels(
  lowerTransitionPixels,
  upperTransitionPixels,
  developedTransitionPixels,
  6,
  1,
  3.74,
  3.7,
  "depth",
  upperTransitionPixels,
  queryTransitionPixels
), 3, "Every physically ready developed pixel should advance together");
assert.deepEqual(Array.from(lowerTransitionPixels.slice(0, 4)), shallowPixel);
const blendedTransitionPixel = [34, 186, 231, 223];
const blendedTransparentPixel = [27, 183, 245, 202];
assert.deepEqual(Array.from(lowerTransitionPixels.slice(4, 8)), blendedTransitionPixel);
assert.deepEqual(Array.from(lowerTransitionPixels.slice(8, 12)), blendedTransparentPixel,
  "A ready transparent developed cell should fade in without dark RGB contamination");
assert.deepEqual(Array.from(lowerTransitionPixels.slice(12, 16)), greenPixel);
assert.deepEqual(Array.from(lowerTransitionPixels.slice(16, 20)), blendedTransitionPixel,
  "A shallow routed feeder must blend with the surface instead of drawing separately");
assert.deepEqual(Array.from(lowerTransitionPixels.slice(20, 24)), greenPixel,
  "Undeveloped disconnected cells must never be admitted by the developed-road transition");

// Shallow routed paths and their surrounding surface must use one temporal
// blend instead of a spatial wipe that exposes an isolated one-pixel line.
const feederWidth = 7;
const feederHeight = 5;
const feederPixelCount = feederWidth * feederHeight;
const feederLowerPixels = new Uint8ClampedArray(feederPixelCount * 4);
const feederUpperPixels = new Uint8ClampedArray(feederPixelCount * 4);
const feederDevelopedPixels = new Uint8ClampedArray(feederPixelCount * 4);
const feederQueryPixels = new Uint8ClampedArray(feederPixelCount * 4);
for (let pixel = 0; pixel < feederPixelCount; pixel += 1) {
  feederLowerPixels.set(pixel < feederWidth ? shallowPixel : greenPixel, pixel * 4);
  feederUpperPixels.set(greenPixel, pixel * 4);
  feederDevelopedPixels.set([0, 0, 255, 255], pixel * 4);
  feederQueryPixels.set(packedQueryPixel(3.0, 3.7), pixel * 4);
}
for (let x = 0; x < feederWidth; x += 1) {
  feederUpperPixels.set(shallowPixel, (feederWidth + x) * 4);
}
for (let y = 2; y < feederHeight; y += 1) {
  feederUpperPixels.set(shallowPixel, (y * feederWidth + 3) * 4);
}
assert.equal(fillingContext.applyFillingTransitionPixels(
  feederLowerPixels,
  feederUpperPixels,
  feederDevelopedPixels,
  feederWidth,
  feederHeight,
  3.74,
  3.7,
  "depth",
  feederUpperPixels,
  feederQueryPixels
), 10, "The full eligible feeder component and basin edge should advance together");
for (let y = 1; y < feederHeight; y += 1) {
  const offset = (y * feederWidth + 3) * 4;
  assert.deepEqual(Array.from(feederLowerPixels.slice(offset, offset + 4)), blendedTransitionPixel,
    "Every feeder pixel should use the same temporal blend");
}

let playbackIntervalMinutes = 15;
const playbackContext = vm.createContext({
  getTimelineIntervalMinutes: () => playbackIntervalMinutes,
  PLAYBACK_SIMULATED_HOUR_MS: 950,
});
vm.runInContext(
  `${extractFunction("getPlaybackFrameDurationMs")}; globalThis.getPlaybackFrameDurationMs = getPlaybackFrameDurationMs;`,
  playbackContext
);
assert.equal(playbackContext.getPlaybackFrameDurationMs(), 237.5);
playbackIntervalMinutes = 60;
assert.equal(playbackContext.getPlaybackFrameDurationMs(), 950);
playbackIntervalMinutes = 1440;
assert.equal(playbackContext.getPlaybackFrameDurationMs(), 950);
assert.match(extractFunction("preloadAroundHour"), /currentOverlayMode/);
assert.doesNotMatch(extractFunction("preloadAroundHour"), /\["depth", "dynamic"\]/);
assert.match(extractFunction("preloadAroundHour"), /requestIdleCallback/);
assert.match(extractFunction("preloadAroundHour"), /distance <= 12/);
assert.doesNotMatch(extractFunction("setTimelineIntervalMinutes"), /clearFloodLayer\(\)/);
assert.match(extractFunction("testImageUrl"), /imageExistsCache\.set\(url, request\)[\s\S]+await request/);
assert.match(extractFunction("getOverlayRecord"), /overlayRecordCache\.set\(key, request\)[\s\S]+await request/);
assert.match(extractFunction("setFloodLayer"), /await new Promise[\s\S]+markInitialFloodFrameReady\(\)/);
assert.match(extractFunction("setPhysicsFloodLayer"), /await new Promise[\s\S]+markInitialFloodFrameReady\(\)/);
assert.match(
  extractFunction("reloadAll"),
  /await renderHour\(currentHourIndex\)[\s\S]+activateDeferredMapLayers\(\)[\s\S]+scheduleBackgroundDataWarmup\(\)/
);
assert.match(extractFunction("activateDeferredMapLayers"), /basemapColorLayer\.addTo\(map\)/);
assert.doesNotMatch(
  extractFunction("ensureMap"),
  /className: "roads-layer",[\s\S]{0,120}\}\)\.addTo\(map\)/
);
assert.match(extractFunction("fitMapTitleBadgeToViewport"), /leftPanel[\s\S]+rightRail[\s\S]+availableWidth/);
assert.match(extractFunction("fitMapTitleBadgeToViewport"), /dataset\.viewportContained/);
assert.match(SOURCE, /id="north-wildwood-title-viewport-containment"/);
assert.match(SOURCE, /font-size:var\(--nww-title-font-size/);

const changingDepthSample = { elevation: 2, connectionStage: 1, developedFlag: true };
const lowWaterDepth = context.getDepthQueryDisplayDepth(changingDepthSample, 3.25);
const highWaterDepth = context.getDepthQueryDisplayDepth(changingDepthSample, 5.25);
assert.ok(
  highWaterDepth > lowWaterDepth,
  "An open depth popup must calculate a larger depth when the selected water level rises"
);
assert.equal(
  context.getDepthQueryDisplayDepth(changingDepthSample, 5.25, { flooded: false }),
  0,
  "The rendered overlay can still mark a modeled location as disconnected"
);
assert.equal(
  context.getDepthQueryDisplayDepth(
    { elevation: 4.1, connectionStage: 4.1, developedFlag: false },
    4.1,
    { flooded: true }
  ),
  0.05,
  "A visible zero-depth crest feeder must report the shallow-water range"
);
assert.equal(
  context.getPenalizedConnectedDepth(4.25, 4.0, true, "filling").depth,
  0,
  "The rising penalty must suppress only the local developed depth band"
);
assert.equal(
  context.getPenalizedConnectedDepth(4.25, 4.0, true, "slack").depth,
  0,
  "The penalty must remain in force at slack/high tide"
);
assert.equal(
  context.getPenalizedConnectedDepth(4.25, 4.0, true, "draining-release-15").depth,
  0.25,
  "Admitted post-crest water must equal the outside/source stage"
);
assert.equal(
  context.getPenaltyRemainingFraction(4.25, "draining-release-15"),
  0.5,
  "Moderate flooding must retain half its admission penalty after 15 minutes"
);
assert.equal(
  context.getPenaltyRemainingFraction(4.25, "draining-release-30"),
  0,
  "Moderate flooding must fill normally after 30 minutes"
);
assert.equal(context.getHydraulicStatePhase("draining-release-15"), "draining");
assert.equal(
  context.getPenalizedConnectedDepth(4.25, 4.0, true, "draining").depth,
  0.25,
  "Normal drainage must use the outside/source water stage"
);
assert.equal(
  context.getPenalizedConnectedDepth(4.25, 4.0, true, "filling", 0).depth,
  0,
  "The site-specific filling penalty must not vary with source distance"
);
assert.equal(
  context.getPenalizedConnectedDepth(5.25, 5.0, true, "filling").depth,
  0.25,
  "Normal filling must resume at major stage"
);

const phaseTransitionRows = [
  { stage: 3.65, timeUtc: "2024-09-19T13:30:00Z", timelineIntervalMinutes: 15 },
  { stage: 3.74, timeUtc: "2024-09-19T13:45:00Z", timelineIntervalMinutes: 15 },
  { stage: 3.83, timeUtc: "2024-09-19T14:00:00Z", timelineIntervalMinutes: 15 },
  { stage: 3.89, timeUtc: "2024-09-19T14:15:00Z", timelineIntervalMinutes: 15 },
  { stage: 3.90, timeUtc: "2024-09-19T14:30:00Z", timelineIntervalMinutes: 15 },
  { stage: 3.88, timeUtc: "2024-09-19T14:45:00Z", timelineIntervalMinutes: 15 },
  { stage: 3.77, timeUtc: "2024-09-19T15:00:00Z", timelineIntervalMinutes: 15 },
  { stage: 3.65, timeUtc: "2024-09-19T15:15:00Z", timelineIntervalMinutes: 15 },
];
const phaseContext = vm.createContext({
  Number,
  Math,
  Date,
  MINOR_FLOOD_FT: 3.25,
  MODERATE_FLOOD_FT: 4.25,
  MAJOR_FLOOD_FT: 5.25,
  currentSeriesHours: phaseTransitionRows,
  normalizeHydraulicPhase: context.normalizeHydraulicPhase,
  getStageValue: entry => entry?.stage,
  findClosestEntryIndex: () => -1,
  entryTimeMs: entry => Date.parse(entry?.timeUtc || entry?.hydraulicCrestTimeUtc || ""),
  getEntryESTDate: entry => new Date(entry.timeUtc),
  getNyParts: date => ({ minute: String(date.getUTCMinutes()) }),
  getTimelineIntervalMinutes: () => 15,
});
for (const name of [
  "getHydraulicFrameMinutes",
  "findHydraulicCrestIndex",
  "getHydraulicElapsedMinutes",
  "inferHydraulicPhaseForIndex",
  "annotateHydraulicSeries",
  "getHydraulicPhaseForEntry",
  "sampleCanonicalHydraulicSeries",
]) {
  vm.runInContext(`${extractFunction(name)}; globalThis.${name} = ${name};`, phaseContext);
}
assert.equal(
  phaseContext.getHydraulicPhaseForEntry(phaseTransitionRows[0], 0, phaseTransitionRows),
  "filling",
  "The filling penalty must remain full before the crest"
);
assert.equal(
  phaseContext.getHydraulicPhaseForEntry(phaseTransitionRows[1], 1, phaseTransitionRows),
  "filling"
);
assert.equal(
  phaseContext.getHydraulicPhaseForEntry(phaseTransitionRows[2], 2, phaseTransitionRows),
  "filling"
);
assert.equal(
  phaseContext.getHydraulicPhaseForEntry(phaseTransitionRows[3], 3, phaseTransitionRows),
  "slack"
);
assert.equal(
  phaseContext.getHydraulicPhaseForEntry(phaseTransitionRows[4], 4, phaseTransitionRows),
  "slack",
  "The crest must remain slack"
);
assert.equal(
  phaseContext.getHydraulicPhaseForEntry(phaseTransitionRows[5], 5, phaseTransitionRows),
  "draining-release-15",
  "A minor crest must retain two-thirds of its penalty after 15 minutes"
);
assert.equal(
  phaseContext.getHydraulicPhaseForEntry(phaseTransitionRows[6], 6, phaseTransitionRows),
  "draining-release-30",
  "A minor crest must retain one-third of its penalty after 30 minutes"
);
assert.equal(
  phaseContext.getHydraulicPhaseForEntry(phaseTransitionRows[7], 7, phaseTransitionRows),
  "draining",
  "A minor crest must fill normally after 45 minutes"
);

const hourlyPhaseRows = [
  { stage: 3.65, timelineIntervalMinutes: 60 },
  { stage: 3.90, timelineIntervalMinutes: 60 },
  { stage: 3.77, timelineIntervalMinutes: 60 },
];
assert.equal(
  phaseContext.getHydraulicPhaseForEntry(hourlyPhaseRows[0], 0, hourlyPhaseRows),
  "filling",
  "Hourly and quarter-hour views must both retain the full penalty one hour before crest"
);
assert.equal(
  phaseContext.getHydraulicPhaseForEntry(hourlyPhaseRows[1], 1, hourlyPhaseRows),
  "slack",
  "Hourly and quarter-hour views must both use slack at crest"
);

const canonicalPhaseRows = phaseContext.annotateHydraulicSeries(phaseTransitionRows);
const canonicalHourlyRows = phaseContext.sampleCanonicalHydraulicSeries(canonicalPhaseRows, 60);
assert.equal(canonicalHourlyRows.length, 2, "Hourly view must sample the canonical quarter-hour timeline");
assert.equal(canonicalHourlyRows[0].stage, 3.83);
assert.equal(canonicalHourlyRows[0].hydraulicPhase, "filling");
assert.equal(canonicalHourlyRows[1].stage, 3.77);
assert.equal(
  canonicalHourlyRows[1].hydraulicPhase,
  "draining-release-30",
  "The 11:00 hourly frame must retain the 10:30 quarter-hour crest and its 30-minute drainage state"
);
assert.equal(canonicalHourlyRows[1].hydraulicCrestTimeUtc, "2024-09-19T14:30:00.000Z");

const longRecessionRows = [
  { stage: 4.2, timeUtc: "2024-09-19T12:00:00Z", timelineIntervalMinutes: 15 },
  { stage: 3.0, timeUtc: "2024-09-19T13:00:00Z", timelineIntervalMinutes: 15 },
  { stage: 3.5, timeUtc: "2024-09-19T14:00:00Z", timelineIntervalMinutes: 15 },
  { stage: 3.9, timeUtc: "2024-09-19T14:30:00Z", timelineIntervalMinutes: 15 },
  { stage: 2.8, timeUtc: "2024-09-19T17:00:00Z", timelineIntervalMinutes: 15 },
];
assert.equal(
  phaseContext.findHydraulicCrestIndex(longRecessionRows, 4),
  3,
  "A long recession must keep its own local crest without borrowing a higher prior tide"
);

const drainagePixelContext = vm.createContext({
  Math,
  Number,
  Uint8Array,
  MINOR_FLOOD_FT: 3.25,
  MODERATE_FLOOD_FT: 4.25,
  MAJOR_FLOOD_FT: 5.25,
  DRAINAGE_DEPTH_BREAKS_FT: [0.10, 0.25, 0.50, 1.00, 1.50, 2.00, 2.50, 3.00, 4.00, 5.00],
  DRAINAGE_DEPTH_COLORS: [
    [125, 249, 255], [93, 231, 255], [56, 211, 255], [27, 183, 245],
    [22, 140, 235], [21, 107, 224], [24, 83, 198], [23, 62, 168],
    [19, 47, 132], [11, 30, 91], [5, 14, 51]
  ],
  DRAINAGE_STAGE_COLORS: [[244, 167, 66], [231, 76, 60], [125, 60, 152]],
});
for (const name of [
  "isDisconnectedRasterPixel",
  "isWetRasterPixel",
  "getDrainageDepthColor",
  "getDrainageStageColor",
  "applyDrainageRetentionPixels",
]) {
  vm.runInContext(`${extractFunction(name)}; globalThis.${name} = ${name};`, drainagePixelContext);
}
const currentPixels = new Uint8Array([99, 212, 113, 225, 99, 212, 113, 225]);
const historicalPixels = new Uint8Array([125, 249, 255, 225, 125, 249, 255, 225]);
const queryPixels = new Uint8Array([128, 30, 0, 255, 128, 40, 0, 255]);
assert.equal(
  drainagePixelContext.applyDrainageRetentionPixels(currentPixels, [historicalPixels], queryPixels, 3.7, "depth"),
  1,
  "Only previously wetted cells still below the outside water surface may be retained"
);
assert.deepEqual(Array.from(currentPixels.slice(0, 4)), [27, 183, 245, 225]);
assert.deepEqual(Array.from(currentPixels.slice(4, 8)), [99, 212, 113, 225]);

let previousPenalty = Infinity;
for (let stage = 3.25; stage <= 5.25 + 1e-9; stage += 0.1) {
  const penalty = context.getVerticalBathtubPenalty(stage);
  assert.ok(penalty <= previousPenalty + 1e-12, "Penalty must decrease monotonically");
  previousPenalty = penalty;
}

assert.match(SOURCE, /candidateElevation > -100 && candidateElevation < 100/);
assert.match(SOURCE, /elevation >= 1000/);
assert.doesNotMatch(SOURCE, /<dt>Ground<\/dt>/);
assert.doesNotMatch(SOURCE, /<dt>Maximum depth penalty<\/dt>/);
assert.match(SOURCE, /<div class="depth-query-value">/);
assert.match(extractFunction("getDepthQueryPopupHeading"), /currentDataMode === "forecast"[\s\S]+return "Forecast Water Depth"/);
assert.match(extractFunction("getDepthQueryPopupHeading"), /currentDataMode === "observed"[\s\S]+return "Water Depth"/);
assert.match(extractFunction("getDepthQueryPopupHeading"), /return "Modeled Water Depth"/);
assert.match(extractFunction("buildDepthQueryPopupHtml"), /getDepthQueryPopupHeading\(\)/);
assert.match(SOURCE, /let persistentDepthQueryContext = null/);
assert.match(SOURCE, /function updatePersistentDepthQueryPopup\(/);
assert.match(
  extractFunction("renderHour"),
  /updatePersistentDepthQueryPopup\(\{ useRenderedFlood: false \}\)/
);
assert.match(
  extractFunction("setFloodLayer"),
  /currentFloodLayer = nextLayer;[\s\S]+updatePersistentDepthQueryPopup\(\)/
);
assert.match(SOURCE, /id="satelliteToggle"/);
assert.match(SOURCE, /World_Imagery\/MapServer\/tile/);
assert.match(SOURCE, /payload\.valueType === "int16-le"/);
assert.match(SOURCE, /depthQueryPngPath/);
assert.match(SOURCE, /developedQueryPngPath/);
assert.match(SOURCE, /sourceDistanceFt/);
assert.doesNotMatch(SOURCE, /depthZoneQueryPngPath/);
assert.match(SOURCE, /function loadDepthQueryPng\(/);
assert.match(SOURCE, /async function samplePackedDepthGrid\(/);
assert.match(SOURCE, /encodedElevation - 32768/);
assert.match(SOURCE, /connectionCode - 50/);
assert.match(SOURCE, /\/assets\/hydraulic-v29\//);
assert.match(extractFunction("getOverlayCandidates"), /const orderedRoots = \[\.\.\.roots\]/);
assert.doesNotMatch(extractFunction("getOverlayCandidates"), /\.sort\(/);
assert.ok(
  SOURCE.indexOf('"./assets/hydraulic-v29/DepthPNGs/North%20Wildwood/"') <
    SOURCE.indexOf('"https://floodmapperv1.b-cdn.net/DepthPNGs/North%20Wildwood/v37/"'),
  "The complete bundled catalog must precede the matching Bunny v37 catalog",
);
assert.match(SOURCE, /20260816-road-feeder-v39/);
assert.match(SOURCE, /sampledFromCanonical15MinuteHistory/);
assert.match(SOURCE, /isHistoryAwareDrainageComposite/);
assert.match(extractFunction("preloadExportFrameAssets"), /getHydraulicOverlayRecord/);
assert.match(extractFunction("addFastCompositeGifFrames"), /getHydraulicOverlayRecord/);
assert.equal(HYDRAULIC_ASSET_MANIFEST.packedQuery.schema, "north-wildwood-packed-depth-query-v3");
assert.equal(
  HYDRAULIC_ASSET_MANIFEST.packedQuery.bytes,
  fs.statSync(path.join(BUNDLED_HYDRAULIC_ROOT, "COGs", "North Wildwood", "NorthWildwoodHydraulicQuery5ft.png")).size
);
assert.match(HYDRAULIC_ASSET_MANIFEST.eventHistoryDrainage.timelineBasis, /canonical 15-minute history/);
assert.match(SOURCE, /"modelKind": "phase-aware developed-land conditional connectivity"/);
assert.match(SOURCE, /"phaseInvariant": false/);
assert.match(SOURCE, /\/v37\//);
assert.match(extractFunction("getDepthQueryDisplayDepth"), /connectionStageLimit/);
assert.match(extractFunction("scheduleHistoricalTopTideWarmup"), /TOP_TIDE_DISPLAY_COUNT/);
assert.match(extractFunction("scheduleHistoricalTopTideWarmup"), /ensureObservedArchiveForDate/);
assert.match(extractFunction("scheduleHistoricalTopTideWarmup"), /preloadImage/);
assert.match(extractFunction("loadTopTideEvent"), /Promise\.all\(\[[\s\S]+crestAssetPromise/);
assert.match(
  extractFunction("loadTopTideEvent"),
  /preferredEntry[\s\S]+findClosestMeasuredEntryIndex\(currentSeriesHours, preferredEntry\)/,
);
assert.doesNotMatch(SOURCE, /historic_1962_five_tides/);
assert.match(SOURCE, /id="boundaryToggle"[^>]+role="switch"[^>]+aria-checked="true"/);
assert.match(SOURCE, />Simulation Extent</i);
assert.match(extractFunction("isTownBoundaryEnabled"), /boundaryToggle[\s\S]+classList\.contains\("on"\)/);
assert.match(SOURCE, /id="roadsToggle"[^>]+role="switch"[^>]+aria-checked="true"/);
assert.match(SOURCE, /el\.setAttribute\("aria-checked", String\(el\.classList\.contains\("on"\)\)\)/);
assert.doesNotMatch(
  SOURCE,
  /html body:not\(\.mobile-optimized\) #rightRail \.layers-card \.layer-list\{[^}]*grid-template-columns:repeat\(2/
);
assert.doesNotMatch(
  SOURCE,
  /html body:not\(\.mobile-optimized\) #rightRail > #downloadCard \.download-launch-meta\{[^}]*display:none/
);
assert.match(SOURCE, /:has\(#mapClickModeControl:not\(\[hidden\]\)\) #mapWrap > #legendDock\{[\s\S]+top:126px !important/);
assert.match(SOURCE, /depthQueryGridPromise = null/);
assert.match(
  SOURCE,
  /depthQueryImagePromise = GeoTIFF\.fromUrl[\s\S]+depthQueryImagePromise = null/
);
assert.match(
  SOURCE,
  /Packed routed-depth query failed; retrying through the COG/
);
assert.match(SOURCE, /id="downloadIntervalControl"/);
assert.match(SOURCE, /data-export-interval="hourly"/);
assert.match(SOURCE, /data-export-interval="15min"/);
assert.match(SOURCE, /data-export-interval="daily"/);
assert.match(SOURCE, /function buildExportRangeFrameItems\(/);
assert.match(SOURCE, /function buildQuarterHourRangeFrameItems\(/);
assert.match(SOURCE, /function buildDailyMaximumRangeFrameItems\(/);
assert.match(SOURCE, /function getReturnIntervalExportEntries\(/);
assert.match(SOURCE, /exportSourceMode: "return-interval"/);
assert.match(SOURCE, /mode: "return-interval"/);
assert.match(SOURCE, /currentDataMode !== "return-interval" && getDownloadScopeValue\(\) !== "current"/);
assert.match(SOURCE, /Create a shareable animation of the full \$\{modeledHours\}-hour modeled storm/);
assert.match(SOURCE, /getExportBaseName\(items\)/);
assert.match(SOURCE, /function getCurrentSelectionExportRange\(/);
assert.match(SOURCE, /const currentDate = getEntryESTDate\(getDownloadCurrentEntry\(\)\)/);
assert.match(SOURCE, /seedDownloadRangeToCurrentSelection\(force\)/);
assert.doesNotMatch(SOURCE, /seedDownloadRangeToCurrentForecast/);
assert.doesNotMatch(SOURCE, /\bstageColor\b/);
assert.match(SOURCE, /function getExportFrameDateTimeText\(/);
assert.match(SOURCE, /return `\$\{getExportFrameDateTimeText\(entry\)\}\\n\$\{getExportFrameWaterLevelText\(entry\)\}`/);
assert.doesNotMatch(extractFunction("getExportFrameTimestampText"), /15-Minute|Hourly|Daily maximum|Water level/);
assert.match(SOURCE, /const MODELED_EXPORT_DATE_PLACEHOLDER = "xx\/xx\/xxxx"/);
assert.match(extractFunction("syncExportDateTimeEditorFromCanonical"), /modeledDateLocked[\s\S]+MODELED_EXPORT_DATE_PLACEHOLDER/);
assert.match(SOURCE, /function commitExportDateTimeEditor\([\s\S]+currentDataMode === "return-interval"[\s\S]+canonicalMatch/);
assert.match(extractFunction("getReturnIntervalStormLabel"), /`\$\{value\.toLocaleString\("en-US"\)\}-Year Storm`/);
assert.doesNotMatch(extractFunction("getExportFrameTimestampText"), /if \(entry\?\.returnIntervalYears\)/);
assert.doesNotMatch(extractFunction("getExportFrameTimestampText"), /formatReturnStormOffset/);
assert.match(SOURCE, /data-export-legend-mode="depth"/);
assert.match(SOURCE, /class="export-depth-key-gradient"/);
assert.match(SOURCE, /<strong>Flood Depth<\/strong>/);
assert.match(SOURCE, /linear-gradient\(90deg,#63d471 0%,#63d471 18%,#18c8ff 18%/);
assert.match(SOURCE, /<strong>Green<\/strong> = uncertainty/);
assert.match(SOURCE, /<span>Uncertainty<\/span>/);
assert.doesNotMatch(SOURCE, /Not Yet Connected/i);
assert.doesNotMatch(SOURCE, /penalty-held/i);
assert.match(extractFunction("fitExportMapToSelectedExtent"), /fitBounds\(map\.getBounds\(\)/);
assert.match(extractFunction("fitExportMapToSelectedExtent"), /mode === "town"[\s\S]+getBoundaryDrivenOverlayBounds\(\)/);
assert.match(extractFunction("fitExportMapToSelectedExtent"), /paddingTopLeft/);
assert.match(SOURCE, /data-aspect="4:5"[^>]+>Social 4:5</);
assert.match(SOURCE, /data-extent="town"[^>]+>Fill North Wildwood</);
assert.match(SOURCE, /"4:5": \{ value: "4:5", width: 1080, height: 1350, pngWidth: 2160, pngHeight: 2700/);
assert.match(extractFunction("getExportAspectConfig"), /getDownloadFormatValue\(\) !== "png"/);
assert.match(extractFunction("getExportAspectConfig"), /resolutionLabel/);
assert.match(extractFunction("renderLegend"), /physics-daily-maximum-active/);
assert.match(extractFunction("renderLegend"), /Daily Max/);
assert.match(extractFunction("renderLegend"), /Physics daily max/);
assert.match(extractFunction("updateExportLegend"), /entry = null/);
assert.match(extractFunction("updateExportLegend"), /isPhysicsDailyMaximum/);
assert.match(
  SOURCE,
  /async function prepareExportFrame\(item, options = \{\}\)[\s\S]+updateExportLegend\(item\.entry\)/
);
assert.match(extractFunction("captureFastGifBaseCanvas"), /updateExportLegend\(firstItem\?\.entry\)/);
assert.match(extractFunction("renderHour"), /physics-daily-maximum-active/);
assert.doesNotMatch(SOURCE, /Green represents uncertainty/i);
assert.doesNotMatch(SOURCE, /Feet above ground/);
assert.doesNotMatch(SOURCE, /class="export-depth-key-disconnected"/);
assert.match(extractFunction("updateExportLegend"), /querySelectorAll\("\.legend-row-boundary"\)\.forEach\(row => row\.remove\(\)\)/);
assert.match(SOURCE, /--boundary-color:#000000/);
assert.match(SOURCE, /NorthWildwoodParcelBoundaries\.png\?v=20260802-red-parcels-v1/);
assert.match(SOURCE, /opacity: 0\.78/);
assert.match(SOURCE, /exportMap\.createPane\("parcelsPane"\)/);
assert.match(SOURCE, /async function updateExportParcelsLayer\(/);
assert.match(SOURCE, /async function prepareExportFrame\([\s\S]+await updateExportParcelsLayer\(\)/);
assert.match(SOURCE, /async function captureFastGifBaseCanvas\([\s\S]+await updateExportParcelsLayer\(\)/);
assert.match(SOURCE, /async function buildStableExportGifPalette\(/);
assert.match(extractFunction("buildStableExportGifPalette"), /globalPalette: true/);
assert.match(extractFunction("exportGif"), /globalPalette: stableGlobalPalette/);
assert.doesNotMatch(SOURCE, /globalPalette: false/);
assert.doesNotMatch(SOURCE, /seedGifLegendPalette/);
assert.match(SOURCE, /\.export-stage-legend\[data-export-legend-mode="depth"\]\{[\s\S]+background:#0b1220 !important/);
assert.match(SOURCE, /id="north-wildwood-export-final-qa"/);
assert.match(SOURCE, /data-export-aspect="16:9"|font-size:60px !important/);
assert.match(SOURCE, /data-export-aspect="1:1"[\s\S]+font-size:52px !important/);
assert.match(SOURCE, /data-export-aspect="4:5"[\s\S]+font-size:50px !important/);
assert.match(SOURCE, /data-export-aspect="9:16"[\s\S]+font-size:50px !important/);

const modeledStormLabelContext = vm.createContext({ Number });
vm.runInContext(
  `${extractFunction("getReturnIntervalStormLabel")}; globalThis.getReturnIntervalStormLabel = getReturnIntervalStormLabel;`,
  modeledStormLabelContext
);
for (const years of [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
  assert.equal(
    modeledStormLabelContext.getReturnIntervalStormLabel(years),
    `${years.toLocaleString("en-US")}-Year Storm`,
    `Modeled GIF title is wrong for the ${years}-year interval`
  );
}

const modeledTimestampContext = vm.createContext({
  getExportFrameDateTimeText: entry => `${Number(entry.returnIntervalYears).toLocaleString("en-US")}-Year Storm`,
  getExportFrameWaterLevelText: entry => `${Number(entry.stage).toFixed(2)} ft NAVD88`
});
vm.runInContext(
  `${extractFunction("getExportFrameTimestampText")}; globalThis.getExportFrameTimestampText = getExportFrameTimestampText;`,
  modeledTimestampContext
);
assert.equal(
  modeledTimestampContext.getExportFrameTimestampText({ returnIntervalYears: 20, stage: 4.37 }),
  "20-Year Storm\n4.37 ft NAVD88",
  "Modeled GIF title cards must include the tide height and datum on a second line"
);
assert.match(SOURCE, /function captureExportRoadLabelsCanvas\(/);
assert.doesNotMatch(SOURCE, /function normalizeExportRoadLabelCanvas\(/);
assert.match(
  extractFunction("captureExportRoadLabelsCanvas"),
  /return captureExportLayerCanvas\(\{/
);
assert.match(SOURCE, /ctx\.drawImage\(roadLabelsCanvas[\s\S]+ctx\.drawImage\(chromeCanvas[\s\S]+drawExportTimestampOnCanvas/);
assert.match(SOURCE, /getPane\("roadsPane"\)\.style\.zIndex = 710/);
assert.match(SOURCE, /\.export-stage \.leaflet-pane\.roads-dark img,[\s\S]+filter:none !important/);
assert.match(SOURCE, /\.export-stage-legend\[data-export-legend-mode="depth"\]\{[\s\S]+right:40px !important/);
assert.doesNotMatch(extractFunction("getExportFrameDateTimeText"), /timeZoneName|GMT|UTC|E\[SD\]T/);
assert.match(SOURCE, /id="buildingsToggle"/);
assert.match(SOURCE, /function styleEsriBuildingForeground\(/);
assert.match(SOURCE, /makeEsriBuildingForegroundLayer\("buildingsPane"\)/);
assert.doesNotMatch(SOURCE, /Buildings are above the water/);
assert.doesNotMatch(SOURCE, /recorded high-tide floods?/);
assert.match(SOURCE, /modeled floor exceedances/);
assert.match(SOURCE, /id="nsiStructuresToggle"/);
assert.match(SOURCE, /north-wildwood-nsi-2026-first-floor-v1/);
assert.match(SOURCE, /function getNsiStructureImpactStyle\(/);
assert.match(SOURCE, /function buildNsiStructurePopup\(/);
assert.match(SOURCE, /function findNsiStructureFeatureForLocation\(/);
assert.match(SOURCE, /getPane\("structuresPane"\)\.style\.zIndex = 625/);
assert.match(SOURCE, /L\.canvas\(\{ pane: "structuresPane"/);
assert.match(extractFunction("findProjectionElevationIndex"), /nsi2026ModelElevationIndex/);
assert.match(extractFunction("renderHour"), /updateNsiStructureImpactLayer\(\)/);
assert.match(extractFunction("openPersistentFloodPopup"), /desktopRightRailWidth \+ 30/);
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
assert.match(SOURCE, /north-wildwood-physics-forecast-v1/);
assert.match(SOURCE, /"physicsForecastPointerPath": null/);
assert.match(SOURCE, /"physicsForecastCyclePointerTemplatePath": null/);
assert.match(extractFunction("physicsPointerUrl"), /forecastData\?\.petssCycleUtc/);
assert.match(extractFunction("physicsPointerUrl"), /replaceAll\("\{cycleId\}", cycleId\)/);
assert.match(SOURCE, /function getPhysicsForecastDisplaySeries\(/);
assert.match(SOURCE, /function physicsManifestMatchesForecastCycle\(/);
assert.match(SOURCE, /physicsCycle === dashboardCycle/);
assert.match(SOURCE, /function setPhysicsFloodLayer\(/);
assert.match(SOURCE, /function samplePhysicsDepth\(/);
assert.match(extractFunction("renderHour"), /if \(physicsAsset\) await setPhysicsFloodLayer/);
assert.match(SOURCE, /getActivePhysicsManifest\(\)\.frames\.map\(physicsFrameToForecastEntry\)/);
assert.match(extractFunction("setExportFloodLayer"), /getPhysicsAssetForEntry\(entry\)/);
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
assert.match(SOURCE, /id="north-wildwood-centered-close-controls"/);
assert.match(SOURCE, /transform:translate\(-50%,-50%\) rotate\(45deg\) !important/);
assert.match(SOURCE, /transform:translate\(-50%,-50%\) rotate\(-45deg\) !important/);
assert.match(SOURCE, /\.flood-year-control input\[type="range"\]\{[\s\S]+min-height:30px !important/);
assert.match(SOURCE, /grid-template-columns:120px minmax\(0, 1fr\) !important/);
assert.match(SOURCE, /persistent-flood-popup-open #timelineBubble/);
assert.match(SOURCE, /\{ allowNearest: false \}/);
assert.match(SOURCE, /No parcel contains that building tap/);
assert.match(SOURCE, /requestIdleCallback/);
assert.match(SOURCE, /loadForecast\(null, \{ selectCurrent: true, forceRefresh: true, deferPhysicsCatalog: true \}\)/);
assert.match(extractFunction("scheduleForecastCatalogWarmup"), /initialFloodFrame !== "ready"/);
assert.match(extractFunction("scheduleForecastCatalogWarmup"), /loadPhysicsForecast\(false\)/);
assert.match(SOURCE, /observedArchiveIndexPath/);
assert.match(SOURCE, /lewesArchiveIndexPath/);
assert.match(SOURCE, /function ensureObservedArchiveYear\(/);
assert.match(SOURCE, /function ensureObservedArchiveRange\(/);
assert.match(SOURCE, /await ensureObservedArchiveForDate\(dateStr\)/);
assert.match(SOURCE, /Loading the selected tide-archive year/);
assert.doesNotMatch(extractFunction("warmBackgroundData"), /LEWES_HOURLY_URL/);
assert.doesNotMatch(extractFunction("warmBackgroundData"), /OBSERVED_15MIN_URL/);
assert.match(SOURCE, /data-return-years="10000"/);
assert.match(
  SOURCE,
  /const RETURN_INTERVAL_OPTIONS = \[1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000\]/
);
assert.match(
  SOURCE,
  /\.leaflet-image-layer\.return-interval-depth-overlay,[\s\S]+filter:contrast\(\.68\) brightness\(1\.25\) saturate\(1\.25\)/
);
assert.match(
  extractFunction("setFloodLayer"),
  /className: currentDataMode === "return-interval" && mode === "depth"[\s\S]+return-interval-depth-overlay/
);
assert.match(
  extractFunction("setExportFloodLayer"),
  /className: currentDataMode === "return-interval" && mode === "depth"[\s\S]+return-interval-depth-overlay/
);
assert.match(SOURCE, /record\.targetNavd88Ft \?\? record\.weightedNavd88Ft \?\? record\.naccsNavd88Ft/);
assert.match(extractFunction("switchReturnInterval"), /await loadReturnInterval\(\)/);
assert.doesNotMatch(extractFunction("switchReturnInterval"), /previousEntry/);
assert.match(SOURCE, /<h2>Flood Data<\/h2>/);
assert.match(SOURCE, />Modeled Floods<\/button>/);
assert.match(SOURCE, /<h2>How Often\?<\/h2>/);
assert.match(SOURCE, /Every 10 Years/);
assert.match(SOURCE, /return-interval-mode #leftPanel > #timelineIntervalCard\{order:1 !important\}/);
assert.match(SOURCE, /#rightRail > #mapperTutorialBtn\{order:5 !important\}/);
assert.match(SOURCE, /#mapperTutorialBtn\.mapper-tutorial-launch\{[\s\S]+bottom:0 !important/);
assert.match(SOURCE, /body\.observed-mode #leftPanel \.data-source-options,[\s\S]+grid-template-columns:repeat\(3,minmax\(0,1fr\)\) !important/);
assert.match(SOURCE, /function loadObservedDay\([\s\S]+findClosestMeasuredEntryIndex\(currentSeriesHours, preferredEntry\)/);
assert.match(extractFunction("getLatestObservedDate"), /peakNAVD88 != null/);
assert.match(extractFunction("getLatestObservedDate"), /hasMeasuredHour/);
assert.match(extractFunction("renderTimelineDays"), /hasDisplayedLongGaugeOutage\(currentSeriesHours, group\.start, group\.end\)/);
assert.match(extractFunction("renderHour"), /hasDisplayedLongGaugeOutage\(currentSeriesHours\)/);
const helpCopyStart = SOURCE.indexOf("const HELP_COPY =");
const helpCopyEnd = SOURCE.indexOf("function setInfoModalOpen", helpCopyStart);
assert.ok(helpCopyStart >= 0 && helpCopyEnd > helpCopyStart);
assert.doesNotMatch(SOURCE.slice(helpCopyStart, helpCopyEnd), /—/);
assert.doesNotMatch(extractFunction("sliderHelpBody"), /—/);

const nearestObservedContext = vm.createContext({
  Number,
  entryTimeMs: entry => Date.parse(entry.timeUtc),
  getStageValue: entry => entry.navd88StageFt,
  findClosestEntryIndex: () => 0,
});
vm.runInContext(
  `${extractFunction("findClosestMeasuredEntryIndex")}; globalThis.findClosestMeasuredEntryIndex = findClosestMeasuredEntryIndex;`,
  nearestObservedContext
);
const fallbackSeries = Array.from({ length: 24 }, (_, index) => ({
  timeUtc: new Date(Date.UTC(2026, 6, 30, index)).toISOString(),
  navd88StageFt: index === 9 ? 2.13 : null,
  isMissingObservedHour: index !== 9,
}));
assert.equal(
  nearestObservedContext.findClosestMeasuredEntryIndex(
    fallbackSeries,
    { timeUtc: new Date(Date.UTC(2026, 6, 30, 12)).toISOString() }
  ),
  9,
  "Observed mode must choose the nearest real measurement instead of a closer missing slot"
);
assert.equal(
  nearestObservedContext.findClosestMeasuredEntryIndex(
    [
      { timeUtc: new Date(Date.UTC(2026, 6, 30, 9)).toISOString(), navd88StageFt: 2.1 },
      { timeUtc: new Date(Date.UTC(2026, 6, 30, 11)).toISOString(), navd88StageFt: 2.2 },
    ],
    { timeUtc: new Date(Date.UTC(2026, 6, 30, 10)).toISOString() }
  ),
  1,
  "An equal-distance observed fallback should prefer the newer measurement"
);

const gaugeOutageContext = vm.createContext({
  Number,
  getStageValue: entry => entry.navd88StageFt,
  getTimelineFrameHours: () => 1,
});
vm.runInContext(
  `${extractFunction("getLongestGaugeOutageHours")}; globalThis.getLongestGaugeOutageHours = getLongestGaugeOutageHours;`,
  gaugeOutageContext
);
const partialLatestDay = Array.from({ length: 24 }, (_, index) => ({
  navd88StageFt: index === 9 ? 2.13 : null,
  isMissingObservedHour: index !== 9,
}));
assert.equal(gaugeOutageContext.getLongestGaugeOutageHours(partialLatestDay), 14);
assert.equal(
  gaugeOutageContext.getLongestGaugeOutageHours(partialLatestDay, 0, null, { ignoreTrailingGap: true }),
  9,
  "Future or not-yet-published slots after the latest real reading must not mark the latest observed day inoperable"
);
const interruptedDay = partialLatestDay.map((entry, index) => (
  index === 23 ? { navd88StageFt: 2.2, isMissingObservedHour: false } : entry
));
assert.equal(
  gaugeOutageContext.getLongestGaugeOutageHours(interruptedDay, 0, null, { ignoreTrailingGap: true }),
  13,
  "A completed gap between two real readings must still be treated as a gauge outage"
);
assert.doesNotMatch(SOURCE, /id="returnIntervalMethodNote"/);
assert.doesNotMatch(SOURCE, /no USGS averaging/);
assert.doesNotMatch(SOURCE, /depth map capped at/);
assert.match(SOURCE, /function clearStableDesktopPaneSizes\(/);
assert.equal(OBSERVED_INDEX.source, "stone-harbor");
assert.equal(LEWES_INDEX.source, "lewes");
assert.equal(OBSERVED_INDEX.days.length, OBSERVED_15MIN.days.length);
assert.ok(LEWES_INDEX.days.length > 23000);

for (const family of ["DepthPNGs", "StagePNGs"]) {
  for (const phase of ["", "filling", "draining"]) {
    const directory = path.join(
      BUNDLED_HYDRAULIC_ROOT,
      family,
      "North Wildwood",
      phase
    );
    const files = fs.readdirSync(directory).filter(name => name.endsWith(".png")).sort();
    assert.equal(files.length, 201, `${family}/${phase || "slack"} must contain the complete 0.0–20.0 ft catalog`);
    assert.match(files[0], /p0000\.png$/);
    assert.match(files.at(-1), /p2000\.png$/);
  }
}
assert.ok(fs.statSync(path.join(
  BUNDLED_HYDRAULIC_ROOT,
  "COGs",
  "North Wildwood",
  "NorthWildwoodHydraulicQuery5ft.png"
)).size > 1_000_000);
assert.ok(fs.statSync(path.join(
  BUNDLED_HYDRAULIC_ROOT,
  "COGs",
  "North Wildwood",
  "NorthWildwoodDevelopedMask5ft.png"
)).size > 1_000);

const selectedRangeContext = vm.createContext({
  Date,
  Math,
  Number,
  EXPORT_RANGE_MAX_MS: 84 * 60 * 60 * 1000,
  currentDataMode: "forecast",
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

const modeledFrames = [
  { date: new Date("2026-06-15T13:45:00.000Z"), navd88StageFt: 2.1 },
  { date: new Date("2026-06-16T01:45:00.000Z"), navd88StageFt: 6.2 },
  { date: new Date("2026-06-16T13:45:00.000Z"), navd88StageFt: 2.0 },
];
selectedRangeContext.currentDataMode = "return-interval";
selectedRangeContext.currentEntry = modeledFrames[1];
selectedRangeContext.getReturnIntervalExportEntries = () => modeledFrames;
selectedRangeContext.entryTimeMs = entry => entry.date.getTime();
selectedRange = selectedRangeContext.getCurrentSelectionExportRange();
assert.equal(
  selectedRange.firstDate.getTime(),
  modeledFrames[0].date.getTime(),
  "Modeled export must default to the beginning of the synthetic storm"
);
assert.equal(
  selectedRange.lastDate.getTime(),
  modeledFrames.at(-1).date.getTime(),
  "Modeled export must default to the end of the synthetic storm"
);

const modeledExportContext = vm.createContext({
  Array,
  Number,
  currentDataMode: "return-interval",
  currentRawSeriesHours: modeledFrames,
  currentSeriesHours: modeledFrames,
  selectedObservedDate: "",
  entryTimeMs: entry => entry.date.getTime(),
});
for (const name of [
  "getReturnIntervalExportEntries",
  "getCurrentExportSourceMode",
  "getDownloadSourceEntries",
  "getDownloadFrameItemFromEntry",
]) {
  vm.runInContext(`${extractFunction(name)}; globalThis.${name} = ${name};`, modeledExportContext);
}
const modeledSources = modeledExportContext.getDownloadSourceEntries();
assert.equal(modeledSources.length, modeledFrames.length);
assert.deepEqual(
  Array.from(modeledSources, entry => entry.exportSourceMode),
  ["return-interval", "return-interval", "return-interval"],
  "Modeled export frames must not be relabeled as forecast frames"
);
const modeledFrameItem = modeledExportContext.getDownloadFrameItemFromEntry(modeledSources[1], 1);
assert.equal(modeledFrameItem.mode, "return-interval");
assert.equal(modeledFrameItem.series.length, modeledFrames.length);

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
