import test from 'node:test';
import assert from 'node:assert/strict';
import { CommunityFocus } from '../docs/community-focus.js';
import { CommunityStore } from '../docs/community-core.js';
import { getP2PArea } from '../docs/p2p-areas.js';

const BASE = Date.parse('2026-10-20T12:00:00+09:00');
const stamp = milliseconds => new Date(milliseconds).toISOString();
const message = (id, area = 250, time = BASE, extra = {}) => ({ code: 561, id, area, time: stamp(time), ...extra });
function setup(options = {}) {
  let now = BASE;
  const focus = new CommunityFocus({ now: () => now, ...options });
  return { focus, at: time => { now = BASE + time; },
    live: (raw, extra = {}) => focus.ingestLive({ areas: [] }, { message: raw, receivedAt: now, ...extra }) };
}

test('one accepted individual report pans only after the 400ms batch window, even with no aggregate delta', () => {
  const f = setup();
  assert.equal(f.live(message('one')).accepted, true);
  assert.equal(f.focus.snapshot().readyAt, BASE + 400);
  assert.equal(f.focus.take(), null);
  f.at(399); assert.equal(f.focus.take(), null);
  f.at(400);
  const result = f.focus.take();
  const area = getP2PArea(250);
  assert.equal(result.kind, 'community-reports');
  assert.equal(result.count, 1);
  assert.equal(result.lat, area.lat);
  assert.equal(result.lon, area.lon);
  assert.equal(result.expiresAt, BASE + 5000);
  assert.deepEqual(result.areas.map(({ code, count }) => ({ code, count })), [{ code: 250, count: 1 }]);
  assert.equal(f.focus.take(), null);
});

test('history, replay, explicit rejection, other codes and cumulative 9611 snapshots cannot initiate a pan', () => {
  const f = setup();
  for (const source of ['history', 'replay', 'backfill', '', null, false]) {
    assert.equal(f.live(message(String(source)), { source }).accepted, false);
  }
  assert.equal(f.live(message('history-flag'), { history: true }).accepted, false);
  assert.equal(f.live(message('replay-flag'), { replay: true }).accepted, false);
  assert.equal(f.live(message('rejected'), { accepted: false }).accepted, false);
  assert.equal(f.live({ ...message('total'), code: 9611, count: 120 }).accepted, false);
  assert.equal(f.live({ ...message('earthquake'), code: 551 }).accepted, false);
  f.at(400); assert.equal(f.focus.take(), null);
  assert.equal(f.focus.snapshot().pendingCount, 0);
});

test('positions come exclusively from known official regional coordinates, never input snapshot or payload', () => {
  const f = setup();
  for (const area of [900, 901, 905, 999, null, true, [], [250], '0250']) {
    assert.equal(f.live(message(`unknown-${String(area)}`, area, BASE, { lat: 35, lon: 139 })).accepted, false);
  }
  f.focus.ingestLive({ areas: [{ code: 250, lat: 0, lon: 0, count: 9999 }] },
    { message: message('official', '250', BASE, { lat: -10, lon: -10 }), receivedAt: BASE, source: 'live' });
  f.at(400);
  const result = f.focus.take();
  assert.equal(result.lat, getP2PArea(250).lat);
  assert.equal(result.lon, getP2PArea(250).lon);
  assert.equal(result.count, 1);
});

test('nearby regions join one report-weighted centre and later arrivals do not postpone the initial batch', () => {
  const f = setup();
  f.live(message('tokyo-a', 250));
  f.at(200); f.live(message('kanagawa', 270, BASE + 200));
  f.at(350); f.live(message('tokyo-b', 250, BASE + 350));
  assert.equal(f.focus.snapshot().readyAt, BASE + 400);
  f.at(400);
  const result = f.focus.take();
  assert.equal(result.count, 3);
  assert.deepEqual(result.areas.map(({ code, count }) => ({ code, count })), [{ code: 250, count: 2 }, { code: 270, count: 1 }]);
  assert.equal(result.lat, (getP2PArea(250).lat * 2 + getP2PArea(270).lat) / 3);
  assert.equal(result.lon, (getP2PArea(250).lon * 2 + getP2PArea(270).lon) / 3);
  assert.equal(result.bounds.south, getP2PArea(270).lat);
  assert.equal(result.bounds.north, getP2PArea(250).lat);
  assert.equal(result.receivedAt, BASE + 350);
});

