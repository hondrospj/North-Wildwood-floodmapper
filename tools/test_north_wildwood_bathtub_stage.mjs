#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "..", "index.html"), "utf8");

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `Missing browser function ${name}`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Unterminated browser function ${name}`);
}

const encodeGround = groundFt => {
  const value = Math.round(groundFt * 10) + 32768;
  return [Math.floor(value / 256), value % 256, 255, 255];
};

const context = vm.createContext({
  MINOR_FLOOD_FT: 3.25,
  MODERATE_FLOOD_FT: 4.25,
  DRAINAGE_STAGE_COLORS: [[244, 167, 66], [231, 76, 60], [125, 60, 152]],
  Number,
});
vm.runInContext(
  `${extractFunction("applyBathtubStagePixels")}; globalThis.applyBathtubStagePixels = applyBathtubStagePixels;`,
  context
);

const sourcePixels = new Uint8ClampedArray([
  ...encodeGround(3.0),
  ...encodeGround(3.5),
  ...encodeGround(4.5),
  ...encodeGround(5.5),
  0, 0, 255, 255,
]);
const targetPixels = new Uint8ClampedArray(sourcePixels.length);
const count = context.applyBathtubStagePixels(sourcePixels, targetPixels, 5.0);

assert.equal(count, 3);
assert.deepEqual(Array.from(targetPixels.slice(0, 4)), [244, 167, 66, 225]);
assert.deepEqual(Array.from(targetPixels.slice(4, 8)), [231, 76, 60, 225]);
assert.deepEqual(Array.from(targetPixels.slice(8, 12)), [125, 60, 152, 225]);
assert.deepEqual(Array.from(targetPixels.slice(12, 20)), Array(8).fill(0));

assert.match(extractFunction("getHydraulicOverlayRecord"), /mode === "dynamic"[\s\S]+getBathtubStageOverlayRecord/);
assert.doesNotMatch(extractFunction("getBathtubStageOverlayRecord"), /connection|developed|penalty|phase/i);
assert.match(source, /North Wildwood Flood Mapper/);
assert.doesNotMatch(source, /North Wildwood Coastal Flood Mapper/);
assert.doesNotMatch(source, /id="legendCollapseBtn"/);
assert.match(source, /id="legendHelpBtn"[^>]*>\?<\/button>/);
assert.match(extractFunction("syncMobileControlsLayout"), /\{ mobileRailMount, closeBtn \}/);
assert.match(extractFunction("syncMobileControlsLayout"), /getElementById\("mobileControlsClose"\) \|\| closeBtn/);
assert.match(source, /#legendDock\[data-legend-mode="dynamic"\][\s\S]+font-size:16px !important/);
assert.match(source, /deferPhysicsCatalog: true/);
assert.match(extractFunction("reloadAll"), /renderHour\(currentHourIndex\)[\s\S]+waitForInitialFramePaint\(\)[\s\S]+scheduleForecastCatalogWarmup\(\)/);
assert.match(extractFunction("setFloodLayer"), /initialFloodFrame === "loading"[\s\S]+getOverlayRecord/);
assert.doesNotMatch(extractFunction("scheduleHistoricalTopTideWarmup"), /"dynamic"/);

console.log("North Wildwood bathtub-stage checks passed");
