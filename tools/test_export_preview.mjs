import { readAppSource } from './app_source.mjs';
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const html = readAppSource(new URL("../index.html", import.meta.url));
const source = fs.readFileSync(new URL("../assets/export-preview.js", import.meta.url), "utf8");
assert.match(html, /<script defer src="assets\/export-preview\.js\?v=[^"]+"/,
  "Preview UI must not add a parser-blocking startup request");
function nativeFunction(name) {
  const match = html.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n    }`));
  assert.ok(match, `Missing native ${name} function`);
  return match[0];
}
const noop = () => {};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

function node(id = "") {
  const attributes = new Map(), classes = new Set(), listeners = new Map();
  return {
    id, hidden: false, disabled: false, textContent: "", dataset: {}, children: [],
    style: { setProperty: noop, removeProperty: noop },
    classList: {
      add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      contains: name => classes.has(name),
      toggle(name, force) {
        const on = force == null ? !classes.has(name) : force;
        if (on) classes.add(name); else classes.delete(name);
        return on;
      },
    },
    setAttribute: (name, value) => attributes.set(name, String(value)),
    getAttribute: name => attributes.get(name) ?? null,
    removeAttribute: name => attributes.delete(name),
    addEventListener(name, callback) { listeners.set(name, callback); },
    dispatch(name, event = {}) { return listeners.get(name)?.(event); },
    contains(child) { return child === this || this.children.some(node => node.contains?.(child)); },
    replaceChildren(...children) { this.children = children; },
    append(...children) { this.children.push(...children); },
    appendChild(child) { this.children.push(child); return child; },
    querySelector: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ width: 640, height: 480 }),
  };
}

function canvas(marker) {
  return { ...node(), marker, width: 640, height: 800, getContext: () => ({ drawImage: noop }) };
}

function harness() {
  const ids = ["downloadModal", "exportPreview", "exportPreviewCanvas", "exportPreviewStatus",
    "exportPreviewFrameLabel", "exportPreviewRetryBtn", "downloadBtn", "downloadBtnLabel",
    "exportBasicFields", "exportReviewFields", "exportReviewBackBtn", "downloadResetBtn", "exportStepHeading"];
  const nodes = Object.fromEntries(ids.map(id => [id, node(id)]));
  nodes.downloadModal.hidden = true;
  nodes.downloadModal.append(nodes.downloadBtn, nodes.exportPreview, nodes.exportBasicFields, nodes.exportReviewFields);
  const documentEvents = node("document"), windowEvents = node("window");
  let time = 0, timerId = 0;
  const timers = new Map();
  const state = {
    events: [], prepared: [], captures: [], archives: [], libraries: [], downloads: 0,
    frame: { entry: { label: "First frame" }, index: 0 },
    validation: { ok: true, range: { startDate: new Date("2026-10-01T00:00Z"), endDate: new Date("2026-10-02T00:00Z") } },
    scope: "range", capture: async () => canvas("first"), prepare: async () => {},
    archive: async () => {}, library: async () => {}, download: async () => {},
  };
  const ctx = vm.createContext({
    console: { log: noop, warn: noop, error: noop },
    document: {
      readyState: "loading", hidden: false, body: node("body"), head: node("head"),
      getElementById: id => nodes[id] ?? null,
      addEventListener: (...args) => documentEvents.addEventListener(...args),
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: tag => tag === "canvas" ? canvas("created") : node(),
    },
    setTimeout(fn, delay = 0) { const id = ++timerId; timers.set(id, { fn, at: time + delay }); return id; },
    clearTimeout: id => timers.delete(id),
    requestAnimationFrame: fn => fn(),
    cancelAnimationFrame: noop,
    addEventListener: (...args) => windowEvents.addEventListener(...args),
    exportInProgress: false, floodFrameState: "ready", currentDataMode: "forecast",
    isDownloadModalOpen: () => !nodes.downloadModal.hidden,
    setDownloadModalOpen: open => { nodes.downloadModal.hidden = !open; },
    updateDownloadSummary: noop,
    resetExportPanelToDefaults: noop,
    getDownloadScopeValue: () => state.scope,
    getDownloadFormatValue: () => "png",
    getDownloadAspectValue: () => "4:5",
    getDownloadIntervalValue: () => "hourly",
    getDownloadExtentValue: () => "current",
    getDownloadSpeedValue: () => "normal",
    getExportAspectConfig: () => ({ width: 2160, height: 2700, label: "Social 4:5" }),
    validateDownloadRangeForExport: () => state.validation,
    ensureExportArchiveAvailability: async () => {},
    exportRangeNeedsObservedArchive: () => true,
    ensureObservedArchiveRange: async (start, end) => {
      state.archives.push({ start, end }); state.events.push("archive"); await state.archive(start, end);
    },
    getDownloadFrameItems: () => [state.frame],
    ensureExportLibraries: async (format, count) => {
      state.libraries.push({ format, count }); state.events.push("libraries"); await state.library();
    },
    prepareExportFrame: async (item, options) => {
      state.prepared.push({ item, options }); state.events.push("prepare"); await state.prepare(item, options);
    },
    captureExportCanvas: async options => {
      state.captures.push(options); state.events.push("capture"); return state.capture(options);
    },
    formatHourEntryTime: entry => entry.label,
    getFriendlyExportError: error => error.message,
    downloadCurrentSelection: async () => {
      state.downloads++; state.events.push("download"); ctx.exportInProgress = true;
      try { await state.download(); } finally { ctx.exportInProgress = false; }
    },
  });
  ctx.window = ctx;
  vm.runInContext(nativeFunction("updateExportSegmentedUI"), ctx);
  vm.runInContext(source, ctx, { filename: "export-preview.js" });
  async function tick(ms = 300) {
    const target = time + ms;
    for (let count = 0; count < 100; count++) {
      const next = [...timers].filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, timer] = next; timers.delete(id); time = timer.at; timer.fn(); await flush();
      if (count === 99) assert.fail("Preview scheduler did not become idle");
    }
    time = target; await flush();
  }
  const dispatch = (name, event = {}) => documentEvents.dispatch(name, { target: nodes.downloadBtn, pointerId: 1, ...event });
  const dispatchWindow = name => windowEvents.dispatch(name);
  return { ctx, state, nodes, tick, dispatch, dispatchWindow };
}

// Current-frame preview follows the downloader's valid-frame guard and retries when ready.
{
  const { ctx, state, nodes, tick } = harness();
  state.scope = "current"; ctx.floodFrameState = "loading";
  ctx.setDownloadModalOpen(true); await tick();
  assert.equal(state.prepared.length, 0, "Never preview a stale current map while its flood frame loads");
  assert.equal(state.archives.length, 0);
  assert.match(nodes.exportPreviewStatus.textContent, /loading/i);
  assert.notEqual(nodes.exportPreview.dataset.state, "ready");
  ctx.floodFrameState = "ready"; ctx.updateDownloadSummary(); await tick();
  assert.equal(state.prepared.length, 1);
  assert.equal(state.archives.length, 0, "A current frame does not require loading an archive range");
  assert.equal(nodes.exportPreview.dataset.state, "ready");
}

// The embedded preview follows the same first frame and framing path as a real export.
{
  const { ctx, state, nodes, tick } = harness();
  ctx.setDownloadModalOpen(true);
  ctx.updateDownloadSummary(); ctx.updateDownloadSummary();
  await tick();
  assert.equal(state.prepared.length, 1, "Coalesce rapid updates into one preview");
  assert.equal(state.prepared[0].item, state.frame);
  assert.equal(state.prepared[0].options.isFirstFrame, true, "Always refit changed preview extents");
  assert.equal(state.libraries[0].format, "png");
  assert.equal(state.libraries[0].count, 1, "Preview needs only the image capture library");
  assert.ok(state.captures[0].scale > 0 && state.captures[0].scale < 1, "Bound thumbnail pixels below full output resolution");
  assert.equal(nodes.exportPreviewCanvas.children.length, 1);
}

// End/speed changes leave the first-frame pixels intact and publish no spinner.
{
  const { ctx, state, nodes, tick } = harness();
  ctx.setDownloadModalOpen(true); await tick();
  const first = nodes.exportPreviewCanvas.children[0];
  state.validation.range.endDate = new Date("2026-10-03T00:00Z");
  ctx.getDownloadSpeedValue = () => "fast";
  ctx.updateDownloadSummary();
  assert.equal(nodes.exportPreview.dataset.state, "ready", "Unchanged first frames must stay ready synchronously");
  assert.equal(nodes.exportPreviewCanvas.children[0], first);
  await tick();
  assert.equal(state.captures.length, 1, "End and playback settings must not recapture the first frame");
}

// Returning to a cached frame cancels a different in-flight frame's publication.
{
  const { ctx, state, nodes, tick } = harness();
  const originalFrame = state.frame;
  ctx.setDownloadModalOpen(true); await tick();
  const originalCanvas = nodes.exportPreviewCanvas.children[0];
  const delayed = deferred();
  state.frame = { entry: { label: "A different time" }, index: 1 };
  state.capture = () => delayed.promise;
  ctx.updateDownloadSummary(); await tick();
  state.frame = originalFrame;
  ctx.updateDownloadSummary();
  assert.equal(nodes.exportPreview.dataset.state, "ready");
  assert.equal(nodes.exportPreviewCanvas.children[0], originalCanvas);
  const stale = canvas("late different time");
  delayed.resolve(stale); await flush(); await tick();
  assert.equal(stale.width, 1, "The late uncached capture must be released");
  assert.equal(nodes.exportPreviewCanvas.children[0], originalCanvas);
  assert.equal(state.captures.length, 2);
}

// Cached publication also preserves an active gesture barrier.
{
  const { ctx, state, nodes, tick, dispatch } = harness();
  const originalFrame = state.frame;
  ctx.setDownloadModalOpen(true); await tick();
  const delayed = deferred(); state.capture = () => delayed.promise;
  state.frame = { entry: { label: "New time during gesture" }, index: 1 };
  ctx.updateDownloadSummary(); await tick();
  dispatch("pointerdown");
  state.frame = originalFrame; ctx.updateDownloadSummary();
  assert.equal(nodes.exportPreview.dataset.state, "loading", "A cached frame must preserve held-pointer geometry too");
  dispatch("pointerup"); dispatch("click"); await tick(0);
  assert.equal(nodes.exportPreview.dataset.state, "ready");
  delayed.resolve(canvas("obsolete")); await flush();
}

// A retina preview has enough physical pixels for its actual contained size.
{
  const { ctx, state, tick } = harness();
  ctx.devicePixelRatio = 2;
  ctx.setDownloadModalOpen(true); await tick();
  assert.equal(state.captures[0].scale, 960 / 2700);
  assert.equal(state.captures[0].omitAttribution, true, "Preview credits belong in the nearby HTML, not the bitmap");
}

// A larger preview is recaptured sharply; smaller views retain the larger image.
{
  const { ctx, state, nodes, tick, dispatchWindow } = harness();
  ctx.setDownloadModalOpen(true); await tick();
  nodes.exportPreviewCanvas.getBoundingClientRect = () => ({ width: 1200, height: 1200 });
  state.capture = async () => ({ ...canvas("larger"), width: 960, height: 1200 });
  dispatchWindow("resize"); await tick();
  assert.equal(state.captures.length, 2);
  nodes.exportPreviewCanvas.getBoundingClientRect = () => ({ width: 320, height: 240 });
  dispatchWindow("resize"); await tick();
  assert.equal(state.captures.length, 2, "A smaller viewport can reuse the sharper cached image");
}

// Reopening before a same-frame capture settles must queue a fresh generation.
{
  const { ctx, state, nodes, tick } = harness();
  const delayed = deferred();
  state.capture = async () => state.captures.length === 1 ? delayed.promise : canvas("reopened");
  ctx.setDownloadModalOpen(true); await tick();
  ctx.setDownloadModalOpen(false);
  ctx.setDownloadModalOpen(true); await tick();
  const stale = canvas("closed job"); delayed.resolve(stale);
  await flush(); await tick();
  assert.equal(stale.width, 1);
  assert.equal(state.captures.length, 2);
  assert.equal(nodes.exportPreview.dataset.state, "ready");
  assert.equal(nodes.exportPreviewCanvas.children[0].marker, "reopened");
}

// Valid forecast-only previews do not depend on any historical transport.
{
  const { ctx, state, nodes, tick } = harness();
  ctx.exportRangeNeedsObservedArchive = () => false;
  ctx.ensureExportArchiveAvailability = async () => { throw Error("history offline"); };
  state.archive = async () => { throw Error("archive offline"); };
  ctx.setDownloadModalOpen(true); await tick();
  assert.equal(nodes.exportPreview.dataset.state, "ready");
  assert.equal(state.archives.length, 0);
  assert.equal(state.prepared.length, 1);
}

// A year loaded during export must also be loaded before choosing a historic preview frame.
{
  const { ctx, state, tick } = harness();
  const archivedFrame = { entry: { label: "Historic frame" }, index: 0 };
  state.archive = async () => { state.frame = archivedFrame; };
  ctx.setDownloadModalOpen(true); await tick();
  assert.equal(state.archives.length, 1);
  assert.equal(state.archives[0].start, state.validation.range.startDate);
  assert.equal(state.prepared[0].item, archivedFrame, "Resolve first frame after archive availability");
  assert.ok(state.events.indexOf("archive") < state.events.indexOf("prepare"));
}

// A completed preview cannot move a control between pointer-down and its click.
{
  const { ctx, nodes, tick, dispatch } = harness();
  ctx.setDownloadModalOpen(true);
  dispatch("pointerdown");
  await tick();
  assert.equal(nodes.exportPreviewCanvas.children.length, 0, "Hold the completed canvas through a gesture");
  assert.equal(nodes.exportPreview.dataset.state, "loading", "Keep the caption geometry stable");
  dispatch("pointerup"); await flush();
  assert.equal(nodes.exportPreviewCanvas.children.length, 0, "Pointer-up must allow the compatibility click first");
  dispatch("click"); await flush();
  assert.equal(nodes.exportPreviewCanvas.children.length, 0, "Publish only after the click's handlers complete");
  await tick(0);
  assert.equal(nodes.exportPreviewCanvas.children[0]?.marker, "first");
  assert.equal(nodes.exportPreview.dataset.state, "ready");
}

// Multi-pointer gestures and a newly started gesture retain the same barrier.
{
  const { ctx, nodes, tick, dispatch } = harness();
  ctx.setDownloadModalOpen(true);
  dispatch("pointerdown"); dispatch("pointerdown", { pointerId: 2 });
  await tick();
  dispatch("pointerup"); dispatch("click"); await tick(0);
  assert.equal(nodes.exportPreviewCanvas.children.length, 0, "Another held pointer still owns the gesture");
  dispatch("pointerup", { pointerId: 2 }); await tick(200);
  dispatch("pointerdown", { pointerId: 3 }); await tick(600);
  assert.equal(nodes.exportPreviewCanvas.children.length, 0, "A new gesture cancels the previous no-click deadline");
  dispatch("pointercancel", { pointerId: 3 }); await flush();
  assert.equal(nodes.exportPreview.dataset.state, "ready");
}

// Pointer cancellation, focus loss and a suppressed click cannot strand a capture.
for (const ending of ["pointercancel", "blur", "no-click"]) {
  const { ctx, nodes, tick, dispatch, dispatchWindow } = harness();
  ctx.setDownloadModalOpen(true); dispatch("pointerdown"); await tick();
  if (ending === "blur") dispatchWindow("blur");
  else if (ending === "pointercancel") dispatch("pointercancel");
  else {
    dispatch("pointerup"); await tick(499);
    assert.equal(nodes.exportPreviewCanvas.children.length, 0, "Allow a delayed compatibility click before fallback");
    await tick(1);
  }
  await flush();
  assert.equal(nodes.exportPreview.dataset.state, "ready", `${ending} releases the held publication`);
}

// Changed settings are serialized behind the held capture; only the newest commits.
{
  const { ctx, state, nodes, tick, dispatch } = harness();
  const stale = canvas("old-setting");
  state.capture = async () => state.captures.length === 1 ? stale : canvas("new-setting");
  ctx.setDownloadModalOpen(true); dispatch("pointerdown"); await tick();
  state.frame = { entry: { label: "Changed first frame" }, index: 1 };
  ctx.updateDownloadSummary(); await tick();
  assert.equal(state.prepared.length, 1, "Keep the shared stage serialized while publication waits");
  dispatch("pointerup"); dispatch("click"); await tick(0);
  assert.equal(stale.width, 1, "Release the stale canvas after its setting changes");
  assert.equal(stale.height, 1);
  assert.equal(state.prepared.length, 2);
  assert.equal(nodes.exportPreviewCanvas.children[0]?.marker, "new-setting");
}

// Lifecycle invalidation must release held canvases and allow a fresh preview.
for (const ending of ["close", "hidden", "pagehide"]) {
  const { ctx, state, nodes, tick, dispatch, dispatchWindow } = harness();
  const held = canvas("discarded"); state.capture = async () => held;
  ctx.setDownloadModalOpen(true); dispatch("pointerdown"); await tick();
  if (ending === "close") ctx.setDownloadModalOpen(false);
  else if (ending === "hidden") { ctx.document.hidden = true; dispatch("visibilitychange"); }
  else dispatchWindow("pagehide");
  await flush();
  assert.equal(held.width, 1, `${ending} releases a completed waiting capture`);
  assert.equal(held.height, 1);
  assert.equal(nodes.exportPreviewCanvas.children.length, 0, `${ending} cannot publish stale work`);
  state.capture = async () => canvas("fresh");
  if (ending === "hidden") { ctx.document.hidden = false; dispatch("visibilitychange"); }
  else ctx.setDownloadModalOpen(true);
  await tick();
  assert.equal(nodes.exportPreviewCanvas.children[0]?.marker, "fresh");
}

// Download invalidation drains a held publication without waiting for its gesture.
{
  const { ctx, state, nodes, tick, dispatch } = harness();
  const held = canvas("not-a-download"); state.capture = async () => held;
  ctx.setDownloadModalOpen(true); dispatch("pointerdown"); await tick();
  await ctx.downloadCurrentSelection();
  assert.equal(state.downloads, 0, "The review gate remains intact during a gesture");
  await ctx.downloadCurrentSelection();
  assert.equal(state.downloads, 1, "A real download must not deadlock on the preview gesture waiter");
  assert.equal(held.width, 1);
  assert.equal(nodes.exportPreviewCanvas.children.length, 0);
  assert.equal(nodes.downloadBtn.disabled, false);
}

// Validation failure cannot initiate a costly archive fetch or leave an old extent displayed.
{
  const { ctx, state, nodes, tick } = harness();
  ctx.setDownloadModalOpen(true); await tick();
  state.validation = { ok: false, message: "Choose an available time range." };
  ctx.updateDownloadSummary(); await tick();
  assert.equal(state.archives.length, 1);
  assert.equal(state.prepared.length, 1);
  assert.ok(nodes.exportPreview.dataset.state !== "ready" || nodes.exportPreviewCanvas.children.length === 0,
    "Do not present an obsolete preview after validation fails");
  assert.match(nodes.exportPreviewStatus.textContent, /range|available|preview/i);
}

// The stale render must be discarded and the second render must wait for the shared stage.
{
  const { ctx, state, nodes, tick } = harness();
  const first = deferred(); let captureCount = 0;
  state.capture = async () => ++captureCount === 1 ? first.promise : canvas("second");
  ctx.setDownloadModalOpen(true); await tick();
  state.frame = { entry: { label: "Second frame" }, index: 1 };
  ctx.updateDownloadSummary(); await tick();
  assert.equal(state.prepared.length, 1, "Never render concurrently into the shared export stage");
  first.resolve(canvas("stale")); await flush(); await tick();
  assert.equal(state.prepared.length, 2);
  assert.equal(nodes.exportPreviewCanvas.children[0]?.marker, "second", "A stale capture cannot replace the newest extent");
}

// Closing during capture prevents commits; reopening starts a fresh generation.
{
  const { ctx, state, nodes, tick } = harness();
  const first = deferred(); state.capture = () => first.promise;
  ctx.setDownloadModalOpen(true); await tick();
  ctx.setDownloadModalOpen(false); first.resolve(canvas("closed")); await flush();
  assert.equal(nodes.exportPreviewCanvas.children.length, 0);
  state.capture = async () => canvas("reopened");
  ctx.setDownloadModalOpen(true); await tick();
  assert.equal(nodes.exportPreviewCanvas.children[0]?.marker, "reopened");
}

// Cancellation must be checked after each expensive await, before starting the next stage.
for (const stalledStep of ["archive", "library", "prepare"]) {
  const { ctx, state, nodes, tick } = harness();
  const gate = deferred(); state[stalledStep] = () => gate.promise;
  ctx.setDownloadModalOpen(true); await tick();
  ctx.setDownloadModalOpen(false); gate.resolve(); await flush();
  assert.equal(state.captures.length, 0, `Do not capture a preview closed during ${stalledStep}`);
  assert.equal(nodes.exportPreviewCanvas.children.length, 0);
  if (stalledStep !== "prepare") assert.equal(state.prepared.length, 0);
}

// A download drains its active preview, clears queued work and ignores duplicate requests.
{
  const { ctx, state, nodes, tick } = harness();
  const capture = deferred(), download = deferred();
  state.capture = () => capture.promise; state.download = () => download.promise;
  ctx.setDownloadModalOpen(true); await tick();
  await ctx.downloadCurrentSelection();
  assert.equal(state.downloads, 0, "Review remains mandatory before testing the real download barrier");
  ctx.updateDownloadSummary();
  const downloading = ctx.downloadCurrentSelection();
  assert.equal(nodes.downloadBtn.disabled, true, "Give immediate feedback while draining a slow preview");
  assert.match(nodes.downloadBtnLabel.textContent, /Preparing export/i);
  const duplicate = ctx.downloadCurrentSelection();
  await tick(); assert.equal(state.downloads, 0, "Wait for shared-stage capture before starting export");
  capture.resolve(canvas("cancelled-preview")); await flush();
  assert.equal(state.downloads, 1, "Do not queue a second export while draining a preview");
  assert.equal(state.prepared.length, 1, "Discard previews queued before downloading");
  assert.equal(nodes.exportPreviewCanvas.children.length, 0, "A cancelled preview cannot commit during export");
  download.resolve(); await downloading; await duplicate; await flush();
  assert.equal(nodes.downloadBtn.disabled, false, "Restore Download after the export finishes");
  assert.equal(nodes.downloadBtnLabel.textContent, "Download");
}

// A preview that rejects while Download is draining it cannot reject the real export.
{
  const { ctx, state, tick } = harness();
  const capture = deferred(); state.capture = () => capture.promise;
  ctx.setDownloadModalOpen(true); await tick();
  await ctx.downloadCurrentSelection();
  const downloading = ctx.downloadCurrentSelection();
  capture.reject(new Error("Preview network timeout")); await downloading;
  assert.equal(state.downloads, 1);
}

// Closing settings cancels Download while a preview dependency is still pending.
{
  const { ctx, state, nodes, tick } = harness();
  const library = deferred(); state.library = () => library.promise;
  ctx.setDownloadModalOpen(true); await tick();
  await ctx.downloadCurrentSelection();
  const requested = ctx.downloadCurrentSelection();
  assert.equal(nodes.downloadBtn.disabled, true);
  ctx.setDownloadModalOpen(false);
  await requested;
  assert.equal(nodes.downloadBtn.disabled, false, "Closing must release a preview-drain request immediately");
  assert.equal(state.downloads, 0, "A cancelled preparation must not download later");
  ctx.setDownloadModalOpen(true);
  assert.equal(nodes.downloadBtnLabel.textContent, "More options");
  library.resolve(); await flush();
  state.library = async () => {};
  await tick();
  await ctx.downloadCurrentSelection(); await ctx.downloadCurrentSelection();
  assert.equal(state.downloads, 1, "Reopening can review and download after the dependency recovers");
}

// An actual export error must also release the request lock for a later retry.
{
  const { ctx, state, nodes } = harness();
  state.download = async () => { throw new Error("Export network timeout"); };
  await ctx.downloadCurrentSelection();
  await assert.rejects(ctx.downloadCurrentSelection(), /Export network timeout/);
  assert.equal(nodes.downloadBtn.disabled, false);
  assert.equal(nodes.downloadBtnLabel.textContent, "Download", "Restore Download after an export failure");
  state.download = async () => {};
  await ctx.downloadCurrentSelection();
  assert.equal(state.downloads, 2, "Release preview/export request lock after export failure");
}

// Preview errors remain local and cannot poison a later download or refreshed preview.
{
  const { ctx, state, nodes, tick } = harness();
  state.capture = async () => { throw new Error("Map tiles could not load."); };
  ctx.setDownloadModalOpen(true); await tick();
  assert.match(nodes.exportPreviewStatus.textContent, /could not|couldn.t|failed|unavailable|retry/i);
  assert.ok(nodes.exportPreview.dataset.state !== "ready" || nodes.exportPreviewCanvas.children.length === 0);
  await ctx.downloadCurrentSelection(); assert.equal(state.downloads, 0, "Preview failure cannot bypass review");
  await ctx.downloadCurrentSelection(); assert.equal(state.downloads, 1);
  state.capture = async () => canvas("recovered");
  ctx.setDownloadModalOpen(true); await tick();
  assert.equal(nodes.exportPreviewCanvas.children[0]?.marker, "recovered");
}

// Capture accepts thumbnail scale only when requested; normal downloads retain their scale.
{
  const scales = [], filters = [];
  let roadWaits = 0;
  const ctx = vm.createContext({
    document: { getElementById: () => ({}) },
    html2canvas: async (_stage, options) => { scales.push(options.scale); filters.push(options.ignoreElements); return canvas("capture"); },
    waitForExportChromeReady: async () => {}, getExportCaptureScale: () => 1,
    waitForExportRoadLabelsReady: async () => { roadWaits++; },
    throwIfExportCancelled: () => {}, exportMap: null,
    isOutsideExportStage: () => false,
  });
  vm.runInContext(nativeFunction("captureExportCanvas"), ctx);
  await ctx.captureExportCanvas();
  await ctx.captureExportCanvas({ scale: 0.25 });
  assert.equal(scales[0], 1, "Default PNG/GIF capture resolution must not change");
  assert.equal(scales[1], 0.25);
  assert.equal(filters[0]({ id: "exportMapAttribution" }), false, "Downloads retain source credits");
  await ctx.captureExportCanvas({ omitAttribution: true });
  assert.equal(filters.at(-1)({ id: "exportMapAttribution" }), true);
  assert.equal(filters.at(-1)({ id: "exportLegendDock" }), false, "Only the attribution is omitted from preview capture");
  for (const scale of [0, -1, Infinity, NaN]) await ctx.captureExportCanvas({ scale });
  assert.ok(scales.slice(2).every(scale => scale === 1), "Invalid thumbnail scales must retain the normal export scale");
  assert.equal(roadWaits, scales.length, "Every thumbnail and download waits for the active vector road renderer");
}

// A failed preview tile is retried on the same reused map, then reused by a real capture.
{
  let clock = 0, retries = 0;
  const tile = { complete: true, naturalWidth: 0 };
  const layer = {
    isLoading: () => !tile.complete,
    getContainer: () => ({ querySelectorAll: () => [tile] }),
    redraw() { assert.fail("Fractional tile grids must not use Leaflet redraw"); },
  };
  let attached = true;
  const map = { zoom: 14.743299527888258,
    hasLayer: value => value === layer && attached,
    removeLayer(value) { assert.equal(value, layer); attached = false; },
    addLayer(value) { assert.equal(value, layer); attached = true; retries++; tile.complete = false; },
  };
  const ctx = vm.createContext({
    exportMap: map,
    Date: { now: () => clock }, throwIfExportCancelled: noop,
    requestAnimationFrame: callback => callback(),
    wait: async ms => { clock += ms; tile.complete = true; tile.naturalWidth = 256; },
  });
  vm.runInContext(nativeFunction("retryExportRasterLayerTiles"), ctx);
  vm.runInContext(nativeFunction("waitForExportRasterLayerReady"), ctx);
  await ctx.waitForExportRasterLayerReady(layer);
  assert.equal(retries, 1, "Retry the same attached layer without changing extent");
  assert.equal(map.zoom, 14.743299527888258);
  await ctx.waitForExportRasterLayerReady(layer);
  assert.equal(retries, 1, "A later capture reuses successfully recovered map tiles");
}

// Persistent tile failure is bounded to one retry per request, and later requests may retry.
{
  let clock = 0, retries = 0, recover = false;
  const tile = { complete: true, naturalWidth: 0 };
  const layer = {
    isLoading: () => false, getContainer: () => ({ querySelectorAll: () => [tile] }),
    redraw() { assert.fail("Fractional tile grids must not use Leaflet redraw"); },
  };
  let attached = true;
  const map = {
    hasLayer: value => value === layer && attached,
    removeLayer(value) { assert.equal(value, layer); attached = false; },
    addLayer(value) { assert.equal(value, layer); attached = true; retries++; if (recover) tile.naturalWidth = 256; },
  };
  const ctx = vm.createContext({
    exportMap: map,
    Date: { now: () => clock }, throwIfExportCancelled: noop,
    requestAnimationFrame: callback => callback(), wait: async ms => { clock += ms; },
  });
  vm.runInContext(nativeFunction("retryExportRasterLayerTiles"), ctx);
  vm.runInContext(nativeFunction("waitForExportRasterLayerReady"), ctx);
  await assert.rejects(ctx.waitForExportRasterLayerReady(layer), /map tile could not load/);
  assert.equal(retries, 1, "Do not retry a persistently failing tile forever");
  recover = true; await ctx.waitForExportRasterLayerReady(layer);
  assert.equal(retries, 2, "A failed preview must not poison a later download retry");
}

// Retrying does not restart the readiness deadline or ignore export cancellation.
for (const outcome of ["timeout", "cancel"]) {
  let clock = 0, retries = 0, cancelled = false;
  const tile = { complete: true, naturalWidth: 0 };
  const layer = {
    isLoading: () => true, getContainer: () => ({ querySelectorAll: () => [tile] }),
    redraw() { assert.fail("Fractional tile grids must not use Leaflet redraw"); },
  };
  let attached = true;
  const map = {
    hasLayer: value => value === layer && attached,
    removeLayer(value) { assert.equal(value, layer); attached = false; },
    addLayer(value) { assert.equal(value, layer); attached = true; retries++; tile.complete = false; },
  };
  const ctx = vm.createContext({
    exportMap: map,
    Date: { now: () => clock }, requestAnimationFrame: callback => callback(),
    throwIfExportCancelled: () => { if (cancelled) throw Object.assign(new Error("Export cancelled."), { name: "AbortError" }); },
    wait: async ms => { clock += ms; if (outcome === "cancel") cancelled = true; },
  });
  vm.runInContext(nativeFunction("retryExportRasterLayerTiles"), ctx);
  vm.runInContext(nativeFunction("waitForExportRasterLayerReady"), ctx);
  await assert.rejects(ctx.waitForExportRasterLayerReady(layer, 150),
    outcome === "cancel" ? /Export cancelled/ : /map background is still loading/);
  assert.equal(retries, 1);
  assert.equal(clock, outcome === "cancel" ? 100 : 200, "Retain the original deadline while retrying");
}

assert.match(html, /src="assets\/export-preview\.js[^\"]*"/);
assert.ok(html.indexOf('src="assets/export-preview.js') > html.indexOf('src="assets/export-area.js'),
  "Load the preview after the area selection hooks");
console.log("PASS export preview: accurate frames, held gestures/clicks, cancellation and lifecycle release, serialized download handoff, stale rendering, close/reopen, tile recovery and original export resolution.");
