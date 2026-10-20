import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {CommunityLogActivity} from '../docs/community-log-activity.js';

const project = JSON.parse(fs.readFileSync(new URL('../docs/assets/project.json', import.meta.url), 'utf8'));
const EPOCH = Date.UTC(2000, 0, 1);
const START = Date.UTC(2026, 9, 20, 12, 0, 30);
const seconds = time => (time - EPOCH) / 1_000;
const inactive = {active: false, kinds: []};

function fixture() {
  const copy = source => Object.fromEntries(Object.entries({...source.variables, ...source.lists})
    .map(([id, [name, value]]) => [id, {name, value: structuredClone(value)}]));
  const stage = {isStage: true, variables: copy(project.targets.find(target => target.isStage))};
  const receiver = {isOriginal: true, getName: () => '受信と検出',
    variables: copy(project.targets.find(target => target.name === '受信と検出'))};
  const vm = {runtime: {targets: [stage, receiver]}};
  const variable = name => Object.values(stage.variables).find(item => item.name === name) ??
    Object.values(receiver.variables).find(item => item.name === name);
  const set = (name, value) => { variable(name).value = value; };
  set('0EEW', Array(140).fill(''));
  set('5地震情報リスト', []);
  set('EEW全体で発表中？', 0);
  set('#リプレイモード', 0);
  set('9津波関連', Array(14).fill(0));
  set('4リアルタイム状況(最大震度など)', Array(14).fill(-3));
  set('検出済みグリッド数', 0);
  let now = START;
  const activity = new CommunityLogActivity({now: () => now});
  return {vm, stage, receiver, variable, set, activity,
    get now() { return now; },
    advance(ms) { now += ms; },
    at(value) { now = value; },
    update() { return activity.update(vm); },
    eew({slot = 0, state = 1, report = 1, origin = START, issue = now} = {}) {
      variable('0EEW').value.splice(slot * 14, 14,
        state, 1, report, 0, seconds(origin), '', '', '', '', 5, 0, 0, 0, seconds(issue));
    },
    normal({issue = now, origin = START - 30_000, id = '01', index = 0} = {}) {
      const row = Array(20).fill('');
      [row[0], row[1], row[4], row[6], row[9], row[11]] = [0, 5, seconds(origin), seconds(issue), id, 'e'];
      const list = variable('5地震情報リスト').value;
      while (list.length < (index + 1) * 20) list.push('');
      list.splice(index * 20, 20, ...row);
    },
  };
}

test('actual native IDs: all ten slots include PLUM/unlocated EEW regardless of camera/history/layout', () => {
  const f = fixture();
  f.eew({slot: 9});
  f.set('タブ', 5);
  f.set('地図過去表示モード', 1);
  f.set('自動カメラ移動許可', 0);
  f.set('ダイアログなう', 'settings');
  const before = structuredClone([f.stage.variables, f.receiver.variables]);
  assert.deepEqual(f.update(), {active: true, kinds: ['eew']});
  assert.deepEqual(f.update(), {active: true, kinds: ['eew']});
  const detached = f.activity.snapshot();
  detached.kinds.push('tsunami');
  assert.deepEqual(f.activity.snapshot(), {active: true, kinds: ['eew']});
  assert.deepEqual([f.stage.variables, f.receiver.variables], before, 'no native writes');
});

test('global EEW flag works without a hypocentre and frozen source expires after five minutes', () => {
  const f = fixture();
  f.set('EEW全体で発表中？', 1);
  assert.equal(f.update().active, true);
  f.advance(5 * 60_000);
  assert.deepEqual(f.update(), inactive);
  assert.deepEqual(f.update(), inactive, 'unchanged active flag does not restart its deadline');
});

