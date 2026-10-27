import { readAppSource } from './app_source.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../assets/north-wildwood-loading.js', import.meta.url), 'utf8');
const html = readAppSource(new URL('../index.html', import.meta.url));
assert.match(html, /<body\b[^>]*\bclass="[^"]*\bnw-app-loading\b/);
assert.match(html, /id="nwSiteLoader" role="status"/);
const loaderTag = html.match(/<script\b[^>]*\bsrc="assets\/north-wildwood-loading\.js[^>]*>/)?.[0];
assert.ok(loaderTag, 'The loading-screen controller must be connected');
assert.doesNotMatch(loaderTag, /\b(?:defer|async)\b/, 'The watchdog must start before blocking core scripts');
assert.ok(html.indexOf(loaderTag) > html.indexOf('id="exportStage"'));
assert.ok(html.indexOf(loaderTag) < html.indexOf('<script src="https://unpkg.com/leaflet@'));
assert.doesNotMatch(html, /#nwSiteLoader\s*\{[^}]*display\s*:\s*none\s*!important/,
  'No unconditional important CSS override may disconnect the visible splash');

function fixture({ready = false, reducedMotion = false, dependenciesReady = true, parsing = false} = {}) {
  const classes = new Set(['nw-app-loading', ...(ready ? ['nw-app-ready'] : [])]);
  const timers = new Map();
  const intervals = new Map();
  let now = 0;
  let nextTimer = 0, callback, disconnected = false;
  const events = new Map();
  const body = {dataset:{}, classList:{contains: name => classes.has(name), remove: name => classes.delete(name)}};
  const app = {inert:false, setAttribute(name, value) { this[name] = value; }};
  const toggle = {inert:false}, legend = {inert:false};
  const progress = {dataset:{}, style:{}}, status = {textContent:'Preparing forecast and map data…'};
  const loader = {hidden:false, classList:{add(name) { loader[name] = true; }}, setAttribute(name, value) { this[name] = value; }, addEventListener() {}};
  const retry = {hidden:true, disabled:false, focusCount:0, focus() { this.focusCount++; }, addEventListener(type, fn) { this[type] = fn; }};
  let reloads = 0;
  const context = {
    document:{readyState:parsing?'loading':'complete', body, getElementById:id => ({app, nwSiteLoader:loader, mobileControlsToggle:toggle, legendDock:legend, nwLoaderProgress:progress, nwLoaderStatus:status, nwLoaderRetry:retry})[id]},
    window:{matchMedia:() => ({matches:reducedMotion}), floodmapperMapDependenciesReady:dependenciesReady,
      addEventListener(type, fn) { events.set(type, fn); }, removeEventListener(type) { events.delete(type); }, location:{reload() {reloads++;}}},
    performance:{now:() => now},
    MutationObserver:class { constructor(fn) { callback = fn; } observe() {} disconnect() { disconnected = true; } },
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, {fn,ms}); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(fn, ms) { const id = ++nextTimer; intervals.set(id, {fn,ms}); return id; },
    clearInterval(id) { intervals.delete(id); }
  };
  vm.runInNewContext(source, context);
  return {body, app, loader, toggle, legend, progress, status, classes, timers, intervals, retry, events,
    reloads:() => reloads,
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

const core = fixture({dependenciesReady:false, parsing:true, reducedMotion:true});
assert.equal(core.app.inert, true, 'Watchdog initializes while the parser is waiting on a core script');
core.tickProgress();
core.runTimer(20000);
assert.equal(core.body.dataset.siteLoader, 'dependency-error');
assert.equal(core.loader.hidden, false);
assert.equal(core.app.inert, true, 'Incomplete controls stay isolated');
assert.equal(core.retry.hidden, false);
assert.equal(core.retry.focusCount, 1);
assert.match(core.status.textContent, /could not load/);
assert.equal(core.intervals.size, 0);
core.signalReady();
assert.equal(core.loader.hidden, true, 'Late successful startup recovers without a reload');
assert.equal(core.app.inert, false);

const failed = fixture({dependenciesReady:false, parsing:true});
failed.events.get('nww:map-dependency-error')();
assert.equal(failed.retry.hidden, false, 'Failed dependencies expose immediate retry');
failed.retry.click();
assert.equal(failed.retry.disabled, true);
assert.equal(failed.reloads(), 1);
console.log('Passed loading lifecycle, parser-stalled core recovery, failure retry, and late successful startup');
