import test from 'node:test';
import assert from 'node:assert/strict';
import {layoutCameraMarkers} from '../docs/camera-map-layout.js';
import {projectPoint} from '../docs/viewer-bridge.js';
import {LIVE_CAMERAS} from '../docs/live-cameras.js';

function view(width = 800, height = 600) {
  return {width, height, stage: {width, height}, camera: {x: 0, y: 0, zoom: 1},
    layout: {offsetX: 0, offsetY: 0, uiScale: 1},
    viewport: {left: 0, top: 0, right: width, bottom: height, width, height}};
}

function cameraAt(x, y, id = 'camera', current = view()) {
  const mapX = current.camera.x + ((x / current.width - 0.5) * current.stage.width /
    current.layout.uiScale - current.layout.offsetX) / current.camera.zoom;
  const mapY = current.camera.y + ((0.5 - y / current.height) * current.stage.height /
    current.layout.uiScale - current.layout.offsetY) / current.camera.zoom;
  return {id, label: id, coordinateKind: 'approximate-scene', lon: 136 + mapX / 10,
    lat: 2 * Math.atan(Math.exp((mapY + 374.04780730560344) / 572.9577951308232)) * 180 / Math.PI - 90};
}

const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

function assertSafe(markers, current, obstacles = []) {
  const scaleX = Math.max(1, current.layout.uiScale * current.width / current.stage.width);
  const scaleY = Math.max(1, current.layout.uiScale * current.height / current.stage.height);
  const controls = {left: current.viewport.left, top: current.viewport.bottom - 116 * scaleY,
    right: current.viewport.left + 44 * scaleX, bottom: current.viewport.bottom};
  for (const marker of markers) {
    assert.equal(marker.width, 24);
    assert.equal(marker.height, 24);
    assert.equal(marker.key, marker.id);
    assert.equal(marker.x, marker.left);
    assert.equal(marker.y, marker.top);
    assert.ok(marker.left >= current.viewport.left + 30 * scaleX);
    assert.ok(marker.top >= current.viewport.top + 34 * scaleY);
    assert.ok(marker.right <= current.viewport.right);
    assert.ok(marker.bottom <= current.viewport.bottom);
    assert.equal(overlaps(marker, controls), false, 'native zoom/reset controls remain clear');
    assert.ok(Math.hypot(marker.x + 12 - marker.anchor.x, marker.y + 12 - marker.anchor.y) <= 108 + 1e-8);
    for (const obstacle of obstacles) assert.equal(overlaps(marker, obstacle), false);
  }
  for (let a = 0; a < markers.length; a++) {
    for (let b = a + 1; b < markers.length; b++) assert.equal(overlaps(markers[a], markers[b]), false);
  }
}

test('uses the native projection and follows pan, zoom and canvas resizing without mutating inputs', () => {
  const current = view();
  const camera = {id: 'original', label: '対象地域', coordinateKind: 'approximate-scene',
    lat: 26.344250361649102, lon: 141.76};
  const before = structuredClone([camera, current]);
  const [first] = layoutCameraMarkers([camera], current);
  close(first.anchor.x, 457.6);
  close(first.anchor.y, 400.8);
  close(first.x + 12, first.anchor.x);
  close(first.y + 12, first.anchor.y);
  assert.equal(first.camera, camera);
  const moved = {...current, width: 1200, height: 800, stage: {width: 600, height: 400},
    camera: {x: 30, y: -80, zoom: 1.5}, viewport: {left: 120, top: 0, right: 1200, bottom: 800, width: 1080, height: 800}};
  const [next] = layoutCameraMarkers([camera], moved);
  const point = projectPoint(camera, moved);
  close(next.anchor.x, point.x);
  close(next.anchor.y, point.y);
  close(next.x + 12, point.x);
  close(next.y + 12, point.y);
  assertSafe([next], moved);
  assert.deepEqual([camera, current], before);
});

test('different cameras at the same representative point fan out into individually selectable markers', () => {
  const current = view();
  const cameras = ['one', 'two', 'three', 'four'].map(id => cameraAt(400, 300, id));
  const markers = layoutCameraMarkers(cameras, current);
  assert.equal(markers.length, 4);
  assert.deepEqual(markers.map(marker => marker.id), cameras.map(camera => camera.id));
  for (const marker of markers) {
    close(marker.anchor.x, 400);
    close(marker.anchor.y, 300);
    assert.equal(marker.camera, cameras.find(camera => camera.id === marker.id));
  }
  assertSafe(markers, current);
});

test('active camera is placed first and keeps the only safe slot', () => {
  const current = view();
  const cameras = ['first', 'second', 'active'].map(id => cameraAt(400, 300, id));
  const obstacles = [
    {left: 0, top: 0, right: 384.5, bottom: 600},
    {left: 415.5, top: 0, right: 800, bottom: 600},
    {left: 384.5, top: 0, right: 415.5, bottom: 284.5},
    {left: 384.5, top: 315.5, right: 415.5, bottom: 600},
  ];
  const markers = layoutCameraMarkers(cameras, current, obstacles, {activeId: 'active'});
  assert.deepEqual(markers.map(marker => marker.id), ['active']);
  assert.equal(markers[0].active, true);
  close(markers[0].x + 12, markers[0].anchor.x);
  assertSafe(markers, current, obstacles);
});

