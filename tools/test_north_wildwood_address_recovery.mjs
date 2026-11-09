// Exercise real provider fetches, deadlines and cancellation through address search.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('app/runtime/27-mobile-and-address.js', import.meta.url), 'utf8');
const parcelSource = fs.readFileSync(new URL('app/runtime/25-structures-and-parcels.js', import.meta.url), 'utf8');
const configSource = fs.readFileSync(new URL('app/town-config.js', import.meta.url), 'utf8');
const configStart = configSource.indexOf('TOWN_CONFIG = {') + 'TOWN_CONFIG = '.length;
const config = JSON.parse(configSource.slice(configStart, configSource.indexOf('\n};', configStart) + 2));
const flush = async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); };

function setup(fetchResult) {
  const timers = new Map();
  const requests = [];
  const events = {};
  const button = { disabled: false };
  const input = { value: '100 New Jersey Ave', focus() {}, addEventListener: (name, fn) => { events[name] = fn; } };
  const form = { dataset: {}, addEventListener: (name, fn) => { events[name] = fn; } };
  const status = { textContent: '', classList: { toggle() {} } };
  const marker = { setLatLng() {}, setIcon() {}, addTo() { return this; } };
  const popups = [];
  let activePopup = null;
  const context = vm.createContext({
    console, Promise, URLSearchParams, AbortController,
    TOWN_CONFIG: config, townAddressSearchGeneration: 0, townAddressMarker: null, municipalBoundaryFeature: null, mapQueryGeneration: 0,
    setTimeout: (fn, ms) => { const id = {}; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id),
    fetch: (url, options) => { requests.push({ url, ...options }); return fetchResult(url, options, requests.length); },
    document: { getElementById: id => ({ townAddressForm: form, townAddressSearchBtn: button, townAddressInput: input, townAddressStatus: status }[id]), body: { classList: { contains: () => false } } },
    map: { hasLayer: () => false, setView() {}, getZoom: () => 10 }, window: {},
    L: { latLng: (lat, lng) => ({ lat, lng }), divIcon: () => ({}), marker: () => marker },
    findParcelFeatureForLocation: async () => null,
    openPersistentFloodPopup(_point, html) {
      activePopup?.remove();
      let onRemove;
      const popup = { html, removed: false, once(_event, callback) { onRemove = callback; },
        remove() { this.removed = true; onRemove?.(); if (activePopup === this) activePopup = null; } };
      popups.push(popup);
      activePopup = popup;
      return popup;
    }
  });
  vm.runInContext(source, context);
  return { context, timers, requests, button, input, status, popups, events };
}
const valid = { ok: true, json: async () => ({ candidates: [{
  location: { x: -74.8, y: 39.005 }, address: '100 New Jersey Ave, North Wildwood',
  attributes: { Addr_type: 'PointAddress' }, score: 100
}] }) };
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
// Clear only owns the address result. A later ordinary map popup stays open.
for (const replacePopup of [false, true]) {
  const t = setup(url => Promise.resolve(url.includes('arcgis') ? valid : { ok: true, json: async () => [] }));
  await t.context.searchTownAddress(t.input.value);
  assert.equal(t.popups[0].removed, false);
  if (replacePopup) t.context.openPersistentFloodPopup(null, 'Independent map query');
  t.context.clearTownAddressLookup();
  assert.equal(t.popups[0].removed, true);
  if (replacePopup) assert.equal(t.popups[1].removed, false);
}
// Both providers must return address-level precision for a numbered lookup.
{
  const {context} = setup(never);
  const arcgis = (type, label, x = -74.79744, y = 38.99498) => ({
    attributes: { Addr_type: type, Match_addr: label }, location: { x, y }, score: 100
  });
  const street = arcgis('StreetName', 'Ocean Ave, Wildwood, New Jersey, 08260');
  const locality = arcgis('Locality', 'North Wildwood, New Jersey');
  assert.equal(context.normalizeArcgisTownCandidate(street, '9999 Ocean Avenue'), null);
  assert.equal(context.normalizeArcgisTownCandidate(locality, 'Totally Invalid Road'), null);
  assert.ok(context.normalizeArcgisTownCandidate(street, 'Ocean Avenue'));
  const exact = arcgis('PointAddress', '1601 Ocean Ave, Wildwood, New Jersey, 08260');
  assert.equal(context.normalizeArcgisTownCandidate(exact, '160 Ocean Avenue'), null);
  assert.equal(context.normalizeArcgisTownCandidate(exact, '1601 Oceen Avenue').streetAddress, '1601 ocean ave');
  const nominatim = { lat: '38.99498', lon: '-74.79744', address: { road: 'Ocean Avenue', village: 'North Wildwood' } };
  assert.equal(context.normalizeNominatimTownCandidate(nominatim, '1601 Ocean Avenue'), null);
  nominatim.address.house_number = '1601';
  assert.equal(context.normalizeNominatimTownCandidate(nominatim, '1601 Ocean Avenue').streetAddress, '1601 ocean ave');

  for (const name of ['pointInRing', 'pointInParcelFeature']) {
    const definition = parcelSource.match(new RegExp(`^    function ${name}\\([^\\n]*\\) \\{\\n.*?^    \\}`, 'ms'));
    assert.ok(definition, name);
    vm.runInContext(definition[0], context);
  }
  context.municipalBoundaryFeature = { geometry: { type: 'Polygon', coordinates: [
    [[-74.8, 38.99], [-74.79, 38.99], [-74.79, 39.01], [-74.8, 39.01], [-74.8, 38.99]]
  ] } };
  assert.ok(context.normalizeArcgisTownCandidate(exact, '1601 Ocean Avenue'));
  assert.equal(context.normalizeArcgisTownCandidate(
    arcgis('PointAddress', '3101 Pacific Ave, Wildwood, New Jersey, 08260', -74.81157, 38.99118),
    '3101 Pacific Avenue'), null);
}

// Native form wiring unlocks the second submission as soon as the user edits.
{
  const t = setup((url, options, count) => count <= 2 ? never() :
    Promise.resolve(url.includes('arcgis') ? valid : { ok: true, json: async () => [] }));
  t.context.wireTownAddressLookup();
  t.input.value = '200 Ocean Avenue';
  t.events.submit({ preventDefault() {} });
  assert.equal(t.button.disabled, true);
  t.input.value = '100 New Jersey Ave';
  t.events.input();
  assert.equal(t.button.disabled, false);
  assert.ok(t.requests.every(request => request.signal.aborted));
  t.events.submit({ preventDefault() {} });
  await new Promise(setImmediate);
  assert.equal(t.requests.length, 4);
  assert.match(t.status.textContent, /100 New Jersey Ave/);
  assert.equal(t.popups.length, 1);
}

console.log('Address recovery passed: provider precision, boundary, body deadlines, partial success, popup ownership, clear and form replacement cancellation.');
