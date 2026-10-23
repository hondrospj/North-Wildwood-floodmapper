import { readAppSource } from './app_source.mjs';
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const html = readAppSource(new URL("../index.html", import.meta.url));
const source = fs.readFileSync(new URL("../assets/export-preview.js", import.meta.url), "utf8");
const noop = () => {};

// Exercise the real DOM assembly and public handlers without adding a browser dependency.
function fixture() {
  const ids = new Map(), events = new Map();
  function element(tag = "div") {
    const attrs = new Map(), listeners = new Map();
    const item = {
      tagName: tag.toUpperCase(), children: [], parentElement: null, dataset: {},
      hidden: false, disabled: false, textContent: "", value: "",
      style: { setProperty: noop, removeProperty: noop },
      setAttribute(name, value) {
        attrs.set(name, String(value));
        if (name === "id") this.id = value;
        if (name === "class") this.className = value;
        if (name === "hidden") this.hidden = true;
        if (name === "value") this.value = value;
        if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
      },
      getAttribute: name => attrs.get(name) ?? null,
      removeAttribute: name => attrs.delete(name),
      append(...children) {
        for (const child of children) {
          if (typeof child === "string") continue;
          child.remove(); child.parentElement = this; this.children.push(child);
        }
      },
      prepend(...children) {
        for (const child of [...children].reverse()) {
          child.remove(); child.parentElement = this; this.children.unshift(child);
        }
      },
      appendChild(child) { this.append(child); return child; },
      before(child) {
        const parent = this.parentElement, index = parent.children.indexOf(this);
        child.remove(); child.parentElement = parent; parent.children.splice(index, 0, child);
      },
      remove() {
        if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
        this.parentElement = null;
      },
      replaceChildren(...children) { for (const child of [...this.children]) child.remove(); this.append(...children); },
      contains(child) { return this === child || this.children.some(next => next.contains(child)); },
      matches(selector) {
        return selector.split(",").some(raw => {
          const part = raw.trim();
          if (part.startsWith("#")) return this.id === part.slice(1);
          if (part.startsWith(".")) return this.classList.contains(part.slice(1));
          const attr = part.match(/^\[([^=\]]+)(?:=["']?([^"'\]]+)["']?)?\]$/);
          if (attr) return attrs.has(attr[1]) && (attr[2] == null || attrs.get(attr[1]) === attr[2]);
          return this.tagName.toLowerCase() === part.toLowerCase();
        });
      },
      querySelectorAll(selector) {
        return this.children.flatMap(child => [ ...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector) ]);
      },
      querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; },
      closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; },
      addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
      async dispatch(name) {
        for (const fn of listeners.get(name) || []) await fn({ target: this, currentTarget: this, preventDefault: noop, stopPropagation: noop });
      },
      focus: noop, scrollIntoView: noop,
      getBoundingClientRect: () => ({ width: 640, height: 480 }),
    };
    let id = "", className = "";
    Object.defineProperty(item, "id", { get: () => id, set: value => { id = String(value); ids.set(id, item); attrs.set("id", id); } });
    Object.defineProperty(item, "className", { get: () => className, set: value => { className = String(value); attrs.set("class", className); } });
    Object.defineProperty(item, "parentNode", { get: () => item.parentElement });
    item.classList = {
      contains: name => className.split(/\s+/).includes(name),
      toggle(name, force) {
        const names = new Set(className.split(/\s+/).filter(Boolean));
        const on = force ?? !names.has(name); if (on) names.add(name); else names.delete(name);
        item.className = [...names].join(" "); return on;
      },
      add: (...names) => names.forEach(name => item.classList.toggle(name, true)),
      remove: (...names) => names.forEach(name => item.classList.toggle(name, false)),
    };
    Object.defineProperty(item, "innerHTML", { set: markup => { item.replaceChildren(); parse(markup, item); } });
    return item;
  }
  function parse(markup, parent) {
    const stack = [parent];
    for (const match of markup.matchAll(/<(\/?)([a-z][a-z0-9-]*)([^>]*)>/gi)) {
      if (match[1]) { if (stack.length > 1) stack.pop(); continue; }
      const child = element(match[2]);
      for (const attr of match[3].matchAll(/([a-zA-Z_:][\w:.-]*)(?:="([^"]*)"|='([^']*)'|=([^\s>]+))?/g)) child.setAttribute(attr[1], attr[2] ?? attr[3] ?? attr[4] ?? "");
      stack.at(-1).append(child);
      if (!/\/$/.test(match[3]) && !/^(input|img|br|hr|meta|link)$/i.test(match[2])) stack.push(child);
    }
  }
  const body = element("body"), head = element("head"), modal = element("div");
  modal.id = "downloadModal"; modal.hidden = true; body.append(modal);
  const start = html.indexOf(">", html.indexOf('<div id="downloadModal"')) + 1;
  const end = html.indexOf('<div id="exportOrderModal"', start);
  assert.ok(start > 0 && end > start, "Missing native export controls");
  parse(html.slice(start, end), modal);
  const state = { downloads: 0, resets: 0, format: "png" };
  const ctx = vm.createContext({
    console, document: { readyState: "loading", body, head,
      createElement: element, getElementById: id => ids.get(id) ?? null,
      querySelector: selector => body.querySelector(selector), querySelectorAll: selector => body.querySelectorAll(selector),
      addEventListener: (name, fn) => events.set(name, fn),
    },
    setTimeout: () => 1, clearTimeout: noop, requestAnimationFrame: fn => fn(),
    exportInProgress: false, floodFrameState: "ready", currentDataMode: "forecast",
    isDownloadModalOpen: () => !modal.hidden,
    setDownloadModalOpen: value => { modal.hidden = !value; }, updateDownloadSummary: noop,
    resetExportPanelToDefaults: () => { state.resets++; },
    updateExportSegmentedUI: () => { ids.get("downloadBtnLabel").textContent = state.format === "png" ? "Download PNG Frames" : "Download GIF"; },
    downloadCurrentSelection: async () => { state.downloads++; },
    getDownloadFormatValue: () => state.format, getDownloadScopeValue: () => "current",
    getDownloadExtentValue: () => "current",
    getDownloadAspectValue: () => "viewport", getExportAspectConfig: () => ({ width: 1440, height: 900 }),
    validateDownloadRangeForExport: () => ({ ok: true }), getDownloadFrameItems: () => [],
  });
  ctx.window = ctx;
  // Existing listeners and controls must survive moving fields into the new review layout.
  const nativeControls = ["downloadFormatControl", "downloadStartDateText", "downloadStartTimeSelect", "downloadAspectControl", "downloadExtentControl", "downloadIntervalControl", "downloadSpeedControl"]
    .map(id => ids.get(id));
  let nativeChanges = 0;
  for (const control of nativeControls) { assert.ok(control); control.addEventListener("change", () => nativeChanges++); }
  // main() wires this captured reference before the deferred preview module loads.
  ids.get("downloadResetBtn").addEventListener("click", ctx.resetExportPanelToDefaults);
  vm.runInContext(source, ctx, { filename: "export-preview.js" });
  events.get("DOMContentLoaded")();
  return { ctx, ids, state, modal, nativeControls, changes: () => nativeChanges };
}

