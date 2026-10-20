import test from 'node:test';
import assert from 'node:assert/strict';
import {startCommunityMapFollow, COMMUNITY_MANUAL_HOLD_MS} from '../docs/community-map.js';

function target() {
  const handlers = new Map();
  return {
    addEventListener(name, callback) {if(!handlers.has(name))handlers.set(name,new Set());handlers.get(name).add(callback);},
    removeEventListener(name, callback) {handlers.get(name)?.delete(callback);},
    fire(name, event = {}) {for(const callback of handlers.get(name) ?? [])callback(event);},
    get listenerCount() {return [...handlers.values()].reduce((sum,callbacks)=>sum+callbacks.size,0);},
  };
}
function fixture() {
  let now = Date.UTC(2026,9,20), serial = 0, timerId = 0, blocked = false, rejectPan = false;
  const timers = new Map(), moves = [], doc = target(), events = target();
  const app = {id:'app'}, canvas = {tagName:'CANVAS',closest:()=>app}, body = {tagName:'BODY'};
  doc.hidden = false;doc.getElementById = () => ({hidden:true});
  const follower = startCommunityMapFollow({doc,events,now:()=>now,vm:()=>({}),scaffolding:()=>({}),read:()=>({}),
    control:()=>({ready:true,blocked}),pan:(next)=>{if(rejectPan)return {moved:false,reason:'native-priority'};moves.push(next);return {moved:true};},
    schedule:(callback,delay)=>{const id=++timerId;timers.set(id,{callback,at:now+delay});return id;},cancel:id=>timers.delete(id)});
  function post(area = 10) {
    const message={code:561,id:`report-${++serial}`,uid:`user-${serial}`,time:new Date(now).toISOString(),area};
    return follower.ingestLive({}, {message,receivedAt:now});
  }
  function advance(milliseconds) {
    const until=now+milliseconds;
    for(let steps=0;steps<100;steps++) {
      const next=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];
      if(!next || next[1].at>until){now=until;return;}
      timers.delete(next[0]);now=next[1].at;next[1].callback();
    }
    throw new Error('Unexpected busy timer loop');
  }
  return {follower,post,advance,moves,timers,doc,events,canvas,body,
    block:value=>{blocked=value;},rejectPan:value=>{rejectPan=value;}};
}

test('one live report moves after the short batch and leaves no idle timer',()=>{
  const f=fixture();assert.equal(f.post().accepted,true);
  f.advance(399);assert.equal(f.moves.length,0);
  f.advance(1);assert.equal(f.moves.length,1);
  assert.equal(f.moves[0].areas[0].code,10);assert.equal(f.moves[0].count,1);
  assert.equal(f.timers.size,0);f.follower.stop();
});

test('native priority drops both new arrivals and already pending reports without later replay',()=>{
  const f=fixture();f.block(true);f.post();assert.equal(f.timers.size,0);
  f.block(false);f.advance(1000);assert.equal(f.moves.length,0);
  f.post();f.advance(200);f.block(true);f.advance(200);
  f.block(false);f.advance(10_000);assert.equal(f.moves.length,0);assert.equal(f.timers.size,0);
  f.post(60);f.advance(400);assert.equal(f.moves[0].areas[0].code,60);f.follower.stop();
});

test('a native change detected by the final pan guard is never forced or retried',()=>{
  const f=fixture();f.post();f.rejectPan(true);f.advance(400);
  f.rejectPan(false);f.advance(10_000);assert.equal(f.moves.length,0);assert.equal(f.timers.size,0);f.follower.stop();
});

test('dragging the native viewer cancels pending focus and preserves a full manual hold after release',()=>{
  const f=fixture();f.post();f.doc.fire('pointerdown',{target:f.canvas,pointerId:1});f.advance(31_000);
  assert.equal(f.post().accepted,false);assert.equal(f.moves.length,0);
  f.doc.fire('pointerup',{target:f.body,pointerId:1});f.advance(COMMUNITY_MANUAL_HOLD_MS-1);
  assert.equal(f.post().accepted,false);f.advance(1);f.post(70);f.advance(400);
  assert.equal(f.moves.length,1);assert.equal(f.moves[0].areas[0].code,70);f.follower.stop();
});

test('wheel over the map yields to native zoom; scrolling the camera log does not suppress focus',()=>{
  const f=fixture();f.doc.fire('wheel',{target:{tagName:'OL',closest:()=>null}});f.post();f.advance(400);
  assert.equal(f.moves.length,1);
  f.post();f.doc.fire('wheel',{target:f.canvas});f.advance(5000);
  assert.equal(f.moves.length,1);assert.equal(f.timers.size,0);f.follower.stop();
});

test('native map keys on document/body keep manual priority without stopping native events',()=>{
  for(const key of ['ArrowUp','ArrowDown','z','c','x','Z','+','-']) {
    const f=fixture();f.post();f.doc.fire('keydown',{target:f.body,key,
      preventDefault(){throw new Error('Must preserve the native key');},stopPropagation(){throw new Error('Must preserve the native key');}});
    f.advance(5000);assert.equal(f.moves.length,0,key);assert.equal(f.timers.size,0,key);f.follower.stop();
  }
});

test('typing in input, select or editable content does not count as a manual map key',()=>{
  for(const node of [{tagName:'INPUT'},{tagName:'SELECT'},{tagName:'DIV',isContentEditable:true}]) {
    const f=fixture();f.doc.fire('keydown',{target:node,key:'x'});f.post();f.advance(400);
    assert.equal(f.moves.length,1);f.follower.stop();
  }
});

test('layout changes, resize and visibility discard pre-transition reports',()=>{
  for(const [surface,event] of [['doc','eew-layout-change'],['events','resize'],['doc','visibilitychange']]) {
    const f=fixture();f.post();f[surface].fire(event);f.advance(5000);
    assert.equal(f.moves.length,0,event);assert.equal(f.timers.size,0,event);f.follower.stop();
  }
});

test('hidden/loading native viewer does not receive community moves',()=>{
  const f=fixture();f.doc.hidden=true;f.post();f.advance(1000);f.doc.hidden=false;
  f.doc.getElementById=id=>id==='loading'?{hidden:false}:null;f.post();f.advance(1000);
  assert.equal(f.moves.length,0);assert.equal(f.timers.size,0);f.follower.stop();
});

test('disable, pause/resume and stop remove pending effects; only fresh posts restart them',()=>{
  const f=fixture();f.post();f.follower.setEnabled(false);f.advance(1000);assert.equal(f.moves.length,0);
  f.follower.setEnabled(true);f.advance(1000);assert.equal(f.moves.length,0);
  f.post();f.follower.pause();f.advance(1000);f.follower.resume();f.advance(1000);assert.equal(f.moves.length,0);
  f.post();f.advance(400);assert.equal(f.moves.length,1);
  f.post();f.follower.stop();f.advance(5000);assert.equal(f.moves.length,1);
  assert.equal(f.timers.size,0);assert.equal(f.doc.listenerCount+f.events.listenerCount,0);
  assert.equal(f.post().accepted,false);
});
