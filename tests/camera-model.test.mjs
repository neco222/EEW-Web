import test from 'node:test';
import assert from 'node:assert/strict';
import {distanceKm, rankCameras, cameraLayout, youtubeEmbedURL} from '../docs/camera-model.js';

const camera = (id, lat, lon, videoId = `testvideo0${id}`) => ({id, lat, lon, videoId, label: id, owner: '提供元', sourceURL: 'https://example.test/camera'});

test('uses geographic distance instead of prefecture labels and includes the threshold', () => {
  const origin={lat:35,lon:139};
  const near=camera('1',35.1,139),far=camera('2',40,140),middle=camera('3',35.8,139.1);
  assert.ok(Math.abs(distanceKm(origin,near)-11.1195)<.01);
  const input=[far,middle,near];
  assert.deepEqual(rankCameras(origin,input).map(c=>c.id),['1','3']);
  assert.deepEqual(input,[far,middle,near]);
  assert.equal(rankCameras(origin,[near],{maxDistanceKm:distanceKm(origin,near)}).length,1);
});

test('never invents coordinates, selects a distant camera, or embeds duplicate streams', () => {
  const quake={lat:43,lon:141};
  const first=camera('1',43.1,141),duplicate={...camera('2',43.2,141),videoId:first.videoId};
  const others=[camera('3',35,139),{...first,lat:null},{...first,videoId:'<script>'},{...first,sourceURL:'javascript:alert(1)'}];
  assert.equal(rankCameras(quake,[duplicate,first,...others]).length,1);
  assert.equal(rankCameras(quake,[duplicate,first])[0].id,'1');
  assert.deepEqual(rankCameras({lat:'43',lon:141},[first]),[]);
  assert.equal(distanceKm({},quake),Infinity);
});

test('wide cameras reserve a side column without reducing warning/history height', () => {
  const layout=cameraLayout({width:1280,height:720,expanded:true,hasEvent:true,communityDetails:true});
  assert.equal(layout.mode,'side');assert.equal(layout.side,336);assert.equal(layout.bottom,0);assert.equal(layout.video,true);
  assert.ok(1280-layout.side>=900);
});

test('portrait shelves leave native warning space; small screens have no background player', () => {
  const portrait=cameraLayout({width:390,height:844,expanded:true,hasEvent:true});
  assert.equal(portrait.mode,'bottom');assert.ok(844-26-portrait.bottom>=400);assert.equal(portrait.video,true);
  const small=cameraLayout({width:360,height:470,expanded:true,hasEvent:true});
  assert.equal(small.mode,'compact');assert.ok(470-26-small.bottom>=330);assert.equal(small.video,false);
  const community=cameraLayout({width:390,height:844,expanded:true,hasEvent:true,communityDetails:true});
  assert.equal(community.mode,'off');assert.equal(community.video,false);
  assert.equal(cameraLayout({width:1280,height:720,expanded:false,hasEvent:true}).mode,'off');
});

test('uses the official privacy-enhanced embed with an origin/referrer-compatible URL', () => {
  const url=new URL(youtubeEmbedURL('abcdefghijk','https://neco222.github.io/EEW-Web/'));
  assert.equal(url.host,'www.youtube-nocookie.com');assert.equal(url.pathname,'/embed/abcdefghijk');
  assert.equal(url.searchParams.get('origin'),'https://neco222.github.io');assert.equal(url.searchParams.get('enablejsapi'),'1');
  assert.equal(url.searchParams.get('mute'),'1');assert.equal(url.searchParams.get('playsinline'),'1');
  assert.throws(()=>youtubeEmbedURL('../bad','https://example.test'),TypeError);
  assert.throws(()=>youtubeEmbedURL('abcdefghijk','file:///tmp/example'),TypeError);
});

test('tall portrait screens reserve log space while retaining 400px of native warnings',()=>{
  const tall=cameraLayout({width:390,height:844,expanded:true,hasEvent:true});
  assert.ok(tall.bottom>=390);assert.ok(844-26-tall.bottom>=400);
  const short=cameraLayout({width:390,height:700,expanded:true,hasEvent:true});
  assert.equal(short.bottom,310);assert.ok(700-26-short.bottom>=350);
  const veryTall=cameraLayout({width:390,height:1200,expanded:true,hasEvent:true});
  assert.equal(veryTall.bottom,470);
});
