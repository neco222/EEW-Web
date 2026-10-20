import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {readMapObstacles} from '../docs/viewer-obstacles.js';
import {projectPoint} from '../docs/viewer-bridge.js';

const original = JSON.parse(fs.readFileSync(new URL('../docs/assets/project.json', import.meta.url))).targets[0];

function fixture() {
  const variables = Object.fromEntries(Object.entries({...original.variables, ...original.lists})
    .map(([id, [name, value]]) => [id, {name, value: structuredClone(value)}]));
  const stage = {isStage: true, variables};
  // Reading the first stage is sufficient; looking through clone arrays is not.
  const targets = new Proxy({0: stage}, {
    get(target, key) {
      if (key !== '0') throw new Error(`Unexpected target scan: ${String(key)}`);
      return target[0];
    },
  });
  const vm = {runtime: {targets}};
  const view = {
    width: 480, height: 360, stage: {width: 480, height: 360},
    camera: {x: 0, y: 0, zoom: 1}, layout: {offsetX: 0, offsetY: 0, uiScale: 1},
    viewport: {left: 0, top: 0, right: 480, bottom: 360, width: 480, height: 360},
    mapMode: 2, tab: 0,
  };
  const get = name => Object.values(variables).find(variable => variable.name === name);
  const set = (name, value) => { get(name).value = value; };
  const settings = get('7システム設定').value;
  settings[9] = true; settings[14] = 1; settings[16] = 1; settings[17] = true;
  settings[20] = 0; settings[22] = 0; settings[23] = true; settings[62] = false;
  set('#r:最新クラウド変数', ['initial']);
  return {vm, view, get, set, variables, settings};
}

