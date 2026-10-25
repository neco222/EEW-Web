import test from 'node:test';
import assert from 'node:assert/strict';
import { CommunityStore } from '../docs/community-core.js';
import { CommunityLog } from '../docs/community-log.js';
import { CommunityFeed, COMMUNITY_WEBSOCKET_URL } from '../docs/community-feed.js';
import { startCommunityMapFollow } from '../docs/community-map.js';

const BASE = Date.parse('2026-10-20T12:00:00+09:00');
const TIME = '2026/10/20 12:00:00.000';
const report = (id = 'report', area = 250) => ({ code: 561, id, area, time: TIME });
const reportAt = (id, at, uid) => ({ code: 561, id, area: 250, time: new Date(at).toISOString(), ...(uid ? { uid } : {}) });
const evaluation = { code: 9611, id: 'evaluation', started_at: TIME, updated_at: TIME,
  time: TIME, count: 1, confidence: 0, area_confidences: {} };
async function flush() { for (let i = 0; i < 35; i++) await Promise.resolve(); }
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function response(data = [], { status = 200, retryAfter = null, broken = false } = {}) {
  return { ok: status >= 200 && status < 300, status,
    headers: { get: (name) => name === 'retry-after' ? retryAfter : null },
    json: async () => { if (broken) throw new SyntaxError('Broken JSON'); return data; } };
}

class Clock {
  time = BASE + 60000;
  timers = new Map();
  nextId = 1;
  now = () => this.time;
  setTimeout = (callback, delay) => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + delay, callback });
    return id;
  };
  clearTimeout = (id) => this.timers.delete(id);
  async advance(ms) {
    const end = this.time + ms;
    for (;;) {
      const next = [...this.timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
      await flush();
    }
    this.time = end;
    await flush();
  }
}

function socketFactory() {
  return class FakeWebSocket {
    static instances = [];
    readyState = 0;
    closeCalls = 0;
    constructor(url) { this.url = url; this.constructor.instances.push(this); }
    open() { this.readyState = 1; this.onopen?.({}); }
    message(message) { this.onmessage?.({ data: typeof message === 'string' ? message : JSON.stringify(message) }); }
    error() { this.onerror?.({}); }
    disconnect() { this.readyState = 3; this.onclose?.({ code: 1006 }); }
    close() { this.closeCalls++; this.readyState = 3; this.onclose?.({ code: 1000 }); }
  };
}

function harness(extra = {}) {
  const clock = extra.clock ?? new Clock();
  const WebSocket = extra.WebSocket ?? socketFactory();
  const statuses = [];
  const changes = [];
  const live = [];
  const history = [];
  const calls = [];
  const fetch = (url, options) => { calls.push({ url, options }); return extra.fetch ? extra.fetch(url, options) : Promise.resolve(response()); };
  const store = new CommunityStore({ now: clock.now });
  const eventTarget = new EventTarget();
  const feed = new CommunityFeed({ store, WebSocket, fetch,
    now: clock.now, random: () => 0.5, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    eventTarget, navigator: { onLine: true }, locks: null, BroadcastChannel: null,
    onChange: (snapshot) => changes.push(snapshot), onStatus: (status) => statuses.push(status),
    onLive: (snapshot, detail) => live.push({ snapshot, ...detail }),
    onHistory: (messages) => history.push(messages),
    ...extra.options,
  });
  return { clock, WebSocket, store, feed, statuses, changes, live, history, calls, eventTarget };
}

test('the observed Toyama 561 reaches the map from one live WebSocket message while native fit settles',async()=>{
  // Public report observed during the reported failure; original source fields.
  const message={code:561,id:'6ad7566cc58757000704c9f9',area:310,time:'2026/10/20 20:54:20.858'};
  const clock=new Clock();clock.time=Date.parse('2026-10-20T20:54:21.858+09:00');
  const doc=new EventTarget();doc.hidden=false;doc.getElementById=()=>({hidden:true});
  const native={ready:true,blocked:true,reason:'native-auto-recent'},moves=[],intakes=[];
  const follower=startCommunityMapFollow({now:clock.now,doc,events:new EventTarget(),vm:()=>({}),read:()=>({}),
    control:()=>({...native}),pan:next=>{moves.push(next);return{moved:true};},cancelPan:()=>{},
    schedule:clock.setTimeout,cancel:clock.clearTimeout});
  const h=harness({clock,options:{onLive:(next,detail)=>intakes.push(follower.ingestLive(next,detail))}});
  h.feed.start();await flush();h.WebSocket.instances[0].open();
  h.WebSocket.instances[0].message(message);
  assert.equal(h.store.snapshot().total,1);assert.equal(intakes.length,1);assert.equal(intakes[0].accepted,true);
  await clock.advance(600);assert.equal(moves.length,0);
  native.blocked=false;native.reason=null;await clock.advance(100);
  assert.equal(moves.length,1);assert.equal(moves[0].count,1);assert.equal(moves[0].areas[0].code,310);
  assert.equal(moves[0].lat,36.827);assert.equal(moves[0].lon,137.409);
  h.WebSocket.instances[0].message(message);await clock.advance(4000);
  assert.equal(intakes.length,1);assert.equal(moves.length,1);
  follower.stop();h.feed.stop();assert.equal(clock.timers.size,0);
});

test('the same one Toyama report loaded as history cannot later masquerade as a new live movement',async()=>{
  const message={code:561,id:'6ad7566cc58757000704c9f9',area:310,time:'2026/10/20 20:54:20.858'};
  const clock=new Clock();clock.time=Date.parse('2026-10-20T20:54:21.858+09:00');
  const h=harness({clock,fetch:url=>Promise.resolve(response(url.includes('codes=561')?[message]:[]))});
  h.feed.start();await flush();h.WebSocket.instances[0].open();
  assert.equal(h.store.snapshot().total,1);assert.equal(h.history.length,1);
  h.WebSocket.instances[0].message(message);await clock.advance(1000);
  assert.equal(h.live.length,0);h.feed.stop();assert.equal(clock.timers.size,0);
});

test('start is inert until called and idempotent; startup makes exactly two API requests and one socket', async () => {
  const h = harness();
  assert.equal(h.calls.length, 0);
  assert.equal(h.WebSocket.instances.length, 0);
  assert.equal(h.feed.start(), h.feed);
  h.feed.start(); h.feed.start();
  await flush();
  assert.equal(h.WebSocket.instances.length, 1);
  assert.equal(h.WebSocket.instances[0].url, COMMUNITY_WEBSOCKET_URL);
  assert.deepEqual(h.calls.map((call) => call.url).sort(), [
    'https://api.p2pquake.net/v2/history?codes=561&limit=100',
    'https://api.p2pquake.net/v2/history?codes=9611&limit=30',
  ]);
  assert.ok(h.calls.every((call) => call.options.signal instanceof AbortSignal && call.options.credentials === 'omit'));
  h.WebSocket.instances[0].open();
  await flush();
  assert.equal(h.calls.length, 2); // Initial open does not duplicate startup backfill.
  assert.equal(h.statuses.at(-1).state, 'live');
  assert.equal(h.statuses.at(-1).lastSync, h.clock.time);
  assert.ok(h.changes.length >= 1);
  h.feed.stop(); h.feed.stop();
  assert.equal(h.WebSocket.instances[0].closeCalls, 1);
  assert.equal(h.statuses.at(-1).state, 'stopped');
  assert.equal(h.clock.timers.size, 0);
});

