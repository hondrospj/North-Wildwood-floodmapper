import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./app/runtime/24-alerts-and-projections.js', import.meta.url), 'utf8');
const start = source.indexOf('    async function checkNwsAlerts()');
assert.ok(start >= 0);
const body = source.slice(start, source.indexOf('\n    }', start) + 6);
let now = Date.parse('2026-11-01T12:00:00Z');
class TestDate extends Date {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
}
const alert = (id, event, expires) => ({ id, properties: { event, expires } });
const warning = alert('warning', 'Coastal Flood Warning', '2026-11-01T15:00:00Z');
const advisory = alert('advisory', 'Coastal Flood Advisory', '2026-11-01T16:00:00Z');
const banner = [], count = {};
let responses = { NJZ024: [warning], NJC009: [] };
const context = vm.createContext({ Date: TestDate, Set, Promise, nwsAlertPromise: null,
  lastSuccessfulNwsAlerts: null, NWS_POINT_URL: null,
  TOWN_CONFIG: { alerts: { zoneCodes: ['NJZ024', 'NJC009'] } },
  document: { body: { dataset: {} }, getElementById: () => count },
  formatLocalBannerTime: String, setBanner: (...args) => banner.push(args),
  fetchJson: async url => {
    const value = responses[new URL(url).searchParams.get('zone')];
    if (value instanceof Error) throw value;
    return { features: value };
  }
});
vm.runInContext(body, context);
assert.equal(await context.checkNwsAlerts(), 'active');
assert.equal(banner.at(-1)[1], 'Coastal Flood Warning');
const checkedAt = context.lastSuccessfulNwsAlerts.checkedAt;
responses = { NJZ024: new Error('offline'), NJC009: [advisory] };
assert.equal(await context.checkNwsAlerts(), 'stale');
assert.equal(banner.at(-1)[3], 2, 'A partial outage discarded the still-current warning from the failed zone');
assert.equal(banner.at(-1)[1], 'Coastal Flood Warning', 'A less urgent fresh advisory hid a still-current warning');
assert.equal(count.textContent, '2 last reported');
assert.equal(context.lastSuccessfulNwsAlerts.checkedAt, checkedAt, 'A partial update is not a complete successful check');
now = Date.parse('2026-11-01T15:30:00Z');
responses = { NJZ024: new Error('offline'), NJC009: new Error('offline') };
assert.equal(await context.checkNwsAlerts(), 'stale');
assert.equal(banner.at(-1)[1], 'Coastal Flood Advisory', 'A fresh partial-zone alert must survive a later full outage');
assert.equal(banner.at(-1)[3], 1, 'The expired warning must be removed while the advisory remains current');
now = Date.parse('2026-11-01T16:30:00Z');
assert.equal(await context.checkNwsAlerts(), 'stale');
assert.equal(banner.at(-1)[1], 'Flood alert status unavailable', 'An expired cached warning remained displayed');
assert.equal(banner.at(-1)[3], 0);
assert.equal(count.textContent, 'Status unknown');
now = Date.parse('2026-11-01T12:00:00Z');
responses = { NJZ024: [advisory], NJC009: [advisory] };
assert.equal(await context.checkNwsAlerts(), 'active');
assert.equal(banner.at(-1)[3], 1, 'Duplicate zone alerts must count once');
responses = { NJZ024: [], NJC009: [] };
assert.equal(await context.checkNwsAlerts(), 'none');
assert.equal(banner.at(-1)[0], false, 'A healthy all-clear should clear previous alerts');

// An authoritative all-clear for one zone must not be undone by another zone's
// outage, and a fresh warning from the first partial response remains usable.
responses = { NJZ024: [warning], NJC009: [] };
assert.equal(await context.checkNwsAlerts(), 'active');
responses = { NJZ024: [], NJC009: new Error('offline') };
assert.equal(await context.checkNwsAlerts(), 'stale');
assert.equal(banner.at(-1)[3], 0, 'A healthy zone all-clear must discard that zone\'s cached warning');
assert.equal(count.textContent, 'Status unknown', 'An unreachable other zone cannot imply a complete all-clear');
responses = { NJZ024: new Error('offline'), NJC009: new Error('offline') };
assert.equal(await context.checkNwsAlerts(), 'stale');
assert.equal(banner.at(-1)[3], 0, 'A cleared warning must not return during the next outage');
context.lastSuccessfulNwsAlerts = null;
responses = { NJZ024: [warning], NJC009: new Error('offline') };
assert.equal(await context.checkNwsAlerts(), 'stale');
assert.equal(context.lastSuccessfulNwsAlerts.checkedAt, undefined, 'A first partial response must not claim a full successful check');
responses = { NJZ024: new Error('offline'), NJC009: new Error('offline') };
assert.equal(await context.checkNwsAlerts(), 'stale');
assert.equal(banner.at(-1)[1], 'Coastal Flood Warning', 'A first partial response must be cached before any fully successful check');
assert.equal(banner.at(-1)[3], 1);
console.log('Alert per-zone outage retention, authoritative all-clear, partial-first cache, expiry, deduplication, and recovery passed');
