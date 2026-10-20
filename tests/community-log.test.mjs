import assert from 'node:assert/strict';
import test from 'node:test';
import { CommunityStore, COMMUNITY_WINDOW_MS } from '../docs/community-core.js';
import { CommunityLog, COMMUNITY_LOG_LIMIT, formatCommunityLogTime } from '../docs/community-log.js';

const BASE = Date.parse('2026-10-20T12:00:00+09:00');
const stamp = at => new Date(at + 9 * 60 * 60_000).toISOString().replaceAll('-', '/').replace('T', ' ').replace('Z', '');
const report = (id, area = 250, at = BASE, extra = {}) => ({ code: 561, id, area, time: stamp(at), ...extra });
const evaluation = (id = 'evaluation', count = 120) => ({ code: 9611, id, time: stamp(BASE),
  started_at: stamp(BASE - 60_000), updated_at: stamp(BASE), confidence: .98,
  count, area_confidences: { 250: { count } } });
function fixture(options = {}) {
  let now = BASE + 60_000;
  const log = new CommunityLog({ now: () => now, ...options });
  return { log, setNow: value => { now = value; },
    live: (message, detail = {}, next = {}) => log.ingestLive(next, { message, receivedAt: now, ...detail }) };
}

test('a real public 561 fixture is one exact report with source/receipt timestamps and official region', () => {
  // Same public history fixture as community-core.test.mjs, read 2026-10-20.
  const message = { area: 250, code: 561, created_at: '2026/10/20 12:02:04.760', hop: 6,
    id: '6ad6d9acc58757000704c93d', time: '2026/10/20 12:02:04.755',
    uid: '0021520261020120205179', ver: '20150406' };
  const f = fixture(); f.setNow(BASE + 180_000);
  const result = f.live(message);
  assert.equal(result.accepted, true);
  const entry = f.log.snapshot().entries[0];
  assert.equal(entry.at, BASE + 124_755);
  assert.equal(entry.receivedAt, BASE + 180_000);
  assert.equal(entry.timeLabel, '12:02:04');
  assert.equal(entry.receivedTimeLabel, '12:03:00');
  assert.equal(entry.areaName, '東京');
  assert.deepEqual(entry.areaCodes, [250]);
  assert.equal(entry.count, 1);
  assert.equal(entry.history, false);
  assert.equal(entry.source, 'live');
  assert.equal('intensity' in entry, false);
  assert.equal('uid' in entry, false, 'protocol aliases are not displayed as user identities');
});

test('9611 snapshots, aggregate area deltas, and store snapshots cannot fabricate individual rows', () => {
  const f = fixture();
  const next = { total: 120, areas: [{ code: 250, name: '東京都', count: 120 }] };
  assert.equal(f.live(evaluation(), {}, next).accepted, false);
  assert.equal(f.live(evaluation('next', 130), {}, next).accepted, false);
  assert.deepEqual(f.log.ingestHistory([evaluation()]), { accepted: 0, skipped: 1, invalid: false });
  assert.deepEqual(f.log.ingestHistory(next), { accepted: 0, skipped: 0, invalid: true });
  assert.equal(f.log.snapshot().total, 0);
});

test('an accepted live 561 still logs when a cumulative evaluation already covers it', () => {
  const f = fixture();
  const store = new CommunityStore({ now: () => BASE + 60_000 });
  store.ingest(evaluation());
  const previous = store.snapshot();
  const message = report('covered');
  assert.equal(store.ingest(message).accepted, true);
  const next = store.snapshot();
  assert.equal(next.total, previous.total);
  assert.equal(f.live(message, { previous }, next).accepted, true);
  assert.equal(f.log.snapshot().entries.length, 1);
});

