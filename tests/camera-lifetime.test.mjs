import assert from 'node:assert/strict';
import test from 'node:test';
import { CameraLifetime, CAMERA_EEW_END_GRACE_MS, CAMERA_INFORMATION_HOLD_MS,
  CAMERA_MANUAL_HOLD_MS, CAMERA_EEW_STALE_MS } from '../docs/camera-lifetime.js';
import { EarthquakeMonitor } from '../docs/camera-event.js';

const START = Date.UTC(2026, 9, 20, 12, 0, 30);
const event = (extra = {}) => ({ id: 'eew:one', sourceId: 'eew:one', kind: 'eew',
  time: START, receivedAt: START, report: 1, lat: 42, lon: 142.3, regionCode: 192,
  maxIntensity: 5, magnitude: 6.2, depth: 30, present: true, reliable: true, located: true,
  active: true, nativeActive: true, recent: true, ...extra });
const normal = (extra = {}) => event({ id: 'earthquake:one', sourceId: 'earthquake:one',
  kind: 'earthquake', report: null, infoType: 'e', ...extra });
function clock() {
  let time = START;
  return { now: () => time, get time() { return time; }, advance(ms) { time += ms; }, set(value) { time = value; } };
}

test('EEW ends after one 30-second grace; repeated inactive polls do not postpone it', () => {
  const c = clock(), lifetime = new CameraLifetime({ now: c.now });
  lifetime.start(event()); c.advance(10_000);
  const ended = event({ active: false, nativeActive: false, reason: 'ended' });
  const first = lifetime.update(ended);
  assert.equal(first.expiresAt, c.time + CAMERA_EEW_END_GRACE_MS);
  assert.equal(first.close, false);
  c.advance(29_999);
  assert.equal(lifetime.update({ ...ended, ageMs: 999999 }).expiresAt, first.expiresAt);
  assert.equal(lifetime.update(ended).close, false);
  c.advance(1);
  assert.equal(lifetime.update(ended).close, true);
  assert.equal(lifetime.update(ended).reason, 'eew-ended');
});

test('disappearing EEW data starts grace even when retained native activity is true', () => {
  const c = clock(), lifetime = new CameraLifetime({ now: c.now });
  lifetime.start(event()); c.advance(1000);
  const missing = event({ present: false });
  const first = lifetime.update(missing);
  c.advance(20_000);
  assert.equal(lifetime.update(missing).expiresAt, first.expiresAt);
  c.advance(10_000);
  assert.equal(lifetime.update(null).reason, 'eew-ended');
});

test('only genuine active EEW progress cancels an ending or missing grace', () => {
  const c = clock(), lifetime = new CameraLifetime({ now: c.now });
  lifetime.start(event());
  const ending = lifetime.update(event({ present: false }));
  c.advance(10_000);
  assert.equal(lifetime.update(event()).expiresAt, ending.expiresAt, 'a frozen active flag cannot revive the event');
  const resumed = lifetime.update(event({ report: 2, receivedAt: c.time }));
  assert.equal(resumed.close, false);
  assert.equal(resumed.expiresAt, c.time + CAMERA_EEW_STALE_MS);
  c.advance(40_000);
  assert.equal(lifetime.update(event({ report: 2, receivedAt: START + 10_000 })).close, false);
});

test('fresh active EEW updates can continue beyond ten minutes despite origin-based stale flags', () => {
  const c = clock(), lifetime = new CameraLifetime({ now: c.now });
  lifetime.start(event());
  for (let report = 2; report <= 5; report++) {
    c.advance(4 * 60_000);
    const status = event({ report, receivedAt: c.time, active: false, nativeActive: true, recent: false, reason: 'stale' });
    const decision = lifetime.update(status);
    assert.equal(decision.close, false);
    assert.equal(decision.expiresAt, c.time + CAMERA_EEW_STALE_MS);
  }
  assert.ok(c.time - START > 10 * 60_000);
});

test('a frozen active VM expires after five minutes; polling and animation fields cannot extend it', () => {
  const c = clock(), lifetime = new CameraLifetime({ now: c.now });
  const initial = lifetime.start(event());
  for (let second = 1; second < 300; second++) {
    c.advance(1000);
    const decision = lifetime.update(event({ ageMs: second * 1000, elapsed: second, pWaveRadius: second * 3, sWaveRadius: second * 2, recent: second < 200 }));
    assert.equal(decision.close, false);
    assert.equal(decision.expiresAt, initial.expiresAt);
  }
  c.advance(1000);
  assert.equal(lifetime.update(event()).reason, 'eew-stale');
});

