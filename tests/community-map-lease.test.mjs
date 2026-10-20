import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import {acquireCommunityMapLease} from '../docs/community-map-lease.js';

const project=JSON.parse(readFileSync(new URL('../docs/assets/project.json',import.meta.url),'utf8'));
const rawReceiver=project.targets.find(target=>target.name==='受信と検出');
const rawStage=project.targets.find(target=>target.isStage);
const procedure='自動カメラ呼び出し %b %s %b %b %b';
const syncKey=`W${procedure}`,generatorKey=`Z${procedure}`;
const periodic=[false,'5秒ごと',false,false,false];

// Native Blocks uses ordinary shadow/reporter objects, not SB3 input arrays.
function normalize(source){
  const result={},literals=[];let serial=0;
  const literal=(raw,parent)=>{
    const[type,value,id]=raw,key=`lease-fixture/literal/${++serial}`,numeric=type>=4&&type<=8;
    const opcode=numeric?'math_number':type===9?'colour_picker':type===11?'event_broadcast_menu':type===12?'data_variable':type===13?'data_listcontents':'text';
    const name=numeric?'NUM':type===9?'COLOUR':type===11?'BROADCAST_OPTION':type===12?'VARIABLE':type===13?'LIST':'TEXT';
    literals.push({id:key,opcode,next:null,parent,inputs:{},fields:{[name]:{name,value,...(id?{id}:{})}},shadow:type!==12&&type!==13,topLevel:false});
    return key;
  };
  for(const[id,raw]of Object.entries(source)){
    const block={...structuredClone(raw),id,next:raw.next??null,parent:raw.parent??null,shadow:raw.shadow??false,topLevel:raw.topLevel??false};
    block.fields=Object.fromEntries(Object.entries(raw.fields??{}).map(([name,[value,id]])=>[name,{name,value,...(id?{id}:{})}]));
    block.inputs=Object.fromEntries(Object.entries(raw.inputs??{}).map(([name,input])=>{
      const primary=Array.isArray(input[1])?literal(input[1],id):input[1]??null;
      const shadow=input[0]===1?primary:Array.isArray(input[2])?literal(input[2],id):input[2]??null;
      return[name,{name,block:primary,shadow}];
    }));
    result[id]=block;
  }
  for(const block of literals)result[block.id]=block;
  return result;
}

function fixture({compiled=true,topBlock='c%S'}={}){
  let time=10_000,safe=true,guardError=null;
  const calls=[],context={name:'native-this'};
  const variables=raw=>Object.fromEntries(Object.entries({...raw.variables,...raw.lists})
    .map(([id,[name,value]])=>[id,{id,name,type:Object.hasOwn(raw.lists??{},id)?'list':'',value:structuredClone(value)}]));
  const stage={isStage:true,isOriginal:true,variables:variables(rawStage)};
  const blockGraph=normalize(rawReceiver.blocks);
  const blocks={_blocks:blockGraph,_scripts:Object.values(blockGraph).filter(block=>block.topLevel).map(block=>block.id),
    _cache:{untouched:'native compile cache'},getBlock(id){return this._blocks[id];}};
  const receiver={isStage:false,isOriginal:true,variables:variables(rawReceiver),blocks,getName:()=> '受信と検出'};
  const originalSync=function(...args){calls.push({kind:'sync',self:this,args});return 'native-sync-result';};
  const originalGenerator=function*(...args){calls.push({kind:'generator',self:this,args});const value=yield 'native-yield';return value;};
  const thread={target:receiver,topBlock,isCompiled:compiled,procedures:{[syncKey]:originalSync,[generatorKey]:originalGenerator}};
  const primitive=function(...args){calls.push({kind:'interpreter',self:this,args});return 'native-primitive';};
  const runtime=Object.assign(new EventEmitter(),{targets:[stage,receiver],threads:[thread],getTargetForStage:()=>stage,
    _primitives:{procedures_call:primitive}});
  const vm={runtime};
  const options={now:()=>time,canHold(){if(guardError)throw guardError;return safe;}};
  return{vm,runtime,stage,receiver,blocks,thread,calls,context,options,originalSync,originalGenerator,primitive,
    acquire:()=>acquireCommunityMapLease(vm,options),
    sync:(args=periodic)=>thread.procedures[syncKey].apply(context,args),
    generator:(args=periodic)=>thread.procedures[generatorKey].apply(context,args),
    advance(ms){time+=ms;},setTime(value){time=value;},guard(value){safe=value;},throwGuard(error){guardError=error;}};
}

