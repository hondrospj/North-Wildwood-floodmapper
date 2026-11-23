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
const criticalStyle = html.match(/<style id="floodmapper-loading-screen">\n([\s\S]*?)\n<\/style>/);
assert.ok(criticalStyle, 'Inline the established loader CSS to paint before blocking resources');
assert.equal(criticalStyle[1], fs.readFileSync(new URL('../assets/north-wildwood-loading.css', import.meta.url), 'utf8').trimEnd());
assert.match(html, /data-floodmapper-loading-ui="branded"/);
assert.match(html, /class="nw-loader-status">Preparing forecast and map data…<\/p>/);
assert.ok(html.indexOf('id="nwSiteLoader"') < html.indexOf('<link data-nww-startup-style'),
  'Parse the loading screen before the app stylesheets');
const previewTag = html.match(/<img\b[^>]*\bid="startupMapPreview"\s+src="data:image\/webp;base64,([^"]+)"[^>]*>/);
assert.ok(previewTag, 'Use an inline geographic preview so the first map image never waits for an asset request');
assert.deepEqual(Buffer.from(previewTag[1], 'base64'), fs.readFileSync(new URL('../assets/north-wildwood-startup-map.webp', import.meta.url)));
assert.ok(previewTag.index < html.indexOf('<link data-nww-startup-style'), 'Parse the preview before loading the existing stylesheets');
assert.match(html, /id="floodmapper-startup-visibility"/);

function fixture({ready = false, reducedMotion = false, dependenciesReady = true, parsing = false, unified = false, layoutReady = false} = {}) {
  const classes = new Set(['nw-app-loading', ...(ready ? ['nw-app-ready'] : [])]);
  const timers = new Map();
  const intervals = new Map();
  let nextTimer = 0, callback, disconnected = false;
  const events = new Map();
  const body = {dataset:unified ? {floodmapperUnified:'test', ...(layoutReady ? {unifiedLayoutPasses:'1'} : {})} : {}, classList:{contains: name => classes.has(name), remove: name => classes.delete(name)}};
  const app = {inert:false, setAttribute(name, value) { this[name] = value; }};
  const toolbar = {inert:false}, toggle = {inert:false}, legend = {inert:false};
  const progress = {dataset:{}, style:{}}, status = {textContent:'Preparing forecast and map data…'};
  const loader = {hidden:false, classList:{add(name) { loader[name] = true; }}, setAttribute(name, value) { this[name] = value; }, addEventListener() {}};
  const retry = {hidden:true, disabled:false, focusCount:0, focus() { this.focusCount++; }, addEventListener(type, fn) { this[type] = fn; }};
  let reloads = 0;
  const context = {
    document:{readyState:parsing?'loading':'complete', body, getElementById:id => ({app, nwSiteLoader:loader, nwwMobileUtilities:toolbar, mobileControlsToggle:toggle, legendDock:legend, nwLoaderProgress:progress, nwLoaderStatus:status, nwLoaderRetry:retry})[id]},
    window:{matchMedia:() => ({matches:reducedMotion}), floodmapperMapDependenciesReady:dependenciesReady,
      addEventListener(type, fn) { events.set(type, fn); }, removeEventListener(type) { events.delete(type); }, location:{reload() {reloads++;}}},
    MutationObserver:class { constructor(fn) { callback = fn; } observe() {} disconnect() { disconnected = true; } },
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, {fn,ms}); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(fn, ms) { const id = ++nextTimer; intervals.set(id, {fn,ms}); return id; },
    clearInterval(id) { intervals.delete(id); }
  };
  vm.runInNewContext(source, context);
  return {body, app, loader, toolbar, toggle, legend, progress, status, classes, timers, intervals, retry, events,
    reloads:() => reloads,
    tickProgress() { [...intervals.values()][0].fn(); },
    signalReady() { classes.add('nw-app-ready'); callback(); },
    signalLayout() { body.dataset.unifiedLayoutPasses='1'; callback(); },
    disconnected:() => disconnected, runTimer(ms) { const [id,timer] = [...timers].find(([,timer]) => timer.ms === ms); timers.delete(id); timer.fn(); }};
}

