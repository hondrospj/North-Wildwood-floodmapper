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
const template = read("tools/app/index.template.html");
const published = read("index.html");
const previewUi = JSON.parse(read("tools/fixtures/north-wildwood-export-preview-ui.json"));
const previewSource = read(previewUi.source);
const exportPresentation = JSON.parse(read("tools/fixtures/north-wildwood-export-presentation.json"));
const boundaryStartup = JSON.parse(read("tools/fixtures/north-wildwood-boundary-startup.json"));
const paneStartup = JSON.parse(read("tools/fixtures/north-wildwood-pane-startup.json"));
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
  const actual = exactPaneStartupCss(read(block.source));
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
    const actual = exactBoundaryStartupBlock(read(block.source), block, label);
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
    const actual = exactPresentationBlock(read(block.source), block.function, label);
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

function auditedBaselineSource(kind, entry, source) {
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

function referencedOutput(value, expectedOutput) {
  const url = new URL(value, "https://north-wildwood-parity.invalid/");
  assert.equal(url.origin, "https://north-wildwood-parity.invalid",
    "Extracted application sources must remain local");
  assert.equal(decodeURIComponent(url.pathname).replace(/^\//, ""), expectedOutput,
    "Generated tag points to the wrong output file");
  const version = url.searchParams.get("v");
  assert.ok(version && version.length >= 12 && sha256(read(expectedOutput)).startsWith(version),
    `${expectedOutput} must have a version derived from its exact content`);
  assert.equal(url.hash, "", "Extracted source references must not contain fragments");
}

function token(kind, id) {
  return `<!-- nww:${kind}:${id} -->`;
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
const originalHtml = auditedPaneStartupTemplate(template).replace(/<!-- nww:(?:style|script):[\w-]+ -->/g, key => {
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

console.log(`North Wildwood source parity passed: ${styleEntries.length} CSS blocks in ${seenStyleOutputs.size} bundles and ${compiled} classic scripts retain original hashes after exact audited calendar/export-presentation/boundary-startup/pane-startup inverses; original UI DOM and dependency order remain exact.`);

if (process.argv.includes("--self-test")) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "nww-refactor-parity-"));
  try {
    for (const relative of ["tools/app", "assets/app", "assets/styles", "assets/export-preview.js",
      "tools/fixtures/north-wildwood-refactor-baseline.json", "tools/fixtures/north-wildwood-export-preview-ui.json",
      "tools/fixtures/north-wildwood-export-presentation.json", "tools/fixtures/north-wildwood-boundary-startup.json",
      "tools/fixtures/north-wildwood-pane-startup.json",
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
