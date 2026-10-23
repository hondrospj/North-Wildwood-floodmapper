#!/usr/bin/env node
import { readAppSource } from './app_source.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Run the shipped controller's own handler and normalization, without loading
// maps, fetching data, or changing the source file. No browser dependencies.
const sourcePath = process.argv[2];
if (!sourcePath) {
  console.error('Usage: node legend-keyboard.mjs /absolute/path/to/index.html');
  process.exit(2);
}
const html = readAppSource(sourcePath);
const controller = html.match(/<script\b[^>]*\bid="floodmapper-unified-controller-20261017"[^>]*>([\s\S]*?)<\/script>/)?.[1];
assert.ok(controller, 'The unified controller must exist in the supplied HTML');
const keyboardBody = controller.match(/document\.addEventListener\('keydown',event=>\{([\s\S]*?)\n \},true\);/)?.[1];
const normalizeSource = controller.match(/ function normalize\(\)\{[\s\S]*?\n \}/)?.[0];
assert.ok(keyboardBody, 'The unified document keydown handler must be found');
assert.ok(normalizeSource, 'The unified normalize function must be found');

class Element {
  constructor(id, tagName = 'section', parent = null) {
    this.id = id;
    this.tagName = tagName.toUpperCase();
    this.parentElement = parent;
    this.attributes = new Map();
    this.focusCalls = 0;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  hasAttribute(name) { return this.attributes.has(name); }
  set tabIndex(value) { this.setAttribute('tabindex', value); }
  get tabIndex() { return Number(this.getAttribute('tabindex') ?? -1); }
  focus() { this.focusCalls++; }
  matches(selector) {
    return selector.split(',').some(part => {
      const item = part.trim();
      if (item.startsWith('#')) return this.id === item.slice(1);
      return item.toUpperCase() === this.tagName;
    });
  }
  closest(selector) {
    return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null;
  }
}

function fixture(compact = true) {
  const classes = new Set();
  const legend = new Element('legendDock');
  const help = new Element('legendHelpBtn', 'button', legend);
  const helpIcon = new Element('helpIcon', 'span', help);
  const header = new Element('legendHeader', 'div', legend);
  const body = {
    classList: {
      contains: name => classes.has(name),
      add: name => classes.add(name),
      remove: name => classes.delete(name),
    },
  };
  const state = { scheduled: 0 };
  const panel = { querySelector: () => null, querySelectorAll: () => [], contains: () => false };
  const document = {
    activeElement: legend,
    getElementById: id => id === 'legendDock' ? legend : null,
    querySelectorAll: () => [],
  };
  const env = {
    mobile: { matches: compact }, body, panel, document,
    timeline: { querySelectorAll: () => [] },
    groups: {}, Node: { TEXT_NODE: 3 },
    visible: () => true,
    flag: (_element, name, enabled) => enabled ? classes.add(name) : classes.delete(name),
    schedule: () => state.scheduled++,
    attr: (element, name, value) => element?.setAttribute(name, value),
    text: () => {}, set: () => {},
    ensureControlButtons: () => {}, ensureHeader: () => {},
    ensureDays: () => {}, ensureLayers: () => {},
  };
  const onKey = new Function('env', 'event', `with (env) { ${keyboardBody}\n }`);
  const normalize = new Function('env', `with (env) { ${normalizeSource}\n normalize(); }`);
  return { classes, legend, help, helpIcon, header, state, env,
    normalize: () => normalize(env),
    key(target, key) {
      const event = {
        key, target, defaultPrevented: false, propagationStopped: false,
        preventDefault() { this.defaultPrevented = true; },
        stopImmediatePropagation() { this.propagationStopped = true; },
      };
      onKey(env, event);
      return event;
    },
  };
}

const checks = [];
function check(name, run) {
  try { run(); checks.push({ name, passed: true }); }
  catch (error) { checks.push({ name, passed: false, error: error.message }); }
}

for (const key of ['Enter', ' ']) {
  for (const targetName of ['help', 'helpIcon']) {
    check(`${JSON.stringify(key)} on nested ${targetName} preserves native activation`, () => {
      const f = fixture();
      f.classes.add('mobile-legend-open');
      const event = f.key(f[targetName], key);
      assert.equal(f.classes.has('mobile-legend-open'), true, 'Nested help must leave the key open');
      assert.equal(event.defaultPrevented, false, 'Native button activation must remain available');
      assert.equal(event.propagationStopped, false, 'The help handler must remain reachable');
      assert.equal(f.state.scheduled, 0, 'Help activation must not schedule a container toggle');
    });
  }
  for (const targetName of ['legend', 'header']) {
    check(`${JSON.stringify(key)} on ${targetName} toggles the compact key`, () => {
      const f = fixture();
      const open = f.key(f[targetName], key);
      assert.equal(f.classes.has('mobile-legend-open'), true);
      assert.equal(open.defaultPrevented, true);
      assert.equal(open.propagationStopped, true);
      const close = f.key(f[targetName], key);
      assert.equal(f.classes.has('mobile-legend-open'), false);
      assert.equal(close.defaultPrevented, true);
      assert.equal(close.propagationStopped, true);
      assert.equal(f.state.scheduled, 2);
    });
  }
  check(`${JSON.stringify(key)} does not turn a desktop legend into a button`, () => {
    const f = fixture(false);
    const event = f.key(f.legend, key);
    assert.equal(f.classes.has('mobile-legend-open'), false);
    assert.equal(event.defaultPrevented, false);
    assert.equal(event.propagationStopped, false);
    assert.equal(f.state.scheduled, 0);
  });
}

check('Compact legend exposes its button state', () => {
  const f = fixture();
  f.normalize();
  assert.equal(f.legend.getAttribute('role'), 'button');
  assert.equal(f.legend.getAttribute('tabindex'), '0');
  assert.equal(f.legend.getAttribute('aria-expanded'), 'false');
  f.classes.add('mobile-legend-open');
  f.normalize();
  assert.equal(f.legend.getAttribute('aria-expanded'), 'true');
});

check('Desktop transition clears compact-only button semantics', () => {
  const f = fixture();
  f.normalize();
  f.env.mobile.matches = false;
  f.normalize();
  assert.notEqual(f.legend.getAttribute('role'), 'button', 'Desktop legend is not an interactive container');
  assert.equal(f.legend.hasAttribute('tabindex'), false, 'Desktop legend must not add a dead tab stop');
  assert.equal(f.legend.hasAttribute('aria-expanded'), false, 'Desktop legend is not collapsible');
});

const failed = checks.filter(check => !check.passed);
console.log(JSON.stringify({ source: path.resolve(sourcePath), passed: checks.length - failed.length,
  failed: failed.length, checks }, null, 2));
process.exitCode = failed.length ? 1 : 0;