test('rapid refresh calls share a batch Promise and do not replace the socket', async () => {
  const batches = [];
  const h = harness({ fetch: () => { const pending = deferred(); batches.push(pending); return pending.promise; } });
  h.feed.start();
  const first = h.feed.refresh();
  assert.equal(h.feed.refresh(), first);
  assert.equal(h.feed.refresh(), first);
  await flush();
  assert.equal(h.calls.length, 2);
  batches[0].resolve(response([evaluation]));
  batches[1].resolve(response([report()]));
  await first;
  assert.equal(h.store.snapshot().total, 1);
  const second = h.feed.refresh();
  assert.notEqual(second, first);
  assert.equal(h.feed.refresh(), second);
  await flush();
  assert.equal(h.calls.length, 4);
  assert.equal(h.WebSocket.instances.length, 1);
  batches[2].resolve(response([])); batches[3].resolve(response([]));
  await second;
  h.feed.stop();
});

test('live messages racing newest-first backfill deduplicate through the store', async () => {
  const pending = [];
  const h = harness({ fetch: () => { const item = deferred(); pending.push(item); return item.promise; } });
  h.feed.start();
  await flush();
  h.WebSocket.instances[0].open();
  h.WebSocket.instances[0].message(report());
  pending[0].resolve(response([evaluation])); pending[1].resolve(response([report()]));
  await flush();
  assert.equal(h.store.snapshot().total, 1);
  assert.equal(h.changes.at(-1).total, 1);
  assert.equal(h.live.length, 1);
  h.feed.stop();
});

test('onLive receives exact before/after snapshots only for accepted live reports', async () => {
  const h = harness();
  h.feed.start(); await flush(); h.WebSocket.instances[0].open();
  assert.equal(h.live.length, 0);
  const message = report();
  h.WebSocket.instances[0].message(message);
  assert.equal(h.live.length, 1);
  assert.equal(h.live[0].previous.total, 0);
  assert.equal(h.live[0].snapshot.total, 1);
  assert.deepEqual(h.live[0].message, message);
  assert.equal(h.live[0].receivedAt, h.clock.time);
  h.WebSocket.instances[0].message(message); // server redelivery
  h.WebSocket.instances[0].message({ ...report('invalid'), area: null });
  h.WebSocket.instances[0].message({ ...report('future'), time: '2026/10/20 13:00:00.000' });
  h.WebSocket.instances[0].message({ code: 555, id: 'unrelated', time: TIME });
  assert.equal(h.live.length, 1);
  h.feed.stop();
});

test('live 561 dispatches change and live callbacks in the socket call without waiting for reconciliation or timers', async () => {
  const h = harness();
  h.feed.start(); await flush(); const socket = h.WebSocket.instances[0]; socket.open();
  const timers = [...h.clock.timers.keys()];
  const at = h.clock.time;
  socket.message(reportAt('immediate', at));
  assert.equal(h.live.length, 1);
  assert.equal(h.changes.at(-1).total, 1);
  assert.equal(h.live[0].receivedAt, at);
  assert.deepEqual([...h.clock.timers.keys()], timers);
  assert.equal(h.statuses.at(-1).lastFrameAt, at);
  assert.equal(h.statuses.at(-1).lastLiveAt, at);
  assert.equal(h.statuses.at(-1).openedAt, at);
  assert.equal(h.statuses.at(-1).liveAcceptedCount, 1);
  h.feed.stop();
});

test('production WS _id records normalize before immediate ingestion and deduplicate against canonical REST id for 561 and 9611', async () => {
  let records = [];
  const h = harness({ fetch: url => Promise.resolve(response(records.filter(message => url.includes(`codes=${message.code}`)))) });
  h.feed.start(); await flush(); const socket = h.WebSocket.instances[0]; socket.open();
  const canonical = reportAt('6add9bfbc58757000704d541', h.clock.time);
  const wire = { ...canonical, _id: canonical.id }; delete wire.id;
  socket.message(wire);
  assert.equal(h.changes.at(-1).total, 1); assert.equal(h.live.length, 1);
  assert.equal(h.live[0].message.id, canonical.id); assert.equal(Object.hasOwn(wire, 'id'), false);
  records = [canonical]; await h.feed.refresh(); socket.message(wire);
  assert.equal(h.live.length, 1); assert.equal(h.store.snapshot().total, 1);
  const canonicalEvaluation = { ...evaluation, id: '6add9c02c58757000704d542' };
  const wireEvaluation = { ...canonicalEvaluation, id: null, _id: canonicalEvaluation.id };
  socket.message(wireEvaluation);
  assert.equal(h.live.length, 2); assert.equal(h.live.at(-1).message.id, canonicalEvaluation.id);
  assert.equal(wireEvaluation.id, null);
  records = [canonical, canonicalEvaluation]; await h.feed.refresh(); socket.message(wireEvaluation);
  assert.equal(h.live.length, 2); assert.equal(h.statuses.at(-1).liveRejectedCount, 0);
  h.feed.stop();
});

test('wire normalization preserves any non-null id and rejects unsupported _id values instead of inventing identifiers', async () => {
  const h = harness(); h.feed.start(); await flush(); const socket = h.WebSocket.instances[0]; socket.open();
  const value = reportAt('canonical-wins', h.clock.time);
  socket.message({ ...value, _id: '6add9bfbc58757000704d541' });
  assert.equal(h.live.at(-1).message.id, 'canonical-wins');
  for (const message of [
    { ...value, id: '', _id: '6add9bfbc58757000704d541' },
    { ...value, id: 42, _id: '6add9bfbc58757000704d541' },
    { ...value, id: null, _id: 'not-an-object-id' },
    { ...value, id: null, _id: { $oid: '6add9bfbc58757000704d541' } },
  ]) socket.message(message);
  assert.equal(h.live.length, 1); assert.equal(h.statuses.at(-1).liveRejectedCount, 4);
  assert.equal(h.statuses.at(-1).lastRejectedReason, 'invalid-message');
  h.feed.stop();
});

