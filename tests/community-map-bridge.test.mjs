import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {EventEmitter} from 'node:events';
import {readView} from '../docs/viewer-bridge.js';
import {readMapControl,panCommunityFocus,cancelCommunityFocus} from '../docs/community-map-bridge.js';
import {getCommunityMapLease} from '../docs/community-map-lease.js';

const project=JSON.parse(await readFile(new URL('../docs/assets/project.json',import.meta.url),'utf8'));
const EPOCH=Date.UTC(2000,0,1),NOW=Date.parse('2026-10-20T06:00:00Z');
const point={lat:43.06,lon:141.354};
const autoCode='自動カメラ呼び出し %b %s %b %b %b';

// Native Blocks expands SB3 inline literals into shadow/reporter blocks.
function nativeBlocks(source){
  const normalized={};let serial=0;
  function literal(raw,parent){
    const[type,value,id]=raw,key=`bridge-test/${++serial}`,number=type>=4&&type<=8;
    const opcode=number?'math_number':type===12?'data_variable':type===13?'data_listcontents':'text';
    const name=number?'NUM':type===12?'VARIABLE':type===13?'LIST':'TEXT';
    normalized[key]={id:key,opcode,parent,next:null,inputs:{},fields:{[name]:{name,value,id}}};
    return key;
  }
  for(const[id,raw]of Object.entries(source)){
    const fields=Object.fromEntries(Object.entries(raw.fields??{}).map(([name,[value,id]])=>[name,{name,value,id}]));
    const inputs=Object.fromEntries(Object.entries(raw.inputs??{}).map(([name,rawInput])=>[name,
      {name,block:Array.isArray(rawInput[1])?literal(rawInput[1],id):rawInput[1],shadow:null}]));
    normalized[id]={...structuredClone(raw),id,inputs,fields};
  }
  return {_blocks:normalized,getBlock(id){return this._blocks[id];}};
}

function fixture({compiled=false}={}){
  const original=project.targets.find(target=>target.isStage);
  const stage={isStage:true,isOriginal:true,variables:{}};
  for(const[id,[name,value]]of Object.entries(original.variables))stage.variables[id]={name,value:structuredClone(value),type:''};
  for(const[id,[name,value]]of Object.entries(original.lists))stage.variables[id]={name,value:structuredClone(value),type:'list'};
  const byName=(name,target=stage)=>Object.values(target.variables).find(variable=>variable.name===name);
  const set=(name,value,target=stage)=>{byName(name,target).value=value;};
  const receiver={isOriginal:true,getName:()=> '受信と検出',variables:{grid:{name:'検出済みグリッド数',value:0}}};
  let clock=9000,width=480,height=360;
  const document={getElementById:()=>({hidden:true})};
  const canvas={ownerDocument:document,getBoundingClientRect:()=>({left:12,top:20,width,height})};
  const runtime=Object.assign(new EventEmitter(),{targets:[stage,receiver],threads:[{}],stageWidth:480,stageHeight:360,renderer:{canvas},
    getTargetForStage(){return this.targets[0];},_primitives:{sensing_dayssince2000:()=>clock},ioDevices:{mouse:{getIsDown:()=>false}}});
  const vm={runtime};
  set('タブ',1);set('地図表示モード',1);set('画面サイズモード','w');set('ダイアログなう','');
  set('地図過去表示モード',0);set('#リプレイモード',0);set('自動カメラ移動許可',1);set('EEW全体で発表中？',0);
  set('ボタン - 操作可能対象',0);set('0EEW',Array(140).fill(''));set('9津波関連',Array(14).fill(0));set('tsu: 地図表示集',[]);set('5地震情報リスト',[]);
  const settings=byName('7システム設定').value;settings[0]=true;
  byName('4リアルタイム状況(最大震度など)').value[7]=-3;
  const screen=byName('3画面設定系').value;Object.assign(screen,{0:60,1:0,2:180,3:180,5:1});
  const camera=byName('1カメラ系').value;
  Object.assign(camera,{0:16,1:41,2:1.8,3:'',4:'',5:1.8,11:0,17:1,18:0,19:16,20:41,21:clock-40/86400,32:0,33:''});
  set('自動カメラ時間',clock-2/86400);
  let nativeFits=0;
  if(compiled){
    receiver.blocks=nativeBlocks(project.targets.find(target=>target.name==='受信と検出').blocks);
    const nativeFit=function(){nativeFits++;camera[17]=0;set('自動カメラ時間',clock);return 'native-fit';};
    runtime.threads=[{target:receiver,topBlock:'c%S',isCompiled:true,procedures:{[`Z${autoCode}`]:nativeFit}}];
  }
  const values=()=>structuredClone(runtime.targets.map(target=>Object.fromEntries(Object.entries(target.variables).map(([id,entry])=>[id,entry.value]))));
  return {vm,stage,receiver,camera,byName,set,values,view:()=>readView(vm),control:()=>readMapControl(vm,readView(vm),NOW),
    pan:(focus=point,view=undefined)=>panCommunityFocus(focus,vm,view,NOW),clock:()=>clock,
    nativeFits:()=>nativeFits,fit:(comment='5秒ごと',flags=['','false','false'])=>runtime.threads[0].procedures[`Z${autoCode}`](false,comment,...flags),
    advance(ms){clock+=ms/86400000;},resize(w,h){width=w;height=h;runtime.stageWidth=w;runtime.stageHeight=h;}};
}

