#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readAppSource } from './app_source.mjs';

const html = readAppSource(process.argv[2] || 'index.html');
const controller = html.match(/<script\b[^>]*\bid="floodmapper-unified-controller-20261017"[^>]*>([\s\S]*?)<\/script>/)?.[1];
assert.ok(controller, 'The unified controller must exist.');
const dismiss = controller.match(/document\.addEventListener\('keydown',event=>\{([\s\S]*?)\n \},true\);/)?.[1];
const setLegend = controller.match(/ function setLegend\(open\)\{[\s\S]*?\n \}/)?.[0];
assert.ok(dismiss && setLegend, 'Use the shipped controller to exercise legend dismissal.');
assert.match(html, /<button id="nwwMobileLegendToggle" type="button" aria-controls="legendDock" aria-expanded="false">Legend<\/button>/);
assert.match(html, /<section id="legendDock"/);

function testKey(target, key, { mobile = true, modal = false } = {}) {
  const state = { open: true, expanded: 'true', focus: false, dismissed: false, stopped: false, scheduled: 0 };
  const env = {
    mobile: { matches: mobile },
    body: { classList: { contains: name => name === 'mobile-legend-open' && state.open } },
    panel: {},
    document: { querySelectorAll: () => modal ? [{}] : [] },
    visible: () => true,
    legendToggle: { focus: () => { state.focus = true; } },
    flag: (_body, _name, open) => { state.open = open; },
    attr: (_element, name, value) => { if (name === 'aria-expanded') state.expanded = value; },
    schedule: () => { state.scheduled++; },
  };
  const event = {
    target, key,
    preventDefault() { state.dismissed = true; },
    stopImmediatePropagation() { state.stopped = true; },
  };
  new Function('env', 'event', `with (env) { ${setLegend}\n ${dismiss}\n }`)(env, event);
  return state;
}

const unhandled = { open: true, expanded: 'true', focus: false, dismissed: false, stopped: false, scheduled: 0 };
for (const key of ['Enter', ' ']) {
  for (const id of ['nwwMobileLegendToggle', 'legendHelpBtn', 'legendHeader']) {
    assert.deepEqual(testKey({ id }, key), unhandled, `${id}: keep native keyboard activation`);
  }
}
assert.deepEqual(testKey({}, 'Escape'), {
  open: false, expanded: 'false', focus: true, dismissed: true, stopped: true, scheduled: 1,
});
assert.deepEqual(testKey({}, 'Escape', { modal: true }), unhandled);
assert.deepEqual(testKey({}, 'Escape', { mobile: false }), unhandled);
console.log('Legend uses native buttons and restores focus after Escape.');
