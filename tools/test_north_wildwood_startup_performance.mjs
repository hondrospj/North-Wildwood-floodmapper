#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
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

const parserBlockingScripts = [...source.matchAll(/<script\s+src="([^"]+)"/g)].map(match => match[1]);
assert.deepEqual(parserBlockingScripts, [
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
  "https://unpkg.com/esri-leaflet@3.0.19/dist/esri-leaflet.js",
  "https://unpkg.com/esri-leaflet-vector@4.3.2/dist/esri-leaflet-vector.js",
  "./assets/3d/north-wildwood-3d.js?v=20260825-nw-3d-v60",
]);

assert.match(source, /const OPTIONAL_SCRIPT_URLS = \{[\s\S]+html2canvas[\s\S]+gif[\s\S]+jszip[\s\S]+geotiff/);
assert.match(extractFunction("downloadCurrentSelection"), /await ensureExportLibraries\(format, frameItems\.length\)/);
assert.match(extractFunction("getDepthQueryImage"), /await ensureDepthQueryLibrary\(\)/);

const backgroundWarmup = extractFunction("scheduleBackgroundDataWarmup");
assert.match(backgroundWarmup, /backgroundDataWarmup = "on-demand"/);
assert.doesNotMatch(backgroundWarmup, /warmBackgroundData\(\)/);
assert.doesNotMatch(extractFunction("warmBackgroundData"), /TOP_TIDES_URL/);

const reloadAll = extractFunction("reloadAll");
assert.match(reloadAll, /waitForInitialFramePaint\(\)[\s\S]+scheduleTopTidesListWarmup\(\)[\s\S]+scheduleBackgroundDataWarmup\(\)/);

const startupPreload = extractFunction("preloadNorthWildwoodExperience");
assert.match(startupPreload, /warmCamera: "core"/);
assert.doesNotMatch(startupPreload, /OBSERVED_URL/);
assert.doesNotMatch(startupPreload, /ensureParcelAssets\(\)/);
assert.doesNotMatch(startupPreload, /ensureNsiStructureAssets\(\)/);
assert.doesNotMatch(startupPreload, /loadOptionalScript\(/);
assert.doesNotMatch(startupPreload, /scheduleNorthWildwood3dWarmup\(\)/);
assert.match(startupPreload, /map3dDeferredWarmup = "on-demand-no-background-camera-traversal"/);

console.log("North Wildwood startup performance checks passed");