test('idle live map is readable without changing any native value',()=>{
  const f=fixture(),before=f.values(),state=f.control();
  assert.equal(state.ready,true);assert.equal(state.blocked,false);assert.equal(state.historyIndex,0);
  assert.equal(state.nativePending,false);assert.equal(state.nativeMoving,false);
  assert.deepEqual(f.values(),before);
});

test('manual and native-auto stamps use native Scratch days, independent of Date.now epoch',()=>{
  const f=fixture();const state=readMapControl(f.vm,f.view(),-999999999999);
  assert.equal(state.blocked,false);
  assert.ok(Math.abs(state.manualAgeMs-40000)<.1);
  assert.ok(Math.abs(state.nativeAutoAgeMs-2000)<.1);
  f.camera[21]=f.clock()-20/86400;
  assert.equal(f.control().reason,'manual-hold');
});

test('one focus writes only native follow/target slots with the exact original projection',()=>{
  const f=fixture(),before=f.values(),cameraBefore=[...f.camera];
  const result=f.pan();assert.equal(result.moved,true);
  assert.ok(Math.abs(f.camera[19]-53.54)<1e-9);
  assert.equal(f.camera[20],Math.log(Math.tan((45+43.06/2)*Math.PI/180))*572.9577951308232-374.04780730560344);
  assert.equal(f.camera[18],1);
  for(let index=0;index<37;index++)if(![18,19,20].includes(index))assert.equal(f.camera[index],cameraBefore[index]);
  const after=f.values(),cameraId=Object.keys(f.stage.variables).find(id=>f.stage.variables[id].name==='1カメラ系');
  before[0][cameraId][18]=1;before[0][cameraId][19]=f.camera[19];before[0][cameraId][20]=f.camera[20];
  assert.deepEqual(after,before,'no zoom, permission, manual stamp, range flag, project block or other state write');
});

test('all ten active EEW slots block regardless of old origin, provisional flags or missing epicentre',()=>{
  for(let slot=0;slot<10;slot++){
    const f=fixture(),eew=f.byName('0EEW').value;eew[slot*14]=1;eew[slot*14+4]=1;eew[slot*14+5]='';
    const before=f.values();assert.equal(f.control().reason,'eew-active');assert.equal(f.pan().moved,false);assert.deepEqual(f.values(),before);
  }
  const f=fixture();f.set('EEW全体で発表中？',1);assert.equal(f.control().reason,'eew-active');
});

test('tsunami warning, still-populated coast geometry, and native tsunami mode each retain priority',()=>{
  for(const modify of [f=>{f.byName('9津波関連').value[0]=4;},f=>f.set('tsu: 地図表示集',[1,4]),f=>f.set('地図表示モード',3)]){
    const f=fixture();modify(f);assert.equal(f.control().reason,'tsunami-active');assert.equal(f.pan().moved,false);
  }
});

test('latest old normal-information map is allowed, but new source information gets two minutes',()=>{
  const f=fixture();f.set('タブ',0);f.set('地図表示モード',2);
  const information=Array(20).fill('');information[4]=(NOW-EPOCH-600000)/1000;information[6]=(NOW-EPOCH-120001)/1000;
  f.set('5地震情報リスト',information);assert.equal(f.control().blocked,false);
  information[6]=(NOW-EPOCH-120000)/1000;assert.equal(f.control().reason,'native-information');
  information[6]=(NOW-EPOCH)/1000;assert.equal(f.control().reason,'native-information');
  information[6]='';information[4]=(NOW-EPOCH)/1000;assert.equal(f.control().reason,'native-information');
  information[4]=(NOW-EPOCH-600000)/1000;assert.equal(f.pan().moved,true);
});

test('history, replay, dialogs, non-map tabs and a disabled native auto-camera setting block',()=>{
  for(const[name,value,reason]of [['地図過去表示モード',1,'history'],['#リプレイモード',1,'replay'],['ダイアログなう','settings','dialog'],['タブ',3,'not-map']]){
    const f=fixture();f.set(name,value);assert.equal(f.control().reason,reason);assert.equal(f.pan().moved,false);
  }
  const f=fixture();f.byName('7システム設定').value[0]=false;assert.equal(f.control().reason,'native-auto-disabled');
});

