import test from 'node:test';
import assert from 'node:assert/strict';
import {communityLogLayout} from '../docs/community-log-layout.js';

test('desktop reports reserve the same side column with and without a camera',()=>{
  const idle=communityLogLayout({width:1280,height:720});
  const video=communityLogLayout({width:1280,height:720,cameraTop:360});
  assert.equal(idle.mode,'side');assert.equal(idle.side,336);assert.equal(idle.top,0);
  assert.equal(video.side,idle.side);assert.equal(video.top,360);assert.equal(video.bottom,0);
});

test('details retain the report view inside their normal reserved region',()=>{
  const desktop=communityLogLayout({width:1280,height:720,cameraTop:360,details:true});
  assert.equal(desktop.mode,'inline');assert.equal(desktop.side,336);assert.equal(desktop.top,360);
  const phone=communityLogLayout({width:390,height:700,details:true});
  assert.equal(phone.mode,'inline');assert.equal(phone.side,0);assert.equal(phone.bottom,300);
  assert.ok(700-26-phone.bottom>=330);
});

test('mobile reservations leave readable warning space and include report rows',()=>{
  for(const input of [{width:390,height:844,cameraBottom:358},{width:390,height:700,cameraBottom:106},
    {width:360,height:470,cameraBottom:54},{width:390,height:844}]){
    const layout=communityLogLayout(input);
    assert.equal(layout.mode,'bottom');assert.ok(layout.logHeight>=60);
    assert.ok(input.height-26-layout.bottom>=330);
    assert.equal(layout.bottom,input.cameraBottom?input.cameraBottom+layout.logHeight:layout.logHeight);
  }
});

test('invalid and very short viewports never reserve negative space',()=>{
  assert.equal(communityLogLayout({width:0,height:720}).mode,'off');
  for(const height of [250,350,390]){
    const layout=communityLogLayout({width:600,height,cameraBottom:106});
    assert.ok(layout.bottom>=0);assert.ok(layout.logHeight>=0);
    assert.ok(layout.bottom<=Math.max(0,height-26-330));
  }
});
