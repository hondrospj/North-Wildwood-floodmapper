// Run against a local preview: NWW_TEST_URL=http://127.0.0.1:8765/index.html
// PLAYWRIGHT_MODULE and CHROME_PATH follow test_north_wildwood_layout.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
const {chromium, webkit}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const engine=process.env.NWW_BROWSER==='webkit' ? webkit : chromium;
const browser=await engine.launch({headless:true,...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH}:{}),...(engine===chromium?{args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']}: {})});
const failures=[],checks=[];
const touchPages=new WeakSet();
const url=process.env.NWW_TEST_URL || 'http://127.0.0.1:8765/index.html';
const parcel=JSON.parse(fs.readFileSync(new URL('../assets/parcel-history-v2/NorthWildwoodParcels.geojson',import.meta.url),'utf8')).features[0];
const sizes=[[1512,945],[1321,800],[1200,800],[1121,768],[1024,768],[901,768],[900,768],[861,768],[860,768],[768,1024],[430,932],[390,844],[360,800],[320,568],[1512,600],[1024,561],[1024,560],[932,430],[667,375],[568,320],[1512,945]];
function check(ok,label,details){checks.push(label);if(!ok)failures.push({label,details});}
async function settled(page){await page.waitForTimeout(900);}
async function activate(page,selector){
  const control=page.locator(selector);
  try{if(touchPages.has(page))await control.tap();else await control.click();}
  catch(error){
    console.error('Control failure',selector,await control.evaluate(el=>{
      const chain=[];for(let p=el;p;p=p.parentElement){const s=getComputedStyle(p),r=p.getBoundingClientRect();chain.push({id:p.id,tag:p.tagName,classes:p.className,display:s.display,visibility:s.visibility,x:r.x,y:r.y,w:r.width,h:r.height,scroll:p.scrollTop});}
      return {chain,active:document.activeElement?.id};
    }));
    throw error;
  }
}
async function openDrawer(page){if(await page.locator('body').evaluate(e=>e.classList.contains('mobile-optimized')&&!e.classList.contains('mobile-controls-open')))await activate(page,'#mobileControlsToggle');}
async function closeDrawer(page){if(await page.locator('body').evaluate(e=>e.classList.contains('mobile-controls-open')))await activate(page,'#mobileControlsClose');}
async function contained(page,selector,label){
  const result=await page.locator(selector).evaluate(el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,vw:innerWidth,vh:innerHeight,sw:el.scrollWidth,cw:el.clientWidth};});
  check(result.w>0&&result.x>=-1&&result.y>=-1&&result.x+result.w<=result.vw+1&&result.y+result.h<=result.vh+1,label,result);
}
async function hitTestable(page,selector,label){
  const result=await page.locator(selector).evaluate(el=>{const r=el.getBoundingClientRect();const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {reachable:hit===el||el.contains(hit),x:r.x,y:r.y,w:r.width,h:r.height};});
  check(result.reachable,label,result);
}
try {
  for(const touch of process.env.NWW_TOUCH_ONLY ? [true] : [false,true]){
    const context=await browser.newContext({viewport:touch?{width:390,height:844}:{width:1512,height:945},hasTouch:touch,isMobile:touch,deviceScaleFactor:touch?2:1});
    const page=await context.newPage();
    if(touch)touchPages.add(page);
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    page.setDefaultTimeout(15000);
    await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
    await page.waitForFunction(()=>document.body.classList.contains('nw-app-ready'),{},{timeout:90000});
    for(const [width,height] of touch?[[390,844],[320,568],[844,390],[390,400],[390,844]]:sizes){
      await page.setViewportSize({width,height});await settled(page);
      const state=await page.evaluate(()=>{
        const visible=el=>el&&el.getBoundingClientRect().width>0&&getComputedStyle(el).visibility!=='hidden'&&getComputedStyle(el).display!=='none';
        const rect=id=>{const e=document.getElementById(id);if(!visible(e))return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,w:r.width,h:r.height};};
        const overlap=(a,b)=>a&&b&&Math.min(a.right,b.right)-Math.max(a.x,b.x)>1&&Math.min(a.bottom,b.bottom)-Math.max(a.y,b.y)>1;
        return {compact:document.body.classList.contains('mobile-optimized'),rootOverflow:document.documentElement.scrollWidth>innerWidth+1,toggle:visible(document.getElementById('mobileControlsToggle')),rail:visible(document.getElementById('rightRail')),titleNavOverlap:overlap(rect('mapTitleBadge'),rect('nwDefaultNavControl')),sidebarTimestampOverlap:overlap(rect('leftPanel'),rect('timelineBubble')),bubble:rect('timelineBubble'),nav:rect('nwDefaultNavControl'),timeline:rect('timelineDock'),title:rect('mapTitleBadge')};
      });
      const compact=width<=900||height<=560;const prefix=`${touch?'touch':'mouse'} ${width}x${height}`;
      check(state.compact===compact,`${prefix} breakpoint`,state);
      check(!state.rootOverflow,`${prefix} root containment`,state);
      check(!state.titleNavOverlap,`${prefix} title/navigation separation`,state);
      check(state.toggle===compact&&state.rail===!compact,`${prefix} correct controls`,state);
      if(!compact)check(!state.sidebarTimestampOverlap,`${prefix} sidebar/timestamp separation`,state);
      for(const id of ['mapTitleBadge','timelineDock','timelineBubble','nwDefaultNavControl'])await contained(page,'#'+id,`${prefix} ${id} fits`);
      if(compact){await openDrawer(page);await settled(page);await contained(page,'#leftPanel',`${prefix} open drawer fits`);await closeDrawer(page);await settled(page);check(!await page.locator('body').evaluate(e=>e.classList.contains('mobile-controls-open')),`${prefix} close button works`);}
      console.log(prefix,'checked');
    }
    for(const width of [320,390,768]){
      await page.setViewportSize({width,height:width===768?1024:844});await settled(page);
      await openDrawer(page);await activate(page,'#openDownloadModalBtn');await settled(page);
      await contained(page,'#downloadModal .download-modal-card',`${width} export fits`);
      const overflow=await page.locator('#downloadModal .download-modal-card').evaluate(card=>{const r=card.getBoundingClientRect();return [...card.querySelectorAll('button,input:not([type=hidden]),select')].filter(el=>{if(el.classList.contains('export-native-date-picker'))return false;const b=el.getBoundingClientRect();return b.width>0&&(b.left<r.left-1||b.right>r.right+1)}).map(el=>el.id);});
      check(!overflow.length,`${width} export controls fit`,overflow);
      for(const id of ['exportFormatPngBtn','exportFormatGifBtn','exportAspectSquareBtn','exportAspectPortraitBtn','exportExtentCurrentBtn','exportExtentTownBtn']){
        if(await page.locator('#'+id).count())await activate(page,'#'+id);
      }
      const playBox=await page.locator('#playBtn').boundingBox();
      await page.mouse.click(playBox.x+playBox.width/2,playBox.y+playBox.height/2);
      check(!await page.evaluate(()=>Boolean(playTimer)),`${width} dialog click does not start playback`);
      if(await page.locator('#downloadModalCloseBtn').isVisible())await activate(page,'#downloadModalCloseBtn');
      await openDrawer(page);await activate(page,'#observedDataBtn');await settled(page);
      await activate(page,'#calendarTitleBtn');await settled(page);
      await contained(page,'#calendarPopover',`${width} calendar fits`);
      const selectedHour=await page.evaluate(()=>currentHourIndex);
      await page.keyboard.press('ArrowRight');
      check(await page.evaluate(()=>currentHourIndex)===selectedHour,`${width} calendar keys do not advance timeline`);
      await activate(page,'#calendarPopoverCloseBtn');
      check(!await page.locator('#calendarPopover').evaluate(e=>e.classList.contains('open')),`${width} calendar close works`);
      await activate(page,'#returnIntervalDataBtn');await settled(page);
      check(await page.locator('#returnIntervalCard').isVisible(),`${width} modeled mode visible`);
      await activate(page,'#forecastDataBtn');await settled(page);
      await activate(page,'#dataSourceHelpBtn');
      await contained(page,'#infoModal .info-modal-card',`${width} help fits`);
      await activate(page,'#infoModalCloseBtn');
      await activate(page,'#observedDataBtn');await settled(page);
      await page.locator('.top-tide-more-btn:visible').first()[touch?'tap':'click']();
      await contained(page,'#topTidesModal .top-tides-modal-card',`${width} top tides fits`);
      await activate(page,'#topTidesModalCloseBtn');
      await closeDrawer(page);
    }
    for(const [width,height] of [[320,568],[390,844],[568,320]]){
      await page.setViewportSize({width,height});await settled(page);
      await page.evaluate(feature=>openParcelFloodPrompt(feature,map.getCenter()),parcel);
      await settled(page);
      await contained(page,'.nw-mobile-popup .maplibregl-popup-content',`${width}x${height} building popup fits`);
      await hitTestable(page,'.nw-mobile-popup .maplibregl-popup-close-button',`${width}x${height} popup close immediately reachable`);
      await activate(page,'.nw-mobile-popup .house-alert-cta');
      await settled(page);
      await contained(page,'#floodHistoryPane',`${width}x${height} history dialog fits`);
      await activate(page,'#floodHistoryCloseBtn');
      await activate(page,'.nw-mobile-popup .maplibregl-popup-close-button');
      check(!await page.locator('.nw-mobile-popup').count(),`${width}x${height} popup close works`);
      await openDrawer(page);
      await activate(page,'#mapperTutorialBtn');
      for(let i=0;i<8;i++){
        await settled(page);
        await contained(page,'#mapperTutorialCard',`${width}x${height} tutorial ${i+1} fits`);
        await activate(page,'#mapperTutorialNext');
      }
      await closeDrawer(page);
      await settled(page);
      if(process.env.NWW_SCREENSHOT_DIR){fs.mkdirSync(process.env.NWW_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:`${process.env.NWW_SCREENSHOT_DIR}/${touch?'touch':'mouse'}-${width}x${height}.png`});}
    }
    check(!errors.length,`${touch?'touch':'mouse'} no uncaught errors`,errors);
    await context.close();
  }
}finally{console.log('Checks completed before shutdown',checks.length,'failures',JSON.stringify(failures));await browser.close();}
console.log(JSON.stringify({checks:checks.length,failures},null,2));
assert.equal(failures.length,0,'Responsive regressions; see the failure list above');
