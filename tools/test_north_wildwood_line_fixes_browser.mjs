import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const playwright = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const name = process.env.NWW_BROWSER || 'chromium';
const minimumFont = Number(process.env.NWW_MINIMUM_FONT_SIZE ?? 30);
assert.ok(Number.isInteger(minimumFont) && minimumFont >= 0,'NWW_MINIMUM_FONT_SIZE must be a nonnegative integer');
const engine = playwright[name === 'edge' ? 'chromium' : name];
const browser = await engine.launch({headless:true,
  ...(name === 'edge' ? {channel:'msedge'} : {}),
  ...(name === 'chromium' && process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {}),
  ...(name === 'chromium' && process.env.NWW_CHROMIUM_CHANNEL ? {channel:process.env.NWW_CHROMIUM_CHANNEL} : {}),
  ...(['chromium','edge'].includes(name) ? {args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']} : {}),
  ...(name === 'firefox' ? {firefoxUserPrefs:{'font.minimum-size.x-western':minimumFont}} : {})
});
const url = process.env.NWW_TEST_URL || 'http://127.0.0.1:8773/index.html';
const output = process.env.NWW_AUDIT_OUTPUT;
if (output) fs.mkdirSync(output,{recursive:true});
const results = [];
async function ready(page) {
  await page.waitForFunction(()=>document.body.classList.contains('nw-app-ready') && floodFrameState==='ready',{}, {timeout:90000});
  await page.locator('#nwSiteLoader').waitFor({state:'hidden'});
}
async function choiceText(page,selector,expectedIds) {
  const choices=await page.locator(selector).evaluateAll(elements=>elements.filter(e=>e.getClientRects().length).map(e=>{
    const range=document.createRange();range.selectNodeContents(e);
    const rect=a=>({left:a.left,top:a.top,right:a.right,bottom:a.bottom,width:a.width,height:a.height});
    const a=e.getBoundingClientRect(),b=range.getBoundingClientRect();
    const group=e.parentElement.getBoundingClientRect(),card=e.closest('.panel-card')?.getBoundingClientRect();
    return {id:e.id||e.dataset.group,width:a.width,height:a.height,textWidth:b.width,textHeight:b.height,
      overflow:getComputedStyle(e).overflow,button:rect(a),text:rect(b),lines:[...range.getClientRects()].map(rect),
      group:rect(group),card:card&&rect(card)};
  }));
  assert.deepEqual(choices.map(c=>c.id).sort(),[...expectedIds].sort(),'Every expected choice must be present and visible');
  assert.ok(choices.every(c=>c.textWidth<=c.width+1 && c.textHeight<=c.height+1),JSON.stringify(choices));
  const inside=(a,b)=>a.left>=b.left-1&&a.right<=b.right+1&&a.top>=b.top-1&&a.bottom<=b.bottom+1;
  assert.ok(choices.every(c=>c.lines.length>0&&c.lines.every(line=>inside(line,c.button))&&
    inside(c.button,c.group)&&(!c.card||inside(c.button,c.card))),JSON.stringify(choices));
  return choices;
}
async function headerText(page) {
  const header=await page.locator('#nwwMobileControlHeader').evaluate(e=>{
    const rect=a=>({left:a.left,top:a.top,right:a.right,bottom:a.bottom,width:a.width,height:a.height});
    const text=selector=>{const node=e.querySelector(selector),range=document.createRange();range.selectNodeContents(node);
      const style=getComputedStyle(node);
      return {text:node.textContent,fontSize:style.fontSize,lineHeight:style.lineHeight,
        box:rect(node.getBoundingClientRect()),lines:[...range.getClientRects()].map(rect)};};
    return {title:text('h2'),subtitle:text('p'),tabs:rect(e.querySelector('.nww-control-tabs').getBoundingClientRect())};
  });
  const inside=(a,b)=>a.left>=b.left-1&&a.right<=b.right+1&&a.top>=b.top-1&&a.bottom<=b.bottom+1;
  for(const item of [header.title,header.subtitle])assert.ok(item.text&&item.lines.length&&item.lines.every(line=>inside(line,item.box)),JSON.stringify(header));
  assert.ok(header.title.box.bottom<=header.subtitle.box.top+1&&header.subtitle.box.bottom<=header.tabs.top+1,JSON.stringify(header));
  if(name!=='firefox'||minimumFont===0){
    assert.ok(Math.abs(parseFloat(header.title.lineHeight)-24)<0.1,JSON.stringify(header));
    assert.ok(Math.abs(parseFloat(header.subtitle.lineHeight)-16)<0.1,JSON.stringify(header));
  }
  const tabs=await choiceText(page,'#nwwMobileControlHeader [role="tab"]',['forecast','map','tools']);
  return {...header,tabChoices:tabs};
}
try {
  for (const script of ['leaflet@1.9.4/dist/leaflet.js','esri-leaflet-vector@4.3.2/dist/esri-leaflet-vector.js']) {
    const page = await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce'});
    let release, received;
    const pending = new Promise(resolve=>release=resolve), requested = new Promise(resolve=>received=resolve);
    await page.route('**/'+script,async route=>{received();await pending;await route.continue();});
    try {
      await page.clock.install();
      await page.goto(url,{waitUntil:'commit',timeout:90000});
      await requested;
      await page.waitForFunction(()=>Number(document.getElementById('nwLoaderProgress')?.dataset.progress)>0,{}, {timeout:45000});
      await page.clock.fastForward(20001);
      await page.locator('#nwLoaderRetry').waitFor({state:'visible'});
      assert.equal(await page.locator('#app').evaluate(e=>e.inert),true);
      assert.equal(await page.locator('body').getAttribute('data-site-loader'),'dependency-error');
      assert.equal(await page.locator('body').evaluate(e=>e.classList.contains('nw-app-ready')),false);
      assert.match(await page.locator('#nwLoaderStatus').innerText(),/could not load/);
      assert.equal(await page.locator('#nwLoaderRetry').evaluate(e=>document.activeElement===e),true);
      release();await ready(page);
      assert.equal(await page.locator('#app').evaluate(e=>e.inert),false);
      assert.equal(await page.locator('body').getAttribute('data-site-loader'),'complete');
      // Firefox's screenshot font wait also waits for a parser-paused document.
      // Capture after release; assertions above verify the actual stalled state.
      if (output) await page.screenshot({path:path.join(output,`${name}-core-recovered-${results.length}.png`)});
      results.push({scenario:script,deadlineRetry:true,lateRecovery:true});
    } finally {release();await page.close();}
  }
  {
    const page = await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce'});
    let fail = true;
    await page.route('**/leaflet@1.9.4/dist/leaflet.js',route=>{
      if (fail) return route.abort('failed');
      return route.continue();
    });
    await page.goto(url,{waitUntil:'domcontentloaded',timeout:90000});
    await page.locator('#nwLoaderRetry').waitFor({state:'visible'});
    assert.equal(await page.locator('body').evaluate(e=>e.classList.contains('nw-app-ready')),false);
    assert.equal(await page.locator('#app').evaluate(e=>e.inert),true);
    fail = false;
    const navigation=page.waitForNavigation({waitUntil:'domcontentloaded',timeout:90000});
    await page.locator('#nwLoaderRetry').click();await navigation;await ready(page);
    assert.ok(await page.evaluate(()=>Number.isFinite(getStageValue(currentSeriesHours[currentHourIndex]))));
    results.push({scenario:'failed Leaflet then Retry',reloadRecovery:true});
    await page.close();
  }
  for (const viewport of [{width:1440,height:900},{width:390,height:844},{width:844,height:390}]) {
    const mobile=viewport.width<=900;
    const page = await browser.newPage({viewport,hasTouch:mobile,...(name==='firefox'?{}:{isMobile:mobile})});
    await page.goto(url,{waitUntil:'domcontentloaded',timeout:90000});await ready(page);
    if(mobile){
      await page.locator('#mobileControlsToggle').click();
      await page.getByRole('tab',{name:'Flood data',exact:true}).click();
    }
    await page.locator('#timelineIntervalToggle').scrollIntoViewIfNeeded();
    const choices=await choiceText(page,'.data-source-options button,#timelineIntervalToggle button,.button-grid-3 button',
      ['forecastDataBtn','observedDataBtn','returnIntervalDataBtn','forecastLowBtn','forecastMeanBtn','forecastHighBtn','intervalHourBtn','intervalQuarterBtn','intervalDailyBtn']);
    const header=mobile?await headerText(page):null;
    if (output) await page.screenshot({path:path.join(output,`${name}-text-${viewport.width}-forecast.png`)});
    if(mobile)await page.getByRole('tab',{name:'Map layers',exact:true}).click();
    const mapChoices=await choiceText(page,'.overlay-card .button-grid-2 button,.datum-card .segmented-control button',
      ['depthModeBtn','dynamicModeBtn','datumMllwBtn','datumNavd88Btn']);
    if (output) await page.screenshot({path:path.join(output,`${name}-text-${viewport.width}-map.png`)});
    if(mobile)await page.getByRole('tab',{name:'Flood data',exact:true}).click();
    await page.locator('#returnIntervalDataBtn').click();
    await page.waitForFunction(()=>currentDataMode==='return-interval'&&floodFrameState==='ready',{}, {timeout:90000});
    if(mobile&&!await page.locator('body').evaluate(e=>e.classList.contains('mobile-controls-open')))await page.locator('#mobileControlsToggle').click();
    const modeledChoices=await choiceText(page,'.return-interval-grid button',
      [1,2,5,10,20,50,100,200,500,1000,2000,5000,10000].map(years=>`return${years}Btn`));
    if (output) await page.screenshot({path:path.join(output,`${name}-text-${viewport.width}-modeled.png`)});
    results.push({scenario:`choice text ${viewport.width}`,nativeMinimumFont:name==='firefox'?minimumFont:null,choices,mapChoices,modeledChoices,header});
    await page.close();
  }
} finally {
  const result={browser:name,version:browser.version(),results};
  if (output) fs.writeFileSync(path.join(output,`${name}-line-browser.json`),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));await browser.close();
}
