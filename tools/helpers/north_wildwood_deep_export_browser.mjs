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
export async function checkNativeParcelVectors3d(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => document.body.classList.contains('nw-app-ready') &&
    floodFrameState === 'ready', {}, { timeout: 90000 });
  await page.locator('.nw-simple-view').click();
  await page.waitForFunction(() => NORTH_WILDWOOD_3D.state().ready &&
    NORTH_WILDWOOD_3D.state().pitch > 10, {}, { timeout: 90000 });

  const snapshot = () => page.evaluate(() => {
    const map = NORTH_WILDWOOD_3D.getMap();
    const line = map.getLayer('nw-parcel-vector');
    return {
      enabled: parcelsToggle.classList.contains('on'),
      vectorSource: map.getSource('nw-parcel-vector-source')?.type ?? null,
      vectorLayer: line?.type ?? null,
      vectorVisibility: line ? map.getLayoutProperty('nw-parcel-vector', 'visibility') : null,
      rasterSource: Boolean(map.getSource('nw-parcel-source'))
    };
  });
  const before = await snapshot();
  const toggle = page.locator('#parcelsToggle');
  await toggle.click();
  await page.waitForFunction(() => {
    const map = NORTH_WILDWOOD_3D.getMap();
    return map.getLayer('nw-parcel-vector') &&
      map.queryRenderedFeatures({ layers: ['nw-parcel-vector'] }).length > 0;
  }, {}, { timeout: 30000 });
  const enabled = await snapshot();
  await toggle.click();
  await page.waitForFunction(() => NORTH_WILDWOOD_3D.getMap()
    .getLayoutProperty('nw-parcel-vector', 'visibility') === 'none', {}, { timeout: 30000 });
  return { before, enabled, disabled: await snapshot() };
}