function near(actual, expected) { assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`); }

test('protects regional intensity icons through the original area lookup without changing Stage data', () => {
  const f = fixture();
  const values = Array(188).fill(-3); values[0] = 3;
  f.set('map:表示する震度', values);
  const before = structuredClone(f.variables);
  const [rectangle] = readMapObstacles(f.vm, f.view);
  assert.equal(rectangle.kind, 'region-intensity');
  // Area 1 -> record 12 -> native coordinates (55.1, 108.4).
  near(rectangle.x, 295.1); near(rectangle.y, 71.6);
  assert.ok(rectangle.width >= 22);
  assert.deepEqual(f.variables, before);
});

test('uses the selected history entry and stops detailed stations at the next event ID', () => {
  const f = fixture();
  f.settings[22] = 2;
  const earthquakes = Array(40).fill('');
  earthquakes[17] = 1; earthquakes[37] = 4;
  f.set('5地震情報リスト', earthquakes);
  f.set('5-4ID付き各点震度', ['i001', 'j2', 1, 'i002', 'j4', 2]);
  f.set('d jms:x', [10, 100]); f.set('d jms:y', [20, 10]);
  let rectangles = readMapObstacles(f.vm, f.view);
  assert.equal(rectangles.length, 1);
  assert.equal(rectangles[0].kind, 'station-intensity');
  near(rectangles[0].x, 250); near(rectangles[0].y, 160);
  f.set('地図過去表示モード', 1);
  rectangles = readMapObstacles(f.vm, f.view);
  assert.equal(rectangles.length, 1);
  near(rectangles[0].x, 340); near(rectangles[0].y, 170);
});

test('protects only the real-time stations listed for drawing and deduplicates overlapping groups', () => {
  const f = fixture(); f.view.mapMode = 1;
  f.set('dtc:Xpix', [0, 100, 10000]); f.set('dtc:Ypix', [0, 0, 0]);
  f.set('ten:震度', [2, 4, 2]);
  f.set('ten:0', [1, '']); f.set('ten:1', [1, 2, 3, '']);
  const rectangles = readMapObstacles(f.vm, f.view);
  assert.equal(rectangles.length, 2);
  assert.ok(rectangles.every(rectangle => rectangle.kind === 'realtime-station'));
  assert.deepEqual(rectangles.map(rectangle => rectangle.x), [240, 340]);
});

test('protects normal and active EEW epicenters using their geographic source coordinates', () => {
  const f = fixture();
  const earthquakes = Array(20).fill(''); earthquakes[7] = 139.69; earthquakes[8] = 35.68;
  f.set('5地震情報リスト', earthquakes);
  const eew = Array(28).fill(''); eew[0] = 1; eew[5] = 132; eew[6] = 33;
  eew[14] = 0; eew[19] = 140; eew[20] = 35;
  f.set('0EEW', eew);
  const rectangles = readMapObstacles(f.vm, f.view);
  assert.equal(rectangles.length, 2);
  const ordinary = rectangles.find(rectangle => rectangle.kind === 'epicenter');
  const expected = projectPoint({lon: 139.69, lat: 35.68}, f.view);
  near(ordinary.x, expected.x); near(ordinary.y, expected.y);
  assert.equal(rectangles.filter(rectangle => rectangle.kind === 'eew-epicenter').length, 1);
});

test('includes tsunami epicenters and the upward extent of an observed tsunami bar', () => {
  const f = fixture(); f.view.mapMode = 3;
  f.set('9-1津波震源情報', [139, 35, 1]);
  const status = Array(14).fill(0); status[4] = 1; status[5] = 1; status[9] = 1;
  f.set('9津波関連', status);
  const observations = Array(201 * 7).fill(''); observations[2] = 1; observations[200 * 7 + 2] = 0.5;
  f.set('9-5各点津波観測状況', observations);
  const xs = Array(201).fill(''), ys = Array(201).fill(''); xs[0] = ys[0] = 0; xs[200] = 50; ys[200] = 0;
  f.set('d tsta:x', xs); f.set('d tsta:y', ys);
  const rectangles = readMapObstacles(f.vm, f.view);
  assert.equal(rectangles.filter(rectangle => rectangle.kind === 'tsunami-epicenter').length, 1);
  const bar = rectangles.find(rectangle => rectangle.kind === 'tsunami-station' && rectangle.x === 240);
  near(bar.y, 160.5);
  near(bar.height, 52.25);
  assert.equal(rectangles.filter(rectangle => rectangle.kind === 'tsunami-station').length, 2);
});

test('retains partially visible symbols but excludes distant off-screen symbols', () => {
  const f = fixture();
  f.set('dtc:Xpix', [-244, 10000]); f.set('dtc:Ypix', [0, 0]);
  f.set('ten:震度', [3, 3]); f.set('ten:1', [1, 2]);
  const rectangles = readMapObstacles(f.vm, f.view);
  assert.equal(rectangles.length, 1);
  assert.ok(rectangles[0].left < 0 && rectangles[0].right > 0);
});

test('returns cached geometry without walking station arrays again and invalidates on data or camera updates', () => {
  const f = fixture();
  f.set('dtc:Xpix', [0]); f.set('dtc:Ypix', [0]); f.set('ten:震度', [2]);
  const stations = [1]; f.set('ten:1', stations);
  const first = readMapObstacles(f.vm, f.view);
  stations[Symbol.iterator] = () => { throw new Error('Repeated station scan'); };
  assert.equal(readMapObstacles(f.vm, f.view), first);
  delete stations[Symbol.iterator];
  f.view.camera.x = 1;
  const moved = readMapObstacles(f.vm, f.view);
  assert.notEqual(moved, first);
  near(moved[0].x, 239);
  f.get('dtc:Xpix').value[0] = 10;
  f.get('#r:最新クラウド変数').value[0] = 'next-packet';
  const changed = readMapObstacles(f.vm, f.view);
  assert.notEqual(changed, moved);
  near(changed[0].x, 249);
  f.set('dtc:Xpix', [20]);
  near(readMapObstacles(f.vm, f.view)[0].x, 259);
});

test('responds to UI scaling and rejects missing or invalid viewer state', () => {
  const f = fixture();
  f.set('dtc:Xpix', [10]); f.set('dtc:Ypix', [20]); f.set('ten:震度', [2]); f.set('ten:1', [1]);
  const original = readMapObstacles(f.vm, f.view)[0];
  f.view.layout.uiScale = 2;
  const scaled = readMapObstacles(f.vm, f.view)[0];
  near(scaled.x, 260); near(scaled.y, 140);
  assert.ok(scaled.width > original.width);
  assert.deepEqual(readMapObstacles(null, f.view), []);
  assert.deepEqual(readMapObstacles(f.vm, null), []);
  assert.deepEqual(readMapObstacles(f.vm, {...f.view, stage: {width: 0, height: 0}}), []);
});