{
  const { ctx, ids, state } = fixture();
  ctx.setDownloadModalOpen(true);
  assert.equal(ids.get("downloadBtnLabel").textContent, "Review export settings");
  assert.equal(ids.get("exportReviewFields").hidden, true);
  await ctx.downloadCurrentSelection();
  assert.equal(state.downloads, 0, "First invocation must only reveal required settings review");
  assert.equal(ids.get("exportReviewFields").hidden, false);
  assert.equal(ids.get("downloadBtnLabel").textContent, "Download PNG Frames");
  await ctx.downloadCurrentSelection(); assert.equal(state.downloads, 1);
  await ids.get("exportReviewBackBtn").dispatch("click");
  assert.equal(ids.get("exportReviewFields").hidden, true);
  assert.equal(ids.get("downloadBtnLabel").textContent, "Review export settings");
  await ctx.downloadCurrentSelection(); assert.equal(state.downloads, 1, "Back requires reviewing again before downloading");
  await ids.get("downloadResetBtn").dispatch("click"); assert.equal(state.resets, 1);
  assert.equal(ids.get("exportReviewFields").hidden, true, "A native Reset click also reinstates review");
  await ctx.downloadCurrentSelection(); assert.equal(state.downloads, 1, "The captured native Reset listener cannot bypass review");
  ctx.setDownloadModalOpen(false); ctx.setDownloadModalOpen(true);
  assert.equal(ids.get("exportReviewFields").hidden, true);
  await ctx.downloadCurrentSelection(); assert.equal(state.downloads, 1, "Each new modal session requires review");
}

// The gate belongs to the handler, so direct calls and native label refreshes cannot bypass it.
{
  const { ctx, ids, state } = fixture();
  ctx.setDownloadModalOpen(true);
  state.format = "gif"; ctx.updateExportSegmentedUI();
  assert.equal(ids.get("downloadBtnLabel").textContent, "Review export settings");
  await ctx.downloadCurrentSelection(); assert.equal(state.downloads, 0);
  assert.equal(ids.get("downloadBtnLabel").textContent, "Download GIF");
  await ctx.downloadCurrentSelection(); assert.equal(state.downloads, 1);
}

{
  const { ids, nativeControls, changes } = fixture();
  for (const control of nativeControls) {
    assert.equal(ids.get(control.id), control, `Preserve native ${control.id} node identity`);
    await control.dispatch("change");
  }
  assert.equal(changes(), nativeControls.length, "Moving native controls preserves their existing change handlers");
  assert.ok(ids.get("exportReviewFields").contains(ids.get("downloadAspectControl")));
  assert.ok(ids.get("exportReviewFields").contains(ids.get("downloadExtentControl")));
  assert.ok(ids.get("exportReviewFields").contains(ids.get("downloadIntervalControl")));
  assert.ok(!ids.get("exportReviewFields").contains(ids.get("downloadFormatControl")), "File type remains in the first step");
  assert.ok(!ids.get("exportReviewFields").contains(ids.get("downloadStartDateText")), "Date and time remain in the first step");
}

console.log("PASS export review: required per-session gate, direct-call safety, Back/Reset, native labels and preserved control handlers.");