test('quiet or hidden OPEN sockets remain connected indefinitely; unrelated frames update diagnostics only', async () => {
  const doc = new EventTarget(); doc.hidden = false;
  const h = harness({ options: { lifecycleTarget: doc } });
  h.feed.start(); await flush(); const socket = h.WebSocket.instances[0]; socket.open();
  doc.hidden = true; doc.dispatchEvent(new Event('visibilitychange'));
  await h.clock.advance(12 * 60000);
  socket.message({ code: 555 });
  assert.equal(h.WebSocket.instances.length, 1);
  assert.equal(socket.closeCalls, 0);
  assert.equal(h.statuses.at(-1).state, 'live');
  assert.equal(h.statuses.at(-1).lastFrameAt, h.clock.time);
  assert.equal(h.statuses.at(-1).lastLiveAt, null);
  assert.equal(h.statuses.at(-1).realtimeRecoveryCount, 0);
  h.feed.stop(); assert.equal(h.clock.timers.size, 0);
});

test('the same missing post-open report in two separate successful batches closes first and reconnects with backoff silently', async () => {
  let records = [];
  const h = harness({ fetch: url => Promise.resolve(response(url.includes('codes=561') ? records : [])) });
  h.feed.start(); await flush(); const socket = h.WebSocket.instances[0]; socket.open();
  records = [reportAt('missed-wire', h.clock.time + 10000, 'protocol-uid')];
  await h.clock.advance(30000);
  assert.equal(h.store.snapshot().total, 1);
  assert.equal(socket.closeCalls, 0);
  await h.feed.refresh(); // Another request at the same time is not corroboration.
  assert.equal(socket.closeCalls, 0);
  await h.clock.advance(30000);
  assert.equal(socket.closeCalls, 1);
  assert.equal(h.WebSocket.instances.length, 1);
  assert.equal(h.statuses.at(-1).state, 'reconnecting');
  assert.equal(h.statuses.at(-1).realtimeRecoveryCount, 1);
  assert.equal(h.live.length, 0);
  assert.equal(h.statuses.at(-1).lastHistoryAt, h.clock.time);
  await h.clock.advance(999); assert.equal(h.WebSocket.instances.length, 1);
  await h.clock.advance(1); assert.equal(h.WebSocket.instances.length, 2);
  h.WebSocket.instances[1].open(); await flush();
  assert.equal(h.statuses.at(-1).state, 'live');
  assert.equal(h.live.length, 0);
  h.feed.stop(); assert.equal(h.clock.timers.size, 0);
});

test('pre-open, initial grace, expired, future, invalid and unrelated history cannot trigger socket recovery', async () => {
  let openedAt;
  const h = harness({ fetch: url => Promise.resolve(response(url.includes('codes=561') && openedAt ? [
    reportAt('before-open', openedAt - 1), reportAt('initial-race', openedAt + 5000),
    reportAt('expired', h.clock.time - 600001), reportAt('future', h.clock.time + 60000),
    { ...reportAt('invalid-area', openedAt + 10000), area: null },
    { ...reportAt('invalid-id', openedAt + 10000), id: null },
  ] : [])) });
  h.feed.start(); await flush(); h.WebSocket.instances[0].open(); openedAt = h.clock.time;
  await h.clock.advance(180000);
  assert.equal(h.WebSocket.instances.length, 1);
  assert.equal(h.WebSocket.instances[0].closeCalls, 0);
  assert.equal(h.statuses.at(-1).realtimeRecoveryCount, 0);
  h.feed.stop();
});

test('a valid wire id or uid arriving after silent backfill cancels missing-realtime suspicion despite store dedup', async t => {
  for (const alias of ['id', 'uid']) await t.test(alias, async () => {
    let records = [];
    const h = harness({ fetch: url => Promise.resolve(response(url.includes('codes=561') ? records : [])) });
    h.feed.start(); await flush(); const socket = h.WebSocket.instances[0]; socket.open();
    const message = reportAt('canonical', h.clock.time + 10000, 'wire-uid'); records = [message];
    await h.clock.advance(30000);
    socket.message(alias === 'uid' ? { ...message, id: 'wire-alias' } : message);
    assert.equal(h.statuses.at(-1).liveDuplicateCount, 1);
    assert.equal(h.statuses.at(-1).liveRejectedCount, 0);
    assert.equal(h.live.length, 0);
    await h.clock.advance(90000);
    assert.equal(socket.closeCalls, 0);
    assert.equal(h.WebSocket.instances.length, 1);
    h.feed.stop();
  });
});

test('a partial history failure resets corroboration and respects Retry-After before recovery', async () => {
  let records = [], fail = false;
  const h = harness({ fetch: url => Promise.resolve(url.includes('codes=9611') && fail ?
    response([], { status: 429, retryAfter: '5' }) : response(url.includes('codes=561') ? records : [])) });
  h.feed.start(); await flush(); const socket = h.WebSocket.instances[0]; socket.open();
  records = [reportAt('missing', h.clock.time + 10000)];
  await h.clock.advance(30000); fail = true;
  await h.clock.advance(30000); assert.equal(socket.closeCalls, 0);
  fail = false; await h.clock.advance(5000); assert.equal(socket.closeCalls, 0);
  await h.clock.advance(29999); assert.equal(socket.closeCalls, 0);
  await h.clock.advance(1); assert.equal(socket.closeCalls, 1);
  assert.equal(h.live.length, 0);
  h.feed.stop();
});

test('successive missing reports cannot cause more than one recovery per two minutes', async () => {
  let records = [];
  const h = harness({ fetch: url => Promise.resolve(response(url.includes('codes=561') ? records : [])) });
  h.feed.start(); await flush(); h.WebSocket.instances[0].open();
  records = [reportAt('first-gap', h.clock.time + 10000)];
  await h.clock.advance(60000);
  assert.equal(h.statuses.at(-1).realtimeRecoveryCount, 1);
  await h.clock.advance(1000); const second = h.WebSocket.instances[1]; second.open(); await flush();
  records = [reportAt('new-gap', h.clock.time + 10000)];
  await h.clock.advance(90000);
  assert.equal(second.closeCalls, 0);
  assert.equal(h.statuses.at(-1).realtimeRecoveryCount, 1);
  await h.clock.advance(30000);
  assert.equal(second.closeCalls, 1);
  assert.equal(h.statuses.at(-1).realtimeRecoveryCount, 2);
  assert.equal(h.live.length, 0);
  h.feed.stop();
});

test('a close/reopen discards the previous socket missing-report evidence', async () => {
  let records = [];
  const h = harness({ fetch: url => Promise.resolve(response(url.includes('codes=561') ? records : [])) });
  h.feed.start(); await flush(); const first = h.WebSocket.instances[0]; first.open();
  records = [reportAt('previous-session', h.clock.time + 10000)];
  await h.clock.advance(30000);
  first.disconnect(); await h.clock.advance(1000); h.WebSocket.instances[1].open(); await flush();
  await h.clock.advance(90000);
  assert.equal(h.WebSocket.instances.length, 2);
  assert.equal(h.WebSocket.instances[1].closeCalls, 0);
  assert.equal(h.statuses.at(-1).realtimeRecoveryCount, 0);
  h.feed.stop();
});

