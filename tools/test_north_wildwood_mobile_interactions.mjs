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
async function activate(selector){await page.locator(selector)[touch?'tap':'click']();}
try{
  await page.goto(process.env.NWW_TEST_URL || 'http://127.0.0.1:8765/index.html',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>document.body.classList.contains('nw-app-ready'),{},{timeout:90000});
  await page.evaluate(async()=>{
    await switchDataMode('observed');
    window.controlAudit=[];
    for(const type of ['pointerdown','pointerup','click'])document.addEventListener(type,event=>{
      window.controlAudit.push({type,id:event.target.id,body:document.body.className});
      if(window.controlAudit.length>30)window.controlAudit.shift();
    },true);
  });
  for(let i=0;i<20;i++){
    await activate('#mobileControlsToggle');
    if(!await page.locator('body').evaluate(el=>el.classList.contains('mobile-controls-open')))throw Error('Drawer did not open');
    await activate('#calendarTitleBtn');
    if(!await page.locator('#calendarPopover').evaluate(el=>el.classList.contains('open')))throw Error('Calendar did not open');
    await activate('#calendarPopoverCloseBtn');
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
