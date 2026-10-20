import test from 'node:test';
import assert from 'node:assert/strict';
import { CommunityPulses, formatPulseCount } from '../docs/community-pulses.js';
import { CommunityStore } from '../docs/community-core.js';

const area = (code, count, extra = {}) => ({ code, count, name: `地域 ${code}`, lat: 35, lon: 139, ...extra });
const state = (...areas) => ({ areas });
function setup() {
  let now = 0;
  return { pulses: new CommunityPulses({ now: () => now }), at: (time) => { now = time; } };
}

test('only positive live deltas create report counters, never current cumulative totals', () => {
  const { pulses } = setup();
  const next = state(area(250, 12), area(270, 4), area(275, 0));
  pulses.ingest(next, state(area(250, 10), area(270, 7)));
  assert.deepEqual(pulses.snapshot().map(({ code, count, expiresAt }) => ({ code, count, expiresAt })),
    [{ code: 250, count: 2, expiresAt: 3000 }]);
  pulses.ingest(next, next);
  assert.equal(pulses.snapshot()[0].count, 2);
});

test('same-region arrivals accumulate and extend to 3 seconds after the latest addition', () => {
  const { pulses, at } = setup();
  pulses.ingest(state(area(250, 3)), state());
  at(2500);
  pulses.ingest(state(area(250, 5)), state(area(250, 3)));
  assert.equal(pulses.snapshot()[0].count, 5);
  assert.equal(pulses.snapshot()[0].createdAt, 0);
  assert.equal(pulses.snapshot()[0].expiresAt, 5500);
  at(5499); assert.equal(pulses.snapshot().length, 1);
  at(5500); assert.equal(pulses.snapshot().length, 0);
});

test('new reports in another region cannot extend an older region counter', () => {
  const { pulses, at } = setup();
  pulses.ingest(state(area(250, 1)), state());
  at(2500);
  pulses.ingest(state(area(250, 1), area(270, 2)), state(area(250, 1)));
  assert.equal(pulses.snapshot().find((pulse) => pulse.code === 250).expiresAt, 3000);
  assert.equal(pulses.snapshot().find((pulse) => pulse.code === 270).expiresAt, 5500);
  at(3000);
  assert.deepEqual(pulses.snapshot().map((pulse) => pulse.code), [270]);
});

test('an expired region starts a new counter instead of carrying its previous pulse count', () => {
  const { pulses, at } = setup();
  pulses.ingest(state(area(250, 5)), state());
  at(3000);
  pulses.ingest(state(area(250, 6)), state(area(250, 5)));
  assert.equal(pulses.snapshot()[0].count, 1);
  assert.equal(pulses.snapshot()[0].createdAt, 3000);
});

test('missing/invalid positions and malformed counts never get guessed into map posts', () => {
  const { pulses } = setup();
  pulses.ingest(state(area(900, 2, { lat: null, lon: null }), area(901, 2, { lat: NaN }),
    area(902, 2, { lat: 91 }), area(903, 2, { lon: 181 }), area(904, 2, { lat: '35' }),
    area(250, -3), area(270, '3'), area(275, Infinity)), state());
  assert.deepEqual(pulses.snapshot(), []);
});

test('a clock moving backwards cannot extend or resurrect a pulse', () => {
  const { pulses, at } = setup();
  at(1000); pulses.ingest(state(area(250, 1)), state());
  at(500); assert.equal(pulses.snapshot()[0].expiresAt, 4000);
  at(4000); assert.deepEqual(pulses.snapshot(), []);
  at(1000); assert.deepEqual(pulses.snapshot(), []);
});

test('snapshot and source mutation do not affect retained counters; clear hides all posts', () => {
  const { pulses } = setup();
  const input = state(area(250, 2));
  pulses.ingest(input, state());
  input.areas[0].count = 100;
  pulses.snapshot()[0].count = 500;
  assert.equal(pulses.snapshot()[0].count, 2);
  pulses.clear(); assert.deepEqual(pulses.snapshot(), []);
});

const BASE = Date.parse('2026-10-20T12:00:00+09:00');
const raw = (id, time = '2026/10/20 12:00:00.000') => ({ code: 561, id, area: 250, time });
const aggregate = () => ({ code: 9611, id: 'aggregate', time: '2026/10/20 12:00:10.000',
  started_at: '2026/10/20 12:00:00.000', updated_at: '2026/10/20 12:00:10.000',
  count: 120, confidence: 0.98, area_confidences: { 250: { count: 120 } } });
function liveSetup() {
  const pulseClock = setup();
  const store = new CommunityStore({ now: () => BASE + 60000 });
  return { ...pulseClock, store, accept(message) {
    const previous = store.snapshot();
    if (store.ingest(message).accepted) pulseClock.pulses.ingestLive(store.snapshot(), { previous, message });
  } };
}

test('an initial cumulative 9611 arriving before history cannot masquerade as 120 new reports', () => {
  const { pulses, store, accept } = liveSetup();
  accept(aggregate());
  assert.equal(store.snapshot().total, 120);
  assert.deepEqual(pulses.snapshot(), []);
  accept(raw('new-after-event', '2026/10/20 12:00:20.000'));
  assert.equal(store.snapshot().total, 121);
  assert.equal(pulses.snapshot()[0].count, 1);
});

test('561 followed by initial 9611 shows one new report, never a +119 revision or renewed expiry', () => {
  const { pulses, store, accept, at } = liveSetup();
  accept(raw('first'));
  assert.equal(pulses.snapshot()[0].count, 1);
  at(2500); accept(aggregate());
  assert.equal(store.snapshot().total, 120);
  assert.equal(pulses.snapshot()[0].count, 1);
  assert.equal(pulses.snapshot()[0].expiresAt, 3000);
  at(3000); assert.deepEqual(pulses.snapshot(), []);
});

test('a unique 561 already included by an aggregate is still exactly one fresh received report', () => {
  const { pulses, store, accept } = liveSetup();
  accept(aggregate());
  accept(raw('late-unique', '2026/10/20 12:00:05.000'));
  assert.equal(store.snapshot().total, 120); // cumulative count already covers it
  assert.equal(pulses.snapshot()[0].count, 1);
  accept(raw('late-unique', '2026/10/20 12:00:05.000'));
  assert.equal(pulses.snapshot()[0].count, 1); // feed/store acceptance excludes redelivery
});

test('one 561 cannot pulse other regions whose cumulative counts changed', () => {
  const { pulses } = setup();
  pulses.ingestLive(state(area(250, 120), area(270, 999)), { previous: state(), message: raw('one') });
  assert.deepEqual(pulses.snapshot().map(({ code, count }) => ({ code, count })), [{ code: 250, count: 1 }]);
  pulses.ingestLive(state(area(250, 120)), { message: { code: 555, area: 250 } });
  assert.equal(pulses.snapshot()[0].count, 1);
});

test('unlocated 561 messages never acquire invented positions, even beside located totals', () => {
  const { pulses } = setup();
  pulses.ingestLive(state(area(900, 5, { lat: null, lon: null }), area(250, 3)), { message: { code: 561, area: 900 } });
  assert.deepEqual(pulses.snapshot(), []);
});

test('large damage counters use a short Japanese unit while retaining exact small counts', () => {
  assert.equal(formatPulseCount(1), '+1件');
  assert.equal(formatPulseCount(9999), '+9,999件');
  assert.equal(formatPulseCount(120000), '+12万件');
  assert.ok(formatPulseCount(2147483647).length <= 10);
  assert.ok(formatPulseCount(Number.MAX_SAFE_INTEGER).length <= 12);
});
