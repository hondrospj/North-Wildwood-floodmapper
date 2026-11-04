// A key already handled by a focused control must not navigate Past again.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const file=process.env.NWW_SHORTCUT_SOURCE||new URL('./app/runtime/28-tutorial-and-events.js',import.meta.url);
const source=fs.readFileSync(file,'utf8');
const blocks=[...source.matchAll(/document\.addEventListener\("keydown", e => \{[\s\S]+?\n      \}\);/g)]
 .map(match=>match[0]).filter(block=>block.includes('stepSeriesBy(1)')&&block.includes('currentDataMode !== "observed"'));
assert.equal(blocks.length,1,'Extract the actual historical navigation listener');
const block=blocks[0];
let checks=0;
for(const mode of ['forecast','observed','return-interval'])for(const overlay of ['depth','dynamic']){
 const steps=[],calls={stop:0};let handler;
 const context=vm.createContext({currentDataMode:mode,currentOverlayMode:overlay,currentSeriesHours:[{}],
  document:{activeElement:{tagName:'DIV'},addEventListener(type,fn){assert.equal(type,'keydown');handler=fn;}},
  stopPlayback(){calls.stop++;},stepSeriesBy(value){steps.push(value);return Promise.resolve();},toast(){},setDatumHelpOpen(){},setInfoModalOpen(){}});
 vm.runInContext(block,context);
 for(const key of ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown',' ','Enter']){
  const previousSteps=steps.length,previousStop=calls.stop;
  handler({key,defaultPrevented:true,target:{closest:()=>null},preventDefault(){throw Error('A consumed event must remain untouched');}});
  assert.equal(steps.length,previousSteps,`${mode}/${overlay}/${key}: focused control already handled this key`);
  assert.equal(calls.stop,previousStop,'Consumed keys cannot stop playback either');checks++;
 }
 for(const [key,step] of [['ArrowRight',1],['ArrowLeft',-1]]){
  const previous=steps.length;let prevented=false;
  handler({key,defaultPrevented:false,target:{closest:()=>null},preventDefault(){prevented=true;}});
  assert.equal(steps.length,previous+(mode==='observed'?1:0));
  if(mode==='observed'){assert.equal(steps.at(-1),step);assert.equal(prevented,true);}checks++;
 }
 for(const tag of ['INPUT','SELECT','TEXTAREA']){
  context.document.activeElement={tagName:tag};const previous=steps.length;
  handler({key:'ArrowRight',defaultPrevented:false,target:{closest:()=>null},preventDefault(){throw Error('Native input navigation must stay untouched');}});
  assert.equal(steps.length,previous);checks++;
 }
 context.document.activeElement={tagName:'BUTTON'};
 const previous=steps.length;
 handler({key:'ArrowRight',defaultPrevented:false,target:{closest:()=>({})},preventDefault(){throw Error('Modal navigation must stay untouched');}});
 assert.equal(steps.length,previous);checks++;
}
console.log(`${checks} consumed-key, ordinary Past shortcut, mode/overlay, native input and modal navigation checks passed.`);
