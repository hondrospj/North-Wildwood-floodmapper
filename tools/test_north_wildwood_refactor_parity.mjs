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
const readBytes = relative => fs.readFileSync(localPath(relative));
const readCurrent = relative => readBeforeOvernight(relative);
const readActual = relative => readRecheckReviewed(relative);
const readRaw = relative => readFollowupReviewed(relative);
const read = relative => readDeepReviewed(relative);
const sha256 = source => createHash("sha256").update(source).digest("hex");
const priorMutationSnapshot = Boolean(process.env.NWW_PARITY_ROOT) && process.argv.includes("--prior-mutation-snapshot");
const priorBuildingViewSnapshot = priorMutationSnapshot ||
  (Boolean(process.env.NWW_PARITY_ROOT) && process.argv.includes("--prior-building-view-snapshot"));
const priorOvernightSnapshot = priorBuildingViewSnapshot ||
  (Boolean(process.env.NWW_PARITY_ROOT) && process.argv.includes("--prior-overnight-snapshot"));
const OVERNIGHT_PATH = "tools/fixtures/north-wildwood-20261108-overnight.json";
const overnightText = readBytes(OVERNIGHT_PATH).toString("utf8");
assert.equal(sha256(overnightText), "8580d0ed4fd9a7162135298dc7d85210995b4dc50b457a799169a63088212a7b", "Retain the exact overnight inverse");
const overnight = JSON.parse(overnightText);
assert.equal(overnight.schemaVersion, 1);
assert.equal(overnight.baselineCommit, "84951f91c7872c98b47417a594103f91dc410301");
function readBeforeOvernight(relative) {
  const source = readBytes(relative).toString("utf8");
  const file = overnight.files.find(entry => entry.source === relative);
  if (priorOvernightSnapshot || !file) return source;
  assert.equal(sha256(source), file.afterSha256, `${relative} changed outside the reviewed overnight work`);
  let restored = source;
  for (const block of file.changes) {
    assert.ok(block.beforeSource.length && block.afterSource.length);
    assert.equal(restored.split(block.afterSource).length - 1, 1, `${relative}: one exact overnight fragment`);
    restored = restored.replace(block.afterSource, block.beforeSource);
  }
  assert.equal(sha256(restored), file.beforeSha256, `${relative}: restore every pre-overnight byte`);
  return restored;
}
if (!priorOvernightSnapshot) {
  for (const file of overnight.files) readBeforeOvernight(file.source);
  for (const file of overnight.added) {
    assert.equal(sha256(readBytes(file.source)), file.sha256, `${file.source}: reviewed overnight asset bytes`);
  }
  const currentHtml = readBytes("index.html").toString("utf8");
  const dependencies = [...currentHtml.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+)"[^>]*>/g)]
    .map(match => new URL(match[1], "https://overnight.invalid/"));
  for (const [relative, key] of Object.entries(overnight.cacheDependencies)) {
    const urls = dependencies.filter(url => url.pathname.slice(1) === relative);
    assert.equal(urls.length, 1, `${relative}: one published dependency`);
    assert.equal(urls[0].searchParams.get(key), sha256(readBytes(relative)).slice(0, 16), `${relative}: exact cache version`);
  }
}
const BUILDING_VIEW_PATH = "tools/fixtures/north-wildwood-20261107-building-view.json";
const buildingViewText = readCurrent(BUILDING_VIEW_PATH);
assert.equal(sha256(buildingViewText), "afcbf5800adcd5d5bedda39f535c2c44f4f3a8fb780f4d0489fa97fa3a022013",
  "Retain the exact building view inverse");
const buildingView = JSON.parse(buildingViewText);
assert.equal(buildingView.schemaVersion, 1);
assert.equal(buildingView.baselineCommit, "81c37c07cabaa25cb1bce7674526e845183b3ace");
function readBeforeBuildingView(relative) {
  const source = readCurrent(relative), file = buildingView.files.find(entry => entry.source === relative);
  if (priorBuildingViewSnapshot || !file) return source;
  assert.equal(sha256(source), file.afterSha256, `${relative} changed outside the reviewed building view fix`);
  let restored = source;
  for (const change of file.changes) {
    assert.equal(restored.split(change.afterSource).length - 1, 1, `${relative}: one exact building view fragment`);
    restored = restored.replace(change.afterSource, change.beforeSource);
  }
  assert.equal(sha256(restored), file.beforeSha256, `${relative}: restore all pre-fix bytes`);
  return restored;
}
for (const file of buildingView.files) readBeforeBuildingView(file.source);
// Reverse only the reviewed browser changes before running the original parity layers.
const LINE_AUDIT_PATH = "tools/fixtures/north-wildwood-20261106-line-audit.json";
const lineAuditText = readCurrent(LINE_AUDIT_PATH);
assert.equal(sha256(lineAuditText), "38b1a95dec68f9ebf0974066dc5983097652eaf13a0aea21751631e04fa33f53",
  "Retain the exact line audit inverse");
const lineAudit = JSON.parse(lineAuditText);
assert.equal(lineAudit.schemaVersion, 1);
assert.equal(lineAudit.baselineCommit, "943c0056743d76370c81481c0354192964307187");
function readBeforeLineAudit(relative) {
  const source = readBeforeBuildingView(relative), file = lineAudit.files.find(entry => entry.source === relative);
  if (priorMutationSnapshot || !file) return source;
  assert.equal(sha256(source), file.afterSha256, `${relative} changed outside the reviewed line audit`);
  let restored = source;
  for (const change of file.changes) {
    assert.equal(restored.split(change.afterSource).length - 1, 1, `${relative}: one exact line audit fragment`);
    restored = restored.replace(change.afterSource, change.beforeSource);
  }
  assert.equal(sha256(restored), file.beforeSha256, `${relative}: restore all pre-audit bytes`);
  return restored;
}
for (const file of lineAudit.files) readBeforeLineAudit(file.source);
// Pin the projection-note removal before the earlier audited presentation changes.
const PROJECTION_NOTE_PATH = "tools/fixtures/north-wildwood-20261105-projection-note.json";
const projectionNoteText = readCurrent(PROJECTION_NOTE_PATH);
assert.equal(sha256(projectionNoteText), "facd945a32bdf06119478bb563dcb7296460a9ddbf755779e4f42cc111f31208", "Retain the exact reviewed projection-note inverse");
const projectionNote = JSON.parse(projectionNoteText);
assert.equal(projectionNote.schemaVersion, 1);
assert.equal(projectionNote.baselineCommit, "7c470c6977ff2cab2ec3c0f777c0bc14e90d40eb");
assert.deepEqual(projectionNote.files.map(file => file.source), ["tools/app/index.template.html", "tools/app/runtime/24-alerts-and-projections.js", "assets/app/runtime.js", "index.html"]);
function readProjectionNoteReviewed(relative) {
  const source = readBeforeLineAudit(relative), file = projectionNote.files.find(file => file.source === relative);
  if (!file) return source;
  assert.equal(sha256(source), file.afterSha256, `${relative} changed outside the reviewed projection-note removal`);
  let restored = source;
  for (const block of file.changes) {
    assert.equal(sha256(block.beforeSource), block.beforeSha256);
    assert.equal(sha256(block.afterSource), block.afterSha256);
    assert.ok(block.beforeSource.length && block.afterSource.length);
    assert.equal(restored.split(block.afterSource).length - 1, 1, `${relative}: one exact projection-note fragment`);
    restored = restored.replace(block.afterSource, block.beforeSource);
  }
  assert.equal(sha256(restored), file.beforeSha256, `${relative}: restore every pre-removal byte`);
  return restored;
}
for (const file of projectionNote.files) readProjectionNoteReviewed(file.source);
// Older HTML fragment reversions still target the active runtime script tag.
const projectionRuntimeTag = projectionNote.files.find(file => file.source === "index.html").changes
  .find(block => block.beforeSource.includes('src="./assets/app/runtime.js?v='));
assert.ok(projectionRuntimeTag);
function projectionNoteCurrentFragment(relative, fragment) {
  if (relative !== "index.html") return fragment;
  return fragment.replace(projectionRuntimeTag.beforeSource, projectionRuntimeTag.afterSource);
}
// Only the explicitly requested forecast-label capitalization precedes prior audits.
const LABEL_CASE_PATH = "tools/fixtures/north-wildwood-20261104-forecast-label-case.json";
const labelCaseText = readCurrent(LABEL_CASE_PATH);
assert.equal(sha256(labelCaseText), "37be370e4d37b020a4e334504015f27c6d1f9b7bc6ad41a7e49c2a363a9ea023", "Retain the exact reviewed forecast-label inverse");
const labelCase = JSON.parse(labelCaseText);
assert.equal(labelCase.schemaVersion, 1);
assert.equal(labelCase.baselineCommit, "4023165cea5a7f1319c8127e31ec83914c99613d");
assert.deepEqual(labelCase.files.map(file => file.source), ["tools/app/index.template.html", "tools/app/unified-controller.js", "assets/app/unified-controller.js", "index.html"]);
function readForecastLabelReviewed(relative) {
  const source = readProjectionNoteReviewed(relative), file = labelCase.files.find(file => file.source === relative);
  if (!file) return source;
  assert.equal(sha256(source), file.afterSha256, `${relative} changed outside reviewed forecast-label capitalization`);
  let restored = source;
  for (const block of file.changes) {
    assert.equal(sha256(block.beforeSource), block.beforeSha256);
    assert.equal(sha256(block.afterSource), block.afterSha256);
    assert.ok(block.beforeSource.length && block.afterSource.length);
    assert.equal(restored.split(block.afterSource).length - 1, 1, `${relative}: one exact forecast-label fragment`);
    restored = restored.replace(block.afterSource, block.beforeSource);
  }
  assert.equal(sha256(restored), file.beforeSha256, `${relative}: restore every pre-capitalization byte`);
  return restored;
}
for (const file of labelCase.files) readForecastLabelReviewed(file.source);
const labelControllerTags = [...readCurrent("index.html").matchAll(/<script[^>]+src="([^"]+)"[^>]*>/g)]
  .map(match => new URL(match[1], "https://label-case.invalid/"))
  .filter(url => url.pathname === "/assets/app/unified-controller.js");
assert.equal(labelControllerTags.length, 1);
assert.equal(labelControllerTags[0].searchParams.get("v"), sha256(readCurrent("assets/app/unified-controller.js")).slice(0, 16));
// The November 4 building/camera change is pinned before all prior inverses.
// Every historical validator continues to receive its exact pre-change bytes.
const CAMERAS_3D_PATH = "tools/fixtures/north-wildwood-20261104-3d-cameras.json";
const cameras3dText = readCurrent(CAMERAS_3D_PATH);
assert.equal(sha256(cameras3dText), "28db3bf510b591bbee65f18e111c91421aedabaadb36441065e565dee46ff3e2",
  "The 3D/camera inverse must retain its exact reviewed fixture");
const cameras3d = JSON.parse(cameras3dText);
assert.equal(cameras3d.schemaVersion, 1);
assert.equal(cameras3d.baselineCommit, "8dac57f98a3f09d6300f1e616487a2c8ea27b98a");
assert.deepEqual(cameras3d.files.map(file => file.source), ["assets/3d/north-wildwood-3d.js", "tools/app/runtime/10-map-geometry-and-layers.js", "tools/app/runtime/27-mobile-and-address.js", "tools/app/webcams.js", "tools/app/styles/style-012.css", "assets/app/runtime.js", "assets/app/webcams.js", "assets/styles/app-04.css", "tools/app/index.template.html", "index.html"]);
function read3dCameraReviewed(relative) {
  const source = readForecastLabelReviewed(relative), file = cameras3d.files.find(file => file.source === relative);
  if (!file) return source;
  assert.equal(sha256(source), file.afterSha256, `${relative} changed outside the reviewed 3D/camera fixes`);
  let restored = source;
  for (const block of file.changes) {
    assert.equal(sha256(block.beforeSource), block.beforeSha256);
    assert.equal(sha256(block.afterSource), block.afterSha256);
    assert.ok(block.beforeSource.length && block.afterSource.length);
    assert.equal(restored.split(block.afterSource).length - 1, 1, `${relative}:${block.afterLine} requires one exact 3D/camera fragment`);
    restored = restored.replace(block.afterSource, block.beforeSource);
  }
  assert.equal(sha256(restored), file.beforeSha256, `${relative} must restore every pre-3D/camera byte`);
  return restored;
}
for (const file of cameras3d.files) read3dCameraReviewed(file.source);
for (const [relative, parameter, documents] of [
  ["assets/3d/north-wildwood-3d.js", "deep", ["tools/app/index.template.html", "index.html"]],
  ["assets/app/runtime.js", "v", ["index.html"]],
  ["assets/app/webcams.js", "v", ["index.html"]],
  ["assets/styles/app-04.css", "v", ["index.html"]]
]) {
  for (const document of documents) {
    const tags = [...readCurrent(document).matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+)"[^>]*>/g)];
    const urls = tags.map(match => new URL(match[1], "https://3d-cameras.invalid/")).filter(url => url.pathname.slice(1) === relative);
    assert.equal(urls.length, 1, `${document}: one exact current 3D/camera dependency for ${relative}`);
    assert.equal(urls[0].searchParams.get(parameter), sha256(readCurrent(relative)).slice(0, 16), `${relative}: current 3D/camera cache key must match its bytes`);
  }
}
// Map historical mutation boundaries only through unchanged exact anchors.
// Edited interior bytes never provide an inferred or silently skipped boundary.
function cameraCurrentFragment(relative, fragment) {
  const current = readProjectionNoteReviewed(relative);
  if (current.split(fragment).length - 1 === 1) return projectionNoteCurrentFragment(relative, fragment);
  const baseline = read3dCameraReviewed(relative), file = cameras3d.files.find(file => file.source === relative);
  assert.ok(file, `${relative}: changed mutation fragment requires an exact 3D/camera owner`);
  assert.equal(baseline.split(fragment).length - 1, 1, `${relative}: prior mutation fragment must be unique`);
  const offset = position => {
    let shift = 0;
    for (const block of file.changes) {
      const start = baseline.indexOf(block.beforeSource), end = start + block.beforeSource.length;
      assert.ok(start >= 0);
      if (position < start) break;
      if (position >= end) { shift += block.afterSource.length - block.beforeSource.length; continue; }
      let prefix = 0, suffix = 0;
      while (prefix < Math.min(block.beforeSource.length, block.afterSource.length) && block.beforeSource[prefix] === block.afterSource[prefix]) prefix++;
      while (suffix < Math.min(block.beforeSource.length, block.afterSource.length) - prefix && block.beforeSource.at(-suffix - 1) === block.afterSource.at(-suffix - 1)) suffix++;
      if (position - start <= prefix) return position + shift;
      if (position >= end - suffix) return start + shift + block.afterSource.length - (end - position);
      const local = position - start;
      if (local === 0 || block.beforeSource[local - 1] === "\n") {
        let forward = local, backward = local;
        for (let lines = 0; lines < block.beforeSource.split("\n").length; lines++) {
          forward = block.beforeSource.indexOf("\n", forward) + 1 || block.beforeSource.length;
          backward = block.beforeSource.lastIndexOf("\n", Math.max(0, backward - 2)) + 1;
          for (const [anchor, endBoundary] of [[block.beforeSource.slice(local, forward), false], [block.beforeSource.slice(backward, local), true]]) {
            if (!anchor.trim() || block.beforeSource.split(anchor).length - 1 !== 1 || block.afterSource.split(anchor).length - 1 !== 1) continue;
            return start + shift + block.afterSource.indexOf(anchor) + (endBoundary ? anchor.length : 0);
          }
          if (forward === block.beforeSource.length && backward === 0) break;
        }
      }
      assert.fail(`${relative}: prior mutation boundary lies inside newly edited 3D/camera bytes`);
    }
    return position + shift;
  };
  const start = baseline.indexOf(fragment), mapped = current.slice(offset(start), offset(start + fragment.length));
  assert.ok(mapped.length);
  assert.equal(current.split(mapped).length - 1, 1, `${relative}: mapped current 3D/camera mutation fragment must be unique`);
  return projectionNoteCurrentFragment(relative, mapped);
}
// Pin the physical recheck bytes first. Every previous audit still receives
// exactly its original source through this narrowly enumerated inverse.
const RECHECK_PATH = "tools/fixtures/north-wildwood-20261103-recheck-debug.json";
const recheckText = readCurrent(RECHECK_PATH);
assert.equal(sha256(recheckText), "48ced54ddb319d0a452ae3ad4c7facbb7455784a7a16c289143cad4089928fc0",
  "The recheck inverse must retain its exact reviewed fixture");
const recheck = JSON.parse(recheckText);
assert.equal(recheck.schemaVersion, 1);
assert.equal(recheck.baselineCommit, "fb2740502cbc50ceb24081f2bba78a82d422bc30");
assert.deepEqual(recheck.files.map(file => file.source), [
  "tools/app/runtime/02-data-and-datums.js", "tools/app/runtime/05-presentation.js",
  "tools/app/runtime/17-export-encoding.js", "tools/app/runtime/22-calendar-and-modes.js",
  "tools/app/runtime/28-tutorial-and-events.js", "assets/3d/north-wildwood-3d.js",
  "city-gauge/index.html", "assets/app/runtime.js", "tools/app/index.template.html", "index.html"
]);
function readRecheckReviewed(relative) {
  const source = read3dCameraReviewed(relative), file = recheck.files.find(file => file.source === relative);
  if (!file) return source;
  assert.equal(sha256(source), file.afterSha256, `${relative} changed outside the reviewed recheck fixes`);
  let restored = source;
  for (const block of file.changes) {
    assert.equal(sha256(block.beforeSource), block.beforeSha256);
    assert.equal(sha256(block.afterSource), block.afterSha256);
    assert.ok(block.beforeSource.length && block.afterSource.length);
    assert.equal(restored.split(block.afterSource).length - 1, 1, `${relative}:${block.afterLine} requires one exact recheck fragment`);
    restored = restored.replace(block.afterSource, block.beforeSource);
  }
  assert.equal(sha256(restored), file.beforeSha256, `${relative} must restore every pre-recheck byte`);
  return restored;
}
for (const file of recheck.files) readRecheckReviewed(file.source);
for (const [relative, parameter, documents] of [
  ["assets/3d/north-wildwood-3d.js", "deep", ["tools/app/index.template.html", "index.html"]],
  ["assets/app/runtime.js", "v", ["index.html"]]
]) {
  for (const document of documents) {
    const tags = [...read3dCameraReviewed(document).matchAll(/<script[^>]+src="([^"]+)"[^>]*>/g)];
    const urls = tags.map(match => new URL(match[1], "https://recheck.invalid/")).filter(url => url.pathname.slice(1) === relative);
    assert.equal(urls.length, 1, `${document}: one exact recheck dependency for ${relative}`);
    assert.equal(urls[0].searchParams.get(parameter), sha256(read3dCameraReviewed(relative)).slice(0, 16), `${relative}: pre-3D/camera content cache key must match its bytes`);
  }
}
// Prior fragment-revert mutations keep their names and original regression
// effects even when a newly reviewed edit lies inside their owned fragment.
// Map only unchanged fragment boundaries through the exact leading inverse;
// a boundary inside edited bytes is an assertion failure, never an ignored case.
function recheckCurrentFragment(relative, fragment) {
  const current = read3dCameraReviewed(relative);
  if (current.split(fragment).length - 1 === 1) return cameraCurrentFragment(relative, fragment);
  const baseline = readActual(relative), file = recheck.files.find(file => file.source === relative);
  assert.ok(file, `${relative}: changed mutation fragment requires an exact recheck owner`);
  assert.equal(baseline.split(fragment).length - 1, 1, `${relative}: previous mutation fragment must be unique`);
  const offset = (position) => {
    let shift = 0;
    for (const block of file.changes) {
      const start = baseline.indexOf(block.beforeSource), end = start + block.beforeSource.length;
      assert.ok(start >= 0);
      if (position < start) break;
      if (position >= end) { shift += block.afterSource.length - block.beforeSource.length; continue; }
      let prefix = 0, suffix = 0;
      while (prefix < Math.min(block.beforeSource.length, block.afterSource.length) && block.beforeSource[prefix] === block.afterSource[prefix]) prefix++;
      while (suffix < Math.min(block.beforeSource.length, block.afterSource.length) - prefix && block.beforeSource.at(-suffix - 1) === block.afterSource.at(-suffix - 1)) suffix++;
      if (position - start <= prefix) return position + shift;
      if (position >= end - suffix) return start + shift + block.afterSource.length - (end - position);
      // A minified function may sit between two edited lines in the same
      // exact hunk. Its unchanged adjacent lines still identify the boundary
      // without guessing an offset inside either changed line.
      const local = position - start;
      if (local === 0 || block.beforeSource[local - 1] === "\n") {
        let forward = local, backward = local;
        for (let lines = 0; lines < block.beforeSource.split("\n").length; lines++) {
          forward = block.beforeSource.indexOf("\n", forward) + 1 || block.beforeSource.length;
          backward = block.beforeSource.lastIndexOf("\n", Math.max(0, backward - 2)) + 1;
          for (const [anchor, endBoundary] of [[block.beforeSource.slice(local, forward), false], [block.beforeSource.slice(backward, local), true]]) {
            if (!anchor.trim() || block.beforeSource.split(anchor).length - 1 !== 1 || block.afterSource.split(anchor).length - 1 !== 1) continue;
            return start + shift + block.afterSource.indexOf(anchor) + (endBoundary ? anchor.length : 0);
          }
          if (forward === block.beforeSource.length && backward === 0) break;
        }
      }
      assert.fail(`${relative}: previous mutation boundary lies inside newly edited bytes`);
    }
    return position + shift;
  };
  const start = baseline.indexOf(fragment), mapped = current.slice(offset(start), offset(start + fragment.length));
  assert.ok(mapped.length);
  assert.equal(current.split(mapped).length - 1, 1, `${relative}: mapped current mutation fragment must be unique`);
  return cameraCurrentFragment(relative, mapped);
}
// Pin every current follow-up byte, then invert only exact reviewed fragments.
// All earlier fixtures and their assertions still receive their original input.
const FOLLOWUP_PATH = "tools/fixtures/north-wildwood-20261103-followup-debug.json";
const followupText = readActual(FOLLOWUP_PATH);
assert.equal(sha256(followupText), "51ec45d7931410dfaec0257e9cc1452650e27630d18c9187d499fdfc9b5695e1",
  "The follow-up inverse must retain its exact reviewed fixture");
