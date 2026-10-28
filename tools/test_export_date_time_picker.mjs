import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Exercise the shipped picker against the existing New York clock and
// interpolation code, rather than a second implementation of either rule.
const runtime = ['03-time-series', '12-export-date-editors', '18-flood-frame-rendering']
  .map(name => fs.readFileSync(new URL(`app/runtime/${name}.js`, import.meta.url), 'utf8')).join('\n');
const observed = new Map();
let forecast = [], source = [];
const ctx = vm.createContext({Date, Intl, Map, Number, console,
  window:{}, document:{readyState:'loading',addEventListener(){}},
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
});
for (const name of ['getNyParts','formatNyLocalIso','getLocalNyDateCandidates','parseStoredLocalNyToDate',
  'getExportTimeSelection','classifyFloodStage','detectSeriesResolutionMinutes','setTimelineSlotFields',
  'makeMissingTimelineEntry','makeInterpolatedTimelineEntry','buildQuarterHourTimelineSeries']) {
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
