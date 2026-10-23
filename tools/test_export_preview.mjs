import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const source = fs.readFileSync(new URL("../assets/export-preview.js", import.meta.url), "utf8");
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
    "exportPreviewFrameLabel", "exportPreviewRetryBtn", "downloadBtn", "downloadBtnLabel"];
  const nodes = Object.fromEntries(ids.map(id => [id, node(id)]));
  nodes.downloadModal.hidden = true;
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
      readyState: "loading", body: node("body"), head: node("head"),
      getElementById: id => nodes[id] ?? null,
      addEventListener: noop,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: tag => tag === "canvas" ? canvas("created") : node(),
    },
    setTimeout(fn, delay = 0) { const id = ++timerId; timers.set(id, { fn, at: time + delay }); return id; },
    clearTimeout: id => timers.delete(id),
    requestAnimationFrame: fn => fn(),
    cancelAnimationFrame: noop,
    exportInProgress: false, floodFrameState: "ready", currentDataMode: "forecast",
    isDownloadModalOpen: () => !nodes.downloadModal.hidden,
    setDownloadModalOpen: open => { nodes.downloadModal.hidden = !open; },
    updateDownloadSummary: noop,
    getDownloadScopeValue: () => state.scope,
    getDownloadFormatValue: () => "png",
    getDownloadAspectValue: () => "4:5",
    getDownloadIntervalValue: () => "hourly",
    getDownloadExtentValue: () => "current",
    getDownloadSpeedValue: () => "normal",
    getExportAspectConfig: () => ({ width: 2160, height: 2700, label: "Social 4:5" }),
    validateDownloadRangeForExport: () => state.validation,
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
  return { ctx, state, nodes, tick };
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
  assert.equal(nodes.downloadBtnLabel.textContent, "Download PNG Frames");
}

// A preview that rejects while Download is draining it cannot reject the real export.
{
  const { ctx, state, tick } = harness();
  const capture = deferred(); state.capture = () => capture.promise;
  ctx.setDownloadModalOpen(true); await tick();
  const downloading = ctx.downloadCurrentSelection();
  capture.reject(new Error("Preview network timeout")); await downloading;
  assert.equal(state.downloads, 1);
}

// An actual export error must also release the request lock for a later retry.
{
  const { ctx, state, nodes } = harness();
  state.download = async () => { throw new Error("Export network timeout"); };
  await assert.rejects(ctx.downloadCurrentSelection(), /Export network timeout/);
  assert.equal(nodes.downloadBtn.disabled, false);
  assert.equal(nodes.downloadBtnLabel.textContent, "Download PNG Frames", "Restore Download after an export failure");
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
  await ctx.downloadCurrentSelection(); assert.equal(state.downloads, 1);
  state.capture = async () => canvas("recovered");
  ctx.setDownloadModalOpen(true); await tick();
  assert.equal(nodes.exportPreviewCanvas.children[0]?.marker, "recovered");
}

// Capture accepts thumbnail scale only when requested; normal downloads retain their scale.
{
  const scales = [];
  const ctx = vm.createContext({
    document: { getElementById: () => ({}) },
    html2canvas: async (_stage, options) => { scales.push(options.scale); return canvas("capture"); },
    waitForExportChromeReady: async () => {}, getExportCaptureScale: () => 1,
    isOutsideExportStage: () => false,
  });
  vm.runInContext(nativeFunction("captureExportCanvas"), ctx);
  await ctx.captureExportCanvas();
  await ctx.captureExportCanvas({ scale: 0.25 });
  assert.equal(scales[0], 1, "Default PNG/GIF capture resolution must not change");
  assert.equal(scales[1], 0.25);
  for (const scale of [0, -1, Infinity, NaN]) await ctx.captureExportCanvas({ scale });
  assert.ok(scales.slice(2).every(scale => scale === 1), "Invalid thumbnail scales must retain the normal export scale");
}

// A failed preview tile is retried on the same reused map, then reused by a real capture.
{
  let clock = 0, redraws = 0;
  const tile = { complete: true, naturalWidth: 0 };
  const layer = {
    isLoading: () => !tile.complete,
    getContainer: () => ({ querySelectorAll: () => [tile] }),
    redraw() { redraws++; tile.complete = false; },
  };
  const ctx = vm.createContext({
    Date: { now: () => clock }, throwIfExportCancelled: noop,
    requestAnimationFrame: callback => callback(),
    wait: async ms => { clock += ms; tile.complete = true; tile.naturalWidth = 256; },
  });
  vm.runInContext(nativeFunction("waitForExportRasterLayerReady"), ctx);
  await ctx.waitForExportRasterLayerReady(layer);
  assert.equal(redraws, 1, "Retry a failed tile without changing extent");
  await ctx.waitForExportRasterLayerReady(layer);
  assert.equal(redraws, 1, "A later capture reuses successfully recovered map tiles");
}

// Persistent tile failure is bounded to one redraw per request, and later requests may retry.
{
  let clock = 0, redraws = 0, recover = false;
  const tile = { complete: true, naturalWidth: 0 };
  const layer = {
    isLoading: () => false, getContainer: () => ({ querySelectorAll: () => [tile] }),
    redraw() { redraws++; if (recover) tile.naturalWidth = 256; },
  };
  const ctx = vm.createContext({
    Date: { now: () => clock }, throwIfExportCancelled: noop,
    requestAnimationFrame: callback => callback(), wait: async ms => { clock += ms; },
  });
  vm.runInContext(nativeFunction("waitForExportRasterLayerReady"), ctx);
  await assert.rejects(ctx.waitForExportRasterLayerReady(layer), /map tile could not load/);
  assert.equal(redraws, 1, "Do not retry a persistently failing tile forever");
  recover = true; await ctx.waitForExportRasterLayerReady(layer);
  assert.equal(redraws, 2, "A failed preview must not poison a later download retry");
}

// Redrawing does not restart the readiness deadline or ignore export cancellation.
for (const outcome of ["timeout", "cancel"]) {
  let clock = 0, redraws = 0, cancelled = false;
  const tile = { complete: true, naturalWidth: 0 };
  const layer = {
    isLoading: () => true, getContainer: () => ({ querySelectorAll: () => [tile] }),
    redraw() { redraws++; tile.complete = false; },
  };
  const ctx = vm.createContext({
    Date: { now: () => clock }, requestAnimationFrame: callback => callback(),
    throwIfExportCancelled: () => { if (cancelled) throw Object.assign(new Error("Export cancelled."), { name: "AbortError" }); },
    wait: async ms => { clock += ms; if (outcome === "cancel") cancelled = true; },
  });
  vm.runInContext(nativeFunction("waitForExportRasterLayerReady"), ctx);
  await assert.rejects(ctx.waitForExportRasterLayerReady(layer, 150),
    outcome === "cancel" ? /Export cancelled/ : /map background is still loading/);
  assert.equal(redraws, 1);
  assert.equal(clock, outcome === "cancel" ? 100 : 200, "Retain the original deadline while retrying");
}

assert.match(html, /src="assets\/export-preview\.js[^\"]*"/);
assert.ok(html.indexOf('src="assets/export-preview.js') > html.indexOf('src="assets/export-area.js'),
  "Load the preview after the area selection hooks");
console.log("PASS export preview: accurate frames, archives, bounded capture, stale rendering, close/reopen, download races, same-extent tile recovery and original export resolution.");
