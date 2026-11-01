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
async function modeledChoiceText(page) {
  const years=[1,2,5,10,20,50,100,200,500,1000,2000,5000,10000];
  const expectedIds=years.map(years=>`return${years}Btn`);
  const select=page.locator('#nwwCompactReturnPeriod');
  if(!await select.isVisible())return choiceText(page,'.return-interval-grid button',expectedIds);
  const choices=await select.evaluate(e=>{
    const style=getComputedStyle(e),box=e.getBoundingClientRect();
    const probe=document.createElement('span');
    Object.assign(probe.style,{position:'fixed',visibility:'hidden',whiteSpace:'pre',font:style.font,letterSpacing:style.letterSpacing});
    document.body.append(probe);
    try{
      // Native popup options have no portable DOM rectangles. A real text
      // Range retains Firefox's minimum-font setting, unlike canvas metrics.
      return [...e.options].map(option=>{
        probe.textContent=option.textContent;
        const range=document.createRange();range.selectNodeContents(probe);const text=range.getBoundingClientRect();
        const button=document.getElementById(`return${option.value}Btn`);
        return{id:button?.id,value:option.value,label:option.textContent,
          expectedLabel:(button?.getAttribute('aria-label')||button?.textContent||'').replace(/ modeled flood$/i,''),
          disabled:option.disabled,expectedDisabled:!!button?.disabled,
          width:box.width,height:box.height,textWidth:text.width,textHeight:text.height,font:style.font};
      });
    }finally{probe.remove();}
  });
  assert.deepEqual(choices.map(c=>c.id).sort(),[...expectedIds].sort(),'The visible native selector must retain every modeled choice');
  assert.ok(choices.every(c=>c.label===c.expectedLabel&&c.disabled===c.expectedDisabled),JSON.stringify(choices));
  assert.ok(choices.every(c=>c.textWidth<=c.width+1&&c.textHeight<=c.height+1),JSON.stringify(choices));
  const restore=await select.inputValue();
  await select.selectOption('20');
  await page.waitForFunction(()=>currentReturnIntervalYears===20&&floodFrameState==='ready',{}, {timeout:90000});
  assert.equal(await select.inputValue(),'20','The native modeled choice must activate the actual scenario');
  await select.selectOption(restore);
  await page.waitForFunction(years=>currentReturnIntervalYears===Number(years)&&floodFrameState==='ready',restore, {timeout:90000});
  return choices;
}
async function sidebarLabelText(page) {
  const labels=await page.evaluate(()=>{
    const rect=a=>({left:a.left,top:a.top,right:a.right,bottom:a.bottom,width:a.width,height:a.height});
    const textRects=e=>{const range=document.createRange();range.selectNodeContents(e);return [...range.getClientRects()].map(rect);};
    const shown=e=>e&&e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
    return{
      layers:[...document.querySelectorAll('#rightRail .layer-item,#mobileRailMount .layer-item')].filter(shown).map(row=>{
        const label=row.querySelector('.layer-name'),toggle=row.querySelector('.toggle');
        return{label:label.textContent.trim(),row:rect(row.getBoundingClientRect()),region:rect(label.getBoundingClientRect()),overflowY:getComputedStyle(label).overflowY,text:textRects(label),toggle:rect(toggle.getBoundingClientRect())};
      }),
      sections:[...document.querySelectorAll('#leftPanel .overlay-card,#leftPanel .datum-card,#leftPanel .opacity-card,#leftPanel #timelineIntervalCard')].filter(shown).map(card=>{
        const title=card.querySelector('.section-title h2'),controls=card.querySelector('.button-grid-2,.segmented-control,.control-row,#timelineIntervalToggle');
        return{title:title.textContent.trim(),text:textRects(title),controls:rect(controls.getBoundingClientRect())};
      })
    };
  });
  const inside=(a,b)=>a.left>=b.left-1.5&&a.right<=b.right+1.5&&a.top>=b.top-1.5&&a.bottom<=b.bottom+1.5;
  const overlaps=(a,b)=>Math.min(a.right,b.right)-Math.max(a.left,b.left)>1.5&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1.5;
  assert.ok(labels.layers.length>0,'The selected map section must expose its layer labels');
  for(const layer of labels.layers){
    // Font ink can extend beyond a line box without clipping. The full row
    // must contain it, and its horizontal label region must clear the switch.
    assert.ok(layer.text.length&&layer.text.every(text=>inside(text,layer.row)&&text.left>=layer.region.left-1.5&&text.right<=layer.region.right+1.5&&
      (layer.overflowY==='visible'||inside(text,layer.region))&&!overlaps(text,layer.toggle)),JSON.stringify(layer));
    for(const other of labels.layers)if(other!==layer)assert.ok(layer.text.every(text=>other.text.every(otherText=>!overlaps(text,otherText))),JSON.stringify({layer,other}));
  }
  assert.ok(labels.sections.length>0,'The selected map section must expose its main section titles');
  for(const section of labels.sections)assert.ok(section.text.length&&section.text.every(text=>!overlaps(text,section.controls)),JSON.stringify(section));
  if(await page.locator('body').evaluate(e=>e.dataset.unifiedLayout==='desktop'&&e.dataset.sidebarFit==='bounded')){
    await page.locator('#legendDock').scrollIntoViewIfNeeded();
    const key=await page.locator('#legendDock').evaluate(e=>{
      const rect=a=>({left:a.left,top:a.top,right:a.right,bottom:a.bottom});
      return{card:rect(e.getBoundingClientRect()),labels:[...e.querySelectorAll('.depth-legend-labels > *')].map(label=>{
        const range=document.createRange();range.selectNodeContents(label);
        return{label:label.textContent,box:rect(label.getBoundingClientRect()),text:[...range.getClientRects()].map(rect)};
      })};
    });
    assert.deepEqual(key.labels.map(l=>l.label),['Uncertain','Shallow','Deep']);
    for(const label of key.labels){
      assert.ok(label.text.length&&label.text.every(text=>inside(text,label.box)&&inside(text,key.card)),JSON.stringify(key));
      for(const other of key.labels)if(other!==label)assert.ok(label.text.every(text=>other.text.every(otherText=>!overlaps(text,otherText))),JSON.stringify(key));
    }
    const reachable=[];
    for(const id of ['legendHelpBtn','townAddressInput','townAddressSearchBtn','townAddressClearBtn']){
      const control=page.locator('#'+id);await control.scrollIntoViewIfNeeded();
      const target=await control.evaluate(e=>{const r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return{id:e.id,reachable:hit===e||e.contains(hit),left:r.left,top:r.top,right:r.right,bottom:r.bottom,viewport:{right:innerWidth,bottom:innerHeight}};});
      assert.ok(target.reachable&&target.left>=0&&target.top>=0&&target.right<=target.viewport.right+1&&target.bottom<=target.viewport.bottom+1,JSON.stringify(target));reachable.push(target);
    }
    const address=await choiceText(page,'#townAddressSearchBtn,#townAddressClearBtn',['townAddressSearchBtn','townAddressClearBtn']);
    labels.bounded={key,address,reachable};
  }
  return labels;
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
    const sidebarLabels=await sidebarLabelText(page);
    if (output) await page.screenshot({path:path.join(output,`${name}-text-${viewport.width}-map.png`)});
    if(mobile)await page.getByRole('tab',{name:'Flood data',exact:true}).click();
    await page.locator('#returnIntervalDataBtn').click();
    await page.waitForFunction(()=>currentDataMode==='return-interval'&&floodFrameState==='ready',{}, {timeout:90000});
    if(mobile&&!await page.locator('body').evaluate(e=>e.classList.contains('mobile-controls-open')))await page.locator('#mobileControlsToggle').click();
    const modeledChoices=await modeledChoiceText(page);
    if (output) await page.screenshot({path:path.join(output,`${name}-text-${viewport.width}-modeled.png`)});
    results.push({scenario:`choice text ${viewport.width}`,nativeMinimumFont:name==='firefox'?minimumFont:null,choices,mapChoices,modeledChoices,sidebarLabels,header});
    await page.close();
  }
} finally {
  const result={browser:name,version:browser.version(),results};
  if (output) fs.writeFileSync(path.join(output,`${name}-line-browser.json`),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));await browser.close();
}
