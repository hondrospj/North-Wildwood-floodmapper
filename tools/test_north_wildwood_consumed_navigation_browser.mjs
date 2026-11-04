// Real compass and timeline key events against the complete shipped mapper.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const playwright=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const name=process.env.NWW_BROWSER||'chromium',engine=playwright[name==='edge'?'chromium':name];
const browser=await engine.launch({headless:true,...(name==='edge'?{channel:'msedge'}:{}),
 ...(name==='chromium'&&process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{}),
 ...(name==='chromium'&&!process.env.CHROME_PATH&&process.env.NWW_CHROMIUM_CHANNEL?{channel:process.env.NWW_CHROMIUM_CHANNEL}:{}),
 ...(['chromium','edge'].includes(name)?{args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']}:{}),
});
const url=process.env.NWW_TEST_URL||'http://127.0.0.1:9043/index.html';
const out=process.env.NWW_AUDIT_OUTPUT||fs.mkdtempSync(path.join(os.tmpdir(),'nww-consumed-navigation-'));
fs.mkdirSync(out,{recursive:true});
const result={browser:name,version:browser.version(),checks:[],states:[],errors:[]};
const page=await browser.newPage({viewport:{width:1440,height:1000},timezoneId:'America/New_York'});
page.on('pageerror',error=>result.errors.push(error.message));
const snapshot=()=>page.evaluate(()=>({mode:currentDataMode,overlay:currentOverlayMode,index:currentHourIndex,
 time:currentSeriesHours[currentHourIndex]?.timeUtc,stage:getStageValue(currentSeriesHours[currentHourIndex]),
 frame:floodFrameState,focusIsCompass:document.activeElement?.classList.contains('nw-direction-wheel'),
 camera:window.NORTH_WILDWOOD_3D.state()}));
async function ready(mode){
 await page.waitForFunction(mode=>document.body.classList.contains('nw-app-ready')&&currentDataMode===mode&&
  currentSeriesHours.length>3&&floodFrameState==='ready'&&!pendingTimelineSelection&&!requestedTimelineSelection&&
  currentFloodLayer?._floodmapperFrame?.dataMode===mode,mode,{timeout:120000});
}
try{
 await page.goto(url,{waitUntil:'domcontentloaded'});await ready('forecast');
 await page.locator('#nwSiteLoader').waitFor({state:'hidden'});
 for(const[mode,button]of[['observed','#observedDataBtn'],['forecast','#forecastDataBtn'],['return-interval','#returnIntervalDataBtn']]){
  await page.locator(button).click();await ready(mode);
  for(const[overlay,control]of[['depth','#depthModeBtn'],['dynamic','#dynamicModeBtn']]){
   await page.locator(control).click();await ready(mode);
   assert.equal((await snapshot()).overlay,overlay);
   for(const[key,bearing]of[['ArrowRight',270],['ArrowLeft',90],['ArrowUp',180],['ArrowDown',0]]){
    await page.locator('.nw-direction-wheel').focus();const before=await snapshot();
    assert.equal(before.focusIsCompass,true,'The actual compass must own the native arrow key');
    await page.keyboard.press(key);
    await page.waitForFunction(bearing=>{const state=window.NORTH_WILDWOOD_3D.state();return state.ready&&
     Math.abs(((state.bearing%360)+360)%360-bearing)<.01;},bearing,{timeout:30000});
    await ready(mode);const after=await snapshot();
    assert.equal(after.time,before.time,`${mode}/${overlay}/${key}: compass must retain flood time`);
    assert.equal(after.index,before.index);assert.equal(after.stage,before.stage);assert.equal(after.focusIsCompass,true);
    result.states.push({mode,overlay,key,before,after});
   }
  }
 }
 result.checks.push('All four compass arrow keys preserve flood time/stage in Forecast, Past and Modeled Floods with both overlays');
 await page.locator('#observedDataBtn').click();await ready('observed');
 const slider=page.locator('#hourSlider');await slider.focus();await page.keyboard.press('Home');
 await page.waitForFunction(()=>currentHourIndex===0&&floodFrameState==='ready'&&!pendingTimelineSelection&&!requestedTimelineSelection,{},{timeout:60000});
 await page.keyboard.press('ArrowRight');
 await page.waitForFunction(()=>currentHourIndex===1&&floodFrameState==='ready'&&!pendingTimelineSelection&&!requestedTimelineSelection,{},{timeout:60000});
 result.checks.push('The actual timeline slider still handles ArrowRight exactly once');
 await page.evaluate(()=>document.activeElement.blur());
 assert.equal(await page.evaluate(()=>document.activeElement===document.body),true);
 await page.keyboard.press('ArrowRight');
 await page.waitForFunction(()=>currentHourIndex===2&&floodFrameState==='ready'&&!pendingTimelineSelection&&!requestedTimelineSelection,{},{timeout:60000});
 await page.keyboard.press('ArrowLeft');
 await page.waitForFunction(()=>currentHourIndex===1&&floodFrameState==='ready'&&!pendingTimelineSelection&&!requestedTimelineSelection,{},{timeout:60000});
 result.checks.push('Unhandled document ArrowRight/ArrowLeft retain ordinary Past timeline navigation');
 assert.deepEqual(result.errors,[]);
 await page.screenshot({path:path.join(out,`${name}-consumed-navigation.png`)});
 console.log(JSON.stringify({browser:name,version:result.version,checks:result.checks,compassCases:result.states.length,errors:result.errors},null,2));
}catch(error){result.failure=error.stack;throw error;}
finally{await browser.close();fs.writeFileSync(path.join(out,`${name}-consumed-navigation.json`),JSON.stringify(result,null,2)+'\n');}