test('an explicit EEW end receives full grace even near the stale-feed deadline', () => {
  const c = clock(), lifetime = new CameraLifetime({ now: c.now });
  lifetime.start(event()); c.advance(CAMERA_EEW_STALE_MS - 10_000);
  const ended = event({ active: false, nativeActive: false });
  const first = lifetime.update(ended);
  assert.equal(first.expiresAt, c.time + CAMERA_EEW_END_GRACE_MS);
  c.advance(20_000);
  assert.equal(lifetime.update(ended).close, false);
  c.advance(10_000);
  assert.equal(lifetime.update(ended).reason, 'eew-ended');
});

test('ordinary earthquake information expires after two minutes without an end signal', () => {
  const c = clock(), lifetime = new CameraLifetime({ now: c.now });
  const first = lifetime.start(normal());
  assert.equal(first.expiresAt, START + CAMERA_INFORMATION_HOLD_MS);
  c.advance(CAMERA_INFORMATION_HOLD_MS - 1);
  assert.equal(lifetime.update(normal({ ageMs: 119999, recent: false, active: false, reason: 'stale' })).close, false);
  c.advance(1);
  assert.equal(lifetime.update(normal()).reason, 'information-timeout');
});

test('new issue times and distinct source changes extend normal information only once', () => {
  for (const change of [
    { receivedAt: START + 60_000 }, { report: 2 }, { infoType: 'h' }, { lat: 41.9 },
    { lon: 142.4 }, { maxIntensity: 6 }, { magnitude: 6.3 }, { depth: 40 },
  ]) {
    const c = clock(), lifetime = new CameraLifetime({ now: c.now });
    lifetime.start(normal()); c.advance(60_000);
    const updated = normal(change), expected = c.time + CAMERA_INFORMATION_HOLD_MS;
    assert.equal(lifetime.update(updated).expiresAt, expected);
    c.advance(60_000);
    assert.equal(lifetime.update({ ...updated, ageMs: 120000 }).expiresAt, expected);
    assert.equal(lifetime.update(updated).close, false);
    c.advance(60_000);
    assert.equal(lifetime.update(updated).reason, 'information-timeout');
  }
});

test('out-of-order older issues and lower EEW report replays do not count as progress', () => {
  const c = clock(), lifetime = new CameraLifetime({ now: c.now });
  lifetime.start(normal({ receivedAt: START, infoType: 'h' })); c.advance(60_000);
  assert.equal(lifetime.update(normal({ receivedAt: START - 1000, infoType: 'e', lat: 43 })).expiresAt, START + CAMERA_INFORMATION_HOLD_MS);
  lifetime.start(event({ report: 4 }));
  const limit = c.time + CAMERA_EEW_STALE_MS;
  c.advance(60_000);
  assert.equal(lifetime.update(event({ report: 3, lat: 41 })).expiresAt, limit);
});

test('an EEW-to-normal follow-up removes the old grace and uses the new information deadline', () => {
  const c = clock(), lifetime = new CameraLifetime({ now: c.now });
  lifetime.start(event()); c.advance(10_000);
  const ending = lifetime.update(event({ nativeActive: false, active: false }));
  c.advance(10_000);
  const followup = normal({ id: 'eew:one', receivedAt: c.time });
  const decision = lifetime.update(followup);
  assert.equal(decision.expiresAt, c.time + CAMERA_INFORMATION_HOLD_MS);
  assert.ok(decision.expiresAt > ending.expiresAt);
  c.advance(30_000);
  assert.equal(lifetime.update(followup).close, false);
  c.advance(90_000);
  assert.equal(lifetime.update(followup).reason, 'information-timeout');
});

test('an associated normal-to-active-EEW update uses EEW freshness instead of an old normal deadline', () => {
  const c = clock(), lifetime = new CameraLifetime({ now: c.now });
  lifetime.start(normal()); c.advance(90_000);
  const eew = event({ id: 'earthquake:one', report: 2, receivedAt: c.time });
  const decision = lifetime.update(eew);
  assert.equal(decision.expiresAt, c.time + CAMERA_EEW_STALE_MS);
  c.advance(60_000);
  assert.equal(lifetime.update(eew).close, false);
});

