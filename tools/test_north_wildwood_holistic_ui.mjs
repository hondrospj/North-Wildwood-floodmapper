// Regression tests for the second October 26 audit. Real app/data/renderers;
// graphics loss uses the actual supported WebGL loss/restoration extension.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const playwright = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const name = process.env.NWW_BROWSER || 'chromium';
const engine = playwright[name === 'edge' ? 'chromium' : name];
const browser = await engine.launch({headless:true,
  ...(name === 'edge' ? {channel:'msedge'} : {}),
  ...(name === 'chromium' && process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {}),
  ...(['chromium','edge'].includes(name) ? {args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']} : {}),
  ...(name === 'firefox' ? {firefoxUserPrefs:{'font.minimum-size.x-western':30}} : {}),
});
const url = process.env.NWW_TEST_URL || 'http://127.0.0.1:8765/index.html';
const checks = [], errors = [], observations = [];
const output = process.env.NWW_AUDIT_OUTPUT;
if (output) fs.mkdirSync(output,{recursive:true});
async function pageFor(options) {
  const page = await browser.newPage(options);
  page.setDefaultTimeout(30000);
  page.on('pageerror',error=>errors.push(error.stack || error.message));
  await page.goto(url,{waitUntil:'domcontentloaded',timeout:90000});
  await page.waitForFunction(()=>document.body.classList.contains('nw-app-ready') && floodFrameState === 'ready',{}, {timeout:90000});
  return page;
}
async function snapshot(page,label) {
  if (output) await page.screenshot({path:path.join(output,`${name}-${label}.png`)});
}
async function graphics(page) {
  await page.locator('#returnIntervalDataBtn').click();
  await page.waitForFunction(()=>currentDataMode==='return-interval' && floodFrameState==='ready');
  const available = await page.evaluate(async()=>!!await window.NORTH_WILDWOOD_3D.ensure());
  if (!available) {
    observations.push('3D unavailable: explicit 2D fallback exercised; graphics restoration not claimed.');
    return;
  }
  if (await page.locator('body').getAttribute('data-map-view-mode') !== '3d') await page.locator('.nw-simple-view').click();
  await page.waitForFunction(()=>document.body.dataset.mapViewMode==='3d' && document.body.dataset.map3dFloodTexture==='ready');
  const before = await page.evaluate(()=>({stage:document.getElementById('stageText').textContent,time:document.getElementById('timeText').textContent}));
  const supported = await page.evaluate(()=>{
    const m=window.NORTH_WILDWOOD_3D.getMap();
    window.__holisticLoss=m.painter.context.gl.getExtension('WEBGL_lose_context');
    window.__holisticEvents=[];
    for(const type of ['webglcontextlost','webglcontextrestored'])m.on(type,()=>window.__holisticEvents.push(type));
    return !!window.__holisticLoss;
  });
  assert.ok(supported,'Required real context loss extension unavailable');
  await snapshot(page,'graphics-before');
  // Repeat to catch stale layer objects/listeners surviving a first recovery.
  for(let i=0;i<2;i++) {
    await page.evaluate(()=>window.__holisticLoss.loseContext());
    await page.waitForFunction(()=>document.body.dataset.map3d==='recovering');
    assert.equal(await page.locator('#map3dStatus').isVisible(),true);
    await page.evaluate(()=>window.__holisticLoss.restoreContext());
    await page.waitForFunction(()=>{
      const m=window.NORTH_WILDWOOD_3D.getMap();
      return document.body.dataset.map3d==='ready' && document.body.dataset.map3dFloodTexture==='ready' && !!m.getLayer('nw-flood-overlay');
    },{}, {timeout:45000});
    const after=await page.evaluate(()=>{
      const m=window.NORTH_WILDWOOD_3D.getMap();
      return {stage:document.getElementById('stageText').textContent,time:document.getElementById('timeText').textContent,
        custom:!!m.getLayer('nw-flood-overlay'),drape:m.getLayoutProperty('nw-flood-drape','visibility'),events:window.__holisticEvents};
    });
    assert.equal(after.stage,before.stage);assert.equal(after.time,before.time);
    assert.equal(after.custom,true);assert.equal(after.drape,'none');
    assert.equal(after.events.filter(e=>e==='webglcontextrestored').length,i+1);
    checks.push(`real graphics restoration ${i+1} preserves selected flood, stage and time`);
  }
  await snapshot(page,'graphics-restored');
}
try {
  const desktop = await pageFor({viewport:{width:1440,height:900},timezoneId:'America/Los_Angeles'});
  const fonts=await desktop.evaluate(()=>[...new Set([...document.querySelectorAll('body,button,input,select,label,h1,h2,h3')].filter(el=>el.getClientRects().length).map(el=>getComputedStyle(el).fontFamily))]);
  assert.equal(fonts.length,1,JSON.stringify(fonts));checks.push('visible interface text retains one shared font family');
  await desktop.locator('#openDownloadModalBtn').click();
  await desktop.waitForFunction(()=>typeof exportMap!=='undefined' && exportMap);
  const semantics=await desktop.evaluate(()=>['downloadFormatControl','downloadIntervalControl','downloadAspectControl','downloadExtentControl','downloadSpeedControl'].map(id=>document.getElementById(id).getAttribute('role')));
  assert.ok(semantics.every(role=>role==='group'));
  assert.equal(await desktop.locator('[aria-label="Vertical datum"]').getAttribute('role'),'group');
  checks.push('datum and export choices expose button group semantics');
  const contrast=await desktop.locator('#downloadBtn').evaluate(button=>{
    const c=getComputedStyle(button);
    function luminance(rgb){return rgb.match(/[\d.]+/g).slice(0,3).map(v=>{v=Number(v)/255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((v,c,i)=>v+c*[.2126,.7152,.0722][i],0);}
    const a=luminance(c.color),b=luminance(c.backgroundColor);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
  });
  assert.ok(contrast>=4.5,`Action contrast is ${contrast}`);checks.push('export action text contrast is at least4.5:1');
  await desktop.locator('#downloadModalCloseBtn').click();
  await desktop.locator('.nw-simple-zoom-out').focus();
  for(let i=0;i<8;i++) {
    await desktop.keyboard.press('Tab');
    assert.equal(await desktop.evaluate(()=>!!document.activeElement.closest('#exportStage')),false);
  }
  assert.equal(await desktop.evaluate(()=>exportMap.options.keyboard),false);
  assert.equal(await desktop.locator('#exportStage').evaluate(el=>el.inert),true);
  checks.push('offscreen export stage is inert and excluded from keyboard interaction');
  await graphics(desktop);
  await desktop.close();

  const mobile=await pageFor({viewport:{width:844,height:390},hasTouch:true,...(name==='firefox'?{}:{isMobile:true})});
  const activate=async selector=>{
    if(!await mobile.locator('body').evaluate(el=>el.classList.contains('mobile-controls-open')))await mobile.locator('#mobileControlsToggle').click();
    if(selector==='#openDownloadModalBtn' || selector==='#mapperTutorialBtn')await mobile.getByRole('tab',{name:'Tools',exact:true}).click();
    await mobile.locator(selector).click();
  };
  await activate('#mapperTutorialBtn');
  await mobile.locator('#mapperTutorialClose').click();
  if(!await mobile.locator('body').evaluate(el=>el.classList.contains('mobile-controls-open')))await mobile.locator('#mobileControlsToggle').click();
  await mobile.getByRole('tab',{name:'Tools',exact:true}).click();
  const tools=mobile.getByRole('tab',{name:'Tools',exact:true});
  await mobile.locator('#mapperTutorialBtn').focus();await mobile.keyboard.press('Tab');
  // The close control may be the actual first sequential element. Inactive
  // roving tabs must never become an explicit wrap target.
  assert.equal(await mobile.evaluate(()=>document.activeElement.getAttribute('aria-selected')==='false'),false);
  await tools.focus();await mobile.keyboard.press('Shift+Tab');
  assert.equal(await mobile.evaluate(()=>!!document.activeElement.closest('#leftPanel')),true);
  checks.push('mobile drawer forward/reverse Tab stays inside and excludes inactive tabs');
  const boxes=await mobile.locator('#nwwMobileControlHeader [role="tab"]').evaluateAll(tabs=>tabs.map(tab=>{const range=document.createRange();range.selectNodeContents(tab);return {textHeight:range.getBoundingClientRect().height,height:tab.getBoundingClientRect().height};}));
  assert.ok(boxes.every(b=>b.textHeight<=b.height+1),JSON.stringify(boxes));
  checks.push(name==='firefox'?'native Firefox minimum font30 keeps full drawer labels':'drawer labels fit their buttons');
  await mobile.evaluate(()=>{
    window.__holisticFocus=[];
    for(const type of ['focusin','focusout','keydown','keyup','input'])document.addEventListener(type,event=>{
      if(type.startsWith('focus') || event.target.id==='downloadStartDateText')window.__holisticFocus.push({type,id:event.target.id,key:event.key,value:event.target.value,start:event.target.selectionStart,at:performance.now()});
      if(window.__holisticFocus.length>60)window.__holisticFocus.shift();
    },true);
  });
  // No settling delay between opening and entering a date. Use page.keyboard
  // after focus so a stolen focus cannot be hidden by locator.press refocusing.
  for(let i=0;i<12;i++) {
    await activate('#openDownloadModalBtn');
    const input=mobile.locator('#downloadStartDateText');
    await input.fill('10/26/2026');
    await mobile.keyboard.press('End');
    await mobile.keyboard.press('ArrowLeft');await mobile.keyboard.press('ArrowLeft');
    await mobile.keyboard.press('Backspace');await mobile.keyboard.press('0');
    assert.equal(await input.inputValue(),'10/26/2026',`Date changed at attempt${i}`);
    assert.equal(await input.evaluate(el=>document.activeElement===el),true,JSON.stringify(await mobile.evaluate(()=>({attempt:window.__holisticAttempt,active:document.activeElement.id,events:window.__holisticFocus}))));
    await mobile.locator('#downloadModalCloseBtn').click();
    if(await mobile.locator('#mobileControlsClose').isVisible())await mobile.locator('#mobileControlsClose').click();
  }
  checks.push('12 immediate mobile date edits retain focus/caret using keyboard events');
  await snapshot(mobile,'mobile');await mobile.close();
  assert.deepEqual(errors,[]);checks.push('no uncaught browser errors');
} finally {
  const result={browser:name,version:browser.version(),checks,observations,errors};
  if(output)fs.writeFileSync(path.join(output,`${name}-ui.json`),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));await browser.close();
}