test('a compatible live compiled receiver skips only the periodic background call without editing native state',()=>{
  const f=fixture(),graph=structuredClone(f.blocks._blocks),variables=structuredClone([f.stage.variables,f.receiver.variables]),cache=f.blocks._cache;
  const lease=f.acquire();assert.ok(lease);assert.equal(lease.active,true);assert.equal(lease.expiresAt,13_000);
  f.sync();assert.equal(f.generator().next().done,true);
  assert.equal(f.calls.length,0);assert.equal(lease.stats.skipped,2);
  assert.deepEqual(f.blocks._blocks,graph);assert.deepEqual([f.stage.variables,f.receiver.variables],variables);
  assert.equal(f.blocks._cache,cache);assert.equal(f.runtime._primitives.procedures_call,f.primitive);
  lease.dispose();assert.equal(f.thread.procedures[syncKey],f.originalSync);assert.equal(f.thread.procedures[generatorKey],f.originalGenerator);
});

test('native false defaults and both optional-move values still identify the exact periodic call',()=>{
  const f=fixture(),lease=f.acquire();assert.ok(lease);
  f.sync([false,'5秒ごと',undefined,undefined,undefined]);f.sync([true,'5秒ごと','','','']);
  assert.equal(f.calls.length,0);assert.equal(lease.stats.skipped,2);lease.dispose();
});

test('manual, warning, force and other-reason calls always preserve their native this and arguments',()=>{
  const permitted=[
    [false,'EEW',false,true,false],
    [false,'5秒ごと',true,false,false],
    [false,'5秒ごと',false,true,false],
    [false,'5秒ごと',false,false,true],
    [false,'5秒ごと '],
    [false,'別の更新',false,false,false],
  ];
  for(const args of permitted){
    const f=fixture(),lease=f.acquire();assert.ok(lease);
    assert.equal(f.sync(args),'native-sync-result');assert.equal(f.calls.at(-1).self,f.context);assert.deepEqual(f.calls.at(-1).args,args);
    assert.equal(lease.stats.skipped,0);assert.equal(lease.stats.passed,1);assert.equal(lease.active,false);lease.dispose();
  }
});

test('a generator pass-through preserves yields, resume values, return values and thrown errors',()=>{
  const f=fixture(),lease=f.acquire();assert.ok(lease);
  const generator=f.generator([false,'地震情報',false,false,false]);
  assert.deepEqual(generator.next(),{value:'native-yield',done:false});
  assert.deepEqual(generator.next('native-return'),{value:'native-return',done:true});
  assert.equal(f.calls[0].self,f.context);
  lease.dispose();
  const other=fixture(),otherLease=other.acquire();assert.ok(otherLease);
  const thrown=other.generator([false,'手動',true,false,false]);thrown.next();
  const error=new Error('native-generator-error');assert.throws(()=>thrown.throw(error),value=>value===error);
  otherLease.dispose();
});

test('a closure created before acquisition uses the wrapped procedure property in the existing thread',()=>{
  const f=fixture(),compiledClosure=(...args)=>f.thread.procedures[syncKey](...args);
  const lease=f.acquire();assert.ok(lease);
  assert.notEqual(compiledClosure(...periodic),'native-sync-result');assert.equal(f.calls.length,0);
  lease.release('manual');assert.equal(compiledClosure(...periodic),'native-sync-result');assert.equal(f.calls.length,1);
  lease.dispose();
});

test('a lease expires after exactly three seconds and repeated acquisition does not renew it',()=>{
  const f=fixture(),lease=f.acquire();assert.ok(lease);const expiresAt=lease.expiresAt;
  f.advance(2999);assert.equal(f.acquire(),lease);assert.equal(lease.expiresAt,expiresAt);assert.equal(lease.active,true);
  f.advance(1);assert.equal(lease.active,false);assert.ok(lease.reason);
  assert.equal(f.sync(),'native-sync-result');assert.equal(f.calls.length,1);lease.dispose();
});