test('wire diagnostics distinguish malformed records and duplicates without exposing raw content', async () => {
  const h = harness(); h.feed.start(); await flush(); const socket = h.WebSocket.instances[0]; socket.open();
  socket.message('{secret');
  socket.message({ ...reportAt('private-id', h.clock.time), id: null, _id: 'private-diagnostic-value' });
  socket.message({ ...reportAt('bad-area', h.clock.time), area: null });
  socket.message(reportAt('valid', h.clock.time)); socket.message(reportAt('valid', h.clock.time));
  const status = h.statuses.at(-1);
  assert.equal(status.liveRejectedCount, 3);
  assert.equal(status.lastRejectedReason, 'invalid-area');
  assert.equal(status.liveDuplicateCount, 1);
  assert.equal(status.liveAcceptedCount, 1);
  assert.equal(JSON.stringify(status).includes('private'), false);
  assert.equal(JSON.stringify(status).includes('secret'), false);
  h.feed.stop();
});

test('onLive previous prunes expired reports instead of using the last rendered net total', async () => {
  const clock = new Clock();
  clock.time = BASE + 600000 - 1;
  const h = harness({ clock, fetch: (url) => Promise.resolve(response(url.includes('codes=561') ? [report('old')] : [])) });
  h.feed.start(); await flush(); h.WebSocket.instances[0].open();
  assert.equal(h.changes.at(-1).total, 1);
  assert.equal(h.live.length, 0); // startup history must not create a pulse
  clock.time += 2;
  h.WebSocket.instances[0].message({ ...report('new'), time: '2026/10/20 12:10:00.001' });
  assert.equal(h.live.length, 1);
  assert.equal(h.live[0].previous.total, 0);
  assert.equal(h.live[0].snapshot.total, 1);
  assert.equal(h.changes.at(-1).total, 1); // a rendered-net-diff would incorrectly be zero
  h.feed.stop();
});

test('live 9611 revisions carry before/after areas while history, duplicates, and reconnect backfill stay silent', async () => {
  const h = harness({ fetch: (url) => Promise.resolve(response(url.includes('codes=9611') ? [evaluation] : [report()])) });
  h.feed.start(); await flush(); h.WebSocket.instances[0].open();
  assert.equal(h.live.length, 0);
  const update = { ...evaluation, id: 'new-evaluation', count: 4,
    updated_at: '2026/10/20 12:00:10.000', time: '2026/10/20 12:00:10.000',
    area_confidences: { 250: { count: 4 } } };
  h.WebSocket.instances[0].message(update);
  assert.equal(h.live.length, 1);
  assert.equal(h.live[0].previous.areas[0].count, 1);
  assert.equal(h.live[0].snapshot.areas[0].count, 4);
  h.WebSocket.instances[0].message(update);
  await h.feed.refresh();
  assert.equal(h.live.length, 1);
  h.WebSocket.instances[0].disconnect();
  await h.clock.advance(1000);
  h.WebSocket.instances[1].open(); await flush();
  assert.equal(h.calls.length, 6);
  assert.equal(h.live.length, 1);
  h.feed.stop();
});

