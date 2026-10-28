#!/usr/bin/env node
// Enforce the source extraction contract and narrowly approved presentation
// changes. Original hashes remain independent of the build and UI audit code.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = process.env.NWW_PARITY_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = relative => fs.readFileSync(localPath(relative), "utf8");
const sha256 = source => createHash("sha256").update(source).digest("hex");
const baseline = JSON.parse(read("tools/fixtures/north-wildwood-refactor-baseline.json"));
const manifest = JSON.parse(read("tools/app/manifest.json"));
const FRAME_REUSE_AUDIT_PATH = "tools/fixtures/north-wildwood-20261028-export-frame-reuse.json";
const FRAME_REUSE_AUDIT_SHA256 = "9797c14583eafc9374f5070820b2428f0108c67af7a8055466e364c90feefe32";
const frameReuseText = read(FRAME_REUSE_AUDIT_PATH);
assert.equal(sha256(frameReuseText), FRAME_REUSE_AUDIT_SHA256,
  "The export frame-reuse follow-up must retain its exact separately reviewed inverse");
const frameReuseAudit = JSON.parse(frameReuseText);
assert.equal(frameReuseAudit.schemaVersion, 1);
assert.equal(frameReuseAudit.baselineCommit, "a83b6f37af3e38ac783cf2c4004636ea12f2f321");
assert.deepEqual(frameReuseAudit.files.map(file => file.source), ["tools/app/runtime/16-export-map.js"],
  "The frame-reuse inverse may change only its export flood-layer source");
assert.deepEqual([...new Set(frameReuseAudit.changes.map(block => block.source))],
  frameReuseAudit.files.map(file => file.source));
assert.equal(new Set(frameReuseAudit.changes.map(block => block.id)).size, frameReuseAudit.changes.length);
for (const block of frameReuseAudit.changes) {
  assert.equal(block.kind, "script");
  assert.equal(block.entryId, "script-004");
}
for (const file of frameReuseAudit.files) auditedFrameReuseRead(file.source);
const PLACEMENT_AUDIT_PATH = "tools/fixtures/north-wildwood-20261028-road-label-placement.json";
const PLACEMENT_AUDIT_SHA256 = "c7d2b5ccd52fffcb72a6fcdab672c24941cb676a22d4c5fc3d3bd76a46f0e0f0";
const placementText = read(PLACEMENT_AUDIT_PATH);
assert.equal(sha256(placementText), PLACEMENT_AUDIT_SHA256,
  "The road-label placement follow-up must retain its exact separately reviewed inverse");
const placementAudit = JSON.parse(placementText);
assert.equal(placementAudit.schemaVersion, 1);
assert.equal(placementAudit.baselineCommit, "fb3561293cba61054c80d587cb6ece63ec05c881");
assert.deepEqual(placementAudit.files.map(file => file.source), [
  "assets/export-road-labels.js", "tools/app/index.template.html"
], "The placement follow-up may change only the label layout and dependency cache version");
assert.deepEqual([...new Set(placementAudit.changes.map(block => block.source))],
  placementAudit.files.map(file => file.source));
assert.equal(new Set(placementAudit.changes.map(block => block.id)).size, placementAudit.changes.length);
const activeRoadLabelTag = placementAudit.afterScriptTag;
for (const file of placementAudit.files) auditedPlacementRead(file.source);
const ROAD_LABEL_AUDIT_PATH = "tools/fixtures/north-wildwood-20261028-export-road-labels.json";
const ROAD_LABEL_AUDIT_SHA256 = "d132d4886f946fc8ad6a0cf4c052b56249f7bbc346afce6e6d266bdd12f871c0";
const roadLabelText = read(ROAD_LABEL_AUDIT_PATH);
assert.equal(sha256(roadLabelText), ROAD_LABEL_AUDIT_SHA256,
  "The export road-label audit must retain its exact reviewed inverse fragments");
const roadLabelAudit = JSON.parse(roadLabelText);
assert.equal(roadLabelAudit.schemaVersion, 1);
assert.equal(roadLabelAudit.baselineCommit, "f75b03edb4af59d6001e089d28bf22cd14077a23");
assert.deepEqual(roadLabelAudit.files.map(file => file.source), [
  "tools/app/runtime/10-map-geometry-and-layers.js",
  "tools/app/runtime/16-export-map.js",
  "tools/app/runtime/17-export-encoding.js",
  "tools/app/index.template.html"
], "The road-label inverse may cover only its three export integration sources, dependency insertion and attribution");
const ROAD_LABEL_FUNCTIONS = new Map([
  ["tools/app/runtime/10-map-geometry-and-layers.js", ["createRoadLabelLayer"]],
  ["tools/app/runtime/16-export-map.js", ["ensureExportMap", "updateExportRoadLayerAppearance", "prepareExportRoadNames", "prepareExportFrame"]],
  ["tools/app/runtime/17-export-encoding.js", ["captureFastGifBaseCanvas"]]
]);
const ROAD_LABEL_ATTRIBUTION_BEFORE = "Map: Esri, HERE, Garmin, USGS, &copy; OpenStreetMap contributors";
const ROAD_LABEL_ATTRIBUTION_AFTER = ROAD_LABEL_ATTRIBUTION_BEFORE + " · Local road names: NJOGIS";
assert.equal(new Set(roadLabelAudit.changes.map(block => block.id)).size, roadLabelAudit.changes.length);
assert.deepEqual([...new Set(roadLabelAudit.changes.map(block => block.source))],
  roadLabelAudit.files.map(file => file.source), "Every road-label diff must remain in its declared source");
for (const block of roadLabelAudit.changes) {
  const isRuntime = ROAD_LABEL_FUNCTIONS.has(block.source);
  assert.equal(block.kind, isRuntime ? "script" : "template");
  assert.equal(block.entryId, isRuntime ? "script-004" : null);
}
assert.equal(roadLabelAudit.module.source, "assets/export-road-labels.js");
assert.equal(roadLabelAudit.data.source, "assets/roads/north-wildwood-road-centerlines.geojson");
for (const asset of [roadLabelAudit.module, roadLabelAudit.data]) {
  const source = auditedPlacementRead(asset.source);
  assert.equal(Buffer.byteLength(source), asset.bytes, `${asset.source} must retain its reviewed byte count`);
  assert.equal(sha256(source), asset.sha256, `${asset.source} changed outside the reviewed road-label implementation`);
}
new vm.Script(read(roadLabelAudit.module.source), { filename: roadLabelAudit.module.source });
for (const file of roadLabelAudit.files) auditedRoadLabelRead(file.source);
const LINE_FIX_AUDIT_PATH = "tools/fixtures/north-wildwood-20261027-line-fixes.json";
const LINE_FIX_AUDIT_SHA256 = "ee105b3ca7ed357c43efa95805fd9c17705b15e6b26dd379e9bb919a147aa615";
const lineFixText = read(LINE_FIX_AUDIT_PATH);
assert.equal(sha256(lineFixText), LINE_FIX_AUDIT_SHA256,
  "The October 27 fixes must retain their exact independently reviewed inverse fragments");
const lineFixAudit = JSON.parse(lineFixText);
assert.equal(lineFixAudit.schemaVersion, 1);
assert.equal(lineFixAudit.baselineCommit, "4177f020ec58213dff42f41a1df6d06ce5829c5f");
assert.equal(new Set(lineFixAudit.files.map(file => file.source)).size, lineFixAudit.files.length);
for (const file of lineFixAudit.files) auditedLineRead(file.source);
const HOLISTIC_FIX_AUDIT_PATH = "tools/fixtures/north-wildwood-20261026-holistic-fixes.json";
const holisticFixText = read(HOLISTIC_FIX_AUDIT_PATH);
assert.equal(sha256(holisticFixText), "359b8237b258a4e5dfbbc966e1729c0359bdfd9cac458ee09eb5fdefc63811a3",
  "The holistic fixes must retain their exact reviewed inverse fragments");
const holisticFixAudit = JSON.parse(holisticFixText);
assert.equal(holisticFixAudit.schemaVersion, 1);
assert.equal(holisticFixAudit.baselineCommit, "075b294431f5bf57542a2c8850ef7b2d26320766");
const template = read("tools/app/index.template.html");
const published = read("index.html");
const previewUi = JSON.parse(read("tools/fixtures/north-wildwood-export-preview-ui.json"));
const previewSource = auditedHolisticRead(previewUi.source);
const exportPresentation = JSON.parse(read("tools/fixtures/north-wildwood-export-presentation.json"));
const boundaryStartup = JSON.parse(read("tools/fixtures/north-wildwood-boundary-startup.json"));
const paneStartup = JSON.parse(read("tools/fixtures/north-wildwood-pane-startup.json"));
const uiStartup = JSON.parse(read("tools/fixtures/north-wildwood-ui-startup.json"));
const viewPillSurface = JSON.parse(read("tools/fixtures/north-wildwood-view-pill-surface.json"));
const loaderRestore = JSON.parse(read("tools/fixtures/north-wildwood-loader-restore.json"));
const BUG_FIX_AUDIT_PATH = "tools/fixtures/north-wildwood-20261026-bug-fixes.json";
const BUG_FIX_AUDIT_SHA256 = "06b82915a30c6d163e0369f274198693841d5ad2c1b1c93b51f7f3da37d57e69";
const bugFixAuditText = read(BUG_FIX_AUDIT_PATH);
assert.equal(sha256(bugFixAuditText), BUG_FIX_AUDIT_SHA256,
  "The October 26 fixes must retain their exact independently reviewed inverse fragments");
