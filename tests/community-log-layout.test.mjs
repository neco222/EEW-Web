import test from 'node:test';
import assert from 'node:assert/strict';
import {communityLogLayout} from '../docs/community-log-layout.js';

test('inactive logs reserve no map space even while a camera has its own region',()=>{
  const off={mode:'off',side:0,bottom:0,logHeight:0,top:0};
  for(const input of [{width:1280,height:720},{width:1280,height:720,cameraTop:360},
    {width:390,height:844},{width:390,height:844,cameraBottom:358},
    {width:360,height:470,cameraBottom:54}]){
    assert.deepEqual(communityLogLayout(input),off);
    assert.deepEqual(communityLogLayout({...input,active:false}),off);
  }
});

test('active desktop reports reserve the same side column with and without a camera',()=>{
  const idle=communityLogLayout({width:1280,height:720,active:true});
  const video=communityLogLayout({width:1280,height:720,cameraTop:360,active:true});
  assert.equal(idle.mode,'side');assert.equal(idle.side,336);assert.equal(idle.top,0);
  assert.equal(video.side,idle.side);assert.equal(video.top,360);assert.equal(video.bottom,0);
});

test('manually opened details retain the inline log even when automatic display is inactive',()=>{
  const desktop=communityLogLayout({width:1280,height:720,cameraTop:360,details:true});
  assert.equal(desktop.mode,'inline');assert.equal(desktop.side,336);assert.equal(desktop.top,360);
  const phone=communityLogLayout({width:390,height:700,details:true});
  assert.equal(phone.mode,'inline');assert.equal(phone.side,0);assert.equal(phone.bottom,300);
  assert.ok(700-26-phone.bottom>=330);
});

test('mobile reservations leave readable warning space and include report rows',()=>{
  for(const input of [{width:390,height:844,cameraBottom:358},{width:390,height:700,cameraBottom:106},
    {width:360,height:470,cameraBottom:54},{width:390,height:844}]){
    const layout=communityLogLayout({...input,active:true});
    assert.equal(layout.mode,'bottom');assert.ok(layout.logHeight>=60);
    assert.ok(input.height-26-layout.bottom>=330);
    assert.equal(layout.bottom,input.cameraBottom?input.cameraBottom+layout.logHeight:layout.logHeight);
  }
});

test('invalid and very short viewports never reserve negative space',()=>{
  assert.equal(communityLogLayout({width:0,height:720}).mode,'off');
  for(const height of [250,350,390]){
    const layout=communityLogLayout({width:600,height,cameraBottom:106,active:true});
    assert.ok(layout.bottom>=0);assert.ok(layout.logHeight>=0);
    assert.ok(layout.bottom<=Math.max(0,height-26-330));
  }
});

test('ending an active display releases its reservation while retaining a manual drawer',()=>{
  for(const size of [{width:1280,height:720,cameraTop:360},{width:390,height:844,cameraBottom:358}]){
    const visible=communityLogLayout({...size,active:true});
    const hidden=communityLogLayout({...size,active:false});
    const manual=communityLogLayout({...size,active:false,details:true});
    assert.notEqual(visible.mode,'off');
    assert.equal(hidden.mode,'off');assert.equal(hidden.side,0);assert.equal(hidden.bottom,0);
    assert.equal(manual.mode,'inline');
    assert.deepEqual(communityLogLayout({...size,active:true,details:true}),manual);
  }
});
