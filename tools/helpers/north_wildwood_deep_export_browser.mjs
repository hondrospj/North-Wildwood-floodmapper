// Native-control helpers: no application-function replacements or data injection.
export async function setNativeExportRange(page, startUtc, endUtc) {
  const values=await page.evaluate(times=>times.map(value=>{
    const date=new Date(value),parts=getNyParts(date);
    return {date:`${parts.month}/${parts.day}/${parts.year}`,time:formatNyLocalIso(date).slice(11),instant:date.getTime()};
  }),[startUtc,endUtc]);
  for(const [index,cap] of ['Start','End'].entries()) {
    const value=values[index];
    await page.locator(`#download${cap}DateText`).fill(value.date);
    await page.locator(`#download${cap}DateText`).press('Tab');
    await page.locator(`#download${cap}TimeButton`).click();
    const option=await page.locator(`#download${cap}TimeSelect`).evaluate((select,value)=>
      [...select.options].find(option=>option.value===`${value.time}|${value.instant}`)?.value
      || [...select.options].find(option=>option.value===value.time)?.value,value);
    if(!option)throw Error(`No native time option for ${cap}: ${JSON.stringify(value)}`);
    await page.locator(`#nwwExportDateTimePicker [data-value="${option}"]`).click();
  }
}
export async function reviewNativeExport(page) {
  if(await page.locator('#downloadModal').getAttribute('data-export-step')!=='review') await page.locator('#downloadBtn').click();
}
export async function exportSelectionSnapshot(page) {
  return page.evaluate(()=>({start:downloadStartInput.value,end:downloadEndInput.value,interval:getDownloadIntervalValue(),
    validation:validateDownloadRangeForExport().ok,items:getDownloadFrameItems().map(item=>({time:item.entry.timeUtc,stage:getStageValue(item.entry)})),
    summary:downloadSummary.textContent,preview:exportPreview.dataset.state,previewMessage:exportPreviewStatus.textContent}));
}
export async function findNativeBuildingRoof(page, footprintId) {
  return page.evaluate(id=>{
    const map=NORTH_WILDWOOD_3D.getMap(),rect=map.getContainer().getBoundingClientRect();
    for(let y=120;y<Math.min(rect.height-130,800);y+=10)for(let x=520;x<Math.min(rect.width-320,1120);x+=10){
      const feature=map.queryRenderedFeatures([x,y],{layers:['nw-3d-buildings']})[0];
      if(feature?.properties.footprintId===id)return {point:[x+rect.left,y+rect.top],properties:feature.properties};
    }
    return null;
  },footprintId);
}
export async function retryNativeParcelSource3d(page, url) {
  const requests=[];
  await page.route('**/*NorthWildwoodParcelBoundaries*',async route=>{
    const request=route.request();requests.push({url:request.url(),type:request.resourceType(),failed:requests.length===0});
    if(requests.length===1)await route.abort('failed');else await route.continue();
  });
  await page.goto(url,{waitUntil:'domcontentloaded',timeout:90000});
  await page.waitForFunction(()=>document.body.classList.contains('nw-app-ready')&&floodFrameState==='ready',{},{timeout:90000});
  await page.locator('.nw-simple-view').click();
  await page.waitForFunction(()=>NORTH_WILDWOOD_3D.state().buildingsVisible,{},{timeout:90000});
  const before=await page.evaluate(()=>{const source=NORTH_WILDWOOD_3D.getMap().getSource('nw-parcel-source');return {sourceLoaded:source.loaded(),imageWidth:source.image?.width||0,texturePresent:!!source.texture,sourceKeys:Object.keys(source),enabled:parcelsToggle.classList.contains('on')};});
  if(!requests.length||before.imageWidth||before.enabled)throw Error(`Expected a failed hidden GL parcel image: ${JSON.stringify({before,requests})}`);
  // The first source request failed while Parcels was off. The native enable
  // loads the Leaflet image and must also retry the same URL in MapLibre.
  await page.locator('#parcelsToggle').click();
  await page.waitForFunction(()=>parcelsToggle.classList.contains('on')&&parcelsLayer?.getElement()?.complete&&
    parcelsLayer.getElement().naturalWidth>0&&NORTH_WILDWOOD_3D.getMap().getSource('nw-parcel-source').image?.width>0,{},{timeout:30000});
  const after=await page.evaluate(()=>({sourceLoaded:NORTH_WILDWOOD_3D.getMap().getSource('nw-parcel-source').loaded(),
    imageWidth:NORTH_WILDWOOD_3D.getMap().getSource('nw-parcel-source').image?.width||0,visibility:NORTH_WILDWOOD_3D.getMap().getLayoutProperty('nw-parcel-overlay','visibility'),leafletWidth:parcelsLayer.getElement().naturalWidth}));
  return {requests,before,after};
}