const bugFixAudit = JSON.parse(bugFixAuditText);
assert.equal(bugFixAudit.schemaVersion, 1);
assert.equal(bugFixAudit.baselineCommit, "de65f0db910cb8511d9911b7c1b60adf4ce9805b");
const sourcePaths = new Set();
const outputs = new Map();
const entriesByToken = new Map();
const scriptEntriesById = new Map();
const styleBundlesById = new Map();
const styleEntries = [];
const scriptEntries = [];
let compiled = 0;

// Audited exception: preserve an unchanged month Text node during WebKit's
// held-click tracking. Inverse ONLY this exact change for original-hash checks;
// the original baseline fixture, DOM and all other JavaScript stay pinned.
const MONTH_LABEL_SOURCE = "tools/app/runtime/22-calendar-and-modes.js";
const MONTH_LABEL_BEFORE = `    async function renderCalendar() {
      if (!observedData || !currentMonthKey) return;
      document.getElementById("monthLabel").textContent = prettyMonthShort(currentMonthKey);`;
const MONTH_LABEL_GUARD = "      if (monthLabel.textContent !== monthText) monthLabel.textContent = monthText;";
const MONTH_LABEL_AFTER = `    async function renderCalendar() {
      if (!observedData || !currentMonthKey) return;
      const monthLabel = document.getElementById("monthLabel");
      const monthText = prettyMonthShort(currentMonthKey);
${MONTH_LABEL_GUARD}`;
const PREVIEW_TAG_BEFORE = '<script defer src="assets/export-preview.js?v=20261023-2" id="floodmapper-export-preview"></script>';
const PREVIEW_TAG_AFTER = '<script defer src="assets/export-preview.js?v=20261023-gesture1" id="floodmapper-export-preview"></script>';

// The requested common UI family is an independent, first-loaded stylesheet.
// Invert only its exact head insertion for original-document checks. All
// original inline declarations, layout rules and dependency order stay pinned.
const FONT_FAMILY_SOURCE = "assets/north-wildwood-font.css";
const FONT_FAMILY_TAG = '<link rel="stylesheet" href="./assets/north-wildwood-font.css?v=20261026-1">';
const FONT_FAMILY_SHA256 = "40ae82d038de6c6dfc928c259c6ab276de4112dde733590f5462718ba8480b15";

function auditedFontFamilyTemplate(source, label) {
  assert.equal(source.split(FONT_FAMILY_TAG).length - 1, 1,
    `${label} must include the exact font-family stylesheet once`);
  const insertion = `<head>\n${FONT_FAMILY_TAG}\n`;
  assert.equal(source.split(insertion).length - 1, 1,
    `${label} must load the font-family stylesheet before every original head dependency`);
  return source.replace(insertion, "<head>\n");
}