test('a priority guard becoming false latches release and cannot revive after the priority disappears',()=>{
  const f=fixture(),lease=f.acquire();assert.ok(lease);
  f.guard(false);f.runtime.emit('BEFORE_EXECUTE');assert.equal(lease.active,false);assert.ok(lease.reason);
  f.guard(true);assert.equal(lease.active,false);assert.equal(f.sync(),'native-sync-result');lease.dispose();
});

test('guard failures and invalid or backward clocks fail closed without throwing into the native receiver',()=>{
  for(const invalidate of [f=>f.throwGuard(new Error('native unavailable')),f=>f.setTime(NaN),f=>f.setTime(9999)]){
    const f=fixture(),lease=f.acquire();assert.ok(lease);invalidate(f);
    assert.doesNotThrow(()=>f.runtime.emit('BEFORE_EXECUTE'));assert.equal(lease.active,false);
    f.throwGuard(null);f.setTime(10_001);assert.equal(lease.active,false);
    assert.equal(f.sync(),'native-sync-result');lease.dispose();
  }
});

test('project loading, stopping and a native stage-size change release the temporary hold',()=>{
  for(const event of ['PROJECT_LOADED','PROJECT_STOP_ALL','PROJECT_START','STAGE_SIZE_CHANGED','PROJECT_CHANGED']){
    const f=fixture(),lease=f.acquire();assert.ok(lease);f.runtime.emit(event);
    assert.equal(lease.active,false,event);assert.equal(f.sync(),'native-sync-result',event);lease.dispose();
  }
});

test('source replacement or a stopped receiver releases without waiting for the three-second timeout',()=>{
  for(const replace of [
    f=>{f.runtime.getTargetForStage=()=>({...f.stage});},
    f=>{f.runtime.targets=[f.stage];},
    f=>{f.receiver.blocks={...f.blocks};},
    f=>{f.runtime.threads=[];},
  ]){
    const f=fixture(),lease=f.acquire();assert.ok(lease);replace(f);f.runtime.emit('BEFORE_EXECUTE');
    assert.equal(lease.active,false);assert.equal(f.sync(),'native-sync-result');lease.dispose();
  }
});

test('other native threads and targets are not gated by the selected receiver loop',()=>{
  const f=fixture();
  const foreignTop={...f.thread,topBlock:'other-native-hat',procedures:{[syncKey]:f.originalSync}};
  const foreignTarget={...f.thread,target:{...f.receiver,getName:()=> '別のターゲット'},procedures:{[syncKey]:f.originalSync}};
  f.runtime.threads.push(foreignTop,foreignTarget);
  const lease=f.acquire();assert.ok(lease);
  assert.equal(foreignTop.procedures[syncKey](...periodic),'native-sync-result');
  assert.equal(foreignTarget.procedures[syncKey](...periodic),'native-sync-result');
  assert.notEqual(f.sync(),'native-sync-result');assert.equal(f.calls.length,2);lease.dispose();
});

test('late compiled replacements are wrapped on the ordinary execution boundary',()=>{
  const f=fixture(),lease=f.acquire();assert.ok(lease);
  const late={...f.thread,procedures:{[syncKey]:f.originalSync,[generatorKey]:f.originalGenerator}};
  f.runtime.threads=[late];f.runtime.emit('BEFORE_EXECUTE');
  assert.notEqual(late.procedures[syncKey](...periodic),'native-sync-result');assert.equal(f.calls.length,0);
  lease.dispose();assert.equal(late.procedures[syncKey],f.originalSync);
});

test('disposal restores only owned wrappers, preserves other patches and removes its event listeners',()=>{
  const f=fixture(),events=['BEFORE_EXECUTE','PROJECT_LOADED','PROJECT_STOP_ALL','STAGE_SIZE_CHANGED'];
  const sentinel=()=>{};for(const event of events)f.runtime.on(event,sentinel);
  const counts=events.map(event=>f.runtime.listenerCount(event));const lease=f.acquire();assert.ok(lease);
  const externalPatch=()=> 'external-patch';f.thread.procedures[syncKey]=externalPatch;
  lease.dispose();lease.dispose();assert.equal(lease.active,false);
  assert.equal(f.thread.procedures[syncKey],externalPatch);assert.equal(f.thread.procedures[generatorKey],f.originalGenerator);
  assert.deepEqual(events.map(event=>f.runtime.listenerCount(event)),counts);
});