test('a distant minority is consumed with the chosen batch and is not replayed as a later map jump', () => {
  const f = setup();
  f.live(message('sapporo', 10));
  f.live(message('tokyo', 250));
  f.live(message('kanagawa', 270));
  f.at(400);
  const result = f.focus.take();
  assert.equal(result.count, 2);
  assert.equal(result.discardedCount, 1);
  assert.deepEqual(result.areas.map(area => area.code), [250, 270]);
  f.at(3400); assert.equal(f.focus.take(), null);
});

test('equally supported remote groups prefer the latest receipt, with deterministic area-code ties', () => {
  const f = setup();
  f.live(message('tokyo', 250));
  f.at(100); f.live(message('sapporo', 10, BASE + 100));
  f.at(400); assert.equal(f.focus.take().areas[0].code, 10);
  const a = setup(); const b = setup();
  a.live(message('tokyo', 250)); a.live(message('sapporo', 10));
  b.live(message('sapporo', 10)); b.live(message('tokyo', 250));
  a.at(400); b.at(400);
  assert.deepEqual(a.focus.take(), b.focus.take());
});

test('movement interval is at least three seconds; fresh reports accumulate while throttled', () => {
  const f = setup();
  f.live(message('first'));
  f.at(400); assert.ok(f.focus.take());
  f.at(600); f.live(message('second', 270, BASE + 600));
  f.at(2900); f.live(message('third', 275, BASE + 2900));
  assert.equal(f.focus.snapshot().readyAt, BASE + 3400);
  f.at(3399); assert.equal(f.focus.take(), null);
  f.at(3400);
  assert.equal(f.focus.take().count, 2);
  assert.equal(f.focus.snapshot().lastFocusedAt, BASE + 3400);
});

test('candidate receipt TTL expires at five seconds, including after delayed polling or a stale callback', () => {
  const f = setup();
  f.live(message('expires'));
  f.at(5000);
  assert.equal(f.focus.take(), null);
  assert.equal(f.focus.snapshot().readyAt, null);
  assert.equal(f.live(message('delayed', 250, BASE + 5000), { receivedAt: BASE }).reason, 'expired');
  f.at(5001); assert.equal(f.focus.take(), null);
  assert.equal(f.focus.snapshot().lastFocusedAt, null);
});

test('expired older reports cannot influence a fresh group still waiting through a long movement interval', () => {
  const f = setup({ intervalMs: 6000 });
  f.live(message('initial'));
  f.at(400); f.focus.take();
  f.at(600); f.live(message('old', 10, BASE + 600));
  f.at(4000); f.live(message('fresh', 250, BASE + 4000));
  f.at(6400);
  const result = f.focus.take();
  assert.equal(result.count, 1);
  assert.equal(result.areas[0].code, 250);
});

test('a higher-priority action discards candidates, including during the batch, without resetting the movement interval', () => {
  const f = setup();
  f.live(message('cancelled-by-manual'));
  f.at(200); assert.equal(f.focus.take({ blocked: true }), null);
  f.at(1000); assert.equal(f.focus.take(), null);
  assert.equal(f.live(message('cancelled-by-manual', 250, BASE + 1000)).reason, 'duplicate');
  f.live(message('new-after-manual', 270, BASE + 1000));
  f.at(1400); assert.ok(f.focus.take());
  f.at(1500); f.live(message('pause', 10, BASE + 1500)); f.focus.clear();
  f.at(2000); f.live(message('resume', 250, BASE + 2000));
  f.at(2400); assert.equal(f.focus.take(), null);
  f.at(4400); assert.equal(f.focus.take().areas[0].code, 250);
});

test('ID and UID retransmissions never renew candidate arrival or trigger another movement after consumption', () => {
  const f = setup();
  f.live(message('one', 250, BASE, { uid: 'uid-one' }));
  f.at(300);
  assert.equal(f.live(message('redelivered', 250, BASE + 300, { uid: 'uid-one' })).reason, 'duplicate');
  assert.equal(f.live(message('one', 250, BASE + 300, { uid: 'uid-two' })).reason, 'duplicate');
  assert.equal(f.focus.snapshot().readyAt, BASE + 400);
  f.at(400); assert.equal(f.focus.take().count, 1);
  f.at(4000);
  assert.equal(f.live(message('third-id', 250, BASE + 4000, { uid: 'uid-two' })).reason, 'duplicate');
  f.at(4500); assert.equal(f.focus.take(), null);
});