test('same id and protocol UID retransmissions stay one row and never renew occurrence/receipt time', () => {
  const f = fixture();
  const first = report('first', 250, BASE, { uid: 'report-uid' });
  assert.equal(f.live(first).accepted, true);
  const key = f.log.snapshot().entries[0].key;
  f.setNow(BASE + 90_000);
  assert.equal(f.live({ ...first, id: 'redelivered', time: stamp(BASE + 10_000) }).reason, 'duplicate');
  assert.equal(f.live({ ...first, uid: 'another-uid' }).reason, 'duplicate');
  const entry = f.log.snapshot().entries[0];
  assert.equal(entry.key, key);
  assert.equal(entry.at, BASE);
  assert.equal(entry.receivedAt, BASE + 60_000);
  f.setNow(BASE + COMMUNITY_WINDOW_MS);
  assert.equal(f.log.snapshot().total, 0);
});

test('several explicit region codes and aliases are one post, without multiplying its count', () => {
  const f = fixture();
  assert.equal(f.live(report('multi', [70, '010', 70], BASE, { uid: 'one' })).accepted, true);
  assert.equal(f.live(report('alias', 60, BASE, { uid: 'one' })).accepted, false);
  const state = f.log.snapshot();
  assert.equal(state.total, 1);
  assert.equal(state.entries[0].count, 1);
  assert.deepEqual(state.entries[0].areaCodes, [10, 60, 70]);
  assert.equal(state.entries[0].areaName, '北海道 石狩・北海道 日高・北海道 釧路');
});

test('unknown and explicitly unconfigured regions are shown without inferred locations', () => {
  const f = fixture();
  f.live(report('unknown', 999));
  f.live(report('unset', 900));
  f.live(report('foreign', 905));
  const byId = new Map(f.log.snapshot().entries.map(entry => [entry.id, entry]));
  assert.equal(byId.get('unknown').areaName, '地域不明（コード999）');
  assert.equal(byId.get('unknown').areas[0].known, false);
  assert.equal(byId.get('unset').areaName, '地域未設定');
  assert.equal(byId.get('unset').areas[0].known, false);
  assert.equal(byId.get('foreign').areaName, '日本以外');
  for (const entry of byId.values()) assert.equal('lat' in entry.areas[0], false);
});

test('initial history and reconnect copies are visibly historical and cannot become fresh live rows', () => {
  const f = fixture();
  const message = report('seed', 250, BASE, { uid: 'seed-uid' });
  assert.deepEqual(f.log.ingestHistory([message, evaluation()]), { accepted: 1, skipped: 1, invalid: false });
  const before = f.log.snapshot().entries[0];
  assert.equal(before.history, true);
  assert.equal(before.source, 'history');
  assert.equal(before.receivedAt, null);
  assert.equal(before.receivedTimeLabel, '');
  assert.equal(f.live({ ...message, id: 'socket-copy' }).accepted, false);
  assert.equal(f.log.snapshot().entries[0].history, true);
  assert.equal(f.log.ingestHistory([message]).accepted, 0);

  f.live(report('live', 60, BASE + 10_000));
  assert.equal(f.log.ingestHistory([report('live', 60, BASE + 10_000)]).accepted, 0);
  assert.equal(f.log.snapshot().entries[0].source, 'live');
});

test('history/replay passed accidentally to onLive cannot animate or append a live row', () => {
  const f = fixture();
  for (const source of ['history', 'replay']) {
    assert.equal(f.live(report(source), { source }).reason, 'non-live');
  }
  assert.equal(f.log.snapshot().total, 0);
});

test('out-of-order arrival is sorted by report time and capped by newest reports, not retransmit arrival', () => {
  const f = fixture({ maxEntries: 3 });
  for (const [id, delta] of [['newest', 50_000], ['older', 20_000], ['middle', 40_000], ['oldest', 10_000]]) {
    f.live(report(id, 250, BASE + delta));
  }
  assert.deepEqual(f.log.snapshot().entries.map(entry => entry.id), ['newest', 'middle', 'older']);
  assert.equal(f.live(report('oldest', 250, BASE + 10_000)).reason, 'capacity');
  assert.deepEqual(f.log.snapshot().entries.map(entry => entry.id), ['newest', 'middle', 'older']);
});

