import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const sourcePath = process.argv[2];
if (!sourcePath) throw new Error('Usage: node popup-focus.mjs /path/to/north-wildwood-3d.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const body = source.match(/updatePersistentDepthQueryPopup = function \(\) \{([\s\S]*?)\n  \};/)?.[1];
assert.ok(body, 'The actual popup refresh wrapper must be present');
const refresh = new Function('env', `with(env) { ${body}\n }`);

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
console.log(JSON.stringify({ source: path.resolve(sourcePath), checks, passed: true }, null, 2));
