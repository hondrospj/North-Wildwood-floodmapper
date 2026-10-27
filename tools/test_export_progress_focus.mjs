// Use the actual modal-focus module and progress opening/closing functions.
// No map/network fixture can hide focus, inert or superseded-timer failures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
const playwright=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const name=process.env.NWW_BROWSER || 'chromium';
const engine=playwright[name==='edge'?'chromium':name];
const browser=await engine.launch({headless:true,
  ...(name==='edge'?{channel:'msedge'}:{}),
  ...(name==='chromium'&&process.env.NWW_CHROMIUM_CHANNEL?{channel:process.env.NWW_CHROMIUM_CHANNEL}:{}),
  ...(name==='chromium'&&process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
const page=await browser.newPage();
const errors=[];page.on('pageerror',error=>errors.push(error.message));
const source=fs.readFileSync(new URL('app/runtime/11-export-selection.js',import.meta.url),'utf8');
const extract=name=>source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n    }`))[0];
const template=fs.readFileSync(new URL('app/index.template.html',import.meta.url),'utf8');
const progress=template.slice(template.indexOf('  <div id="exportProgressOverlay"'),template.indexOf('  <div id="exportStage"'));
try{
  await page.setContent(`<button id="launch">Export Map</button><button id="background">Datum</button>
    <div id="nested" role="dialog" aria-modal="true" hidden><button id="nestedClose">Close warning</button></div>
    <div id="offscreen" inert><button>Never focus</button></div>${progress}`);
  await page.addScriptTag({content:fs.readFileSync(new URL('../assets/modal-focus.js',import.meta.url),'utf8')});
  await page.addScriptTag({content:`let exportInProgress=false,exportProgressVisibilityVersion=0,exportProgressReturnFocus=null;
    ${['setExportProgressVisible','setExportProgress','finishExportProgress','finishCancelledExportProgress'].map(extract).join('\n')}`});
  await page.locator('#launch').click();
  const opening=await page.evaluate(()=>{
    exportInProgress=true;setExportProgressVisible(true);
    return{focus:document.activeElement.id,background:document.getElementById('launch').inert};
  });
  assert.deepEqual(opening,{focus:'exportProgressCloseBtn',background:true},'Opening is synchronous');
  for(const key of ['Tab','Shift+Tab','Tab','Shift+Tab']){
    await page.keyboard.press(key);assert.equal(await page.evaluate(()=>document.activeElement.id),'exportProgressCloseBtn');
  }
  assert.equal(await page.locator('#offscreen').evaluate(el=>el.inert),true);
  await page.evaluate(()=>{
    document.getElementById('nested').hidden=false;document.dispatchEvent(new Event('nww:modalchange'));
  });
  assert.equal(await page.evaluate(()=>document.activeElement.id),'nestedClose');
  await page.evaluate(()=>{
    document.getElementById('nested').hidden=true;document.dispatchEvent(new Event('nww:modalchange'));
  });
  assert.equal(await page.evaluate(()=>document.activeElement.id),'exportProgressCloseBtn');
  await page.evaluate(()=>{exportInProgress=false;setExportProgressVisible(false);});
  assert.equal(await page.evaluate(()=>document.activeElement.id),'launch');
  assert.equal(await page.locator('#launch').evaluate(el=>el.inert),false);

  // A stale completion timer must not hide a subsequent job's progress, even
  // when that newer job has itself already completed.
  await page.evaluate(()=>{
    window.progressTimers=[];window.savedSetTimeout=window.setTimeout;
    window.setTimeout=callback=>{progressTimers.push(callback);return progressTimers.length;};
    exportInProgress=true;setExportProgressVisible(true);finishExportProgress('First complete');
    setExportProgressVisible(false);setExportProgressVisible(true);finishCancelledExportProgress('Second cancelled');
    exportInProgress=false;progressTimers[0]();
  });
  assert.equal(await page.locator('#exportProgressOverlay').isVisible(),true);
  await page.evaluate(()=>progressTimers[1]());
  assert.equal(await page.locator('#exportProgressOverlay').isVisible(),false);
  assert.equal(await page.evaluate(()=>document.activeElement.id),'launch');
  await page.evaluate(()=>{window.setTimeout=window.savedSetTimeout;});

  // Preserve the nested warning's focus if progress finishes underneath it,
  // then restore the original trigger once the warning closes.
  await page.evaluate(()=>{
    setExportProgressVisible(true);document.getElementById('nested').hidden=false;
    document.dispatchEvent(new Event('nww:modalchange'));setExportProgressVisible(false);
  });
  assert.equal(await page.evaluate(()=>document.activeElement.id),'nestedClose');
  await page.evaluate(()=>{document.getElementById('nested').hidden=true;document.dispatchEvent(new Event('nww:modalchange'));});
  assert.equal(await page.evaluate(()=>document.activeElement.id),'launch');
  assert.equal(await page.locator('#offscreen').evaluate(el=>el.inert),true);
  assert.deepEqual(errors,[]);
  console.log(`PASS ${name}: export progress initial focus, Tab containment, background isolation, restored focus/inert, nested completion and superseded timers.`);
}finally{await browser.close();}