test('native drag, inertia, touch, key/wheel pause, permission and mouse/button activity win',()=>{
  const cases=[f=>{f.camera[3]=0;},f=>{f.camera[4]='k';},f=>{f.camera[33]=0;},f=>{f.camera[11]=.5;},f=>{f.camera[32]=.01;},
    f=>{f.vm.runtime.ioDevices.mouse.getIsDown=()=>true;},f=>f.set('ボタン - 操作可能対象',2)];
  for(const modify of cases){const f=fixture();modify(f);assert.equal(f.control().reason,'manual-motion');assert.equal(f.pan().moved,false);}
  const f=fixture();f.set('自動カメラ移動許可',0);assert.equal(f.control().reason,'manual-hold');
  f.set('自動カメラ移動許可',1);f.camera[21]=f.clock();assert.equal(f.control().reason,'manual-hold');
});

test('native shaking detections, range calculation, recent requests and target/zoom animation block',()=>{
  const cases=[['shaking',f=>{f.receiver.variables.grid.value=1;}],['shaking',f=>{f.byName('4リアルタイム状況(最大震度など)').value[7]=.1;}],
    ['native-pending',f=>{f.camera[17]=0;}],['native-auto-recent',f=>f.set('自動カメラ時間',f.clock())],
    ['native-moving',f=>{f.camera[18]=1;f.camera[19]=200;}],['native-moving',f=>{f.camera[5]=2;}]];
  for(const[reason,modify]of cases){const f=fixture();modify(f);assert.equal(f.control().reason,reason);assert.equal(f.pan().moved,false);}
});

test('our continuing pan is distinguishable from a native target and cancellation changes only its follow flag',()=>{
  const f=fixture();assert.equal(f.pan().moved,true);
  const state=f.control();assert.equal(state.communityMoving,true);assert.equal(state.nativeMoving,false);assert.equal(state.blocked,false);
  const before=[...f.camera];assert.equal(cancelCommunityFocus(f.vm).cancelled,true);
  before[18]=0;assert.deepEqual(f.camera,before);assert.equal(cancelCommunityFocus(f.vm).cancelled,false);
});

test('native or manual ownership changes are never cancelled or restored over',()=>{
  for(const modify of [f=>{f.camera[19]+=1;},f=>{f.camera[21]=f.clock();},f=>f.set('自動カメラ時間',f.clock()),f=>{f.camera[17]=0;}]){
    const f=fixture();f.pan();modify(f);const before=f.values();assert.equal(cancelCommunityFocus(f.vm).cancelled,false);assert.deepEqual(f.values(),before);
  }
});

test('pan rechecks live priority instead of trusting an earlier allowed view',()=>{
  const f=fixture(),old=f.view();assert.equal(f.control().blocked,false);
  f.byName('0EEW').value[14]=1;const before=f.values();
  assert.deepEqual(f.pan(point,old),{moved:false,reason:'eew-active'});assert.deepEqual(f.values(),before);
});

test('stage, Variable and camera-list replacement cannot write or cancel a stale reference',()=>{
  const f=fixture(),old=f.camera;f.pan();
  const id=Object.keys(f.stage.variables).find(id=>f.stage.variables[id].name==='1カメラ系');
  const replacement=[...old];replacement[18]=0;f.stage.variables[id]={...f.stage.variables[id],value:replacement};
  assert.equal(cancelCommunityFocus(f.vm).cancelled,false);
  const beforeOld=[...old];assert.equal(f.pan({lat:35.68,lon:139.76}).moved,true);assert.deepEqual(old,beforeOld);assert.notEqual(replacement[19],old[19]);
  const previous=f.stage;f.vm.runtime.targets[0]={...previous,variables:structuredClone(previous.variables)};
  const beforePrevious=structuredClone(previous.variables);assert.equal(cancelCommunityFocus(f.vm).cancelled,false);
  f.pan(point);assert.deepEqual(previous.variables,beforePrevious);
});

test('resizes and unready/frozen/replaced schemas fail without throwing or partial writes',()=>{
  const f=fixture(),view=f.view();f.resize(600,360);
  assert.equal(f.pan(point,view).moved,false);
  assert.equal(readMapControl(f.vm,{...view,settled:false},NOW).reason,'layout-unsettled');
  assert.doesNotThrow(()=>readMapControl(f.vm,{},NOW));
  const g=fixture();Object.freeze(g.camera);assert.deepEqual(g.pan(),{moved:false,reason:'camera-readonly'});
  assert.doesNotThrow(()=>panCommunityFocus(point,{runtime:{getTargetForStage(){throw new Error('replaced');}}}));
  for(const focus of [null,{}, {lat:null,lon:1},{lat:false,lon:1},{lat:'',lon:1},{lat:90,lon:1},{lat:1,lon:181},{lat:NaN,lon:1}])assert.equal(g.pan(focus).moved,false);
});