test('a retransmission linking two aliases merges queued reports and cannot requeue a consumed report', () => {
  const f = setup();
  f.live(message('first', 250, BASE, { uid: 'uid-first' }));
  f.live(message('second', 270, BASE, { uid: 'uid-second' }));
  assert.equal(f.live(message('first', 250, BASE, { uid: 'uid-second' })).reason, 'duplicate');
  assert.equal(f.focus.snapshot().pendingCount, 1);
  f.at(400); assert.equal(f.focus.take().count, 1);
  f.at(1000); f.live(message('separate', 10, BASE + 1000, { uid: 'uid-separate' }));
  assert.equal(f.live(message('separate', 10, BASE + 1000, { uid: 'uid-second' })).reason, 'duplicate');
  assert.equal(f.focus.snapshot().pendingCount, 0);
  f.at(3400); assert.equal(f.focus.take(), null);
});

test('late source reports and excessive future source clocks never move the map; boundaries are explicit', () => {
  const f = setup();
  assert.equal(f.live(message('old', 250, BASE - 30_001)).reason, 'old-source');
  assert.equal(f.live(message('future', 250, BASE + 5001)).reason, 'future-source');
  assert.equal(f.live(message('receipt-future'), { receivedAt: BASE + 1 }).reason, 'invalid-receipt');
  assert.equal(f.live(message('no-receipt'), { receivedAt: undefined }).reason, 'invalid-receipt');
  assert.equal(f.live(message('source-boundary', 250, BASE - 30_000)).accepted, true);
  assert.equal(f.live(message('future-boundary', 270, BASE + 5000)).accepted, true);
  f.at(400); assert.equal(f.focus.take().count, 2);
});

test('JST source timestamps are parsed without depending on local time zone', () => {
  const f = setup();
  assert.equal(f.live({ ...message('jst'), time: '2026/10/20 12:00:00.000' }).accepted, true);
  assert.equal(f.live({ ...message('bad-calendar'), time: '2026/02/30 12:00:00.000' }).accepted, false);
  assert.equal(f.live({ ...message('bad-time'), time: 'bad' }).accepted, false);
  assert.equal(f.live(message('', 250)).accepted, false);
  assert.equal(f.live(null).accepted, false);
});

test('a 9611 racing history cannot pan; an accepted recent individual already covered by it still can', () => {
  const f = setup();
  const store = new CommunityStore({ now: () => BASE });
  const aggregate = { code: 9611, id: 'total', time: stamp(BASE), started_at: stamp(BASE - 10_000),
    updated_at: stamp(BASE), count: 120, confidence: 0.98, area_confidences: { 250: { count: 120 } } };
  const accept = raw => {
    const previous = store.snapshot();
    if (store.ingest(raw).accepted) f.focus.ingestLive(store.snapshot(), { previous, message: raw, receivedAt: BASE });
  };
  accept(aggregate);
  assert.equal(f.focus.snapshot().pendingCount, 0);
  store.ingestHistory([message('seed', 250, BASE - 2000)]);
  accept(message('seed', 250, BASE - 2000));
  assert.equal(f.focus.snapshot().pendingCount, 0);
  accept(message('unique-covered', 250, BASE - 1000));
  accept(message('unique-covered', 250, BASE - 1000));
  assert.equal(store.snapshot().total, 120);
  f.at(400); assert.equal(f.focus.take().count, 1);
});

test('large bursts stay bounded and a stopped or blocked batch does not later resurface', () => {
  const f = setup();
  for (let i = 0; i < 3000; i++) f.live(message(`burst-${i}`, i % 2 ? 250 : 270));
  assert.equal(f.focus.snapshot().pendingCount, 512);
  f.at(400); assert.equal(f.focus.take().count, 512);
  f.at(1000); f.live(message('queued', 10, BASE + 1000));
  assert.equal(f.focus.take({ blocked: true }), null);
  f.at(4500); assert.equal(f.focus.take(), null);
});

test('input and output mutation cannot change later decisions; backward wall-clock changes cannot bypass throttling', () => {
  const f = setup();
  const raw = message('one');
  f.live(raw); raw.area = 10;
  f.at(400);
  const result = f.focus.take();
  result.areas[0].code = 10; result.bounds.south = -90;
  f.focus.snapshot().lastFocusedAt = null;
  f.at(100); f.live(message('next', 270, BASE + 100));
  assert.equal(f.focus.take(), null);
  assert.equal(f.focus.snapshot().lastFocusedAt, BASE + 400);
  f.at(3400); assert.equal(f.focus.take().areas[0].code, 270);
});

test('invalid constructor and clock values fail predictably', () => {
  for (const options of [{ now: 5 }, { batchMs: 0 }, { batchMs: 5000 }, { intervalMs: NaN },
    { maxAgeMs: 1 }, { sourceMaxAgeMs: -1 }, { nearbyKm: -1 }]) {
    assert.throws(() => new CommunityFocus(options));
  }
  assert.throws(() => new CommunityFocus({ now: () => NaN }).snapshot(), TypeError);
});