test('global-only EEW can start a new session after a real end without positive polling extending it', () => {
  const f = fixture();
  f.set('EEW全体で発表中？', 1);
  assert.equal(f.update().active, true);
  f.advance(1_000);
  f.set('EEW全体で発表中？', 0);
  f.update();
  f.advance(6 * 60_000);
  assert.deepEqual(f.update(), inactive);
  f.set('EEW全体で発表中？', 1);
  assert.deepEqual(f.update(), {active: true, kinds: ['eew']});
  f.advance(5 * 60_000);
  assert.deepEqual(f.update(), inactive);
  assert.deepEqual(f.update(), inactive);
});

test('EEW end has one 30-second grace; repeated ended polling does not slide it', () => {
  const f = fixture();
  f.eew();
  f.update();
  f.advance(1_000);
  f.eew({state: 0});
  assert.equal(f.update().active, true);
  f.advance(29_999);
  assert.equal(f.update().active, true);
  f.advance(1);
  assert.deepEqual(f.update(), inactive);
});

test('cancellation immediately clears the cancelled EEW and grace but preserves another active slot', () => {
  const f = fixture();
  f.eew();
  f.eew({slot: 9, origin: START + 1});
  f.update();
  f.eew({state: -1});
  assert.equal(f.update().active, true);
  f.eew({slot: 9, state: 0, origin: START + 1});
  f.update();
  f.eew({slot: 9, state: -1, origin: START + 1});
  assert.deepEqual(f.update(), inactive);
  f.eew({report: 1});
  assert.deepEqual(f.update(), inactive, 'replayed cancelled origin cannot reopen the log');
});

test('only genuine forward EEW information renews the stale deadline, never wave animation or older reports', () => {
  const f = fixture();
  f.eew();
  f.update();
  f.advance(60_000);
  f.eew({report: 2});
  f.update();
  f.advance(60_000);
  f.eew({report: 1, issue: START});
  f.update();
  f.variable('0EEW').value.splice(10, 3, 500, 1000, 1200);
  f.advance(4 * 60_000);
  assert.deepEqual(f.update(), inactive);
  f.eew({report: 3});
  assert.equal(f.update().active, true, 'a genuinely new follow-up can restore an active native alert');
});

test('allowed shaking sources activate; end grace expires and unrelated raw station values do not activate', () => {
  const f = fixture();
  assert.deepEqual(f.update(), inactive);
  f.set('検出済みグリッド数', 1);
  assert.deepEqual(f.update(), {active: true, kinds: ['shaking']});
  f.set('検出済みグリッド数', 0);
  f.variable('4リアルタイム状況(最大震度など)').value[7] = 4;
  assert.equal(f.update().active, true);
  f.variable('4リアルタイム状況(最大震度など)').value[7] = -3;
  f.variable('4リアルタイム状況(最大震度など)').value[0] = 9;
  f.update();
  f.advance(30_000);
  assert.deepEqual(f.update(), inactive);
});

test('frozen positive shaking expires after five minutes without polling or unrelated animation extending it', () => {
  const f = fixture();
  f.set('検出済みグリッド数', 1);
  assert.deepEqual(f.update(), {active: true, kinds: ['shaking']});
  f.advance(4 * 60_000);
  f.variable('0EEW').value.splice(10, 3, 400, 600, 900);
  assert.equal(f.update().active, true);
  f.advance(60_000);
  assert.deepEqual(f.update(), inactive);
  f.advance(24 * 60 * 60_000);
  assert.deepEqual(f.update(), inactive);
  f.set('検出済みグリッド数', 0);
  assert.deepEqual(f.update(), inactive, 'a late stop cannot reopen a stale detector for its end grace');
});

test('real detector changes renew progress and a stopped detector can open a new shaking session', () => {
  const f = fixture();
  f.set('検出済みグリッド数', 1);
  f.update();
  f.advance(4 * 60_000);
  f.variable('4リアルタイム状況(最大震度など)').value[7] = 3;
  f.update();
  f.advance(4 * 60_000);
  assert.equal(f.update().active, true, 'a genuine allowed intensity change renewed the five-minute guard');
  f.advance(60_000);
  assert.deepEqual(f.update(), inactive);
  f.set('検出済みグリッド数', 0);
  f.variable('4リアルタイム状況(最大震度など)').value[7] = -3;
  f.update();
  f.advance(1_000);
  f.set('検出済みグリッド数', 1);
  assert.deepEqual(f.update(), {active: true, kinds: ['shaking']}, 'the same count after a real stop is a new session');
});

