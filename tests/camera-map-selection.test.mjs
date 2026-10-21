import test from 'node:test';
import assert from 'node:assert/strict';
import {selectMapCamera, CAMERA_MANUAL_HOLD_MS} from '../docs/camera-map-selection.js';
import {CAMERA_MANUAL_HOLD_MS as NATIVE_MANUAL_HOLD_MS} from '../docs/camera-lifetime.js';
import {distanceKm} from '../docs/camera-model.js';
import {LIVE_CAMERAS} from '../docs/live-cameras.js';

const BASE = Date.parse('2026-10-21T09:00:00+09:00');
const camera = (id, lat = 35.7, lon = 139.7) => Object.freeze({id, lat, lon,
  videoId: `cam${id.padStart(8, '0')}`, label: `Camera ${id}`, owner: 'Provider',
  sourceURL: `https://example.test/cameras/${id}`});
const catalog = Object.freeze([camera('a'), camera('b', 35.8, 139.7), camera('c', 43.0, 141.3)]);

test('only a known valid catalogue ID can create a standalone two-minute preview', () => {
  for (const id of [null, undefined, '', 'missing', 'https://example.test/live', {id: 'a'}]) {
    assert.equal(selectMapCamera(id, {}, catalog, BASE), null);
  }
  assert.equal(selectMapCamera('a', {}, [{...catalog[0], videoId: 'bad'}], BASE), null);
  assert.equal(selectMapCamera('a', {}, null, BASE), null);
  assert.equal(selectMapCamera('a', {}, catalog, NaN), null);
  assert.equal(selectMapCamera('a', {current: {kind: 'unknown'}}, catalog, BASE), null);
  const result = selectMapCamera('a', {}, catalog, BASE);
  assert.deepEqual(result.current, {kind: 'camera', name: 'Camera a', id: 'camera:a',
    manual: true, lat: 35.7, lon: 139.7, time: BASE});
  assert.equal(result.selected.id, 'a');
  assert.ok(result.choices.includes(result.selected));
  assert.equal(result.selected.distanceKm, 0);
  assert.deepEqual(result.choices.map(item => item.id), ['a', 'b']);
  assert.equal(result.manualUntil, BASE + 120000);
  assert.equal(CAMERA_MANUAL_HOLD_MS, NATIVE_MANUAL_HOLD_MS);
});

test('native and report sessions keep their exact source, deadline and existing choices', () => {
  for (const kind of ['eew', 'earthquake', 'community']) {
    const current = Object.freeze({kind, id: 'native-session', lat: 35.6, lon: 139.6,
      time: BASE - 50000, expiresAt: BASE + 35000, manual: kind === 'earthquake'});
    const existing = Object.freeze({...catalog[0], distanceKm: distanceKm(current, catalog[0])});
    const choices = Object.freeze([existing]);
    const state = Object.freeze({current, choices, selected: existing, manualUntil: BASE + 7000});
    const result = selectMapCamera('a', state, catalog, BASE);
    assert.strictEqual(result.current, current);
    assert.strictEqual(result.choices, choices);
    assert.strictEqual(result.selected, existing);
    assert.equal(result.manualUntil, state.manualUntil);
    assert.equal(result.current.expiresAt, BASE + 35000);
  }
});

test('an explicitly selected distant camera is appended without replacing the source or its nearby choices', () => {
  const current = Object.freeze({kind: 'eew', id: 'warning', lat: 35.6, lon: 139.6, time: BASE - 1000});
  const existing = Object.freeze({...catalog[0], distanceKm: 15});
  const choices = Object.freeze([existing]);
  const result = selectMapCamera('c', {current, choices, selected: existing}, catalog, BASE);
  assert.strictEqual(result.current, current);
  assert.deepEqual(result.choices.slice(0, 1), [existing]);
  assert.strictEqual(result.choices[0], existing);
  assert.equal(result.choices.length, 2);
  assert.strictEqual(result.choices[1], result.selected);
  assert.equal(result.selected.distanceKm, distanceKm(current, catalog[2]));
  assert.ok(result.selected.distanceKm > 300, 'an explicit selection is not an automatic nearest-camera decision');
  assert.equal(result.manualUntil, null);
  assert.equal(choices.length, 1);
});

test('repeated clicks of the same manual camera never renew its original deadline or source time', () => {
  const first = selectMapCamera('a', {}, catalog, BASE);
  for (const offset of [1, 60000, 119999]) {
    const again = selectMapCamera('a', first, catalog, BASE + offset);
    assert.strictEqual(again.current, first.current);
    assert.equal(again.current.time, BASE);
    assert.equal(again.manualUntil, BASE + 120000);
  }
  const reopened = selectMapCamera('a', first, catalog, BASE + 120000);
  assert.notStrictEqual(reopened.current, first.current);
  assert.equal(reopened.current.time, BASE + 120000);
  assert.equal(reopened.manualUntil, BASE + 240000);
});

test('a different manually selected camera starts its own fixed preview without changing the previous result', () => {
  const first = selectMapCamera('a', {}, catalog, BASE);
  const before = structuredClone(first);
  const second = selectMapCamera('b', first, catalog, BASE + 50000);
  assert.equal(second.current.id, 'camera:b');
  assert.equal(second.current.time, BASE + 50000);
  assert.equal(second.manualUntil, BASE + 170000);
  assert.equal(second.selected.id, 'b');
  assert.deepEqual(first, before);
});

test('co-located sources remain independently selectable even when the clicked ID ranks after five others', () => {
  const overlapping = Object.freeze(Array.from({length: 7}, (_, i) => camera(String(i))));
  const first = selectMapCamera('6', {}, overlapping, BASE);
  assert.equal(first.choices.length, 5);
  assert.equal(first.selected.id, '6');
  assert.ok(first.choices.includes(first.selected));
  assert.equal(new Set(first.choices.map(item => item.videoId)).size, 5);
  const second = selectMapCamera('5', first, overlapping, BASE + 1000);
  assert.equal(second.selected.id, '5');
  assert.equal(second.current.id, 'camera:5');
  assert.equal(second.manualUntil, BASE + 121000);
});

test('the real catalogue default supports both Shibuya sources without invented coordinates or URLs', () => {
  for (const id of ['fnn-shibuya', 'ann-shibuya']) {
    const result = selectMapCamera(id, {}, undefined, BASE);
    const known = LIVE_CAMERAS.find(item => item.id === id);
    assert.equal(result.selected.videoId, known.videoId);
    assert.equal(result.selected.sourceURL, known.sourceURL);
    assert.equal(result.current.lat, known.lat);
    assert.equal(result.current.lon, known.lon);
  }
});

test('invalid source coordinates cannot produce an infinite source-distance choice', () => {
  for (const lat of [NaN, Infinity, 91, '35.7']) {
    assert.equal(selectMapCamera('a', {current: {kind: 'earthquake', lat, lon: 139.7}}, catalog, BASE), null);
  }
});
