import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../assets/north-wildwood-loading.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
assert.match(html, /<body class="nw-app-loading"/);
assert.match(html, /id="nwSiteLoader" role="status"/);
assert.match(html, /<script defer src="assets\/north-wildwood-loading\.js/);

function fixture({ready = false, reducedMotion = false} = {}) {
  const classes = new Set(['nw-app-loading', ...(ready ? ['nw-app-ready'] : [])]);
  const timers = new Map();
  const intervals = new Map();
  let now = 0;
  let nextTimer = 0, callback, disconnected = false;
  const body = {dataset:{}, classList:{contains: name => classes.has(name), remove: name => classes.delete(name)}};
  const app = {inert:false, setAttribute(name, value) { this[name] = value; }};
  const toggle = {inert:false}, legend = {inert:false};
  const progress = {dataset:{}, style:{}}, status = {textContent:'Preparing forecast and map data…'};
  const loader = {hidden:false, classList:{add(name) { loader[name] = true; }}, setAttribute(name, value) { this[name] = value; }, addEventListener() {}};
  const context = {
    document:{readyState:'complete', body, getElementById:id => ({app, nwSiteLoader:loader, mobileControlsToggle:toggle, legendDock:legend, nwLoaderProgress:progress, nwLoaderStatus:status})[id]},
    window:{matchMedia:() => ({matches:reducedMotion})},
    performance:{now:() => now},
    MutationObserver:class { constructor(fn) { callback = fn; } observe() {} disconnect() { disconnected = true; } },
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, {fn,ms}); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(fn, ms) { const id = ++nextTimer; intervals.set(id, {fn,ms}); return id; },
    clearInterval(id) { intervals.delete(id); }
  };
  vm.runInNewContext(source, context);
  return {body, app, loader, toggle, legend, progress, status, classes, timers, intervals,
    advanceTime(ms) { now += ms; }, tickProgress() { [...intervals.values()][0].fn(); },
    signalReady() { classes.add('nw-app-ready'); callback(); },
    disconnected:() => disconnected, runTimer(ms) { const [id,timer] = [...timers].find(([,timer]) => timer.ms === ms); timers.delete(id); timer.fn(); }};
}

const normal = fixture();
assert.equal(normal.loader.hidden, false);
assert.equal(normal.app.inert, true, 'Loading controls must not receive keyboard focus');
assert.equal(normal.toggle.inert, true);
assert.equal(normal.legend.inert, true);
assert.equal(normal.app['aria-busy'], 'true');
normal.tickProgress();
assert.equal(normal.progress.style.width, '11%');
normal.advanceTime(900);
normal.signalReady();
assert.equal(normal.progress.style.width, '100%');
assert.equal(normal.status.textContent, 'Floodmapper ready');
assert.equal(normal.intervals.size, 0);
assert.equal(normal.app.inert, true, 'Keep the background inactive during the original completion pause');
normal.runTimer(260);
assert.equal(normal.body.dataset.siteLoader, 'complete');
assert.equal(normal.app.inert, false);
assert.equal(normal.toggle.inert, false);
assert.equal(normal.legend.inert, false);
assert.equal(normal.app['aria-busy'], 'false');
assert.equal(normal.loader['aria-hidden'], 'true');
assert.equal(normal.classes.has('nw-app-loading'), false);
assert.equal(normal.disconnected(), true);
assert.equal([...normal.timers.values()].some(timer => timer.ms === 20000), false);
normal.runTimer(700);
assert.equal(normal.loader.hidden, true);

const cached = fixture({ready:true, reducedMotion:true});
assert.equal(cached.loader.hidden, true, 'Cached startup must not wait for a minimum splash duration');
assert.equal(cached.timers.size, 0);
assert.equal(cached.intervals.size, 0);

const fast = fixture({ready:true});
assert.equal(fast.app.inert, true, 'Cached startup still isolates controls during the original completion pause');
fast.runTimer(1060);
assert.equal(fast.loader['is-fading'], true, 'Preserve the original minimum display and completion pause');
fast.runTimer(700);
assert.equal(fast.loader.hidden, true);

const stalled = fixture({reducedMotion:true});
stalled.runTimer(20000);
assert.equal(stalled.body.dataset.siteLoader, 'timeout');
assert.equal(stalled.app.inert, false);
assert.equal(stalled.loader.hidden, true);
assert.equal(stalled.intervals.size, 0);
assert.equal(stalled.classes.has('nw-app-ready'), false, 'The fallback must not falsely mark the map ready');
stalled.signalReady();
assert.equal(stalled.body.dataset.siteLoader, 'timeout', 'Late completion must not restart the overlay');
console.log('Passed original progress, completion timing, focus handoff, reduced motion and stalled-request recovery');
