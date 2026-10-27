import { readAppSource } from './app_source.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const sourcePath = process.argv[2];
if (!sourcePath) throw new Error('Usage: node popup-focus.mjs /path/to/north-wildwood-3d.js');
const source = readAppSource(sourcePath);
const body = source.match(/updatePersistentDepthQueryPopup = function \(\) \{([\s\S]*?)\n  \};/)?.[1];
assert.ok(body, 'The actual popup refresh wrapper must be present');
const fallbackLifetimeSource = source.match(/  function closeOutdatedFallbackBuildingPopup\(\) \{[\s\S]*?\n  \}/)?.[0];
assert.ok(fallbackLifetimeSource, 'The actual fallback popup lifetime helper must be present');
const discardSource = source.match(/  function discardObsoleteFloodFrame3d\(\) \{[\s\S]*?\n  \}/)?.[0];
assert.ok(discardSource, 'The actual pending GPU-frame cleanup must be present');
const refresh = new Function('env', `with(env) { ${discardSource}\n ${fallbackLifetimeSource}\n ${body}\n }`);

function fixture({ focus = 'slider', focusAfterOpen = true, changed = true, throws = false } = {}) {
  const document = { activeElement: null };
  const calls = { setHTML: 0, autofocus: 0, focus: [], layout: 0, original: 0 };
  function element(id, classes = []) {
    return { id, classList: { contains: name => classes.includes(name) },
      focus(options) { document.activeElement = this; calls.focus.push({ id, options }); } };
  }
  const slider = element('hourSlider');
  const oldClose = element('old-close', ['maplibregl-popup-close-button']);
  const oldCta = element('old-cta', ['house-alert-cta']);
  let close = oldClose, cta = oldCta;
  const content = { scrollTop: 73 };
  const container = { querySelector(selector) {
    if (selector === '.maplibregl-popup-content') return content;
    if (selector === '.maplibregl-popup-close-button') return close;
    if (selector === '.house-alert-cta') return cta;
    throw new Error(`Unexpected selector: ${selector}`);
  } };
  const glPopup = {
    options: { focusAfterOpen }, getElement: () => container,
    setHTML() {
      calls.setHTML++;
      if (throws) throw new Error('Simulated MapLibre setHTML error');
      close = element('new-close', ['maplibregl-popup-close-button']);
      cta = element('new-cta', ['house-alert-cta']);
      content.scrollTop = 0;
      // MapLibre 5.24.0 setHTML -> setDOMContent -> _focusFirstElement.
      if (this.options.focusAfterOpen) { calls.autofocus++; cta.focus(); }
    },
  };
  const env = {
    glPopup, document, persistentFloodPopup: { getContent: () => changed ? 'new reading' : 'old reading' },
    lastGlPopupHtml: 'old reading',
    fallbackBuildingPopup: null, fallbackBuildingRenderToken: null, pendingFlood3dRequest: null, lastRenderToken: 1, floodFrameState: 'ready',
    originalUpdatePersistentDepthQueryPopup: () => { calls.original++; return 'original result'; },
    syncGlPopupLayout: () => calls.layout++,
  };
  document.activeElement = focus === 'close' ? close : focus === 'cta' ? cta : slider;
  return { env, calls, document, slider, content, glPopup, run: () => refresh(env) };
}

