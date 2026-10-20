import test from 'node:test';
import assert from 'node:assert/strict';
import {CommunityCameraPolicy,communityCameraAllowed,communityCameraMustYield,
  COMMUNITY_CAMERA_HOLD_MS,COMMUNITY_CAMERA_DURATION_MS} from '../docs/camera-community.js';
import {LIVE_CAMERAS} from '../docs/live-cameras.js';
import {getP2PArea} from '../docs/p2p-areas.js';

const BASE=Date.parse('2026-10-20T12:00:00+09:00');
const camera=(id,lat,lon)=>({id,lat,lon,videoId:`camera0000${id}`,label:`Camera ${id}`,owner:'Provider',sourceURL:'https://example.test/'});
const catalogue=[camera('1',43.068,141.35),camera('2',35.7,139.5),camera('3',34.8,135.55)];
const report=(id,area,time)=>({code:561,id,area,time:new Date(time).toISOString()});
function fixture(options={}){
  let now=BASE,serial=0;
  const policy=new CommunityCameraPolicy({now:()=>now,catalogue,...options});
  return {policy,at:offset=>{now=BASE+offset;},
    post:(area=10,extra={})=>policy.ingestLive({areas:[{code:area,count:9999}]},
      {message:report(`post-${++serial}`,area,now),receivedAt:now,...extra})};
}
const ready=(extra={})=>({ready:true,blocked:false,reason:null,eewActive:false,tsunamiActive:false,
  nativeInformationAgeMs:null,historyIndex:0,manualMotion:false,nativeMoving:false,nativePending:false,
  manualAgeMs:60_000,...extra});

test('one accepted 561 starts a local muted-camera candidate after one short batch, with report semantics',()=>{
  const f=fixture();assert.equal(f.post().accepted,true);
  assert.equal(f.policy.take(),null);assert.equal(f.policy.snapshot().readyAt,BASE+400);
  f.at(400);const result=f.policy.take();
  assert.equal(result.selected.id,'1');assert.equal(result.event.kind,'community');
  assert.equal(result.event.source,'561');assert.equal(result.event.measured,false);
  assert.equal(result.event.count,1);assert.equal(result.event.name,getP2PArea(10).name);
  assert.equal('maxIntensity' in result.event,false);
  assert.equal(result.event.expiresAt,BASE+400+COMMUNITY_CAMERA_DURATION_MS);
  assert.equal(f.policy.snapshot().pendingCount,0);assert.equal(f.policy.snapshot().readyAt,null);
});

test('aggregate, history/replay, old, unlocated and duplicate reports never open a camera',()=>{
  const f=fixture();
  for(const detail of [{source:'history'},{source:'replay'},{message:{...report('total',10,BASE),code:9611}},
    {message:report('old',10,BASE-30_001)},{message:report('unknown',999,BASE)}]){
    assert.equal(f.post(10,detail).accepted,false);
  }
  const message=report('unique',10,BASE);
  assert.equal(f.post(10,{message}).accepted,true);
  assert.equal(f.post(10,{message}).accepted,false);
  f.at(400);assert.equal(f.policy.take().event.count,1);
});

test('the real catalogue offers Sapporo cameras for an Ishikari report without new API or invented positions',()=>{
  const f=fixture({catalogue:LIVE_CAMERAS});f.post(10);f.at(400);
  const result=f.policy.take();
  assert.equal(result.selected.id,'htb-sapporo-station');
  assert.ok(result.selected.distanceKm<2);
  assert.ok(result.choices.every(camera=>camera.distanceKm<=300));
});

test('nearby reports are coalesced while a distant minority cannot churn through several cameras',()=>{
  const f=fixture();f.post(10);f.at(100);f.post(30);f.post(250);f.at(400);
  const result=f.policy.take();assert.equal(result.selected.id,'1');assert.equal(result.event.count,2);
  assert.deepEqual(result.event.areas.map(area=>area.code),[10,30]);
  f.at(1000);assert.equal(f.post(250).reason,'camera-held');
  f.at(5000);assert.equal(f.policy.take(),null);assert.equal(f.policy.snapshot().pendingCount,0);
});

test('remote region replacement needs a fresh post after the hold and never extends the original two-minute session',()=>{
  const f=fixture();f.post(10);f.at(400);const first=f.policy.take();
  f.at(30_399);assert.equal(f.post(250).accepted,false);
  f.at(30_400);assert.equal(f.post(250).accepted,true);f.at(30_800);
  const second=f.policy.take();
  assert.equal(second.selected.id,'2');assert.equal(second.event.id,first.event.id);
  assert.equal(second.event.expiresAt,first.event.expiresAt);
  f.at(first.event.expiresAt-BASE-1);assert.equal(f.policy.snapshot().close,false);
  f.at(first.event.expiresAt-BASE);assert.equal(f.policy.snapshot().close,true);
});

test('a still-nearby selected camera stays even when it falls outside the five nearest choices',()=>{
  const close=Array.from({length:5},(_,i)=>camera(String(i+1),35.70+i*.01,139.50));
  const f=fixture({catalogue:[...close,camera('6',35.443,139.638)]});
  f.post(270);f.at(400);assert.equal(f.policy.take().selected.id,'6');
  f.at(30_400);f.post(250);f.at(30_800);
  assert.equal(f.policy.take(),null,'a slightly nearer alternative is not a reason to replace playback');
  assert.equal(f.policy.snapshot().expiresAt,BASE+120_400);
});

