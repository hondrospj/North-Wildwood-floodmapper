// Rapid interactions intentionally have no settling sleeps: layout controllers
// must not move a control between pointer-down and pointer-up.
// Uses NWW_TEST_URL, PLAYWRIGHT_MODULE, CHROME_PATH, NWW_BROWSER and NWW_TOUCH.
const {chromium,webkit}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const engine=process.env.NWW_BROWSER==='webkit' ? webkit : chromium;
const browser=await engine.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{}),...(engine===chromium?{args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']}: {})});
const touch=process.env.NWW_TOUCH==='1';
const page=await browser.newPage({viewport:{width:320,height:568},hasTouch:touch,isMobile:touch});
const errors=[];
page.on('pageerror',error=>errors.push(error.message));
page.setDefaultTimeout(15000);
async function activate(selector){
  const control=page.locator(selector);
  if(await control.evaluate(el=>!!el.closest('#leftPanel'))&&await page.locator('#mobileControlsToggle').isVisible()&&!await page.locator('body').evaluate(el=>el.classList.contains('mobile-controls-open')))await page.locator('#mobileControlsToggle')[touch?'tap':'click']();
  const group=await control.evaluate(el=>el.closest('[data-nww-group]')?.dataset.nwwGroup);
  if(group&&await page.locator('body').evaluate(el=>el.classList.contains('mobile-controls-open'))){
    const tab=page.locator(`#nwwMobileControlHeader [data-group="${group}"]`);
    if(await tab.getAttribute('aria-selected')!=='true')await tab[touch?'tap':'click']();
  }
  await control[touch?'tap':'click']();
}
try{
  await page.goto(process.env.NWW_TEST_URL || 'http://127.0.0.1:8765/index.html',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>document.body.classList.contains('nw-app-ready'),{},{timeout:90000});
  await page.evaluate(async()=>{
    await switchDataMode('observed');
    window.controlAudit=[];
    for(const type of ['pointerdown','pointerup','click'])document.addEventListener(type,event=>{
      const button=event.target.closest('button'),rect=button?.getBoundingClientRect();
      window.controlAudit.push({type,id:event.target.id,button:button?.id,body:document.body.className,at:performance.now(),connected:event.target.isConnected,inert:!!event.target.closest('[inert]'),active:document.activeElement?.id,rect:rect&&{x:rect.x,y:rect.y,width:rect.width,height:rect.height}});
      if(window.controlAudit.length>30)window.controlAudit.shift();
    },true);
    new MutationObserver(records=>{
      window.controlAudit.push({type:'month-label-mutation',at:performance.now(),removed:records.reduce((sum,record)=>sum+record.removedNodes.length,0),added:records.reduce((sum,record)=>sum+record.addedNodes.length,0),value:document.getElementById('monthLabel').textContent});
      if(window.controlAudit.length>30)window.controlAudit.shift();
    }).observe(document.getElementById('monthLabel'),{childList:true});
  });
  for(let i=0;i<20;i++){
    await activate('#mobileControlsToggle');
    if(!await page.locator('body').evaluate(el=>el.classList.contains('mobile-controls-open')))throw Error('Drawer did not open');
    // The previous cycle ends in Tools. Select Forecast before opening its
    // calendar, even when that control is hidden by the current section.
    await activate('#observedCalendarOpenBtn');
    // Hold the first mouse click through delayed layout timers. Detaching the
    // calendar card during this gesture suppresses click in WebKit.
    if(!touch&&i===0)await page.locator('#calendarTitleBtn').click({delay:400});
    else await activate('#calendarTitleBtn');
    // WebKit may deliver the synthetic click after its mouseup command returns.
    // Await the resulting state without sleeping before/between pointer events.
    await page.waitForFunction(()=>document.getElementById('calendarPopover').classList.contains('open'),{},{timeout:3000});
    await activate('#calendarPopoverCloseBtn');
    if(await page.locator('#observedCalendarCloseBtn').isVisible())await activate('#observedCalendarCloseBtn');
    await activate('#mapperTutorialBtn');
    await activate('#mapperTutorialClose');
    if(await page.locator('body').evaluate(el=>el.classList.contains('mobile-controls-open')))await activate('#mobileControlsClose');
    console.log(`${touch?'touch':'mouse'} interaction cycle ${i+1} passed`);
  }
  if(errors.length)throw Error('Uncaught errors: '+errors.join('; '));
}catch(error){
  console.error(JSON.stringify(await page.evaluate(()=>({events:window.controlAudit,body:document.body.className,calendar:document.getElementById('calendarPopover')?.className,tourParent:document.getElementById('mapperTutorialBtn')?.parentElement.id})),null,2));
  throw error;
}finally{await browser.close();}
