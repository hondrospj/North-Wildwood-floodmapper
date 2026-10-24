// Complete a real preview capture during a held mobile-format gesture. The
// renderer and flood data are real; only capture completion is synchronized.
import assert from 'node:assert/strict';
const {chromium,webkit}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const engine=process.env.NWW_BROWSER==='webkit'?webkit:chromium;
const browser=await engine.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{}),...(engine===chromium?{args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']}: {})});
const page=await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
const errors=[],warnings=[];
page.on('pageerror',error=>errors.push(error.message));
page.on('console',message=>{if(['warning','error'].includes(message.type())){warnings.push(message.text());if(warnings.length>10)warnings.shift();}});
try{
  await page.goto(process.env.NWW_TEST_URL || 'http://127.0.0.1:8765/index.html',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>document.body.classList.contains('nw-app-ready'),{},{timeout:90000});
  await page.evaluate(()=>{
    const capture=captureExportCanvas;
    captureExportCanvas=async(...args)=>{
      const canvas=await capture(...args);
      if(!window.previewCaptureReady){
        window.previewCaptureReady=true;
        await new Promise(resolve=>{window.releasePreviewCapture=resolve;});
      }
      return canvas;
    };
  });
  await page.locator('#mobileControlsToggle').click();
  await page.getByRole('tab',{name:'Tools',exact:true}).click();
  await page.locator('#openDownloadModalBtn').click();
  await page.waitForFunction(()=>window.previewCaptureReady,{},{timeout:90000});
  const control=page.locator('#exportFormatPngBtn');
  await control.scrollIntoViewIfNeeded();
  await control.evaluate(element=>{
    const snapshot=()=>{
      const {x,y,width,height}=element.getBoundingClientRect();
      const hit=document.elementFromPoint(x+width/2,y+height/2);
      return{x,y,width,height,hit:hit?.closest('button')?.id,pressed:window.previewGesturePressed,state:document.getElementById('exportPreview').dataset.state};
    };
    window.previewGestureEvents=[];
    for(const type of ['pointerdown','pointerup','click'])element.addEventListener(type,event=>{
      if(type==='pointerdown')window.previewGesturePressed=true;
      if(type==='pointerup')window.previewGesturePressed=false;
      window.previewGestureEvents.push({type,target:event.target.id,at:performance.now(),...snapshot()});
    },true);
    element.addEventListener('pointerdown',()=>{
      window.previewGestureBefore=snapshot();
      window.releasePreviewCapture();
      requestAnimationFrame(()=>requestAnimationFrame(()=>{window.previewGestureDuring=snapshot();}));
    },{once:true});
  });
  // A locator gesture verifies visibility and hit-testing before dispatch. Raw
  // page.mouse coordinates do not perform those checks in mobile emulation.
  await control.click({delay:400});
  // Software compositing can postpone rAF polling even after the sample was
  // recorded. Timer polling observes it without weakening the held-state check.
  await page.waitForFunction(()=>window.previewGestureDuring,{},{timeout:30000,polling:50});
  const {before,during,events}=await page.evaluate(()=>({before:window.previewGestureBefore,during:window.previewGestureDuring,events:window.previewGestureEvents}));
  console.log('Preview gesture geometry',JSON.stringify({before,during,events}));
  assert.equal(before.hit,'exportFormatPngBtn');
  assert.equal(during.pressed,true,'The real capture must complete during the held gesture');
  assert.ok(Math.abs(before.x-during.x)<1&&Math.abs(before.y-during.y)<1,'Preview completion moved the format control during a held gesture');
  await page.waitForFunction(()=>document.getElementById('downloadFormatSelect').value==='png',{},{timeout:30000,polling:50});
  assert.equal(await control.getAttribute('aria-pressed'),'true');
  await page.waitForFunction(()=>document.getElementById('exportPreview').dataset.state==='ready',{},{timeout:90000});
  assert.deepEqual(errors,[]);
  console.log('Real preview completion preserves the held format gesture and selected PNG setting');
}catch(error){
  console.error('Preview test state',JSON.stringify(await page.evaluate(()=>({preview:document.getElementById('exportPreview')?.dataset.state,status:document.getElementById('exportPreviewStatus')?.textContent,format:document.getElementById('downloadFormatSelect')?.value,frame:floodFrameState,body:document.body.className,before:window.previewGestureBefore,during:window.previewGestureDuring,events:window.previewGestureEvents,viewport:{width:innerWidth,height:innerHeight,scale:visualViewport?.scale,offsetTop:visualViewport?.offsetTop}}))),JSON.stringify({errors,warnings}));
  throw error;
}finally{await browser.close();}