test('native symbols and live report bubble rectangles win over nearby camera icons', () => {
  const current = view();
  const obstacles = [
    {left: 390, top: 290, right: 410, bottom: 310, kind: 'epicenter'},
    {x: 530, y: 270, width: 128, height: 48},
  ];
  const markers = layoutCameraMarkers([cameraAt(400, 300), cameraAt(600, 300, 'bubble-nearby')], current, obstacles);
  assert.equal(markers.length, 2, 'small nearby gaps remain usable without covering the bubble');
  assert.equal(markers[0].id, 'camera');
  assert.ok(Math.hypot(markers[0].x + 12 - markers[0].anchor.x, markers[0].y + 12 - markers[0].anchor.y) >= 24);
  assertSafe(markers, current, [{left: 390, top: 290, right: 410, bottom: 310},
    {left: 530, top: 270, right: 658, bottom: 318}]);
});

test('escapes dense native symbols at 84px when the nearer candidates are full', () => {
  const current = view();
  const native = {left: 350, top: 250, right: 450, bottom: 350, kind: 'region-intensity'};
  const markers = layoutCameraMarkers([cameraAt(400, 300, 'dense')], current, [native]);
  assert.equal(markers.length, 1);
  const marker = markers[0];
  close(Math.hypot(marker.x + 12 - marker.anchor.x, marker.y + 12 - marker.anchor.y), 84);
  assertSafe(markers, current, [native]);
  // Empty surroundings still prefer the unchanged projection over long leaders.
  const [near] = layoutCameraMarkers([marker.camera], current);
  close(near.x + 12, near.anchor.x);
  close(near.y + 12, near.anchor.y);
});

test('clamps edge markers then rechecks collisions and protects the clock and lower-left controls', () => {
  const current = view();
  const edge = cameraAt(799, 599, 'edge');
  const initial = layoutCameraMarkers([edge], current);
  assert.equal(initial.length, 1);
  assertSafe(initial, current);
  const obstacle = {left: initial[0].left, top: initial[0].top, right: initial[0].right, bottom: initial[0].bottom};
  assertSafe(layoutCameraMarkers([edge], current, [obstacle]), current, [obstacle]);
  const controls = layoutCameraMarkers([cameraAt(45, 565, 'zoom'), cameraAt(400, 20, 'clock')], current);
  assert.equal(controls.length, 2);
  assertSafe(controls, current);
  const scaled = {...current, stage: {width: 400, height: 300}};
  const scaledMarkers = layoutCameraMarkers([cameraAt(80, 500, 'scaled', scaled)], scaled);
  assert.equal(scaledMarkers.length, 1);
  assertSafe(scaledMarkers, scaled);
});

test('omits full, tiny, offscreen and malformed layouts without moving icons to distant free space', () => {
  const current = view();
  const camera = cameraAt(400, 300);
  assert.deepEqual(layoutCameraMarkers([camera], current, [current.viewport]), []);
  assert.deepEqual(layoutCameraMarkers([camera], view(40, 40)), []);
  assert.deepEqual(layoutCameraMarkers([cameraAt(900, 300)], current), []);
  assert.deepEqual(layoutCameraMarkers([camera], {...current, camera: {...current.camera, zoom: 0}}), []);
  assert.deepEqual(layoutCameraMarkers([camera], {...current, viewport: {...current.viewport, right: Infinity}}), []);
  assert.deepEqual(layoutCameraMarkers(null, current), []);
  assert.deepEqual(layoutCameraMarkers([camera], null), []);
});

test('keeps catalogue identity and approximate-scene metadata, with a maximum of 25 individual cameras', () => {
  const current = view();
  assert.equal(LIVE_CAMERAS.length, 25);
  const markers = layoutCameraMarkers(LIVE_CAMERAS, current);
  assert.ok(markers.length > 0 && markers.length <= 25);
  for (const marker of markers) {
    assert.equal(marker.camera, LIVE_CAMERAS.find(camera => camera.id === marker.id));
    assert.equal(marker.camera.coordinateKind, 'approximate-scene');
  }
  assertSafe(markers, current);
  const repeated = Array.from({length: 30}, (_, index) => cameraAt(100 + index * 20, 300, `id${index}`));
  assert.ok(layoutCameraMarkers(repeated, current).every(marker => Number(marker.id.slice(2)) < 25));
});

test('deduplicates IDs, tolerates malformed entries, and indexes a large obstacle input once', () => {
  const current = view();
  const camera = cameraAt(400, 300);
  let reads = 0;
  const obstacles = Array.from({length: 3000}, (_, index) => ({
    get x() { reads++; return 10000 + index; }, y: 10000, width: 10, height: 10,
  }));
  obstacles.push(null, {}, {left: NaN, top: 0, right: 5, bottom: 5});
  const before = structuredClone(camera);
  Object.freeze(camera);
  const markers = layoutCameraMarkers([null, {}, camera, camera, {...camera, id: 'pole', lat: 90},
    {...camera, id: 'invalid', lon: NaN}], current, obstacles);
  assert.deepEqual(markers.map(marker => marker.id), ['camera']);
  assert.equal(reads, 3000);
  assert.deepEqual(camera, before);
  assertSafe(markers, current);
});
