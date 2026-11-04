// Real modeled export opening must start on a visible, accessible control.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const playwright=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const name=process.env.NWW_BROWSER||'chromium';
const browser=await playwright[name==='edge'?'chromium':name].launch({headless:true,
 ...(name==='edge'?{channel:'msedge'}:{}),
 ...(name==='chromium'&&process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{}),
 ...(name==='chromium'&&!process.env.CHROME_PATH&&process.env.NWW_CHROMIUM_CHANNEL?{channel:process.env.NWW_CHROMIUM_CHANNEL}:{}),
 ...(['edge','chromium'].includes(name)?{args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']}:{}),
});
const url=process.env.NWW_TEST_URL||'http://127.0.0.1:9043/index.html';
const out=process.env.NWW_MODELED_FOCUS_ARTIFACT_DIR||path.join(process.env.NWW_AUDIT_OUTPUT||os.tmpdir(),'modeled-export-focus',name);
fs.mkdirSync(out,{recursive:true});const evidence=[],errors=[];
const snapshot=page=>page.evaluate(()=>{const a=document.activeElement,s=getComputedStyle(a);return {id:a.id,tag:a.tagName,ariaHidden:a.getAttribute('aria-hidden'),opacity:s.opacity,visible:s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)>0&&a.getClientRects().length>0,disabled:!!a.disabled};});
try{
 for(const mobile of [false,true]){
  const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1440,height:1000},hasTouch:mobile,timezoneId:'America/New_York'});const page=await context.newPage();page.setDefaultTimeout(30000);page.on('pageerror',e=>errors.push(e.message));
  try{
   console.log(`Checking modeled export focus: ${mobile?'phone':'desktop'}`);
   await page.goto(url,{waitUntil:'domcontentloaded',timeout:90000});await page.waitForFunction(()=>document.body.classList.contains('nw-app-ready')&&floodFrameState==='ready',{},{timeout:120000});
   if(mobile)await page.locator('#mobileControlsToggle').click();
   await page.locator('#returnIntervalDataBtn').click();await page.waitForFunction(()=>currentDataMode==='return-interval'&&floodFrameState==='ready',{},{timeout:120000});
   if(mobile)await page.getByRole('tab',{name:'Tools',exact:true}).click();
   await page.locator('#openDownloadModalBtn').click();await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
   const opened=await snapshot(page);assert.equal(opened.id,mobile?'downloadModalCloseBtn':'downloadStartTimeButton');assert.equal(opened.visible,true);assert.notEqual(opened.ariaHidden,'true');assert.equal(opened.disabled,false);
   await page.keyboard.press('Tab');const afterTab=await snapshot(page);assert.equal(afterTab.visible,true);assert.notEqual(afterTab.ariaHidden,'true');assert.equal(afterTab.disabled,false);assert.notEqual(afterTab.id,'downloadStartTimeSelect');
   evidence.push({profile:mobile?'phone-touch-portrait':'desktop',opened,afterTab});
   console.log(`Visible modeled export focus passed: ${mobile?'phone':'desktop'}`);
  }finally{await context.close();}
 }
 assert.deepEqual(errors,[]);console.log(`Modeled export visible initial focus and Tab passed for desktop/phone in ${name} ${browser.version()}.`);
}finally{fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({browser:name,version:browser.version(),evidence,errors},null,2));await browser.close();}
