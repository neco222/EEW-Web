import test from 'node:test';
import assert from 'node:assert/strict';
import { CommunityStore, parseP2PTime, COMMUNITY_WINDOW_MS } from '../docs/community-core.js';
import { P2P_AREAS, getP2PArea } from '../docs/p2p-areas.js';

const BASE = Date.parse('2026-10-20T12:00:00+09:00');
function stamp(at) {
  return new Date(at + 9 * 60 * 60000).toISOString().replaceAll('-', '/').replace('T', ' ').replace('Z', '');
}
const report = (id, area, at, extra = {}) => ({ code: 561, id, area, time: stamp(at), ...extra });
const evaluation = (id, start, end, counts, extra = {}) => ({
  code: 9611, id, time: stamp(end + 100), started_at: stamp(start), updated_at: stamp(end),
  confidence: 0.97015,
  count: Object.values(counts).reduce((sum, count) => sum + count, 0),
  area_confidences: Object.fromEntries(Object.entries(counts).map(([code, count]) => [code, { count, confidence: 0, display: 'E' }])),
  ...extra,
});
function clockStore(time = BASE + 120000, windowMs = COMMUNITY_WINDOW_MS) {
  let now = time;
  return { store: new CommunityStore({ now: () => now, windowMs }), setNow: (next) => { now = next; } };
}

test('JST parser is explicit, accepts API precision and validates calendar/time fields', () => {
  assert.equal(parseP2PTime('2026/10/20 12:00:00'), BASE);
  assert.equal(parseP2PTime('2026/10/20 12:00:00.1'), BASE + 100);
  assert.equal(parseP2PTime('2026/10/20 12:00:00.012'), BASE + 12);
  assert.equal(parseP2PTime('2026-10-20T03:00:00Z'), BASE);
  assert.equal(parseP2PTime('2026-10-20T12:00:00+09:00'), BASE);
  assert.equal(parseP2PTime('2024/02/29 23:59:59.999'), Date.parse('2024-02-29T23:59:59.999+09:00'));
  for (const value of ['2026/02/29 12:00:00', '2026/02/30 12:00:00', '2026/10/20 24:00:00',
    '2026/10/20 12:60:00', '2026/10/20 12:00:60', '2026-10-20T03:00:00+25:00', '', null, 0]) {
    assert.equal(parseP2PTime(value), null, String(value));
  }
});

test('official region coordinates stay attached to the correct prefecture and code', () => {
  assert.equal(P2P_AREAS.length, 141);
  assert.equal(new Set(P2P_AREAS.map((area) => area.code)).size, P2P_AREAS.length);
  assert.deepEqual(getP2PArea('010'), { code: 10, name: '北海道 石狩', prefecture: '北海道', region: '北海道', lat: 43.062, lon: 141.354 });
  assert.equal(getP2PArea(250).prefecture, '東京');
  assert.equal(getP2PArea(514).name, '島根隠岐');
  assert.equal(getP2PArea(541).name, '山口西部');
  assert.equal(getP2PArea(705).lat, 24.286);
  assert.equal(getP2PArea(710).lon, 131.232);
  assert.equal(getP2PArea(905).lat, null);
  assert.equal(getP2PArea(952), null); // auxiliary EEW codes are not report locations
  for (const area of P2P_AREAS.filter((entry) => entry.lat !== null)) {
    assert.ok(area.lat >= 24 && area.lat <= 46 && area.lon >= 122 && area.lon <= 146);
    assert.ok(area.prefecture.length > 0);
  }
});

test('real public history fixture is a user report and duplicate ids/UIDs count once', () => {
  // https://api.p2pquake.net/v2/history?codes=561&limit=3 , read 2026-10-20.
  const fixture = { area: 250, code: 561, created_at: '2026/10/20 12:02:04.760', hop: 6,
    id: '6ad6d9acc58757000704c93d', time: '2026/10/20 12:02:04.755',
    uid: '0021520261020120205179', ver: '20150406' };
  const { store } = clockStore(BASE + 180000);
  assert.equal(store.ingest(fixture).accepted, true);
  assert.equal(store.ingest(fixture).reason, 'duplicate');
  assert.equal(store.ingest({ ...fixture, id: 'redelivered-with-another-id' }).reason, 'duplicate');
  assert.equal(store.ingest({ ...fixture, uid: 'another-uid' }).reason, 'duplicate');
  assert.equal(store.snapshot().total, 1);
  assert.equal(store.snapshot().kind, 'user-reports');
  assert.equal(store.snapshot().unit, 'reports');
  assert.equal(store.snapshot().areas[0].source, '561');
  assert.equal('intensity' in store.snapshot().areas[0], false);
});

test('9611 cumulative revisions replace instead of sum, even when the same id is reused', () => {
  const { store } = clockStore();
  const first = evaluation('event', BASE, BASE + 10000, { 250: 3 });
  const second = evaluation('event', BASE, BASE + 30000, { 250: 7, 270: 2 });
  store.ingest(first);
  store.ingest(second);
  store.ingest(second);
  store.ingest(first);
  assert.equal(store.snapshot().total, 9);
  assert.deepEqual(store.snapshot().areas.map((area) => [area.code, area.count]), [[250, 7], [270, 2]]);
  assert.equal(store.snapshot().mode, 'aggregate');
});