const followup = JSON.parse(followupText);
assert.equal(followup.schemaVersion, 1);
assert.equal(followup.baselineCommit, "ec552d376a8a82a590f96f9eb6567f9685a2d02c");
assert.deepEqual(followup.files.map(file => file.source), [
  "tools/app/runtime/02-data-and-datums.js", "tools/app/runtime/22-calendar-and-modes.js",
  "tools/app/runtime/24-alerts-and-projections.js", "tools/app/runtime/26-depth-queries.js",
  "tools/app/runtime/28-tutorial-and-events.js", "assets/3d/north-wildwood-3d.js",
  "assets/modal-focus.js", "assets/export-area.js", "tools/app/town-config.js",
  "assets/app/town-config.js", "assets/app/runtime.js", "tools/app/index.template.html", "index.html", "city-gauge/index.html"
]);
function readFollowupReviewed(relative) {
  const source = readActual(relative), file = followup.files.find(file => file.source === relative);
  if (!file) return source;
  assert.equal(sha256(source), file.afterSha256, `${relative} changed outside the reviewed follow-up fixes`);
  let restored = source;
  for (const block of file.changes) {
    assert.equal(sha256(block.beforeSource), block.beforeSha256);
    assert.equal(sha256(block.afterSource), block.afterSha256);
    assert.ok(block.beforeSource.length && block.afterSource.length);
    assert.equal(restored.split(block.afterSource).length - 1, 1, `${relative}:${block.afterLine} requires one exact owned fragment`);
    restored = restored.replace(block.afterSource, block.beforeSource);
  }
  assert.equal(sha256(restored), file.beforeSha256, `${relative} must restore every pre-follow-up byte`);
  return restored;
}
for (const file of followup.files) readFollowupReviewed(file.source);
for (const [relative, parameter] of [["assets/3d/north-wildwood-3d.js", "deep"], ["assets/modal-focus.js", "v"], ["assets/export-area.js", "v"], ["assets/app/runtime.js", "v"], ["assets/app/town-config.js", "v"]]) {
  for (const document of ["index.html", ...(relative.startsWith("assets/app/") ? [] : ["tools/app/index.template.html"])]) {
    const tags = [...readActual(document).matchAll(/<script[^>]+src="([^"]+)"[^>]*>/g)];
    const urls = tags.map(match => new URL(match[1], "https://followup.invalid/")).filter(url => url.pathname.slice(1) === relative);
    assert.equal(urls.length, 1, `${document}: one exact dependency for ${relative}`);
    assert.equal(urls[0].searchParams.get(parameter), sha256(readActual(relative)).slice(0, 16), `${relative}: content cache key must match its current bytes`);
  }
}
const baseline = JSON.parse(readRaw("tools/fixtures/north-wildwood-refactor-baseline.json"));
const manifest = JSON.parse(readRaw("tools/app/manifest.json"));

// Invert only the invisible map-region and date-combobox semantics. Current
// files are pinned before every older audit sees its exact previous input.
const ARIA_SEMANTICS_PATH = "tools/fixtures/north-wildwood-20261103-aria-semantics.json";
const ariaSemanticsText = readRaw(ARIA_SEMANTICS_PATH);
assert.equal(sha256(ariaSemanticsText), "ca6e139a541d995a50c6779850191f9b04623af646867424c063cc63fa4634b1",
  "The semantic inverse must retain its exact reviewed fixture");
const ariaSemantics = JSON.parse(ariaSemanticsText);
assert.equal(ariaSemantics.schemaVersion, 1);
assert.equal(ariaSemantics.baselineCommit, "6b309913d6620ffd0367cd57b7f2a2c3eb6f98d0");
const ARIA_SEMANTICS_PICKER = "assets/export-date-time-picker.js";
const ARIA_SEMANTICS_TEMPLATE = "tools/app/index.template.html";
const ARIA_SEMANTICS_OWNERS = ["close", "create", "openDate", "init"];
assert.deepEqual(ariaSemantics.files.map(file => [file.source, file.kind, file.entryId]), [
  [ARIA_SEMANTICS_PICKER, "external", null], [ARIA_SEMANTICS_TEMPLATE, "template", null], ["index.html", "document", null]
]);
assert.deepEqual(ariaSemantics.changes.map(block => [block.id, block.source, block.kind, block.functionOwner, block.entryId]), [
  ["date-popup-close-state", ARIA_SEMANTICS_PICKER, "external", "close", null],
  ["date-popup-open-state", ARIA_SEMANTICS_PICKER, "external", "create", null],
  ["editable-date-combobox-role", ARIA_SEMANTICS_PICKER, "external", "init", null],
  ["date-popup-invocation-owner", ARIA_SEMANTICS_PICKER, "external", "openDate", null],
  ["date-combobox-keyboard-focus", ARIA_SEMANTICS_PICKER, "external", "init", null],
  ["named-map-region", ARIA_SEMANTICS_TEMPLATE, "template", null, null]
]);
const ariaCloseAnchor = '    previous.anchor.setAttribute("aria-expanded", "false");\n' +
  '    document.getElementById(`download${previous.prefix === "end" ? "End" : "Start"}CalendarBtn`)?.setAttribute("aria-expanded", "false");\n' +
  '    if (restoreFocus && previous.anchor.isConnected) previous.anchor.focus({ preventScroll: true });\n';
assert.equal(ariaSemantics.changes[0].beforeSource, ariaCloseAnchor);
assert.equal(ariaSemantics.changes[0].afterSource, ariaCloseAnchor
  .replace('    previous.anchor.setAttribute("aria-expanded", "false");\n',
    '    previous.anchor.setAttribute("aria-expanded", "false");\n' +
    '    if (previous.kind === "date") getExportDateEditorElements(previous.prefix).dateText?.setAttribute("aria-expanded", "false");\n')
  .replace('    if (restoreFocus && previous.anchor.isConnected) previous.anchor.focus({ preventScroll: true });\n',
    '    const returnFocus = previous.returnFocus || previous.anchor;\n' +
    '    if (restoreFocus && returnFocus.isConnected) returnFocus.focus({ preventScroll: true });\n'));
const ariaOpenAnchor = '    anchor.setAttribute("aria-expanded", "true"); anchor.setAttribute("aria-controls", ID);\n';
assert.equal(ariaSemantics.changes[1].beforeSource, ariaOpenAnchor);
assert.equal(ariaSemantics.changes[1].afterSource, ariaOpenAnchor +
  '    if (kind === "date") {\n' +
  '      for (const trigger of [getExportDateEditorElements(prefix).dateText, document.getElementById(`download${prefix === "end" ? "End" : "Start"}CalendarBtn`)]) {\n' +
  '        trigger?.setAttribute("aria-expanded", "true"); trigger?.setAttribute("aria-controls", ID);\n' +
  '      }\n' +
  '    }\n');
const ariaDateEditor = '      editor.datePicker.hidden = true; editor.datePicker.tabIndex = -1;\n';
assert.equal(ariaSemantics.changes[2].beforeSource, ariaDateEditor);
assert.equal(ariaSemantics.changes[2].afterSource, ariaDateEditor + '      editor.dateText.setAttribute("role","combobox");\n');
const ariaPopupOwner = '  function openDate(prefix, focusCalendar = true) {\n' +
  '    if (currentDataMode === "return-interval") return;\n' +
  '    const editor = getExportDateEditorElements(prefix);\n' +
  '    const anchor = focusCalendar ? document.getElementById(`download${prefix === "end" ? "End" : "Start"}CalendarBtn`) : editor.dateText;\n' +
  '    if (!anchor || editor.dateText.disabled) return;\n' +
  '    const state = create(prefix,"date",anchor); if (!state) return;\n';
assert.equal(ariaSemantics.changes[3].beforeSource, ariaPopupOwner);
assert.equal(ariaSemantics.changes[3].afterSource, ariaPopupOwner
  .replace('focusCalendar = true)', 'focusCalendar = true, opener = null)') + '    state.returnFocus = opener || anchor;\n',
  "Only an explicit invoking element may alter the popup's focus-return owner");
const ariaDateKeydown = '        if(event.key === "ArrowDown"){event.preventDefault();openDate(prefix);}\n';
assert.equal(ariaSemantics.changes[4].beforeSource, ariaDateKeydown);
assert.equal(ariaSemantics.changes[4].afterSource, ariaDateKeydown.replace('openDate(prefix)', 'openDate(prefix,true,editor.dateText)'),
  "ArrowDown retains its existing calendar focus behavior and records the invoking combobox");
assert.equal(ariaSemantics.changes[5].beforeSource,
  '<div id="map3d" aria-label="Interactive 3D North Wildwood flood map">');
assert.equal(ariaSemantics.changes[5].afterSource,
  ariaSemantics.changes[5].beforeSource.replace('id="map3d"', 'id="map3d" role="region"'),
  "The named map may add only the region role, retaining every label and visual attribute");
function ariaSemanticsOwner(source, name) {
  const expression = new RegExp("^  function " + name + "\\([^\\n]*\\) \\{\\n[^]*?^  }\\n(?:\\n)?", "gm");
  const matches = [...source.matchAll(expression)];
  assert.equal(matches.length, 1, `${name} must retain its exact date-picker function owner`);
  return matches[0][0];
}
for (const block of ariaSemantics.changes) {
  assert.equal(sha256(block.beforeSource), block.beforeSha256);
  assert.equal(sha256(block.afterSource), block.afterSha256);
  if (block.kind === "external") {
    assert.ok(ariaSemanticsOwner(readRaw(block.source), block.functionOwner).includes(block.afterSource),
      "Each semantic fragment must remain inside its existing picker function");
  }
}
assert.deepEqual(ariaSemantics.documentTags.map(tag => [tag.output, tag.documents]),
  [[ARIA_SEMANTICS_PICKER, [ARIA_SEMANTICS_TEMPLATE, "index.html"]]]);
for (const tag of ariaSemantics.documentTags) {
  assert.equal(tag.afterSource.replace(/\?v=[a-f0-9]+/, "?v=VERSION"), tag.beforeSource.replace(/\?v=[a-f0-9]+/, "?v=VERSION"),
    "The picker dependency may change only its exact content cache key");
  const attrs = attributes(tag.afterSource.slice(0, tag.afterSource.indexOf(">") + 1));
  referencedOutput(attrs.get("src"), tag.output, readRaw(tag.output));
}
function readAriaSemanticsReviewed(relative) {
  const source = readRaw(relative), file = ariaSemantics.files.find(file => file.source === relative);
  if (!file) return source;
  assert.equal(sha256(source), file.afterSha256, `${relative} changed outside the reviewed invisible semantics`);
  const blocks = file.kind === "external" ? ariaSemantics.changes.filter(block => block.kind === "external")
    : [...ariaSemantics.changes.filter(block => block.kind === "template"), ...ariaSemantics.documentTags];
  let restored = source;
  for (const block of blocks) {
    assert.ok(block.afterSource.length);
    assert.equal(restored.split(block.afterSource).length - 1, 1,
      `${block.id || block.output} must retain one exact semantic fragment`);
    restored = restored.replace(block.afterSource, block.beforeSource);
  }
  if (file.kind === "external") {
    const strip = text => {
      for (const name of ARIA_SEMANTICS_OWNERS) text = text.replace(ariaSemanticsOwner(text, name), "");
      return text;
    };
    assert.equal(strip(source), strip(restored),
      "Only close/create/openDate/init semantic role, state and focus fragments may change; every other picker byte remains exact");
    for (const block of blocks) assert.ok(ariaSemanticsOwner(restored, block.functionOwner).includes(block.beforeSource));
  }
  assert.equal(sha256(restored), file.beforeSha256, `${relative} must restore every pre-semantics byte`);
  return restored;
}
for (const file of ariaSemantics.files) readAriaSemanticsReviewed(file.source);

// Invert only the reviewed deep state/data fixes. Every prior audit reads its
// exact input bytes; this leading layer separately pins the real current files.
const DEEP_REVIEW_PATH = "tools/fixtures/north-wildwood-20261103-deep-fixes.json";
const deepReviewedText = readRaw(DEEP_REVIEW_PATH);
assert.equal(sha256(deepReviewedText), "fdd12441798319f48629c376a4d174775034cbceebc602a2e2eece2924740860",
  "The deep-fix inverse must retain its exact reviewed fixture");
const deepReviewed = JSON.parse(deepReviewedText);
assert.equal(deepReviewed.schemaVersion, 1);
assert.equal(deepReviewed.baselineCommit, "debf97d7aace528cd46ba94721904bf0a3a417ac");
const DEEP_RUNTIME = "assets/app/runtime.js", DEEP_3D = "assets/3d/north-wildwood-3d.js";
const DEEP_TEMPLATE = "tools/app/index.template.html";
const DEEP_OWNERS = [
  ["tools/app/runtime/03-time-series.js", ["buildObservedDailyMaximumSeries"]],
  ["tools/app/runtime/04-observation-archives.js", ["ensureObservedArchiveForDate", "ensureObservedArchiveRange", "buildObservedCanonicalSeries"]],
  ["tools/app/runtime/06-inundation-catalog.js", ["annotateHydraulicSeries"]],
  ["tools/app/runtime/08-filling-and-drainage.js", ["getDrainageRetentionMilestones"]],
  ["tools/app/runtime/13-export-range.js", ["getDownloadRangeSummaryFrameCount"]],
  ["tools/app/runtime/17-export-encoding.js", ["buildHourlyRangeFrameItems"]],
  ["tools/app/runtime/22-calendar-and-modes.js", ["loadObservedDay", "setTimelineIntervalMinutes", "switchDataMode"]],
  ["tools/app/runtime/25-structures-and-parcels.js", ["setNsiStructuresEnabled", "ensureParcelAssets", "loadParcelBoundaryLayer", "setParcelsEnabled"]],
  [DEEP_3D, ["updateImageLayer", "syncParcels3d", "buildingGeometryPolygons3d", "buildingGeometrySegments3d",
    "buildingPointOnSegment3d", "buildingGeometryContainsPoint3d", "buildingInteriorPoint3d", "buildingSegmentParts3d",
    "buildingFootprintFitsParcel3d", "resolveClickedBuildingParcel3d", "wire3dInteractions", "setParcelsEnabled="]]
];
const DEEP_NEW_FUNCTIONS = ["loadParcelBoundaryLayer", "buildingGeometryPolygons3d", "buildingGeometrySegments3d",
  "buildingPointOnSegment3d", "buildingGeometryContainsPoint3d", "buildingInteriorPoint3d", "buildingSegmentParts3d",
  "buildingFootprintFitsParcel3d", "resolveClickedBuildingParcel3d"];
assert.deepEqual(deepReviewed.files.map(file => [file.source, file.kind, file.entryId]), [
  ...DEEP_OWNERS.map(([relative]) => [relative, relative === DEEP_3D ? "external" : "script", relative === DEEP_3D ? null : "script-004"]),
  [DEEP_RUNTIME, "generated-script", "script-004"], [DEEP_TEMPLATE, "template", null], ["index.html", "document", null]
]);
assert.deepEqual(deepReviewed.changes.map(block => [block.source, block.functionOwner]),
  DEEP_OWNERS.flatMap(([relative, names]) => names.map(name => [relative, name])));
