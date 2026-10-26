/* Shared FloodMapper presentation. Each town retains its own model and data handlers. */
(() => {
 'use strict';
 const VERSION='20261021.1',body=document.body,root=document.documentElement;
 const panel=document.getElementById('leftPanel'),rail=document.getElementById('rightRail'),timeline=document.getElementById('timelineDock'),app=document.getElementById('app');
 if(!panel||!rail||!timeline||body.dataset.unifiedUiReady===VERSION)return;
 body.dataset.unifiedUiReady=VERSION;body.dataset.floodmapperUnified=VERSION;body.dataset.countyViewport=VERSION;
 const mobile=matchMedia('(max-width:900px), (max-height:560px) and (pointer:coarse), (max-width:1366px) and (any-pointer:coarse)');
 const owned=new WeakMap(),bound=new WeakSet();
 const layerOrder=[['satelliteToggle','Satellite'],['roadImpactsToggle','Road Impacts'],['buildingsToggle','Buildings'],['parcelsToggle','Parcels'],['nsiStructuresToggle','Structural Impacts'],['roadsToggle','Road names'],['webcamsToggle','Cameras']];
 const groups={forecast:'.data-source-card,#forecastScenarioCard,#returnIntervalCard,#timelineIntervalCard,#calendarCard,.mobile-top-tides-card,.top-tides-card',map:'.overlay-card,.datum-card,.opacity-card,.layers-card',tools:'#townAddressCard,#downloadCard,#mapperTutorialBtn,#avalonTourBtn'};
 const safeProbe=document.createElement('div');safeProbe.id='unifiedSafeAreaProbe';safeProbe.setAttribute('aria-hidden','true');safeProbe.style.cssText='position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';body.append(safeProbe);
 let chosenSection=panel.dataset.nwwSection||'forecast';
 let frame=0,layoutPasses=0,drawerOpener=null,drawerFocusGeneration=0;
 const visible=e=>!!e&&e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden'&&getComputedStyle(e).display!=='none';
 function set(e,key,value){if(e&&e.style.getPropertyValue(key)!==value)e.style.setProperty(key,value,'important');else if(e&&e.style.getPropertyPriority(key)!=='important')e.style.setProperty(key,value,'important');}
 function saveStyle(e){if(e)owned.set(e,e.getAttribute('style'));}
 function text(e,value){if(e&&e.textContent!==value)e.textContent=value;}
 function attr(e,key,value){if(e&&e.getAttribute(key)!==value)e.setAttribute(key,value);}
 function flag(e,name,value){if(e&&e.classList.contains(name)!==!!value)e.classList.toggle(name,!!value);}
 function leaflet(){return typeof map!=='undefined'?map:null;}
 function standalone(){return window.COUNTY_STANDALONE_3D?.getMap?.()||null;}
 function selectSection(group,focus=false){
  if(!Object.hasOwn(groups,group))group='forecast';chosenSection=group;
  if(panel.dataset.nwwSection!==group)panel.dataset.nwwSection=group;
  for(const tab of panel.querySelectorAll('#nwwMobileControlHeader [role="tab"]')){const on=tab.dataset.group===group;attr(tab,'aria-selected',String(on));tab.tabIndex=on?0:-1;if(on&&focus)tab.focus({preventScroll:true});}
 }
 function ensureControlButtons(){
  for(const [id,label]of [['mobileControlsToggle','Controls'],['mobileControlsClose','×']]){const copies=[...document.querySelectorAll('[id="'+id+'"]')];let button=copies.shift();for(const duplicate of copies)duplicate.remove();if(!button){button=document.createElement('button');button.id=id;button.type='button';button.textContent=label;(id==='mobileControlsClose'?panel:body).append(button);}attr(button,'aria-label',id==='mobileControlsClose'?'Close controls':'Open map controls');if(id==='mobileControlsToggle'){attr(button,'aria-controls','leftPanel');attr(button,'aria-expanded',String(body.classList.contains('mobile-controls-open')));}}
 }
 function ensureHeader(){
  const headers=[...document.querySelectorAll('[id="nwwMobileControlHeader"]')];let header=headers.shift();
  for(const duplicate of headers)duplicate.remove();
  if(!header){header=document.createElement('div');header.id='nwwMobileControlHeader';header.innerHTML='<div class="nww-drawer-heading"><h2 id="nwwControlsTitle">Map controls</h2><p></p></div><div class="nww-control-tabs" role="tablist" aria-label="Control sections"><button type="button" role="tab" data-group="forecast">Flood data</button><button type="button" role="tab" data-group="map">Map layers</button><button type="button" role="tab" data-group="tools">Tools</button></div>';panel.prepend(header);}
  if(header.parentElement!==panel)panel.prepend(header);
  text(header.querySelector('p'),document.getElementById('mapTitleText')?.textContent||'');
  if(!bound.has(header)){
   const tabs=[...header.querySelectorAll('[role="tab"]')];
   tabs.forEach((tab,i)=>{tab.addEventListener('click',event=>{event.stopImmediatePropagation();selectSection(tab.dataset.group);schedule();},true);tab.addEventListener('keydown',event=>{const next=event.key==='ArrowRight'?(i+1)%tabs.length:event.key==='ArrowLeft'?(i+tabs.length-1)%tabs.length:event.key==='Home'?0:event.key==='End'?tabs.length-1:null;if(next!==null){event.preventDefault();event.stopImmediatePropagation();selectSection(tabs[next].dataset.group,true);schedule();}},true);});bound.add(header);
  }
  selectSection(chosenSection);
 }
 function ensureDays(){
  const days=document.getElementById('timelineDayTabs');if(!days)return;
  const buttons=[...days.querySelectorAll('.timeline-day')],active=Math.max(0,buttons.findIndex(e=>e.classList.contains('active')||e.getAttribute('aria-current')==='date'));
  for(const [id,delta,label]of [['timelinePreviousDay',-1,'Previous'],['timelineNextDay',1,'Next']]){
   const copies=[...document.querySelectorAll('[id="'+id+'"]')];let button=copies.shift();for(const duplicate of copies)duplicate.remove();
   if(!button){button=document.createElement('button');button.id=id;button.className='timeline-day-arrow';button.type='button';days.parentElement.insertBefore(button,delta<0?days:days.nextSibling);}
   const neighbor=buttons[active+delta];button.disabled=!neighbor;
   const labelText=neighbor?.textContent?.trim()||label;attr(button,'aria-label',neighbor?label+' day: '+labelText:'No '+(delta<0?'earlier':'later')+' day available');
   const span=button.querySelector('.neighbor-day');if(span)text(span,labelText);else text(button,labelText);
   if(!bound.has(button)){button.addEventListener('click',event=>{event.preventDefault();event.stopImmediatePropagation();const current=[...days.querySelectorAll('.timeline-day')],i=current.findIndex(e=>e.classList.contains('active')||e.getAttribute('aria-current')==='date');current[Math.max(0,i)+delta]?.click();},true);bound.add(button);}
  }
 }
 function ensureLayers(){
  const card=document.querySelector('.layers-card');if(!card)return;flag(card,'nww-layers-card',true);
  let list=card.querySelector('.layer-list');if(!list){list=document.createElement('div');list.className='layer-list';card.append(list);}
  const desired=[];
  for(const [id,label]of layerOrder){
   // Feature modules own capability, state, loading, errors and activation.
   // Presentation never fabricates switches or disables a native handler.
   const toggle=document.getElementById(id),row=toggle?.closest('.layer-item');if(!row)continue;
   text(row.querySelector('.layer-name'),label);attr(toggle,'aria-label','Show '+label.toLowerCase());
   const note=row.querySelector('.unified-layer-note');
   if(note){if(toggle.getAttribute('aria-describedby')===note.id)toggle.removeAttribute('aria-describedby');note.remove();toggle.removeAttribute('aria-disabled');row.removeAttribute('title');}
   flag(row,'ui-unavailable',false);flag(row,'ui-locked',false);desired.push(row);
  }
  for(let i=0;i<desired.length;i++)if(list.children[i]!==desired[i])list.insertBefore(desired[i],list.children[i]||null);
  const hint=document.getElementById('nativeRoadNamesHint');if(hint&&!hint.hidden)hint.hidden=true;
 }
 function setDrawer(open,returnFocus=true){
  const generation=++drawerFocusGeneration;
  if(!mobile.matches)open=false;
  if(open){drawerOpener=document.activeElement;body.classList.remove('mobile-legend-open');}
  flag(body,'mobile-controls-open',open);attr(document.getElementById('mobileControlsToggle'),'aria-expanded',String(open));
  syncDrawer();schedule();
  if(open)panel.querySelector('#nwwMobileControlHeader [aria-selected="true"]')?.focus({preventScroll:true});
  else if(returnFocus){
   const closingFocus=document.activeElement;
   requestAnimationFrame(()=>{
    if(generation!==drawerFocusGeneration||body.classList.contains('mobile-controls-open')||document.activeElement!==closingFocus)return;
    if([...document.querySelectorAll('[aria-modal="true"],dialog[open]')].some(e=>e!==panel&&visible(e)))return;
    (drawerOpener?.isConnected?drawerOpener:document.getElementById('mobileControlsToggle'))?.focus({preventScroll:true});
   });
  }
 }
 function syncDrawer(){
  const open=mobile.matches&&body.classList.contains('mobile-controls-open');
  const childModal=[...document.querySelectorAll('[aria-modal="true"],dialog[open]')].some(e=>e!==panel&&!panel.contains(e)&&visible(e));
  panel.inert=mobile.matches&&(!open||childModal);
  if(open){attr(panel,'role','dialog');if(childModal)panel.removeAttribute('aria-modal');else attr(panel,'aria-modal','true');attr(panel,'aria-label','Map controls');}
  else {panel.removeAttribute('role');panel.removeAttribute('aria-modal');attr(panel,'aria-label','Flood map controls');}
  for(const id of ['map','map3d','countyStandalone3d','timelineDock']){const e=document.getElementById(id);if(e)e.inert=open;}
  attr(document.getElementById('mobileControlsToggle'),'aria-expanded',String(open));
 }
 function normalize(){
  ensureControlButtons();ensureHeader();ensureDays();ensureLayers();
  const title=panel.querySelector('.data-source-card h2');text(title,'Flood Data');
  const downloadCard=document.getElementById('downloadCard');if(downloadCard?.getAttribute('role')==='button'){downloadCard.removeAttribute('role');downloadCard.removeAttribute('tabindex');downloadCard.removeAttribute('aria-label');}
  for(const [id,label]of [['forecastDataBtn','Forecast'],['observedDataBtn','Past'],['returnIntervalDataBtn','Modeled Floods'],['forecastLowBtn','Lower end'],['forecastMeanBtn','Mean'],['forecastHighBtn','Upper end'],['openDownloadModalBtn','Export Map']])text(document.getElementById(id),label);
  text(panel.querySelector('#forecastScenarioCard h2'),'Forecast range');
  for(const id of ['mapperTutorialBtn','avalonTourBtn'])text(document.getElementById(id),'Take the FloodMapper tour');
  for(const button of document.querySelectorAll('.top-tide-more-btn')){if(button.dataset.unifiedMore!=='true'){const plus=document.createElement('span');plus.className='unified-more-plus';plus.textContent='+';const label=document.createElement('span');label.textContent='Show more';button.replaceChildren(plus,label);button.dataset.unifiedMore='true';}}
  const opacity=panel.querySelector('.opacity-card .control-row'),opacityText=document.getElementById('opacityText');if(opacity&&opacityText&&opacityText.parentElement!==opacity)opacity.append(opacityText);
  attr(document.getElementById('opacitySlider'),'aria-label','Flood overlay opacity');attr(document.getElementById('hourSlider'),'aria-label',body.classList.contains('observed-mode')?'Observed flood time':body.classList.contains('return-interval-mode')?'Modeled flood time':'Flood forecast time');
  Object.entries(groups).forEach(([group,selector])=>document.querySelectorAll(selector).forEach(e=>{if(e.dataset.nwwGroup!==group)e.dataset.nwwGroup=group;}));
  for(const item of timeline.querySelectorAll('.timeline-key-item'))for(const node of [...item.childNodes])if(node.nodeType===Node.TEXT_NODE&&node.textContent.trim()){const span=document.createElement('span');span.className='timeline-key-label';span.textContent=node.textContent.trim().replace(/^No flooding$/i,'No Flooding').replace(/^(Minor|Moderate|Major) flooding$/i,'$1');node.replaceWith(span);}
  const bubble=document.getElementById('timelineBubble');if(bubble&&bubble.style.getPropertyValue('translate')!=='none')set(bubble,'translate','none');
  const legend=document.getElementById('legendDock');if(legend){attr(legend,'aria-label','Flood map legend');if(mobile.matches){attr(legend,'role','button');legend.tabIndex=0;attr(legend,'aria-expanded',String(body.classList.contains('mobile-legend-open')));}else{legend.removeAttribute('role');legend.removeAttribute('tabindex');legend.removeAttribute('aria-expanded');}}
 }
 function reparent(){
  const compact=mobile.matches,legend=document.getElementById('legendDock');let mount=document.getElementById('mobileRailMount');
  if(compact){
   if(panel.parentElement!==body)body.append(panel);if(!mount){mount=document.createElement('div');mount.id='mobileRailMount';panel.append(mount);}
   for(const card of [...rail.children])mount.append(card);if(legend&&legend.parentElement!==body)body.append(legend);
  }else{
   if(app&&panel.parentElement!==app)app.insertBefore(panel,app.firstChild);
   if(mount)for(const card of [...mount.children])rail.append(card);if(legend&&legend.parentElement!==panel)panel.append(legend);
  }
  flag(root,'county-compact',compact);syncDrawer();
 }
 function layout(){
  frame=0;normalize();reparent();layoutPasses++;
  const compact=mobile.matches;
  for(const pane of [panel,rail]){set(pane,'zoom','1');set(pane,'transform','none');set(pane,'min-width','0px');}
  if(compact){
   const vv=window.visualViewport,viewport=vv&&Math.abs((vv.scale||1)-1)<.01?vv:{height:innerHeight,width:innerWidth,offsetTop:0,offsetLeft:0};
   const computed=getComputedStyle(safeProbe),safe={top:parseFloat(computed.paddingTop)||0,right:parseFloat(computed.paddingRight)||0,bottom:parseFloat(computed.paddingBottom)||0,left:parseFloat(computed.paddingLeft)||0};
   const top=Math.max(0,viewport.offsetTop||0)+safe.top+8,left=Math.max(0,viewport.offsetLeft||0)+safe.left+8,right=Math.max(0,innerWidth-(viewport.offsetLeft||0)-(viewport.width||innerWidth))+safe.right+8,bottom=Math.max(0,innerHeight-(viewport.offsetTop||0)-(viewport.height||innerHeight))+safe.bottom+8;
   for(const [key,value]of Object.entries({top,left,right,bottom,height:Math.max(1,(viewport.height||innerHeight)-16)})){const valueText=value.toFixed(2)+'px';if(body.style.getPropertyValue('--cm-'+key)!==valueText)body.style.setProperty('--cm-'+key,valueText);}
   for(const [key,value]of Object.entries({position:'fixed',left:left+'px',right:right+'px',top:top+'px',bottom:bottom+'px',width:'auto','max-width':'none',height:'auto','max-height':'none','min-height':'0px','overflow-y':'auto','overflow-x':'hidden'}))set(panel,key,value);
   set(panel,'display',body.classList.contains('mobile-controls-open')?'flex':'none');set(rail,'display','none');set(timeline,'bottom',bottom+'px');set(timeline,'left',left+'px');set(timeline,'right',right+'px');set(timeline,'height','180px');set(timeline,'min-height','180px');set(timeline,'max-height','180px');
   for(const e of [document.getElementById('nwDefaultNavControl'),document.getElementById('countyStandaloneView')])if(e)for(const key of ['left','right','top'])e.style.removeProperty(key);
   const title=document.getElementById('mapTitleBadge');for(const key of ['left','right','top','max-width','transform'])title?.style.removeProperty(key);
   const focused=document.activeElement;if(body.classList.contains('mobile-controls-open')&&focused?.matches('input,textarea,select')&&panel.contains(focused)){const r=focused.getBoundingClientRect(),p=panel.getBoundingClientRect();if(r.bottom>p.bottom-20||r.top<p.top+130)requestAnimationFrame(()=>focused.scrollIntoView({block:'nearest',inline:'nearest'}));}
  }else{
   for(const key of ['top','left','right','bottom','height'])body.style.removeProperty('--cm-'+key);
   set(timeline,'position','fixed');set(timeline,'left','16px');set(timeline,'right','16px');set(timeline,'bottom','16px');set(timeline,'height','112px');set(timeline,'min-height','112px');set(timeline,'max-height','112px');
   const bubbleRect=document.getElementById('timelineBubble')?.getBoundingClientRect();
   const controlsBottom=Math.min(timeline.getBoundingClientRect().top-28,bubbleRect?.height?bubbleRect.top-12:Infinity);
   const available=Math.max(100,controlsBottom-16);
   for(const [pane,width]of [[panel,300],[rail,280]])for(const [key,value]of Object.entries({position:'absolute',top:'16px',bottom:'auto',left:pane===panel?'16px':'auto',right:pane===rail?'16px':'auto',width:width+'px','max-width':width+'px',height:'auto','max-height':available+'px','min-height':'0px','overflow-y':'auto','overflow-x':'hidden',display:'flex'}))set(pane,key,value);
   const navWidth=document.getElementById('nwDefaultNavControl')?.getBoundingClientRect().width||document.getElementById('countyStandaloneView')?.getBoundingClientRect().width||48;
   const title=document.getElementById('mapTitleBadge'),l=panel.getBoundingClientRect().right+20,r=rail.getBoundingClientRect().left-navWidth-28;if(title){set(title,'left',((l+r)/2)+'px');set(title,'right','auto');set(title,'top','16px');set(title,'max-width',Math.max(100,r-l)+'px');set(title,'transform','translateX(-50%)');}
   const nav=document.getElementById('nwDefaultNavControl'),standaloneButton=document.getElementById('countyStandaloneView');const navRight=innerWidth-rail.getBoundingClientRect().left+14;
   if(nav){set(nav,'right',navRight+'px');set(nav,'left','auto');set(nav,'top','16px');}
   if(standaloneButton)set(standaloneButton,'right',navRight+'px');body.style.setProperty('--county-nav-right',navRight+'px');
  }
  for(const e of [panel,rail,timeline,document.getElementById('mapTitleBadge')])saveStyle(e);
  body.dataset.unifiedLayoutPasses=String(layoutPasses);body.dataset.unifiedLayout=compact?'mobile':'desktop';
 }
 function schedule(){if(!frame)frame=requestAnimationFrame(layout);}
 document.addEventListener('click',event=>{
  if(event.target.closest('#mobileControlsToggle')){if(!mobile.matches)return;event.preventDefault();event.stopImmediatePropagation();setDrawer(!body.classList.contains('mobile-controls-open'));}
  else if(event.target.closest('#mobileControlsClose')){event.preventDefault();event.stopImmediatePropagation();setDrawer(false);}
  else if(mobile.matches&&event.target.closest('#legendDock')&&!event.target.closest('button')){event.preventDefault();event.stopImmediatePropagation();flag(body,'mobile-legend-open',!body.classList.contains('mobile-legend-open'));schedule();}
 },true);
 document.addEventListener('keydown',event=>{
  if(!mobile.matches)return;
  if(event.key==='Escape'&&body.classList.contains('mobile-legend-open')){flag(body,'mobile-legend-open',false);document.getElementById('legendDock')?.focus();schedule();return;}
  const otherModal=[...document.querySelectorAll('[aria-modal="true"],dialog[open]')].some(e=>e!==panel&&visible(e));if(otherModal)return;
  if(body.classList.contains('mobile-controls-open')){
   if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();setDrawer(false);}
   else if(event.key==='Tab'){const items=[...panel.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),a[href],[tabindex]')].filter(e=>visible(e)&&e.tabIndex>=0&&!e.closest('[inert]')),first=items[0],last=items.at(-1);if(first&&(!panel.contains(document.activeElement)||(event.shiftKey&&document.activeElement===first)||(!event.shiftKey&&document.activeElement===last))){event.preventDefault();(event.shiftKey?last:first).focus();}}
  }else if(event.target.closest('#legendDock')&&!event.target.closest('button')&&(event.key==='Enter'||event.key===' ')){event.preventDefault();event.stopImmediatePropagation();flag(body,'mobile-legend-open',!body.classList.contains('mobile-legend-open'));schedule();}
 },true);
 document.addEventListener('nww:reveal-control',event=>{if(mobile.matches&&typeof event.detail==='string'){const element=document.querySelector(event.detail);if(element)selectSection(element.closest('[data-nww-group]')?.dataset.nwwGroup||'forecast');schedule();}});
 const observer=new MutationObserver(records=>{if(records.some(m=>m.type!=='attributes'||m.attributeName!=='style'||owned.get(m.target)!==m.target.getAttribute('style')))schedule();});
 for(const e of [panel,rail,timeline])observer.observe(e,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['class','hidden','aria-current','data-nww-section']});
 const geometryObserver=new MutationObserver(records=>{if(records.some(m=>owned.get(m.target)!==m.target.getAttribute('style')))schedule();});
 for(const e of [panel,rail,timeline,document.getElementById('mapTitleBadge')])if(e)geometryObserver.observe(e,{attributes:true,attributeFilter:['style']});
 observer.observe(body,{attributes:true,attributeFilter:['class']});
 for(const modal of document.querySelectorAll('[role="dialog"],dialog,.download-modal,.datum-modal'))if(modal!==panel)observer.observe(modal,{attributes:true,attributeFilter:['class','hidden','open','aria-modal','style']});
 new ResizeObserver(schedule).observe(timeline);mobile.addEventListener('change',schedule);addEventListener('resize',schedule,{passive:true});window.visualViewport?.addEventListener('resize',schedule,{passive:true});window.visualViewport?.addEventListener('scroll',schedule,{passive:true});
 addEventListener('load',schedule,{once:true});if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',schedule,{once:true});
 layout();
})();
