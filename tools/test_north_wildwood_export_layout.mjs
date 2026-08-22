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

assert.match(source, /<h3>Create Shareable Map<\/h3>/);
assert.match(source, /<h3 id="downloadModalTitle">Create shareable flood map<\/h3>/);
assert.match(source, /data-aspect="4:5"[^>]+>Social 4:5<\/button>/);
assert.match(source, /data-extent="town"[^>]+>Fill North Wildwood<\/button>/);
assert.match(source, /pngWidth: 2160, pngHeight: 2700/);
assert.match(source, /id="north-wildwood-export-device-layout"/);
assert.match(source, /#downloadModal #downloadAspectControl\{\s*grid-template-columns:repeat\(2,minmax\(0,1fr\)\) !important/);
assert.match(source, /compactTouchLayout[\s\S]+downloadModalCloseBtn[\s\S]+preventScroll: true/);

const socialBase = {
  value: "4:5",
  width: 1080,
  height: 1350,
  pngWidth: 2160,
  pngHeight: 2700,
  label: "Social 4:5",
};
const aspectContext = vm.createContext({
  EXPORT_GIF_ASPECTS: { "4:5": socialBase },
  getDownloadAspectValue: () => "4:5",
  getDownloadFormatValue: () => "png",
});
vm.runInContext(
  `${extractFunction("getExportAspectConfig")}; globalThis.getExportAspectConfig = getExportAspectConfig;`,
  aspectContext
);
const pngAspect = aspectContext.getExportAspectConfig();
assert.equal(pngAspect.width, 2160);
assert.equal(pngAspect.height, 2700);
assert.equal(pngAspect.resolutionLabel, "2160 × 2700");

const townBounds = { isValid: () => true };
let fittedBounds = null;
let fittedOptions = null;
const mapInstance = {
  fitBounds(bounds, options) {
    fittedBounds = bounds;
    fittedOptions = options;
  },
};
const fitContext = vm.createContext({
  getDownloadExtentValue: () => "town",
  getBoundaryDrivenOverlayBounds: () => townBounds,
  getExportAspectConfig: () => pngAspect,
  map: null,
  floodLatLngBounds: null,
  Math,
});
vm.runInContext(
  `${extractFunction("fitExportMapToSelectedExtent")}; globalThis.fitExportMapToSelectedExtent = fitExportMapToSelectedExtent;`,
  fitContext
);
fitContext.fitExportMapToSelectedExtent(mapInstance);
assert.equal(fittedBounds, townBounds);
assert.ok(fittedOptions.paddingTopLeft[0] > 0);
assert.ok(fittedOptions.paddingTopLeft[1] > fittedOptions.paddingBottomRight[1]);
assert.equal(fittedOptions.animate, false);

console.log("North Wildwood export layout checks passed");
