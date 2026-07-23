#!/usr/bin/env node
// Static and executable checks for the browser's 0.05-ft depth contract.

import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import path from "node:path";


const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = fs.readFileSync(path.join(HERE, "..", "index.html"), "utf8");

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

console.log("North Wildwood browser depth contract checks passed");
