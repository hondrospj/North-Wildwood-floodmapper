// Exercise authoring sources directly so these regressions cannot pass against
// stale generated assets. The one shipped archive day is a small local fixture.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = name => fs.readFileSync(new URL(`app/runtime/${name}.js`, import.meta.url), 'utf8');
const source = ['03-time-series', '04-observation-archives', '11-export-selection', '12-export-date-editors',
  '13-export-range', '14-export-calendars', '16-export-map', '17-export-encoding'].map(read).join('\n');
const extract = name => {
  const match = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n    }`));
  assert.ok(match, `Missing ${name}`);
  return match[0];
};
const noop = () => {};
function context(names, mocks = {}) {
  const ctx = vm.createContext({ console, Date, Intl, Map, Set, setTimeout, clearTimeout,
    NY_PARTS_FORMATTER: new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', minute: '2-digit',
      hour12: true, timeZoneName: 'short' }),
    pad2: value => String(value).padStart(2, '0'), ...mocks });
  names.forEach(name => vm.runInContext(extract(name), ctx));
  return ctx;
}
const timeFunctions = ['getNyParts', 'formatNyLocalIso', 'getLocalNyDateCandidates', 'parseStoredLocalNyToDate'];

// The mask keeps a ten-character value even when a digit is deleted. A native
// maxlength would make WebKit truncate an insertion before our beforeinput
// handler receives the digit. The mask itself owns its length limit.
{
  const template = fs.readFileSync(new URL('app/index.template.html', import.meta.url), 'utf8');
  for (const id of ['downloadStartDateText', 'downloadEndDateText']) {
    const tag = template.match(new RegExp(`<input\\b[^>]*\\bid="${id}"[^>]*>`))?.[0];
    assert.ok(tag, `Missing ${id}`);
    assert.doesNotMatch(tag, /\bmaxlength\s*=/i, `${id} must leave insertion data available to the mask`);
  }
}

// New York's missing and repeated hours are distinguished without depending on
// the browser's own timezone. Invalid calendar rollover is rejected as well.
{
  const ctx = context(timeFunctions);
  assert.equal(ctx.parseStoredLocalNyToDate('2026-03-08T02:30'), null);
  assert.equal(ctx.parseStoredLocalNyToDate('2026-02-30T12:00'), null);
  assert.equal(ctx.parseStoredLocalNyToDate('2026-01-01T24:00'), null);
  assert.equal(ctx.parseStoredLocalNyToDate('2026-07-01T12:00').toISOString(), '2026-07-01T16:00:00.000Z');
  assert.equal(ctx.parseStoredLocalNyToDate('2026-01-01T12:00').toISOString(), '2026-01-01T17:00:00.000Z');
  assert.deepEqual(Array.from(ctx.getLocalNyDateCandidates('2025-11-02T01:30'), date => date.toISOString()),
    ['2025-11-02T05:30:00.000Z', '2025-11-02T06:30:00.000Z']);
  assert.equal(ctx.parseStoredLocalNyToDate('2025-11-02T01:30').toISOString(), '2025-11-02T05:30:00.000Z',
    'Legacy wall-only records keep the earlier instant');
}

// Test every digit position, both deletion directions and multiple successive
// edits. A replacement must never move an untouched month/day/year digit.
{
  const positions = [0, 1, 3, 4, 6, 7, 8, 9];
  const animationFrames = [];
  const ctx = context(['exportDateMaskPlaceholderAt', 'formatExportDateMask', 'normalizeExportDateMask',
    'getNextExportDateMaskPosition', 'setExportDateMaskCaret', 'clearExportDateMaskRange',
    'insertExportDateMaskDigits', 'deleteExportDateMaskDigits'], {
    EXPORT_DATE_MASK: 'MM/DD/YYYY', EXPORT_DATE_MASK_POSITIONS: positions,
    requestAnimationFrame: fn => animationFrames.push(fn),
  });
  const inputAt = position => ({ value: '10/26/2026', selectionStart: position, selectionEnd: position,
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; } });
  for (const position of positions) {
    for (const backward of [true, false]) {
      const input = inputAt(backward ? position + 1 : position);
      ctx.deleteExportDateMaskDigits(input, backward);
      ctx.insertExportDateMaskDigits(input, '10/26/2026'[position]);
      assert.equal(input.value, '10/26/2026', `Roundtrip position ${position}, backward=${backward}`);
    }
  }
  const start = inputAt(0);
  ctx.deleteExportDateMaskDigits(start, true);
  assert.equal(start.value, '10/26/2026', 'Backspace at the start does nothing');
  const range = inputAt(3); range.selectionEnd = 5;
  ctx.deleteExportDateMaskDigits(range, false);
  ctx.insertExportDateMaskDigits(range, '25');
  assert.equal(range.value, '10/25/2026');
  range.selectionStart = range.selectionEnd = 8;
  ctx.deleteExportDateMaskDigits(range, true);
  ctx.deleteExportDateMaskDigits(range, true);
  ctx.insertExportDateMaskDigits(range, '20');
  assert.equal(range.value, '10/25/2026');
  const rapid = inputAt(8);
  ctx.deleteExportDateMaskDigits(rapid, true);
  ctx.insertExportDateMaskDigits(rapid, '0');
  assert.equal(rapid.value, '10/26/2026', 'A following key works before any animation frame');
  ctx.setExportDateMaskCaret(rapid, 10);
  rapid.selectionStart = rapid.selectionEnd = 8; // Native ArrowLeft twice.
  animationFrames.splice(0).forEach(callback => callback());
  assert.equal(rapid.selectionStart, 8, 'A queued caret write cannot overwrite later arrow movement');
  const overflow = inputAt(0);
  ctx.insertExportDateMaskDigits(overflow, '12345678901234567890');
  assert.equal(overflow.value, '12/34/5678', 'The mask enforces eight digits without native maxlength');
}

// A small DOM surface exercises real editor population and commits, including
// re-rendering a seeded second occurrence of the repeated hour.
function editorContext() {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) {
      const element = { id, value: '', dataset: {}, options: [], style: {},
        classList: { add: noop, remove: noop, toggle: noop },
        setAttribute: noop, removeAttribute: noop };
      Object.defineProperty(element, 'innerHTML', { set(markup) {
        element.options = Array.from(markup.matchAll(/<option value="([^"]+)"([^>]*)>([^<]*)<\/option>/g),
          match => ({ value: match[1], disabled: match[2].includes('disabled'), textContent: match[3] }));
      }});
      nodes.set(id, element);
    }
    return nodes.get(id);
  };
  const errors = [];
  const ctx = context([...timeFunctions, 'parseExportDateText', 'formatExportTimeLabel', 'getExportTimeSelection',
    'populateExportTimeSelect', 'getExportDateEditorElements', 'getExportEditorPrefixFromCanonicalId',
    'syncExportDateTimeEditorFromCanonical', 'commitExportDateTimeEditor', 'getRangeInputDate', 'setRangeInputDate'], {
    document: { getElementById: node }, currentDataMode: 'observed', exportInProgress: false,
    EXPORT_DATE_MASK: 'MM/DD/YYYY', MODELED_EXPORT_DATE_PLACEHOLDER: 'xx/xx/xxxx',
    setDownloadStatus: message => errors.push(message),
  });
  return { ctx, node, errors };
}
{
  const { ctx, node } = editorContext();
  for (const [utc, zone] of [['2025-11-02T05:30:00Z', 'EDT (first)'], ['2025-11-02T06:30:00Z', 'EST (second)']]) {
    ctx.setRangeInputDate('downloadStartInput', new Date(utc));
    const selected = node('downloadStartTimeSelect').options.find(option => option.value === node('downloadStartTimeSelect').value);
    assert.ok(selected.textContent.endsWith(zone));
    assert.equal(ctx.getRangeInputDate('downloadStartInput').getTime(), Date.parse(utc));
    assert.equal(ctx.commitExportDateTimeEditor('start'), true);
    ctx.syncExportDateTimeEditorFromCanonical('start');
    assert.equal(ctx.getRangeInputDate('downloadStartInput').getTime(), Date.parse(utc));
  }
  const choices = node('downloadStartTimeSelect').options.filter(option => option.value.startsWith('01:30|'));
  assert.equal(choices.length, 2);
  node('downloadStartTimeSelect').value = choices[0].value;
  ctx.commitExportDateTimeEditor('start');
  assert.equal(ctx.getRangeInputDate('downloadStartInput').toISOString(), '2025-11-02T05:30:00.000Z');
  node('downloadStartTimeSelect').value = choices[1].value;
  ctx.commitExportDateTimeEditor('start');
  assert.equal(ctx.getRangeInputDate('downloadStartInput').toISOString(), '2025-11-02T06:30:00.000Z');
}
{
  const { ctx, node, errors } = editorContext();
  ctx.setRangeInputDate('downloadStartInput', new Date('2026-03-07T07:30:00Z'));
  node('downloadStartDateText').value = '03/08/2026';
  assert.equal(ctx.commitExportDateTimeEditor('start', { showError: true }), false);
  assert.match(errors.at(-1), /does not occur/);
  assert.equal(ctx.getRangeInputDate('downloadStartInput'), null);
  ctx.syncExportDateTimeEditorFromCanonical('start');
  assert.equal(node('downloadStartDateText').value, '03/08/2026', 'An invalid time must not silently revert to the previous day');
  assert.equal(ctx.getRangeInputDate('downloadStartInput'), null);
  const select = node('downloadStartTimeSelect');
  assert.equal(select.options.find(option => option.value === '02:30').disabled, true);
  assert.ok(!select.options.some(option => option.value === '02:00'));
  select.value = '03:30';
  assert.equal(ctx.commitExportDateTimeEditor('start'), true);
  assert.equal(ctx.getRangeInputDate('downloadStartInput').toISOString(), '2026-03-08T07:30:00.000Z');
}

// Keep all 100 real source instants on the shipped fall-back day. Preference
// for a forecast at one exact instant must not delete the other 01:00 reading.
{
  const fixture = JSON.parse(fs.readFileSync(new URL('fixtures/north-wildwood-export-dst.json', import.meta.url), 'utf8'));
  const archive = new URL(`../${fixture.source}`, import.meta.url);
  if (fs.existsSync(archive)) {
    const shipped = JSON.parse(fs.readFileSync(archive, 'utf8')).days.find(day => day.d === fixture.day.d);
    assert.deepEqual(fixture.day, shipped, 'The compact fixture must match its shipped archive source');
  }
  const day = { date: fixture.day.d, hours: [] };
  let forecast = [];
  const ctx = context([...timeFunctions, 'setTimelineSlotFields', 'detectSeriesResolutionMinutes',
    'buildQuarterHourTimelineSeries', 'decodeObserved15MinuteDay', 'getObservedRangeExportEntries',
    'getDownloadSourceEntries', 'findClosestExportEntryForSlot', 'buildHourlyRangeFrameItems',
    'buildQuarterHourRangeFrameItems'], {
    currentDataMode: 'observed', getObservedDays: () => [day],
    getObservedSourceHoursForDay: () => day.hours, getForecastExportEntries: () => forecast,
    observed15MinuteData: {}, TOWN_CONFIG: { observed: { usgsGaugeId: '01411360' } },
    entryTimeMs: entry => Date.parse(entry.timeUtc), getEntryESTDate: entry => new Date(entry.timeUtc),
    getStageValue: entry => entry.navd88StageFt,
    getDownloadFrameItemFromEntry: entry => ({ entry }),
  });
  day.hours = ctx.decodeObserved15MinuteDay(fixture.day);
  const start = ctx.parseStoredLocalNyToDate(`${day.date}T00:00`);
  const end = ctx.parseStoredLocalNyToDate(`${day.date}T23:45`);
  const actual = ctx.getDownloadSourceEntries(true, start, end);
  assert.equal(actual.length, 100);
  assert.deepEqual(Array.from(actual, entry => [entry.timeUtc, entry.navd88StageFt]),
    Array.from(day.hours, entry => [entry.timeUtc, entry.navd88StageFt]));
  const range = { startMs: start.getTime(), endMs: end.getTime() };
  const hourly = ctx.buildHourlyRangeFrameItems(actual, range);
  assert.equal(hourly.length, 25);
  assert.equal(hourly[1].entry.timeUtc, '2025-11-02T05:00:00.000Z');
  assert.equal(hourly[2].entry.timeUtc, '2025-11-02T06:00:00.000Z');
  const quarterHourly = ctx.buildQuarterHourRangeFrameItems(actual, range);
  assert.equal(quarterHourly.length, 100);
  assert.deepEqual(Array.from(quarterHourly, item => [item.entry.timeUtc, item.entry.navd88StageFt]),
    Array.from(day.hours, entry => [entry.timeUtc, entry.navd88StageFt]));
  forecast = [{ ...day.hours[8], navd88StageFt: 99, exportSourceMode: 'forecast' }];
  const merged = ctx.getDownloadSourceEntries(true, start, end);
  assert.equal(merged.length, 100);
  assert.equal(merged[4].navd88StageFt, day.hours[4].navd88StageFt);
  assert.equal(merged[8].navd88StageFt, 99);
}

// Cancellation while the archive promise is pending must stop before creating
// frame items, encoding or downloads; failure and retry share the same cleanup.
for (const outcome of ['cancel-resolve', 'cancel-reject', 'archive-error', 'success']) {
  let release, reject, downloads = 0, frameBuilds = 0, libraries = 0;
  const archive = new Promise((resolve, fail) => { release = resolve; reject = fail; });
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { id, textContent: '', classList: { toggle: noop }, dataset: {}, setAttribute: noop });
    return nodes.get(id);
  };
  let modalOpen = true, progress = '', cancelled = 0, failed = 0;
  const ctx = context(['setDownloadBusy', 'makeExportCancelledError', 'throwIfExportCancelled',
    'cancelCurrentExport', 'isExportCancelledError', 'downloadCurrentSelection'], {
    document: { getElementById: node, querySelectorAll: () => [] },
    exportInProgress: false, exportCancelRequested: false, activeGifExport: null, exportViewportBounds: null,
    currentDataMode: 'observed', getActiveMapBounds: () => ({}), floodFrameState: 'ready',
    setExportProgressVisible: noop, setExportProgress: message => { progress = message; },
    setDownloadStatus: message => { node('downloadStatus').textContent = message; },
    stopPlayback: noop, syncDownloadRangeInputs: noop, getDownloadScopeValue: () => 'range',
    getDownloadFormatValue: () => 'png', getDownloadAspectValue: () => 'viewport',
    validateDownloadRangeForExport: () => ({ ok: true, range: { startDate: new Date(), endDate: new Date() } }),
    ensureExportArchiveAvailability: async () => {},
    exportRangeNeedsObservedArchive: () => true,
    ensureObservedArchiveRange: () => archive, getDownloadFrameItems: () => { frameBuilds++; return [{ entry: {} }]; },
    setDownloadModalOpen: open => { modalOpen = open; }, EXPORT_PNG_SELECTION_LIMIT: 337,
    ensureExportLibraries: async () => { libraries++; }, exportPng: async () => { downloads++; },
    getFriendlyExportError: error => error.message, toast: noop, updateDownloadSummary: noop,
    finishCancelledExportProgress: () => { cancelled++; }, finishExportProgress: (_message, isError) => { if (isError) failed++; },
    console: { error: noop },
  });
  const job = ctx.downloadCurrentSelection();
  assert.equal(ctx.exportInProgress, true);
  assert.equal(modalOpen, false, 'Settings isolation must release the visible progress Cancel button');
  assert.match(progress, /archive year/);
  // Availability initialization now precedes the selected-year request.
  for (let turn = 0; turn < 5; turn++) await Promise.resolve();
  if (outcome.startsWith('cancel')) {
    ctx.cancelCurrentExport();
    ctx.setDownloadBusy(true);
    assert.equal(ctx.exportCancelRequested, true, 'A continuing busy phase cannot erase cancellation');
  }
  if (outcome.endsWith('reject') || outcome === 'archive-error') reject(new Error('offline'));
  else release();
  await job;
  assert.equal(ctx.exportInProgress, false);
  assert.equal(node('downloadBtn').disabled, false);
  assert.equal(ctx.exportCancelRequested, false);
  assert.equal(downloads, outcome === 'success' ? 1 : 0);
  assert.equal(libraries, outcome === 'success' ? 1 : 0);
  assert.equal(frameBuilds, outcome === 'success' ? 1 : 0);
  assert.equal(cancelled, outcome.startsWith('cancel') ? 1 : 0);
  assert.equal(failed, outcome === 'archive-error' ? 1 : 0);
  if (outcome !== 'success') {
    ctx.ensureObservedArchiveRange = async () => {};
    await ctx.downloadCurrentSelection();
    assert.equal(downloads, 1, 'A later attempt succeeds after cancellation or archive failure');
    assert.equal(ctx.exportInProgress, false);
  }
}

console.log('PASS export dates: positional mask edits, spring rejection, explicit EDT/EST choices, 100 fall-back readings, archive cancellation/error cleanup.');