test('tsunami stays active until native cancellation; residual map geometry is not a live warning', () => {
  const f = fixture();
  f.set('tsu: 地図表示集', [123, 4]);
  f.set('地図表示モード', 3);
  assert.deepEqual(f.update(), inactive);
  f.variable('9津波関連').value[0] = 4;
  assert.deepEqual(f.update(), {active: true, kinds: ['tsunami']});
  f.advance(24 * 60 * 60_000);
  assert.equal(f.update().active, true);
  f.variable('9津波関連').value[0] = 0;
  assert.deepEqual(f.update(), inactive);
});

test('initial normal history is silent, including the first valid record after an empty startup', () => {
  const f = fixture();
  f.normal();
  assert.deepEqual(f.update(), inactive);
  f.advance(1_000);
  f.variable('5地震情報リスト').value[7] = 140;
  assert.deepEqual(f.update(), inactive, 'late coordinates are not a fresh issue');
  const late = fixture();
  late.update();
  late.advance(30_000);
  late.normal();
  assert.deepEqual(late.update(), inactive);
});

test('new normal issue and same-event follow-up show for two minutes without requiring coordinates', () => {
  const f = fixture();
  f.normal({issue: START - 60_000});
  f.update();
  f.advance(1_000);
  f.normal();
  assert.deepEqual(f.update(), {active: true, kinds: ['earthquake']});
  f.advance(100_000);
  f.normal();
  assert.equal(f.update().active, true);
  f.advance(119_999);
  assert.equal(f.update().active, true);
  f.advance(1);
  assert.deepEqual(f.update(), inactive, 'identical polling never extends the hold');
});

test('old, future and selected history records cannot extend or reopen normal activity', () => {
  const f = fixture();
  f.normal({issue: START - 60_000});
  f.update();
  f.advance(1_000);
  f.normal();
  f.update();
  f.advance(1_000);
  f.normal({issue: f.now + 10 * 60_000, id: 'future'});
  f.update();
  f.normal({issue: START - 30_000, id: 'old'});
  f.update();
  f.normal({issue: f.now, index: 1, id: 'history-selection'});
  f.update();
  f.advance(119_000);
  assert.deepEqual(f.update(), inactive);
  f.normal({issue: START + 602_000, id: 'future'});
  f.at(START + 603_000);
  assert.deepEqual(f.update(), inactive, 'a previously seen future snapshot stays silent when time catches up');
});

test('replay, unreadable native data, project replacement and reset cannot leave a permanent log', () => {
  const f = fixture();
  f.eew();
  f.normal();
  f.variable('9津波関連').value[0] = 1;
  assert.equal(f.update().active, true);
  f.set('#リプレイモード', 1);
  assert.deepEqual(f.update(), inactive);
  f.set('#リプレイモード', 0);
  f.set('0EEW', []);
  assert.deepEqual(f.update(), inactive);
  assert.deepEqual(f.activity.snapshot(), inactive);
  const replacement = fixture();
  replacement.normal();
  assert.deepEqual(f.activity.update(replacement.vm), inactive, 'new project history seeds silently');
  replacement.eew();
  assert.equal(f.activity.update(replacement.vm).active, true);
  assert.deepEqual(f.activity.reset(), inactive);
  assert.deepEqual(f.activity.snapshot(), inactive);
});

test('invalid/backward clocks and throwing source reads fail closed', () => {
  const f = fixture();
  f.eew();
  f.update();
  f.at(START - 1);
  assert.deepEqual(f.update(), inactive);
  f.at(NaN);
  assert.deepEqual(f.update(), inactive);
  f.at(START);
  assert.equal(f.update().active, true);
  Object.defineProperty(f.vm.runtime, 'targets', {get() { throw new Error('disposed'); }});
  assert.deepEqual(f.update(), inactive);
});
