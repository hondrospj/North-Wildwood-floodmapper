import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const axePath = process.env.NWW_AXE_PATH || require.resolve('axe-core/axe.min.js');
const playwright = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const name = process.env.NWW_BROWSER || 'chromium';
const browser = await playwright[name === 'edge' ? 'chromium' : name].launch({headless:true,
  ...(name === 'edge' ? {channel:'msedge'} : {}),
  ...(name === 'chromium' && process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {}),
  ...(name === 'chromium' && process.env.NWW_CHROMIUM_CHANNEL ? {channel:process.env.NWW_CHROMIUM_CHANNEL} : {}),
  ...(['chromium','edge'].includes(name) ? {args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']} : {})});
const output = path.join(process.env.NWW_AUDIT_OUTPUT || path.join(os.tmpdir(),'north-wildwood-aria'), 'aria-semantics', name);
fs.mkdirSync(output,{recursive:true});
const result = {browser:name,version:browser.version(),checks:[],axe:[],errors:[]};
const page = await browser.newPage({viewport:{width:1440,height:900},timezoneId:'America/New_York'});
page.setDefaultTimeout(15000);
page.on('pageerror',error=>result.errors.push(error.message));
async function scan(label) {
  const audit = await page.evaluate(async()=>{
    const data = await window.axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}});
    return {version:window.axe.version,violations:data.violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>({target:n.target,html:n.html,summary:n.failureSummary}))}))};
  });
  result.axe.push({label,...audit});
  assert.deepEqual(audit.violations,[],`${label}: no WCAG A/AA axe violations`);
}
async function states(label, start=false, end=false) {
  const values = await page.evaluate(()=>Object.fromEntries(['Start','End'].map(cap=>{
    const input=document.getElementById(`download${cap}DateText`),button=document.getElementById(`download${cap}CalendarBtn`);
    return [cap.toLowerCase(),{role:input.getAttribute('role'),inputExpanded:input.getAttribute('aria-expanded'),buttonExpanded:button.getAttribute('aria-expanded'),inputControls:input.getAttribute('aria-controls'),buttonControls:button.getAttribute('aria-controls'),inputPopup:input.getAttribute('aria-haspopup'),buttonPopup:button.getAttribute('aria-haspopup')}];
  })));
  for (const [prefix,expanded] of [['start',start],['end',end]]) {
    const value=values[prefix];assert.equal(value.role,'combobox');
    assert.equal(value.inputPopup,'dialog');assert.equal(value.buttonPopup,'dialog');
    assert.equal(value.inputExpanded,String(expanded),`${label}: ${prefix} combobox`);
    assert.equal(value.buttonExpanded,String(expanded),`${label}: ${prefix} calendar button`);
    if(expanded) {
      assert.equal(value.inputControls,value.buttonControls);
      await assert.equal(await page.locator(`#${value.inputControls}`).getAttribute('role'),'dialog');
    }
  }
  result.checks.push({label,values});
}
// Geometry comparisons require the same finished preview/layout phase. The
// existing 90-second asset/startup budget bounds this new precondition; all
// action timeouts and the original one-pixel comparison remain unchanged.
async function geometryReady(prefix) {
  const started=Date.now();
  await page.evaluate(()=>{
    const state={fontsReady:false,last:null,stableFrames:0};
    window.__nwwAriaGeometryReadiness=state;
    document.fonts.ready.then(()=>{state.fontsReady=true;});
  });
  const ready=await page.waitForFunction(prefix=>{
    const state=window.__nwwAriaGeometryReadiness,cap=prefix==='end'?'End':'Start',preview=document.getElementById('exportPreview');
    if(!state.fontsReady||document.fonts.status!=='loaded'||document.getElementById('nwwExportDateTimePicker')||!['ready','error'].includes(preview?.dataset.state)) {
      state.last=null;state.stableFrames=0;return false;
    }
    const current=JSON.stringify([preview.dataset.state,
      ...[document.querySelector('#downloadModal .download-modal-card'),document.getElementById(`download${cap}CalendarBtn`)].map(element=>{
        const r=element.getBoundingClientRect();return [r.x,r.y,r.width,r.height,element.scrollTop];
      })]);
    state.stableFrames=current===state.last?state.stableFrames+1:0;state.last=current;
    return state.stableFrames>=2;
  },prefix,{timeout:90000});
  assert.equal(await ready.jsonValue(),true,'The synchronous readiness predicate actually reached its condition');
  const state=await page.locator('#exportPreview').getAttribute('data-state');
  (result.geometryReadiness??=[]).push({prefix,elapsedMs:Date.now()-started,state});
}
async function recordGeometry(prefix,label,bounds) {
  const context=await page.evaluate(prefix=>{
    const cap=prefix==='end'?'End':'Start',panel=document.getElementById('nwwExportDateTimePicker');
    const rect=element=>{const r=element.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};
    return {preview:document.getElementById('exportPreview').dataset.state,fonts:document.fonts.status,
      anchor:rect(document.getElementById(`download${cap}CalendarBtn`)),card:rect(document.querySelector('#downloadModal .download-modal-card')),
      calendar:{selects:[...panel.querySelectorAll('select')].map(select=>select.value),days:panel.querySelectorAll('[data-date]').length,
        selected:panel.querySelector('.selected')?.dataset.date??null,loading:!!panel.querySelector('.nww-picker-message')}};
  },prefix);
  (result.geometry??=[]).push({prefix,label,bounds,context});
  fs.writeFileSync(path.join(output,'geometry-progress.json'),JSON.stringify({readiness:result.geometryReadiness,measurements:result.geometry},null,2));
  return context;
}
async function popupBounds() {
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  return page.locator('#nwwExportDateTimePicker').boundingBox();
}
async function escapeTo(id) {
  await page.keyboard.press('Escape');
  await page.waitForFunction(()=>!document.getElementById('nwwExportDateTimePicker'));
  assert.equal(await page.evaluate(()=>document.activeElement.id),id);
  assert.equal(await page.locator('#downloadModal').getAttribute('hidden'),null,'One Escape retains Export settings');
}
try {
  await page.goto(process.env.NWW_TEST_URL || 'http://127.0.0.1:9023/index.html',{waitUntil:'domcontentloaded',timeout:90000});
  await page.waitForFunction(()=>document.body.classList.contains('nw-app-ready')&&window.NORTH_WILDWOOD_EXPORT_PICKER?.ready,{},{timeout:90000});
  await page.addScriptTag({path:axePath});
  assert.equal(await page.locator('#map3d').getAttribute('role'),'region');
  assert.equal(await page.locator('#map3d').getAttribute('aria-label'),'Interactive 3D North Wildwood flood map');
  await scan('Desktop map');
  await page.locator('#openDownloadModalBtn').click();
  await states('Export settings initially closed');await scan('Export settings initially closed');
  const initial = await page.locator('#downloadStartDateText').inputValue();
  await geometryReady('start');
  for(const cap of ['Start','End']) {
    const prefix=cap.toLowerCase();
    await page.locator(`#download${cap}DateText`).click({noWaitAfter:true,delay:50});
    await states(`${prefix} input click`,prefix==='start',prefix==='end');await scan(`${prefix} input click`);
    await escapeTo(`download${cap}DateText`);await states(`${prefix} input Escape`);
    await geometryReady(prefix);
    await page.locator(`#download${cap}DateText`).press('ArrowDown');
    await states(`${prefix} ArrowDown`,prefix==='start',prefix==='end');
    const keyboardBounds = await popupBounds();
    const keyboardContext = await recordGeometry(prefix,'keyboard',keyboardBounds);
    assert.ok(await page.locator('#nwwExportDateTimePicker').evaluate(panel=>panel.contains(document.activeElement)));
    await escapeTo(`download${cap}DateText`);await states(`${prefix} ArrowDown Escape`);
    await geometryReady(prefix);
    await page.locator(`#download${cap}CalendarBtn`).click();
    await states(`${prefix} calendar click`,prefix==='start',prefix==='end');
    const buttonBounds = await popupBounds();
    const buttonContext = await recordGeometry(prefix,'button',buttonBounds);
    assert.ok(['ready','error'].includes(keyboardContext.preview),'Keyboard geometry uses a terminal preview state');
    assert.ok(['ready','error'].includes(buttonContext.preview),'Button geometry uses a terminal preview state');
    assert.equal(keyboardContext.preview,buttonContext.preview,'Compare matching terminal preview states');
    assert.equal(keyboardContext.fonts,'loaded');assert.equal(buttonContext.fonts,'loaded');
    assert.deepEqual(keyboardContext.calendar,buttonContext.calendar,'Compare the same calendar content');
    for(const owner of ['anchor','card'])for(const key of ['x','y','width','height'])assert.ok(Math.abs(keyboardContext[owner][key]-buttonContext[owner][key])<1,`${prefix}: compare matching ${owner} geometry`);
    for(const key of ['x','y','width','height']) assert.ok(Math.abs(keyboardBounds[key]-buttonBounds[key])<1,`${prefix}: keyboard opening preserves calendar-button popup geometry`);
    result.checks.push({label:`${prefix} popup geometry unchanged`,keyboardBounds,buttonBounds});
    await page.locator('#nwwExportDateTimePicker button[aria-label="Close date and time picker"]').click();
    await states(`${prefix} close button`);
  }
  await page.locator('#downloadStartDateText').click({noWaitAfter:true,delay:50});
  await page.locator('#downloadEndDateText').press('ArrowDown');
  await states('Start to End date transition',false,true);
  await page.locator('#downloadEndTimeButton').press('Enter');
  await states('Date to time transition');await scan('Time picker after date');
  await escapeTo('downloadEndTimeButton');await states('Time picker Escape');await scan('Closed after transitions');
  await page.locator('#downloadStartDateText').fill(initial);
  await page.locator('#downloadStartDateText').press('Tab');
  assert.equal(await page.locator('#downloadStartDateText').inputValue(),initial,'Date remains editable with its original format');
  await states('Typed date preserves collapsed semantics');
  await page.screenshot({path:path.join(output,'export-settings.png')});
  await page.keyboard.press('Escape');
  await page.setViewportSize({width:390,height:844});
  if(await page.locator('#mobileControlsToggle').isVisible()) {
    await page.locator('#mobileControlsToggle').click();
    await page.locator('#nwwMobileControlHeader [data-group="tools"]').click();
  }
  await page.locator('#openDownloadModalBtn').click();
  await states('Phone settings closed');await scan('Phone settings closed');
  await page.locator('#downloadStartCalendarBtn').click();
  await states('Phone date popup open',true,false);await scan('Phone date popup open');
  await escapeTo('downloadStartCalendarBtn');await states('Phone date popup Escape');
  await page.screenshot({path:path.join(output,'phone-export-settings.png')});
  assert.deepEqual(result.errors,[],'No unexpected application JavaScript errors');
  result.passed=true;
} catch(error) {result.failure=error.stack;throw error;}
finally {
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(result,null,2));
  await browser.close();
  console.log(JSON.stringify({browser:name,version:result.version,passed:result.passed,checks:result.checks.length,axe:result.axe.map(a=>({label:a.label,version:a.version,violations:a.violations.length})),failure:result.failure,output},null,2));
}