test('replayed EEW/normal aliases cannot roll the current policy back or extend its deadline', () => {
  const c = clock(), lifetime = new CameraLifetime({ now: c.now });
  const initial = event(); lifetime.start(initial);
  c.advance(1000);
  const followup = normal({ id: initial.id, receivedAt: c.time });
  const normalDecision = lifetime.update(followup);
  c.advance(1000);
  assert.deepEqual(lifetime.update(initial), normalDecision);
  // A genuinely new EEW report may switch the same canonical event again.
  const resumed = event({ report: 2, receivedAt: c.time });
  const eewDecision = lifetime.update(resumed);
  assert.equal(eewDecision.expiresAt, c.time + CAMERA_EEW_STALE_MS);
  c.advance(1000);
  assert.deepEqual(lifetime.update(followup), eewDecision);
  // Activity alone is still an ending signal when the source kind is current.
  const ended = lifetime.update({ ...resumed, nativeActive: false, active: false });
  assert.equal(ended.expiresAt, c.time + CAMERA_EEW_END_GRACE_MS);
});

test('manual previews have a fixed two-minute limit even when live follow-ups continue', () => {
  for (const initial of [event(), normal()]) {
    const c = clock(), lifetime = new CameraLifetime({ now: c.now });
    const first = lifetime.start({ ...initial, manual: true });
    assert.equal(first.expiresAt, START + CAMERA_MANUAL_HOLD_MS);
    c.advance(60_000);
    assert.equal(lifetime.update({ ...initial, receivedAt: c.time, report: 2 }).expiresAt, first.expiresAt);
    c.advance(60_000);
    assert.equal(lifetime.update({ ...initial, receivedAt: c.time, report: 3 }).reason, 'manual-timeout');
  }
});

test('a manual EEW preview still obeys an earlier end grace', () => {
  const c = clock(), lifetime = new CameraLifetime({ now: c.now });
  lifetime.start(event(), { manual: true });
  const ended = event({ active: false, nativeActive: false });
  assert.equal(lifetime.update(ended).expiresAt, START + CAMERA_EEW_END_GRACE_MS);
  c.advance(CAMERA_EEW_END_GRACE_MS);
  assert.equal(lifetime.update(ended).reason, 'eew-ended');
});

test('a new automatic earthquake resets manual/end deadlines and ignores old event callbacks', () => {
  const c = clock(), lifetime = new CameraLifetime({ now: c.now });
  lifetime.start(event(), { manual: true });
  const old = lifetime.update(event({ nativeActive: false, active: false }));
  c.advance(20_000);
  const next = event({ id: 'eew:two', sourceId: 'eew:two', receivedAt: c.time });
  const current = lifetime.start(next);
  assert.ok(current.generation > old.generation);
  c.advance(20_000);
  assert.deepEqual(lifetime.update(event({ cancelled: true })), current);
  c.advance(CAMERA_MANUAL_HOLD_MS);
  assert.equal(lifetime.update(next).close, false);
  assert.equal(lifetime.update(next).expiresAt, current.expiresAt);
});

test('cancellation, replay, training, uncertainty, missing hypocentre and future events close immediately', () => {
  for (const [fields, reason] of [
    [{ cancelled: true }, 'cancelled'], [{ replay: true }, 'replay'], [{ training: true }, 'training'],
    [{ reliable: false }, 'uncertain-hypocentre'], [{ located: false }, 'unlocated'], [{ reason: 'future' }, 'future'],
  ]) {
    const c = clock(), lifetime = new CameraLifetime({ now: c.now });
    lifetime.start(event()); c.advance(1000);
    const decision = lifetime.update(event(fields));
    assert.equal(decision.close, true); assert.equal(decision.reason, reason); assert.equal(decision.expiresAt, c.time);
    assert.equal(lifetime.update(event()).close, true, 'a later safe poll does not reopen a closed camera');
  }
});

