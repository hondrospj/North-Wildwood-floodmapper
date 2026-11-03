import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

const root = process.env.NWW_ARIA_SOURCE_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const template = fs.readFileSync(path.join(root, 'tools/app/index.template.html'), 'utf8');
const picker = fs.readFileSync(path.join(root, 'assets/export-date-time-picker.js'), 'utf8');
assert.match(template, /<div id="map3d" role="region" aria-label="Interactive 3D North Wildwood flood map"><\/div>/);
function extract(name) {
  const match = picker.match(new RegExp('^  function ' + name + '\\([^\\n]*\\) \\{\\n[^]*?^  }\\n', 'm'));
  assert.ok(match, `Missing actual picker owner ${name}`);
  return match[0];
}
class Element {
  constructor() { this.attrs = {}; this.listeners = {}; this.dataset = {}; this.classList = {add(){}}; this.isConnected = true; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return this.attrs[name] ?? null; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  append() {}
  before() {}
  remove() { this.removed = true; }
  focus() { focused = this; }
}
const elements = new Map(), editors = new Map();
for (const prefix of ['start', 'end']) {
  const cap = prefix === 'end' ? 'End' : 'Start';
  editors.set(prefix, {dateText:new Element(), datePicker:new Element(), timeSelect:new Element(), canonical:{id:`download${cap}Input`}});
  elements.set(`download${cap}CalendarBtn`, new Element());
}
elements.set('downloadModal', new Element());
const card = new Element();
let focused = null;
const ctx = vm.createContext({
  window:{addEventListener(){},NORTH_WILDWOOD_EXPORT_PICKER:{}},
  document:{getElementById:id=>elements.get(id),querySelector:()=>card,addEventListener(){}},
  MutationObserver:class { observe(){} },
  getExportDateEditorElements:prefix=>editors.get(prefix),
  node:()=>new Element(),button:()=>new Element(),
  syncTimeButton(){},populateExportTimeSelect(){},openDate(){},openTime(){},position(){},
  isDownloadModalOpen:()=>true,exportInProgress:false,currentDataMode:"forecast",
  getRangeInputDate:()=>new Date("2026-11-03T12:00:00Z"),dayKey:()=>"2026-11-03",
  ensureExportArchiveAvailability:()=>Promise.resolve(),renderCalendar(){},
});
vm.runInContext('let active = null; const ID = "nwwExportDateTimePicker";\n' + ['close','create','openDate','init'].map(extract).join('\n'), ctx);
ctx.init();
let checks = 1;
function state(prefix, expanded) {
  const cap = prefix === 'end' ? 'End' : 'Start';
  const input = editors.get(prefix).dateText, button = elements.get(`download${cap}CalendarBtn`);
  assert.equal(input.getAttribute('role'), 'combobox');
  for (const trigger of [input, button]) {
    assert.equal(trigger.getAttribute('aria-haspopup'), 'dialog');
    assert.equal(trigger.getAttribute('aria-expanded'), String(expanded));
    if (expanded) assert.equal(trigger.getAttribute('aria-controls'), 'nwwExportDateTimePicker');
  }
  checks++;
}
for (const prefix of ['start','end']) state(prefix, false);
for (const prefix of ['start','end']) {
  const cap = prefix === 'end' ? 'End' : 'Start';
  for (const anchor of [editors.get(prefix).dateText,elements.get(`download${cap}CalendarBtn`)]) {
    ctx.create(prefix, 'date', anchor);
    state(prefix, true);
    ctx.close(true);
    state(prefix, false);
    assert.equal(focused, anchor, 'Closing preserves the original invocation anchor');
    checks++;
  }
}
ctx.create('start','date',editors.get('start').dateText);
ctx.create('end','date',elements.get('downloadEndCalendarBtn'));
state('start',false);state('end',true);
const timeButton = new Element();
ctx.create('end','time',timeButton);
state('end',false);
assert.equal(timeButton.getAttribute('aria-expanded'),'true');
ctx.close(true);
assert.equal(timeButton.getAttribute('aria-expanded'),'false');
assert.equal(focused,timeButton);
checks++;
for (const prefix of ['start','end']) {
  editors.get(prefix).dateText.listeners.keydown({key:'ArrowDown',preventDefault(){}});
  state(prefix,true);ctx.close(true);state(prefix,false);
  assert.equal(focused,editors.get(prefix).dateText,'Input ArrowDown returns focus to the invoking combobox');checks++;
}
ctx.close(); // An already closed picker remains a no-op.
state('start',false);state('end',false);
console.log(`PASS ARIA semantics: ${checks} named-region, real picker role/state, ownership, transition and focus checks.`);