const deepRuntimeEntry = manifest.scripts.find(entry => entry.id === "script-004");
assert.equal(deepRuntimeEntry.output, DEEP_RUNTIME);
for (const [relative] of DEEP_OWNERS.filter(([relative]) => relative !== DEEP_3D)) assert.ok(deepRuntimeEntry.sources.includes(relative));
function deepOwnedFunction(source, name, indent, absent = false) {
  const assignment = name.endsWith("=");
  const head = assignment ? name.slice(0, -1) + " = async function \\(\\)" : "(?:async )?function " + name + "\\([^\\n]*\\)";
  const expression = new RegExp("^" + " ".repeat(indent) + head + " \\{\\n[^]*?^" + " ".repeat(indent) + (assignment ? "};" : "}") + "\\n(?:\\n)?", "gm");
  const matches = [...source.matchAll(expression)];
  assert.equal(matches.length, absent ? 0 : 1, `${name} must retain its exact deep-fix function owner`);
  return matches[0]?.[0] || "";
}
for (const block of deepReviewed.changes) {
  const external = block.source === DEEP_3D;
  assert.equal(block.kind, external ? "external" : "script");assert.equal(block.entryId, external ? null : "script-004");
  assert.equal(block.afterSource, deepOwnedFunction(readAriaSemanticsReviewed(block.source), block.functionOwner, external ? 2 : 4));
  assert.equal(sha256(block.afterSource), block.afterSha256);
  assert.equal(block.beforeSource === "", DEEP_NEW_FUNCTIONS.includes(block.functionOwner),
    "Only the nine reviewed new helpers may introduce declarations");
}
assert.deepEqual(deepReviewed.documentTags.map(tag => [tag.output, tag.documents]), [
  [DEEP_RUNTIME, ["index.html"]], [DEEP_3D, [DEEP_TEMPLATE, "index.html"]]
]);
for (const tag of deepReviewed.documentTags) {
  const attrs = attributes(tag.afterSource.slice(0, tag.afterSource.indexOf(">") + 1));
  if (tag.output === DEEP_RUNTIME) {
    assert.equal(tag.afterSource.replace(/\?v=[a-f0-9]+/, "?v=VERSION"), tag.beforeSource.replace(/\?v=[a-f0-9]+/, "?v=VERSION"),
      "Deep runtime fixes may change only the existing content cache key");
    referencedOutput(attrs.get("src"), tag.output, readAriaSemanticsReviewed(tag.output));
  } else {
    assert.equal(tag.afterSource.replace(/&deep=[a-f0-9]{16}(?=")/, ""), tag.beforeSource,
      "The 3D dependency may add only its exact deep-fix content cache key");
    const url = new URL(attrs.get("src"), "https://north-wildwood-parity.invalid/");
    assert.equal(url.origin, "https://north-wildwood-parity.invalid");
    assert.equal(url.pathname.slice(1), DEEP_3D);assert.equal(url.hash, "");
    assert.equal(url.searchParams.get("deep"), sha256(readAriaSemanticsReviewed(DEEP_3D)).slice(0, 16));
  }
}
function deepReviewedFragments(source, blocks) {
  for (const block of blocks) {
    assert.ok(block.afterSource.length);
    assert.equal(source.split(block.afterSource).length - 1, 1, `${block.functionOwner || block.output} must retain one exact deep-fix fragment`);
    source = source.replace(block.afterSource, block.beforeSource);
  }
  return source;
}
function readDeepReviewed(relative) {
  const source = readAriaSemanticsReviewed(relative), file = deepReviewed.files.find(file => file.source === relative);
  if (!file) return source;
  assert.equal(sha256(source), file.afterSha256, `${relative} changed outside the reviewed deep fixes`);
  const blocks = file.kind === "generated-script" ? deepReviewed.changes.filter(block => block.kind === "script")
    : ["template", "document"].includes(file.kind) ? deepReviewed.documentTags.filter(tag => tag.documents.includes(relative))
    : deepReviewed.changes.filter(block => block.source === relative);
  const restored = deepReviewedFragments(source, blocks);
  if (["script", "external"].includes(file.kind)) {
    const names = DEEP_OWNERS.find(([name]) => name === relative)[1], indent = relative === DEEP_3D ? 2 : 4;
    const strip = (text, before) => {
      for (const name of names) text = text.replace(deepOwnedFunction(text, name, indent, before && DEEP_NEW_FUNCTIONS.includes(name)), "");
      return text;
    };
    assert.equal(strip(source, false), strip(restored, true), `${relative} may change only its reviewed function declarations and wrapper`);
  }
  assert.equal(sha256(restored), file.beforeSha256, `${relative} must restore every pre-deep-fix byte`);
  return restored;
}
for (const file of deepReviewed.files) readDeepReviewed(file.source);

// Release only the owned html2canvas clone buffers after the reviewed capture.
const CLONE_CLEANUP_PATH = "tools/fixtures/north-wildwood-20261103-export-clone-cleanup.json";
const cloneCleanupText = read(CLONE_CLEANUP_PATH);
assert.equal(sha256(cloneCleanupText), "2b6e8246bd8423376f5fda3d2cc13fbf20c10fcb4a9cefab35af80011ce97bea",
  "The clone-cleanup inverse must retain its exact reviewed fixture");
const cloneCleanup = JSON.parse(cloneCleanupText);
assert.equal(cloneCleanup.schemaVersion, 1);
assert.equal(cloneCleanup.baselineCommit, "f54a3b521eae87487992379635e6433c1df1000c");
const CLONE_CLEANUP_SOURCE = "tools/app/runtime/16-export-map.js", CLONE_CLEANUP_RUNTIME = "assets/app/runtime.js";
const CLONE_CLEANUP_FUNCTIONS = ["captureExportElement", "captureExportCanvas", "captureExportLayerCanvas"];
assert.deepEqual(cloneCleanup.files.map(file => [file.source, file.kind, file.entryId]), [
  [CLONE_CLEANUP_SOURCE, "script", "script-004"], [CLONE_CLEANUP_RUNTIME, "generated-script", "script-004"], ["index.html", "document", null]
]);
const cloneCleanupRuntimeEntry = manifest.scripts.find(entry => entry.id === "script-004");
assert.equal(cloneCleanupRuntimeEntry.output, CLONE_CLEANUP_RUNTIME);
assert.ok(cloneCleanupRuntimeEntry.sources.includes(CLONE_CLEANUP_SOURCE));
assert.deepEqual(cloneCleanup.changes.map(block => block.functionOwner), CLONE_CLEANUP_FUNCTIONS);
for (const block of cloneCleanup.changes) {
  assert.equal(block.source, CLONE_CLEANUP_SOURCE);assert.equal(block.kind, "script");assert.equal(block.entryId, "script-004");
  assert.ok(auditLogicFunction(read(CLONE_CLEANUP_SOURCE), block.functionOwner, 4).includes(block.afterSource),
    "Every cleanup fragment must remain in its exact capture function");
}
assert.equal(cloneCleanup.changes[0].beforeSource, "");
assert.equal(cloneCleanup.changes[0].afterSource, auditLogicFunction(read(CLONE_CLEANUP_SOURCE), CLONE_CLEANUP_FUNCTIONS[0], 4),
  "The only new declaration is the exact reviewed capture helper");
for (const [index, indent] of [[1, 6], [2, 8]]) {
  const block = cloneCleanup.changes[index];
  assert.equal(block.beforeSource, `\n${" ".repeat(indent)}return await html2canvas(stage, {\n`);
  assert.equal(block.afterSource, block.beforeSource.replace("html2canvas", "captureExportElement"),
    "Existing capture callers may change only the renderer delegation, retaining every capture option");
}
assert.deepEqual(cloneCleanup.documentTags.map(tag => [tag.output, tag.documents]), [[CLONE_CLEANUP_RUNTIME, ["index.html"]]]);
for (const tag of cloneCleanup.documentTags) {
  assert.equal(tag.afterSource.replace(/\?v=[a-f0-9]+/, "?v=VERSION"), tag.beforeSource.replace(/\?v=[a-f0-9]+/, "?v=VERSION"),
    "Clone cleanup may change only the existing runtime content cache key");
  const attrs = attributes(tag.afterSource.slice(0, tag.afterSource.indexOf(">") + 1));
  referencedOutput(attrs.get("src"), tag.output);
}
function cloneCleanupFragments(source, blocks) {
  for (const block of blocks) {
    const label = block.id || block.output;
    assert.ok(block.afterSource.length, `${label} must retain an exact nonempty cleanup fragment`);
    assert.equal(source.split(block.afterSource).length - 1, 1, `${label} cleanup fragment must occur exactly once`);
    source = source.replace(block.afterSource, block.beforeSource);
  }
  return source;
}
function assertCloneCleanupOwnership(source, restored) {
  const strip = (text, before) => {
    for (const name of CLONE_CLEANUP_FUNCTIONS) {
      text = text.replace(auditLogicFunction(text, name, 4, before && name === "captureExportElement"), "");
    }
    return text;
  };
  assert.equal(strip(source, false), strip(restored, true),
    "Only the owned-clone helper and its two existing capture callers may change; all other declarations remain exact");
  for (const block of cloneCleanup.changes.slice(1)) {
    assert.ok(auditLogicFunction(restored, block.functionOwner, 4).includes(block.beforeSource));
  }
}
function auditedCloneCleanupRead(relative) {
  const source = read(relative), file = cloneCleanup.files.find(file => file.source === relative);
  if (!file) return source;
  assert.equal(sha256(source), file.afterSha256, `${relative} changed outside the reviewed clone cleanup`);
  const restored = cloneCleanupFragments(source, file.kind === "document" ? cloneCleanup.documentTags : cloneCleanup.changes);
  if (file.kind === "script") assertCloneCleanupOwnership(source, restored);
  assert.equal(sha256(restored), file.beforeSha256, `${relative} must restore every pre-cleanup byte`);
  return restored;
}
for (const file of cloneCleanup.files) auditedCloneCleanupRead(file.source);

// Invert only the reviewed November 3 dialog stacking, Escape and accessible-state fixes.
const UI_DIALOGS_PATH = "tools/fixtures/north-wildwood-20261103-ui-dialogs.json";
const uiDialogsText = read(UI_DIALOGS_PATH);
assert.equal(sha256(uiDialogsText), "c6730d21386d7d0cac87b0d6e8ff135703ec13bfc98ac3668b3340a0faac397e",
  "The UI-dialog inverse must retain its exact reviewed fixture");
const uiDialogs = JSON.parse(uiDialogsText);
assert.equal(uiDialogs.schemaVersion, 1);
assert.equal(uiDialogs.baselineCommit, "f3f02d5d23d85ca46800fa437a15a91abc67e22f");
const UI_DIALOGS_OWNERS = [
  ["tools/app/runtime/05-presentation.js", ["updateModeButtons", "updateDataModeButtons"]],
  ["tools/app/runtime/28-tutorial-and-events.js", ["wireEvents"]]
];
const UI_DIALOGS_RUNTIME = "assets/app/runtime.js", UI_DIALOGS_CSS = "assets/styles/app-03.css";
const UI_DIALOGS_STYLE = "tools/app/styles/style-009.css", UI_DIALOGS_TEMPLATE = "tools/app/index.template.html";
const UI_DIALOGS_RULE = "    #exportOrderModal{ z-index:7300; }\n";
const UI_DIALOGS_BUTTONS = ["forecastDataBtn", "observedDataBtn", "returnIntervalDataBtn", "depthModeBtn", "dynamicModeBtn"];
assert.deepEqual(uiDialogs.files.map(file => [file.source, file.kind, file.entryId]), [
  ...UI_DIALOGS_OWNERS.map(([relative]) => [relative, "script", "script-004"]),
  [UI_DIALOGS_STYLE, "style", "style-009"], [UI_DIALOGS_TEMPLATE, "template", null],
  [UI_DIALOGS_RUNTIME, "generated-script", "script-004"], [UI_DIALOGS_CSS, "generated-style", null], ["index.html", "document", null]
]);
const uiDialogsRuntimeEntry = manifest.scripts.find(entry => entry.id === "script-004");
assert.equal(uiDialogsRuntimeEntry.output, UI_DIALOGS_RUNTIME);
for (const [relative] of UI_DIALOGS_OWNERS) assert.ok(uiDialogsRuntimeEntry.sources.includes(relative));
const uiDialogsStyleEntry = manifest.styles.find(entry => entry.id === "style-009");
assert.deepEqual(uiDialogsStyleEntry.sources, [UI_DIALOGS_STYLE]);
assert.equal(uiDialogsStyleEntry.output, UI_DIALOGS_CSS);
for (const block of uiDialogs.changes) {
  const file = uiDialogs.files.find(file => file.source === block.source);
  assert.ok(file && ["script", "style", "template"].includes(file.kind));
  assert.equal(block.kind, file.kind);assert.equal(block.entryId, file.entryId);
  if (block.kind === "script") {
    const owner = UI_DIALOGS_OWNERS.find(([relative]) => relative === block.source);
    assert.ok(owner && owner[1].includes(block.functionOwner), "UI runtime edits must retain their exact named function owner");
    assert.ok(auditLogicFunction(read(block.source), block.functionOwner, 4).includes(block.afterSource),
      "Each runtime inverse fragment must remain in its declared current function");
    assert.ok(block.beforeSource.length && block.afterSource.length);
  }
}
const uiDialogsCssBlocks = uiDialogs.changes.filter(block => block.kind === "style");
assert.equal(uiDialogsCssBlocks.length, 1);
assert.equal(uiDialogsCssBlocks[0].beforeSource, "");
assert.equal(uiDialogsCssBlocks[0].afterSource, UI_DIALOGS_RULE,
  "The only permitted CSS edit raises the existing range-warning layer, retaining every visual style");
const uiDialogsTemplateBlocks = uiDialogs.changes.filter(block => block.kind === "template");
assert.deepEqual(uiDialogsTemplateBlocks.map(block => attributes(block.afterSource.slice(0, block.afterSource.indexOf(">") + 1)).get("id")), UI_DIALOGS_BUTTONS);
for (const block of uiDialogsTemplateBlocks) {
  assert.equal(block.afterSource.replace(/ aria-pressed="(?:true|false)"/, ""), block.beforeSource,
    "Semantic button defaults may add only their one aria-pressed attribute; labels, classes and all other markup stay exact");
  const attrs = attributes(block.afterSource.slice(0, block.afterSource.indexOf(">") + 1));
  assert.equal(attrs.get("aria-pressed"), ["forecastDataBtn", "depthModeBtn"].includes(attrs.get("id")) ? "true" : "false");
}
assert.deepEqual(uiDialogs.documentTags.map(tag => [tag.output, tag.documents]), [
  [UI_DIALOGS_RUNTIME, ["index.html"]], [UI_DIALOGS_CSS, ["index.html"]]
]);
for (const tag of uiDialogs.documentTags) {
  assert.equal(tag.afterSource.replace(/\?v=[a-f0-9]+/, "?v=VERSION"), tag.beforeSource.replace(/\?v=[a-f0-9]+/, "?v=VERSION"),
    "Dialog fixes may change only the existing runtime/CSS content cache keys");
  const attrs = attributes(tag.afterSource.slice(0, tag.afterSource.indexOf(">") + 1));
  referencedOutput(attrs.get(tag.output === UI_DIALOGS_RUNTIME ? "src" : "href"), tag.output, auditedCloneCleanupRead(tag.output));
}
function uiDialogsFragments(source, blocks) {
  for (const block of blocks) {
    const label = block.id || block.output;
    assert.ok(block.afterSource.length, `${label} must retain an exact nonempty dialog fragment`);
    assert.equal(source.split(block.afterSource).length - 1, 1, `${label} dialog fragment must occur exactly once`);
    source = source.replace(block.afterSource, block.beforeSource);
  }
  return source;
}
function assertUiDialogsOwnership(relative, source, restored) {
  const owner = UI_DIALOGS_OWNERS.find(([name]) => name === relative);
  if (owner) {
    const strip = text => {
      for (const name of owner[1]) text = text.replace(auditLogicFunction(text, name, 4), "");
      return text;
    };
    assert.equal(strip(source), strip(restored), `${relative} may change only its reviewed UI functions, without new declarations`);
    for (const block of uiDialogs.changes.filter(block => block.source === relative)) {
      assert.ok(auditLogicFunction(restored, block.functionOwner, 4).includes(block.beforeSource),
        "Every restored runtime fragment must stay in its existing function owner");
    }
  } else if (relative === UI_DIALOGS_STYLE) {
    assert.equal(source.replace(UI_DIALOGS_RULE, ""), restored, "Every CSS byte except the one warning layer declaration remains exact");
  }
}
function uiDialogsDocument(source) {
  return uiDialogsFragments(source, uiDialogsTemplateBlocks);
}
function auditedUiDialogsRead(relative) {
  const source = auditedCloneCleanupRead(relative), file = uiDialogs.files.find(file => file.source === relative);
  if (!file) return source;
  assert.equal(sha256(source), file.afterSha256, `${relative} changed outside the reviewed UI-dialog fixes`);
  let blocks;
  if (file.kind === "document") blocks = [...uiDialogs.documentTags, ...uiDialogsTemplateBlocks];
  else if (file.kind === "generated-script") blocks = uiDialogs.changes.filter(block => block.kind === "script");
  else if (file.kind === "generated-style") blocks = uiDialogsCssBlocks;
  else blocks = uiDialogs.changes.filter(block => block.source === relative);
  const restored = uiDialogsFragments(source, blocks);
  if (["script", "style"].includes(file.kind)) assertUiDialogsOwnership(relative, source, restored);
  assert.equal(sha256(restored), file.beforeSha256, `${relative} must restore every pre-dialog-fix byte`);
  return restored;
}
for (const file of uiDialogs.files) auditedUiDialogsRead(file.source);

// Invert only the reviewed history-selection transaction; retain every UI byte.
const HISTORY_STATE_PATH = "tools/fixtures/north-wildwood-20261102-history-state.json";
const historyStateText = read(HISTORY_STATE_PATH);
assert.equal(sha256(historyStateText), "7214aac195fcfb314e58d06029f58b9638c8b70f45b282cbbe8d9d8e8a16dd38",
  "The history-state inverse must retain its exact reviewed fixture");
const historyState = JSON.parse(historyStateText);
assert.equal(historyState.schemaVersion, 1);
assert.equal(historyState.baselineCommit, "617f4bc21aefc8ba95eb48ed3aea35ac136e01f4");
const HISTORY_STATE_SOURCE = "tools/app/runtime/22-calendar-and-modes.js";
const HISTORY_STATE_OUTPUT = "assets/app/runtime.js";
const HISTORY_STATE_FUNCTIONS = ["loadTopTideEvent", "switchDataMode"];
assert.deepEqual(historyState.files.map(file => [file.source, file.kind, file.entryId]), [
  [HISTORY_STATE_SOURCE, "script", "script-004"],
  [HISTORY_STATE_OUTPUT, "generated", "script-004"],
  ["index.html", "document", null]
]);
const historyStateEntry = manifest.scripts.find(entry => entry.id === "script-004");
assert.equal(historyStateEntry.output, HISTORY_STATE_OUTPUT);
assert.ok(historyStateEntry.sources.includes(HISTORY_STATE_SOURCE));
assert.ok(historyState.changes.length > 0);
for (const block of historyState.changes) {
  assert.equal(block.source, HISTORY_STATE_SOURCE);
  assert.equal(block.kind, "script");assert.equal(block.entryId, "script-004");
}
assert.deepEqual(historyState.documentTags.map(tag => [tag.output, tag.documents]), [[HISTORY_STATE_OUTPUT, ["index.html"]]]);
for (const tag of historyState.documentTags) {
  assert.equal(tag.afterSource.replace(/\?v=[a-f0-9]+/, "?v=VERSION"), tag.beforeSource.replace(/\?v=[a-f0-9]+/, "?v=VERSION"),
    "The history transaction may change only the existing runtime cache key, without UI attributes");
  const attrs = attributes(tag.afterSource.slice(0, tag.afterSource.indexOf(">") + 1));
  referencedOutput(attrs.get("src"), tag.output, auditedUiDialogsRead(tag.output));
}
function historyStateFragments(source, blocks) {
  for (const block of blocks) {
    const label = block.id || block.output;
    assert.ok(block.afterSource.length, `${label} must retain an exact nonempty state fragment`);
    assert.equal(source.split(block.afterSource).length - 1, 1, `${label} state fragment must occur exactly once`);
    source = source.replace(block.afterSource, block.beforeSource);
  }
  return source;
}
function assertHistoryStateOwnership(source, restored) {
  const strip = text => {
    for (const name of HISTORY_STATE_FUNCTIONS) text = text.replace(auditLogicFunction(text, name, 4), "");
    return text;
  };
  assert.equal(strip(source), strip(restored),
    "History transactions may change only loadTopTideEvent and switchDataMode; other code and declarations remain exact");
}
function auditedHistoryStateRead(relative) {
  const source = auditedUiDialogsRead(relative), file = historyState.files.find(file => file.source === relative);
  if (!file) return source;
  assert.equal(sha256(source), file.afterSha256, `${relative} changed outside the reviewed history transaction`);
  const restored = historyStateFragments(source, file.kind === "document" ? historyState.documentTags : historyState.changes);
  if (file.kind === "script") assertHistoryStateOwnership(source, restored);
  assert.equal(sha256(restored), file.beforeSha256, `${relative} must restore every pre-history-transaction byte`);
  return restored;
}
for (const file of historyState.files) auditedHistoryStateRead(file.source);

// Invert only the reviewed November 2 logic corrections; retain every UI byte.
const AUDIT_LOGIC_PATH = "tools/fixtures/north-wildwood-20261102-audit-logic.json";
const auditLogicText = read(AUDIT_LOGIC_PATH);
assert.equal(sha256(auditLogicText), "0b31eadfe5b91f9b6c2fad977fe07fd1d52b2c2ca3562e5b37dee24d53bec73f", "The logic inverse must retain its exact reviewed fixture");
const auditLogic = JSON.parse(auditLogicText);
assert.equal(auditLogic.schemaVersion, 1);
assert.equal(auditLogic.baselineCommit, "6e97c247867016bbc0c27d60f2841a1f0b65b5b1");
const AUDIT_LOGIC_OWNERS = [
  ["tools/app/runtime/01-physics-manifests.js", ["physicsCycleIdFromUtc", "physicsPointerUrl", "loadPhysicsForecast"], ["physicsCycleIdFromUtc"]],
  ["tools/app/runtime/03-time-series.js", ["getObservedSourceHoursForDay", "buildQuarterHourTimelineSeries"], []],
  ["tools/app/runtime/04-observation-archives.js", ["ensureObservedArchiveForDate", "buildObservedCanonicalSeries"], []],
  ["tools/app/runtime/05-presentation.js", ["setDownloadModalOpen"], []],
  ["tools/app/runtime/21-forecast-and-observed-loading.js", ["addOrMergeObservedDayRecord", "normalizeUsgsIvObservedDays", "fetchRecentUsgsObservedDays", "extendObservedArchiveThroughToday"], []],
  ["tools/app/runtime/22-calendar-and-modes.js", ["loadTopTideEvent"], []],
  ["tools/app/runtime/26-depth-queries.js", ["latLngToPhysicsQueryPixel", "samplePhysicsDepth"], ["latLngToPhysicsQueryPixel"]]
];
const AUDIT_LOGIC_RUNTIME = "assets/app/runtime.js", AUDIT_LOGIC_MODULE = "assets/export-area.js", AUDIT_LOGIC_CITY = "city-gauge/index.html";
const auditLogicRuntimeEntry = manifest.scripts.find(entry => entry.id === "script-004");
assert.equal(auditLogicRuntimeEntry.output, AUDIT_LOGIC_RUNTIME);
for (const [relative] of AUDIT_LOGIC_OWNERS) assert.ok(auditLogicRuntimeEntry.sources.includes(relative));
assert.deepEqual(auditLogic.files.map(file => [file.source, file.kind, file.entryId]), [
  ...AUDIT_LOGIC_OWNERS.map(([relative]) => [relative, "script", "script-004"]),
  [AUDIT_LOGIC_MODULE, "module", null], [AUDIT_LOGIC_CITY, "script-document", null],
  ["tools/app/index.template.html", "template", null], [AUDIT_LOGIC_RUNTIME, "generated", "script-004"], ["index.html", "document", null]
]);
for (const block of auditLogic.changes) {
  const file = auditLogic.files.find(file => file.source === block.source);
  assert.ok(file && ["script", "module", "script-document"].includes(file.kind));
  assert.equal(block.kind, file.kind);assert.equal(block.entryId, file.entryId);
}
assert.deepEqual(auditLogic.documentTags.map(tag => [tag.output, tag.documents]), [
  [AUDIT_LOGIC_RUNTIME, ["index.html"]], [AUDIT_LOGIC_MODULE, ["tools/app/index.template.html", "index.html"]]
]);
for (const tag of auditLogic.documentTags) {
  assert.equal(tag.afterSource.replace(/\?v=[^"']+/, "?v=VERSION"), tag.beforeSource.replace(/\?v=[^"']+/, "?v=VERSION"),
    "Logic fixes may change only the existing runtime/export-area cache keys, without UI attributes");
  const attrs = attributes(tag.afterSource.slice(0, tag.afterSource.indexOf(">") + 1));
  referencedOutput(attrs.get("src"), tag.output,
    tag.output === AUDIT_LOGIC_RUNTIME ? auditedHistoryStateRead(tag.output) : read(tag.output));
}
function auditLogicFragments(source, blocks) {
  for (const block of blocks) {
    const label = block.id || block.output;
    assert.ok(block.afterSource.length, `${label} must retain an exact nonempty logic fragment`);
    assert.equal(source.split(block.afterSource).length - 1, 1, `${label} logic fragment must occur exactly once`);
    source = source.replace(block.afterSource, block.beforeSource);
  }
  return source;
}
function auditLogicFunction(source, name, indent, absent = false) {
  const expression = new RegExp("^" + " ".repeat(indent) + "(?:async )?function " + name + "\\([^\\n]*\\) \\{\\n[^]*?^" + " ".repeat(indent) + "}\\n(?:\\n)?", "gm");
  const matches = [...source.matchAll(expression)];
  assert.equal(matches.length, absent ? 0 : 1, `${name} must retain its one declared logic owner`);
  return matches[0]?.[0] || "";
}
function assertAuditLogicOwnership(relative, source, restored) {
  const owner = AUDIT_LOGIC_OWNERS.find(([path]) => path === relative);
  if (owner) {
    const strip = (text, before) => {
      for (const name of owner[1]) text = text.replace(auditLogicFunction(text, name, 4, before && owner[2].includes(name)), "");
      return text;
    };
    assert.equal(strip(source, false), strip(restored, true), `${relative} may change only its explicitly reviewed functions`);
  } else if (relative === AUDIT_LOGIC_MODULE) {
    const changed = "setDownloadModalOpen(true, { preserveRange: true });", original = "setDownloadModalOpen(true);";
    const functionSource = auditLogicFunction(source, "closePicker", 2);
    assert.equal(functionSource.split(changed).length - 1, 1);
    assert.equal(source.split(changed).length - 1, 1);
    assert.equal(source.replace(changed, original), restored, "The area module may change only its one preserveRange caller option");
  } else if (relative === AUDIT_LOGIC_CITY) {
    const expression = /^    function comparisonSeries\([^\n]*}\n/gm;
    const strip = text => {
      const matches = [...text.matchAll(expression)];assert.equal(matches.length, 1);
      const match = matches[0], start = text.lastIndexOf("<script", match.index), end = text.indexOf("</script>", start);
      assert.ok(start >= 0 && match.index > text.indexOf(">", start) && match.index + match[0].length <= end,
        "The city comparison fix must remain inside its existing script");
      return text.replace(match[0], "");
    };
    assert.equal(strip(source), strip(restored), "Every city dashboard HTML/CSS/UI byte outside comparisonSeries must remain unchanged");
  }
}
function auditLogicExternalDocument(source) {
  return auditLogicFragments(source, auditLogic.documentTags.filter(tag => tag.output === AUDIT_LOGIC_MODULE));
}
function auditedAuditLogicRead(relative) {
  const source = auditedHistoryStateRead(relative), file = auditLogic.files.find(file => file.source === relative);
  if (!file) return source;
  assert.equal(sha256(source), file.afterSha256, `${relative} changed outside the reviewed logic fixes`);
  let blocks;
  if (["document", "template"].includes(file.kind)) blocks = auditLogic.documentTags.filter(tag => tag.documents.includes(relative));
  else blocks = auditLogic.changes.filter(block => file.kind === "generated" ? block.kind === "script" : block.source === relative);
  const restored = auditLogicFragments(source, blocks);
  if (["script", "module", "script-document"].includes(file.kind)) assertAuditLogicOwnership(relative, source, restored);
  assert.equal(sha256(restored), file.beforeSha256, `${relative} must restore every original pre-audit byte`);
  return restored;
}
for (const file of auditLogic.files) auditedAuditLogicRead(file.source);

// Restore only the reviewed tutorial gesture presentation before all prior audits.
const TUTORIAL_GESTURE_PATH = "tools/fixtures/north-wildwood-20261101-tutorial-gesture.json";
const tutorialGestureText = read(TUTORIAL_GESTURE_PATH);
assert.equal(sha256(tutorialGestureText), "347cf4c08aad8f8ce525f3089021241b3424a3282d15392df6502e8a79b900b6",
  "The tutorial gesture inverse must retain its exact reviewed fixture");
const tutorialGesture = JSON.parse(tutorialGestureText);
assert.equal(tutorialGesture.schemaVersion, 1);
assert.equal(tutorialGesture.baselineCommit, "b8fd68830f97d2d08f90d4c7f364410be1b6324e");
const TUTORIAL_GESTURE_SOURCE = "tools/app/runtime/28-tutorial-and-events.js";
const TUTORIAL_GESTURE_OUTPUT = "assets/app/runtime.js";
assert.deepEqual(tutorialGesture.files.map(file => [file.source, file.kind, file.entryId]), [
  [TUTORIAL_GESTURE_SOURCE, "script", "script-004"],
  [TUTORIAL_GESTURE_OUTPUT, "generated", "script-004"],
  ["index.html", "document", null]
]);
assert.deepEqual(tutorialGesture.documentTags.map(tag => tag.output), [TUTORIAL_GESTURE_OUTPUT]);
assert.ok(tutorialGesture.changes.length > 0);
const tutorialEntry = manifest.scripts.find(entry => entry.id === "script-004");
assert.ok(tutorialEntry.sources.includes(TUTORIAL_GESTURE_SOURCE));
assert.equal(tutorialEntry.output, TUTORIAL_GESTURE_OUTPUT);
for (const block of tutorialGesture.changes) {
  assert.equal(block.source, TUTORIAL_GESTURE_SOURCE);
  assert.equal(block.kind, "script");assert.equal(block.entryId, "script-004");
}
for (const tag of tutorialGesture.documentTags) {
  assert.equal(tag.afterSource.replace(/\?v=[a-f0-9]+/, "?v=VERSION"),
    tag.beforeSource.replace(/\?v=[a-f0-9]+/, "?v=VERSION"),
    "Tutorial HTML may update only the existing runtime bundle cache key");
  const actual = attributes(tag.afterSource.slice(0, tag.afterSource.indexOf(">") + 1));
  referencedOutput(actual.get("src"), TUTORIAL_GESTURE_OUTPUT, auditedAuditLogicRead(TUTORIAL_GESTURE_OUTPUT));
}
function tutorialGestureFragments(source, blocks) {
  for (const block of blocks) {
    const label = block.id || block.output;
    assert.ok(block.afterSource.length, `${label} must use an exact nonempty reviewed fragment`);
    assert.equal(source.split(block.afterSource).length - 1, 1,
      `${label} tutorial gesture fragment must occur exactly once`);
    source = source.replace(block.afterSource, block.beforeSource);
  }
  return source;
}
function assertTutorialGestureOwnership(source, restored) {
  const strip = (text, before) => {
    for (const name of ["finishMapperTutorialGesture", "positionMapperTutorial", "renderMapperTutorialStep", "setMapperTutorialOpen", "wireMapperTutorial"]) {
      const expression = new RegExp("^    function " + name + "\\([^\\n]*\\) \\{\\n[^]*?^    }\\n(?:\\n)?", "gm");
      assert.equal([...text.matchAll(expression)].length, before && name === "finishMapperTutorialGesture" ? 0 : 1,
        `${name} must retain its explicit tutorial presentation owner`);
      text = text.replace(expression, "");
    }
    const state = "    const mapperTutorialGesturePointers = new Set();\n" +
      "    let mapperTutorialGestureSettling = false;\n" +
      "    let mapperTutorialGestureTimer = null;\n" +
      "    let mapperTutorialPositionPending = false;\n\n";
    assert.equal(text.split(state).length - 1, before ? 0 : 1,
      "Tutorial gesture state must retain only its four declared presentation fields");
    return text.replace(state, "");
  };
  assert.equal(strip(source, false), strip(restored, true),
    "Tutorial gestures may change only their five declared functions and four state fields");
}
function auditedTutorialGestureRead(relative) {
  const source = auditedAuditLogicRead(relative);
  const file = tutorialGesture.files.find(file => file.source === relative);
  if (!file) return source;
  assert.equal(sha256(source), file.afterSha256, `${relative} changed outside its reviewed tutorial gesture fix`);
  const restored = file.kind === "document"
    ? tutorialGestureFragments(source, tutorialGesture.documentTags)
    : tutorialGestureFragments(source, tutorialGesture.changes);
  if (file.kind !== "document") assertTutorialGestureOwnership(source, restored);
  assert.equal(sha256(restored), file.beforeSha256, `${relative} must restore every pre-tutorial-gesture byte`);
  return restored;
}
for (const file of tutorialGesture.files) auditedTutorialGestureRead(file.source);

// Restore only the reviewed responsive presentation before every prior audit.
const ADAPTIVE_SIDEBAR_PATH = "tools/fixtures/north-wildwood-20261101-adaptive-sidebar.json";
const adaptiveSidebarText = read(ADAPTIVE_SIDEBAR_PATH);
assert.equal(sha256(adaptiveSidebarText), "8e44e6a7c602ae8ed2710c44db1089b32fefa68d20415b207459b473f40217eb",
  "The adaptive sidebar inverse must retain its exact reviewed fixture");
const adaptiveSidebar = JSON.parse(adaptiveSidebarText);
assert.equal(adaptiveSidebar.schemaVersion, 1);
assert.equal(adaptiveSidebar.baselineCommit, "0748bddc9102de3d8e99c1dde071f67a3d632070");
assert.deepEqual(adaptiveSidebar.files.map(file => [file.source, file.kind, file.entryId]), [
  ["tools/app/unified-controller.js", "script", "script-011"],
  ["tools/app/platform.js", "script", "script-003"],
  ["tools/app/styles/style-002.css", "style", "style-002"],
  ["index.html", "document", null]
]);
assert.deepEqual(adaptiveSidebar.documentTags.map(tag => tag.output),
  ["assets/app/platform.js", "assets/app/unified-controller.js", "assets/styles/app-01.css"]);
for (const tag of adaptiveSidebar.documentTags) {
  assert.equal(tag.afterSource.replace(/\?v=[a-f0-9]+/, "?v=VERSION"),
    tag.beforeSource.replace(/\?v=[a-f0-9]+/, "?v=VERSION"),
    "Adaptive HTML may update only the existing bundle content cache keys");
  const actual = attributes(tag.afterSource.slice(0, tag.afterSource.indexOf(">") + 1));
  referencedOutput(actual.get("src") || actual.get("href"), tag.output);
}
function adaptiveSidebarFragments(source, blocks) {
  for (const block of blocks) {
    const label = block.id || block.output;
    assert.ok(block.afterSource.length, `${label} must use an exact nonempty reviewed fragment`);
    assert.equal(source.split(block.afterSource).length - 1, 1,
      `${label} adaptive presentation fragment must occur exactly once`);
    source = source.replace(block.afterSource, block.beforeSource);
  }
  return source;
}
function adaptiveFunction(source, name, optional = false) {
  const expression = new RegExp("^ function " + name + "\\([^\\n]*\\)\\s*\\{\\n[^]*?^ }\\n", "gm");
  const matches = [...source.matchAll(expression)];
  assert.equal(matches.length, optional ? 0 : 1, `${name} must retain its explicit presentation owner`);
  return matches[0]?.[0] || "";
}
function assertAdaptiveOwnership(relative, source, restored) {
  if (relative === "tools/app/unified-controller.js") {
    const strip = (text, before) => {
      for (const name of ["ensureReturnPeriodSelect", "normalize", "layout"]) {
        text = text.replace(adaptiveFunction(text, name, before && name === "ensureReturnPeriodSelect"), "");
      }
      for (const expression of [
        /^ const mobile=matchMedia\([^\n]*\);\n/gm,
        /^ for\(const e of \[panel,rail,timeline,document\.getElementById\('mapTitleBadge'\)[^\n]*geometryObserver\.observe\([^\n]*\);\n/gm,
        /^ (?:new ResizeObserver\(schedule\)\.observe\(timeline\)|const resizeObserver=new ResizeObserver\(schedule\))[^\n]*\n/gm
      ]) {
        assert.equal([...text.matchAll(expression)].length, 1, "Adaptive layout observation must have one declared owner");
        text = text.replace(expression, "");
      }
      const fonts = /^ document\.fonts\?\.ready\.then\(schedule\);[^\n]*\n/gm;
      assert.equal([...text.matchAll(fonts)].length, before ? 0 : 1);
      return text.replace(fonts, "");
    };
    assert.equal(strip(source, false), strip(restored, true),
      "Adaptive presentation may change only its modeled select, normalization, geometry, media and observation owners");
  } else if (relative === "tools/app/platform.js") {
    assert.equal(source.replace('(max-width:900px), (max-height:560px),', '(max-width:900px),'), restored,
      "Platform presentation may add only the short-window drawer media condition");
  } else if (relative === "tools/app/styles/style-002.css") {
    const marker = "\n\n/* Fit the familiar sidebars to shorter desktop windows without scaling text. */";
    assert.equal(source.split(marker).length - 1, 1, "The responsive density stylesheet must have one scoped append");
    let prefix = source.slice(0, source.indexOf(marker));
    prefix = prefix.replaceAll('(max-height:560px) and (pointer:coarse), (max-height:560px) {',
      '(max-height:560px) and (pointer:coarse) {');
    prefix = prefix.replace('(max-height:500px) and (pointer:coarse), (min-width:901px) and (max-height:560px){',
      '(max-height:500px) and (pointer:coarse){');
    assert.equal(prefix, restored,
      "Adaptive CSS may append the reviewed density rules and add only the three short-window media conditions");
  }
}
function auditedAdaptiveSidebarRead(relative) {
  const source = auditedTutorialGestureRead(relative);
  const file = adaptiveSidebar.files.find(file => file.source === relative);
  if (!file) return source;
  assert.equal(sha256(source), file.afterSha256, `${relative} changed outside its reviewed adaptive presentation`);
  let restored;
  if (file.kind === "document") {
    restored = adaptiveSidebarFragments(source, adaptiveSidebar.documentTags);
  } else {
    const blocks = adaptiveSidebar.changes.filter(block => block.source === relative);
    for (const block of blocks) {
      assert.equal(block.kind, file.kind);assert.equal(block.entryId, file.entryId);
      assert.ok(manifest[file.kind + "s"].some(entry => entry.id === block.entryId && entry.sources.includes(relative)));
    }
    restored = adaptiveSidebarFragments(source, blocks);
    assertAdaptiveOwnership(relative, source, restored);
  }
  assert.equal(sha256(restored), file.beforeSha256, `${relative} must restore every pre-adaptive byte`);
  return restored;
}
for (const file of adaptiveSidebar.files) auditedAdaptiveSidebarRead(file.source);

// The fallback fix changes only layout's early length check and its cache key.
// Validate actual bytes/version first, then restore the previous audited inputs.
const ROAD_FALLBACK_PATH = "tools/fixtures/north-wildwood-20261101-road-fallback.json";
const roadFallbackText = read(ROAD_FALLBACK_PATH);
assert.equal(sha256(roadFallbackText), "fa159c746924ad0720100563da32e89bcf08860e20f2ab1407d1510594c3f4e4");
const roadFallback = JSON.parse(roadFallbackText);
assert.equal(roadFallback.schemaVersion, 1);
assert.equal(roadFallback.baselineCommit, "0fbdfc1a3f5ac9d3350cda5fbdb41f3d326ff799");
assert.equal(roadFallback.function, "layout");
assert.equal(roadFallback.module, "assets/export-road-labels.js");
assert.deepEqual(roadFallback.files.map(file => file.source), [roadFallback.module, "tools/app/index.template.html", "index.html"]);
function roadFallbackDocument(source) {
  assert.equal(source.split(roadFallback.afterScriptTag).length - 1, 1, "The fallback renderer must use its reviewed content cache key once");
  return source.replace(roadFallback.afterScriptTag, roadFallback.beforeScriptTag);
}
function auditedRoadFallbackRead(relative) {
  const source = auditedAdaptiveSidebarRead(relative);
  const file = roadFallback.files.find(file => file.source === relative);
  if (!file) return source;
  assert.equal(sha256(source), file.afterSha256, `${relative} changed outside its reviewed fallback fix`);
  let restored;
  if (relative === roadFallback.module) {
    for (const text of [roadFallback.beforeSource, roadFallback.afterSource]) {
      const matches = [...text.matchAll(/^  function layout\([^\n]*\) \{\n[^]*?^  }\n/gm)];
      assert.equal(matches.length, 1);
      assert.equal(matches[0][0], text, "The fallback inverse must cover only layout");
    }
    assert.equal(source.split(roadFallback.afterSource).length - 1, 1);
    restored = source.replace(roadFallback.afterSource, roadFallback.beforeSource);
  } else restored = roadFallbackDocument(source);
  assert.equal(sha256(restored), file.beforeSha256, `${relative} must restore every original fallback byte`);
  return restored;
}
assert.equal(roadFallback.afterScriptTag.replace(/\?v=[a-f0-9]+/, "?v=VERSION"),
  roadFallback.beforeScriptTag.replace(/\?v=[a-f0-9]+/, "?v=VERSION"));
const roadFallbackCacheVersion = roadFallback.afterScriptTag.match(/\?v=([a-f0-9]+)/)?.[1];
assert.equal(roadFallbackCacheVersion, sha256(read(roadFallback.module)).slice(0, 16),
  "The actual fallback cache key must match the actual renderer content");
for (const file of roadFallback.files) auditedRoadFallbackRead(file.source);
// Reverse only the ten reviewed bug-fix functions before all previous audits.
// Full-file pins reject edits beside those functions; older fixtures stay exact.
const REVIEW_FIX_PATH = "tools/fixtures/north-wildwood-20261101-review-fixes.json";
const reviewFixText = read(REVIEW_FIX_PATH);
assert.equal(sha256(reviewFixText), "430555a79159caeeae2496dd73cdfeebd0a668833aa92f627c5d513434c2cf32");
const reviewFix = JSON.parse(reviewFixText);
const REVIEW_FIX_OWNERS = {
  "tools/app/runtime/01-physics-manifests.js": ["loadPhysicsForecast"],
  "tools/app/runtime/19-observed-history.js": ["loadHistoricalTopTides"],
  "tools/app/runtime/21-forecast-and-observed-loading.js": ["loadForecast", "extendObservedArchiveThroughToday", "loadObserved"],
  "tools/app/runtime/23-refresh-and-playback.js": ["warmBackgroundData", "scheduleTopTidesListWarmup", "scheduleForecastCatalogWarmup"],
  "tools/app/runtime/24-alerts-and-projections.js": ["checkNwsAlerts"],
  "tools/app/unified-controller.js": ["selectSection"]
};
assert.equal(reviewFix.schemaVersion, 1);
assert.equal(reviewFix.baselineCommit, "4720fc5b24aec1dde0ccf0ef65f07446c28b3764");
assert.deepEqual(Object.fromEntries(reviewFix.files.map(file => [file.source, file.functions])), REVIEW_FIX_OWNERS);
assert.equal(reviewFix.changes.length, 10);
function reviewFixFragments(source, blocks) {
  for (const block of blocks) {
    const indent = block.source.endsWith("unified-controller.js") ? " " : "    ";
    const expression = new RegExp("^" + indent + "(?:async )?function " + block.function + "\\([^\\n]*\\)\\s*\\{\\n[^]*?^" + indent + "}\\n", "gm");
    for (const text of [block.beforeSource, block.afterSource]) {
      const matches = [...text.matchAll(expression)];
      assert.equal(matches.length, 1, `${block.function} must have exactly one reviewed function owner`);
      assert.equal(matches[0][0], text, `${block.function} must not exempt adjacent code`);
    }
    assert.equal(source.split(block.afterSource).length - 1, 1, `${block.function} must retain its exact reviewed fix once`);
    source = source.replace(block.afterSource, block.beforeSource);
  }
  return source;
}
function auditedReviewFixRead(relative) {
  const source = auditedRoadFallbackRead(relative);
  const file = reviewFix.files.find(file => file.source === relative);
  if (!file) return source;
  const blocks = reviewFix.changes.filter(block => block.source === relative);
  assert.deepEqual(blocks.map(block => block.function), REVIEW_FIX_OWNERS[relative]);
  const entry = manifest.scripts.find(entry => entry.sources.includes(relative));
  for (const block of blocks) {
    assert.equal(block.kind, "script");
    assert.equal(block.entryId, entry.id);
  }
  assert.equal(sha256(source), file.afterSha256, `${relative} changed outside its reviewed bug fixes`);
  const restored = reviewFixFragments(source, blocks);
  assert.equal(sha256(restored), file.beforeSha256, `${relative} must restore every original byte`);
  return restored;
}
for (const file of reviewFix.files) auditedReviewFixRead(file.source);
// Restore this separately pinned road-label presentation delta before the
// previous audits; original terrain, flood, parcel and UI hashes stay exact.
const SCALABLE_ROAD_AUDIT_PATH = "tools/fixtures/north-wildwood-20261030-scalable-road-labels.json";
const SCALABLE_ROAD_AUDIT_SHA256 = "b1d67d07367a78e72ee838f7a2e6b4dbc0620cfe4528792ab7aa549a9ccf993b";
const scalableRoadText = read(SCALABLE_ROAD_AUDIT_PATH);
assert.equal(sha256(scalableRoadText), SCALABLE_ROAD_AUDIT_SHA256,
  "Scalable road labels must retain the exact reviewed inverse and module pin");
const scalableRoadAudit = JSON.parse(scalableRoadText);
const SCALABLE_ROAD_FUNCTIONS = new Map([
  ["tools/app/runtime/10-map-geometry-and-layers.js", ["createRoadLabelLayer"]],
  ["tools/app/runtime/15-export-capture.js", ["waitForExportMapReady"]],
  ["tools/app/runtime/16-export-map.js", ["updateExportRoadLayerAppearance", "captureExportCanvas"]],
  ["tools/app/runtime/17-export-encoding.js", ["captureFastGifBaseCanvas"]],
  ["assets/3d/north-wildwood-3d.js", ["load3dStyle", "syncRoadLabels3d", "addCore3dLayers"]],
  ["tools/app/index.template.html", []],
  ["tools/app/runtime/00-configuration.js", []],
  ["assets/export-road-labels.js", ["layout", "attach"]]
]);
const SCALABLE_ROAD_NEW_FUNCTIONS = ["exportUsesScalableRoadLabels", "exportScalableRoadLabelsEnabled",
  "waitForExportRoadLabelsReady"];
const SCALABLE_ROAD_ATTRIBUTION = ">Map: Esri, HERE, Garmin, USGS, &copy; OpenStreetMap contributors \u00b7 Local road names: NJOGIS</div>";
const SCALABLE_FALLBACK_BEFORE = "    const FALLBACK_BASEMAP_URL = \"https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}\";\n";
const SCALABLE_FALLBACK_AFTER = "    const FALLBACK_BASEMAP_URL = \"https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}\";\n";
const SCALABLE_ROAD_MARKER = "    /* Shorely scalable road-label export integration v1. */\n";
const SCALABLE_3D_RASTER_BLOCK = "    glMap.addSource(\"nw-road-labels-source\", {\n      type: \"raster\",\n      tiles: [ROAD_LABELS_URL.replace(\"{s}\", \"a\")],\n      tileSize: 256,\n      minzoom: 11,\n      maxzoom: 20,\n      attribution: \"&copy; OpenStreetMap contributors &copy; CARTO\"\n    });\n    glMap.addLayer({\n      id: \"nw-road-labels\",\n      type: \"raster\",\n      source: \"nw-road-labels-source\",\n      minzoom: ROAD_LABEL_ZOOM,\n      layout: { visibility: visibility(layerVisible(\"roadsToggle\", true)) },\n      paint: {\n        \"raster-opacity\": 0.98, \"raster-fade-duration\": 0,\n        \"raster-saturation\": -1,\n        \"raster-brightness-min\": 0.3375, \"raster-brightness-max\": 1\n      }\n    });\n";
const SCALABLE_3D_STYLE_COMMENT = "    // Road symbols come from the shared scalable vector style.\n";
assert.equal(scalableRoadAudit.schemaVersion, 1);
assert.equal(scalableRoadAudit.beforeFallback, SCALABLE_FALLBACK_BEFORE);
assert.equal(scalableRoadAudit.afterFallback, SCALABLE_FALLBACK_AFTER);
assert.equal(scalableRoadAudit.baselineCommit, "d78d28560b951c8a0d032b8dd5d51097201b2184");
assert.deepEqual(scalableRoadAudit.functions, Object.fromEntries(SCALABLE_ROAD_FUNCTIONS));
assert.deepEqual(scalableRoadAudit.newFunctions, SCALABLE_ROAD_NEW_FUNCTIONS);
assert.deepEqual(scalableRoadAudit.files.map(file => [file.source, file.kind, file.entryId]), [
  ["tools/app/runtime/10-map-geometry-and-layers.js", "script", "script-004"],
  ["tools/app/runtime/15-export-capture.js", "script", "script-004"],
  ["tools/app/runtime/16-export-map.js", "script", "script-004"],
  ["tools/app/runtime/17-export-encoding.js", "script", "script-004"],
  ["assets/3d/north-wildwood-3d.js", "external", null],
  ["tools/app/index.template.html", "template", null],
  ["tools/app/runtime/00-configuration.js", "script", "script-004"],
  ["assets/export-road-labels.js", "external", null]
]);
assert.deepEqual([...new Set(scalableRoadAudit.changes.map(block => block.source))],
  scalableRoadAudit.files.map(file => file.source));
assert.equal(new Set(scalableRoadAudit.changes.map(block => block.id)).size, 15);
assert.equal(scalableRoadAudit.changes.length, 15);
for (const block of scalableRoadAudit.changes) {
  const file = scalableRoadAudit.files.find(file => file.source === block.source);
  assert.equal(block.kind, file.kind);
  assert.equal(block.entryId, file.entryId);
}
assert.equal(scalableRoadAudit.module.source, "assets/road-labels.js");
const scalableRoadModule = read(scalableRoadAudit.module.source);
assert.equal(Buffer.byteLength(scalableRoadModule), scalableRoadAudit.module.bytes);
assert.equal(sha256(scalableRoadModule), scalableRoadAudit.module.sha256,
  "The shared vector road renderer must retain its reviewed bytes");
new vm.Script(scalableRoadModule, { filename: scalableRoadAudit.module.source });
for (const file of scalableRoadAudit.files) auditedScalableRoadRead(file.source);
new vm.Script(read("assets/3d/north-wildwood-3d.js"), { filename: "assets/3d/north-wildwood-3d.js" });
const PROVIDER_READINESS_AUDIT_PATH = "tools/fixtures/north-wildwood-20261028-export-provider-readiness.json";
const PROVIDER_READINESS_AUDIT_SHA256 = "ca6a957fbbf4f6ff76b0d936a134fae2170a6395aca4eb5b34d95ecc525d3612";
const providerReadinessText = read(PROVIDER_READINESS_AUDIT_PATH);
assert.equal(sha256(providerReadinessText), PROVIDER_READINESS_AUDIT_SHA256,
  "Provider readiness must retain its exact separately reviewed inverse");
const providerReadinessAudit = JSON.parse(providerReadinessText);
assert.equal(providerReadinessAudit.schemaVersion, 1);
assert.equal(providerReadinessAudit.baselineCommit, "d37d186d7e992597704494c8ad0f878f02c9fc64");
assert.equal(providerReadinessAudit.function, "waitForExportRasterLayerReady");
assert.deepEqual(providerReadinessAudit.files.map(file => file.source), ["tools/app/runtime/15-export-capture.js"]);
assert.deepEqual([...new Set(providerReadinessAudit.changes.map(block => block.source))],
  providerReadinessAudit.files.map(file => file.source));
assert.equal(new Set(providerReadinessAudit.changes.map(block => block.id)).size, providerReadinessAudit.changes.length);
for (const block of providerReadinessAudit.changes) {
  assert.equal(block.kind, "script");
  assert.equal(block.entryId, "script-004");
}
for (const file of providerReadinessAudit.files) auditedProviderReadinessRead(file.source);
const LOGO_READINESS_AUDIT_PATH = "tools/fixtures/north-wildwood-20261028-export-logo-readiness.json";
const LOGO_READINESS_AUDIT_SHA256 = "0f573d6c366c50e2e504aeb0e15a212d5d1388cd3c4253fb5fa6a6c98fd26e17";
const logoReadinessText = read(LOGO_READINESS_AUDIT_PATH);
assert.equal(sha256(logoReadinessText), LOGO_READINESS_AUDIT_SHA256,
  "Logo readiness must retain its exact separately reviewed inverse");
const logoReadinessAudit = JSON.parse(logoReadinessText);
assert.equal(logoReadinessAudit.schemaVersion, 1);
assert.equal(logoReadinessAudit.baselineCommit, "8e106aaa99f304a66f262c4f182a4829d21f2184");
assert.equal(logoReadinessAudit.function, "waitForExportChromeReady");
assert.deepEqual(logoReadinessAudit.files.map(file => file.source), ["tools/app/runtime/15-export-capture.js"]);
assert.deepEqual([...new Set(logoReadinessAudit.changes.map(block => block.source))],
  logoReadinessAudit.files.map(file => file.source));
assert.equal(new Set(logoReadinessAudit.changes.map(block => block.id)).size, logoReadinessAudit.changes.length);
for (const block of logoReadinessAudit.changes) {
  assert.equal(block.kind, "script");
  assert.equal(block.entryId, "script-004");
}
for (const file of logoReadinessAudit.files) auditedLogoReadinessRead(file.source);
const PREVIEW_POLISH_AUDIT_PATH = "tools/fixtures/north-wildwood-20261028-export-preview-polish.json";
const PREVIEW_POLISH_AUDIT_SHA256 = "437dc173478053243979a4a340d8626222df60d4fec96989eca9fbeeae97f263";
const previewPolishText = read(PREVIEW_POLISH_AUDIT_PATH);
assert.equal(sha256(previewPolishText), PREVIEW_POLISH_AUDIT_SHA256,
  "Export preview polish must retain its exact separately reviewed inverse and asset pins");
const previewPolishAudit = JSON.parse(previewPolishText);
assert.equal(previewPolishAudit.schemaVersion, 1);
assert.equal(previewPolishAudit.baselineCommit, "4c9a9691a9fe10c036792bec0f765e13a92d5fe6");
const PREVIEW_POLISH_FUNCTIONS = new Map([
  ["assets/export-preview.js", ["sourceId", "previewRequest", "rememberPreview", "previewScale", "publishPreview", "restorePreview",
    "renderReviewStep", "clearCanvas", "schedulePreview", "renderPreview", "startPreview", "init"]],
  ["tools/app/runtime/13-export-range.js", ["getExportFooterLayout"]],
  ["tools/app/runtime/15-export-capture.js", ["waitForExportChromeReady"]],
  ["tools/app/runtime/16-export-map.js", ["updateExportLegend", "captureExportCanvas"]]
]);
const PREVIEW_POLISH_NEW_FUNCTIONS = new Set(["sourceId", "previewRequest", "rememberPreview", "previewScale", "publishPreview", "restorePreview"]);
const PREVIEW_POLISH_DECLARATIONS = "  let activePreviewKey = null;\n  let activePreviewGeneration = null;\n  let displayedPreviewKey = null;\n"
  + "  const previewCache = new Map();\n  const sourceIds = new WeakMap();\n  let nextSourceId = 0;\n";
const PREVIEW_POLISH_RESIZE_LISTENER = '  window.addEventListener?.("resize", schedulePreview);\n';
const PREVIEW_POLISH_SELECTORS = [
  "#exportStageFrame #exportFooter .export-stage-logo",
  "#exportStageFrame #exportFooter .export-stage-logo:only-child",
  "#exportStageFrame #exportFooter .export-depth-key-ends",
  "#exportStageFrame #exportFooter .export-depth-key-ends span",
  "#exportStageFrame #exportFooter .export-depth-key-ends span:nth-child(2):not(:last-child)",
  "#exportStageFrame #exportFooter .export-depth-key-ends-three",
  "#exportStageFrame #exportFooter .export-depth-key-ends-three span:nth-child(2)",
  "#exportStageFrame #exportFooter .export-depth-key-ends-three span:last-child"
];
assert.deepEqual(previewPolishAudit.functions, Object.fromEntries(PREVIEW_POLISH_FUNCTIONS));
assert.equal(previewPolishAudit.previewDeclarations, PREVIEW_POLISH_DECLARATIONS);
assert.equal(previewPolishAudit.previewAssignment, "setDownloadModalOpen");
assert.equal(previewPolishAudit.previewResizeListener, PREVIEW_POLISH_RESIZE_LISTENER);
assert.deepEqual(previewPolishAudit.cssSelectors, PREVIEW_POLISH_SELECTORS);
assert.deepEqual(previewPolishAudit.files.map(file => [file.source, file.kind, file.entryId]), [
  ["assets/export-preview.js", "external", null],
  ["tools/app/runtime/13-export-range.js", "script", "script-004"],
  ["tools/app/runtime/15-export-capture.js", "script", "script-004"],
  ["tools/app/runtime/16-export-map.js", "script", "script-004"],
  ["tools/app/styles/style-081.css", "style", "style-081"],
  ["tools/app/index.template.html", "template", null]
], "Preview polish may cover only the reviewed UI owners and dependency fragments");
assert.deepEqual([...new Set(previewPolishAudit.changes.map(block => block.source))],
  previewPolishAudit.files.map(file => file.source));
assert.equal(new Set(previewPolishAudit.changes.map(block => block.id)).size, previewPolishAudit.changes.length);
for (const block of previewPolishAudit.changes) {
  const file = previewPolishAudit.files.find(file => file.source === block.source);
  assert.equal(block.kind, file.kind);
  assert.equal(block.entryId, file.entryId);
}
assert.deepEqual(previewPolishAudit.assets.map(asset => asset.source), [
  "assets/export-date-time-picker.js", "assets/export-date-time-picker.css", "assets/shorelysafe-logo-export.jpg"
]);
for (const asset of previewPolishAudit.assets) {
  const bytes = asset.source === ARIA_SEMANTICS_PICKER
    ? Buffer.from(readAriaSemanticsReviewed(asset.source), "utf8") : fs.readFileSync(localPath(asset.source));
  assert.equal(bytes.length, asset.bytes, `${asset.source} must retain its reviewed asset byte count`);
  assert.equal(sha256(bytes), asset.sha256, `${asset.source} changed outside the reviewed preview polish`);
  if (asset.source.endsWith(".js")) new vm.Script(bytes.toString("utf8"), { filename: asset.source });
}
const brandAsset = previewPolishAudit.assets[2];
assert.equal(brandAsset.bytes, 366696);
assert.equal(brandAsset.sha256, "d8fc9307306509bc9a94eba64d3ed123abb4d4c953effc66d3824f066aee3801");
for (const file of previewPolishAudit.files) auditedPreviewPolishRead(file.source);
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
const activeRoadLabelTag = scalableRoadAudit.afterLocalScriptTag;
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
const template = auditedRoadFallbackRead("tools/app/index.template.html");
// Prior full-file pins use the inverse, but generated cache checks use actual current bundle tags.
const published = roadFallbackDocument(auditLogicExternalDocument(uiDialogsDocument(read("index.html"))));
assertScalableRoadDocument(template, "Template");
assertScalableRoadDocument(published, "Published HTML");
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
    auditedUiStartupFragments(auditedAdaptiveSidebarRead(uiStartup.cssSource), uiStartup.cssChanges, "Source");
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

// Full-file pins plus independent function ownership make the inverse exact:
// no neighboring source block is exempt, including 3D terrain and buildings.
function scalableRoadFunction(source, name, indent) {
  const expression = new RegExp("^" + indent + "(?:async )?function " + name + "\\([^]*?^" + indent + "}\\n\\n?", "gm");
  const matches = [...source.matchAll(expression)];
  assert.equal(matches.length, 1, `${name} must retain one reviewed owner`);
  return matches[0][0];
}

function auditedScalableRoadRead(relative) {
  const source = auditedReviewFixRead(relative);
  const file = scalableRoadAudit.files.find(file => file.source === relative);
  if (!file) return source;
  const blocks = scalableRoadAudit.changes.filter(block => block.source === relative);
  const restored = auditedIssueFixFragments(source, blocks, relative);
  assert.equal(Buffer.byteLength(source), file.afterBytes);
  assert.equal(Buffer.byteLength(restored), file.beforeBytes);
  assert.equal(sha256(source), file.afterSha256, `${relative} changed outside the reviewed scalable-road delta`);
  assert.equal(sha256(restored), file.beforeSha256, `${relative} must restore every pre-scalable-road byte`);
  const names = SCALABLE_ROAD_FUNCTIONS.get(relative);
  if (names.length) {
    const indent = file.kind === "external" ? "  " : "    ";
    if (relative === "assets/3d/north-wildwood-3d.js") {
      const oldCore = scalableRoadFunction(restored, "addCore3dLayers", indent);
      const newCore = scalableRoadFunction(source, "addCore3dLayers", indent);
      assert.equal(oldCore.split(SCALABLE_3D_RASTER_BLOCK).length - 1, 1);
      assert.equal(oldCore.replace(SCALABLE_3D_RASTER_BLOCK, SCALABLE_3D_STYLE_COMMENT), newCore,
        "3D core changes may replace only the old raster road layer; terrain, boundary and building setup stay exact");
    }
    const strip = (text, before) => {
      for (const name of names) text = text.replace(scalableRoadFunction(text, name, indent), "");
      if (relative.endsWith("16-export-map.js")) {
        for (const name of SCALABLE_ROAD_NEW_FUNCTIONS) {
          if (before) assert.ok(!new RegExp("function " + name + "\\(").test(text));
          else text = text.replace(scalableRoadFunction(text, name, indent), "");
        }
        if (!before) {
          assert.equal(text.split(SCALABLE_ROAD_MARKER).length - 1, 1);
          text = text.replace(SCALABLE_ROAD_MARKER, "");
        }
      }
      return text;
    };
    assert.equal(strip(source, false), strip(restored, true),
      `${relative} may change only the explicitly named road-label functions`);
  } else if (relative.endsWith("00-configuration.js")) {
    assert.equal(source.split(SCALABLE_FALLBACK_AFTER).length - 1, 1);
    assert.equal(source.replace(SCALABLE_FALLBACK_AFTER, SCALABLE_FALLBACK_BEFORE), restored,
      "The fallback change may replace only the labeled street service with unlabeled imagery");
  } else {
    assert.equal(source.replace(scalableRoadAudit.moduleScriptTag + "\n", "")
      .replace(scalableRoadAudit.after3dScriptTag, scalableRoadAudit.before3dScriptTag)
      .replace(scalableRoadAudit.afterLocalScriptTag, scalableRoadAudit.beforeLocalScriptTag), restored,
      "The template may add only the road module and update its two content-dependent consumers");
  }
  return restored;
}

function auditedScalableRoadSource(kind, entry, source) {
  const blocks = scalableRoadAudit.changes.filter(block => block.kind === kind && block.entryId === entry.id);
  for (const block of blocks) {
    assert.ok(entry.sources.includes(block.source), `${block.id} must stay in its declared road-label source`);
    auditedScalableRoadRead(block.source);
  }
  return auditedIssueFixFragments(source, blocks, entry.id);
}

function assertScalableRoadDocument(document, label) {
  assert.equal(document.split(SCALABLE_ROAD_ATTRIBUTION).length - 1, 1, `${label} must retain the active NJOGIS source credit`);
  assert.equal(document.split(scalableRoadAudit.afterLocalScriptTag).length - 1, 1, `${label} must use the current enlarged local-label asset`);
  const tag = scalableRoadAudit.moduleScriptTag;
  assert.equal(document.split(tag).length - 1, 1, `${label} must include the reviewed vector road renderer once`);
  const attrs = attributes(tag.trim().slice(0, tag.trim().indexOf(">") + 1));
  assert.deepEqual([...attrs.keys()], ["src"], "The road renderer must load synchronously before classic runtime initialization");
  assert.equal(new URL(attrs.get("src"), "https://parity.invalid/").pathname, "/assets/road-labels.js");
  const vectorTag = '<script src="https://unpkg.com/esri-leaflet-vector@4.3.2/dist/esri-leaflet-vector.js"></script>';
  assert.equal(document.split(vectorTag + "\n" + tag).length - 1, 1,
    `${label} must load the road renderer immediately after its Esri vector dependency`);
  assert.equal(document.split(scalableRoadAudit.after3dScriptTag).length - 1, 1,
    `${label} must retain the reviewed 3D road consumer cache version`);
}

function auditedProviderReadinessRead(relative) {
  const source = auditedScalableRoadRead(relative);
  const file = providerReadinessAudit.files.find(file => file.source === relative);
  if (!file) return source;
  const restored = auditedIssueFixFragments(source,
    providerReadinessAudit.changes.filter(block => block.source === relative), relative);
  assert.equal(sha256(source), file.afterSha256, `${relative} changed outside the exact provider-readiness diff`);
  assert.equal(sha256(restored), file.beforeSha256, `${relative} must restore every pre-provider-readiness byte`);
  const strip = text => {
    const expression = /^    async function waitForExportRasterLayerReady\([^]*?^    }\n\n?/gm;
    assert.equal([...text.matchAll(expression)].length, 1, "Retain one export raster-ready owner");
    return text.replace(expression, "");
  };
  assert.equal(strip(source), strip(restored), "Provider readiness may alter only waitForExportRasterLayerReady()");
  return restored;
}

function auditedProviderReadinessSource(kind, entry, source) {
  const blocks = providerReadinessAudit.changes.filter(block => block.kind === kind && block.entryId === entry.id);
  for (const block of blocks) {
    assert.ok(entry.sources.includes(block.source), `${block.id} must remain in its declared capture source`);
    auditedProviderReadinessRead(block.source);
  }
  return auditedIssueFixFragments(source, blocks, entry.id);
}

function auditedLogoReadinessRead(relative) {
  const source = auditedProviderReadinessRead(relative);
  const file = logoReadinessAudit.files.find(file => file.source === relative);
  if (!file) return source;
  const restored = auditedIssueFixFragments(source,
    logoReadinessAudit.changes.filter(block => block.source === relative), relative);
  assert.equal(sha256(source), file.afterSha256, `${relative} changed outside the exact logo-readiness diff`);
  assert.equal(sha256(restored), file.beforeSha256, `${relative} must restore every pre-logo-readiness byte`);
  const strip = text => {
    const expression = /^    async function waitForExportChromeReady\([^]*?^    }\n\n?/gm;
    assert.equal([...text.matchAll(expression)].length, 1, "Retain one export chrome-ready owner");
    return text.replace(expression, "");
  };
  assert.equal(strip(source), strip(restored), "Logo readiness may alter only waitForExportChromeReady()");
  return restored;
}

function auditedLogoReadinessSource(kind, entry, source) {
  const blocks = logoReadinessAudit.changes.filter(block => block.kind === kind && block.entryId === entry.id);
  for (const block of blocks) {
    assert.ok(entry.sources.includes(block.source), `${block.id} must remain in its declared capture source`);
    auditedLogoReadinessRead(block.source);
  }
  return auditedIssueFixFragments(source, blocks, entry.id);
}

// Restore the separately reviewed UI polish before every older inverse,
// including the independently pinned external preview init/CSS/markup.
function auditedPreviewPolishRead(relative) {
  const source = auditedLogoReadinessRead(relative);
  const file = previewPolishAudit.files.find(file => file.source === relative);
  if (!file) return source;
  const blocks = previewPolishAudit.changes.filter(block => block.source === relative);
  const restored = auditedIssueFixFragments(source, blocks, relative);
  assert.equal(sha256(source), file.afterSha256, `${relative} changed outside its exact preview-polish diff`);
  assert.equal(sha256(restored), file.beforeSha256, `${relative} must restore every pre-polish byte`);
  const names = PREVIEW_POLISH_FUNCTIONS.get(relative);
  if (names) {
    const strip = (text, before) => {
      const external = relative === "assets/export-preview.js";
      const indent = external ? "  " : "    ";
      for (const name of names) {
        const expression = new RegExp(`^${indent}(?:async )?function ${name}\\([^]*?^${indent}}\\n\\n?`, "gm");
        assert.equal([...text.matchAll(expression)].length,
          before && external && PREVIEW_POLISH_NEW_FUNCTIONS.has(name) ? 0 : 1,
          `${relative} ${name} must retain its explicit UI ownership`);
        text = text.replace(expression, "");
      }
      if (external) {
        const assignment = /^  setDownloadModalOpen = function \([^]*?^  };\n\n?/gm;
        assert.equal([...text.matchAll(assignment)].length, 1, "Preview polish must retain one modal wrapper");
        text = text.replace(assignment, "");
        assert.equal(text.split(PREVIEW_POLISH_DECLARATIONS).length - 1, before ? 0 : 1,
          "Preview polish may add only the reviewed cache declarations");
        text = text.replace(PREVIEW_POLISH_DECLARATIONS, "");
        assert.equal(text.split(PREVIEW_POLISH_RESIZE_LISTENER).length - 1, before ? 0 : 1,
          "Preview polish may add only the reviewed resize registration");
        text = text.replace(PREVIEW_POLISH_RESIZE_LISTENER, "");
      }
      return text;
    };
    assert.equal(strip(source, false), strip(restored, true),
      `${relative} preview polish may change only its explicitly named UI owners`);
  } else if (file.kind === "style") {
    const strip = text => {
      for (const selector of PREVIEW_POLISH_SELECTORS) {
        const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        text = text.replace(new RegExp(`^  ${escaped} \\{[^\\n]*}\\n`, "gm"), "");
      }
      return text;
    };
    assert.equal(strip(source), strip(restored), "Only the reviewed export footer selectors may change");
  } else {
    const strip = text => {
      for (const [name, expression] of [
        ["brand", /<img\b[^>]*\bid="exportPartnerLogo"[^>]*>/g],
        ["attribution", /<div\b[^>]*\bid="exportMapAttribution"[^>]*>[^]*?<\/div>/g],
        ["preview-cache", /<script\b[^>]*\bsrc="(?:\.\/)?assets\/export-preview\.js(?:\?[^"\s]*)?"[^>]*><\/script>/g]
      ]) {
        assert.equal([...text.matchAll(expression)].length, 1, `Retain the ${name} template owner once`);
        text = text.replace(expression, `<!-- UI-POLISH-${name} -->`);
      }
      return text.replace(/^[ \t]*<script\b[^>]*\bsrc="(?:\.\/)?assets\/export-date-time-picker\.js(?:\?[^"\s]*)?"[^>]*><\/script>\n/gm, "")
        .replace(/^[ \t]*<link\b[^>]*\bhref="(?:\.\/)?assets\/export-date-time-picker\.css(?:\?[^"\s]*)?"[^>]*>\n/gm, "");
    };
    assert.equal(strip(source), strip(restored),
      "Preview polish may change only brand/credit markup, preview cache version and the picker dependencies");
  }
  return restored;
}

function auditedPreviewPolishSource(kind, entry, source) {
  const blocks = previewPolishAudit.changes.filter(block => block.kind === kind && block.entryId === entry.id);
  for (const block of blocks) {
    assert.ok(entry.sources.includes(block.source), `${block.id} must remain in its declared UI authoring source`);
    auditedPreviewPolishRead(block.source);
  }
  return auditedIssueFixFragments(source, blocks, entry.id);
}

function auditPreviewPolishDependencies(document, label) {
  const tags = previewPolishAudit.tags;
  assert.equal(tags.preview.before.length, 1);
  assert.equal(tags.preview.after.length, 1);
  assert.equal(tags.pickerScript.before.length, 0);
  assert.equal(tags.pickerScript.after.length, 1);
  assert.equal(tags.pickerStyle.before.length, 0);
  assert.equal(tags.pickerStyle.after.length, 1);
  assert.notEqual(tags.preview.before[0], tags.preview.after[0], "Changed preview code must change its cache version");
  assert.equal(tags.preview.before[0].replace(/\?v=[^"\s]+/, "?v=VERSION"),
    tags.preview.after[0].replace(/\?v=[^"\s]+/, "?v=VERSION"), "Preview cache updates must preserve execution/id attributes");
  for (const [name, assetSource, id] of [
    ["preview", "assets/export-preview.js", "floodmapper-export-preview"],
    ["pickerScript", "assets/export-date-time-picker.js", "floodmapper-export-date-time-picker"],
    ["pickerStyle", "assets/export-date-time-picker.css", null]
  ]) {
    const tag = tags[name].after[0];
    assert.equal(document.split(tag).length - 1, 1, `${label} must retain the exact ${name} dependency once`);
    const attrs = attributes(tag.slice(0, tag.indexOf(">") + 1));
    const attribute = id ? "src" : "href";
    if (id) {
      assert.ok(attrs.has("defer"), `${name} must not block startup`);
      assert.equal(attrs.get("id"), id);
      assert.equal(attrs.size, 3);
    } else {
      assert.equal(attrs.get("rel"), "stylesheet");
      assert.equal(attrs.size, 2);
    }
    const url = new URL(attrs.get(attribute), "https://parity.invalid/");
    assert.equal(url.pathname, "/" + assetSource);
    const asset = previewPolishAudit.assets.find(asset => asset.source === assetSource)
      || previewPolishAudit.files.find(file => file.source === assetSource);
    assert.equal(url.searchParams.get("v"), (asset.sha256 || asset.afterSha256).slice(0, 16),
      `${name} must reference the actual reviewed content version`);
  }
  assert.ok(document.indexOf(tags.pickerScript.after[0]) > document.indexOf(tags.preview.after[0]),
    `${label} picker initialization must follow the deferred preview initializer`);
}

// Reusing an owned, ready export image is a separate runtime-only follow-up.
// Invert its exact contextual diff before the unchanged feature/placement
// audits, and prove that all neighboring rendering and scientific code stays
// identical to the independently pinned application baseline.
function auditedFrameReuseRead(relative) {
  const source = auditedPreviewPolishRead(relative);
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
  source = cloneCleanupFragments(source, cloneCleanup.changes.filter(block => block.kind === kind && block.entryId === entry.id));
  source = uiDialogsFragments(source, uiDialogs.changes.filter(block => block.kind === kind && block.entryId === entry.id));
  source = historyStateFragments(source, historyState.changes.filter(block => block.kind === kind && block.entryId === entry.id));
  source = auditLogicFragments(source, auditLogic.changes.filter(block => block.kind === kind && block.entryId === entry.id));
  source = tutorialGestureFragments(source, tutorialGesture.changes.filter(block => block.kind === kind && block.entryId === entry.id));
  source = adaptiveSidebarFragments(source, adaptiveSidebar.changes.filter(block => block.kind === kind && block.entryId === entry.id));
  source = reviewFixFragments(source, reviewFix.changes.filter(block => block.kind === kind && block.entryId === entry.id));
  source = auditedScalableRoadSource(kind, entry, source);
  source = auditedProviderReadinessSource(kind, entry, source);
  source = auditedLogoReadinessSource(kind, entry, source);
  source = auditedPreviewPolishSource(kind, entry, source);
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
auditPreviewPolishDependencies(template, "Source template");
auditPreviewPolishDependencies(published, "Generated HTML");
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
referencedOutput(placementAttributes.get("src"), roadLabelAudit.module.source, auditedRoadFallbackRead(roadLabelAudit.module.source));
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

console.log(`North Wildwood source parity passed: ${styleEntries.length} CSS blocks in ${seenStyleOutputs.size} bundles and ${compiled} classic scripts retain original hashes after exact audited calendar/export-presentation/boundary-startup/pane-startup/UI-startup/view-pill-surface/loader-restore/font-family/October-26/October-27-fixes/October-28-export-road-labels/placement/frame-reuse/October-30-scalable-road-labels inverses; remaining UI DOM and dependency order remain exact.`);

if (process.argv.includes("--self-test")) {
  const readActual = readBeforeLineAudit;
  const readRaw = readActual;
  const read = readActual;
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
      PREVIEW_POLISH_AUDIT_PATH, ...previewPolishAudit.assets.map(asset => asset.source),
      LOGO_READINESS_AUDIT_PATH, PROVIDER_READINESS_AUDIT_PATH,
      SCALABLE_ROAD_AUDIT_PATH, scalableRoadAudit.module.source, "assets/3d/north-wildwood-3d.js", REVIEW_FIX_PATH, ROAD_FALLBACK_PATH, ADAPTIVE_SIDEBAR_PATH, TUTORIAL_GESTURE_PATH, AUDIT_LOGIC_PATH, AUDIT_LOGIC_MODULE, AUDIT_LOGIC_CITY, HISTORY_STATE_PATH, UI_DIALOGS_PATH, CLONE_CLEANUP_PATH, DEEP_REVIEW_PATH, ARIA_SEMANTICS_PATH, ARIA_SEMANTICS_PICKER,
      boundaryStartup.featureSource, FOLLOWUP_PATH, RECHECK_PATH, ...recheck.files.map(file => file.source), CAMERAS_3D_PATH, ...cameras3d.files.map(file => file.source), LABEL_CASE_PATH, ...labelCase.files.map(file => file.source), PROJECTION_NOTE_PATH, ...projectionNote.files.map(file => file.source),
      OVERNIGHT_PATH, ...overnight.files.map(file => file.source), ...overnight.added.map(file => file.source),
      BUILDING_VIEW_PATH, ...buildingView.files.map(file => file.source),
      LINE_AUDIT_PATH, ...lineAudit.files.map(file => file.source), "index.html"]) {
      const destination = path.join(scratch, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.cpSync(localPath(relative), destination, { recursive: true });
    }
    const run = (args = []) => spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...args], {
      env: { ...process.env, NWW_PARITY_ROOT: scratch }, encoding: "utf8"
    });
    assert.equal(run().status, 0, "The unmodified scratch copy must pass before mutation checks");
    const assertMutationsRejected = (cases, check) => {
      for (const [name, target, altered] of cases) {
        const before = fs.readFileSync(target);
        assert.notDeepEqual(Buffer.from(altered), before, `${name}: the mutation must change its target`);
        fs.writeFileSync(target, altered);
        const result = check();
        fs.writeFileSync(target, before);
        assert.equal(result.error, undefined, `${name}: checker must execute successfully`);
        assert.notEqual(result.status, 0, `${name}: parity checker failed to reject the mutation`);
        assert.match(result.stderr, /AssertionError/, `${name}: rejection must come from a parity assertion`);
      }
    };
    assertMutationsRejected([
      ["altered the overnight inverse", path.join(scratch, OVERNIGHT_PATH), overnightText + " "],
      ...overnight.files.map(file => [
        `unreviewed overnight byte in ${file.source}`, path.join(scratch, file.source), readBytes(file.source).toString("utf8") + "\n"
      ]),
      ...overnight.added.map(file => [
        `unreviewed new overnight asset ${file.source}`, path.join(scratch, file.source), Buffer.concat([readBytes(file.source), Buffer.from([0])])
      ])
    ], run);
    for (const file of overnight.files) {
      fs.writeFileSync(path.join(scratch, file.source), readBeforeOvernight(file.source));
    }
    const runBeforeOvernight = () => run(["--prior-overnight-snapshot"]);
    assert.equal(runBeforeOvernight().status, 0, "The restored pre-overnight snapshot must pass");
    assertMutationsRejected([
      ["altered the building view inverse", path.join(scratch, BUILDING_VIEW_PATH), buildingViewText + " "],
      ...buildingView.files.map(file => [
        `unreviewed byte in ${file.source}`, path.join(scratch, file.source), readCurrent(file.source) + "\n"
      ])
    ], runBeforeOvernight);
    for (const file of buildingView.files) {
      fs.writeFileSync(path.join(scratch, file.source), readBeforeBuildingView(file.source));
    }
    const runLineAudit = () => run(["--prior-building-view-snapshot"]);
    const lineAuditCases = [
      ["altered the line audit inverse", path.join(scratch, LINE_AUDIT_PATH), lineAuditText + " "],
      ...lineAudit.files.flatMap(file => {
        const current = readBeforeBuildingView(file.source), target = path.join(scratch, file.source);
        return [
          [`unreviewed byte in ${file.source}`, target, current + "\n"],
          ...file.changes.map((change, index) => [
            `reverted line audit fragment ${file.source}:${index + 1}`,
            target, current.replace(change.afterSource, change.beforeSource)
          ])
        ];
      })
    ];
    assertMutationsRejected(lineAuditCases, runLineAudit);
    assert.equal(runLineAudit().status, 0, "Restoring audited artifacts must restore a passing check");

    // Run historical mutations against the byte-exact snapshot they originally targeted.
    for (const file of lineAudit.files) {
      fs.writeFileSync(path.join(scratch, file.source), readBeforeLineAudit(file.source));
    }
    const runPrior = () => run(["--prior-mutation-snapshot"]);
    assert.equal(runPrior().status, 0, "The restored pre-audit snapshot must pass before historical mutations");
    const template = read("tools/app/index.template.html"), published = read("index.html");
    const activeRoadLabelTag = roadFallback.afterScriptTag;
    const currentDependencyTag = output => [...template.matchAll(/<script[^>]+src="([^"]+)"[^>]*><\/script>/g)].find(match => new URL(match[1], "https://followup.invalid/").pathname.slice(1) === output)?.[0];
    const active3dTag = currentDependencyTag(DEEP_3D), activeAreaTag = currentDependencyTag(AUDIT_LOGIC_MODULE);
    const activePickerTag = ariaSemantics.documentTags[0].afterSource;
    const scratchHtml = path.join(scratch, "index.html");
    const scriptTags = Array.from(published.matchAll(/<script\b[^>]*data-nww-script[^>]*><\/script>/g), match => match[0]);
    const styleTags = Array.from(published.matchAll(/<link\b[^>]*data-nww-style-bundle[^>]*>/g), match => match[0]);
    const activeRuntimeTag = scriptTags.find(tag => tag.includes("assets/app/runtime.js?"));
    const captureSource = read(CLONE_CLEANUP_SOURCE);
    const deepFunctionCase = (name, relative, owner, mutate) => {
      const source = read(relative), block = deepReviewed.changes.find(block => block.source === relative && block.functionOwner === owner);
      assert.ok(block, `${name}: a mutation must name one reviewed function`);
      const owned = deepOwnedFunction(source, owner, relative === DEEP_3D ? 2 : 4);
      return [name, path.join(scratch, relative), source.replace(owned, mutate(owned, block))];
    };
    const deepCases = [
      ["broadened deep-fix owner list", path.join(scratch, DEEP_REVIEW_PATH),
        JSON.stringify({...deepReviewed, changes:[...deepReviewed.changes, {...deepReviewed.changes[0], source:"tools/app/runtime/00-configuration.js"}]})],
      deepFunctionCase("lost native daily-peak hydraulic context", DEEP_OWNERS[0][0], "buildObservedDailyMaximumSeries",
        source => source.replace('"hydraulicAntecedents"', '"unreviewedAntecedents"')),
      deepFunctionCase("lost prior-year archive context", DEEP_OWNERS[1][0], "ensureObservedArchiveForDate",
        source => source.replace('[previousDate, nextDate]', '[nextDate]')),
      deepFunctionCase("omitted first export-day archive context", DEEP_OWNERS[1][0], "ensureObservedArchiveRange",
        source => source.replace('await ensureObservedArchiveForDate(startKey < endKey ? startKey : endKey);', '')),
      deepFunctionCase("lost preceding crest at midnight", DEEP_OWNERS[1][0], "buildObservedCanonicalSeries",
        source => source.replace('source = preceding.concat(source);', 'source = source;')),
      deepFunctionCase("crossed historical gauge identity", DEEP_OWNERS[1][0], "buildObservedCanonicalSeries",
        source => source.replace('Boolean(previousDay.isLewesSurrogate) === Boolean(dayRecord?.isLewesSurrogate)', 'true')),
      deepFunctionCase("dropped historical reannotation antecedents", DEEP_OWNERS[2][0], "annotateHydraulicSeries",
        source => source.replace('const rows = antecedents.concat(selected);', 'const rows = selected;')),
      deepFunctionCase("dropped draining retention antecedents", DEEP_OWNERS[3][0], "getDrainageRetentionMilestones",
        source => source.replace('const rows = antecedents.concat(visible)', 'const rows = visible')),
      deepFunctionCase("restored fractional-hour summary overcount", DEEP_OWNERS[4][0], "getDownloadRangeSummaryFrameCount",
        (source, block) => block.beforeSource),
      deepFunctionCase("allowed an hourly frame before the selected start", DEEP_OWNERS[5][0], "buildHourlyRangeFrameItems",
        source => source.replace('time >= range.startMs && ', '')),
      deepFunctionCase("anchored hourly exports to a fractional start", DEEP_OWNERS[5][0], "buildHourlyRangeFrameItems",
        source => source.replace('Math.ceil(range.startMs / hourMs) * hourMs', 'range.startMs')),
      deepFunctionCase("lost pending observed selection ownership", DEEP_OWNERS[6][0], "loadObservedDay",
        source => source.replace('loadObservedDay.pendingSelection = { generation, dateStr };', '')),
      deepFunctionCase("cancelled a pending observed day on cadence choice", DEEP_OWNERS[6][0], "setTimelineIntervalMinutes",
        source => source.replace('observedSelectionPending || ', '')),
      deepFunctionCase("lost pending observed-mode generation", DEEP_OWNERS[6][0], "switchDataMode",
        source => source.replace('switchDataMode.pendingObservedSelectionGeneration = generation;', '')),
      deepFunctionCase("overwrote building-layer interaction ownership", DEEP_OWNERS[7][0], "setNsiStructuresEnabled",
        (source, block) => block.beforeSource),
      deepFunctionCase("tied parcel metadata to image success", DEEP_OWNERS[7][0], "ensureParcelAssets",
        (source, block) => block.beforeSource),
      deepFunctionCase("accepted an undecoded parcel boundary", DEEP_OWNERS[7][0], "loadParcelBoundaryLayer",
        source => source.replace('await image.decode();', 'void image.decode();')),
      deepFunctionCase("allowed a stale parcel error to evict its replacement", DEEP_OWNERS[7][0], "loadParcelBoundaryLayer",
        source => source.replace('if (parcelsLayer === layer) parcelsLayer = null;', 'parcelsLayer = null;')),
      deepFunctionCase("skipped parcel boundary readiness", DEEP_OWNERS[7][0], "setParcelsEnabled",
        source => source.replace('await loadParcelBoundaryLayer(layer);', '')),
      deepFunctionCase("prevented retry of a failed 3D image", DEEP_3D, "updateImageLayer",
        source => source.replace(' || options.reload === true', '')),
      deepFunctionCase("used a clipped rendered roof for property lookup", DEEP_3D, "resolveClickedBuildingParcel3d",
        source => source.replace('var feature = fullFeatures[0],', 'var feature = renderedFeature,')),
      deepFunctionCase("accepted overlapping roof-to-parcel identities", DEEP_3D, "resolveClickedBuildingParcel3d",
        source => source.replace('if (candidates.length === 1)', 'if (candidates.length >= 1)')),
      deepFunctionCase("omitted the 3D parcel source retry request", DEEP_3D, "setParcelsEnabled=",
        source => source.replace('syncParcels3d(Boolean(arguments[0]));', 'syncParcels3d();')),
      ["added an unreviewed deep-fix global", path.join(scratch, DEEP_OWNERS[0][0]), read(DEEP_OWNERS[0][0]) + '\nvar unreviewedDeepGlobal = true;\n'],
      ["stale generated deep export function", path.join(scratch, DEEP_RUNTIME),
        read(DEEP_RUNTIME).replace(deepReviewed.changes.find(block => block.functionOwner === 'buildHourlyRangeFrameItems').afterSource,
          deepReviewed.changes.find(block => block.functionOwner === 'buildHourlyRangeFrameItems').beforeSource)],
      ["stale deep runtime content key", scratchHtml,
        published.replace(activeRuntimeTag, deepReviewed.documentTags[0].beforeSource)],
      ["omitted deep 3D cache key from template", path.join(scratch, DEEP_TEMPLATE),
        template.replace(active3dTag, deepReviewed.documentTags[1].beforeSource)],
      ["stale deep 3D cache key in published HTML", scratchHtml,
        published.replace(active3dTag, active3dTag.replace(/&deep=[a-f0-9]{16}/, '&deep=0000000000000000'))],
      ["changed visible labels with deep fixes", scratchHtml, published.replace('>Export Map</button>', '>Unreviewed export text</button>')]
    ];
    assert.equal(deepCases.length, 29, "Retain the deep data/state, renderer, cache and UI boundary mutations");
    const cloneCleanupCases = [
      ["broadened clone-cleanup inverse ownership", path.join(scratch, CLONE_CLEANUP_PATH),
        JSON.stringify({ ...cloneCleanup, changes: [...cloneCleanup.changes, { ...cloneCleanup.changes[0], source: "tools/app/runtime/00-configuration.js" }] })],
      ["released the returned capture canvas", path.join(scratch, CLONE_CLEANUP_SOURCE),
        captureSource.replace("canvas !== result && ", "")],
      ["released the caller-supplied canvas", path.join(scratch, CLONE_CLEANUP_SOURCE),
        captureSource.replace("canvas !== options.canvas && ", "")],
      ["accepted a frame from another source document", path.join(scratch, CLONE_CLEANUP_SOURCE),
        captureSource.replace("frame?.ownerDocument === sourceDocument", "frame?.ownerDocument !== sourceDocument")],
      ["accepted the live document as a capture clone", path.join(scratch, CLONE_CLEANUP_SOURCE),
        captureSource.replace("clone && clone !== sourceDocument", "clone")],
      ["skipped cloned canvas buffer release", path.join(scratch, CLONE_CLEANUP_SOURCE),
        captureSource.replace("canvas.width = canvas.height = 1;", "void canvas;")],
      ["missed canvases added by onclone", path.join(scratch, CLONE_CLEANUP_SOURCE),
        captureSource.replace('          clonedDocument.querySelectorAll("canvas").forEach(canvas => clonedCanvases.add(canvas));\n', "")],
      ["dropped the caller onclone promise", path.join(scratch, CLONE_CLEANUP_SOURCE),
        captureSource.replace('if (typeof onclone === "function") return onclone(clone, clonedElement);',
          'if (typeof onclone === "function") void onclone(clone, clonedElement);')],
      ["changed existing capture scale with cleanup", path.join(scratch, CLONE_CLEANUP_SOURCE),
        captureSource.replace("scale: captureScale", "scale: captureScale * 2")],
      ["bypassed cleanup in the main capture caller", path.join(scratch, CLONE_CLEANUP_SOURCE),
        captureSource.replace(cloneCleanup.changes[1].afterSource, cloneCleanup.changes[1].beforeSource)],
      ["bypassed cleanup in the layer capture caller", path.join(scratch, CLONE_CLEANUP_SOURCE),
        captureSource.replace(cloneCleanup.changes[2].afterSource, cloneCleanup.changes[2].beforeSource)],
      ["added an unreviewed capture declaration", path.join(scratch, CLONE_CLEANUP_SOURCE),
        captureSource + "\n    const unreviewedCaptureStorage = [];\n"],
      ["omitted cleanup from the generated runtime", path.join(scratch, CLONE_CLEANUP_RUNTIME),
        read(CLONE_CLEANUP_RUNTIME).replace(cloneCleanup.changes[0].afterSource, "")],
      ["retained the pre-cleanup runtime cache key", scratchHtml,
        published.replace(activeRuntimeTag, cloneCleanup.documentTags[0].beforeSource)],
      ["removed the owned-frame cleanup guard", path.join(scratch, CLONE_CLEANUP_SOURCE),
        captureSource.replace("if (clonedFrame?.contentDocument === clonedDocument)", "if (clonedFrame)")],
      ["changed visible export wording with clone cleanup", scratchHtml,
        published.replace(">Export Map</button>", ">Unreviewed export label</button>")],
    ];
    assert.equal(cloneCleanupCases.length, 16, "Retain all sixteen owned-clone/capture/UI boundary mutations");
    const uiDialogCases = [
      ["broadened dialog inverse ownership", path.join(scratch, UI_DIALOGS_PATH),
        JSON.stringify({ ...uiDialogs, changes: [...uiDialogs.changes, { ...uiDialogs.changes[0], source: "tools/app/runtime/00-configuration.js" }] })],
      ["dropped overlay accessible state", path.join(scratch, UI_DIALOGS_OWNERS[0][0]),
        read(UI_DIALOGS_OWNERS[0][0]).replace('      document.getElementById("depthModeBtn").setAttribute("aria-pressed", String(currentOverlayMode === "depth"));\n', "")],
      ["wrong data-mode accessible state", path.join(scratch, UI_DIALOGS_OWNERS[0][0]),
        read(UI_DIALOGS_OWNERS[0][0]).replace('setAttribute("aria-pressed", String(currentDataMode === "forecast"))', 'setAttribute("aria-pressed", String(currentDataMode === "observed"))')],
      ["removed optional modeled accessible-state guard", path.join(scratch, UI_DIALOGS_OWNERS[0][0]),
        read(UI_DIALOGS_OWNERS[0][0]).replace('getElementById("returnIntervalDataBtn")?.setAttribute', 'getElementById("returnIntervalDataBtn").setAttribute')],
      ["wrong initial selected mode", path.join(scratch, UI_DIALOGS_TEMPLATE),
        template.replace(uiDialogsTemplateBlocks[0].afterSource, uiDialogsTemplateBlocks[0].afterSource.replace('aria-pressed="true"', 'aria-pressed="false"'))],
      ["changed visible mode label with accessibility fix", path.join(scratch, UI_DIALOGS_TEMPLATE),
        template.replace(">Flood Depth</button>", ">Unreviewed depth label</button>")],
      ["warning hidden below desktop export", path.join(scratch, UI_DIALOGS_STYLE),
        read(UI_DIALOGS_STYLE).replace(UI_DIALOGS_RULE, UI_DIALOGS_RULE.replace("7300", "6000"))],
      ["unreviewed warning visual style", path.join(scratch, UI_DIALOGS_STYLE),
        read(UI_DIALOGS_STYLE).replace(UI_DIALOGS_RULE, UI_DIALOGS_RULE.replace("z-index:7300;", "z-index:7300; opacity:0;"))],
      ["unrelated CSS added beside warning layer", path.join(scratch, UI_DIALOGS_STYLE),
        read(UI_DIALOGS_STYLE) + "\n#leftPanel{width:200px!important}\n"],
      ["wrong nested warning visibility guard", path.join(scratch, UI_DIALOGS_OWNERS[1][0]),
        read(UI_DIALOGS_OWNERS[1][0]).replace("rangeWarning && !rangeWarning.hidden", "rangeWarning && rangeWarning.hidden")],
      ["dropped nested Escape propagation stop", path.join(scratch, UI_DIALOGS_OWNERS[1][0]),
        read(UI_DIALOGS_OWNERS[1][0]).replace("            e.stopImmediatePropagation();\n", "")],
      ["unrelated code beside dialog owner", path.join(scratch, UI_DIALOGS_OWNERS[1][0]),
        read(UI_DIALOGS_OWNERS[1][0]) + "\n// Unreviewed adjacent dialog code\n"],
      ["changed generated dialog runtime", path.join(scratch, UI_DIALOGS_RUNTIME),
        read(UI_DIALOGS_RUNTIME) + "\n// Unreviewed generated dialog code\n"],
      ["changed generated dialog CSS", path.join(scratch, UI_DIALOGS_CSS),
        read(UI_DIALOGS_CSS) + "\nbody{font-family:Arial}\n"],
      ["stale dialog runtime cache key", scratchHtml,
        published.replace(activeRuntimeTag, uiDialogs.documentTags[0].beforeSource)],
      ["stale dialog CSS cache key", scratchHtml,
        published.replace(uiDialogs.documentTags[1].afterSource, uiDialogs.documentTags[1].beforeSource)],
    ];
    assert.equal(uiDialogCases.length, 16, "Retain all sixteen dialog/accessibility/UI boundary mutations");
    const cases = [
      ...cloneCleanupCases,
      ...uiDialogCases,
      ["broadened history transaction ownership", path.join(scratch, HISTORY_STATE_PATH),
        JSON.stringify({ ...historyState, changes: [...historyState.changes, { ...historyState.changes[0], source: "tools/app/runtime/00-configuration.js" }] })],
      ["committed observed mode before historical archive wait", path.join(scratch, HISTORY_STATE_SOURCE),
        read(HISTORY_STATE_SOURCE).replace("      if (!observedData) await warmBackgroundData();", '      currentDataMode = "observed";\n      if (!observedData) await warmBackgroundData();')],
      ["dropped pending historical selection owner", path.join(scratch, HISTORY_STATE_SOURCE),
        read(HISTORY_STATE_SOURCE).replace("loadTopTideEvent.pendingSelectionGeneration = generation;", "loadTopTideEvent.pendingSelectionGeneration = null;")],
      ["ignored active-mode historical cancellation", path.join(scratch, HISTORY_STATE_SOURCE),
        read(HISTORY_STATE_SOURCE).replace("&& loadTopTideEvent.pendingSelectionGeneration !== selectionGeneration) return;", "&& loadTopTideEvent.pendingSelectionGeneration !== selectionGeneration || true) return;")],
      ["cleared another historical selection owner", path.join(scratch, HISTORY_STATE_SOURCE),
        read(HISTORY_STATE_SOURCE).replace("if (loadTopTideEvent.pendingSelectionGeneration === generation) {", "if (true) {")],
      ["dropped historical wait selection generation guard", path.join(scratch, HISTORY_STATE_SOURCE),
        read(HISTORY_STATE_SOURCE).replace("      if (!observedData) await warmBackgroundData();\n      if (generation !== selectionGeneration) return false;", "      if (!observedData) await warmBackgroundData();")],
      ["dropped historical mode button commit", path.join(scratch, HISTORY_STATE_SOURCE),
        read(HISTORY_STATE_SOURCE).replace('      currentBaseModeBeforeTopTide = currentDataMode;\n      currentDataMode = "observed";\n      updateDataModeButtons();', '      currentBaseModeBeforeTopTide = currentDataMode;\n      currentDataMode = "observed";')],
      ["changed source beside history transaction owners", path.join(scratch, HISTORY_STATE_SOURCE),
        read(HISTORY_STATE_SOURCE) + "\n// Unreviewed adjacent history change\n"],
      ["changed generated history transaction runtime", path.join(scratch, HISTORY_STATE_OUTPUT),
        read(HISTORY_STATE_OUTPUT) + "\n// Unreviewed generated history change\n"],
      ["stale history transaction runtime cache key", scratchHtml,
        published.replace(activeRuntimeTag, historyState.documentTags[0].beforeSource)],
      ["changed UI markup during history transaction fix", path.join(scratch, "tools/app/index.template.html"),
        template.replace("<h2>Forecast range</h2>", "<h2>Unreviewed history interface</h2>")],
      ["changed UI font during history transaction fix", path.join(scratch, "tools/app/styles/style-002.css"),
        read("tools/app/styles/style-002.css").replace("--sidebar-text:12px", "--sidebar-text:10px")],
      ["broadened audit logic ownership", path.join(scratch, AUDIT_LOGIC_PATH),
        JSON.stringify({ ...auditLogic, changes: [...auditLogic.changes, { ...auditLogic.changes[0], source: "tools/app/runtime/02-data-and-datums.js" }] })],
      ["dropped physics cycle minute guard", path.join(scratch, AUDIT_LOGIC_OWNERS[0][0]),
        read(AUDIT_LOGIC_OWNERS[0][0]).replace("if (cycle.getUTCMinutes() || cycle.getUTCSeconds() || cycle.getUTCMilliseconds())", "if (cycle.getUTCSeconds() || cycle.getUTCMilliseconds())")],
      ["changed physics manifest CRS guard", path.join(scratch, AUDIT_LOGIC_OWNERS[0][0]),
        read(AUDIT_LOGIC_OWNERS[0][0]).replace('manifest?.image?.crs !== "EPSG:3857"', 'manifest?.image?.crs !== "EPSG:4326"')],
      ["dropped exact live observation anchor guard", path.join(scratch, AUDIT_LOGIC_OWNERS[1][0]),
        read(AUDIT_LOGIC_OWNERS[1][0]).replace("if (options.requireExactSamples && item.t !== slot) return;", "if (false) return;")],
      ["changed observed refresh identity guard", path.join(scratch, AUDIT_LOGIC_OWNERS[4][0]),
        read(AUDIT_LOGIC_OWNERS[4][0]).replace("archive !== observedData", "archive === observedData")],
      ["dropped area return range preservation", path.join(scratch, AUDIT_LOGIC_MODULE),
        read(AUDIT_LOGIC_MODULE).replace("setDownloadModalOpen(true, { preserveRange: true });", "setDownloadModalOpen(true, { preserveRange: false });")],
      ["changed comparison gap sampling", path.join(scratch, AUDIT_LOGIC_CITY),
        read(AUDIT_LOGIC_CITY).replace("step=count<=pixelWidth*4?1:", "step=count<=pixelWidth*4?2:")],
      ["restored linear latitude physics query", path.join(scratch, AUDIT_LOGIC_OWNERS[6][0]),
        read(AUDIT_LOGIC_OWNERS[6][0]).replace("(mercY(north) - mercY(lat)) / (mercY(north) - mercY(south))", "(north - lat) / (north - south)")],
      ["changed adjacent audited runtime source", path.join(scratch, AUDIT_LOGIC_OWNERS[6][0]),
        read(AUDIT_LOGIC_OWNERS[6][0]) + "\n// Unreviewed adjacent logic change\n"],
      ["changed generated audited runtime", path.join(scratch, AUDIT_LOGIC_RUNTIME),
        read(AUDIT_LOGIC_RUNTIME) + "\n// Unreviewed generated logic change\n"],
      ["changed export area beside approved caller", path.join(scratch, AUDIT_LOGIC_MODULE),
        read(AUDIT_LOGIC_MODULE) + "\n// Unreviewed area module change\n"],
      ["stale audit runtime cache key", scratchHtml,
        published.replace(activeRuntimeTag, auditLogic.documentTags[0].beforeSource)],
      ["stale export-area source cache key", path.join(scratch, "tools/app/index.template.html"),
        template.replace(activeAreaTag, auditLogic.documentTags[1].beforeSource)],
      ["changed UI font during logic audit", path.join(scratch, "tools/app/styles/style-002.css"),
        read("tools/app/styles/style-002.css").replace("--sidebar-text:12px", "--sidebar-text:11px")],
      ["changed mapper UI label during logic audit", path.join(scratch, "tools/app/index.template.html"),
        template.replace("<h2>Forecast range</h2>", "<h2>Unreviewed forecast</h2>")],
      ["changed city UI title beside script fix", path.join(scratch, AUDIT_LOGIC_CITY),
        read(AUDIT_LOGIC_CITY).replace("<title>", "<title>Unreviewed ")],
      ["broadened tutorial gesture inverse", path.join(scratch, TUTORIAL_GESTURE_PATH),
        JSON.stringify({ ...tutorialGesture, changes: [...tutorialGesture.changes, tutorialGesture.changes[0]] })],
      ["disabled tutorial gesture guard", path.join(scratch, TUTORIAL_GESTURE_SOURCE),
        read(TUTORIAL_GESTURE_SOURCE).replace("      if (mapperTutorialGestureSettling) {", "      if (false) {")],
      ["changed code beside tutorial gesture owners", path.join(scratch, TUTORIAL_GESTURE_SOURCE),
        read(TUTORIAL_GESTURE_SOURCE) + "\n// Unreviewed adjacent tutorial change\n"],
      ["changed generated tutorial runtime", path.join(scratch, TUTORIAL_GESTURE_OUTPUT),
        read(TUTORIAL_GESTURE_OUTPUT) + "\n// Unreviewed generated tutorial change\n"],
      ["stale tutorial runtime cache key", scratchHtml,
        published.replace(activeRuntimeTag, tutorialGesture.documentTags[0].beforeSource)],
      ["broadened adaptive-sidebar inverse", path.join(scratch, ADAPTIVE_SIDEBAR_PATH),
        JSON.stringify({ ...adaptiveSidebar, changes: [...adaptiveSidebar.changes, adaptiveSidebar.changes[0]] })],
      ["changed adaptive fit guard", path.join(scratch, "tools/app/unified-controller.js"),
        read("tools/app/unified-controller.js").replace("const fitted=fits();", "const fitted=true;")],
      ["changed controller beside adaptive owners", path.join(scratch, "tools/app/unified-controller.js"),
        read("tools/app/unified-controller.js") + "\n// Unreviewed adjacent adaptive change\n"],
      ["changed readable sidebar font floor", path.join(scratch, "tools/app/styles/style-002.css"),
        read("tools/app/styles/style-002.css").replace("--sidebar-text:12px", "--sidebar-text:8px")],
      ["stale adaptive bundle cache key", scratchHtml,
        published.replace(adaptiveSidebar.documentTags[0].afterSource, adaptiveSidebar.documentTags[0].beforeSource)],
      ["broadened road fallback inverse", path.join(scratch, ROAD_FALLBACK_PATH),
        JSON.stringify({ ...roadFallback, afterSource: roadFallback.afterSource + "\n" })],
      ["altered road fallback minimum", path.join(scratch, roadFallback.module),
        read(roadFallback.module).replace("Math.min(baseSize, fallbackSize,", "Math.max(baseSize, fallbackSize,")],
      ["unreviewed adjacent road module change", path.join(scratch, roadFallback.module),
        read(roadFallback.module) + "\n// Unreviewed adjacent fallback change\n"],
      ["stale road fallback cache key", path.join(scratch, "tools/app/index.template.html"),
        template.replace(roadFallback.afterScriptTag, roadFallback.beforeScriptTag)],
      ["broadened November 1 bug-fix inverse", path.join(scratch, REVIEW_FIX_PATH),
        JSON.stringify({ ...reviewFix, changes: [...reviewFix.changes, reviewFix.changes[0]] })],
      ["changed reviewed reload guard", path.join(scratch, reviewFix.files[0].source),
        read(reviewFix.files[0].source).replace("generation !== archiveGeneration", "generation === archiveGeneration")],
      ["changed code beside reviewed alert function", path.join(scratch, "tools/app/runtime/24-alerts-and-projections.js"),
        read("tools/app/runtime/24-alerts-and-projections.js") + "\n// Unreviewed adjacent change\n"],
      ["restored address-bearing fallback basemap", path.join(scratch, "tools/app/runtime/00-configuration.js"),
        read("tools/app/runtime/00-configuration.js").replace(SCALABLE_FALLBACK_AFTER, SCALABLE_FALLBACK_BEFORE)],
      ["dropped active NJOGIS road attribution", scratchHtml,
        published.replace(SCALABLE_ROAD_ATTRIBUTION, SCALABLE_ROAD_ATTRIBUTION.replace(" · Local road names: NJOGIS", ""))],
      ["broadened scalable-road inverse", path.join(scratch, SCALABLE_ROAD_AUDIT_PATH),
        JSON.stringify({ ...scalableRoadAudit, changes: [...scalableRoadAudit.changes, scalableRoadAudit.changes[0]] })],
      ["altered shared scalable road renderer", path.join(scratch, scalableRoadAudit.module.source),
        scalableRoadModule + "\n// Unreviewed road-label style\n"],
      ["altered scalable export snapshot helper", path.join(scratch, "tools/app/runtime/16-export-map.js"),
        read("tools/app/runtime/16-export-map.js").replace("    async function waitForExportRoadLabelsReady(",
          "    async function waitForExportRoadLabelsReady(/* Unreviewed readiness */")],
      ["dropped scalable-road dependency", scratchHtml, published.replace(scalableRoadAudit.moduleScriptTag, "")],
      ["asynchronous scalable-road dependency", path.join(scratch, "tools/app/index.template.html"),
        template.replace(scalableRoadAudit.moduleScriptTag, scalableRoadAudit.moduleScriptTag.replace("<script", "<script async"))],
      ["stale scalable-road dependency", path.join(scratch, "tools/app/index.template.html"),
        template.replace(scalableRoadAudit.moduleScriptTag, scalableRoadAudit.moduleScriptTag.replace("?v=", "?v=unreviewed-"))],
      ["altered 3D road-label style consumer", path.join(scratch, "assets/3d/north-wildwood-3d.js"),
        read("assets/3d/north-wildwood-3d.js").replace("  function syncRoadLabels3d() {",
          "  function syncRoadLabels3d() {\n    // Unreviewed road visibility")],
      ["altered 3D terrain outside road-label owners", path.join(scratch, "assets/3d/north-wildwood-3d.js"),
        read("assets/3d/north-wildwood-3d.js").replace("  function syncTerrainForView(pitched) {",
          "  function syncTerrainForView(pitched) {\n    // Unreviewed terrain behavior")],
      ["broadened logo-readiness inverse", path.join(scratch, LOGO_READINESS_AUDIT_PATH),
        JSON.stringify({ ...logoReadinessAudit, changes: [...logoReadinessAudit.changes, logoReadinessAudit.changes[0]] })],
      ["altered reviewed logo-readiness function", path.join(scratch, "tools/app/runtime/15-export-capture.js"),
        read("tools/app/runtime/15-export-capture.js").replace("    async function waitForExportChromeReady() {",
          "    async function waitForExportChromeReady() {\n      // Unreviewed source readiness")],
      ["altered raster deadline outside logo readiness", path.join(scratch, "tools/app/runtime/15-export-capture.js"),
        read("tools/app/runtime/15-export-capture.js").replace("waitForExportRasterLayerReady(layer, timeoutMs = 30000)",
          "waitForExportRasterLayerReady(layer, timeoutMs = 30001)")],
      ["broadened preview-polish inverse", path.join(scratch, PREVIEW_POLISH_AUDIT_PATH),
        JSON.stringify({ ...previewPolishAudit, changes: [...previewPolishAudit.changes, previewPolishAudit.changes[0]] })],
      ["altered reviewed preview cache helper", path.join(scratch, "assets/export-preview.js"),
        read("assets/export-preview.js").replace("  function sourceId(value) {", "  function sourceId(value) {\n    // Unreviewed cache behavior")],
      ["altered science outside preview-polish owners", path.join(scratch, "tools/app/runtime/16-export-map.js"),
        read("tools/app/runtime/16-export-map.js").replace("formatStageForDisplay(rawStage)", "formatStageForDisplay(rawStage + 2)")],
      ["altered date-time picker asset", path.join(scratch, previewPolishAudit.assets[0].source),
        read(previewPolishAudit.assets[0].source) + "\n// Unreviewed date/time behavior\n"],
      ["altered high-resolution branding asset", path.join(scratch, brandAsset.source),
        Buffer.concat([fs.readFileSync(localPath(brandAsset.source)), Buffer.from("unreviewed")])],
      ["dropped date-time picker dependency", scratchHtml,
        published.replace(activePickerTag, "")],
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
        read(roadLabelAudit.changes[0].source).replace("    function createRoadLabelLayer(url, options) {",
          "    function createRoadLabelLayer(url, options) {\n      // Unreviewed road-label integration")],
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
      ["broadened provider-readiness inverse", path.join(scratch, PROVIDER_READINESS_AUDIT_PATH),
        JSON.stringify({ ...providerReadinessAudit, changes: [...providerReadinessAudit.changes, providerReadinessAudit.changes[0]] })],
      ["altered reviewed provider-readiness function", path.join(scratch, "tools/app/runtime/15-export-capture.js"),
        read("tools/app/runtime/15-export-capture.js").replace("    async function waitForExportRasterLayerReady(",
          "    async function waitForExportRasterLayerReady(/* Unreviewed provider readiness */")],
      ["altered adjacent vector-readiness deadline", path.join(scratch, "tools/app/runtime/15-export-capture.js"),
        read("tools/app/runtime/15-export-capture.js").replace("waitForExportVectorLayerReady(layer, timeoutMs = 15000)",
          "waitForExportVectorLayerReady(layer, timeoutMs = 15001)")],
    ];
    assert.equal(cases.length - uiDialogCases.length - cloneCleanupCases.length, 140, "Retain all 128 previous mutations and twelve history transaction/UI boundary mutations");
    assert.equal(cases.length - cloneCleanupCases.length, 156, "Retain all 140 previous mutations plus sixteen dialog/accessibility/UI boundary mutations");
    assert.equal(cases.length, 172, "Retain all 156 previous mutations plus sixteen owned-clone/capture/UI boundary mutations");
    const allCases = [...cases, ...deepCases];
    assert.equal(allCases.length, 201, "Preserve all 172 earlier cases and append 29 deep-fix mutations");
    const semanticsTemplate = readRaw(ARIA_SEMANTICS_TEMPLATE), semanticsPublished = readRaw("index.html");
    const semanticsPicker = readRaw(ARIA_SEMANTICS_PICKER);
    const semanticsMap = ariaSemantics.changes.find(block => block.id === "named-map-region");
    const semanticsCache = ariaSemantics.documentTags[0];
    const semanticsPickerCase = (name, id, mutate) => {
      const block = ariaSemantics.changes.find(block => block.id === id);
      assert.ok(block && block.kind === "external", `${name}: name one exact picker fragment`);
      return [name, path.join(scratch, ARIA_SEMANTICS_PICKER), semanticsPicker.replace(block.afterSource, mutate(block.afterSource, block))];
    };
    const ariaSemanticsCases = [
      ["broadened invisible semantic inverse ownership", path.join(scratch, ARIA_SEMANTICS_PATH),
        JSON.stringify({...ariaSemantics, changes:[...ariaSemantics.changes, {...ariaSemantics.changes[0], functionOwner:"openTime"}]})],
      ["omitted the source 3D region role", path.join(scratch, ARIA_SEMANTICS_TEMPLATE),
        semanticsTemplate.replace(semanticsMap.afterSource, semanticsMap.beforeSource)],
      ["changed the 3D landmark to a different role", path.join(scratch, ARIA_SEMANTICS_TEMPLATE),
        semanticsTemplate.replace(semanticsMap.afterSource, semanticsMap.afterSource.replace('role="region"', 'role="application"'))],
      ["changed the original 3D accessible map name", path.join(scratch, ARIA_SEMANTICS_TEMPLATE),
        semanticsTemplate.replace('aria-label="Interactive 3D North Wildwood flood map"', 'aria-label="Unreviewed map name"')],
      semanticsPickerCase("omitted the editable date combobox role", "editable-date-combobox-role", (source, block) => block.beforeSource),
      semanticsPickerCase("misrepresented the editable date as a button", "editable-date-combobox-role",
        source => source.replace('"role","combobox"', '"role","button"')),
      semanticsPickerCase("lost date combobox state on calendar-button opening", "date-popup-open-state", (source, block) => block.beforeSource),
      semanticsPickerCase("mirrored popup state to the wrong date editor", "date-popup-open-state",
        source => source.replace('getExportDateEditorElements(prefix).dateText', 'getExportDateEditorElements(prefix === "end" ? "start" : "end").dateText')),
      semanticsPickerCase("associated the combobox with a nonexistent popup", "date-popup-open-state",
        source => source.replace('trigger?.setAttribute("aria-controls", ID)', 'trigger?.setAttribute("aria-controls", "unreviewedPopup")')),
      semanticsPickerCase("left the closed date combobox expanded", "date-popup-close-state",
        source => source.replace('dateText?.setAttribute("aria-expanded", "false")', 'dateText?.setAttribute("aria-expanded", "true")')),
      semanticsPickerCase("lost the keyboard combobox invocation owner", "date-combobox-keyboard-focus", (source, block) => block.beforeSource),
      semanticsPickerCase("ignored the explicit popup focus-return owner", "date-popup-invocation-owner", (source, block) => block.beforeSource),
      semanticsPickerCase("returned focus to the positioning button instead of the invoking input", "date-popup-close-state",
        source => source.replace('previous.returnFocus || previous.anchor', 'previous.anchor')),
      ["changed unrelated date-picker cache behavior", path.join(scratch, ARIA_SEMANTICS_PICKER),
        semanticsPicker.replace('stageMaps.size >= 4', 'stageMaps.size >= 5')],
      semanticsPickerCase("changed the existing date keyboard shortcut", "date-combobox-keyboard-focus",
        source => source.replace('event.key === "ArrowDown"', 'event.key === "ArrowUp"')),
      ["added an unreviewed date-picker global", path.join(scratch, ARIA_SEMANTICS_PICKER),
        semanticsPicker + '\nvar unreviewedSemanticGlobal = true;\n'],
      ["changed the shared font with semantic fixes", path.join(scratch, FONT_FAMILY_SOURCE),
        readRaw(FONT_FAMILY_SOURCE) + '\nbody { font-family: serif; }\n'],
      ["changed visible map layout with semantic fixes", path.join(scratch, ARIA_SEMANTICS_TEMPLATE),
        semanticsTemplate.replace(semanticsMap.afterSource, semanticsMap.afterSource.replace('role="region"', 'role="region" style="padding:1px"'))],
      ["omitted the generated 3D region role", scratchHtml,
        semanticsPublished.replace(semanticsMap.afterSource, semanticsMap.beforeSource)],
      ["retained the old picker source cache key", path.join(scratch, ARIA_SEMANTICS_TEMPLATE),
        semanticsTemplate.replace(semanticsCache.afterSource, semanticsCache.beforeSource)],
      ["retained the old generated picker cache key", scratchHtml,
        semanticsPublished.replace(semanticsCache.afterSource, semanticsCache.beforeSource)],
      ["used a picker cache key unrelated to its bytes", scratchHtml,
        semanticsPublished.replace(semanticsCache.afterSource, semanticsCache.afterSource.replace(/\?v=[a-f0-9]+/, '?v=0000000000000000'))],
      ["changed unrelated runtime with semantic fixes", path.join(scratch, DEEP_RUNTIME),
        readRaw(DEEP_RUNTIME) + '\nvar unreviewedSemanticRuntime = true;\n']
    ];
    assert.equal(ariaSemanticsCases.length, 23, "Retain all semantic role/state/focus, exact owner, cache, font and UI boundary mutations");
    allCases.push(...ariaSemanticsCases);
    assert.equal(allCases.length, 224, "Preserve all 201 earlier cases and append 23 invisible-semantic boundary mutations");
    const followupCases = [
      ["broadened follow-up inverse ownership", path.join(scratch, FOLLOWUP_PATH), followupText.replace('"scope":', '"unreviewedScope":')],
      ...followup.files.flatMap(file => {
        const current = readActual(file.source);
        return [
          [`unreviewed follow-up byte in ${file.source}`, path.join(scratch, file.source), current + "\n/* unreviewed follow-up byte */\n"],
          ...file.changes.map((block, index) => [`reverted follow-up fragment ${file.source}:${index + 1}`, path.join(scratch, file.source), current.replace(recheckCurrentFragment(file.source, block.afterSource), block.beforeSource)])
        ];
      })
    ];
    assert.equal(followupCases.length, 66, "Retain all fourteen file boundaries and fifty-one exact follow-up fragments");
    allCases.push(...followupCases);
    assert.equal(allCases.length, 290, "Retain all 224 earlier cases and append 66 follow-up boundaries");
    const recheckCases = [
      ["broadened recheck inverse ownership", path.join(scratch, RECHECK_PATH), recheckText.replace('"scope":', '"unreviewedScope":')],
      ...recheck.files.flatMap(file => {
        const current = readActual(file.source);
        return [
          [`unreviewed recheck byte in ${file.source}`, path.join(scratch, file.source), current + "\n/* unreviewed recheck byte */\n"],
          ...file.changes.map((block, index) => [`reverted recheck fragment ${file.source}:${index + 1}`, path.join(scratch, file.source), current.replace(cameraCurrentFragment(file.source, block.afterSource), block.beforeSource)])
        ];
      })
    ];
    assert.equal(recheckCases.length, 50, "Retain all ten file boundaries and thirty-nine exact recheck fragments");
    allCases.push(...recheckCases);
    assert.equal(allCases.length, 340, "Retain all 290 earlier mutation cases and append 50 recheck boundaries");
    const cameras3dCases = [
      ["broadened 3D/camera inverse ownership", path.join(scratch, CAMERAS_3D_PATH), cameras3dText.replace('"scope":', '"unreviewedScope":')],
      ...cameras3d.files.flatMap(file => {
        const current = readActual(file.source);
        return [
          [`unreviewed 3D/camera byte in ${file.source}`, path.join(scratch, file.source), current + "\n/* unreviewed 3D/camera byte */\n"],
          ...file.changes.map((block, index) => [`reverted 3D/camera fragment ${file.source}:${index + 1}`, path.join(scratch, file.source), current.replace(projectionNoteCurrentFragment(file.source, block.afterSource), block.beforeSource)])
        ];
      })
    ];
    assert.equal(cameras3dCases.length, 47, "Retain every 3D/camera file and exact fragment boundary");
    allCases.push(...cameras3dCases);
    assert.equal(allCases.length, 340 + 47, "Retain all 340 earlier mutations and append the reviewed 3D/camera boundaries");
    assert.deepEqual(allCases.filter(([, target, altered]) => fs.readFileSync(target, "utf8") === altered).map(([name]) => name), [], "Every retained mutation must alter the actual current artifact");
    assertMutationsRejected(allCases, runPrior);
    assert.equal(runPrior().status, 0, "Restoring historical artifacts must restore a passing check");
    console.log(`Parity mutation checks passed: ${allCases.length + lineAuditCases.length} dropped, moved, altered or stale artifacts were rejected.`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
