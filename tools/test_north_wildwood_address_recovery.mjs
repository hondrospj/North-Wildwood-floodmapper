// Exercise real provider fetches, deadlines and cancellation through address search.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('app/runtime/27-mobile-and-address.js', import.meta.url), 'utf8');
const configSource = fs.readFileSync(new URL('app/town-config.js', import.meta.url), 'utf8');
const configStart = configSource.indexOf('TOWN_CONFIG = {') + 'TOWN_CONFIG = '.length;
const config = JSON.parse(configSource.slice(configStart, configSource.indexOf('\n};', configStart) + 2));
const flush = async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); };

function setup(fetchResult) {
  const timers = new Map();
  const requests = [];
  const button = { disabled: false };
  const input = { value: '100 New Jersey Ave', focus() {} };
  const status = { textContent: '', classList: { toggle() {} } };
  const marker = { setLatLng() {}, setIcon() {}, addTo() { return this; } };
  const popups = [];
  const context = vm.createContext({
    console, Promise, URLSearchParams, AbortController,
    TOWN_CONFIG: config, townAddressSearchGeneration: 0, townAddressMarker: null,
    setTimeout: (fn, ms) => { const id = {}; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id),
    fetch: (url, options) => { requests.push({ url, ...options }); return fetchResult(url, options, requests.length); },
    document: { getElementById: id => ({ townAddressSearchBtn: button, townAddressInput: input, townAddressStatus: status }[id]), body: { classList: { contains: () => false } } },
    map: { hasLayer: () => false, setView() {}, getZoom: () => 10 }, window: {},
    L: { latLng: (lat, lng) => ({ lat, lng }), divIcon: () => ({}), marker: () => marker },
    findParcelFeatureForLocation: async () => null,
    openPersistentFloodPopup: (point, html) => popups.push(html)
  });
  vm.runInContext(source, context);
  return { context, timers, requests, button, input, status, popups };
}
const valid = { ok: true, json: async () => ({ candidates: [{ location: { x: -74.8, y: 39.005 }, address: '100 New Jersey Ave, North Wildwood', score: 100 }] }) };
const never = () => new Promise(() => {});

// A response or body that never settles cannot withhold a successful peer forever.
for (const stallBody of [false, true]) {
  const t = setup(url => url.includes('arcgis') ? Promise.resolve(valid) : stallBody ? Promise.resolve({ ok: true, json: never }) : never());
  let completed = false;
  const job = t.context.searchTownAddress(t.input.value).then(() => { completed = true; });
  await flush();
  assert.equal(completed, false);
  assert.equal(t.timers.size, 1, 'Only the stalled provider retains a deadline');
  for (const { fn, ms } of [...t.timers.values()]) { assert.equal(ms, 8000); fn(); }
  await job;
  assert.equal(t.requests.find(r => r.url.includes('nominatim')).signal.aborted, true);
  assert.equal(t.button.disabled, false);
  assert.match(t.status.textContent, /Closest match/);
  assert.equal(t.popups.length, 1);
  assert.equal(t.timers.size, 0);
}

// Both unavailable providers recover the UI, without placing a fake result.
{
  const t = setup(never);
  const job = t.context.searchTownAddress(t.input.value);
  await flush();
  for (const { fn } of [...t.timers.values()]) fn();
  await job;
  assert.equal(t.button.disabled, false);
  assert.match(t.status.textContent, /No close/);
  assert.equal(t.popups.length, 0);
  assert.equal(t.timers.size, 0);
}

// Clear and a replacement search abort both old providers and discard late results.
{
  const t = setup((url, options, count) => count > 2 ? Promise.resolve(url.includes('arcgis') ? valid : { ok: true, json: async () => [] }) : never());
  const first = t.context.searchTownAddress(t.input.value);
  await flush();
  const second = t.context.searchTownAddress(t.input.value);
  await Promise.all([first, second]);
  assert.ok(t.requests.slice(0, 2).every(r => r.signal.aborted));
  assert.equal(t.popups.length, 1);
  assert.equal(t.button.disabled, false);
  assert.equal(t.timers.size, 0);
}
{
  const t = setup(never);
  const job = t.context.searchTownAddress(t.input.value);
  await flush();
  t.context.clearTownAddressLookup();
  await job;
  assert.ok(t.requests.every(r => r.signal.aborted));
  assert.equal(t.button.disabled, false);
  assert.equal(t.status.textContent, '');
  assert.equal(t.input.value, '');
  assert.equal(t.popups.length, 0);
  assert.equal(t.timers.size, 0);
}
console.log('Address recovery passed: provider/body deadlines, partial success, clear and replacement cancellation.');