function auditFontFamilyStylesheet() {
  const source = read(FONT_FAMILY_SOURCE);
  assert.equal(sha256(source), FONT_FAMILY_SHA256,
    "The common-family stylesheet must retain its exact reviewed content");
  // Review its narrow declaration scope independently of the content hash.
  // One outer layer may contain ordinary rules only; nested rules, imports,
  // scripts and changes to size/weight/geometry are not part of this exception.
  const css = source.replace(/\/\*[\s\S]*?\*\//g, "").trim();
  const layer = css.match(/^@layer\s+([\w-]+)\s*\{([\s\S]*)\}$/);
  assert.ok(layer, "The font-family stylesheet must contain one named cascade layer");
  assert.equal(layer[1], "north-wildwood-font", "The reviewed first cascade layer must retain its name");
  assert.doesNotMatch(layer[2], /@/, "The font-family layer may not import or nest additional at-rules");
  let rules = 0;
  const residue = layer[2].replace(/([^{}]+)\{([^{}]*)\}/g, (full, selector, declarations) => {
    assert.ok(selector.trim(), "Every font-family rule needs a selector");
    const entries = declarations.split(";").map(value => value.trim()).filter(Boolean);
    assert.ok(entries.length, "Every font-family rule needs a declaration");
    for (const declaration of entries) {
      const match = declaration.match(/^(font-family|--nww-ui-font-family)\s*:\s*([^{};]+)$/);
      assert.ok(match, `The font-family exception may not alter another property: ${declaration}`);
      assert.doesNotMatch(match[2], /(?:url\s*\(|expression\s*\()/i,
        "The font-family exception must use only the reviewed local font stack");
    }
    rules += 1;
    return "";
  });
  assert.ok(rules > 0, "The font-family layer must contain reviewed rules");
  assert.equal(residue.trim(), "", "The font-family layer may contain only ordinary declaration rules");
}

// User-requested export readability changes are pinned by exact output hashes.
// Restore ONLY these named presentation functions and the footer stylesheet
// before checking the original full-block hashes. No runtime/science block is
// exempted, and the original template, source ordering and fixture stay intact.
const EXPORT_PRESENTATION_BLOCKS = [
  ["script", "script-004", "tools/app/runtime/13-export-range.js", "getExportFooterLayout"],
  ["script", "script-004", "tools/app/runtime/13-export-range.js", "applyExportStageAspect"],
  ["script", "script-004", "tools/app/runtime/16-export-map.js", "updateExportLegend"],
  ["script", "script-004", "tools/app/runtime/16-export-map.js", "getExportFrameDateTimeText"],
  ["script", "script-004", "tools/app/runtime/16-export-map.js", "getExportTimestampRows"],
  ["style", "style-081", "tools/app/styles/style-081.css", null],
];

// The startup fix may seed only the existing authoritative town polygon and
// change the named boundary/startup functions. Invert those exact blocks for
// original extraction parity; every other runtime byte remains pinned.
const BOUNDARY_STARTUP_BLOCKS = [
  ["script", "script-004", "tools/app/runtime/00-configuration.js", "applyTownConfig", null],
  ["script", "script-004", "tools/app/runtime/06-inundation-catalog.js", "getBoundaryDrivenOverlayBounds", null],
  ["script", "script-004", "tools/app/runtime/10-map-geometry-and-layers.js", "seedMunicipalBoundary", null],
  ["script", "script-004", "tools/app/runtime/10-map-geometry-and-layers.js", "makeBoundaryVector", null],
  ["script", "script-004", "tools/app/runtime/10-map-geometry-and-layers.js", "updateBoundaryMaskLayer", null],
  ["script", "script-004", "tools/app/runtime/10-map-geometry-and-layers.js", "updateMunicipalBoundaryLayer", null],
  ["script", "script-004", "tools/app/runtime/10-map-geometry-and-layers.js", "loadMunicipalBoundary", null],
  ["script", "script-004", "tools/app/runtime/10-map-geometry-and-layers.js", "ensureMap", null],
  ["script", "script-004", "tools/app/runtime/28-tutorial-and-events.js", "main", null],
  ["script", "script-007", "tools/app/town-config.js", null, "TOWN_CONFIG.boundary.startupFeature"],
];

// Match the already finished pane geometry and labels on the first paint.
// Inverse only the exact insertion between these two adjacent desktop rules;
// never exempt the complete stylesheet, mobile rules or surrounding template.
const PANE_STARTUP_CSS_SOURCE = "tools/app/styles/style-002.css";
const PANE_STARTUP_CSS_START = '  html body[data-floodmapper-unified] #leftPanel,html body[data-floodmapper-unified] #rightRail {zoom:1!important;gap:6px!important;scrollbar-gutter:stable;}\n';
const PANE_STARTUP_CSS_END = '  html body[data-floodmapper-unified] #leftPanel>:is(.panel-card,#legendDock),html body[data-floodmapper-unified] #rightRail>.rail-card {flex:0 0 auto!important;}\n';
const PANE_STARTUP_LABELS = [
  ["forecast-range", "<h2>Forecast Type</h2>", "<h2>Forecast range</h2>"],
  ["forecast-low", '<button id="forecastLowBtn" type="button" data-scenario="lowEnd">Lower End</button>',
    '<button id="forecastLowBtn" type="button" data-scenario="lowEnd">Lower end</button>'],
  ["forecast-high", '<button id="forecastHighBtn" type="button" data-scenario="highEnd">Upper End</button>',
    '<button id="forecastHighBtn" type="button" data-scenario="highEnd">Upper end</button>'],
];

// Pin the original bytes of each small follow-up UI fragment independently.
// The separate fixture records its reviewed replacement; no complete sheet or
// template is exempted, and earlier pane/boundary audit data stays unchanged.
const UI_STARTUP_CSS = [
  ["timeline-loading-visibility", "93686531e77d96d337133d0edff6c5dd21c3c2bca6260cc0f8a194c52e32cb16"],
  ["desktop-initial-controls", "fc0541c68a25758233e5ec2e75e67527eafcf5e6b376419ae689f10643b4c1cb"],
  ["short-mobile-navigation", "2ce892ca4288e17a5dd7046969821d99e3a89a597413db9ba8dd6d09e5610446"],
];
const UI_STARTUP_TEMPLATE = [
  ["unused-town-title-logo", "ad362fef6a869e086ccd51bf3b547e9e97c43296d7ff51de83ae841a7080d65a"],
  ["initial-address-title", "02db0ce2c88589e1051b066056d5b7b29617094961a632ace328fbad05c478f3"],
  ["initial-address-placeholder", "176149a0a86cd7ce4d5803f08ea03f260b2581292b5e72667e1ea5549892c9ac"],
  ["initial-address-button", "a893d32da236b2b09058e31a03d607c046d3eb2327282b84eeed1969d8951f8f"],
  ["initial-tour-label", "93bbad53604ee546c7b4ccaf11b67789f11181ad2f46bb320c9c6c7cf5e2f057"],
  ["initial-play-icon", "fec1cce46ab6b3ca12409b013cc9ddd6b488b8a1f934386ac03dc817882a734a"],
  ["initial-timeline-placeholder", "e8489613e80da3a663d55187c3eec1fac3276f964bf109eda2c294c2d7ca0911"],
  ["initial-layer-order", "a28892f5f9d0767d7f782893d7d39526e5a30c9bf0b489dbc2da638801537e9b"],
];
const UI_STARTUP_SCRIPTS = [
  ["initial-top-tide-disclosure", "script", "script-004", "tools/app/runtime/19-observed-history.js",
    "fcc46015449c4bae27317d8bbc95e30deac6585d73520597151a392b75d57304"],
];
const VIEW_PILL_SURFACE_BLOCKS = [
  ["mode-pill-opacity", "288e57666bfc4eab9abdbb350ac5a97ce7ed1b275033718a1dd536a2ffc37c35"],
  ["opaque-selected-hover", "e42edca573f069062babf464909ac2ea8f5b80cfec16eb95d1807fcbd7775424"],
];
const LOADER_RESTORE_STYLES = [
  ["style", "style-072", "tools/app/styles/style-072.css", "fragment",
    "f2ec901ed64c3cd26224a680b4c403eaad149b9667829c43e691ae1b6eaebad9"],
  ["style", "style-074", "tools/app/styles/style-074.css", "whole-stylesheet",
    "06c0a8b90f8e9ce48babdb0b65edc5b6e99bb4545cf59c41bce124f03b46517b"],
];

function auditedUiStartupFragments(source, blocks, label) {
  for (const block of blocks) {
    assert.ok(block.afterSource.length > 0, `${block.id} must use a nonempty exact fragment`);
    assert.equal(Buffer.byteLength(block.afterSource), block.afterBytes, `${block.id} approved fragment length changed`);
    assert.equal(sha256(block.afterSource), block.afterSha256, `${block.id} approved fragment hash changed`);
    assert.equal(source.split(block.afterSource).length - 1, 1, `${label} ${block.id} must occur exactly once`);
    source = source.replace(block.afterSource, block.beforeSource);
  }
  return source;
}

function auditedUiStartupSource(kind, entry, source) {
  if (kind === "style" && entry.id === "style-002") {
    assert.ok(entry.sources.includes(uiStartup.cssSource), "Startup UI CSS must remain in its declared stylesheet");
    auditedUiStartupFragments(read(uiStartup.cssSource), uiStartup.cssChanges, "Source");
    source = auditedUiStartupFragments(source, uiStartup.cssChanges, "Stylesheet");
  }
  for (const block of uiStartup.scriptChanges.filter(block => block.kind === kind && block.entryId === entry.id)) {
    assert.ok(entry.sources.includes(block.source), `${block.id} must remain in its declared runtime source`);
    auditedUiStartupFragments(auditedHolisticRead(block.source), [block], "Source");
    source = auditedUiStartupFragments(source, [block], "Runtime");
  }
  return source;
}

function exactPaneStartupCss(source) {
  assert.equal(source.split(PANE_STARTUP_CSS_START).length - 1, 1, "The pane startup CSS start anchor must occur once");
  assert.equal(source.split(PANE_STARTUP_CSS_END).length - 1, 1, "The pane startup CSS end anchor must occur once");
  const start = source.indexOf(PANE_STARTUP_CSS_START);
  const end = source.indexOf(PANE_STARTUP_CSS_END);
  assert.ok(end >= start + PANE_STARTUP_CSS_START.length, "Pane startup CSS anchors must retain their original order");
  return source.slice(start, end + PANE_STARTUP_CSS_END.length);
}

function auditedPaneStartupSource(kind, entry, source) {
  if (kind !== "style" || entry.id !== "style-002") return source;
  const block = paneStartup.css;
  assert.ok(entry.sources.includes(block.source), "Pane startup CSS must stay in its declared stylesheet");
  const actual = exactPaneStartupCss(auditedHolisticRead(block.source));
  assert.equal(Buffer.byteLength(actual), block.afterBytes, "Pane startup CSS differs from the exact reviewed insertion");
  assert.equal(sha256(actual), block.afterSha256, "Pane startup CSS differs from the exact reviewed insertion");
  assert.equal(exactPaneStartupCss(source), actual, "Pane startup CSS must remain unchanged in the generated source");
  return source.replace(actual, block.beforeSource);
}

function auditedPaneStartupTemplate(source) {
  for (const block of paneStartup.labels) {
    assert.equal(source.split(block.afterSource).length - 1, 1, `${block.id} label must occur exactly once`);
    assert.equal(Buffer.byteLength(block.afterSource), block.afterBytes, `${block.id} label byte count changed`);
    assert.equal(sha256(block.afterSource), block.afterSha256, `${block.id} label differs from the reviewed text`);
    source = source.replace(block.afterSource, block.beforeSource);
  }
  return source;
}

function exactBoundaryStartupBlock(source, block, label) {
  const expression = block.function
    ? new RegExp(`^    (?:async )?function ${block.function}\\([^]*?\\n    }\\n${block.function === "seedMunicipalBoundary" ? "\\n" : ""}`, "gm")
    : /^TOWN_CONFIG\.boundary\.startupFeature = [^\n]+;\n/gm;
  const matches = Array.from(source.matchAll(expression));
  assert.equal(matches.length, 1, `${label} must occur exactly once`);
  return matches[0][0];
}

function auditedBoundaryStartupSource(kind, entry, source) {
  for (const block of boundaryStartup.blocks.filter(block => block.kind === kind && block.entryId === entry.id)) {
    const label = block.function || block.assignment;
    assert.ok(entry.sources.includes(block.source), `${label} must remain in its declared source`);
    const actual = exactBoundaryStartupBlock(auditedHolisticRead(block.source), block, label);
    assert.equal(Buffer.byteLength(actual), block.afterBytes, `${label} differs from the approved boundary startup change`);
    assert.equal(sha256(actual), block.afterSha256, `${label} differs from the approved boundary startup change`);
    if (block.function === "seedMunicipalBoundary" || block.assignment) {
      assert.equal(block.beforeSource, "", `${label} must be a new-only audited block`);
    } else {
      assert.equal(exactBoundaryStartupBlock(block.beforeSource, block, `Original ${label}`), block.beforeSource,
        `${label} audit must restore exactly its original function`);
    }
    assert.equal(exactBoundaryStartupBlock(source, block, `Runtime ${label}`), actual,
      `${label} must remain unchanged between source and runtime`);
    if (block.assignment) {
      const prefix = `${block.assignment} = `;
      assert.ok(actual.startsWith(prefix) && actual.endsWith(";\n"));
      assert.deepEqual(JSON.parse(actual.slice(prefix.length, -2)), JSON.parse(read(boundaryStartup.featureSource)),
        "The startup feature must reproduce the existing authoritative boundary exactly");
    }
    source = source.replace(actual, block.beforeSource);
  }
  return source;
}

function exactPresentationBlock(source, name, label) {
  if (name === null) return source;
  const matches = Array.from(source.matchAll(new RegExp(`^    function ${name}\\([^]*?\\n    }\\n`, "gm")));
  assert.equal(matches.length, 1, `${label} must occur exactly once`);
  return matches[0][0];
}

function auditedExportPresentationSource(kind, entry, source) {
  for (const block of exportPresentation.blocks.filter(block => block.kind === kind && block.entryId === entry.id)) {
    const label = block.function || block.source;
    assert.ok(entry.sources.includes(block.source), `${label} must remain in its declared source`);
    const restoredSource = auditedIssueFixFragments(auditedHolisticRead(block.source),
      bugFixAudit.changes.filter(change => change.source === block.source), "Presentation source");
    const actual = exactPresentationBlock(restoredSource, block.function, label);
    assert.equal(Buffer.byteLength(actual), block.afterBytes, `${label} differs from the approved presentation change`);
    assert.equal(sha256(actual), block.afterSha256, `${label} differs from the approved presentation change`);
    assert.equal(exactPresentationBlock(block.beforeSource, block.function, `Original ${label}`), block.beforeSource,
      `${label} audit must restore exactly its original presentation block`);
    if (block.function === null) {
      assert.equal(source, actual, `${label} must remain the complete declared stylesheet`);
      source = block.beforeSource;
    } else {
      assert.equal(exactPresentationBlock(source, block.function, `Runtime ${label}`), actual,
        `${label} must remain unchanged between source and runtime`);
      source = source.replace(actual, block.beforeSource);
    }
  }
  return source;
}

// User-requested correctness fixes have a separate exact-fragment inverse.
// Restore only those reviewed diffs, then apply every earlier audit and the
// original immutable extraction hashes. No source block is exempted wholesale.
function auditedIssueFixFragments(source, blocks, label) {
  for (const block of blocks) {
    assert.ok(block.beforeSource && block.afterSource, `${block.id} must retain nonempty context`);
    assert.equal(sha256(block.beforeSource), block.beforeSha256, `${block.id} original fragment changed`);
    assert.equal(sha256(block.afterSource), block.afterSha256, `${block.id} fixed fragment changed`);
    assert.equal(source.split(block.afterSource).length - 1, 1, `${label} ${block.id} must occur exactly once`);
    source = source.replace(block.afterSource, block.beforeSource);
  }
  return source;
}

function auditedHolisticRead(relative) {
  const blocks = [...holisticFixAudit.changes, ...holisticFixAudit.externalChanges].filter(block => block.source === relative);
  return auditedIssueFixFragments(auditedLineRead(relative), blocks, relative);
}

// Reusing an owned, ready export image is a separate runtime-only follow-up.
// Invert its exact contextual diff before the unchanged feature/placement
// audits, and prove that all neighboring rendering and scientific code stays
// identical to the independently pinned application baseline.
function auditedFrameReuseRead(relative) {
  const source = read(relative);
  const blocks = frameReuseAudit.changes.filter(block => block.source === relative);
  const restored = auditedIssueFixFragments(source, blocks, relative);
  const file = frameReuseAudit.files.find(file => file.source === relative);
  if (file) {
    assert.equal(sha256(source), file.afterSha256, `${relative} changed outside its exact frame-reuse follow-up`);
    assert.equal(sha256(restored), file.beforeSha256, `${relative} must restore every pre-frame-reuse byte`);
    const strip = text => {
      const expression = /^    async function setExportFloodLayer\([^]*?^    }\n\n?/gm;
      assert.equal([...text.matchAll(expression)].length, 1, "Frame reuse must retain one export flood-layer setter");
      return text.replace(expression, "");
    };
    assert.equal(strip(source), strip(restored), "Frame reuse may alter only setExportFloodLayer()");
  }
  return restored;
}

function auditedFrameReuseSource(kind, entry, source) {
  const blocks = frameReuseAudit.changes.filter(block => block.kind === kind && block.entryId === entry.id);
  for (const block of blocks) {
    assert.ok(entry.sources.includes(block.source), `${block.id} must remain in its declared export runtime source`);
    auditedFrameReuseRead(block.source);
  }
  return auditedIssueFixFragments(source, blocks, entry.id);
}

// Preserve the first feature audit unchanged. The hosted-font follow-up can
// alter only layout() and its content-derived script version before that audit
// checks every original integration and asset byte.
function auditedPlacementRead(relative) {
  const source = auditedFrameReuseRead(relative);
  const blocks = placementAudit.changes.filter(block => block.source === relative);
  const restored = auditedIssueFixFragments(source, blocks, relative);
  const file = placementAudit.files.find(file => file.source === relative);
  if (file) {
    assert.equal(sha256(source), file.afterSha256, `${relative} changed outside its exact placement follow-up`);
    assert.equal(sha256(restored), file.beforeSha256, `${relative} must restore every first-feature byte`);
    if (relative === "assets/export-road-labels.js") {
      const strip = text => {
        const expression = /^  function layout\([^]*?^  }\n\n?/gm;
        assert.equal([...text.matchAll(expression)].length, 1, "The placement follow-up must retain one layout function");
        return text.replace(expression, "");
      };
      assert.equal(strip(source), strip(restored), "The placement follow-up may alter only layout()");
    } else {
      assert.equal(source.split(placementAudit.afterScriptTag).length - 1, 1,
        "The placement dependency must occur once");
      assert.equal(source.replace(placementAudit.afterScriptTag, placementAudit.beforeScriptTag), restored,
        "The placement template follow-up may alter only the road-label cache version");
    }
  }
  return restored;
}

function auditedPlacementDocument(source, label) {
  assert.equal(source.split(activeRoadLabelTag).length - 1, 1, `${label} must include the current road-label dependency once`);
  return source.replace(activeRoadLabelTag, placementAudit.beforeScriptTag);
}

// The October 28 export label change is inverted before every earlier audit.
// Full-file hashes bound each contextual replacement to the reviewed diff;
// neither a whole runtime block nor a legacy fixture becomes exempt.
function auditedRoadLabelRead(relative) {
  const source = auditedPlacementRead(relative);
  const blocks = roadLabelAudit.changes.filter(block => block.source === relative);
  const restored = auditedIssueFixFragments(source, blocks, relative);
  const file = roadLabelAudit.files.find(file => file.source === relative);
  if (file) {
    assert.equal(sha256(source), file.afterSha256, `${relative} changed outside its exact road-label integration`);
    assert.equal(sha256(restored), file.beforeSha256, `${relative} must restore every pre-road-label byte`);
    const names = ROAD_LABEL_FUNCTIONS.get(relative);
    if (names) {
      const strip = (text, before) => {
        for (const name of names) {
          const expression = new RegExp(`^    (?:async )?function ${name}\\([^]*?^    }\\n\\n?`, "gm");
          const matches = [...text.matchAll(expression)];
          assert.equal(matches.length, before && name === "prepareExportRoadNames" ? 0 : 1,
            `${relative} ${name} must retain its reviewed function ownership`);
          text = text.replace(expression, "");
        }
        return text;
      };
      assert.equal(strip(source, false), strip(restored, true),
        `${relative} road labels may modify only the explicitly named export functions`);
    } else {
      assert.equal(source.split(ROAD_LABEL_ATTRIBUTION_AFTER).length - 1, 1,
        "The new local road-name source must appear once in export attribution");
      assert.equal(restored.split(ROAD_LABEL_ATTRIBUTION_BEFORE).length - 1, 1,
        "The original map attribution must be restored exactly once");
      assert.equal(source.replace(roadLabelAudit.scriptTag + "\n", "")
        .replace(ROAD_LABEL_ATTRIBUTION_AFTER, ROAD_LABEL_ATTRIBUTION_BEFORE), restored,
        "The road-label template change may add only its reviewed dependency and local-source credit");
    }
  }
  return restored;
}

function auditedRoadLabelSource(kind, entry, source) {
  const blocks = roadLabelAudit.changes.filter(block => block.kind === kind && block.entryId === entry.id);
  for (const block of blocks) {
    assert.ok(entry.sources.includes(block.source), `${block.id} must remain in its declared export integration source`);
    auditedRoadLabelRead(block.source);
  }
  return auditedIssueFixFragments(source, blocks, entry.id);
}

function auditedLineRead(relative) {
  const blocks = [...lineFixAudit.changes, ...lineFixAudit.externalChanges, ...lineFixAudit.templateChanges]
    .filter(block => block.source === relative);
  const source = auditedRoadLabelRead(relative);
  const restored = auditedIssueFixFragments(source, blocks, relative);
  const file = lineFixAudit.files.find(file => file.source === relative);
  if (file) {
    assert.equal(sha256(source), file.afterSha256, `${relative} changed outside its exact October 27 fixes`);
    assert.equal(sha256(restored), file.beforeSha256, `${relative} must restore every original byte`);
  }
  return restored;
}

function auditedLineSource(kind, entry, source) {
  const blocks = lineFixAudit.changes.filter(block => block.kind === kind && block.entryId === entry.id);
  for (const block of blocks) {
    assert.ok(entry.sources.includes(block.source), `${block.id} must remain in its declared source`);
    auditedLineRead(block.source);
  }
  return auditedIssueFixFragments(source, blocks, entry.id);
}

function auditedHolisticSource(kind, entry, source) {
  const blocks = holisticFixAudit.changes.filter(block => block.kind === kind && block.entryId === entry.id);
  for (const block of blocks) {
    assert.ok(entry.sources.includes(block.source), `${block.id} must remain in its declared source`);
    auditedIssueFixFragments(auditedLineRead(block.source), [block], "Holistic authoring source");
  }
  return auditedIssueFixFragments(source, blocks, entry.id);
}

function auditedIssueFixSource(kind, entry, source) {
  const blocks = bugFixAudit.changes.filter(block => block.kind === kind && block.entryId === entry.id);
  for (const block of blocks) {
    assert.ok(entry.sources.includes(block.source), `${block.id} must remain in its declared authoring source`);
    auditedIssueFixFragments(auditedHolisticRead(block.source), [block], "Authoring source");
  }
  return auditedIssueFixFragments(source, blocks, entry.id);
}

function auditedBaselineSource(kind, entry, source) {
  source = auditedFrameReuseSource(kind, entry, source);
  source = auditedRoadLabelSource(kind, entry, source);
  source = auditedLineSource(kind, entry, source);
  source = auditedHolisticSource(kind, entry, source);
  source = auditedIssueFixSource(kind, entry, source);
  for (const block of loaderRestore.styles.filter(block => block.kind === kind && block.entryId === entry.id)) {
    assert.ok(entry.sources.includes(block.source), `${entry.id} loader rules must stay in their declared source`);
    if (block.mode === "whole-stylesheet") {
      assert.deepEqual(entry.sources, [block.source], "The dedicated loader lifecycle block must not include another source");
      assert.equal(auditedHolisticRead(block.source), block.afterSource, "The loader lifecycle source differs from its exact reviewed block");
      assert.equal(Buffer.byteLength(source), block.afterBytes, "The loader lifecycle block length changed");
      assert.equal(sha256(source), block.afterSha256, "The loader lifecycle block changed outside the reviewed restoration");
      assert.equal(source, block.afterSource, "The generated loader lifecycle block must match its source");
      source = block.beforeSource;
    } else {
      auditedUiStartupFragments(auditedHolisticRead(block.source), [block], "Loader source");
      source = auditedUiStartupFragments(source, [block], "Loader stylesheet");
    }
  }
  if (kind === "style" && entry.id === "style-079") {
    assert.ok(entry.sources.includes(viewPillSurface.source), "View-pill surface rules must stay in their declared stylesheet");
    auditedUiStartupFragments(read(viewPillSurface.source), viewPillSurface.blocks, "View-pill source");
    source = auditedUiStartupFragments(source, viewPillSurface.blocks, "View-pill stylesheet");
  }
  source = auditedUiStartupSource(kind, entry, source);
  source = auditedPaneStartupSource(kind, entry, source);
  source = auditedBoundaryStartupSource(kind, entry, source);
  source = auditedExportPresentationSource(kind, entry, source);
  if (kind !== "script" || entry.id !== "script-004") return source;
  assert.ok(entry.sources.includes(MONTH_LABEL_SOURCE),
    "The audited month-label fix must remain in its declared runtime source");
  assert.equal(read(MONTH_LABEL_SOURCE).split(MONTH_LABEL_AFTER).length - 1, 1,
    "The exact audited month-label idempotence fix must occur once in its source");
  assert.equal(source.split(MONTH_LABEL_AFTER).length - 1, 1,
    "The exact audited month-label idempotence fix must occur once in the runtime");
  return source.replace(MONTH_LABEL_AFTER, MONTH_LABEL_BEFORE);
}

function localPath(relative) {
  assert.equal(typeof relative, "string", "Application paths must be strings");
  const resolved = path.resolve(ROOT, relative);
  const fromRoot = path.relative(ROOT, resolved);
  assert.ok(fromRoot && !fromRoot.startsWith("../") && !path.isAbsolute(fromRoot),
    `Application source escapes the repository: ${relative}`);
  return resolved;
}

function attributes(opening) {
  const result = new Map();
  const body = opening.replace(/^<\w+\b/, "").replace(/\/?\s*>$/, "");
  for (const match of body.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    const key = match[1].toLowerCase();
    assert.ok(!result.has(key), `Duplicate HTML attribute ${key}`);
    result.set(key, match[2] ?? match[3] ?? match[4] ?? "");
  }
  return result;
}

function referencedOutput(value, expectedOutput, content = read(expectedOutput)) {
  const url = new URL(value, "https://north-wildwood-parity.invalid/");
  assert.equal(url.origin, "https://north-wildwood-parity.invalid",
    "Extracted application sources must remain local");
  assert.equal(decodeURIComponent(url.pathname).replace(/^\//, ""), expectedOutput,
    "Generated tag points to the wrong output file");
  const version = url.searchParams.get("v");
  assert.ok(version && version.length >= 12 && sha256(content).startsWith(version),
    `${expectedOutput} must have a version derived from its exact content`);
  assert.equal(url.hash, "", "Extracted source references must not contain fragments");
}

function token(kind, id) {
  return `<!-- nww:${kind}:${id} -->`;
}

auditFontFamilyStylesheet();
auditedFontFamilyTemplate(published, "Generated HTML");
const roadLabelTag = roadLabelAudit.scriptTag;
assert.match(roadLabelTag, /^<script\b[^>]*><\/script>$/);
const roadLabelAttributes = attributes(roadLabelTag.slice(0, roadLabelTag.indexOf(">") + 1));
assert.equal(roadLabelAttributes.size, 2, "Export road labels may add only src and defer attributes");
assert.ok(roadLabelAttributes.has("defer"), "Export road labels must not block startup parsing");
referencedOutput(roadLabelAttributes.get("src"), roadLabelAudit.module.source, auditedPlacementRead(roadLabelAudit.module.source));
assert.equal(placementAudit.beforeScriptTag, roadLabelTag, "The placement follow-up must restore the original feature dependency");
assert.equal(placementAudit.afterScriptTag.replace(/\?v=[a-f0-9]+/, "?v=VERSION"),
  roadLabelTag.replace(/\?v=[a-f0-9]+/, "?v=VERSION"), "The placement dependency may change only its content cache version");
const placementAttributes = attributes(activeRoadLabelTag.slice(0, activeRoadLabelTag.indexOf(">") + 1));
referencedOutput(placementAttributes.get("src"), roadLabelAudit.module.source);
for (const [label, document] of [["Template", template], ["Published HTML", published]]) {
  assert.equal(auditedPlacementDocument(document, label).split(roadLabelTag).length - 1, 1,
    `${label} must include the reviewed export road-label dependency once`);
}
assert.equal(baseline.schemaVersion, 1);
assert.equal(manifest.version, 1);
assert.equal(manifest.baselineCommit, baseline.baselineCommit,
  "The extraction manifest must identify the audited pre-refactor commit");
assert.equal(previewUi.schemaVersion, 1);
assert.equal(exportPresentation.schemaVersion, 1);
assert.equal(exportPresentation.baselineCommit, "fe85848f68070189033fec66fe6fc3996df7cc4e");
assert.deepEqual(exportPresentation.blocks.map(block => [block.kind, block.entryId, block.source, block.function]),
  EXPORT_PRESENTATION_BLOCKS, "The export audit may cover only the explicitly approved presentation blocks");
assert.equal(boundaryStartup.schemaVersion, 1);
assert.equal(boundaryStartup.baselineCommit, "17c5ca1c73466e1860204d0906c65f306e902f8c");
assert.equal(boundaryStartup.featureSource, "Boundaries/North Wildwood.geojson");
assert.equal(sha256(read(boundaryStartup.featureSource)), boundaryStartup.featureSha256,
  "The embedded startup polygon must preserve the original authoritative boundary file");
assert.deepEqual(boundaryStartup.blocks.map(block =>
  [block.kind, block.entryId, block.source, block.function, block.assignment]), BOUNDARY_STARTUP_BLOCKS,
  "The boundary startup audit may cover only the explicitly approved blocks");
assert.equal(paneStartup.schemaVersion, 1);
assert.equal(paneStartup.baselineCommit, "a778676bff8b6b527e9a341b01639c10f7cff2bc");
assert.equal(paneStartup.css.kind, "style");
assert.equal(paneStartup.css.entryId, "style-002");
assert.equal(paneStartup.css.source, PANE_STARTUP_CSS_SOURCE);
assert.equal(paneStartup.css.beforeSource, PANE_STARTUP_CSS_START + PANE_STARTUP_CSS_END,
  "The pane audit must restore only the two originally adjacent desktop rules");
assert.equal(paneStartup.templateSource, "tools/app/index.template.html");
assert.deepEqual(paneStartup.labels.map(block => [block.id, block.beforeSource, block.afterSource]), PANE_STARTUP_LABELS,
  "The pane startup template audit may change only the three labels already used by the finished interface");
assert.equal(uiStartup.schemaVersion, 1);
assert.equal(uiStartup.baselineCommit, "a7e4b26a48fc7691f99ede5a061daf033b034738");
assert.equal(uiStartup.cssSource, "tools/app/styles/style-002.css");
assert.equal(uiStartup.templateSource, "tools/app/index.template.html");
assert.deepEqual(uiStartup.cssChanges.map(block => [block.id, sha256(block.beforeSource)]), UI_STARTUP_CSS,
  "The startup UI CSS audit may inverse only its three exact reviewed fragments");
assert.deepEqual(uiStartup.templateChanges.map(block => [block.id, sha256(block.beforeSource)]), UI_STARTUP_TEMPLATE,
  "The startup UI template audit may inverse only its eight exact reviewed fragments");
assert.deepEqual(uiStartup.scriptChanges.map(block =>
  [block.id, block.kind, block.entryId, block.source, sha256(block.beforeSource)]), UI_STARTUP_SCRIPTS,
  "The startup UI runtime audit may inverse only the exact top-tide disclosure creation snippet");
assert.equal(viewPillSurface.schemaVersion, 1);
assert.equal(viewPillSurface.baselineCommit, "29e7a1482a68d1880ec898be9559ef2162d37111");
assert.equal(viewPillSurface.kind, "style");
assert.equal(viewPillSurface.entryId, "style-079");
assert.equal(viewPillSurface.source, "tools/app/styles/style-079.css");
assert.deepEqual(viewPillSurface.blocks.map(block => [block.id, sha256(block.beforeSource)]), VIEW_PILL_SURFACE_BLOCKS,
  "The view-pill surface audit may inverse only its two exact reviewed presentation fragments");
assert.equal(loaderRestore.schemaVersion, 1);
assert.equal(loaderRestore.baselineCommit, "cc901738b8b4fa15e027c63577ce0a16445a1764");
assert.deepEqual(loaderRestore.styles.map(block =>
  [block.kind, block.entryId, block.source, block.mode, sha256(block.beforeSource)]), LOADER_RESTORE_STYLES,
  "The loader restoration audit may inverse only its two exact original visibility/lifecycle fragments");
assert.equal(loaderRestore.controller.source, "assets/north-wildwood-loading.js");
assert.equal(loaderRestore.controller.sha256, "cc99a91625f8dea0f4d11d136cca2fc5dd1703223f0fe689f046791ee36ea276");
assert.equal(Buffer.byteLength(auditedLineRead(loaderRestore.controller.source)), loaderRestore.controller.bytes,
  "The original welcome controller length must stay unchanged");
assert.equal(sha256(auditedLineRead(loaderRestore.controller.source)), loaderRestore.controller.sha256,
  "The original welcome controller must stay byte-for-byte unchanged");
assert.equal(loaderRestore.templateSource, "tools/app/index.template.html");
assert.equal(sha256(loaderRestore.templateChange.beforeSource), "3f8c28bb4a7c493f945380350d92400ec053893736ec936593f90ce59d2a9e4c",
  "The welcome controller must remain adjacent to the original loader stylesheet");
const welcomeTag = loaderRestore.templateChange.scriptTag;
assert.match(welcomeTag, /^<script\b[^>]*><\/script>$/);
const welcomeAttributes = attributes(welcomeTag.slice(0, welcomeTag.indexOf(">") + 1));
assert.equal(welcomeAttributes.size, 2, "The restored controller must retain only its src and defer attributes");
assert.ok(welcomeAttributes.has("defer"), "The restored welcome controller must not block HTML parsing");
referencedOutput(welcomeAttributes.get("src"), loaderRestore.controller.source,
  auditedLineRead(loaderRestore.controller.source));
assert.equal(loaderRestore.templateChange.afterSource,
  loaderRestore.templateChange.beforeSource + welcomeTag + "\n",
  "The loader tag audit may add only its one deferred controller script");
// The external controller received separate upstream label improvements after
// the inline extraction baseline. Preserve those as well as the original DOM.
assert.equal(previewUi.baselineCommit, "cd993903a689a41ef5439497b49c8350e962b9b7");
assert.equal(previewUi.source, "assets/export-preview.js");
assert.deepEqual(previewUi.uiFunctions.map(block => block.function), ["init", "renderReviewStep", "showState"]);
for (const block of previewUi.uiFunctions) {
  const match = previewSource.match(new RegExp(`  function ${block.function}\\([^)]*\\) \\{[\\s\\S]*?\\n  }\\n`));
  assert.ok(match, `Missing original preview UI function ${block.function}`);
  assert.equal(Buffer.byteLength(match[0]), block.bytes, `${block.function} preview UI changed`);
  assert.equal(sha256(match[0]), block.sha256, `${block.function} preview CSS/markup/text changed`);
}

for (const kind of ["style", "script"]) {
  const before = baseline.blocks.filter(block => block.kind === kind);
  const after = manifest[`${kind}s`];
  assert.ok(Array.isArray(after), `Manifest ${kind}s must be an ordered array`);
  assert.equal(after.length, before.length, `Every original ${kind} block must be retained once`);
  for (let index = 0; index < before.length; index += 1) {
    const original = before[index];
    const entry = after[index];
    const expectedId = `${kind}-${String(index + 1).padStart(3, "0")}`;
    assert.equal(entry.id, expectedId, `${kind} manifest order changed`);
    assert.equal(entry.openTag, original.opening, `${expectedId} original attributes changed`);
    assert.equal(entry.closeTag, original.closing, `${expectedId} closing tag changed`);
    assert.ok(Array.isArray(entry.sources) && entry.sources.length,
      `${expectedId} must declare at least one ordered source file`);
    const source = entry.sources.map(relative => {
      assert.ok(!sourcePaths.has(relative), `Source is included twice: ${relative}`);
      sourcePaths.add(relative);
      return read(relative);
    }).join("");
    const baselineSource = auditedBaselineSource(kind, entry, source);
    assert.equal(Buffer.byteLength(baselineSource), original.bytes, `${expectedId} source length changed outside the audited changes`);
    assert.equal(sha256(baselineSource), original.sha256,
      `${expectedId} source changed: preserve CSS rules, scientific values and script order exactly`);
    const key = token(kind, entry.id);
    assert.ok(!entriesByToken.has(key), `Duplicate application template token ${key}`);
    entriesByToken.set(key, { ...entry, kind, source, baselineSource });
    if (kind === "style") {
      assert.ok(entry.output.startsWith("assets/styles/") && entry.output.endsWith(".css"));
      styleEntries.push(entry);
      if (!outputs.has(entry.output)) outputs.set(entry.output, []);
      outputs.get(entry.output).push(source);
    } else {
      assert.ok(entry.output.startsWith("assets/app/") && entry.output.endsWith(".js"));
      assert.ok(!outputs.has(entry.output), `Script output would overwrite another block: ${entry.output}`);
      outputs.set(entry.output, [source]);
      scriptEntries.push(entry);
      scriptEntriesById.set(entry.id, entry);
      new vm.Script(source, { filename: entry.output });
      compiled += 1;
    }
  }
}

const expectedTokenOrder = baseline.blocks.map(block =>
  token(block.kind, `${block.kind}-${String(block.index + 1).padStart(3, "0")}`));
const actualTokenOrder = Array.from(template.matchAll(/<!-- nww:(?:style|script):[\w-]+ -->/g), match => match[0]);
assert.deepEqual(actualTokenOrder, expectedTokenOrder,
  "Extraction slots must retain the original interleaved CSS/script order");
const originalIssueTemplate = auditedIssueFixFragments(auditedIssueFixFragments(auditedLineRead("tools/app/index.template.html"), holisticFixAudit.templateChanges, "Holistic template"), bugFixAudit.templateChanges, "Template");
const originalFamilyTemplate = auditedFontFamilyTemplate(originalIssueTemplate, "Source template");
const originalLoaderTemplate = auditedUiStartupFragments(originalFamilyTemplate, [loaderRestore.templateChange], "Loader template");
const originalUiTemplate = auditedUiStartupFragments(originalLoaderTemplate, uiStartup.templateChanges, "Template");
const originalHtml = auditedPaneStartupTemplate(originalUiTemplate).replace(/<!-- nww:(?:style|script):[\w-]+ -->/g, key => {
  const entry = entriesByToken.get(key);
  assert.ok(entry, `Unknown template token ${key}`);
  return entry.openTag + entry.baselineSource + entry.closeTag;
});
// Only the cache key changes for the external preview's nonvisual gesture fix.
// Its UI-producing functions remain pinned independently above.
assert.equal(originalHtml.split(PREVIEW_TAG_AFTER).length - 1, 1,
  "The preview must retain its exact defer/id attributes and audited cache version");
assert.equal(sha256(originalHtml.replace(PREVIEW_TAG_AFTER, PREVIEW_TAG_BEFORE)), baseline.baselineHtmlSha256,
  "The source template must reproduce original HTML with only the audited cache-key update");

for (const [output, pieces] of outputs) {
  assert.equal(read(output), pieces.join(""),
    `${output} must contain every source byte exactly once and in order`);
}

const seenStyleOutputs = new Set();
for (const entry of styleEntries) {
  const first = !seenStyleOutputs.has(entry.output);
  assert.equal(entry.firstInBundle, first, `${entry.id} has an invalid firstInBundle flag`);
  if (first) {
    const bundleId = path.basename(entry.output, ".css");
    assert.ok(!styleBundlesById.has(bundleId), `Ambiguous CSS bundle ID ${bundleId}`);
    styleBundlesById.set(bundleId, entry);
    seenStyleOutputs.add(entry.output);
  }
}

const scriptOrder = [];
const styleOrder = [];
let restoredTemplate = published.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, full => {
  const opening = full.slice(0, full.indexOf(">") + 1);
  const attrs = attributes(opening);
  if (!attrs.has("data-nww-script")) {
    assert.ok(attrs.has("src"), "All original inline JavaScript must be extracted");
    return full;
  }
  const id = attrs.get("data-nww-script");
  const entry = scriptEntriesById.get(id);
  assert.ok(entry, `Unknown generated script ${id}`);
  scriptOrder.push(id);
  referencedOutput(attrs.get("src"), entry.output);
  const originalAttrs = attributes(entry.openTag);
  attrs.delete("src");
  attrs.delete("data-nww-script");
  assert.deepEqual(attrs, originalAttrs,
    `${id} must retain its original classic/blocking execution attributes`);
  assert.equal(full.slice(opening.length).replace(/<\/script\s*>$/i, ""), "",
    "Extracted script tags must not contain a second inline implementation");
  return token("script", id);
});
restoredTemplate = restoredTemplate.replace(/<link\b[^>]*>/gi, full => {
  const attrs = attributes(full);
  if (!attrs.has("data-nww-style-bundle")) return full;
  const bundle = attrs.get("data-nww-style-bundle");
  const entry = styleBundlesById.get(bundle);
  assert.ok(entry, `Unknown generated style bundle ${bundle}`);
  styleOrder.push(entry.output);
  assert.equal(attrs.get("rel"), "stylesheet");
  assert.equal(attrs.size, 3, "Extracted CSS must not acquire media/disabled/loading attributes");
  referencedOutput(attrs.get("href"), entry.output);
  return token("style", entry.id);
});
assert.doesNotMatch(published, /<style\b/i, "All original inline CSS must be extracted");
assert.deepEqual(scriptOrder, scriptEntries.map(entry => entry.id),
  "Generated scripts must execute once in their original blocking order");
assert.deepEqual(styleOrder, Array.from(seenStyleOutputs),
  "Generated CSS bundles must retain their original cascade order");
assert.equal(restoredTemplate, template,
  "Generated HTML may change only the declared source slots; all UI DOM and existing dependencies must remain exact");

// A CSS bundle may not leap over a script or an existing external stylesheet.
// Such a move can change script-observed style and named-layer cascade behavior.
const bundledStyleRuns = new Set();
let activeStyleOutput = null;
for (const match of template.matchAll(/<!-- nww:(style|script):([\w-]+) -->|<script\b[^>]*>[\s\S]*?<\/script\s*>|<link\b[^>]*>/gi)) {
  if (match[1] === "style") {
    const entry = entriesByToken.get(match[0]);
    if (entry.output !== activeStyleOutput) {
      assert.ok(!bundledStyleRuns.has(entry.output),
        `${entry.output} crosses a script or external stylesheet barrier`);
      bundledStyleRuns.add(entry.output);
      activeStyleOutput = entry.output;
    }
  } else if (match[1] === "script" || /^<script\b/i.test(match[0]) ||
    (/^<link\b/i.test(match[0]) && attributes(match[0]).get("rel") === "stylesheet")) {
    activeStyleOutput = null;
  }
}

console.log(`North Wildwood source parity passed: ${styleEntries.length} CSS blocks in ${seenStyleOutputs.size} bundles and ${compiled} classic scripts retain original hashes after exact audited calendar/export-presentation/boundary-startup/pane-startup/UI-startup/view-pill-surface/loader-restore/font-family/October-26/October-27-fixes/October-28-export-road-labels/placement/frame-reuse inverses; remaining UI DOM and dependency order remain exact.`);

if (process.argv.includes("--self-test")) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "nww-refactor-parity-"));
  try {
    for (const relative of ["tools/app", "assets/app", "assets/styles", "assets/export-preview.js", FONT_FAMILY_SOURCE,
      "tools/fixtures/north-wildwood-refactor-baseline.json", "tools/fixtures/north-wildwood-export-preview-ui.json",
      "tools/fixtures/north-wildwood-export-presentation.json", "tools/fixtures/north-wildwood-boundary-startup.json",
      "tools/fixtures/north-wildwood-pane-startup.json",
      "tools/fixtures/north-wildwood-ui-startup.json",
      "tools/fixtures/north-wildwood-view-pill-surface.json",
      "tools/fixtures/north-wildwood-loader-restore.json", BUG_FIX_AUDIT_PATH, HOLISTIC_FIX_AUDIT_PATH, loaderRestore.controller.source,
      LINE_FIX_AUDIT_PATH, ...lineFixAudit.files.map(file => file.source),
      ROAD_LABEL_AUDIT_PATH, roadLabelAudit.module.source, roadLabelAudit.data.source,
      PLACEMENT_AUDIT_PATH,
      FRAME_REUSE_AUDIT_PATH,
      boundaryStartup.featureSource, "index.html"]) {
      const destination = path.join(scratch, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.cpSync(localPath(relative), destination, { recursive: true });
    }
    const run = () => spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { ...process.env, NWW_PARITY_ROOT: scratch }, encoding: "utf8"
    });
    assert.equal(run().status, 0, "The unmodified scratch copy must pass before mutation checks");
    const scratchHtml = path.join(scratch, "index.html");
    const scriptTags = Array.from(published.matchAll(/<script\b[^>]*data-nww-script[^>]*><\/script>/g), match => match[0]);
    const styleTags = Array.from(published.matchAll(/<link\b[^>]*data-nww-style-bundle[^>]*>/g), match => match[0]);
    const cases = [
      ["broadened export frame-reuse inverse", path.join(scratch, FRAME_REUSE_AUDIT_PATH),
        JSON.stringify({ ...frameReuseAudit, changes: [...frameReuseAudit.changes, frameReuseAudit.changes[0]] })],
      ["altered export frame-reuse function", path.join(scratch, frameReuseAudit.files[0].source),
        read(frameReuseAudit.files[0].source).replace("    async function setExportFloodLayer(",
          "    async function setExportFloodLayer(/* Unreviewed frame reuse */")],
      ["altered adjacent export water-level formatter", path.join(scratch, frameReuseAudit.files[0].source),
        read(frameReuseAudit.files[0].source).replace("    function getExportFrameWaterLevelText(",
          "    function getExportFrameWaterLevelText(/* Unreviewed science */")],
      ["broadened road-label placement follow-up", path.join(scratch, PLACEMENT_AUDIT_PATH),
        JSON.stringify({ ...placementAudit, changes: [...placementAudit.changes, placementAudit.changes[0]] })],
      ["altered approved placement function", path.join(scratch, roadLabelAudit.module.source),
        read(roadLabelAudit.module.source).replace("  function layout(", "  function layout(/* Unreviewed placement */")],
      ["altered module outside the placement function", path.join(scratch, roadLabelAudit.module.source),
        read(roadLabelAudit.module.source).replace("Inter,", "Arial,")],
      ["reverted placement dependency cache version", path.join(scratch, "tools/app/index.template.html"),
        template.replace(activeRoadLabelTag, roadLabelTag)],
      ["broadened export road-label inverse audit", path.join(scratch, ROAD_LABEL_AUDIT_PATH),
        JSON.stringify({ ...roadLabelAudit, changes: [...roadLabelAudit.changes, roadLabelAudit.changes[0]] })],
      ["altered export road-label implementation", path.join(scratch, roadLabelAudit.module.source),
        read(roadLabelAudit.module.source) + "\n// Unreviewed label behavior\n"],
      ["altered road-label geographic source", path.join(scratch, roadLabelAudit.data.source),
        read(roadLabelAudit.data.source) + "\n"],
      ["altered road-label integration fragment", path.join(scratch, roadLabelAudit.changes[0].source),
        read(roadLabelAudit.changes[0].source).replace(roadLabelAudit.changes[0].afterSource,
          roadLabelAudit.changes[0].afterSource + "\n// Unreviewed road-label integration\n")],
      ["dropped export road-label dependency", scratchHtml, published.replace(activeRoadLabelTag, "")],
      ["asynchronous export road-label dependency", path.join(scratch, "tools/app/index.template.html"),
        template.replace(activeRoadLabelTag, activeRoadLabelTag.replace("<script", "<script async"))],
      ["stale export road-label cache version", path.join(scratch, "tools/app/index.template.html"),
        template.replace(activeRoadLabelTag, activeRoadLabelTag.replace(/\?v=[a-f0-9]+/, "?v=unreviewed"))],
      ["broadened October 27 inverse audit", path.join(scratch, LINE_FIX_AUDIT_PATH),
        JSON.stringify({ ...lineFixAudit, changes: [...lineFixAudit.changes, lineFixAudit.changes[0]] })],
      ["altered October 27 correctness fragment", path.join(scratch, lineFixAudit.changes[0].source),
        read(lineFixAudit.changes[0].source).replace(lineFixAudit.changes[0].afterSource,
          lineFixAudit.changes[0].afterSource + "\n// Unreviewed change\n")],
      ["broadened holistic inverse audit", path.join(scratch, HOLISTIC_FIX_AUDIT_PATH),
        JSON.stringify({ ...holisticFixAudit, changes: [...holisticFixAudit.changes, holisticFixAudit.changes[0]] })],
      ["altered holistic correctness fragment", path.join(scratch, holisticFixAudit.changes[0].source),
        read(holisticFixAudit.changes[0].source).replace(holisticFixAudit.changes[0].afterSource, holisticFixAudit.changes[0].afterSource + "\n// Unreviewed holistic change\n")],
      ["altered approved correctness fix", path.join(scratch, bugFixAudit.changes[0].source),
        read(bugFixAudit.changes[0].source).replace(bugFixAudit.changes[0].afterSource,
          bugFixAudit.changes[0].afterSource + "\n// Unreviewed correctness change\n")],
      ["broadened correctness inverse audit", path.join(scratch, BUG_FIX_AUDIT_PATH),
        JSON.stringify({ ...bugFixAudit, changes: [...bugFixAudit.changes, bugFixAudit.changes[0]] })],
      ["dropped common-family stylesheet", scratchHtml, published.replace(FONT_FAMILY_TAG + "\n", "")],
      ["moved common-family stylesheet", scratchHtml,
        published.replace(FONT_FAMILY_TAG + "\n", "").replace("</head>", FONT_FAMILY_TAG + "\n</head>")],
      ["duplicated common-family stylesheet", path.join(scratch, "tools/app/index.template.html"),
        template.replace(FONT_FAMILY_TAG, FONT_FAMILY_TAG + "\n" + FONT_FAMILY_TAG)],
      ["altered common-family stylesheet dependency", path.join(scratch, "tools/app/index.template.html"),
        template.replace(FONT_FAMILY_TAG, FONT_FAMILY_TAG.replace("20261026-1", "unreviewed"))],
      ["altered reviewed common font family", path.join(scratch, FONT_FAMILY_SOURCE),
        read(FONT_FAMILY_SOURCE).replace("Inter,", "Arial,")],
      ["added geometry to family-only stylesheet", path.join(scratch, FONT_FAMILY_SOURCE),
        read(FONT_FAMILY_SOURCE).replace("font-family:var", "font-size:18px!important;\n    font-family:var")],
      ["dropped CSS bundle", scratchHtml, published.replace(styleTags[0], "")],
      ["moved CSS bundle", scratchHtml, published.replace(styleTags[0], "") + styleTags[0]],
      ["dropped script", scratchHtml, published.replace(scriptTags[0], "")],
      ["moved script", scratchHtml, published.replace(scriptTags[0], "") + scriptTags[0]],
      ["asynchronous script execution", scratchHtml, published.replace(scriptTags[0], scriptTags[0].replace("<script", "<script async"))],
      ["changed UI DOM", scratchHtml, published.replace("<title>", "<title>Unrequested UI change ")],
      ["altered/stale runtime output", path.join(scratch, scriptEntries[0].output), read(scriptEntries[0].output) + "\n// stale bundle\n"],
      ["altered/stale CSS output", path.join(scratch, styleEntries[0].output), read(styleEntries[0].output) + "\nbody{display:none}\n"],
      ["removed month-label idempotence guard", path.join(scratch, MONTH_LABEL_SOURCE),
        read(MONTH_LABEL_SOURCE).replace(MONTH_LABEL_GUARD, "      monthLabel.textContent = monthText;")],
      ["altered code adjacent to the audited fix", path.join(scratch, MONTH_LABEL_SOURCE),
        read(MONTH_LABEL_SOURCE).replace(MONTH_LABEL_AFTER, MONTH_LABEL_AFTER + "\n      // Unapproved adjacent change")],
      ["duplicated audited fix", path.join(scratch, MONTH_LABEL_SOURCE),
        read(MONTH_LABEL_SOURCE).replace(MONTH_LABEL_AFTER, MONTH_LABEL_AFTER + "\n" + MONTH_LABEL_AFTER)],
      ["changed preview UI", path.join(scratch, previewUi.source),
        previewSource.replace("height:220px", "height:221px")],
      ["altered approved export layout", path.join(scratch, "tools/app/runtime/13-export-range.js"),
        read("tools/app/runtime/13-export-range.js").replace("    function getExportFooterLayout(width, height) {",
          "    function getExportFooterLayout(width, height) {\n      // Unapproved presentation change")],
      ["duplicated approved export presentation function", path.join(scratch, "tools/app/runtime/16-export-map.js"),
        read("tools/app/runtime/16-export-map.js") + "\n" + exactPresentationBlock(read("tools/app/runtime/16-export-map.js"),
          "getExportTimestampRows", "getExportTimestampRows")],
      ["altered approved export footer CSS", path.join(scratch, "tools/app/styles/style-081.css"),
        read("tools/app/styles/style-081.css") + "\n/* Unapproved footer change */\n"],
      ["altered water-level science adjacent to approved presentation", path.join(scratch, "tools/app/runtime/16-export-map.js"),
        read("tools/app/runtime/16-export-map.js").replace("formatStageForDisplay(rawStage)", "formatStageForDisplay(rawStage + 1)")],
      ["altered approved boundary startup function", path.join(scratch, "tools/app/runtime/10-map-geometry-and-layers.js"),
        read("tools/app/runtime/10-map-geometry-and-layers.js").replace("    function seedMunicipalBoundary(",
          "    function seedMunicipalBoundary(/* Unapproved startup change */")],
      ["duplicated approved boundary startup function", path.join(scratch, "tools/app/runtime/10-map-geometry-and-layers.js"),
        read("tools/app/runtime/10-map-geometry-and-layers.js") + "\n" +
          exactBoundaryStartupBlock(read("tools/app/runtime/10-map-geometry-and-layers.js"),
            boundaryStartup.blocks.find(block => block.function === "seedMunicipalBoundary"), "seedMunicipalBoundary")],
      ["altered code adjacent to the boundary startup fix", path.join(scratch, "tools/app/runtime/10-map-geometry-and-layers.js"),
        read("tools/app/runtime/10-map-geometry-and-layers.js") + "\n// Unapproved adjacent runtime change\n"],
      ["removed exact startup boundary assignment", path.join(scratch, "tools/app/town-config.js"),
        read("tools/app/town-config.js").replace(exactBoundaryStartupBlock(read("tools/app/town-config.js"),
          boundaryStartup.blocks.find(block => block.assignment), "startupFeature"), "")],
      ["altered authoritative boundary file", path.join(scratch, boundaryStartup.featureSource),
        read(boundaryStartup.featureSource) + "\n"],
      ["changed preserved startup camera", path.join(scratch, "tools/app/runtime/10-map-geometry-and-layers.js"),
        read("tools/app/runtime/10-map-geometry-and-layers.js").replace("map.fitBounds(getBoundaryDrivenOverlayBounds(false)",
          "map.fitBounds(getBoundaryDrivenOverlayBounds(true)")],
      ["broadened boundary audit declaration list", path.join(scratch, "tools/fixtures/north-wildwood-boundary-startup.json"),
        JSON.stringify({ ...boundaryStartup, blocks: [...boundaryStartup.blocks, boundaryStartup.blocks[0]] })],
      ["altered pane startup CSS", path.join(scratch, PANE_STARTUP_CSS_SOURCE),
        read(PANE_STARTUP_CSS_SOURCE).replace(PANE_STARTUP_CSS_START,
          PANE_STARTUP_CSS_START + "  /* Unapproved startup geometry change */\n")],
      ["duplicated pane startup CSS", path.join(scratch, PANE_STARTUP_CSS_SOURCE),
        read(PANE_STARTUP_CSS_SOURCE) + exactPaneStartupCss(read(PANE_STARTUP_CSS_SOURCE))],
      ["repositioned pane startup CSS", path.join(scratch, PANE_STARTUP_CSS_SOURCE),
        read(PANE_STARTUP_CSS_SOURCE).replace(exactPaneStartupCss(read(PANE_STARTUP_CSS_SOURCE)), "") +
          exactPaneStartupCss(read(PANE_STARTUP_CSS_SOURCE))],
      ["altered unrelated mobile CSS", path.join(scratch, PANE_STARTUP_CSS_SOURCE),
        read(PANE_STARTUP_CSS_SOURCE) + "\n@media(max-width:900px){#leftPanel{width:300px!important;}}\n"],
      ["altered startup label", path.join(scratch, paneStartup.templateSource),
        template.replace(PANE_STARTUP_LABELS[0][2], "<h2>Unapproved forecast label</h2>")],
      ["broadened pane startup label audit", path.join(scratch, "tools/fixtures/north-wildwood-pane-startup.json"),
        JSON.stringify({ ...paneStartup, labels: [...paneStartup.labels, paneStartup.labels[0]] })],
      ["altered initial title lane", path.join(scratch, uiStartup.cssSource),
        read(uiStartup.cssSource).replace("left:calc(50% - 40px)!important", "left:50%!important")],
      ["altered initial pane clearance", path.join(scratch, uiStartup.cssSource),
        read(uiStartup.cssSource).replace("max-height:max(100px,calc(100dvh - 217.2px))!important",
          "max-height:100vh!important")],
      ["duplicated startup UI fragment", path.join(scratch, uiStartup.cssSource),
        read(uiStartup.cssSource) + uiStartup.cssChanges[1].afterSource],
      ["repositioned startup UI fragment", path.join(scratch, uiStartup.cssSource),
        read(uiStartup.cssSource).replace(uiStartup.cssChanges[1].afterSource, "") + uiStartup.cssChanges[1].afterSource],
      ["removed pending timestamp protection", path.join(scratch, uiStartup.cssSource),
        read(uiStartup.cssSource).replace("#timelineBubble:has(.timeline-bubble-startup-placeholder)", "#unapprovedPlaceholder")],
      ["altered initial configured address", path.join(scratch, uiStartup.templateSource),
        template.replace("Find a North Wildwood Address", "Find Address")],
      ["reverted initial layer order/case", path.join(scratch, uiStartup.templateSource),
        template.replace("<div class=\"layer-name\">Road names</div>", "<div class=\"layer-name\">Road Names</div>")],
      ["broadened startup UI CSS audit", path.join(scratch, "tools/fixtures/north-wildwood-ui-startup.json"),
        JSON.stringify({ ...uiStartup, cssChanges: [...uiStartup.cssChanges, uiStartup.cssChanges[0]] })],
      ["altered initial top-tide disclosure", path.join(scratch, uiStartup.scriptChanges[0].source),
        read(uiStartup.scriptChanges[0].source).replace('<span class="unified-more-plus">+</span>',
          '<span class="unified-more-plus">Changed</span>')],
      ["broadened startup UI runtime audit", path.join(scratch, "tools/fixtures/north-wildwood-ui-startup.json"),
        JSON.stringify({ ...uiStartup, scriptChanges: [...uiStartup.scriptChanges, uiStartup.scriptChanges[0]] })],
      ["restored transparent view-pill fill", path.join(scratch, viewPillSurface.source),
        read(viewPillSurface.source).replace("background:#23344b !important", "background:var(--accent-soft) !important")],
      ["restored dimmed busy view pill", path.join(scratch, viewPillSurface.source),
        read(viewPillSurface.source).replace("opacity:1 !important", "opacity:.88 !important")],
      ["broadened view-pill surface audit", path.join(scratch, "tools/fixtures/north-wildwood-view-pill-surface.json"),
        JSON.stringify({ ...viewPillSurface, blocks: [...viewPillSurface.blocks, viewPillSurface.blocks[0]] })],
      ["restored early loader hiding", path.join(scratch, loaderRestore.styles[0].source),
        read(loaderRestore.styles[0].source).replace("\n", "\n#nwSiteLoader{display:none!important;}\n")],
      ["revealed controls before loader completion", path.join(scratch, loaderRestore.styles[1].source),
        read(loaderRestore.styles[1].source).replace("body.nw-app-ready:not(.nw-app-loading)",
          "body:is(.nw-app-loading,.nw-app-ready)")],
      ["removed welcome controller", path.join(scratch, loaderRestore.templateSource),
        template.replace(template.match(/<script\b[^>]*\bsrc="assets\/north-wildwood-loading\.js[^>]*><\/script>/)[0], "")],
      ["changed welcome controller to asynchronous execution", path.join(scratch, loaderRestore.templateSource),
        template.replace(template.match(/<script\b[^>]*\bsrc="assets\/north-wildwood-loading\.js[^>]*><\/script>/)[0],
          template.match(/<script\b[^>]*\bsrc="assets\/north-wildwood-loading\.js[^>]*><\/script>/)[0].replace("<script", "<script async"))],
      ["altered original welcome controller", path.join(scratch, loaderRestore.controller.source),
        read(loaderRestore.controller.source) + "\n// Unapproved loader behavior\n"],
    ];
    for (const [name, target, altered] of cases) {
      const before = fs.readFileSync(target, "utf8");
      fs.writeFileSync(target, altered);
      const result = run();
      fs.writeFileSync(target, before);
      assert.equal(result.error, undefined, `${name}: checker must execute successfully`);
      assert.notEqual(result.status, 0, `${name}: parity checker failed to reject the mutation`);
      assert.match(result.stderr, /AssertionError/, `${name}: rejection must come from a parity assertion`);
    }
    assert.equal(run().status, 0, "Restoring the scratch files must restore a passing check");
    console.log(`Parity mutation checks passed: ${cases.length} dropped, moved, altered or stale artifacts were rejected.`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
