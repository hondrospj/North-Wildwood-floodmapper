import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Exercise the shipped picker against the existing New York clock and
// interpolation code, rather than a second implementation of either rule.
const runtime = ['03-time-series', '04-observation-archives', '12-export-date-editors',
  '17-export-encoding', '18-flood-frame-rendering']
  .map(name => fs.readFileSync(new URL(`app/runtime/${name}.js`, import.meta.url), 'utf8')).join('\n');
const observed = new Map();
let forecast = [], source = [];
const ctx = vm.createContext({Date, Intl, Map, Number, console,
  window:{}, document:{readyState:'loading',addEventListener(){}},
  currentDataMode:'forecast',
  MINOR_FLOOD_FT:3, MODERATE_FLOOD_FT:4, MAJOR_FLOOD_FT:5,
  NY_PARTS_FORMATTER:new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'numeric',minute:'2-digit',hour12:true,timeZoneName:'short'}),
  pad2:value=>String(value).padStart(2,'0'),
  normalizeStageValue:value=>value == null ? null : Number(value),
  getStageValue:entry=>entry?.navd88StageFt ?? null,
  entryTimeMs:entry=>Date.parse(entry.timeUtc),
  getEntryESTDate:entry=>new Date(entry.timeUtc),
  getExportDayKeyFromDate:date=>ctx.formatNyLocalIso(date).slice(0,10),
  getObservedExportDayIndex:()=>observed,
  getForecastExportEntriesLimited:()=>forecast,
  getDownloadSourceEntries:()=>source,
  getCurrentExportSourceMode:()=> 'forecast',
  getObservedDayRecord: date => observed.get(date),
  getObservedSourceHoursForDay: day => day?.hours || [],
  addDaysToDateKey: (date, days) => new Date(Date.parse(date) + days * 86400000).toISOString().slice(0, 10),
  annotateHydraulicSeries: entries => entries,
});
for (const name of ['getNyParts','formatNyLocalIso','getLocalNyDateCandidates','parseStoredLocalNyToDate',
  'getExportTimeSelection','formatExportTimeLabel','classifyFloodStage','detectSeriesResolutionMinutes','setTimelineSlotFields',
  'makeMissingTimelineEntry','makeInterpolatedTimelineEntry','buildQuarterHourTimelineSeries',
  'buildObservedCanonicalSeries','getQuarterHourExportEntries']) {
  const match=runtime.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n    }`));
  assert.ok(match,`Missing canonical function ${name}`); vm.runInContext(match[0],ctx);
}
vm.runInContext(fs.readFileSync(new URL('../assets/export-date-time-picker.js',import.meta.url),'utf8'),ctx);
const picker=ctx.window.NORTH_WILDWOOD_EXPORT_PICKER.data;
const entry=(time,stage)=>({timeUtc:time,navd88StageFt:stage,exportSourceMode:'forecast'});

// Calendar peaks use the established raw NAVD thresholds. A stale archive
// classification cannot override a known numeric level; forecast and observed
// readings on the same date contribute to the same highest-severity day.
observed.set('2026-10-28',{peakNAVD88:2.5,classification:'major',hours:[]});
assert.equal(picker.daySeverity('2026-10-28'),'none');
forecast=[entry('2026-10-28T16:00:00Z',3)];
assert.equal(picker.daySeverity('2026-10-28'),'minor');
forecast=[entry('2026-10-28T16:00:00Z',4)];
assert.equal(picker.daySeverity('2026-10-28'),'moderate');
forecast=[entry('2026-10-28T16:00:00Z',5)];
assert.equal(picker.daySeverity('2026-10-28'),'major');
assert.equal(picker.daySeverity('2026-10-29'),'unknown');
observed.set('1980-01-01',{classification:'moderate'});
assert.equal(picker.daySeverity('1980-01-01'),'moderate');

// Repeated-hour option values retain their exact instant; a nonexistent
// spring-forward wall time remains unavailable rather than rolling forward.
for(const utc of ['2025-11-02T05:30:00Z','2025-11-02T06:30:00Z']) {
  assert.equal(picker.optionInstant(`01:30|${Date.parse(utc)}`,'2025-11-02'),Date.parse(utc));
}
assert.equal(picker.optionInstant('02:30','2026-03-08'),null);
assert.equal(picker.optionInstant('broken','2026-03-08'),null);

// The displayed time colors use actual quarter-hour interpolation, retain
// both 1 AM readings and leave long data gaps and daily-only peaks uncolored.
source=[entry('2025-11-02T05:30:00Z',3),entry('2025-11-02T06:30:00Z',5),
  entry('2025-11-02T10:00:00Z',4),{...entry('2025-11-02T12:00:00Z',9),isDailyPeakOnly:true}];
const stages=picker.timeStages('2025-11-02');
assert.equal(stages.get(Date.parse('2025-11-02T05:30:00Z')).stage,3);
assert.equal(stages.get(Date.parse('2025-11-02T06:00:00Z')).stage,4);
assert.equal(stages.get(Date.parse('2025-11-02T06:30:00Z')).stage,5);
assert.equal(stages.has(Date.parse('2025-11-02T08:00:00Z')),false);
assert.equal(stages.has(Date.parse('2025-11-02T12:00:00Z')),false);
console.log('PASS export picker: canonical flood colors, quarter-hour levels, exact repeated hours, missing hours and data gaps.');

const options = ["00:00", `01:30|${Date.parse('2025-11-02T05:30:00Z')}`, `01:30|${Date.parse('2025-11-02T06:30:00Z')}`,
  "03:00", "05:00", "23:45"].map(value => ({ value }));
const visible = picker.timeChoices(options, "2025-11-02", stages);
assert.deepEqual(Array.from(visible, ({ option }) => option.value), options.slice(1, -1).map(o => o.value),
  "Exclude both ends of the day outside stage coverage, retaining the exact duplicate hour");
assert.equal(visible[2].record, undefined, "Retain the actual interior outage for an unavailable row");
const daily = { stage: 5, instant: Date.parse("2025-11-02T04:00:00Z") };
assert.equal(picker.timeChoices(options, "2025-11-02", new Map(), daily)[0].dateOnly, true,
  "Keep an official date-only peak available without inventing a time");

// The Stone Harbor archive has a 45-minute bracket on this date, longer
// than the primary gauge allows. Neither missing slot is exportable.
const gapDate = '2018-12-14';
source = [entry(`${gapDate}T18:15:00Z`, 2), entry(`${gapDate}T19:00:00Z`, 1.66)]
  .map(row => ({ ...row, exportSourceMode: 'observed', observedDate: gapDate }));
observed.set(gapDate, { hours: source });
const gapStages = picker.timeStages(gapDate);
assert.equal(gapStages.get(Date.parse(`${gapDate}T18:15:00Z`)).stage, 2);
assert.equal(gapStages.get(Date.parse(`${gapDate}T19:00:00Z`)).stage, 1.66);
assert.equal(gapStages.has(Date.parse(`${gapDate}T18:30:00Z`)), false);
assert.equal(gapStages.has(Date.parse(`${gapDate}T18:45:00Z`)), false);

// A primary-gauge day with no usable replay can still have one exact annual
// USGS crest. Its time is selectable without creating adjacent readings.
const crestDate = '2009-11-13';
const crestTime = '2009-11-13T10:24:00.000Z';
source = [{ ...entry(crestTime, 5.44), observedDate: crestDate, exportSourceMode: 'observed', isDailyPeakOnly: true, peakTimeKnown: true }];
observed.set(crestDate, { hours: source });
const crestStages = picker.timeStages(crestDate);
assert.equal(crestStages.size, 1);
const crestChoices = picker.timeChoices(['05:15', '05:30'].map(value => ({value})), crestDate, crestStages);
assert.equal(crestChoices.length, 1);
assert.equal(crestChoices[0].option.textContent, '05:24 AM');
assert.equal(picker.optionInstant(crestChoices[0].option.value, crestDate), Date.parse(crestTime));
assert.equal(crestChoices[0].record.stage, 5.44);
assert.equal(crestChoices[0].dateOnly, false);