test('manual collapse suppresses repeated fresh posts until the original deadline without a hidden replay',()=>{
  const f=fixture();f.post();f.at(400);const first=f.policy.take();
  f.at(10_000);f.policy.dismiss();
  f.at(40_000);assert.equal(f.post(250).accepted,false);
  f.at(120_399);assert.equal(f.post(250).accepted,false);
  f.at(120_400);assert.equal(f.policy.snapshot().close,true);assert.equal(f.policy.take(),null);
  f.post(250);f.at(120_800);const second=f.policy.take();
  assert.equal(second.selected.id,'2');assert.notEqual(second.event.id,first.event.id);
});

test('a manually chosen camera receives its own hold and more posts cannot renew its display deadline',()=>{
  const f=fixture();f.post();f.at(400);f.policy.take();
  f.at(20_000);f.policy.select('1');
  f.at(49_999);assert.equal(f.post(250).accepted,false);
  f.at(50_000);assert.equal(f.post(250).accepted,true);
  f.at(50_400);assert.equal(f.policy.take().selected.id,'2');
  assert.equal(f.policy.snapshot().expiresAt,BASE+120_400);
});

test('native priority, pause and resize discard queued posts; a later safe state cannot replay them',()=>{
  for(const action of ['blocked','clear','cancel']){
    const f=fixture();f.post();
    if(action==='blocked')assert.equal(f.policy.take({blocked:true}),null);
    if(action==='clear')f.policy.clearPending();
    if(action==='cancel')f.policy.cancel();
    f.at(1000);assert.equal(f.policy.take(),null);assert.equal(f.policy.snapshot().pendingCount,0);
  }
  const f=fixture();f.post();f.at(400);f.policy.take();f.policy.cancel();
  assert.equal(f.policy.snapshot().id,null);assert.equal(f.policy.snapshot().expiresAt,null);
});

test('a region without a camera within 300km cannot open a distant stream or block another local region',()=>{
  const f=fixture();f.post(265);f.at(400);assert.equal(f.policy.take(),null);
  f.at(1000);assert.equal(f.post(250).accepted,true);f.at(1400);
  assert.equal(f.policy.take().selected.id,'2');
});

test('source receipts expire while paused and a displayed community session is closed after resume past its deadline',()=>{
  const f=fixture();f.post();f.at(5000);assert.equal(f.policy.take(),null);
  f.at(6000);f.post();f.at(6400);f.policy.take();
  f.policy.clearPending();f.at(130_000);assert.equal(f.policy.snapshot().close,true);
});

test('EEW, tsunami, fresh native earthquake information and replay always outrank community cameras',()=>{
  for(const state of [ready({eewActive:true}),ready({tsunamiActive:true}),ready({reason:'tsunami-active'}),
    ready({nativeInformationAgeMs:120_000}),ready({nativeInformationAgeMs:-10_000}),ready({reason:'replay'})]){
    assert.equal(communityCameraAllowed(state),false);assert.equal(communityCameraMustYield(state),true);
  }
  assert.equal(communityCameraAllowed(ready({nativeInformationAgeMs:120_001})),true);
});

test('native and manually previewed earthquake sessions cannot be replaced; actual shaking and native pan OFF still allow report cameras',()=>{
  assert.equal(communityCameraAllowed(ready(),{kind:'eew'}),false);
  assert.equal(communityCameraAllowed(ready(),{kind:'earthquake',manual:true}),false);
  assert.equal(communityCameraAllowed(ready(),{kind:'community'}),true);
  assert.equal(communityCameraAllowed(ready({reason:'shaking',shaking:true})),true);
  assert.equal(communityCameraAllowed(ready({reason:'native-auto-disabled',autoEnabled:false})),true);
});

test('manual movement, history, settings and incomplete native state cannot start a lower-priority camera',()=>{
  for(const state of [null,{ready:false},ready({manualMotion:true}),ready({nativeMoving:true}),
    ready({nativePending:true}),ready({manualAgeMs:30_000}),ready({manualAgeMs:NaN}),ready({historyIndex:1}),
    ready({reason:'dialog'}),ready({reason:'not-map'})])assert.equal(communityCameraAllowed(state),false);
});

test('returned metadata and copied catalogue cannot be mutated to alter another camera decision',()=>{
  const input=catalogue.map(camera=>({...camera}));const f=fixture({catalogue:input});
  input[0].lat=0;f.post();f.at(400);const result=f.policy.take();
  assert.equal(result.selected.id,'1');result.event.areas[0].lat=0;result.selected.lat=0;
  f.at(30_400);f.post(250);f.at(30_800);assert.equal(f.policy.take().selected.id,'2');
});

test('invalid options and invalid clocks fail predictably',()=>{
  assert.throws(()=>new CommunityCameraPolicy({holdMs:0}));
  assert.throws(()=>new CommunityCameraPolicy({durationMs:Infinity}));
  assert.throws(()=>new CommunityCameraPolicy({catalogue:null}));
  assert.throws(()=>new CommunityCameraPolicy({now:()=>NaN}).snapshot());
  assert.equal(COMMUNITY_CAMERA_HOLD_MS,30_000);assert.equal(COMMUNITY_CAMERA_DURATION_MS,120_000);
});

test('a backward wall-clock change closes the report camera instead of making its deadline indefinite',()=>{
  const f=fixture();f.post();f.at(400);f.policy.take();
  f.at(100);assert.equal(f.policy.snapshot().close,true);
  assert.equal(f.policy.snapshot().pendingCount,0);
});
