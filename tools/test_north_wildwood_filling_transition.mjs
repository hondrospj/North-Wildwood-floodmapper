#!/usr/bin/env node
// Focused checks for smooth fractional-stage filling without the full asset catalog.

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
  Boolean,
  Infinity,
  Uint8Array,
  Uint8ClampedArray,
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
    [19, 47, 132], [11, 30, 91], [5, 14, 51],
  ],
  DRAINAGE_STAGE_COLORS: [[244, 167, 66], [231, 76, 60], [125, 60, 152]],
});

for (const name of [
  "getVerticalBathtubPenalty",
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
  vm.runInContext(`${extractFunction(name)}; globalThis.${name} = ${name};`, context);
}

const green = [99, 212, 113, 205];
const shallow = [125, 249, 255, 225];
const medium = [27, 183, 245, 225];
const packedQueryPixel = (groundFt, connectionStageFt) => {
  const encodedGround = Math.round(groundFt * 10) + 32768;
  return [
    Math.floor(encodedGround / 256),
    encodedGround % 256,
    Math.round(connectionStageFt * 10) + 50,
    255,
  ];
};

const lower = new Uint8ClampedArray([...shallow, ...green, ...green, ...green]);
const upper = new Uint8ClampedArray([...shallow, ...medium, ...shallow, ...medium]);
const developed = new Uint8ClampedArray([
  0, 0, 255, 255,
  0, 0, 255, 255,
  0, 0, 255, 255,
  0, 0, 255, 255,
]);
const query = new Uint8ClampedArray([
  ...packedQueryPixel(3.0, 3.0),
  ...packedQueryPixel(3.1, 3.7),
  ...packedQueryPixel(3.0, 3.7),
  ...packedQueryPixel(3.3, 3.7),
]);

assert.equal(
  context.applyFillingTransitionPixels(
    lower, upper, developed, 4, 1, 3.74, 3.7, "depth", upper, query
  ),
  2,
  "All physically ready pixels should share the transition",
);
const blended = [34, 186, 231, 223];
assert.deepEqual(Array.from(lower.slice(4, 8)), blended,
  "A newly admitted pixel should blend toward its actual depth color");
assert.deepEqual(Array.from(lower.slice(8, 12)), blended,
  "A shallow routed pixel must transition with the full surface");
assert.deepEqual(Array.from(lower.slice(12, 16)), green,
  "Ground above the adjusted water surface must remain green");
assert.equal(
  context.applyFillingTransitionPixels(
    lower, upper, developed, 4, 1, 3.74, 3.7, "depth", upper, null
  ),
  0,
  "Missing packed-query data must fall back without inventing a transition line",
);

assert.match(SOURCE, /<strong>Green<\/strong> = uncertainty/);
assert.match(SOURCE, /<span>Uncertainty<\/span>/);
assert.doesNotMatch(SOURCE, /Not Yet Connected/i);
assert.doesNotMatch(SOURCE, /penalty-held/i);

console.log("North Wildwood smooth filling transition checks passed");
