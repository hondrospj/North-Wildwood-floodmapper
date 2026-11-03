// Execute the real Escape listener: a nested validation warning must not
// dismiss its export form or trigger the unrelated cancellation paths.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const eventPath = process.argv[2] || new URL('app/runtime/28-tutorial-and-events.js', import.meta.url);
const events = fs.readFileSync(eventPath, 'utf8');
const listener = events.match(/document\.addEventListener\("keydown", e => \{\n        if \(e\.key === "Escape"\) \{[\s\S]*?\n      \}\);/)?.[0];
assert.ok(listener, 'The application Escape handler must be present');
const calendars = fs.readFileSync(new URL('app/runtime/14-export-calendars.js', import.meta.url), 'utf8');
const closeWarning = calendars.match(/    function closeExportDateOrderPopup\(\) \{[\s\S]*?\n    \}/)?.[0];
assert.ok(closeWarning, 'Use the application warning close function');

function fixture({ warning = 'open', paused = false, exporting = false, progress = false } = {}) {
  const classes = new Set(warning === 'open' ? ['open'] : []);
  const modal = warning === 'missing' ? null : { hidden: warning !== 'open', classList: {
    remove: name => classes.delete(name),
  } };
  const form = { hidden: false, start: '11/07/2026', end: '11/06/2026', aspect: 'square', speed: 'slow' };
  const calls = [];
  let onKey;
  const context = vm.createContext({
    document: {
      getElementById(id) {
        if (id === 'exportOrderModal') return modal;
        if (id === 'calendarPopover') return { classList: { contains: () => false } };
        return null;
      },
      addEventListener(type, callback) { assert.equal(type, 'keydown'); onKey = callback; },
    },
    setDownloadModalOpen: value => { calls.push(['download', value]); form.hidden = !value; },
    setDatumHelpOpen: value => calls.push(['datum', value]),
    setInfoModalOpen: value => calls.push(['info', value]),
    setObservedCalendarOpen: value => calls.push(['calendar', value]),
    setCalendarPopoverOpen: value => calls.push(['popover', value]),
    setTopTidesModalOpen: value => calls.push(['top-tides', value]),
    setPlaybackStillThereOpen: value => calls.push(['playback-prompt', value]),
    setExportProgressVisible: value => calls.push(['progress', value]),
    toast: value => calls.push(['toast', value]),
    stopPlayback: () => calls.push(['stop-playback']),
    cancelCurrentExport: () => calls.push(['cancel-export']),
    isExportProgressOpen: () => progress,
    playbackPausedForConfirmation: paused,
    exportInProgress: exporting,
  });
  vm.runInContext(closeWarning + '\n' + listener, context);
  return { modal, classes, form, calls, key(key = 'Escape') {
    const event = { key, prevented: false, stopped: false,
      preventDefault() { this.prevented = true; },
      stopImmediatePropagation() { this.stopped = true; },
    };
    onKey(event);
    return event;
  } };
}

let checks = 0;
for (const state of [
  {},
  { paused: true },
  { exporting: true, progress: true },
  { paused: true, exporting: true, progress: true },
]) {
  const f = fixture(state), before = { ...f.form };
  const event = f.key();
  assert.equal(f.modal.hidden, true, 'Escape closes the active range warning');
  assert.equal(f.classes.has('open'), false);
  assert.deepEqual(f.form, before, 'The parent and edited range/options remain intact');
  assert.deepEqual(f.calls, [], 'A warning dismissal must not close other dialogs, stop playback or cancel exports');
  assert.equal(event.prevented, true);
  assert.equal(event.stopped, true, 'Later document handlers must not also consume the child Escape');
  checks++;
}
{
  const f = fixture(), before = { ...f.form };
  f.key('ArrowRight');
  assert.equal(f.modal.hidden, false, 'Other keys do not dismiss a warning');
  assert.deepEqual(f.form, before);
  assert.deepEqual(f.calls, []);
  f.key();
  f.key();
  assert.equal(f.form.hidden, true, 'The next Escape still closes the parent normally');
  assert.equal(f.calls.filter(([name]) => name === 'download').length, 1);
  checks++;
}
for (const warning of ['closed', 'missing']) {
  const f = fixture({ warning });
  const event = f.key();
  assert.equal(f.form.hidden, true, 'The existing parent Escape path remains available without a warning');
  assert.ok(f.calls.some(([name, value]) => name === 'download' && value === false));
  assert.ok(f.calls.some(([name, value]) => name === 'toast' && value === ''));
  assert.equal(event.prevented, false);
  assert.equal(event.stopped, false);
  checks++;
}
{
  const f = fixture({ warning: 'closed', paused: true, exporting: true, progress: true });
  f.key();
  assert.ok(f.calls.some(([name]) => name === 'stop-playback'));
  assert.ok(f.calls.some(([name]) => name === 'cancel-export'));
  assert.ok(!f.calls.some(([name]) => name === 'progress'), 'An active export retains its existing cancel path');
  checks++;
}
console.log(JSON.stringify({ passed: true, checks, source: String(eventPath) }));