test('expired sessions stay closed until explicit adoption; clear removes all old state', () => {
  const c = clock(), lifetime = new CameraLifetime({ now: c.now });
  lifetime.start(normal()); c.advance(CAMERA_INFORMATION_HOLD_MS);
  const ended = lifetime.update(normal());
  assert.equal(ended.close, true);
  assert.deepEqual(lifetime.update(normal({ receivedAt: c.time })), ended);
  const cleared = lifetime.clear();
  assert.equal(cleared.id, null); assert.equal(cleared.close, false); assert.equal(cleared.expiresAt, null);
  assert.ok(cleared.generation > ended.generation);
  assert.deepEqual(lifetime.update(normal()), cleared);
  assert.equal(lifetime.start(normal(), { manual: true }).close, false);
});

test('input snapshots remain unchanged and invalid clocks cannot leave playback running indefinitely', () => {
  const c = clock(), lifetime = new CameraLifetime({ now: c.now });
  const frozen = Object.freeze(event());
  lifetime.start(frozen); lifetime.update(frozen);
  assert.equal(frozen.nativeActive, true);
  c.set(START - 1);
  assert.equal(lifetime.update(frozen).reason, 'invalid-clock');
  c.set(NaN);
  assert.equal(lifetime.start(event()).reason, 'invalid-clock');
  assert.equal(new CameraLifetime({ now() { throw new Error('clock failed'); } }).start(event()).close, true);
  assert.equal(lifetime.start({}).reason, 'invalid-event');
  assert.throws(() => new CameraLifetime({ eewStaleMs: Infinity }), RangeError);
});

function nativeFixture() {
  const c = clock();
  const variables = Object.fromEntries(['0EEW', '0-2EEW追加情報', '5地震情報リスト', '#リプレイモード', 'd 地名-コード全集']
    .map(name => [name, { name, value: name === '#リプレイモード' ? 0 : [] }]));
  const vm = { runtime: { targets: [{ isStage: true, variables }] } };
  const epoch = Date.UTC(2000, 0, 1), seconds = time => (time - epoch) / 1000;
  const origin = START + 1000;
  const eew = ({ state = 1, report = 1 } = {}) => {
    variables['0EEW'].value = [state, 0, report, 192, seconds(origin), 142.3, 42, 30, 6.2, 5, 0, 0, 0, seconds(c.time)];
    variables['0-2EEW追加情報'].value = Array(14).fill('');
    variables['0-2EEW追加情報'].value[5] = '000030';
  };
  const normal = () => {
    variables['0EEW'].value = [];
    variables['5地震情報リスト'].value = [192, 5, 6.2, 30, seconds(Math.floor(origin / 60000) * 60000), '', seconds(c.time), 142.3, 42, '01', 1, 'e', 0, '', '', '', '', '', '', ''];
  };
  const monitor = new EarthquakeMonitor({ now: c.now }); monitor.update(vm);
  c.advance(1000); eew();
  const current = monitor.update(vm);
  const lifetime = new CameraLifetime({ now: c.now }); lifetime.start(current);
  return { c, vm, variables, monitor, lifetime, current, eew, normal };
}

test('real EarthquakeMonitor nativeActive keeps fresh EEW reports alive after its five-minute recent cutoff', () => {
  const h = nativeFixture();
  assert.equal(h.current.isNew, true);
  for (let report = 2; report <= 7; report++) {
    h.c.advance(2 * 60_000); h.eew({ report }); h.monitor.update(h.vm);
    const status = h.monitor.status(h.current.id);
    if (report >= 4) { assert.equal(status.recent, false); assert.equal(status.active, false); }
    assert.equal(status.nativeActive, true);
    assert.equal(h.lifetime.update(status).close, false);
  }
});

test('real EarthquakeMonitor associated normal follow-up replaces an ended EEW grace without reopening', () => {
  const h = nativeFixture();
  h.c.advance(1000); h.eew({ state: 0, report: 2 }); h.monitor.update(h.vm);
  const ending = h.lifetime.update(h.monitor.status(h.current.id));
  assert.equal(ending.expiresAt, h.c.time + CAMERA_EEW_END_GRACE_MS);
  h.c.advance(10_000); h.normal();
  const followup = h.monitor.update(h.vm);
  assert.equal(followup.id, h.current.id); assert.equal(followup.isNew, false); assert.equal(followup.kind, 'earthquake');
  const decision = h.lifetime.update(h.monitor.status(h.current.id));
  assert.equal(decision.expiresAt, h.c.time + CAMERA_INFORMATION_HOLD_MS);
  h.c.advance(30_000);
  assert.equal(h.lifetime.update(h.monitor.status(h.current.id)).close, false);
});
