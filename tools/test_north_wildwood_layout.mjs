import fs from 'node:fs';
import assert from 'node:assert/strict';
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const source=fs.readFileSync(new URL('../index.html', import.meta.url),'utf8');
const blocks=[...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
const scripts=[blocks.find(m=>m[1].includes('function clearStableDesktopPaneSizes'))[1],blocks.find(m=>m[0].startsWith('<script id="shorely-mobile-slider-key-correction-script"'))[1]];
const html=source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace(/<link\b[^>]*>/g,'');
const browser=await chromium.launch({...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {}),headless:true});
const results=[];
try {
 for(const [name,selected] of [['both',scripts]]){
  const page=await browser.newPage({viewport:{width:1440,height:1000}});await page.route('**/*',r=>r.abort());
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.setContent(html,{waitUntil:'domcontentloaded'});
  await page.evaluate(()=>{document.body.className='';document.getElementById('nwSiteLoader').remove();window.auditCount=0;window.auditStyles=[];new MutationObserver(rows=>{window.auditCount+=rows.length;window.auditStyles.push(getComputedStyle(document.getElementById('leftPanel')).overflowY)}).observe(document.getElementById('leftPanel'),{attributes:true,attributeFilter:['style']});});
  for(const content of selected)await page.addScriptTag({content});
  await page.waitForTimeout(9000);
  await page.evaluate(()=>{window.auditCount=0;window.auditStyles=[];});await page.waitForTimeout(1200);
  const data=await page.evaluate(()=>({mutationsAfterSettling:window.auditCount,overflowValues:[...new Set(window.auditStyles)],styleBlocks:document.querySelectorAll('style').length,cssRuleCount:[...document.styleSheets].reduce((n,s)=>n+s.cssRules.length,0)}));
  results.push({name,...data,errors});await page.close();
 }
}finally {await browser.close();}
for (const row of results) { assert.equal(row.errors.length,0); assert.equal(row.mutationsAfterSettling,0,JSON.stringify(row)); }
console.log(JSON.stringify(results,null,2));