const normal = fixture();
assert.equal(normal.loader.hidden, false);
assert.equal(normal.app.inert, true, 'Loading controls must not receive keyboard focus');
assert.equal(normal.toolbar.inert, true);
assert.equal(normal.toggle.inert, true);
assert.equal(normal.legend.inert, true);
assert.equal(normal.app['aria-busy'], 'true');
normal.tickProgress();
assert.equal(normal.progress.style.width, '11%');
normal.signalReady();
assert.equal(normal.progress.style.width, '100%');
assert.equal(normal.status.textContent, 'Floodmapper ready');
assert.equal(normal.intervals.size, 0);
assert.equal(normal.body.dataset.siteLoader, 'complete', 'Real readiness must release the controls before another timer runs');
assert.equal(normal.app.inert, false);
assert.equal(normal.toolbar.inert, false);
assert.equal(normal.toggle.inert, false);
assert.equal(normal.legend.inert, false);
assert.equal(normal.app['aria-busy'], 'false');
assert.equal(normal.loader['aria-hidden'], 'true');
assert.equal(normal.classes.has('nw-app-loading'), false);
assert.equal(normal.disconnected(), true);
assert.deepEqual([...normal.timers.values()].map(timer => timer.ms), [700],
  'The timer only cleans up the inaccessible loader node after immediate release');
normal.runTimer(700);
assert.equal(normal.loader.hidden, true);

const cached = fixture({ready:true, reducedMotion:true});
assert.equal(cached.loader.hidden, true, 'Cached startup must not wait for a minimum splash duration');
assert.equal(cached.timers.size, 0);
assert.equal(cached.intervals.size, 0);

const fast = fixture({ready:true});
assert.equal(fast.body.dataset.siteLoader, 'complete');
assert.equal(fast.app.inert, false, 'Cached startup in normal motion immediately enables ready controls');
assert.equal(fast.loader['aria-hidden'], 'true');
assert.deepEqual([...fast.timers.values()].map(timer => timer.ms), [700]);
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

const coreBeforeLayout = fixture({ready:true, unified:true});
assert.equal(coreBeforeLayout.app.inert,true,'Core readiness cannot expose controls before their measured layout');
assert.equal(coreBeforeLayout.classes.has('nw-app-loading'),true);
assert.notEqual(coreBeforeLayout.body.dataset.siteLoader,'complete');
assert.equal(coreBeforeLayout.disconnected(),false,'Keep observing until the delayed layout completes');
coreBeforeLayout.signalLayout();
assert.equal(coreBeforeLayout.body.dataset.siteLoader,'complete','The first layout pass releases a ready map immediately');
assert.equal(coreBeforeLayout.app.inert,false);
assert.equal(coreBeforeLayout.toggle.inert,false);
assert.equal(coreBeforeLayout.legend.inert,false);
assert.equal(coreBeforeLayout.app['aria-busy'],'false');

const layoutBeforeCore = fixture({unified:true,layoutReady:true,reducedMotion:true});
assert.equal(layoutBeforeCore.app.inert,true,'A layout pass alone cannot claim that core data is ready');
layoutBeforeCore.signalReady();
assert.equal(layoutBeforeCore.body.dataset.siteLoader,'complete');
assert.equal(layoutBeforeCore.app.inert,false);

const missingLayout = fixture({ready:true,unified:true,reducedMotion:true});
missingLayout.runTimer(20000);
assert.equal(missingLayout.body.dataset.siteLoader,'timeout','A missing UI controller keeps the existing bounded recovery');
assert.equal(missingLayout.app.inert,false);
assert.equal(missingLayout.loader.hidden,true);
assert.equal(missingLayout.app['aria-busy'],'false');
missingLayout.signalLayout();
assert.equal(missingLayout.body.dataset.siteLoader,'timeout','Late layout cannot reopen or restart the overlay');

const unifiedFailure = fixture({unified:true,dependenciesReady:false,reducedMotion:true});
unifiedFailure.events.get('nww:map-dependency-error')();
assert.equal(unifiedFailure.retry.hidden,false);
unifiedFailure.signalReady();
assert.equal(unifiedFailure.app.inert,true,'Dependency recovery still waits for the first layout');
unifiedFailure.signalLayout();
assert.equal(unifiedFailure.body.dataset.siteLoader,'complete');
assert.equal(unifiedFailure.app.inert,false);
console.log('Passed loading lifecycle, parser-stalled core recovery, failure retry, and late successful startup');
