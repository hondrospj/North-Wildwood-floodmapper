import { readAppSource } from './app_source.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const sourcePath = process.argv[2];
if (!sourcePath) throw new Error('Usage: node camera-geometry.mjs SOURCE_HTML_OR_MOUNT_FUNCTION [CSS_FILE]');
const source = readAppSource(sourcePath);
const css = process.argv[3] ? fs.readFileSync(process.argv[3], 'utf8') : source;
const functionSource = source.match(/  function mountPanel\(\) \{[\s\S]*?\n  \}/)?.[0];
assert.ok(functionSource, 'The actual camera mountPanel function must exist');
const run = new Function('env', `with(env) { ${functionSource}\n mountPanel(); }`);
assert.match(css, /#webcamPanel\[data-viewport-overlay="true"\]\s*\{[^}]*position:\s*fixed[^}]*z-index:\s*10050/s,
  'A short viewport needs a body-level fixed viewer above the timeline');
assert.match(css, /#webcamPanel\[data-viewport-overlay="true"\] \.webcam-heading\s*\{[^}]*position:\s*sticky[^}]*top:\s*0/s,
  'Scrolling the camera viewer must retain its heading and close button');

function fixture(width, height, vv = null, bannerBottom = 0) {
  const style = { removeProperty(name) { delete this[name === 'max-width' ? 'maxWidth' : name]; } };
  const panel = { dataset: {}, style, parentElement: null };
  const rect = { left: 0, top: 0, right: width, bottom: height, width, height };
  const body = { classList: { contains: () => false }, append(element) { element.parentElement = this; } };
  const container = { getBoundingClientRect: () => rect, append(element) { element.parentElement = this; } };
  panel.parentElement = container;
  const elements = {
    mapWrap: container,
    mapTitleBadge: { getClientRects: () => [1], getBoundingClientRect: () => ({ top: 8, bottom: 52, height: 44 }) },
    mobileControlsToggle: { getClientRects: () => [1], getBoundingClientRect: () => ({ top: 8, bottom: 52, height: 44 }) },
    timelineDock: { getBoundingClientRect: () => ({ height: width <= 900 ? 180 : 112,
      top: height - (width <= 900 ? 180 + 8 : 112 + 16) }) },
  };
  if (bannerBottom) elements.topBanner = { getClientRects: () => [1],
    getBoundingClientRect: () => ({ top: 8, bottom: bannerBottom, height: bannerBottom - 8 }) };
  const env = {
    map: null, panel, innerWidth: width, innerHeight: height,
    window: { visualViewport: vv },
    document: { body, getElementById: id => elements[id] ?? null },
    getComputedStyle: () => ({ visibility: 'visible' }),
  };
  return { panel, container, body, env, run: () => run(env) };
}

const cases = [
  { width: 568, height: 320, overlay: true },
  { width: 844, height: 390, overlay: true },
  { width: 390, height: 844, overlay: false },
  { width: 320, height: 568, overlay: false },
  { width: 1440, height: 1000, overlay: false },
  { width: 1440, height: 300, overlay: true },
];
const results = [];
for (const item of cases) {
  const f = fixture(item.width, item.height);
  f.run();
  assert.equal(f.panel.dataset.viewportOverlay, String(item.overlay));
  assert.equal(f.panel.parentElement, item.overlay ? f.body : f.container);
  const top = Number.parseFloat(f.panel.style.top), maxHeight = Number.parseFloat(f.panel.style.maxHeight);
  assert.ok(maxHeight >= 200, 'Viewer must retain usable scrollable height');
  assert.ok(top >= 0 && top + maxHeight <= item.height - 7, 'Viewer must fit inside the viewport');
  if (item.overlay) {
    // Existing mobile heading/close: 10px panel padding + 44px close. It lies
    // wholly within the scrollport; browser QA separately verifies hit testing.
    const closeTop = top + 11, closeBottom = closeTop + 44;
    assert.ok(closeBottom <= top + maxHeight, 'Close control cannot be clipped by a zero-height scrollport');
    assert.ok(closeBottom < item.height - 180 - 8, 'Landscape close is above the timeline even before z-index isolation');
  }
  results.push({ ...item, top, maxHeight });
}
{
  const f = fixture(390, 844, { offsetTop: 100, offsetLeft: 45, width: 300, height: 200 });
  f.run();
  assert.equal(f.panel.parentElement, f.body);
  assert.equal(f.panel.style.top, '108px');
  assert.equal(f.panel.style.maxHeight, '184px');
  assert.equal(f.panel.style.left, '195px');
  assert.equal(f.panel.style.maxWidth, '284px');
}
{
  const f = fixture(568, 320);
  f.run();
  f.env.innerWidth = 390; f.env.innerHeight = 844;
  f.container.getBoundingClientRect = () => ({ left: 0, top: 0, right: 390, bottom: 844, width: 390, height: 844 });
  const originalLookup = f.env.document.getElementById;
  f.env.document.getElementById = id => id === 'timelineDock'
    ? { getBoundingClientRect: () => ({ height: 180, top: 656 }) } : originalLookup(id);
  f.run();
  assert.equal(f.panel.parentElement, f.container, 'Returning to portrait restores the normal viewer mount');
  assert.equal(f.panel.dataset.viewportOverlay, 'false');
  assert.equal(f.panel.style.left, undefined);
  assert.equal(f.panel.style.maxWidth, undefined);
}
console.log(JSON.stringify({ source: path.resolve(sourcePath), checks: cases.length + 2, passed: true, results }, null, 2));