let checks = 0;
for (const originalAutofocus of [true, false]) {
  const f = fixture({ focusAfterOpen: originalAutofocus });
  assert.equal(f.run(), 'original result');
  assert.equal(f.document.activeElement, f.slider, 'Time updates preserve external timeline focus');
  assert.equal(f.calls.autofocus, 0, 'Refresh never triggers MapLibre autofocus');
  assert.deepEqual(f.calls.focus, [], 'External focus is preserved without a corrective focus/scroll');
  assert.equal(f.glPopup.options.focusAfterOpen, originalAutofocus, 'Initial-open behavior is unchanged');
  assert.equal(f.content.scrollTop, 73, 'Refresh preserves popup scroll position');
  assert.equal(f.calls.original, 1);
  checks++;
}
for (const focus of ['close', 'cta']) {
  const f = fixture({ focus });
  f.run();
  assert.equal(f.document.activeElement.id, `new-${focus}`, 'Refresh restores focus within replaced popup content');
  assert.equal(f.calls.autofocus, 0);
  assert.deepEqual(f.calls.focus, [{ id: `new-${focus}`, options: { preventScroll: true } }]);
  assert.equal(f.content.scrollTop, 73);
  checks++;
}
{
  const f = fixture({ changed: false });
  f.run();
  assert.equal(f.calls.setHTML, 0, 'Unchanged readings do not rebuild the popup');
  assert.equal(f.document.activeElement, f.slider);
  checks++;
}
{
  const f = fixture({ throws: true });
  assert.throws(f.run, /Simulated MapLibre/);
  assert.equal(f.glPopup.options.focusAfterOpen, true, 'An exception cannot permanently change popup autofocus');
  assert.equal(f.document.activeElement, f.slider);
  checks++;
}

const layoutSource = source.match(/  function syncGlPopupLayout\(\) \{[\s\S]*?\n  \}/)?.[0];
assert.ok(layoutSource, 'The actual popup layout normalization must be present');
const normalizeLayout = new Function('env', `with(env) { ${layoutSource}\n syncGlPopupLayout(); }`);
for (const compact of [true, false]) {
  const attributes = new Map();
  const close = { setAttribute: (name, value) => attributes.set(name, value) };
  const content = { firstElementChild: null, prepend(node) { this.firstElementChild = node; } };
  const parent = { appendChild(node) { node.parentElement = this; } };
  const element = { parentElement: parent, classList: { toggle() {} }, querySelector(selector) {
    if (selector === '.maplibregl-popup-content') return content;
    if (selector === '.maplibregl-popup-close-button') return close;
    throw new Error(`Unexpected layout selector: ${selector}`);
  } };
  const env = {
    glPopup: { getElement: () => element }, glMap: { getContainer: () => parent },
    document: { body: parent }, isCompactFloodmapperLayout: () => compact,
  };
  normalizeLayout(env);
  assert.equal(attributes.get('aria-label'), 'Close popup', 'Every recreated close needs its accessible name in both layouts');
  if (compact) assert.equal(content.firstElementChild, close, 'Compact close remains before the scrollable content');
  checks++;
}

const clickBody = source.match(/glMap\.on\("click", async function \(event\) \{([\s\S]*?)\n    \}\);/)?.[1];
assert.ok(clickBody, 'The actual 3D map click handler must be present');
const onMapClick = new Function('env', 'event', `with(env) { return (async function() { ${clickBody}\n })(); }`);
for (const target of ['close', 'cta', 'popup-text', 'map', 'synthetic']) {
  let queries = 0, layerLookups = 0;
  const inPopup = target !== 'map' && target !== 'synthetic';
  const event = { point: { x: 50, y: 50 }, lngLat: { lat: 39, lng: -74.8 } };
  if (target !== 'synthetic') event.originalEvent = { target: {
    closest: selector => selector === '.maplibregl-popup' && inPopup ? {} : null,
  } };
  const env = {
    layerVisible: () => { layerLookups++; return false; },
    glMap: {}, mapClickMode: 'building', L: { latLng: (lat, lng) => ({ lat, lng }) },
    handleDepthQueryClick: () => queries++,
  };
  await onMapClick(env, event);
  assert.equal(queries, inPopup ? 0 : 1,
    inPopup ? 'Popup controls must not reopen a profile through the map handler' : 'Ordinary map clicks still query depth');
  if (inPopup) assert.equal(layerLookups, 0, 'Popup events must stop before any map query work');
  checks++;
}
console.log(JSON.stringify({ source: path.resolve(sourcePath), checks, passed: true }, null, 2));