test('a new lease after release cannot stack wrappers or be disposed by its older lease',()=>{
  const f=fixture(),first=f.acquire();assert.ok(first);first.release('done');
  const second=f.acquire();assert.ok(second);assert.notEqual(second,first);
  first.dispose();assert.equal(second.active,true);assert.notEqual(f.sync(),'native-sync-result');
  second.dispose();assert.equal(f.thread.procedures[syncKey],f.originalSync);assert.equal(f.thread.procedures[generatorKey],f.originalGenerator);
});

test('interpreter-only receivers remain untouched and return the explicit safe fallback',()=>{
  const f=fixture({compiled:false}),before=structuredClone(f.blocks._blocks);
  assert.equal(f.acquire(),null);assert.equal(f.runtime._primitives.procedures_call,f.primitive);
  assert.equal(f.thread.procedures[syncKey],f.originalSync);assert.deepEqual(f.blocks._blocks,before);
});

test('unavailable readers, rejected initial ownership and read-only procedures return a harmless fallback',()=>{
  for(const unsupported of [
    f=>{f.runtime.getTargetForStage=()=>{throw new Error('stage unavailable');};},
    f=>{f.receiver.getName=()=>{throw new Error('target unavailable');};},
    f=>f.guard(false),
    f=>f.throwGuard(new Error('priority unavailable')),
    f=>{Object.defineProperty(f.thread.procedures,syncKey,{value:f.originalSync,writable:false,configurable:true});},
  ]){
    const f=fixture();unsupported(f);
    assert.doesNotThrow(()=>assert.equal(f.acquire(),null));
    assert.equal(f.thread.procedures[syncKey],f.originalSync);assert.equal(f.thread.procedures[generatorKey],f.originalGenerator);
    assert.equal(f.runtime._primitives.procedures_call,f.primitive);
  }
});

test('a synchronous native exception passes through the wrapper unchanged',()=>{
  const f=fixture(),error=new Error('native-sync-error');
  const original=function(){assert.equal(this,f.context);throw error;};
  f.thread.procedures[syncKey]=original;const lease=f.acquire();assert.ok(lease);
  assert.throws(()=>f.sync([false,'EEW',false,true,false]),value=>value===error);
  assert.equal(lease.active,false);lease.dispose();assert.equal(f.thread.procedures[syncKey],original);
});

test('an unexpected procedure table or argument shape cannot leave the periodic gate active',()=>{
  const f=fixture(),lease=f.acquire();assert.ok(lease);
  const replacement={[syncKey]:f.originalSync};f.thread.procedures=replacement;f.runtime.emit('BEFORE_EXECUTE');
  assert.equal(lease.active,false);assert.equal(f.thread.procedures,replacement);assert.equal(f.sync(),'native-sync-result');lease.dispose();
  const other=fixture(),otherLease=other.acquire();assert.ok(otherLease);
  assert.equal(other.sync([false,'5秒ごと']),'native-sync-result');assert.equal(otherLease.active,false);otherLease.dispose();
});

test('an unreadable replacement procedure cannot throw out of the native execution boundary',()=>{
  const f=fixture(),lease=f.acquire();assert.ok(lease);
  Object.defineProperty(f.thread.procedures,syncKey,{get(){throw new Error('procedure replaced');},configurable:true});
  assert.doesNotThrow(()=>f.runtime.emit('BEFORE_EXECUTE'));
  assert.equal(lease.active,false);assert.doesNotThrow(()=>lease.dispose());
});

test('unknown callsite schemas and additional ambiguous periodic calls cannot be suppressed',()=>{
  for(const mutate of [
    f=>{f.blocks._blocks.TM.inputs.SUBSTACK.block='different-call';},
    f=>{f.blocks._blocks['a#.'].mutation.proccode='changed-procedure';},
    f=>{f.blocks._blocks['second-periodic-call']={...structuredClone(f.blocks._blocks['a#.']),id:'second-periodic-call'};},
  ]){
    const f=fixture();mutate(f);const graph=structuredClone(f.blocks._blocks);
    assert.equal(f.acquire(),null);assert.equal(f.thread.procedures[syncKey],f.originalSync);assert.deepEqual(f.blocks._blocks,graph);
  }
  for(const vm of [null,{}, {runtime:{}}])assert.doesNotThrow(()=>assert.equal(acquireCommunityMapLease(vm,{canHold:()=>true}),null));
});
