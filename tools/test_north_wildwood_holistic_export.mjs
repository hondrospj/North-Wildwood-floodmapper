// Actual browser/export regressions for the second October 26 audit.
// Use NWW_BROWSER, PLAYWRIGHT_MODULE, CHROME_PATH and NWW_TEST_URL like the UI suite.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const playwright = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const name = process.env.NWW_BROWSER || 'chromium';
const engine = playwright[name === 'edge' ? 'chromium' : name];
const browser = await engine.launch({headless:true,
  ...(name === 'edge' ? {channel:'msedge'} : {}),
  ...(name === 'chromium' && process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {}),
  ...(['chromium','edge'].includes(name) ? {args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']} : {}),
});
const url = process.env.NWW_TEST_URL || 'http://127.0.0.1:8765/index.html';
const retained = process.env.NWW_AUDIT_OUTPUT;
const output = retained || fs.mkdtempSync(path.join(os.tmpdir(),'nww-holistic-export-'));
fs.mkdirSync(output,{recursive:true});
const result = {browser:name,version:browser.version(),checks:[],states:[],errors:[]};
async function pageFor() {
  const page = await browser.newPage({viewport:{width:1440,height:1000},timezoneId:'America/Los_Angeles',acceptDownloads:true});
  page.setDefaultTimeout(30000);
  page.on('pageerror',error=>result.errors.push(error.message));
  return page;
}
async function ready(page) {
  await page.goto(url,{waitUntil:'domcontentloaded',timeout:90000});
  await page.waitForFunction(()=>document.body.classList.contains('nw-app-ready') && floodFrameState==='ready',{}, {timeout:90000});
}
async function fillDate(page,prefix,date,time) {
  await page.locator(`#download${prefix}DateText`).fill(date);
  await page.locator(`#download${prefix}TimeSelect`).focus();
  await page.locator(`#download${prefix}TimeSelect`).selectOption(time);
}
async function review(page) {
  if(await page.locator('#downloadModal').getAttribute('data-export-step')!=='review') await page.locator('#downloadBtn').click();
}
async function yearRange(page,label) {
  await page.locator('#openDownloadModalBtn').click();
  await fillDate(page,'Start','12/31/2025','23:00');
  await fillDate(page,'End','01/01/2026','01:00');
  await review(page);
  await page.waitForFunction(()=>document.getElementById('exportPreview').dataset.state==='ready',{}, {timeout:180000});
  const state=await page.evaluate(()=>({mode:currentDataMode,validation:validateDownloadRangeForExport(),
    frames:getDownloadFrameItems().map(item=>({time:item.entry.timeUtc,stage:getStageValue(item.entry),mode:item.mode})),
    pickers:['downloadStartDatePicker','downloadEndDatePicker'].map(id=>({min:document.getElementById(id).min,max:document.getElementById(id).max}))
  }));
  assert.equal(state.mode,'forecast');assert.equal(state.validation.ok,true);
  assert.equal(state.frames.length,3);assert.ok(state.frames.every(frame=>frame.mode==='observed'));
  assert.ok(state.pickers.every(picker=>picker.min<'2025-12-31' && picker.max>'2026-01-01'),'Native picker must expose history before visiting Past');
  result.states.push({label,...state});
  if(retained) await page.screenshot({path:path.join(output,`${name}-${label}.png`)});
  await page.locator('#downloadModalCloseBtn').click();
  return state;
}
function inspectGif(bytes) {
  assert.match(bytes.subarray(0,6).toString(),/^GIF8[79]a$/);
  const size={width:bytes.readUInt16LE(6),height:bytes.readUInt16LE(8)};
  let offset=13 + ((bytes[10]&0x80) ? 3*(1<<((bytes[10]&7)+1)) : 0),delay=0;
  const frames=[];
  const blocks=()=>{while(offset<bytes.length){const length=bytes[offset++];if(!length)return;offset+=length;}throw Error('Truncated GIF sub-blocks');};
  while(offset<bytes.length) {
    const marker=bytes[offset++];
    if(marker===0x3b) return {...size,frames};
    if(marker===0x21) {
      const type=bytes[offset++];
      if(type===0xf9) delay=bytes.readUInt16LE(offset+2)*10;
      blocks();
    } else if(marker===0x2c) {
      const packed=bytes[offset+8];offset+=9;
      if(packed&0x80)offset+=3*(1<<((packed&7)+1));
      offset++;blocks();frames.push({delayMs:delay});delay=0;
    } else throw Error(`Unexpected GIF marker ${marker}`);
  }
  throw Error('Missing GIF trailer');
}
try {
  const page=await pageFor();await ready(page);
  const before=await yearRange(page,'history-before-Past');
  await page.locator('#observedDataBtn').click();
  await page.waitForFunction(()=>currentDataMode==='observed' && floodFrameState==='ready',{}, {timeout:90000});
  await page.locator('#forecastDataBtn').click();
  await page.waitForFunction(()=>currentDataMode==='forecast' && floodFrameState==='ready');
  const after=await yearRange(page,'history-after-Past');
  assert.deepEqual(before.frames,after.frames);
  result.checks.push('Historical range and native picker bounds work before Past, with identical frames after Past');

  await page.locator('#returnIntervalDataBtn').click();
  await page.waitForFunction(()=>currentDataMode==='return-interval' && floodFrameState==='ready');
  await page.locator('#intervalDailyBtn').click();
  await page.waitForFunction(()=>getTimelineIntervalMinutes()===1440 && floodFrameState==='ready');
  const main=await page.evaluate(()=>currentSeriesHours.map(entry=>({time:entry.timeUtc,stage:getStageValue(entry),day:entry.syntheticStormDay})));
  await page.locator('#openDownloadModalBtn').click();await review(page);
  await page.locator('#exportAspectSquareBtn').click();await page.locator('#exportIntervalDailyBtn').click();
  const modeled=await page.evaluate(()=>getDownloadFrameItems().map(item=>({time:item.entry.timeUtc,stage:getStageValue(item.entry),day:item.entry.syntheticStormDay})));
  assert.deepEqual(modeled,main);assert.equal(modeled.length,2);
  result.states.push({label:'modeled-daily',main,export:modeled});
  result.checks.push('Modeled Daily Max frame instants, storm-day bins and stages match the main timeline');
  if(name==='chromium') {
    const downloading=page.waitForEvent('download',{timeout:240000});
    await page.locator('#downloadBtn').click();
    const download=await downloading;
    const file=path.join(output,download.suggestedFilename());await download.saveAs(file);
    assert.equal(await download.failure(),null);
    await page.waitForFunction(()=>!exportInProgress,{}, {timeout:90000});
    const gif=inspectGif(fs.readFileSync(file));
    assert.equal(gif.width,1200);assert.equal(gif.height,1200);
    assert.equal(gif.frames.length,modeled.length);assert.ok(gif.frames.every(frame=>frame.delayMs===1000));
    result.states.push({label:'actual-gif',file:path.basename(file),...gif});
    result.checks.push('Actual modeled GIF downloads at 1200 × 1200 with two 1,000 ms frames');
  }
  await page.close();

  // A history outage must not block a range supplied entirely by healthy
  // forecast data. The modal may warm history independently for its calendars.
  const forecastOnly=await pageFor();let historyFailures=0;
  await forecastOnly.route(/\/(observed_archive_index|canonical_daily_v2|stone_harbor_observed15min)\.json(?:\?|$)/,route=>{
    historyFailures++;return route.fulfill({status:503,body:'Temporary history outage'});
  });
  await ready(forecastOnly);await forecastOnly.locator('#openDownloadModalBtn').click();
  await forecastOnly.locator('#exportFormatPngBtn').click();await review(forecastOnly);
  await forecastOnly.waitForFunction(()=>document.getElementById('exportPreview').dataset.state==='ready',{}, {timeout:180000});
  const forecastFrames=await forecastOnly.evaluate(()=>getDownloadFrameItems().map(item=>({mode:item.mode,stage:getStageValue(item.entry)})));
  assert.ok(historyFailures>0);assert.equal(forecastFrames.length,1);
  assert.ok(forecastFrames.every(frame=>frame.mode==='forecast' && Number.isFinite(frame.stage)));
  if(name==='chromium') {
    const downloading=forecastOnly.waitForEvent('download',{timeout:180000});
    await forecastOnly.locator('#downloadBtn').click();const download=await downloading;
    const file=path.join(output,`history-outage-${download.suggestedFilename()}`);await download.saveAs(file);
    assert.equal(await download.failure(),null);
    assert.equal(fs.readFileSync(file).subarray(1,4).toString(),'PNG');
  }
  result.checks.push('A 503 history outage leaves healthy forecast range preview and PNG export available');
  result.states.push({label:'forecast-during-history-outage',historyFailures,frames:forecastFrames});
  await forecastOnly.close();

  // A real pending CDN response must not leave Download locked after Close.
  const stalled=await pageFor();let hold=true,release;
  const gate=new Promise(resolve=>{release=resolve;});
  await stalled.route('**/html2canvas*.js',async route=>{
    if(hold){await gate;await route.abort('failed').catch(()=>{});}else await route.continue();
  });
  try {
    await ready(stalled);await stalled.locator('#openDownloadModalBtn').click();
    await stalled.locator('#exportFormatPngBtn').click();
    await stalled.waitForFunction(()=>document.body.dataset.exportLibraries==='loading');
    await stalled.evaluate(()=>{
      window.__holisticScript=document.querySelector('script[data-optional-library="html2canvas"]');
      optionalScriptPromises.get('html2canvas').catch(error=>{window.__holisticDeadline=error.message;});
    });
    // Allow the debounced preview to enter its actual library await.
    await stalled.waitForTimeout(700);await review(stalled);await stalled.locator('#downloadBtn').click();
    await stalled.waitForFunction(()=>document.getElementById('downloadBtn').disabled && !exportInProgress);
    await stalled.locator('#downloadModalCloseBtn').click();await stalled.locator('#openDownloadModalBtn').click();
    assert.equal(await stalled.locator('#downloadBtn').isEnabled(),true);
    assert.equal(await stalled.locator('#downloadBtnLabel').textContent(),'More options');
    await stalled.waitForFunction(()=>Boolean(window.__holisticDeadline),{}, {timeout:15000});
    assert.equal(await stalled.evaluate(()=>!window.__holisticScript.isConnected),true);
    hold=false;release();
    await stalled.waitForFunction(()=>['error','ready'].includes(document.getElementById('exportPreview').dataset.state),{}, {timeout:30000});
    if(await stalled.locator('#exportPreview').getAttribute('data-state')==='error') await stalled.locator('#exportPreviewRetryBtn').click();
    await stalled.waitForFunction(()=>document.getElementById('exportPreview').dataset.state==='ready',{}, {timeout:180000});
    assert.equal(await stalled.locator('#downloadBtn').isEnabled(),true);
    result.checks.push('Pending preview preparation cancels on Close, its CDN request expires, and retry produces a ready preview');
  } finally {release();await stalled.close();}
  assert.deepEqual(result.errors,[]);
} catch(error) {
  result.failure=error.stack;throw error;
} finally {
  await browser.close();
  if(retained)fs.writeFileSync(path.join(output,`${name}-holistic-export.json`),JSON.stringify(result,null,2));
  else fs.rmSync(output,{recursive:true,force:true});
  console.log(JSON.stringify(result,null,2));
}