test('native EEW after a community request owns its new target; community cannot push it back',()=>{
  const f=fixture();f.pan();
  f.byName('0EEW').value[0]=1;f.set('自動カメラ時間',f.clock());f.camera[17]=0;
  // Original bK. -> bJ! supplies the newly calculated native target and marks
  // range ready before btN performs movement; these are native-owned values.
  f.camera[5]=3;f.camera[19]=80;f.camera[20]=100;f.camera[18]=1;f.camera[17]=1;
  const before=f.values();assert.equal(f.pan().moved,false);assert.equal(cancelCommunityFocus(f.vm).cancelled,false);assert.deepEqual(f.values(),before);
  const map=project.targets.find(target=>target.name==='地図').blocks;
  const order=[];for(let id=map['dC('].next;id;id=map[id]?.next)order.push(id);
  const body=map['bFk'].inputs.SUBSTACK[1];const loop=[];for(let id=body;id;id=map[id]?.next)loop.push(id);
  assert.ok(loop.indexOf('bFy')<loop.indexOf('bFB'),'native range calculation runs before camera movement');
  assert.equal(map['bFy'].mutation.proccode,'自動カメラ計算');assert.equal(map['bFB'].mutation.proccode,'カメラ移動');
  for(const[id,index]of [['`U','6'],['`Z','20'],['`!','21'],['bKL','19']])assert.equal(map[id].inputs.INDEX[1][1],index);
});

test('a successful pan alone acquires the short lease and only its periodic fit is held',()=>{
  const f=fixture({compiled:true});assert.equal(getCommunityMapLease(f.vm),null);
  assert.equal(f.pan().moved,true);
  const lease=getCommunityMapLease(f.vm);assert.ok(lease);assert.equal(lease.active,true);
  const before=f.values();assert.notEqual(f.fit(),'native-fit');assert.equal(f.nativeFits(),0);
  assert.equal(lease.stats.skipped,1);assert.deepEqual(f.values(),before);
  assert.equal(f.pan().moved,true);assert.equal(getCommunityMapLease(f.vm),lease,'same target does not renew the lease');
  assert.equal(f.fit('地震情報表示'),'native-fit');assert.equal(f.nativeFits(),1);
  assert.equal(lease.active,false);assert.equal(lease.reason,'native-request');
  assert.equal(f.camera[17],0,'a real native fit retains its range request');
  assert.equal(f.byName('自動カメラ時間').value,f.clock());
});

test('new native priority, source changes and resize yield before the next background call',()=>{
  const cases=[
    f=>{f.byName('0EEW').value[9*14]=1;},
    f=>{f.byName('9津波関連').value[0]=3;},
    f=>f.set('地図過去表示モード',1),
    f=>f.set('#リプレイモード',1),
    f=>{f.camera[21]=f.clock();},
    f=>f.set('自動カメラ移動許可',0),
    f=>f.set('自動カメラ時間',f.clock()),
    f=>{f.byName('5地震情報リスト').value[0]='new source';},
    f=>f.resize(600,360),
  ];
  for(const change of cases){
    const f=fixture({compiled:true});f.pan();const lease=getCommunityMapLease(f.vm);assert.ok(lease);
    change(f);const before=f.values();
    // Calling the native fit directly also checks fresh priority; no execution
    // event or controller poll is required before allowing this native call.
    assert.equal(f.fit(),'native-fit');assert.equal(f.nativeFits(),1);assert.equal(lease.active,false);
    const after=f.values(),id=Object.keys(f.stage.variables).find(id=>f.stage.variables[id].name==='1カメラ系');
    before[0][id][17]=0;
    const timeId=Object.keys(f.stage.variables).find(id=>f.stage.variables[id].name==='自動カメラ時間');before[0][timeId]=f.clock();
    assert.deepEqual(after,before,'only the original native function changes state after yielding');
  }
});

test('cancelling our pan releases the hook as well as its still-owned follow flag',()=>{
  const f=fixture({compiled:true});f.pan();const lease=getCommunityMapLease(f.vm);assert.ok(lease);
  const before=f.values();assert.equal(cancelCommunityFocus(f.vm).cancelled,true);assert.equal(lease.active,false);
  const id=Object.keys(f.stage.variables).find(id=>f.stage.variables[id].name==='1カメラ系');before[0][id][18]=0;
  assert.deepEqual(f.values(),before);assert.equal(getCommunityMapLease(f.vm),null);
  assert.equal(f.fit(),'native-fit');assert.equal(f.nativeFits(),1);
});