test('UID retransmissions converge across reconnect order and cannot renew occurrence time', () => {
  const a = report('a', 250, BASE, { uid: 'one-report' });
  const b = report('b', 250, BASE + 1000, { uid: 'one-report' });
  const { store: forward, setNow: setForward } = clockStore();
  const { store: reverse, setNow: setReverse } = clockStore();
  [a, b].forEach((message) => forward.ingest(message));
  [b, a].forEach((message) => reverse.ingest(message));
  assert.deepEqual(forward.snapshot(), reverse.snapshot());
  setForward(BASE + COMMUNITY_WINDOW_MS);
  setReverse(BASE + COMMUNITY_WINDOW_MS);
  assert.equal(forward.snapshot().total, 0);
  assert.equal(reverse.snapshot().total, 0);
});

test('561 history plus 9611 snapshots never double count covered reports', () => {
  const { store } = clockStore();
  store.ingestHistory([
    evaluation('e', BASE, BASE + 30000, { 250: 3, 270: 1 }),
    report('r1', 250, BASE), report('r2', 250, BASE + 10000),
    report('r3', 270, BASE + 20000), report('r4', 250, BASE + 40000),
  ]);
  assert.equal(store.snapshot().total, 5);
  assert.equal(store.snapshot().areas.find((area) => area.code === 250).count, 4);
  assert.equal(store.snapshot().areas.find((area) => area.code === 250).source, 'mixed');
  assert.equal(store.snapshot().latestAt, BASE + 40000);
});

test('newer corrections including count=0 replace previous aggregates and covered raw copies', () => {
  const { store } = clockStore();
  store.ingest(evaluation('e1', BASE, BASE + 10000, { 250: 10 }));
  store.ingest(report('r1', 250, BASE + 5000));
  store.ingest(evaluation('e2', BASE, BASE + 15000, { 250: 4 }));
  assert.equal(store.snapshot().total, 4);
  store.ingest(evaluation('e3', BASE, BASE + 20000, {}));
  assert.equal(store.snapshot().total, 0);
  assert.deepEqual(store.snapshot().areas, []);
  assert.equal(store.snapshot().mode, 'empty');
  store.ingest(evaluation('e1', BASE, BASE + 10000, { 250: 10 }));
  assert.equal(store.snapshot().total, 0);
});

test('upstream count=1 with empty area breakdown is counted once and remains unlocated until a 561 is available', () => {
  // This empty breakdown is emitted by upstream for events with fewer than 3 reports.
  const { store } = clockStore();
  store.ingest(evaluation('e', BASE, BASE, {}, { count: 1, confidence: 0 }));
  assert.equal(store.snapshot().total, 1);
  assert.equal(store.snapshot().unattributedCount, 1);
  assert.equal(store.snapshot().unlocatedCount, 1);
  assert.equal(store.snapshot().locatedCount, 0);
  assert.deepEqual(store.snapshot().quality.notes, ['missing-area-breakdown']);
  store.ingest(report('r', 250, BASE));
  assert.equal(store.snapshot().total, 1);
  assert.equal(store.snapshot().locatedCount, 1);
  assert.equal(store.snapshot().unattributedCount, 0);
});

test('startup/reconnect history converges with live ingestion irrespective of history order', () => {
  const messages = [report('r1', 250, BASE), evaluation('e1', BASE, BASE + 10000, { 250: 3 }),
    report('r2', 270, BASE + 20000), evaluation('e2', BASE, BASE + 30000, { 250: 3, 270: 1 }),
    report('r3', 250, BASE + 40000)];
  const { store: live } = clockStore();
  messages.forEach((message) => live.ingest(message));
  const { store: startup } = clockStore();
  startup.ingestHistory([...messages].reverse());
  assert.deepEqual(startup.snapshot(), live.snapshot());
  startup.ingestHistory(messages);
  assert.deepEqual(startup.snapshot(), live.snapshot());
  const { store: racing } = clockStore();
  racing.ingest(messages.at(-1)); // WebSocket is already active when REST completes.
  racing.ingest(messages[3]);
  racing.ingestHistory([...messages].reverse());
  assert.deepEqual(racing.snapshot(), live.snapshot());
});

test('TTL uses report occurrence, never late receipt or a later evaluation emission time', () => {
  const { store, setNow } = clockStore(BASE + 1000);
  store.ingest(report('r', 250, BASE));
  setNow(BASE + COMMUNITY_WINDOW_MS - 1);
  assert.equal(store.snapshot().total, 1);
  setNow(BASE + COMMUNITY_WINDOW_MS);
  assert.equal(store.snapshot().total, 0);
  assert.equal(store.ingest(report('r', 250, BASE)).reason, 'expired');
  assert.equal(store.ingest(evaluation('e', BASE, BASE, { 250: 3 }, { time: stamp(BASE + COMMUNITY_WINDOW_MS) })).reason, 'expired');
});

