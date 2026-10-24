#!/usr/bin/env node
// Enforce the unchanged-UI/scientific-source contract for the source extraction.
// The fixture records the pre-refactor source, independently of the build code.
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
// the original baseline fixture, CSS, DOM and all other JavaScript stay pinned.
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

function auditedBaselineSource(kind, entry, source) {
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
    assert.equal(Buffer.byteLength(baselineSource), original.bytes, `${expectedId} source length changed outside the audited fix`);
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
const originalHtml = template.replace(/<!-- nww:(?:style|script):[\w-]+ -->/g, key => {
  const entry = entriesByToken.get(key);
  assert.ok(entry, `Unknown template token ${key}`);
  return entry.openTag + entry.baselineSource + entry.closeTag;
});
assert.equal(sha256(originalHtml), baseline.baselineHtmlSha256,
  "The source template must reproduce the entire original HTML byte-for-byte");

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

console.log(`North Wildwood source parity passed: ${styleEntries.length} unchanged CSS blocks in ${seenStyleOutputs.size} bundles, ${compiled - 1} unchanged classic scripts and one audited nonvisual runtime fix, exact UI DOM and dependency order.`);

if (process.argv.includes("--self-test")) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "nww-refactor-parity-"));
  try {
    for (const relative of ["tools/app", "assets/app", "assets/styles",
      "tools/fixtures/north-wildwood-refactor-baseline.json", "index.html"]) {
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
