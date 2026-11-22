#!/usr/bin/env node
import { readAppSource } from './app_source.mjs';

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";


const here = path.dirname(fileURLToPath(import.meta.url));
const source = readAppSource(path.join(here, "..", "index.html"));

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

assert.match(source, /id="openDownloadModalBtn"[^>]*>Export Map<\/button>/);
assert.doesNotMatch(source, /<h3>Create Shareable Map<\/h3>/);
assert.doesNotMatch(source, /id="downloadLaunchMeta"/);
assert.match(source, /<h3 id="downloadModalTitle">Export map<\/h3>/);
const layoutControl = source.match(/<div id="downloadAspectControl"[^>]*>[\s\S]*?<\/div>/)?.[0];
assert.ok(layoutControl, "Export layout controls must be present");
assert.match(layoutControl, /--seg-cols:4/);
assert.deepEqual([...layoutControl.matchAll(/data-aspect="([^"]+)"/g)].map(match => match[1]),
  ["viewport", "16:9", "9:16", "1:1"]);
assert.match(source, /data-extent="town"[^>]+>Fill North Wildwood<\/button>/);
assert.match(source, /pngWidth: 2160, pngHeight: 3840/);
assert.match(source, /id="north-wildwood-export-device-layout"/);
assert.match(source, /#downloadModal #downloadAspectControl\{\s*grid-template-columns:repeat\(2,minmax\(0,1fr\)\) !important/);
assert.match(source, /compactTouchLayout[\s\S]+downloadModalCloseBtn[\s\S]+preventScroll: true/);

const storyBase = {
  value: "9:16",
  width: 1350,
  height: 2400,
  pngWidth: 2160,
  pngHeight: 3840,
  label: "Story 9:16",
};
const viewport = { value: "viewport", width: 1280, height: 960 };
const hiddenAspect = { value: "9:16" };
const aspectContext = vm.createContext({
  EXPORT_GIF_ASPECTS: { "9:16": storyBase },
  document: { getElementById: () => hiddenAspect, querySelector: () => null },
  getExportViewportAspect: () => viewport,
  getDownloadFormatValue: () => "png",
});
vm.runInContext(
  `${extractFunction("getDownloadAspectValue")}; ${extractFunction("getExportAspectConfig")}`,
  aspectContext
);
const pngAspect = aspectContext.getExportAspectConfig();
assert.equal(pngAspect.width, 2160);
assert.equal(pngAspect.height, 3840);
assert.equal(pngAspect.resolutionLabel, "2160 × 3840");
aspectContext.getDownloadFormatValue = () => "gif";
const gifAspect = aspectContext.getExportAspectConfig();
assert.equal(gifAspect.width, 1350);
assert.equal(gifAspect.height, 2400);
assert.equal(gifAspect.resolutionLabel, "1350 × 2400");
assert.equal(aspectContext.getExportAspectConfig("4:5"), viewport);
hiddenAspect.value = "4:5";
assert.equal(aspectContext.getExportAspectConfig(), viewport);
assert.equal(hiddenAspect.value, "viewport");

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
assert.equal(fittedOptions.paddingTopLeft[1], fittedOptions.paddingBottomRight[1], "Footer branding no longer needs excessive map top padding");
assert.equal(fittedOptions.animate, false);

console.log("North Wildwood export layout checks passed");