test('an aggregate crossing the 10 minute boundary falls back to only in-window raw reports', () => {
  const { store, setNow } = clockStore(BASE + 120000);
  store.ingest(evaluation('e', BASE, BASE + 60000, { 250: 30 }));
  store.ingest(report('r-old', 250, BASE));
  store.ingest(report('r-recent', 250, BASE + 50000));
  assert.equal(store.snapshot().total, 30);
  setNow(BASE + COMMUNITY_WINDOW_MS + 10000);
  assert.equal(store.snapshot().total, 1);
  assert.deepEqual(store.snapshot().quality.notes, ['window-clipped']);
  setNow(BASE + COMMUNITY_WINDOW_MS + 60000);
  assert.equal(store.snapshot().total, 0);
  assert.deepEqual(store.snapshot().quality.notes, []);
});

test('distant future messages are rejected; small clock skew is buffered without extending occurrence time', () => {
  const { store, setNow } = clockStore(BASE);
  assert.equal(store.ingest(report('far', 250, BASE + 60000)).reason, 'future-time');
  assert.equal(store.ingest(evaluation('far-e', BASE, BASE + 60000, { 250: 3 })).reason, 'future-time');
  assert.equal(store.ingest(report('skew', 250, BASE + 1000)).accepted, true);
  assert.equal(store.snapshot().total, 0);
  setNow(BASE + 1000);
  assert.equal(store.snapshot().total, 1);
  setNow(BASE + 1000 + COMMUNITY_WINDOW_MS);
  assert.equal(store.snapshot().total, 0);
});

test('unmapped and foreign report areas never acquire invented coordinates', () => {
  const { store } = clockStore();
  store.ingest(report('foreign', 905, BASE));
  store.ingest(report('unknown', 999, BASE + 1000));
  store.ingest(report('Tokyo', 250, BASE + 2000));
  assert.equal(store.snapshot().total, 3);
  assert.equal(store.snapshot().unlocatedCount, 2);
  assert.equal(store.snapshot().locatedCount, 1);
  for (const area of store.snapshot().areas.filter((row) => row.code !== 250)) {
    assert.equal(area.lat, null);
    assert.equal(area.lon, null);
  }
});

test('separate events sum, while overlapping snapshots choose one and flag uncertainty', () => {
  const { store } = clockStore();
  store.ingest(evaluation('one', BASE, BASE + 10000, { 250: 3 }));
  store.ingest(evaluation('two', BASE + 60000, BASE + 70000, { 270: 4 }));
  assert.equal(store.snapshot().total, 7);
  store.ingest(evaluation('overlap', BASE + 5000, BASE + 20000, { 250: 5 }));
  assert.equal(store.snapshot().total, 9);
  assert.equal(store.snapshot().quality.overlappingEvents, 1);
});

test('invalid data cannot erase a valid event or create NaN/negative report totals', () => {
  const { store } = clockStore();
  const valid = evaluation('valid', BASE, BASE + 10000, { 250: 3 });
  store.ingest(valid);
  const malformed = [null, [], 'hello', {}, { ...report('a', 250, BASE), id: '' },
    report('b', null, BASE), report('b', {}, BASE), report('c', -1, BASE), report('d', 1000, BASE),
    report('e', true, BASE), report('f', 250, BASE, { time: '2026/02/30 00:00:00' }),
    { ...valid, time: stamp(BASE + 20000), count: -1 },
    { ...valid, time: stamp(BASE + 20000), count: '3' },
    { ...valid, time: stamp(BASE + 20000), confidence: NaN },
    { ...valid, time: stamp(BASE + 20000), area_confidences: [] },
    { ...valid, time: stamp(BASE + 20000), area_confidences: { 250: { count: -1 } } },
    { ...valid, time: stamp(BASE + 20000), area_confidences: { 250: { count: 99 } } },
    { ...valid, time: stamp(BASE + 20000), started_at: stamp(BASE + 30000) },
  ];
  for (const message of malformed) assert.equal(store.ingest(message).accepted, false, JSON.stringify(message));
  assert.equal(store.ingest({ code: 551, id: 'q', time: stamp(BASE) }).reason, 'unsupported-code');
  assert.equal(store.snapshot().total, 3);
  assert.deepEqual(store.ingestHistory(null), { accepted: 0, skipped: 0, invalid: true });
});

test('returned snapshots and caller objects cannot mutate store state', () => {
  const { store } = clockStore();
  const message = evaluation('e', BASE, BASE + 10000, { 250: 3 });
  store.ingest(message);
  message.area_confidences[250].count = 99;
  const snapshot = store.snapshot();
  snapshot.areas[0].count = 42;
  snapshot.areas[0].lat = 0;
  snapshot.quality.notes.push('corrupt');
  assert.equal(store.snapshot().total, 3);
  assert.equal(store.snapshot().areas[0].lat, 35.699);
  assert.deepEqual(store.snapshot().quality.notes, []);
});
