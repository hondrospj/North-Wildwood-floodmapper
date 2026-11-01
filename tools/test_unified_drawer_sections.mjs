// Exercise actual presentation source with native scrolling and keyboard input.
// A section change must reveal its first controls rather than retaining the
// previous section's scroll offset; routine layout must preserve current scroll.
import assert from 'node:assert/strict';
import fs from 'node:fs';
const playwright=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const name=process.env.NWW_BROWSER||'chromium';
const browser=await playwright[name].launch({headless:true,
 ...(name==='chromium'&&process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
const page=await browser.newPage({viewport:{width:375,height:400}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
 await page.setContent(`<style>
 body{margin:0}#leftPanel{box-sizing:border-box;padding:12px;flex-direction:column;gap:8px}
 #leftPanel>*{flex-shrink:0}#nwwMobileControlHeader{position:sticky;top:0;background:white;z-index:1}
 #nwwMobileControlHeader button{height:44px}.long-card{height:650px}
 #leftPanel[data-nww-section="forecast"] [data-nww-group]:not([data-nww-group="forecast"]),
 #leftPanel[data-nww-section="map"] [data-nww-group]:not([data-nww-group="map"]),
 #leftPanel[data-nww-section="tools"] [data-nww-group]:not([data-nww-group="tools"]){display:none}
 #timelineDock{pointer-events:none}#mobileControlsClose{position:absolute;right:12px;top:12px}
 </style><main id="app"><aside id="leftPanel">
 <section class="data-source-card long-card"><h2>Flood data</h2><button>Forecast</button></section>
 <section class="overlay-card long-card"><h2>Overlay</h2><button>Depth</button></section>
 <section id="townAddressCard" class="long-card"><h2>Address</h2><input aria-label="Address"></section>
 </aside><aside id="rightRail"></aside><div id="timelineDock"><div id="timelineDayTabs"></div></div></main>`);
 await page.addScriptTag({content:fs.readFileSync(new URL('./app/unified-controller.js',import.meta.url),'utf8')});
 const panel=page.locator('#leftPanel');
 await page.locator('#mobileControlsToggle').click();await panel.waitFor({state:'visible'});
 const settle=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 const scroll=async()=>{await panel.evaluate(el=>el.scrollTop=250);await settle();assert.ok(await panel.evaluate(el=>el.scrollTop)>100);};
 await scroll();
 await page.getByRole('tab',{name:'Map layers',exact:true}).click();await settle();
 assert.equal(await panel.evaluate(el=>el.scrollTop),0,'Opening Map layers reveals its first controls');
 await scroll();
 await page.evaluate(()=>document.querySelector('.overlay-card').classList.toggle('layout-refresh'));
 await settle();
 assert.ok(await panel.evaluate(el=>el.scrollTop)>100,'Ordinary layout retains current section scroll');
 await page.getByRole('tab',{name:'Tools',exact:true}).click();await settle();
 assert.equal(await panel.evaluate(el=>el.scrollTop),0,'Opening Tools reveals its first controls');
 await scroll();
 await page.getByRole('tab',{name:'Tools',exact:true}).focus();await page.keyboard.press('Home');await settle();
 assert.equal(await panel.evaluate(el=>el.scrollTop),0,'Keyboard section navigation resets scroll');
 assert.equal(await page.getByRole('tab',{name:'Flood data',exact:true}).getAttribute('aria-selected'),'true');
 assert.deepEqual(errors,[]);
 console.log(`PASS ${name}: section changes reveal first controls; normal layout preserves drawer scroll`);
}finally{await browser.close();}
