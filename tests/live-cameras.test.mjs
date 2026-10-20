import test from 'node:test';
import assert from 'node:assert/strict';
import {LIVE_CAMERAS} from '../docs/live-cameras.js';
import {rankCameras} from '../docs/camera-model.js';

test('official catalogue entries keep source attribution and valid camera identifiers', () => {
  assert.ok(LIVE_CAMERAS.length>=20);
  assert.ok(new Set(LIVE_CAMERAS.map(camera=>camera.region)).size>=10);
  assert.equal(new Set(LIVE_CAMERAS.map(camera=>camera.id)).size,LIVE_CAMERAS.length);
  assert.equal(new Set(LIVE_CAMERAS.map(camera=>camera.videoId)).size,LIVE_CAMERAS.length);
  for(const camera of LIVE_CAMERAS){
    assert.match(camera.videoId,/^[\w-]{11}$/);
    for(const key of ['sourceURL','watchURL','channelURL'])assert.equal(new URL(camera[key]).protocol,'https:');
    assert.ok(camera.owner&&camera.label&&Number.isFinite(Date.parse(camera.verifiedAt)));
    assert.ok(camera.lat>=20&&camera.lat<=46&&camera.lon>=122&&camera.lon<=146);
    assert.equal(camera.coordinateKind,'approximate-scene');
    assert.equal(typeof camera.maySwitchView,'boolean');
  }
});

test('real catalogue proximity picks the local city and never a different end of Japan', () => {
  const tokyo=rankCameras({lat:35.62,lon:139.77},LIVE_CAMERAS);
  const sapporo=rankCameras({lat:43.06,lon:141.35},LIVE_CAMERAS);
  const naha=rankCameras({lat:26.2,lon:127.65},LIVE_CAMERAS);
  assert.ok(tokyo.length&&tokyo[0].region==='関東');
  assert.ok(sapporo.length&&sapporo[0].region==='北海道');
  assert.ok(naha.length&&naha[0].region==='沖縄');
  for(const list of [tokyo,sapporo,naha])assert.ok(list.every(camera=>camera.distanceKm<=300));
});