test('reverse REST histories converge and large bursts stay bounded', () => {
  const messages = Array.from({ length: 300 }, (_, i) => report(`r${String(i).padStart(3, '0')}`, 250, BASE - 100_000 + i * 500));
  const a = fixture(), b = fixture();
  a.log.ingestHistory(messages); b.log.ingestHistory([...messages].reverse());
  assert.deepEqual(a.log.snapshot(), b.log.snapshot());
  assert.equal(a.log.snapshot().entries.length, COMMUNITY_LOG_LIMIT);
  assert.equal(a.log.snapshot().entries[0].id, 'r299');
  assert.equal(a.log.snapshot().entries.at(-1).id, 'r180');
});

test('ID/UID alias groups merge into one row when a retransmission links them', () => {
  const f = fixture();
  f.live(report('one', 10, BASE, { uid: 'uid-one' }));
  f.live(report('two', 60, BASE + 1_000, { uid: 'uid-two' }));
  assert.equal(f.log.snapshot().total, 2);
  assert.equal(f.live(report('one', 70, BASE + 2_000, { uid: 'uid-two' })).reason, 'duplicate');
  assert.equal(f.log.snapshot().total, 1);
  assert.deepEqual(f.log.snapshot().entries[0].areaCodes, [10, 60, 70]);
  assert.equal(f.live(report('two', 60, BASE + 1_000, { uid: 'uid-one' })).reason, 'duplicate');
});

test('source-time TTL excludes the left boundary even when delivery/backfill is recent', () => {
  const f = fixture(); f.setNow(BASE + COMMUNITY_WINDOW_MS);
  assert.equal(f.live(report('expired')).reason, 'expired');
  assert.equal(f.log.ingestHistory([report('expired')]).accepted, 0);
  assert.equal(f.live(report('inside', 250, BASE + 1)).accepted, true);
  assert.equal(f.log.snapshot().total, 1);
  f.setNow(BASE + COMMUNITY_WINDOW_MS + 1);
  assert.equal(f.log.snapshot().total, 0);
});

test('small future skew is buffered while malformed, excessive future, and unsupported data are rejected', () => {
  const f = fixture();
  const now = BASE + 60_000;
  assert.equal(f.live(report('buffered', 250, now + 2_000)).accepted, true);
  assert.equal(f.log.snapshot().total, 0);
  f.setNow(now + 2_000);
  assert.equal(f.log.snapshot().total, 1);
  assert.equal(f.live(report('future', 250, now + 8_000)).reason, 'future-time');
  for (const message of [null, [], {}, { ...report('bad-time'), time: 'invalid' },
    { ...report('bad-id'), id: '' }, report('bad-area', null), report('bad-area2', 'garbage'),
    report('bad-area3', [10, false]), report('empty', []), report('large', Array(33).fill(10))]) {
    assert.equal(f.live(message).accepted, false);
  }
});

test('snapshots and ingest results cannot mutate input data or retained log rows', () => {
  const f = fixture();
  const message = report('one', [10, 60]);
  const before = structuredClone(message);
  const result = f.live(message);
  assert.deepEqual(message, before);
  result.entry.areaCodes.push(70);
  result.entry.areas[0].name = 'changed';
  const state = f.log.snapshot();
  state.entries[0].areaCodes.push(70);
  state.entries[0].areas[0].name = 'changed again';
  assert.deepEqual(f.log.snapshot().entries[0].areaCodes, [10, 60]);
  assert.equal(f.log.snapshot().entries[0].areas[0].name, '北海道 石狩');
});

test('JST time labels and constructor/clock validation have deterministic boundaries', () => {
  assert.equal(formatCommunityLogTime(Date.parse('2026-10-20T15:00:00Z')), '00:00:00');
  for (const at of [NaN, Infinity, null, Number.MAX_VALUE]) assert.equal(formatCommunityLogTime(at), '');
  for (const maxEntries of [0, 151, 1.5]) assert.throws(() => new CommunityLog({ maxEntries }));
  assert.throws(() => new CommunityLog({ now: 1 }));
  assert.throws(() => new CommunityLog({ windowMs: 0 }));
  assert.throws(() => new CommunityLog({ now: () => NaN }).snapshot());
});
