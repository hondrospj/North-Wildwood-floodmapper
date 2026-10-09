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

// Only the resolved depth frame's green pixels may replace stage colors.
vm.runInContext(`${extractFunction("isDisconnectedRasterPixel")}; ${extractFunction("applyStageUncertaintyPixels")}`, context);
const stagePixels = new Uint8ClampedArray([
  244,167,66,225, 231,76,60,225, 125,60,152,225, 0,0,0,0, 244,167,66,225
]);
const depthPixels = new Uint8ClampedArray([
  99,212,113,200, 99,212,113,0, 27,183,245,255, 99,212,113,225, 125,249,255,225
]);
assert.equal(context.applyStageUncertaintyPixels(depthPixels, stagePixels), 2);
assert.deepEqual(Array.from(stagePixels), [
  99,212,113,200, 231,76,60,225, 125,60,152,225, 99,212,113,225, 244,167,66,225
]);
assert.throws(() => context.applyStageUncertaintyPixels(depthPixels, new Uint8ClampedArray(4)), /sizes do not match/);

// Exercise the asynchronous renderer: same stage, different frame identity;
// unavailable/mismatched depth must not silently become a certainty-only map.
let serial = 0, releaseCount = 0, maskLoads = 0;
const rendered = new Map();
const retired = [];
const masks = new Map([
  ['mask-a', {naturalWidth:1, naturalHeight:1, pixels:new Uint8ClampedArray([99,212,113,225])}],
  ['mask-b', {naturalWidth:1, naturalHeight:1, pixels:new Uint8ClampedArray([27,183,245,225])}],
  ['wrong-grid', {naturalWidth:2, naturalHeight:1}]
]);
context.bathtubStageOverlayCache = new Map();
context.stageToCode = stage => String(stage);
context.retainRasterObjectUrl = () => () => { releaseCount++; };
context.retireRasterObjectUrl = url => retired.push(url);
context.getDepthQueryGrid = async () => ({width:1,height:1,values:new Uint8ClampedArray(encodeGround(3))});
context.getDrainageRasterImage = async url => { maskLoads++; return masks.get(url) || null; };
context.console = {warn:() => {}};
context.document = {createElement: () => {
  const canvas = {};
  canvas.getContext = () => ({
    createImageData: () => ({data:new Uint8ClampedArray(4)}),
    drawImage: image => {canvas.depth = image.pixels;},
    getImageData: () => ({data:canvas.depth}),
    putImageData: image => {canvas.result = Array.from(image.data);}
  });
  return canvas;
}};
context.canvasToDrainageObjectUrl = async canvas => {
  const url = `blob:test-${++serial}`;
  rendered.set(url, canvas.result);
  return url;
};
vm.runInContext(`${extractFunction("cacheBathtubStageOverlay")}; async ${extractFunction("getBathtubStageOverlayRecord")}`, context);
const a = await context.getBathtubStageOverlayRecord(5, {url:'mask-a'});
const aAgain = await context.getBathtubStageOverlayRecord(5, {url:'mask-a'});
const b = await context.getBathtubStageOverlayRecord(5, {url:'mask-b'});
assert.equal(a.url, aAgain.url);
assert.notEqual(a.url, b.url, 'Different depth frames at one water level cannot share a mask');
assert.equal(maskLoads, 2, 'Reusing a rendered frame must not decode its mask again');
assert.deepEqual(rendered.get(a.url), [99,212,113,225]);
assert.deepEqual(rendered.get(b.url), [244,167,66,225], 'Connected depth water keeps its original stage color');
assert.equal(await context.getBathtubStageOverlayRecord(5, {url:'wrong-grid'}), null);
assert.equal(await context.getBathtubStageOverlayRecord(5, {url:'missing'}), null);
assert.equal(releaseCount, 4, 'Release retained depth images on success and failure');
const noMask = await context.getBathtubStageOverlayRecord(5);
assert.deepEqual(rendered.get(noMask.url), [244,167,66,225], 'Physics frames must not invent green areas');
let finishGrid;
context.getDepthQueryGrid = () => new Promise(resolve => {finishGrid = resolve;});
const stale = context.getBathtubStageOverlayRecord(6, {url:'mask-a'});
context.bathtubStageOverlayCache = new Map();
finishGrid({width:1,height:1,values:new Uint8ClampedArray(encodeGround(3))});
assert.equal(await stale, null, 'Reload must discard in-flight old frames');
assert.equal(context.bathtubStageOverlayCache.size, 0);
assert.ok(retired.length);
// The stage path must use the fully resolved depth frame and preserve time/history.
const requestLog = [];
let physicsFrame = null, depthAvailable = true;
const routing = vm.createContext({
  currentRawSeriesHours: [],
  getPhysicsAssetForEntry: () => physicsFrame,
  getPhysicsDisplayRecord: asset => asset?.visible,
  getOverlayRecord: async (...args) => {requestLog.push(args); return depthAvailable ? {url:'base'} : null;},
  getFillingInterpolatedOverlayRecord: async (...args) => {requestLog.push(args); return {url:'resolved-depth'};},
  retainRasterObjectUrl: () => () => {},
  getDrainageRetentionMilestones: () => [],
  getBathtubStageOverlayRecord: async (stage, depth) => ({stage, depth})
});
vm.runInContext(`async ${extractFunction("getHydraulicOverlayRecord")}`, routing);
const entry = {timeUtc:'2026-10-09T18:00:00Z'};
const history = [entry];
const routed = await routing.getHydraulicOverlayRecord('dynamic', 5, 'filling', entry, history);
assert.equal(routed.depth.url, 'resolved-depth');
assert.deepEqual(requestLog[0], ['depth',5,'filling']);
assert.equal(requestLog[1][3], entry);
depthAvailable = false;
assert.equal(await routing.getHydraulicOverlayRecord('dynamic', 5, 'draining', entry, history), null);
physicsFrame = {visible:{url:'physics-depth'}};
const callsBeforePhysics = requestLog.length;
const physicsStage = await routing.getHydraulicOverlayRecord('dynamic', 5, 'filling', entry, history);
assert.equal(physicsStage.depth, undefined);
assert.equal(requestLog.length, callsBeforePhysics, 'Do not substitute static uncertainty for physics depth');
console.log("North Wildwood stage colors, uncertainty mask, frame cache, failures, and reload checks passed");
