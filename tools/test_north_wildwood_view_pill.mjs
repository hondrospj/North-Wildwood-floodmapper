#!/usr/bin/env node
// Real browser/renderer regression. Environment follows the responsive suite:
// NWW_TEST_URL, PLAYWRIGHT_MODULE, CHROME_PATH, NWW_BROWSER=webkit.
import assert from 'node:assert/strict';

const {chromium,webkit}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const engine=process.env.NWW_BROWSER==='webkit' ? webkit : chromium;
const browser=await engine.launch({headless:true,
  ...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {}),
  ...(engine===chromium ? {args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']} : {}),
});
const url=process.env.NWW_TEST_URL || 'http://127.0.0.1:8765/index.html';
const twoPaints=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));

async function checkViewport({width,height,mobile=false}) {
  const name=`${width}x${height}${mobile?' touch':''}`;
  const context=await browser.newContext({viewport:{width,height},deviceScaleFactor:2,hasTouch:mobile,isMobile:mobile});
  const page=await context.newPage();
  page.setDefaultTimeout(30000);
  const errors=[],stages={};
  page.on('pageerror',error=>errors.push(error.message));
  let releaseRuntime,requestedRuntime,requests=0;
  const released=new Promise(resolve=>{releaseRuntime=resolve;});
  const requested=new Promise(resolve=>{requestedRuntime=resolve;});
  let audit,reference;
  try {
    await page.addInitScript(()=>{
      const audit=window.__viewPillAudit={frames:0,samples:[],stopped:false};
      const canvas=document.createElement('canvas');canvas.width=canvas.height=1;
      const color=canvas.getContext('2d',{willReadFrequently:true});
      const bounds=node=>{const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};
      window.__captureViewPill=()=>{
        const pill=document.querySelector('#nwDefaultNavControl .nw-simple-view');
        if(!pill?.getClientRects().length||getComputedStyle(pill).visibility==='hidden')return null;
        for(let parent=pill;parent;parent=parent.parentElement)if(Number(getComputedStyle(parent).opacity)===0)return null;
        const loader=document.getElementById('nwSiteLoader');
        if(loader&&!loader.hidden){const style=getComputedStyle(loader);if(style.display!=='none'&&style.visibility!=='hidden'&&Number(style.opacity)>0)return null;}
        const style=getComputedStyle(pill);
        color.clearRect(0,0,1,1);color.fillStyle=style.backgroundColor;color.fillRect(0,0,1,1);
        let effectiveOpacity=1;
        for(let node=pill;node;node=node.parentElement)effectiveOpacity*=Number(getComputedStyle(node).opacity);
        return {
          rect:bounds(pill),navRect:bounds(document.getElementById('nwDefaultNavControl')),
          background:style.backgroundColor,backgroundAlpha:color.getImageData(0,0,1,1).data[3],
          opacity:Number(style.opacity),effectiveOpacity,
          hover:pill.matches(':hover'),focus:pill.matches(':focus-visible'),outline:style.outlineStyle,
          busy:pill.getAttribute('aria-busy')==='true',pressed:pill.getAttribute('aria-pressed')==='true',
          label:pill.textContent.trim(),mode:document.body.dataset.mapViewMode,
          renderer:document.body.dataset.map3d,pitch:Number(document.body.dataset.map3dPitch),at:performance.now(),
        };
      };
      let previous;
      function sample() {
        if(audit.stopped)return;
        audit.frames++;
        const value=window.__captureViewPill();
        if(value){
          const signature=JSON.stringify({...value,at:0});
          if(signature!==previous){audit.samples.push({...value,frame:audit.frames});previous=signature;}
        }
        requestAnimationFrame(sample);
      }
      requestAnimationFrame(sample);
    });
    // Pause the real first 3D runtime download, rather than replacing map code
    // or manufacturing a busy attribute. Release it to load the real renderer.
    await page.route('**/maplibre-gl@*/dist/maplibre-gl.js*',async route=>{
      requests++;requestedRuntime();await released;await route.continue();
    });
    await page.goto(url,{waitUntil:'domcontentloaded',timeout:90000});
    await page.waitForFunction(()=>!!document.body.dataset.unifiedUiReady&&Number(document.body.dataset.unifiedLayoutPasses)>0);
    await page.waitForFunction(()=>{
      const loader=document.getElementById('nwSiteLoader'),style=loader&&getComputedStyle(loader);
      return (!loader||loader.hidden||style.display==='none'||style.visibility==='hidden'||Number(style.opacity)===0)&&
        Number(getComputedStyle(document.getElementById('app')).opacity)>0.999;
    },{},{timeout:90000});
    const pill=page.locator('#nwDefaultNavControl .nw-simple-view');
    await pill.waitFor({state:'visible'});
    await page.mouse.move(0,0);
    await twoPaints(page);
    reference=await page.evaluate(()=>window.__captureViewPill());
    assert.equal(reference.pressed,false,'Begin in the real 2D map');
    assert.equal(requests,0,'3D runtime must remain on demand until a user opens it');
    const near=(actual,expected,label)=>assert.ok(Math.abs(actual-expected)<=1,
      `${name} ${label}: ${actual} differs from ${expected}`);
    function stable(state,label) {
      assert.ok(state,`${name} ${label}: pill must remain visible`);
      assert.equal(state.backgroundAlpha,255,`${name} ${label}: background ${state.background} must be fully opaque`);
      // Opacity is not a pixel-distance measurement: even a small fade is a
      // regression, although rectangle rounding may differ by one CSS pixel.
      assert.ok(Math.abs(state.opacity-1)<0.001,`${name} ${label}: own opacity must stay 1`);
      assert.ok(Math.abs(state.effectiveOpacity-1)<0.001,`${name} ${label}: no ancestor may fade the pill`);
      for(const key of ['x','y','width','height']) {
        near(state.rect[key],reference.rect[key],label+' button '+key);
        near(state.navRect[key],reference.navRect[key],label+' navigation '+key);
      }
    }
    async function capture(label) {
      const state=await page.evaluate(()=>window.__captureViewPill());
      stages[label]=state;stable(state,label);return state;
    }
    async function settled(pressed) {
      await page.waitForFunction(expected=>{
        const pill=document.querySelector('#nwDefaultNavControl .nw-simple-view');
        return document.body.dataset.map3d==='fallback'||(pill?.getAttribute('aria-busy')!=='true'&&
          (expected===null||pill?.getAttribute('aria-pressed')===String(expected)));
      },pressed,{timeout:90000});
      assert.notEqual(await page.locator('body').getAttribute('data-map3d'),'fallback','The real 3D renderer must load successfully');
      await twoPaints(page);
    }
    const activate=()=>pill[mobile?'tap':'click']();
    await capture('2D normal');
    await pill.hover();await twoPaints(page);
    assert.equal((await capture('2D hover')).hover,true,'Exercise the actual hover selector');
    await activate();
    let deadline;
    try {
      await Promise.race([requested,new Promise((_,reject)=>{
        deadline=setTimeout(()=>reject(new Error('First 3D click did not request the real MapLibre runtime')),30000);
      })]);
    } finally {clearTimeout(deadline);}
    await page.waitForFunction(()=>document.querySelector('#nwDefaultNavControl .nw-simple-view')?.getAttribute('aria-busy')==='true');
    await twoPaints(page);
    const busy=await capture('delayed first 3D busy');
    assert.equal(busy.busy,true);assert.equal(busy.pressed,true);
    // Real repeated inputs while the dependency is pending must remain safe.
    await activate();await activate();await twoPaints(page);
    assert.equal((await capture('repeated clicks while busy')).busy,true);
    assert.equal(requests,1,'Busy clicks must not duplicate the first runtime load');
    releaseRuntime();
    await page.waitForFunction(()=>document.body.classList.contains('map-3d-ready')||document.body.dataset.map3d==='fallback',{},{timeout:90000});
    await settled(true);
    await pill.hover();await twoPaints(page);await capture('3D selected hover');
    await page.mouse.move(0,0);await twoPaints(page);
    const selected=await capture('3D selected without hover');
    assert.equal(selected.pressed,true);assert.equal(selected.hover,false);
    if(!mobile) {
      // Tab navigation supplies real keyboard focus-visible semantics.
      await pill.focus();await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');
      const focused=await capture('3D keyboard focus');
      assert.equal(focused.focus,true);assert.notEqual(focused.outline,'none');
      await pill.press('Enter');
    } else await activate();
    await settled(false);
    await page.mouse.move(0,0);await twoPaints(page);await capture('returned 2D normal');
    await pill.hover();await twoPaints(page);await capture('returned 2D hover');
    const box=await pill.boundingBox();
    for(let index=0;index<8;index++) {
      if(mobile)await page.touchscreen.tap(box.x+box.width/2,box.y+box.height/2);
      else await page.mouse.click(box.x+box.width/2,box.y+box.height/2);
    }
    await settled(null);
    const rapid=await capture('rapid switches settled');
    assert.equal(rapid.mode,rapid.pressed?'3d':'2d');
    assert.equal(rapid.label,rapid.pressed?'3D':'2D');
    assert.equal(rapid.pitch>10,rapid.pressed,'The settled mode label must agree with the actual camera pitch');
    if(rapid.pressed){await activate();await settled(false);}
    await page.mouse.move(0,0);await twoPaints(page);await capture('final 2D');
    audit=await page.evaluate(()=>{window.__viewPillAudit.stopped=true;return window.__viewPillAudit;});
    for(const state of audit.samples.filter(state=>state.at>=reference.at))stable(state,'painted frame '+state.frame);
    assert.ok(audit.samples.some(state=>state.busy),'Observe painted busy frames');
    assert.ok(audit.samples.some(state=>state.pressed&&!state.busy),'Observe painted selected 3D frames');
    assert.deepEqual(errors,[],'No uncaught errors during real renderer startup or repeated toggles');
    console.log(`PASS opaque view pill ${name}: normal/hover/busy/selected${mobile?'':'/keyboard focus'}/rapid toggles; real first 3D runtime (${audit.frames} frames)`);
  } catch(error) {
    console.error(JSON.stringify({viewport:name,stages,reference,requests,errors,
      audit:audit||await page.evaluate(()=>window.__viewPillAudit).catch(()=>null)},null,2));
    throw error;
  } finally {
    releaseRuntime();await context.close();
  }
}
try {
  await checkViewport({width:1512,height:889});
  await checkViewport({width:390,height:844,mobile:true});
} finally {await browser.close();}
