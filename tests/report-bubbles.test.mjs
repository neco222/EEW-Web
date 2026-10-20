import test from 'node:test';
import assert from 'node:assert/strict';
import {layoutReportBubbles} from '../docs/report-bubbles.js';
import {projectPoint} from '../docs/viewer-bridge.js';

function view(width = 800, height = 600) {
  return {
    width, height,
    stage: {width, height},
    camera: {x: 0, y: 0, zoom: 1},
    layout: {offsetX: 0, offsetY: 0, uiScale: 1},
    viewport: {left: 0, top: 0, right: width, bottom: height, width, height},
  };
}

function postAt(x, y, {key = `${x}-${y}`, count = 1, expiresAt = 3000} = {}, current = view()) {
  const mapY = current.height / 2 - y;
  const lat = 2 * Math.atan(Math.exp((mapY + 374.04780730560344) / 572.9577951308232)) * 180 / Math.PI - 90;
  return {key, code: key, name: `地域${key}`, lon: 136 + (x - current.width / 2) / 10, lat, count, expiresAt};
}

const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

function assertSafe(bubbles, current, obstacles = []) {
  for (const bubble of bubbles) {
    assert.equal(bubble.width, 128);
    assert.equal(bubble.height, 48);
    assert.ok(bubble.left >= current.viewport.left + 30);
    assert.ok(bubble.top >= current.viewport.top + 34);
    assert.ok(bubble.right <= current.viewport.right);
    assert.ok(bubble.bottom <= current.viewport.bottom);
    for (const obstacle of obstacles) assert.equal(overlaps(bubble, obstacle), false);
  }
  for (let a = 0; a < bubbles.length; a++) {
    for (let b = a + 1; b < bubbles.length; b++) assert.equal(overlaps(bubbles[a], bubbles[b]), false);
  }
}

test('uses the original viewer projection and preserves the source post', () => {
  const current = view();
  // Saved original Scratch conversion example: map coordinates (57.6,-100.8).
  const post = {key: 'original', code: 1, name: '元座標', lat: 26.344250361649102, lon: 141.76, count: 7, expiresAt: 3000};
  const snapshot = structuredClone(post);
  const result = layoutReportBubbles([post], current);
  assert.equal(result.length, 1);
  assert.ok(Math.abs(result[0].anchor.x - 457.6) < 1e-8);
  assert.ok(Math.abs(result[0].anchor.y - 400.8) < 1e-8);
  const projected = projectPoint(post, current);
  assert.equal(result[0].anchor.x, projected.x);
  assert.equal(result[0].anchor.y, projected.y);
  assert.equal(result[0].count, 7);
  assert.equal(result[0].posts[0], post);
  assert.deepEqual(post, snapshot);
  assertSafe(result, current);
});

test('avoids native rectangles, protected controls, and every other bubble', () => {
  const current = view();
  const obstacles = [
    {left: 320, top: 200, right: 520, bottom: 390},
    {left: 620, top: 70, right: 780, bottom: 200},
    {left: 45, top: 430, right: 220, bottom: 590},
  ];
  const posts = [[400, 300], [600, 400], [250, 150], [730, 70], [90, 520], [600, 560]]
    .map(([x, y], index) => postAt(x, y, {key: `p${index}`}));
  const result = layoutReportBubbles(posts, current, obstacles);
  assert.equal(result.length, posts.length);
  assertSafe(result, current, obstacles);
});

test('rechecks collisions after edge clamping', () => {
  const current = view();
  const obstacle = {left: 650, top: 470, right: 800, bottom: 580};
  const post = postAt(795, 595);
  const result = layoutReportBubbles([post], current, [obstacle]);
  assert.equal(result.length, 1);
  assertSafe(result, current, [obstacle]);
});

test('extends a leader toward distant free space instead of covering native labels', () => {
  const current = view();
  const obstacle = {left: 250, top: 60, right: 750, bottom: 600};
  const result = layoutReportBubbles([postAt(500, 320)], current, [obstacle]);
  assert.equal(result.length, 1);
  assertSafe(result, current, [obstacle]);
  const bubble = result[0];
  assert.ok(bubble.right < 250);
  assert.ok(Math.hypot(bubble.x + 64 - bubble.anchor.x, bubble.y + 24 - bubble.anchor.y) > 250);
});

test('omits unplaceable bubbles when the viewport has no free space', () => {
  const current = view();
  assert.deepEqual(layoutReportBubbles([postAt(400, 300)], current, [current.viewport]), []);
  assert.deepEqual(layoutReportBubbles([postAt(100, 50)], view(140, 70)), []);
});

test('merges nearby regions without losing counts, identities, or expiration', () => {
  const current = view();
  const a = postAt(400, 300, {key: 'a', count: 3, expiresAt: 2000});
  const b = postAt(418, 310, {key: 'b', count: 5, expiresAt: 3000});
  const result = layoutReportBubbles([a, b], current);
  assert.equal(result.length, 1);
  assert.equal(result[0].count, 8);
  assert.deepEqual(result[0].keys, ['a', 'b']);
  assert.equal(result[0].posts.length, 2);
  assert.equal(result[0].expiresAt, 3000);
  assert.equal(result[0].anchor.x, projectPoint(b, current).x);
  assertSafe(result, current);
});

test('rejects outside and invalid points while tolerating malformed obstacles', () => {
  const current = view();
  const valid = postAt(400, 300);
  const invalid = [null, {}, {...valid, key: 'outside', lon: 0}, {...valid, key: 'pole', lat: 90},
    {...valid, key: 'nan', lat: NaN}, {...valid, key: 'none', count: 0}, {...valid, key: 'negative', count: -1}];
  const result = layoutReportBubbles([valid, ...invalid], current, [null, {}, {x: NaN, y: 0, width: 20, height: 20}]);
  assert.equal(result.length, 1);
  assert.deepEqual(layoutReportBubbles([valid], null), []);
  assert.deepEqual(layoutReportBubbles(null, current), []);
  assert.deepEqual(layoutReportBubbles([valid], {...current, viewport: {left: 0, top: 0, right: Infinity, bottom: 600}}), []);
  assertSafe(result, current);
});

test('accepts x/y rectangles and indexes a large obstacle collection once', () => {
  const current = view();
  let reads = 0;
  const obstacles = Array.from({length: 3000}, (_, index) => ({
    get x() { reads++; return 10000 + index; },
    y: 10000, width: 10, height: 10,
  }));
  obstacles.push({x: 300, y: 200, width: 200, height: 200});
  const result = layoutReportBubbles([postAt(400, 300), postAt(600, 400)], current, obstacles);
  assert.equal(result.length, 2);
  assert.equal(reads, 3000);
  assertSafe(result, current, [{left: 300, top: 200, right: 500, bottom: 400}]);
});