test('socket errors reconnect with exponential backoff capped at 30 seconds, and opening backfills again', async () => {
  const h = harness();
  h.feed.start(); await flush();
  const delays = [];
  for (let attempt = 0; attempt < 8; attempt++) {
    h.WebSocket.instances.at(-1).error();
    const status = h.statuses.at(-1);
    delays.push(status.retryInMs);
    assert.equal(status.state, 'reconnecting');
    const count = h.WebSocket.instances.length;
    await h.clock.advance(status.retryInMs - 1);
    assert.equal(h.WebSocket.instances.length, count);
    await h.clock.advance(1);
    assert.equal(h.WebSocket.instances.length, count + 1);
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  const requestsAfterPolling = h.calls.length;
  h.WebSocket.instances.at(-1).open();
  await flush();
  assert.equal(h.calls.length, requestsAfterPolling + 2);
  h.WebSocket.instances.at(-1).disconnect();
  assert.equal(h.statuses.at(-1).retryInMs, 1000);
  await h.clock.advance(1000);
  h.WebSocket.instances.at(-1).open();
  await flush();
  assert.equal(h.calls.length, requestsAfterPolling + 4);
  h.feed.stop();
  const count = h.WebSocket.instances.length;
  await h.clock.advance(60000);
  assert.equal(h.WebSocket.instances.length, count);
});

test('disconnected WebSockets refresh REST history every 30 seconds without live effects or retry postponement', async () => {
  let reportFetches = 0;
  const h = harness({ fetch: (url) => Promise.resolve(response(url.includes('codes=561') ?
    [report(`history-${++reportFetches}`)] : [])) });
  h.feed.start(); await flush();
  h.WebSocket.instances[0].error();
  assert.equal(h.calls.length, 2);
  await h.clock.advance(29999);
  assert.equal(h.calls.length, 2);
  await h.clock.advance(1);
  assert.equal(h.calls.length, 4);
  assert.equal(h.store.snapshot().total, 2);
  assert.equal(h.history.flat().length, 2);
  assert.equal(h.live.length, 0);
  assert.equal(h.statuses.at(-1).state, 'polling');
  assert.match(h.statuses.at(-1).message, /30秒ごとに履歴で補完/);
  await h.clock.advance(30000);
  assert.equal(h.calls.length, 6);
  assert.equal(h.store.snapshot().total, 3);
  assert.equal(h.live.length, 0);
  h.WebSocket.instances.at(-1).open(); await flush();
  h.WebSocket.instances.at(-1).message(report('history-2'));
  assert.equal(h.live.length, 0); // A polled report cannot later become a new WS post.
  h.feed.stop();
  assert.equal(h.clock.timers.size, 0);
});

test('an open WebSocket continues bounded reconciliation after recovery repairs the gap', async () => {
  const h = harness();
  h.feed.start(); await flush();
  h.WebSocket.instances[0].error();
  await h.clock.advance(30000);
  assert.equal(h.calls.length, 4);
  h.WebSocket.instances.at(-1).open();
  await flush();
  assert.equal(h.calls.length, 6);
  assert.equal(h.statuses.at(-1).state, 'live');
  await h.clock.advance(90000);
  assert.equal(h.calls.length, 12);
  assert.equal(h.clock.timers.size, 1);
  assert.equal(h.WebSocket.instances.at(-1).readyState, 1);
  h.feed.stop();
  assert.equal(h.clock.timers.size, 0);
});

test('disconnected REST polling preserves Retry-After delays beyond its 30 second interval', async () => {
  let requests = 0;
  const h = harness({ fetch: () => Promise.resolve(++requests > 2 && requests <= 4 ?
    response([], { status: 429, retryAfter: '120' }) : response()) });
  h.feed.start(); await flush();
  h.WebSocket.instances[0].error();
  await h.clock.advance(30000);
  assert.equal(h.calls.length, 4);
  await h.clock.advance(119999);
  assert.equal(h.calls.length, 4);
  await h.clock.advance(1);
  assert.equal(h.calls.length, 6);
  await h.clock.advance(29999);
  assert.equal(h.calls.length, 6);
  await h.clock.advance(1);
  assert.equal(h.calls.length, 8);
  h.feed.stop();
});

test('WebSocket recovery preserves REST Retry-After before resuming periodic reconciliation', async () => {
  let requests = 0;
  const h = harness({ fetch: () => Promise.resolve(++requests <= 2 ?
    response([], { status: 429, retryAfter: '120' }) : response()) });
  h.feed.start(); await flush();
  h.WebSocket.instances[0].error();
  await h.clock.advance(1000);
  h.WebSocket.instances.at(-1).open(); await flush();
  assert.equal(h.calls.length, 2);
  assert.equal(h.statuses.at(-1).state, 'error');
  await h.clock.advance(118999);
  assert.equal(h.calls.length, 2);
  await h.clock.advance(1);
  assert.equal(h.calls.length, 4);
  assert.equal(h.statuses.at(-1).state, 'live');
  await h.clock.advance(60000);
  assert.equal(h.calls.length, 8);
  h.feed.stop();
  assert.equal(h.clock.timers.size, 0);
});

test('a pending disconnected poll shares the manual refresh batch and schedules again only after completion', async () => {
  const pending = [];
  let requests = 0;
  const h = harness({ fetch: () => {
    if (++requests <= 2) return Promise.resolve(response());
    const item = deferred(); pending.push(item); return item.promise;
  } });
  h.feed.start(); await flush();
  h.WebSocket.instances[0].error();
  await h.clock.advance(30000);
  const batch = h.feed.refresh();
  assert.equal(h.feed.refresh(), batch);
  await h.clock.advance(9999);
  assert.equal(h.calls.length, 4);
  pending[0].resolve(response()); pending[1].resolve(response([report('polled')]));
  await batch;
  assert.equal(h.store.snapshot().total, 1);
  assert.equal(h.live.length, 0);
  await h.clock.advance(29999);
  assert.equal(h.calls.length, 4);
  await h.clock.advance(1);
  assert.equal(h.calls.length, 6);
  h.feed.stop(); await flush();
  assert.equal(h.clock.timers.size, 0);
});

test('offline and pagehide cancel disconnected polling until the matching resume event', async () => {
  for (const [pause, resume] of [['offline', 'online'], ['pagehide', 'pageshow']]) {
    const h = harness();
    h.feed.start(); await flush(); h.WebSocket.instances[0].error();
    h.eventTarget.dispatchEvent(new Event(pause));
    assert.equal(h.clock.timers.size, 0);
    await h.clock.advance(60000);
    assert.equal(h.calls.length, 2);
    h.eventTarget.dispatchEvent(new Event(resume)); await flush();
    assert.equal(h.calls.length, 4);
    await h.clock.advance(30000);
    assert.equal(h.calls.length, 6);
    h.feed.stop();
    assert.equal(h.clock.timers.size, 0);
  }
});

test('connecting timeout closes the stalled socket once and schedules one retry', async () => {
  const h = harness();
  h.feed.start(); await flush();
  await h.clock.advance(10000);
  assert.equal(h.WebSocket.instances[0].closeCalls, 1);
  assert.equal(h.statuses.at(-1).state, 'reconnecting');
  assert.match(h.statuses.at(-1).message, /タイムアウト/);
  await h.clock.advance(1000);
  assert.equal(h.WebSocket.instances.length, 2);
  h.feed.stop();
});

test('history timeout aborts both fetches, recovers automatically, and does not reconnect a healthy socket', async () => {
  let request = 0;
  const h = harness({ fetch: () => ++request <= 2 ? new Promise(() => {}) : Promise.resolve(response()) });
  h.feed.start(); await flush();
  h.WebSocket.instances[0].open();
  await h.clock.advance(10000);
  assert.ok(h.calls.slice(0, 2).every((call) => call.options.signal.aborted));
  assert.equal(h.statuses.at(-1).state, 'error');
  assert.match(h.statuses.at(-1).message, /履歴.*タイムアウト/);
  await h.clock.advance(1000);
  assert.equal(h.calls.length, 4);
  assert.equal(h.statuses.at(-1).state, 'live');
  assert.equal(h.WebSocket.instances.length, 1);
  h.feed.stop();
});

test('HTTP 429 respects Retry-After and broken JSON recovers without adding sockets', async () => {
  let request = 0;
  const h = harness({ fetch: () => {
    request++;
    if (request === 1) return Promise.resolve(response([], { status: 429, retryAfter: '2' }));
    if (request === 2) return Promise.resolve(response([], { broken: true }));
    return Promise.resolve(response());
  } });
  h.feed.start(); await flush();
  h.WebSocket.instances[0].open();
  assert.equal(h.statuses.at(-1).state, 'error');
  await h.clock.advance(1999);
  assert.equal(h.calls.length, 2);
  await h.clock.advance(1);
  assert.equal(h.calls.length, 4);
  assert.equal(h.statuses.at(-1).state, 'live');
  assert.equal(h.WebSocket.instances.length, 1);
  h.feed.stop();
});

test('malformed socket JSON does not crash; next valid API message restores live state', async () => {
  const h = harness();
  h.feed.start(); await flush(); h.WebSocket.instances[0].open();
  h.WebSocket.instances[0].message('{');
  assert.equal(h.statuses.at(-1).state, 'error');
  h.WebSocket.instances[0].message({ code: 555, id: 'other-api-code', time: TIME });
  assert.equal(h.statuses.at(-1).state, 'live');
  h.WebSocket.instances[0].message(report());
  assert.equal(h.store.snapshot().total, 1);
  h.feed.stop();
});

test('stop aborts in-flight requests and ignores late responses and stale socket callbacks', async () => {
  const pending = [];
  const h = harness({ fetch: () => { const item = deferred(); pending.push(item); return item.promise; } });
  h.feed.start(); await flush();
  const oldMessage = h.WebSocket.instances[0].onmessage;
  h.feed.stop();
  assert.ok(h.calls.every((call) => call.options.signal.aborted));
  pending[0].resolve(response([evaluation])); pending[1].resolve(response([report()]));
  oldMessage({ data: JSON.stringify(report('late')) });
  await flush();
  assert.equal(h.store.snapshot().total, 0);
  assert.equal(h.statuses.at(-1).state, 'stopped');
  assert.equal(h.clock.timers.size, 0);
  await h.feed.refresh();
  assert.equal(h.calls.length, 2);
});

test('offline/online and pagehide/pageshow close old resources and resume once', async () => {
  const h = harness();
  h.feed.start(); await flush();
  h.eventTarget.dispatchEvent(new Event('offline'));
  assert.equal(h.statuses.at(-1).state, 'offline');
  assert.equal(h.WebSocket.instances[0].closeCalls, 1);
  h.eventTarget.dispatchEvent(new Event('online')); h.eventTarget.dispatchEvent(new Event('online'));
  await flush();
  assert.equal(h.WebSocket.instances.length, 2);
  assert.equal(h.calls.length, 4);
  h.eventTarget.dispatchEvent(new Event('pagehide'));
  assert.equal(h.WebSocket.instances[1].closeCalls, 1);
  h.eventTarget.dispatchEvent(new Event('pageshow')); h.eventTarget.dispatchEvent(new Event('pageshow'));
  await flush();
  assert.equal(h.WebSocket.instances.length, 3);
  assert.equal(h.calls.length, 6);
  h.feed.stop();
  h.eventTarget.dispatchEvent(new Event('pageshow'));
  h.eventTarget.dispatchEvent(new Event('online'));
  assert.equal(h.WebSocket.instances.length, 3);
});

test('starting offline opens nothing; manual restart reads current navigator state', async () => {
  const navigator = { onLine: false };
  const h = harness({ options: { navigator } });
  h.feed.start(); await flush();
  assert.equal(h.statuses.at(-1).state, 'offline');
  assert.equal(h.WebSocket.instances.length, 0);
  assert.equal(h.calls.length, 0);
  h.feed.stop();
  navigator.onLine = true; // The online event happened while this feed was stopped.
  h.feed.start(); await flush();
  assert.equal(h.WebSocket.instances.length, 1);
  assert.equal(h.calls.length, 2);
  h.feed.stop();
});

class FakeLocks {
  queue = [];
  held = false;
  request(name, { signal }, callback) {
    return new Promise((resolve, reject) => {
      const entry = { name, signal, callback, resolve, reject };
      entry.abort = () => {
        this.queue = this.queue.filter((item) => item !== entry);
        const error = new Error('Aborted lock request'); error.name = 'AbortError'; reject(error);
      };
      if (signal.aborted) { entry.abort(); return; }
      signal.addEventListener('abort', entry.abort, { once: true });
      this.queue.push(entry);
      this.drain();
    });
  }
  drain() {
    if (this.held || !this.queue.length) return;
    this.held = true;
    const entry = this.queue.shift();
    entry.signal.removeEventListener('abort', entry.abort);
    Promise.resolve().then(() => entry.callback({ name: entry.name })).then(entry.resolve, entry.reject).finally(() => {
      this.held = false;
      this.drain();
    });
  }
}

function channelFactory() {
  const channels = new Set();
  return class FakeBroadcastChannel {
    static channels = channels;
    constructor(name) { this.name = name; channels.add(this); }
    postMessage(data) {
      for (const peer of channels) if (peer !== this && peer.name === this.name) {
        queueMicrotask(() => { if (channels.has(peer)) peer.onmessage?.({ data: structuredClone(data) }); });
      }
    }
    close() { channels.delete(this); this.onmessage = null; }
  };
}

test('document freeze releases the leader socket and lock; resume rejoins without creating a second connection', async () => {
  const clock = new Clock(), locks = new FakeLocks(), BroadcastChannel = channelFactory(), WebSocket = socketFactory();
  const aDocument = new EventTarget(), bDocument = new EventTarget();
  const a = harness({ clock, WebSocket, options: { locks, BroadcastChannel, lifecycleTarget: aDocument } });
  const b = harness({ clock, WebSocket, options: { locks, BroadcastChannel, lifecycleTarget: bDocument } });
  a.feed.start(); await flush(); const first = WebSocket.instances[0]; first.open();
  b.feed.start(); await flush(); assert.equal(WebSocket.instances.length, 1);
  aDocument.dispatchEvent(new Event('freeze')); await flush();
  assert.equal(first.closeCalls, 1);
  assert.equal(WebSocket.instances.length, 2);
  WebSocket.instances[1].open();
  assert.equal(a.statuses.at(-1).state, 'stopped');
  aDocument.dispatchEvent(new Event('resume')); await flush();
  assert.equal(WebSocket.instances.length, 2);
  assert.equal(a.statuses.at(-1).role, 'follower');
  b.feed.stop(); await flush(); assert.equal(WebSocket.instances.length, 3);
  WebSocket.instances[2].open();
  assert.equal(a.statuses.at(-1).role, 'leader');
  a.feed.stop(); await flush(); assert.equal(locks.held, false); assert.equal(clock.timers.size, 0);
  aDocument.dispatchEvent(new Event('resume')); await flush(); assert.equal(WebSocket.instances.length, 3);
});

test('a leader shares normalized WS identifiers with a follower; matching REST backfill remains silent', async () => {
  const clock = new Clock(), locks = new FakeLocks(), BroadcastChannel = channelFactory(), WebSocket = socketFactory();
  let records = [];
  const fetch = url => Promise.resolve(response(records.filter(message => url.includes(`codes=${message.code}`))));
  const options = { locks, BroadcastChannel };
  const a = harness({ clock, WebSocket, fetch, options }), b = harness({ clock, WebSocket, fetch, options });
  a.feed.start(); await flush(); WebSocket.instances[0].open(); b.feed.start(); await flush();
  const canonical = reportAt('6add9bfbc58757000704d541', clock.time);
  const wire = { ...canonical, _id: canonical.id }; delete wire.id;
  WebSocket.instances[0].message(wire); await flush();
  assert.equal(a.store.snapshot().total, 1); assert.equal(b.store.snapshot().total, 1);
  assert.equal(a.live.length, 1); assert.equal(b.live.length, 1); assert.equal(b.live[0].message.id, canonical.id);
  records = [canonical]; await a.feed.refresh(); await flush(); WebSocket.instances[0].message(wire); await flush();
  assert.equal(a.live.length, 1); assert.equal(b.live.length, 1); assert.equal(b.calls.length, 0);
  a.feed.stop(); b.feed.stop(); await flush();
});

test('same-origin tabs share one leader socket, replay recent reports, and take over after leader stop', async () => {
  const clock = new Clock();
  const locks = new FakeLocks();
  const BroadcastChannel = channelFactory();
  const WebSocket = socketFactory();
  const options = { locks, BroadcastChannel };
  const a = harness({ clock, WebSocket, options });
  a.feed.start(); await flush();
  WebSocket.instances[0].open(); WebSocket.instances[0].message(report());
  const b = harness({ clock, WebSocket, options });
  b.feed.start(); await flush();
  assert.equal(WebSocket.instances.length, 1);
  assert.equal(a.calls.length, 2);
  assert.equal(b.calls.length, 0);
  assert.equal(b.store.snapshot().total, 1); // replay, not a new network request
  assert.equal(a.live.length, 1);
  assert.equal(b.live.length, 0); // cached replay never emits a fresh notification
  assert.equal(b.statuses.at(-1).state, 'shared');
  assert.equal(b.statuses.at(-1).upstreamState, 'live');
  WebSocket.instances[0].message(report('second', 270));
  await flush();
  assert.equal(a.store.snapshot().total, 2);
  assert.equal(b.store.snapshot().total, 2);
  assert.equal(a.live.length, 2);
  assert.equal(b.live.length, 1);
  assert.equal(b.live[0].previous.total, 1);
  assert.equal(b.live[0].snapshot.total, 2);
  assert.equal(b.live[0].message.id, 'second');
  assert.equal(b.live[0].receivedAt, clock.time);
  WebSocket.instances[0].message(report('second', 270)); await flush();
  assert.equal(a.live.length, 2);
  assert.equal(b.live.length, 1);
  a.feed.stop(); await flush();
  assert.equal(WebSocket.instances.length, 2);
  assert.equal(b.calls.length, 2);
  WebSocket.instances[1].open();
  assert.equal(b.statuses.at(-1).role, 'leader');
  b.feed.stop(); await flush();
  assert.equal(locks.held, false);
  assert.equal(locks.queue.length, 0);
  assert.equal(BroadcastChannel.channels.size, 0);
});

test('follower stop aborts its pending lock; pagehide releases leadership for another tab', async () => {
  const locks = new FakeLocks();
  const BroadcastChannel = channelFactory();
  const WebSocket = socketFactory();
  const options = { locks, BroadcastChannel };
  const a = harness({ WebSocket, options });
  const b = harness({ WebSocket, options });
  a.feed.start(); b.feed.start(); await flush();
  assert.equal(locks.queue.length, 1);
  b.feed.stop(); await flush();
  assert.equal(locks.queue.length, 0);
  a.feed.stop(); await flush();
  assert.equal(WebSocket.instances.length, 1);
  a.feed.start(); b.feed.start(); await flush();
  a.eventTarget.dispatchEvent(new Event('pagehide'));
  await flush();
  assert.equal(b.statuses.at(-1).role, 'leader');
  assert.equal(WebSocket.instances.length, 3);
  a.feed.stop(); b.feed.stop(); await flush();
  assert.equal(locks.queue.length, 0);
  assert.equal(locks.held, false);
});

test('shared refresh requests coalesce at the leader instead of adding follower sockets/fetches', async () => {
  const pending = [];
  const locks = new FakeLocks();
  const BroadcastChannel = channelFactory();
  const WebSocket = socketFactory();
  const options = { locks, BroadcastChannel };
  const a = harness({ WebSocket, options, fetch: () => {
    const item = deferred(); pending.push(item); return item.promise;
  } });
  const b = harness({ WebSocket, options });
  a.feed.start(); b.feed.start(); await flush();
  await Promise.all([b.feed.refresh(), b.feed.refresh(), b.feed.refresh()]); await flush();
  assert.equal(a.calls.length, 2);
  assert.equal(b.calls.length, 0);
  assert.equal(WebSocket.instances.length, 1);
  pending[0].resolve(response([evaluation])); pending[1].resolve(response([report()]));
  await flush();
  assert.equal(b.store.snapshot().total, 1);
  assert.equal(a.live.length, 0);
  assert.equal(b.live.length, 0); // leader's live BroadcastChannel transport also carries history silently
  a.feed.stop(); b.feed.stop(); await flush();
});

test('a new follower replays the newest cumulative snapshot despite an older racing history response', async () => {
  const pending = [];
  const locks = new FakeLocks();
  const BroadcastChannel = channelFactory();
  const WebSocket = socketFactory();
  const options = { locks, BroadcastChannel };
  const a = harness({ WebSocket, options, fetch: () => {
    const item = deferred(); pending.push(item); return item.promise;
  } });
  a.feed.start(); await flush(); WebSocket.instances[0].open();
  const newer = { ...evaluation, time: '2026/10/20 12:00:10.000', updated_at: '2026/10/20 12:00:10.000',
    count: 7, area_confidences: { 250: { count: 7 } } };
  WebSocket.instances[0].message(newer);
  pending[0].resolve(response([evaluation])); pending[1].resolve(response([report()]));
  await flush();
  const b = harness({ WebSocket, options });
  b.feed.start(); await flush();
  assert.equal(a.store.snapshot().total, 7);
  assert.equal(b.store.snapshot().total, 7);
  assert.equal(WebSocket.instances.length, 1);
  a.feed.stop(); b.feed.stop(); await flush();
});

test('a rejected sharing lock falls back to one direct connection and still cleans up', async () => {
  const BroadcastChannel = channelFactory();
  const h = harness({ options: { locks: { request: () => Promise.reject(new Error('Unavailable')) }, BroadcastChannel } });
  h.feed.start(); await flush();
  assert.equal(h.WebSocket.instances.length, 1);
  assert.equal(h.calls.length, 2);
  assert.equal(h.statuses.at(-1).role, 'direct');
  assert.equal(BroadcastChannel.channels.size, 0);
  h.feed.stop();
});

test('raw history reaches the log without becoming live notifications or adding network requests', async () => {
  const posted=report('history-row');
  const h=harness({fetch:url=>Promise.resolve(response(url.includes('codes=561')?[posted]:[evaluation]))});
  h.feed.start();await flush();
  assert.deepEqual(h.history,[[evaluation,posted]]);
  assert.equal(h.live.length,0);
  assert.equal(h.calls.length,2);
  h.WebSocket.instances[0].open();h.WebSocket.instances[0].message(posted);
  assert.equal(h.live.length,0);
  h.WebSocket.instances[0].message(report('fresh-row'));
  assert.equal(h.live.length,1);
  assert.equal(h.history.length,1);
  h.feed.stop();
});

test('a shared follower can reconstruct raw log history while cached replay stays quiet',async()=>{
  const clock=new Clock(),locks=new FakeLocks(),BroadcastChannel=channelFactory(),WebSocket=socketFactory();
  const options={locks,BroadcastChannel};
  const a=harness({clock,WebSocket,options});a.feed.start();await flush();
  WebSocket.instances[0].open();WebSocket.instances[0].message(report('before-follower'));
  const b=harness({clock,WebSocket,options});b.feed.start();await flush();
  assert.ok(b.history.flat().some(entry=>entry.id==='before-follower'));
  assert.equal(b.live.length,0);assert.equal(b.calls.length,0);assert.equal(WebSocket.instances.length,1);
  WebSocket.instances[0].message(report('after-follower'));await flush();
  assert.equal(b.live.length,1);assert.equal(b.live[0].message.id,'after-follower');
  a.feed.stop();b.feed.stop();await flush();
});

test('a failed log callback cannot stop initial history, live transport, or cleanup',async()=>{
  const h=harness({fetch:url=>Promise.resolve(response(url.includes('codes=561')?[report()]:[])),options:{onHistory(){throw new Error('Log unavailable');}}});
  h.feed.start();await flush();h.WebSocket.instances[0].open();
  assert.equal(h.store.snapshot().total,1);assert.equal(h.statuses.at(-1).state,'live');
  h.WebSocket.instances[0].message(report('next'));
  assert.equal(h.store.snapshot().total,2);assert.equal(h.live.length,1);
  h.feed.stop();assert.equal(h.clock.timers.size,0);
});

test('only the leader polls disconnected history and shares its posts silently with followers', async () => {
  const clock = new Clock(), locks = new FakeLocks(), BroadcastChannel = channelFactory(), WebSocket = socketFactory();
  const options = { locks, BroadcastChannel };
  let reportFetches = 0;
  const a = harness({ clock, WebSocket, options, fetch: url => Promise.resolve(response(url.includes('codes=561') ?
    [report(`shared-poll-${++reportFetches}`)] : [])) });
  const b = harness({ clock, WebSocket, options });
  a.feed.start(); await flush(); b.feed.start(); await flush();
  WebSocket.instances[0].error();
  await clock.advance(30000);
  assert.equal(a.calls.length, 4);
  assert.equal(b.calls.length, 0);
  assert.equal(a.store.snapshot().total, 2);
  assert.equal(b.store.snapshot().total, 2);
  assert.equal(a.live.length, 0);
  assert.equal(b.live.length, 0);
  assert.ok(b.history.flat().some(message => message.id === 'shared-poll-2'));
  a.feed.stop(); b.feed.stop(); await flush();
  assert.equal(clock.timers.size, 0);
});

// Exact public 561 IDs, source times and regions observed during 1025.mp4.
// These are read-only regression records, never submitted to the provider.
const CLIP_REPORTS = [
  ['6add9bfbc58757000704d541',125,'15:04:43.874'],
  ['6add9c02c58757000704d542',120,'15:04:50.770'],
  ['6add9c0ac58757000704d543',150,'15:04:58.318'],
  ['6add9c11c58757000704d545',242,'15:05:05.518'],
  ['6add9c18c58757000704d546',120,'15:05:12.669'],
  ['6add9c1cc58757000704d547',150,'15:05:16.372'],
  ['6add9c1fc58757000704d548',150,'15:05:19.329'],
  ['6add9c20c58757000704d549',125,'15:05:19.809'],
  ['6add9c20c58757000704d54a',900,'15:05:20.193'],
  ['6add9c21c58757000704d54b',125,'15:05:21.648'],
  ['6add9c2bc58757000704d54c',150,'15:05:31.534'],
  ['6add9c36c58757000704d54d',125,'15:05:42.504'],
  ['6add9c40c58757000704d54e',142,'15:05:52.681'],
].map(([id,area,time])=>({code:561,id,area,time:`2026/10/25 ${time}`}));

test('an OPEN socket missing the recorded 13 reports repairs counts and raw logs through silent history only',async()=>{
  const clock=new Clock();clock.time=Date.parse('2026-10-25T15:05:59+09:00');
  const log=new CommunityLog({now:clock.now});let batches=0;
  const h=harness({clock,fetch:url=>Promise.resolve(response(url.includes('codes=561')&&++batches>1?CLIP_REPORTS:[])),
    options:{onHistory:messages=>log.ingestHistory(messages)}});
  h.feed.start();await flush();h.WebSocket.instances[0].open();
  assert.equal(h.statuses.at(-1).state,'live');assert.equal(h.store.snapshot().total,0);
  await clock.advance(29999);assert.equal(h.calls.length,2);
  await clock.advance(1);
  assert.equal(h.calls.length,4);assert.equal(h.store.snapshot().total,13);assert.equal(log.snapshot().total,13);
  assert.equal(h.WebSocket.instances.length,1);assert.equal(h.WebSocket.instances[0].readyState,1);
  assert.equal(h.live.length,0);assert.ok(log.snapshot().entries.every(entry=>entry.history));
  assert.equal(log.snapshot().entries[0].timeLabel,'15:05:52');
  await clock.advance(30000);
  assert.equal(h.store.snapshot().total,13);assert.equal(log.snapshot().total,13);
  for(const message of CLIP_REPORTS)h.WebSocket.instances[0].message(message);
  assert.equal(h.live.length,0,'Backfilled reports cannot later become fresh map, camera or bubble events.');
  assert.equal(h.store.snapshot().total,13);assert.equal(log.snapshot().total,13);
  h.feed.stop();assert.equal(clock.timers.size,0);
});

test('OPEN reconciliation and manual refresh preserve Retry-After without adding sockets',async()=>{
  let requests=0;
  const h=harness({fetch:()=>Promise.resolve(++requests>2&&requests<=4?response([],{status:429,retryAfter:'120'}):response())});
  h.feed.start();await flush();h.WebSocket.instances[0].open();
  await h.clock.advance(30000);assert.equal(h.calls.length,4);
  await h.feed.refresh();await flush();assert.equal(h.calls.length,4);
  await h.clock.advance(119999);assert.equal(h.calls.length,4);
  await h.clock.advance(1);assert.equal(h.calls.length,6);assert.equal(h.WebSocket.instances.length,1);
  assert.equal(h.statuses.at(-1).state,'live');
  h.feed.stop();assert.equal(h.clock.timers.size,0);
});

test('only an OPEN leader reconciles; followers retain data and show upstream reconnecting and polling states',async()=>{
  const clock=new Clock(),locks=new FakeLocks(),BroadcastChannel=channelFactory(),WebSocket=socketFactory();
  let batches=0;const options={locks,BroadcastChannel};
  const a=harness({clock,WebSocket,options,fetch:url=>Promise.resolve(response(url.includes('codes=561')?[report(`open-share-${++batches}`)]:[]))});
  const b=harness({clock,WebSocket,options});
  a.feed.start();await flush();WebSocket.instances[0].open();b.feed.start();await flush();
  assert.equal(b.statuses.at(-1).state,'shared');assert.equal(b.statuses.at(-1).upstreamState,'live');
  await clock.advance(30000);
  assert.equal(a.calls.length,4);assert.equal(b.calls.length,0);assert.equal(WebSocket.instances.length,1);
  assert.equal(a.store.snapshot().total,2);assert.equal(b.store.snapshot().total,2);
  assert.equal(a.live.length,0);assert.equal(b.live.length,0);
  WebSocket.instances[0].error();await flush();
  assert.equal(b.statuses.at(-1).state,'reconnecting');assert.equal(b.statuses.at(-1).upstreamState,'reconnecting');
  assert.equal(b.store.snapshot().total,2);
  await a.feed.refresh();await flush();
  assert.equal(b.statuses.at(-1).state,'polling');assert.equal(b.statuses.at(-1).upstreamState,'polling');
  assert.equal(b.calls.length,0);assert.equal(b.store.snapshot().total,3);
  a.feed.stop();b.feed.stop();await flush();assert.equal(clock.timers.size,0);
});
