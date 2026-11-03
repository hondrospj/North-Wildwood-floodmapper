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
  for(const cap of ['Start','End']) {
    const prefix=cap.toLowerCase();
    await page.locator(`#download${cap}DateText`).click();
    await states(`${prefix} input click`,prefix==='start',prefix==='end');await scan(`${prefix} input click`);
    await escapeTo(`download${cap}DateText`);await states(`${prefix} input Escape`);
    await page.locator(`#download${cap}DateText`).press('ArrowDown');
    await states(`${prefix} ArrowDown`,prefix==='start',prefix==='end');
    const keyboardBounds = await popupBounds();
    assert.ok(await page.locator('#nwwExportDateTimePicker').evaluate(panel=>panel.contains(document.activeElement)));
    await escapeTo(`download${cap}DateText`);await states(`${prefix} ArrowDown Escape`);
    await page.locator(`#download${cap}CalendarBtn`).click();
    await states(`${prefix} calendar click`,prefix==='start',prefix==='end');
    const buttonBounds = await popupBounds();
    for(const key of ['x','y','width','height']) assert.ok(Math.abs(keyboardBounds[key]-buttonBounds[key])<1,`${prefix}: keyboard opening preserves calendar-button popup geometry`);
    result.checks.push({label:`${prefix} popup geometry unchanged`,keyboardBounds,buttonBounds});
    await page.locator('#nwwExportDateTimePicker button[aria-label="Close date and time picker"]').click();
    await states(`${prefix} close button`);
  }
  await page.locator('#downloadStartDateText').click();
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
