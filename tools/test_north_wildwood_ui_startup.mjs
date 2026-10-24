#!/usr/bin/env node
// Uses the same preview/browser environment as the responsive test suite:
// NWW_TEST_URL, PLAYWRIGHT_MODULE, CHROME_PATH, and NWW_BROWSER=webkit.
import assert from 'node:assert/strict';

const {chromium,webkit}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const engine=process.env.NWW_BROWSER==='webkit' ? webkit : chromium;
const browser=await engine.launch({headless:true,
  ...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {}),
  ...(engine===chromium ? {args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']} : {}),
});
const url=process.env.NWW_TEST_URL || 'http://127.0.0.1:8765/index.html';
const twoPaints=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
const tolerance=1;

function gate() {
  let release,received;
  const open=new Promise(resolve=>{release=resolve;});
  const requested=new Promise(resolve=>{received=resolve;});
  return {release,requested,handler:async route=>{received();await open;await route.continue();}};
}
async function requested(gate,label) {
  let deadline;
  try {
    await Promise.race([gate.requested,new Promise((_,reject)=>{
      deadline=setTimeout(()=>reject(new Error(`Startup did not request ${label}`)),60000);
      deadline.unref?.();
    })]);
  } finally { clearTimeout(deadline); }
}

async function checkStartup({width,height,dpr=1,mobile=false}) {
  const name=`${width}x${height}@${dpr}${mobile?' touch':''}`;
  const trace=stage=>{if(process.env.NWW_UI_TRACE)console.log(`UI startup ${name}: ${stage}`);};
  const context=await browser.newContext({viewport:{width,height},deviceScaleFactor:dpr,hasTouch:mobile,isMobile:mobile});
  const page=await context.newPage();
  page.setDefaultTimeout(30000);
  const controller=gate(),tides=gate(),errors=[],stages={};
  let navigation,audit;
  page.on('pageerror',error=>errors.push(error.message));
  try {
    await page.addInitScript(()=>{
      const audit=window.__uiStartupAudit={frames:0,samples:[],stopped:false};
      const text=node=>node?.textContent.replace(/\s+/g,' ').trim() || '';
      const bounds=node=>{const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};
      function rendered(node) {
        if (!node?.getClientRects().length) return false;
        const r=node.getBoundingClientRect();
        if (!r.width || !r.height) return false;
        for(let parent=node;parent;parent=parent.parentElement) {
          const style=getComputedStyle(parent);
          if(style.display==='none'||style.visibility==='hidden')return false;
        }
        return true;
      }
      function painted(node) {
        if(!rendered(node))return false;
        for(let parent=node;parent;parent=parent.parentElement)if(Number(getComputedStyle(parent).opacity)===0)return false;
        const loader=document.getElementById('nwSiteLoader');
        if(loader&&!loader.hidden){const style=getComputedStyle(loader);if(style.display!=='none'&&style.visibility!=='hidden'&&Number(style.opacity)>0)return false;}
        const r=node.getBoundingClientRect();
        let left=Math.max(0,r.left),top=Math.max(0,r.top),right=Math.min(innerWidth,r.right),bottom=Math.min(innerHeight,r.bottom);
        let escapesOverflow=getComputedStyle(node).position==='fixed';
        for(let parent=node.parentElement;parent;parent=parent.parentElement) {
          const s=getComputedStyle(parent),p=parent.getBoundingClientRect();
          if(escapesOverflow) {
            // A viewport-fixed timestamp is not clipped by the dock's normal
            // overflow box. Only a real fixed-position containing block can
            // make ancestor clipping apply to it.
            const containsFixed=s.transform!=='none'||s.perspective!=='none'||s.filter!=='none'||
              /paint|layout|strict|content/.test(s.contain)||/transform|perspective|filter/.test(s.willChange);
            if(!containsFixed)continue;
            escapesOverflow=false;
          }
          if(/auto|scroll|hidden|clip/.test(s.overflowX)){left=Math.max(left,p.left);right=Math.min(right,p.right);}
          if(/auto|scroll|hidden|clip/.test(s.overflowY)){top=Math.max(top,p.top);bottom=Math.min(bottom,p.bottom);}
        }
        return right>left && bottom>top;
      }
      const typography=node=>{
        if(!node)return null;
        const s=getComputedStyle(node);
        return {fontFamily:s.fontFamily,fontSize:s.fontSize,fontWeight:s.fontWeight,lineHeight:s.lineHeight};
      };
      const capture=node=>rendered(node)?{...bounds(node),painted:painted(node)}:null;
      const wrapper=node=>rendered(node)?{...capture(node),maxHeight:getComputedStyle(node).maxHeight}:null;
      const byId=id=>capture(document.getElementById(id));
      window.__captureUiStartup=()=>{
        const title=document.getElementById('mapTitleBadge'),rail=document.getElementById('rightRail');
        const play=document.getElementById('playBtn'),icon=play?.querySelector('.playIcon.playTriangle');
        const bubble=document.getElementById('timelineBubble');
        const current=bubble?.querySelector('.timeline-bubble-current'),stage=bubble?.querySelector('.timeline-bubble-stage');
        const cards={},controls={};
        for(const [key,selector]of Object.entries({layers:'.layers-card',tides:'.top-tides-card',export:'#downloadCard',address:'#townAddressCard',tour:'#mapperTutorialBtn'})) {
          const card=rail?.querySelector(selector);
          if(rendered(card))cards[key]={...capture(card),heading:text(card.querySelector('h2,h3'))};
        }
        for(const node of rail?.querySelectorAll('button,input,[role="switch"]') || []) {
          if(!rendered(node))continue;
          let key=node.id;
          if(!key && node.classList.contains('top-tide-item'))key='tide-'+[...node.parentElement.querySelectorAll('.top-tide-item')].indexOf(node);
          if(!key && node.classList.contains('top-tide-more-btn'))key='tide-more';
          if(!key)continue;
          controls[key]={...capture(node),text:text(node),placeholder:node.getAttribute('placeholder'),type:node.getAttribute('type')};
        }
        const layers=rail?.querySelector('.layers-card');
        return {
          ready:!!document.body?.dataset.unifiedUiReady,
          title:capture(title),titleText:byId('mapTitleText'),titleFont:typography(document.getElementById('mapTitleText')),
          titleImages:[...title?.querySelectorAll('img') || []].filter(rendered).map(img=>({id:img.id,src:img.getAttribute('src'),...capture(img)})),
          left:wrapper(document.getElementById('leftPanel')),rail:wrapper(rail),cards,controls,
          layerRows:rendered(layers)?[...layers.querySelectorAll('.layer-item')].map(row=>({
            id:row.querySelector('[role="switch"]')?.id,label:text(row.querySelector('.layer-name')),...capture(row),
          })):[],
          nav:byId('nwDefaultNavControl'),
          navParts:Object.fromEntries(['.nw-direction-wheel','.nw-simple-view','.nw-simple-zoom'].map(selector=>[selector,capture(document.querySelector('#nwDefaultNavControl '+selector))])),
          timeline:byId('timelineDock'),play:capture(play),playIcon:capture(icon),playText:text(play),
          bubble:rendered(bubble)?{
            ...capture(bubble),text:text(bubble),typed:!!(text(current)&&text(stage)&&
              text(current)!=='--'&&text(stage)!=='--'&&!bubble.querySelector('.timeline-bubble-startup-placeholder')),
            currentFont:typography(current),stageFont:typography(stage),
          }:null,
          leftVisible:painted(document.getElementById('leftPanel')),
        };
      };
      let previous;
      function sample() {
        if(audit.stopped)return;
        audit.frames++;
        const state=window.__captureUiStartup(),signature=JSON.stringify(state);
        if(signature!==previous){audit.samples.push({...state,frame:audit.frames,at:performance.now()});previous=signature;}
        requestAnimationFrame(sample);
      }
      // Observe the first document paint, not just a convenient later loaded
      // state. Holds below independently expose controller and data arrivals.
      requestAnimationFrame(sample);
    });
    await page.route('**/assets/app/unified-controller.js*',controller.handler);
    await page.route('**/toptides.json*',tides.handler);
    navigation=page.goto(url,{waitUntil:'domcontentloaded',timeout:90000});
    navigation.catch(()=>{});
    await Promise.race([requested(controller,'unified-controller.js'),navigation.then(()=>{
      throw new Error('Navigation completed without the required controller request hold');
    })]);
    await page.waitForFunction(()=>document.getElementById('mapperTutorialBtn')&&document.getElementById('playBtn'));
    await twoPaints(page);
    stages.controllerHeld=await page.evaluate(()=>window.__captureUiStartup());
    trace('controller held; initial paint captured');
    assert.equal(stages.controllerHeld.ready,false,'The first stage must precede controller execution');
    controller.release();
    await navigation;
    await page.waitForFunction(()=>!!document.body.dataset.unifiedUiReady&&Number(document.body.dataset.unifiedLayoutPasses)>0);
    await requested(tides,'toptides.json');
    await twoPaints(page);
    stages.tidesHeld=await page.evaluate(()=>window.__captureUiStartup());
    trace('controller released; top-tide data held');
    assert.equal(await page.locator('#topTideList .top-tide-item').count(),0,'Top-tide data must still be held independently');
    tides.release();
    await page.waitForFunction(()=>document.querySelector('#topTideList .top-tide-item')&&document.querySelector('#topTideList .top-tide-more-btn'));
    await page.waitForFunction(()=>{
      const bubble=document.getElementById('timelineBubble');
      const current=bubble?.querySelector('.timeline-bubble-current')?.textContent.trim();
      const stage=bubble?.querySelector('.timeline-bubble-stage')?.textContent.trim();
      return current&&stage&&current!=='--'&&stage!=='--'&&!bubble.querySelector('.timeline-bubble-startup-placeholder');
    });
    await page.waitForFunction(()=>{
      const loader=document.getElementById('nwSiteLoader'),style=loader&&getComputedStyle(loader);
      return (!loader||loader.hidden||style.display==='none'||style.visibility==='hidden'||Number(style.opacity)===0)&&
        Number(getComputedStyle(document.getElementById('app')).opacity)>0.999;
    },{},{timeout:90000});
    await twoPaints(page);
    stages.loaded=await page.evaluate(()=>window.__captureUiStartup());
    trace('data released; final paint captured');
    audit=await page.evaluate(()=>{window.__uiStartupAudit.stopped=true;return window.__uiStartupAudit;});
    const final=stages.loaded,failures=[];
    const check=(ok,label,detail)=>{if(!ok)failures.push({label,...(detail?{detail}:{})});};
    const near=(actual,expected,label)=>check(Number.isFinite(actual)&&Number.isFinite(expected)&&Math.abs(actual-expected)<=tolerance,label,{actual,expected});
    const rect=(actual,expected,label,keys=['x','y','width','height'])=>{
      check(!!expected,label+' remains present');
      if(actual&&expected)for(const key of keys)near(actual[key],expected[key],label+' '+key);
    };
    check(audit.samples.some(sample=>!sample.ready),'Probe captured a pre-controller frame');
    check(audit.samples.some(sample=>sample.ready),'Probe captured a post-controller frame');
    if(!mobile) {
      check(!!stages.controllerHeld.title,'Desktop title already has its final geometry beneath the splash');
      check(!!stages.controllerHeld.rail,'Desktop right controls already have geometry beneath the splash');
      check(final.title?.painted&&final.rail?.painted,'Finished title and right controls are actually revealed');
      for(const key of ['layers','tides','export','address','tour'])check(!!stages.controllerHeld.cards[key],key+' card already has its reserved startup geometry');
    }
    const expectedRows=['satelliteToggle','roadImpactsToggle','buildingsToggle','parcelsToggle','nsiStructuresToggle','roadsToggle','webcamsToggle'];
    const validBubbleSamples=[];
    for(const sample of audit.samples) {
      const prefix=`frame ${sample.frame}${sample.ready?' ready':' early'}`;
      if(mobile) {
        check(!sample.leftVisible,prefix+' closed mobile drawer does not flash');
        check(!sample.rail?.painted,prefix+' desktop rail does not flash on mobile');
      }
      for(const key of ['title','titleText','nav','timeline','play'])if(sample[key]?.painted)rect(sample[key],final[key],prefix+' '+key);
      if(!mobile)for(const key of ['left','rail'])if(sample[key]?.painted) {
        rect(sample[key],final[key],prefix+' '+key+' wrapper');
        near(parseFloat(sample[key].maxHeight),parseFloat(final[key]?.maxHeight),prefix+' '+key+' wrapper max-height');
      }
      if(sample.title?.painted) {
        check(JSON.stringify(sample.titleFont)===JSON.stringify(final.titleFont),prefix+' title uses final typography',{actual:sample.titleFont,expected:final.titleFont});
        check(sample.titleImages.every(image=>image.id!=='mapTitleLogo'||!!image.src),prefix+' no unused town logo slot changes the title size');
        check(JSON.stringify(sample.titleImages.map(image=>image.id))===JSON.stringify(final.titleImages.map(image=>image.id)),prefix+' title logo set does not change after paint');
        for(const image of sample.titleImages)rect(image,final.titleImages.find(target=>target.id===image.id),prefix+' title logo '+image.id);
      }
      for(const [key,value]of Object.entries(sample.navParts))if(value?.painted)rect(value,final.navParts[key],prefix+' nav '+key);
      for(const [key,card]of Object.entries(sample.cards)) {
        rect(card,final.cards[key],prefix+' right '+key);
        check(card.heading===final.cards[key]?.heading,prefix+' '+key+' heading does not rewrite',{actual:card.heading,expected:final.cards[key]?.heading});
      }
      for(const [key,control]of Object.entries(sample.controls)) {
        rect(control,final.controls[key],prefix+' right control '+key);
        check(control.text===final.controls[key]?.text,prefix+' '+key+' caption does not rewrite',{actual:control.text,expected:final.controls[key]?.text});
        check(control.placeholder===final.controls[key]?.placeholder,prefix+' '+key+' placeholder does not rewrite');
      }
      if(sample.layerRows.length) {
        check(JSON.stringify(sample.layerRows.map(row=>row.id))===JSON.stringify(expectedRows),prefix+' layer rows use their final order',{actual:sample.layerRows.map(row=>row.id)});
        for(const row of sample.layerRows) {
          const target=final.layerRows.find(value=>value.id===row.id);
          rect(row,target,prefix+' row '+row.id);
          check(row.label===target?.label,prefix+' '+row.id+' label does not rewrite',{actual:row.label,expected:target?.label});
        }
      }
      if(sample.play?.painted) {
        check(!!sample.playIcon,prefix+' play triangle is complete on the first visible frame');
        check(sample.playText==='',prefix+' no temporary text-glyph play icon',{actual:sample.playText});
        if(sample.playIcon)rect(sample.playIcon,final.playIcon,prefix+' play triangle');
      }
      if(sample.bubble?.painted) {
        validBubbleSamples.push(sample);
        check(sample.bubble.typed,prefix+' visible timestamp contains styled date and water-level spans',{text:sample.bubble.text});
        rect(sample.bubble,final.bubble,prefix+' timestamp',['x','y','height']);
        check(JSON.stringify(sample.bubble.currentFont)===JSON.stringify(final.bubble?.currentFont),prefix+' timestamp date has its final typography');
        check(JSON.stringify(sample.bubble.stageFont)===JSON.stringify(final.bubble?.stageFont),prefix+' timestamp level has its final typography');
        // Actual forecast values may legitimately change the pill width. The
        // same text must never resize just because a late UI controller ran.
        if(sample.bubble.text===final.bubble?.text)near(sample.bubble.width,final.bubble.width,prefix+' unchanged timestamp width');
      }
    }
    check(validBubbleSamples.length>0,'A real styled timestamp becomes visible');
    check(final.playIcon?.painted,'The finished play triangle is visible');
    check(errors.length===0,'No uncaught browser errors',{errors});
    if(failures.length)console.error(JSON.stringify({viewport:name,stages,samples:audit.samples,failures:failures.slice(0,80),totalFailures:failures.length,errors},null,2));
    assert.equal(failures.length,0,`${name}: ${failures.length} startup UI regressions; ${JSON.stringify(failures.slice(0,8))}`);
    console.log(`PASS full UI startup ${name}: ${audit.frames} frames/${audit.samples.length} changed paints; controller/data holds, title/right controls/nav/play/timestamp stable`);
  } catch(error) {
    if(!audit)console.error(JSON.stringify({viewport:name,stages,errors,audit:await page.evaluate(()=>window.__uiStartupAudit).catch(()=>null)},null,2));
    throw error;
  } finally {
    controller.release();tides.release();
    await navigation?.catch(()=>{});
    await context.close();
  }
}

try {
  const failures=[];
  const viewports=[
    {width:1440,height:1000}, {width:1512,height:945,dpr:2},
    {width:1200,height:800}, {width:1024,height:1000}, {width:1440,height:650},
    {width:390,height:844,mobile:true,dpr:2}, {width:320,height:568,mobile:true,dpr:2},
  ];
  const selected=process.env.NWW_UI_STARTUP_ONLY
    ? viewports.filter(viewport=>`${viewport.width}x${viewport.height}`===process.env.NWW_UI_STARTUP_ONLY)
    : viewports;
  assert.ok(selected.length,'NWW_UI_STARTUP_ONLY must name one of the configured viewport sizes');
  for(const viewport of selected) {
    try {await checkStartup(viewport);}
    catch(error) {failures.push({viewport,error:error.message});}
  }
  assert.deepEqual(failures,[],'Full UI startup regressions; see viewport diagnostics above');
} finally {await browser.close();}
