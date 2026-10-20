import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createContext,runInContext} from 'node:vm';
const meter=await readFile(new URL('../benchmarks/cpu-benchmark-meter.js',import.meta.url),'utf8');
const fixture=await readFile(new URL('../benchmarks/cpu-benchmark-fixture.js',import.meta.url),'utf8');
const project=JSON.parse(await readFile(new URL('../docs/assets/project.json',import.meta.url),'utf8'));
function harness(){
  let time=0,timer=0;
  const nodes=new Map(),events=new Map();
  const document={visibilityState:'visible',body:{append(node){nodes.set(node.id,node);}},getElementById(id){return nodes.get(id);},createElement(){return {remove(){nodes.delete(this.id);}};}};
  const gl={VENDOR:1,RENDERER:2,VERSION:3,drawingBufferWidth:1280,drawingBufferHeight:720,getExtension(){return {UNMASKED_VENDOR_WEBGL:4,UNMASKED_RENDERER_WEBGL:5};},getParameter(key){return {1:'WebKit',2:'ANGLE',3:'WebGL2',4:'Google',5:'ANGLE (Google, SwiftShader Device (Subzero))'}[key];},getContextAttributes(){return {antialias:false};},isContextLost(){return false;}};
  const renderer={dirty:true,_drawList:[],_gl:gl,_drawThese(){return 'drawn';},penClear(){this.dirty=true;return 'cleared';},penStamp(){this.dirty=true;return 'stamped';},draw(){if(!this.dirty)return;this._drawThese(this._drawList,'default');this.dirty=false;return 'presented';}};
  const runtime={renderer,targets:[],threads:[],getTargetForStage(){return {variables:{}};},on(name,fn){events.set(name,fn);},removeListener(name,fn){if(events.get(name)===fn)events.delete(name);},ioDevices:{cloud:{postData(input){return input;},updateCloudVariable(input){return input;}},clock:{projectTimer(){return time/1000;}}},sequencer:{stepThreads(){return 60;},stepThread(){return 1;}},_primitives:{text2speech_speakAndWait(){return Promise.resolve('spoken');}},_step(){this.sequencer.stepThreads();this.renderer.penClear();this.renderer.penStamp();return this.renderer.draw();}};
  const originals={step:runtime._step,draw:renderer.draw,stamp:renderer.penStamp,drawThese:renderer._drawThese,speech:runtime._primitives.text2speech_speakAndWait};
  const context=createContext({vm:{runtime},performance:{now:()=>time},document,navigator:{userAgent:'node-fixture'},innerWidth:1280,innerHeight:720,devicePixelRatio:1,setInterval(){return ++timer;},clearInterval(){},setTimeout(){return ++timer;},clearTimeout(){},addEventListener(){},structuredClone,Date,console});
  runInContext(meter,context);
  return {context,runtime,renderer,originals,setTime(value){time=value;}};
}
test('15fps presentation cap preserves all 60 native VM and pen updates',()=>{
  const h=harness(),m=h.context.cpuBenchmark;
  m.start({drawFps:15});
  for(let i=0;i<60;i++){h.setTime(i*1000/60);h.runtime._step();}
  h.setTime(1000);const result=m.stop();
  assert.equal(result.measurements['vm.step'].calls,60);
  assert.equal(result.measurements['renderer.penClear'].calls,60);
  assert.equal(result.measurements['renderer.penStamp'].calls,60);
  assert.equal(result.draw.actualFrames,15);
  assert.equal(result.draw.actualFps,15);
  assert.equal(h.renderer.dirty,true,'skipped presentations retain native pending dirtiness');
  m.dispose();assert.equal(h.runtime._step,h.originals.step);assert.equal(h.renderer.draw,h.originals.draw);assert.equal(h.renderer._drawThese,h.originals.drawThese);
});
test('actual frames ignore sensing/stamp passes and observe an inner draw throttle',()=>{
  const h=harness();let last=-Infinity;const draw=h.renderer.draw;
  h.renderer.draw=function(...args){const now=h.context.performance.now();if(now-last<200)return;last=now;return Reflect.apply(draw,this,args);};
  h.context.cpuBenchmark.start({drawFps:0});
  for(let i=0;i<60;i++){h.setTime(i*1000/60);h.runtime._step();h.renderer._drawThese([],'default');h.renderer._drawThese(h.renderer._drawList,'silhouette');}
  h.setTime(1000);const result=h.context.cpuBenchmark.stop();
  assert.equal(result.draw.dirtyDraws,60);
  assert.equal(result.draw.actualFrames,5);
  assert.equal(result.measurements['vm.step'].calls,60);
});
test('observation preserves returns and distinguishes software WebGL',async()=>{
  const h=harness(),m=h.context.cpuBenchmark;
  m.start({drawFps:0});const input={cloud:'value'};
  assert.equal(h.runtime.ioDevices.cloud.postData(input),input);
  assert.equal(h.renderer.penStamp(),'stamped');
  assert.equal(await h.runtime._primitives.text2speech_speakAndWait({WORDS:'test'}),'spoken');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(m.graphics().softwareRenderer,true);
  assert.equal(m.snapshot().speech.completed,1);
  m.dispose();assert.equal(h.runtime._primitives.text2speech_speakAndWait,h.originals.speech);
});
test('native fixture clock streams share a valid timestamp and tsunami packet is exact',()=>{
  const vars=Object.fromEntries(['☁ c2h','☁ c2b0','☁ c2u','時間オフセット','#バージョン照合'].map((name,index)=>[index,{name,value:name==='#バージョン照合'?'28':0}]));
  const receiver=project.targets.find(target=>target.name==='受信と検出');
  const blocks={_blocks:{...receiver.blocks},createBlock(block){this._blocks[block.id]=block;}};
  const target={isOriginal:true,getName:()=>receiver.name,blocks};
  const vm={runtime:{targets:[target],_primitives:{sensing_dayssince2000:()=>10000},getTargetForStage:()=>({variables:vars}),_pushThread(id,item){return {id,target:item};}},postIOData(device,{varUpdate}){assert.equal(device,'cloud');const item=Object.values(vars).find(value=>value.name===varUpdate.name);if(item)item.value=varUpdate.value;}};
  const context=createContext({vm,performance:{now:()=>0},document:{},setInterval(){return 1;},clearInterval(){},addEventListener(){},structuredClone,Date});
  runInContext(fixture,context);const f=context.cpuFixture;
  f.pulseHeartbeat();const read=name=>Object.values(vars).find(item=>item.name===name).value;
  assert.equal(read('☁ c2h').length,256);
  assert.equal(read('☁ c2h').slice(42,44),'28');
  assert.equal(read('☁ c2b0'),`0${read('☁ c2h').slice(0,10)}`);
  const packet=f.tsunamiPacket();assert.equal(packet.length,474);assert.match(packet,/^\d+$/);
  assert.equal(packet.slice(10,16),'342200');assert.equal(packet.slice(76,79),'002');
  assert.equal(packet.slice(282,285),'563');assert.equal(packet.slice(297,300),'420');
  const thread=f.invokeProcedure('津波情報受信 %s',[packet]);
  const call=blocks._blocks[thread.id];assert.equal(call.opcode,'procedures_call');
  const input=Object.values(call.inputs)[0];assert.equal(blocks._blocks[input.block].fields.TEXT.value,packet);
  assert.equal(f.tsunamiPacket({cancel:true}).slice(10,76),'0'.repeat(66));
});
