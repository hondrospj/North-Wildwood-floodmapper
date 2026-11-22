// Exercise the actual Play wiring with native browser events, including holds,
// cancelled gestures and the timeline's enlarged hit area.
import assert from 'node:assert/strict';
import fs from 'node:fs';
const playwright = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const name = process.env.NWW_BROWSER || 'chromium';
const browser = await playwright[name === 'edge' ? 'chromium' : name].launch({headless:true,
  ...(name === 'edge' ? {channel:'msedge'} : {}),
  ...(name === 'chromium' && !process.env.CHROME_PATH && process.env.NWW_CHROMIUM_CHANNEL ? {channel:process.env.NWW_CHROMIUM_CHANNEL} : {}),
  ...(name === 'chromium' && process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {})});
const source = fs.readFileSync(process.env.NWW_PLAY_SOURCE || new URL('./app/runtime/28-tutorial-and-events.js',import.meta.url),'utf8');
const wiring = source.match(/      const playButton = document\.getElementById\("playBtn"\);[\s\S]*?(?=\n      const stopBtn)/)?.[0];
assert.ok(wiring,'Actual Play wiring must be present');
try {
  const context = await browser.newContext({viewport:{width:700,height:400},hasTouch:true});
  const page = await context.newPage();
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.setContent(`<style>#timelineDock{position:absolute;left:20px;top:20px;width:600px;height:150px}#playBtn{position:absolute;left:20px;top:20px;width:44px;height:44px}#other{position:absolute;left:65px;top:20px;width:30px;height:44px}</style>
    <section id="timelineDock"><button id="playBtn">Play</button><button id="other">Other</button></section><button id="outside" style="position:absolute;top:300px">Outside</button>`);
  await page.addScriptTag({content:`window.playActivations=[];
    function updatePlayPauseButton(){}
    function togglePlayback(event){playActivations.push({type:event.type,button:event.button});}
    ${wiring}`});
  const count=()=>page.evaluate(()=>playActivations.length);
  const check=async(label,action,expected=1)=>{
    await page.evaluate(()=>{playActivations=[];});
    // The old code's240ms lock must not suppress a new independent gesture.
    await page.waitForTimeout(260);
    await action();
    assert.equal(await count(),expected,label);
  };
  await check('A short primary click activates once',()=>page.locator('#playBtn').click({delay:20}));
  await check('A held primary click activates once',()=>page.locator('#playBtn').click({delay:400}));
  // The native WebKit menu consumes subsequent test-driver mouse input.
  await page.locator('#playBtn').evaluate(button => {
    button.addEventListener('contextmenu', event => event.preventDefault(), {once:true});
  });
  for(const button of ['right','middle'])await check(`${button} click does not play`,()=>page.locator('#playBtn').click({button}),0);
  await check('Space activates once on release',async()=>{
    await page.locator('#playBtn').focus();await page.keyboard.down('Space');
    assert.equal(await count(),0,'Space must not start playback before release');
    await page.waitForTimeout(400);await page.keyboard.up('Space');
  });
  await check('Enter retains native button activation',()=>page.locator('#playBtn').press('Enter'));
  await check('A touch tap activates once',()=>page.locator('#playBtn').tap());
  await check('A released-outside gesture is cancelled',async()=>{
    const r=await page.locator('#playBtn').boundingBox();
    await page.mouse.move(r.x+r.width/2,r.y+r.height/2);await page.mouse.down();
    await page.mouse.move(500,300);await page.mouse.up();
  },0);
  await check('A nearby timeline click retains the enlarged hit area',async()=>{
    const r=await page.locator('#playBtn').boundingBox();await page.mouse.click(r.x-5,r.y+r.height/2);
  });
  await check('Another nearby button cannot start playback',()=>page.locator('#other').click(),0);
  await check('A disabled Play button cannot activate through its enlarged hit area',async()=>{
    await page.locator('#playBtn').evaluate(button=>{button.disabled=true;});
    const r=await page.locator('#playBtn').boundingBox();await page.mouse.click(r.x-5,r.y+r.height/2);
    await page.locator('#playBtn').evaluate(button=>{button.disabled=false;});
  },0);
  await check('Separate rapid clicks each activate once',async()=>{
    await page.locator('#playBtn').click();await page.locator('#playBtn').click();
  },2);
  assert.deepEqual(errors,[]);
  console.log(`PASS ${name}: Play primary click/hold, keyboard, touch, cancellation, nonprimary, disabled and enlarged hit area`);
}finally{await browser.close();}
