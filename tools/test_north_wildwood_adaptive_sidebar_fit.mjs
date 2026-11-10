// Real application geometry: fitting the container is insufficient when its
// primary controls still require scrolling inside that container.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const playwright=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const name=process.env.NWW_BROWSER||'chromium';
const browser=await playwright[name==='edge'?'chromium':name].launch({headless:true,
 ...(name==='edge'?{channel:'msedge'}:{}),
 ...(name==='chromium'&&process.env.NWW_CHROMIUM_CHANNEL?{channel:process.env.NWW_CHROMIUM_CHANNEL}:{}),
 ...(name==='chromium'&&process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{}),
 ...(['chromium','edge'].includes(name)?{args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']}:{})});
const retained=process.env.NWW_AUDIT_OUTPUT;
const output=retained||fs.mkdtempSync(path.join(os.tmpdir(),'nww-adaptive-fit-'));
fs.mkdirSync(output,{recursive:true});
const result={browser:name,version:browser.version(),checks:[],failures:[],states:[],pageErrors:[],passed:false};
const url=process.env.NWW_TEST_URL||'http://127.0.0.1:8892/index.html';
let testedCompactReturnSelector=false;
const check=(ok,label,details)=>{result.checks.push(label);if(!ok){result.failures.push({label,details});console.error('Adaptive sidebar failure:',label);}};
const desktopProfiles=[
 ['Mac reference',1512,945,true],['Windows125%',1536,864,true],['Laptop1366',1366,768,true],
 ['Windows150%',1280,720,true],['Scaled laptop125%',1093,614,true],
 ['Short laptop',1024,600,true],['Scaled laptop150%',1024,576,true]
];
async function settle(page){
 await page.waitForFunction(()=>{
  const ids=['leftPanel','rightRail','timelineDock','timelineBubble','mapTitleBadge','nwDefaultNavControl','legendDock'];
  const geometry=ids.map(id=>{const e=document.getElementById(id),r=e?.getBoundingClientRect();return r?[r.x,r.y,r.width,r.height,getComputedStyle(e).display]:null;});
  const current=JSON.stringify([innerWidth,innerHeight,document.body.dataset.unifiedLayout,geometry]);
  if(window.adaptiveGeometryLast===current)window.adaptiveGeometryStable=(window.adaptiveGeometryStable||0)+1;
  else{window.adaptiveGeometryLast=current;window.adaptiveGeometryStable=0;}
  return window.adaptiveGeometryStable>=4;
 },null,{timeout:15000,polling:'raf'});
}
async function inspect(page,label){
 const row=await page.evaluate(label=>{
  const box=element=>{if(!element||!element.getClientRects().length||getComputedStyle(element).display==='none')return null;const r=element.getBoundingClientRect();return Object.fromEntries(['left','top','right','bottom','width','height'].map(k=>[k,r[k]]));};
  const pane=id=>{const el=document.getElementById(id);return{box:box(el),clientHeight:el.clientHeight,scrollHeight:el.scrollHeight,clientWidth:el.clientWidth,scrollWidth:el.scrollWidth,inert:el.inert,zoom:getComputedStyle(el).zoom,cards:[...el.querySelectorAll(':scope > .panel-card,:scope > .rail-card,:scope > #legendDock')].filter(card=>box(card)).map(card=>({id:card.id||card.className,box:box(card),scrollHeight:card.scrollHeight,clientHeight:card.clientHeight,scrollWidth:card.scrollWidth,clientWidth:card.clientWidth,overflowY:getComputedStyle(card).overflowY,overflowX:getComputedStyle(card).overflowX}))};};
  return{label,width:innerWidth,height:innerHeight,dpr:devicePixelRatio,layout:document.body.dataset.unifiedLayout,density:document.body.dataset.sidebarDensity,fit:document.body.dataset.sidebarFit,body:document.body.className,
   rootOverflow:document.documentElement.scrollWidth>innerWidth+1||document.documentElement.scrollHeight>innerHeight+1,
   left:pane('leftPanel'),right:pane('rightRail'),timeline:box(document.getElementById('timelineDock')),bubble:box(document.getElementById('timelineBubble')),
   title:box(document.getElementById('mapTitleBadge')),nav:box(document.getElementById('nwDefaultNavControl')),
   legend:box(document.getElementById('legendDock')),key:box(document.getElementById('timelineFloodKey')),
   toggle:box(document.getElementById('mobileControlsToggle')),
   primary:[...document.querySelectorAll('#leftPanel button:not(.help-btn):not(.calendar-day):not(.calendar-nav-btn),#rightRail button:not(.help-btn):not(.calendar-day):not(.calendar-nav-btn),#leftPanel select,#rightRail select,#observedDateInput,#townAddressInput')].filter(el=>box(el)).map(el=>{const r=el.getBoundingClientRect();const parent=el.closest('#leftPanel,#rightRail').getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return{id:el.id,text:el.textContent.trim().slice(0,45),box:box(el),inPanel:r.left>=parent.left-1&&r.top>=parent.top-1&&r.right<=parent.right+1&&r.bottom<=parent.bottom+1,reachable:hit===el||el.contains(hit),font:parseFloat(getComputedStyle(el).fontSize)*(el.offsetHeight?r.height/el.offsetHeight:1)};})};
 },label);
 result.states.push(row);return row;
}
const contained=(r,row)=>!!r&&r.width>0&&r.height>0&&r.left>=-1&&r.top>=-1&&r.right<=row.width+1&&r.bottom<=row.height+1;
const overlaps=(a,b)=>!!a&&!!b&&Math.min(a.right,b.right)-Math.max(a.left,b.left)>1&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1;
async function checkRailOrder(page,parent,label){
 const cards=await page.locator(`${parent} > :is(.layers-card,#townAddressCard,#downloadCard,.top-tides-card)`).evaluateAll(nodes=>nodes.map(node=>{
  const rect=node.getBoundingClientRect();
  return {name:node.id||(node.classList.contains('layers-card')?'layers':'topFloods'),top:rect.top,bottom:rect.bottom,height:rect.height};
 }));
 check(cards.map(card=>card.name).join(',')==='layers,townAddressCard,downloadCard,topFloods'&&
  cards.every((card,index)=>card.height>0&&(!index||card.top>=cards[index-1].bottom-1)),label+' layers, address, export, and Top 10 follow the same visual and keyboard order',cards);
}
async function openDrawer(page){if(!await page.locator('body').evaluate(e=>e.classList.contains('mobile-controls-open')))await page.locator('#mobileControlsToggle').click({noWaitAfter:true});await page.locator('#nwwMobileControlHeader').waitFor({state:'visible'});}
async function closeDrawer(page){if(await page.locator('body').evaluate(e=>e.classList.contains('mobile-controls-open'))){const close=page.locator('#mobileControlsClose');if(await close.isVisible())await close.click({noWaitAfter:true});else{check(false,'Compact drawer keeps a visible close button');await page.keyboard.press('Escape');}}}
async function compactReadability(page,label){
 const visual=await page.evaluate(()=>{
  const visibleText=root=>{const rows=[],walk=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let node;
   while(node=walk.nextNode()){
    const parent=node.parentElement,style=getComputedStyle(parent);
    if(!node.textContent.trim()||parent.closest('.sr-only,.visually-hidden,[hidden],[aria-hidden="true"]')||style.visibility==='hidden'||parseFloat(style.fontSize)<1)continue;
    const range=document.createRange();range.selectNodeContents(node);
    for(const r of range.getClientRects())if(r.width>0&&r.height>0)rows.push({text:node.textContent.trim(),left:r.left,top:r.top,right:r.right,bottom:r.bottom});
   }return rows;};
  const box=e=>{const r=e.getBoundingClientRect();return{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
  const control=document.getElementById('mobileControlsToggle'),key=document.getElementById('legendDock');
  const pseudoText=element=>['::before','::after'].map(p=>{const s=getComputedStyle(element,p);return{content:s.content,font:parseFloat(s.fontSize),display:s.display,visibility:s.visibility};});
  const pseudos=pseudoText(control);
  const svg=[...control.querySelectorAll('svg')].some(svg=>{const r=svg.getBoundingClientRect();return r.width>4&&r.height>4&&getComputedStyle(svg).visibility!=='hidden'&&!!svg.querySelector('path,rect,line,circle,polygon,polyline,use');});
  const fullKey=[...key.querySelectorAll('#legendBody .depth-legend-labels,#legendBody .legend-labels')].some(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden');
  const day=[...document.querySelectorAll('#timelineDayTabs .timeline-day.active,#timelineDayTabs .timeline-day[aria-current="date"]')].find(e=>e.getClientRects().length);
  const track=document.querySelector('#timelineDock .timeline-trackRow');
  return{controlTexts:visibleText(control),pseudos,svg,key:{box:box(key),texts:visibleText(key),pseudos:pseudoText(key),fullKey},day:day?{box:box(day),texts:visibleText(day),track:track&&box(track)}:null};
 });
 const visiblePseudo=p=>p.display!=='none'&&p.visibility!=='hidden'&&p.font>=10&&p.content&&!['none','normal','""',"''"].includes(p.content);
 const token=visual.controlTexts.length||visual.svg||visual.pseudos.some(visiblePseudo);
 check(token,label+' controls button has a visible label or icon',visual);
 const textFits=(texts,box)=>texts.every(r=>r.left>=box.left-1&&r.top>=box.top-1&&r.right<=box.right+1&&r.bottom<=box.bottom+1);
 check((visual.key.texts.length>0||visual.key.pseudos.some(visiblePseudo))&&!visual.key.fullKey&&textFits(visual.key.texts,visual.key.box),label+' collapsed key shows a bounded summary without full-key overlap',visual.key);
 check(visual.day&&visual.day.texts.length>0&&textFits(visual.day.texts,visual.day.box)&&visual.day.texts.every(text=>!overlaps(text,visual.day.track)),label+' active day text stays readable inside the timeline',visual.day);
 const legend=page.locator('#legendDock');await legend.focus();await page.keyboard.press('Enter');
 await page.waitForFunction(()=>document.getElementById('legendDock')?.getAttribute('aria-expanded')==='true');await settle(page);
 const opened=await page.evaluate(()=>{const el=document.getElementById('legendDock'),r=el.getBoundingClientRect(),body=document.getElementById('legendBody');return{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight,bodyVisible:!!body&&body.getClientRects().length>0&&getComputedStyle(body).visibility!=='hidden',scrollWidth:el.scrollWidth,clientWidth:el.clientWidth};});
 check(opened.bodyVisible&&opened.left>=-1&&opened.top>=-1&&opened.right<=opened.width+1&&opened.bottom<=opened.height+1&&opened.scrollWidth<=opened.clientWidth+2,label+' opened key reveals its full legend within the viewport',opened);
 await legend.focus();await page.keyboard.press('Enter');await settle(page);
}
async function testCompact(page,label){
 await compactReadability(page,label);
 await openDrawer(page);await settle(page);
 let row=await inspect(page,label+' drawer');check(contained(row.left.box,row),label+' drawer stays in the viewport',row);
 check(!row.left.inert,label+' open drawer is interactive',row);
 for(const [tab,control]of [['Flood data','#forecastDataBtn'],['Map layers','#satelliteToggle'],['Tools','#townAddressClearBtn']]){
  const tabControl=page.getByRole('tab',{name:tab,exact:true});
  await tabControl.click({noWaitAfter:true});await settle(page);
  if(tab==='Map layers')await checkRailOrder(page,'#mobileRailMount',label);
  const tabBox=await tabControl.boundingBox();
  check(tabBox?.height>=43.5,label+' '+tab+' tab keeps a44px target',tabBox);
  await page.locator(control).scrollIntoViewIfNeeded();await settle(page);
  const r=await page.locator(control).boundingBox();
  const hit=await page.locator(control).evaluate(el=>{const r=el.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return hit===el||el.contains(hit);});
  check(hit&&r?.width>0&&r?.height>0,label+' '+tab+' controls can be reached',r);
 }
 if(retained&&label==='Small desktop')await page.screenshot({path:path.join(output,'compact-1200x500-tools-open.png')});
 await closeDrawer(page);await settle(page);
 check(!await page.locator('body').evaluate(e=>e.classList.contains('mobile-controls-open')),label+' drawer closes');
}
async function geometryChecks(page,label,mustKeepDesktop){
 await settle(page);const row=await inspect(page,label);
 check(!row.rootOverflow,label+' page does not extend beyond the viewport',row);
 for(const key of ['timeline','bubble','title','nav'])check(contained(row[key],row),label+' '+key+' stays visible',row);
 check(!overlaps(row.title,row.nav),label+' title and navigation do not overlap',row);
 check(!overlaps(row.nav,row.timeline),label+' navigation and timeline do not overlap',row);
 check(!!row.key,label+' flood category key remains visible',row);
 if(mustKeepDesktop)check(row.layout==='desktop',label+' preserves side-by-side controls',row);
 if(/^(Small desktop|Short wide|Phone|Zoom-equivalent|Short phone|Touch laptop)/.test(label))check(row.layout==='mobile',label+' uses a readable compact fallback',row);
 if(row.layout==='desktop'){
  await checkRailOrder(page,'#rightRail',label);
  for(const side of ['left','right']){
   const pane=row[side];check(contained(pane.box,row),label+' '+side+' sidebar is fully on screen',row);
   check(pane.scrollHeight<=pane.clientHeight+2,label+' '+side+' primary controls fit without scrolling',row);
   check(pane.scrollWidth<=pane.clientWidth+2,label+' '+side+' controls do not overflow horizontally',row);
   check(!pane.inert,label+' '+side+' sidebar remains interactive',row);
   for(const card of pane.cards)check((card.overflowY==='visible'||card.scrollHeight<=card.clientHeight+2)&&(card.overflowX==='visible'||card.scrollWidth<=card.clientWidth+2),label+' '+side+' '+card.id+' does not clip its contents',card);
   check(!overlaps(pane.box,row.timeline),label+' '+side+' sidebar clears the timeline',row);
   check(!overlaps(pane.box,row.bubble),label+' '+side+' sidebar clears the timestamp',row);
  }
  check(!overlaps(row.left.box,row.right.box),label+' sidebars leave a map lane',row);
  for(const control of row.primary){
   check(control.inPanel&&contained(control.box,row),label+' '+(control.id||control.text)+' stays fully visible in its sidebar',control);
   check(control.reachable,label+' '+(control.id||control.text)+' can receive a pointer click',control);
   check(control.font>=11.8,label+' '+(control.id||control.text)+' keeps readable12px primary text',control);
   check(control.box.height>=23.5,label+' '+(control.id||control.text)+' keeps a24px desktop target',control);
  }
  if(label.startsWith('Mac reference')){
   check(Math.abs(row.left.box.width-300)<=1&&Math.abs(row.right.box.width-280)<=1,label+' retains established sidebar widths',row);
  }
 }else{
  check(!!row.toggle,label+' provides the compact controls button',row);
  await testCompact(page,label);
 }
}
async function start(context){
 const page=await context.newPage();page.setDefaultTimeout(30000);page.on('pageerror',e=>result.pageErrors.push(e.message));
 await page.goto(url,{waitUntil:'domcontentloaded',timeout:90000});
 await page.waitForFunction(()=>document.body.classList.contains('nw-app-ready')&&!document.body.classList.contains('nw-app-loading'),null,{timeout:90000});
 await page.evaluate(()=>document.fonts.ready);
 await page.waitForFunction(()=>{const loader=document.getElementById('nwSiteLoader');return!loader||loader.hidden||getComputedStyle(loader).display==='none'||getComputedStyle(loader).pointerEvents==='none';},null,{timeout:15000});
 if(!result.assets)result.assets=await page.locator('script[src],link[rel=stylesheet]').evaluateAll(nodes=>nodes.map(el=>el.getAttribute('src')||el.getAttribute('href')));
 return page;
}
try{
 const context=await browser.newContext({viewport:{width:1512,height:945},timezoneId:'America/New_York'});
 const page=await start(context);
 for(const mode of ['forecast','return-interval','observed']){
  await page.setViewportSize({width:1512,height:945});await settle(page);
  const id={forecast:'#forecastDataBtn','return-interval':'#returnIntervalDataBtn',observed:'#observedDataBtn'}[mode];
  await page.locator(id).click({noWaitAfter:true});
  await page.waitForFunction(mode=>currentDataMode===mode&&currentSeriesHours.length>0&&floodFrameState==='ready',mode,{timeout:90000});
  for(const [label,width,height,mustKeepDesktop]of desktopProfiles){
   await page.setViewportSize({width,height});await geometryChecks(page,label+' '+mode,mustKeepDesktop);
   const returnSelect=page.locator('#nwwCompactReturnPeriod');
   if(mode==='return-interval'&&!testedCompactReturnSelector&&await returnSelect.isVisible()){
    const choices=await returnSelect.locator('option').evaluateAll(nodes=>nodes.map(node=>Number(node.value)));
    check(JSON.stringify(choices)===JSON.stringify([1,2,5,10,20,50,100,200,500,1000,2000,5000,10000]),'Tight modeled controls preserve all13 actual scenarios',choices);
    await returnSelect.selectOption('20');
    await page.waitForFunction(()=>currentReturnIntervalYears===20&&floodFrameState==='ready',null,{timeout:90000});
    check(await returnSelect.inputValue()==='20','Compact modeled selector activates the actual20-year scenario');
    await geometryChecks(page,label+'20-year modeled selection',mustKeepDesktop);
    await returnSelect.selectOption('10');
    await page.waitForFunction(()=>currentReturnIntervalYears===10&&floodFrameState==='ready',null,{timeout:90000});
    testedCompactReturnSelector=true;
   }
   if(width===1024&&height===576&&mode!=='observed'){
    await page.locator('#dynamicModeBtn').click({noWaitAfter:true});
    await page.waitForFunction(()=>currentOverlayMode==='dynamic'&&floodFrameState==='ready',null,{timeout:90000});
    await geometryChecks(page,label+' '+mode+' Flood stages',true);
    const slider=page.locator('#hourSlider'),last=Number(await slider.getAttribute('max'));
    if(last>0){
     await slider.focus();await page.keyboard.press('End');
     await page.waitForFunction(last=>currentHourIndex===last&&floodFrameState==='ready'&&!pendingTimelineSelection&&!requestedTimelineSelection,last,{timeout:90000});
     await geometryChecks(page,label+' '+mode+' final timestamp',true);
    }
    await page.locator('#depthModeBtn').click({noWaitAfter:true});
    await page.waitForFunction(()=>currentOverlayMode==='depth'&&floodFrameState==='ready',null,{timeout:90000});
    await geometryChecks(page,label+' '+mode+' restored Depth',true);
   }
   if(retained&&['Mac reference','Windows125%','Windows150%','Scaled laptop125%','Scaled laptop150%'].includes(label))await page.screenshot({path:path.join(output,`${mode}-${width}x${height}.png`)});
  }
 }
 await context.close();
 // DPR and CSS viewport are distinct. These represent the logical work area
 // of1920x1080 Windows displays at125%/150%, not a fake browser zoom transform.
 for(const [label,width,height,dpr]of [['DPR125%',1536,864,1.25],['DPR150%',1280,720,1.5]]){
  const context=await browser.newContext({viewport:{width,height},deviceScaleFactor:dpr,timezoneId:'America/New_York'});
  const page=await start(context);await geometryChecks(page,label,true);await context.close();
 }
 for(const [label,width,height,touch=true]of [['Small desktop',1200,500,false],['Short wide',1200,550,false],['Touch laptop',1024,768],['Phone',390,844],['Zoom-equivalent',768,432],['Short phone',375,400]]){
  const context=await browser.newContext({viewport:{width,height},hasTouch:touch,...(name==='firefox'?{}:{isMobile:touch}),timezoneId:'America/New_York'});
  const page=await start(context);await geometryChecks(page,label,false);if(retained&&label==='Small desktop')await page.screenshot({path:path.join(output,'compact-1200x500.png')});await context.close();
 }
 check(testedCompactReturnSelector,'Tight modeled control was exercised at a laptop viewport');
 check(result.pageErrors.length===0,'No uncaught page errors',result.pageErrors);
 assert.equal(result.failures.length,0,`${result.failures.length} sidebar checks failed: ${result.failures.slice(0,8).map(f=>f.label).join('; ')}`);result.passed=true;
}catch(error){result.failure=error.stack;process.exitCode=1;}
finally{await browser.close();fs.writeFileSync(path.join(output,`${name}-adaptive-sidebar-fit.json`),JSON.stringify(result,null,2));console.log(JSON.stringify({browser:name,passed:result.passed,checks:result.checks.length,failures:result.failures.map(f=>f.label),failure:result.failure,output},null,2));if(!retained)fs.rmSync(output,{recursive:true,force:true});}
