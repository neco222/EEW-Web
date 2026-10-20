import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { EarthquakeMonitor, readEarthquake } from "../docs/camera-event.js";

const project = JSON.parse(fs.readFileSync(new URL("../docs/assets/project.json", import.meta.url), "utf8"));
const source = project.targets.find((target) => target.isStage);
const EPOCH = Date.UTC(2000, 0, 1);
const START = Date.UTC(2026, 9, 20, 12, 0, 30);
const seconds = (time) => (time - EPOCH) / 1_000;
const names = ["0EEW", "0-2EEW追加情報", "5地震情報リスト", "#リプレイモード", "d 地名-コード全集"];

function fixture() {
  const variables = {};
  for (const [id, [name, value]] of Object.entries({ ...source.variables, ...source.lists })) {
    if (names.includes(name)) variables[id] = { name, value: structuredClone(value) };
  }
  const stage = { isStage: true, variables };
  const vm = { runtime: { targets: [stage] } };
  const variable = (name) => Object.values(stage.variables).find((item) => item.name === name);
  const set = (name, value) => { variable(name).value = value; };
  set("0EEW", Array(140).fill(""));
  set("0-2EEW追加情報", Array(140).fill(""));
  set("5地震情報リスト", Array(200).fill(""));
  set("#リプレイモード", 0);
  let now = START;
  const options = { now: () => now };
  return {
    vm, stage, variable, set, options,
    advance(ms) { now += ms; return now; },
    get now() { return now; },
    eew({ time = now, state = 1, report = 1, slot = 0, flags = "000030", lat = 42, lon = 142.3, code = 192, max = 5, warning = 0 } = {}) {
      const list = variable("0EEW").value;
      list.splice(slot * 14, 14, state, warning, report, code, seconds(time), lon, lat, 30, 6.2, max, 0, 0, 0, seconds(now));
      variable("0-2EEW追加情報").value[slot * 14 + 5] = flags;
    },
    earthquake({ time = Math.floor(now / 60_000) * 60_000, receivedAt = now, id = "01", lat = 42, lon = 142.3, code = 192, max = 4, index = 0 } = {}) {
      const list = variable("5地震情報リスト").value;
      list.splice(index * 20, 20, code, max, "5.4", 30, seconds(time), "20日21時00分", seconds(receivedAt), lon, lat, id, 1, "e", 0, "", "", "", "", "", "", "");
    },
  };
}

test("reads the actual project's IDs, 14-item EEW fields, UTC time, and native intensity label", () => {
  const f = fixture();
  f.eew({ time: START - 10_000, report: 2, max: 6, warning: 1, flags: "000000" });
  const before = structuredClone(f.stage.variables);
  const event = readEarthquake(f.vm, START);
  assert.equal(event.kind, "eew");
  assert.equal(event.time, START - 10_000);
  assert.equal(event.lat, 42);
  assert.equal(event.lon, 142.3);
  assert.equal(event.name, "浦河沖");
  assert.equal(event.maxIntensity, 6);
  assert.equal(event.maxIntensityLabel, "5強");
  assert.equal(event.report, 2);
  assert.equal(event.recent, true);
  assert.equal(event.actionable, true);
  assert.deepEqual(f.stage.variables, before, "native runtime is never mutated");
});

test("uses the latest normal record, never the selected history row", () => {
  const f = fixture();
  f.earthquake({ id: "02", lat: 35.6, lon: 140.5, code: 473 });
  f.earthquake({ id: "01", time: START - 3600_000, lat: 40, lon: 141, index: 1 });
  f.stage.variables.selection = { name: "履歴選択", value: 1 };
  const first = readEarthquake(f.vm, START);
  f.stage.variables.selection.value = 0;
  assert.deepEqual(readEarthquake(f.vm, START), first);
  assert.equal(first.name, "千葉県東方沖");
  assert.equal(first.lat, 35.6);
  assert.equal(first.timeResolutionMs, 60_000);
});

test("initial normal history stays silent, including late coordinates and late initial load", () => {
  const f = fixture();
  const monitor = new EarthquakeMonitor(f.options);
  f.earthquake({ lat: "", lon: "" });
  assert.equal(monitor.update(f.vm).isNew, false);
  f.earthquake();
  assert.equal(monitor.update(f.vm).isNew, false);
  const empty = fixture();
  const second = new EarthquakeMonitor(empty.options);
  assert.equal(second.update(empty.vm), null);
  empty.advance(2_000);
  empty.earthquake({ time: START - 30_000 });
  assert.equal(second.update(empty.vm).isNew, false);
});

test("first active EEW is opt-in and limited to three minutes", () => {
  const f = fixture();
  f.eew({ time: START - 30_000 });
  const silent = new EarthquakeMonitor(f.options);
  assert.equal(silent.update(f.vm).isNew, false);
  const visible = new EarthquakeMonitor({ ...f.options, showActiveOnStart: true });
  assert.equal(visible.update(f.vm).isNew, true);
  assert.equal(visible.update(f.vm).isNew, false);
  const old = new EarthquakeMonitor({ ...f.options, showActiveOnStart: true });
  f.eew({ time: START - 180_001 });
  assert.equal(old.update(f.vm).isNew, false);
  const ended = new EarthquakeMonitor({ ...f.options, showActiveOnStart: true });
  f.eew({ time: START - 30_000, state: 0 });
  assert.equal(ended.update(f.vm).isNew, false);
});

test("startup EEW allowance survives an empty first native snapshot", () => {
  const f = fixture();
  const monitor = new EarthquakeMonitor({ ...f.options, showActiveOnStart: true });
  assert.equal(monitor.update(f.vm), null);
  f.advance(1_000);
  f.eew({ time: START - 20_000 });
  assert.equal(monitor.update(f.vm).isNew, true);
});

test("a newly received normal earthquake opens once and coordinates may arrive later", () => {
  const f = fixture();
  const monitor = new EarthquakeMonitor(f.options);
  monitor.update(f.vm);
  f.advance(90_000);
  f.earthquake({ lat: "", lon: "" });
  const pending = monitor.update(f.vm);
  assert.equal(pending.reason, "unlocated");
  assert.equal(pending.isNew, false);
  f.earthquake();
  const located = monitor.update(f.vm);
  assert.equal(located.isNew, true);
  assert.equal(located.id, pending.id);
  assert.equal(monitor.update(f.vm).isNew, false);
  f.earthquake({ lat: 41.9, max: 6 });
  assert.equal(monitor.update(f.vm).maxIntensityLabel, "5強");
  assert.equal(monitor.update(f.vm).isNew, false);
});

test("EEW follow-ups, tiny origin corrections, and later normal information do not reopen", () => {
  const f = fixture();
  const monitor = new EarthquakeMonitor(f.options);
  monitor.update(f.vm);
  const time = f.advance(1_000);
  f.eew({ time });
  const first = monitor.update(f.vm);
  assert.equal(first.isNew, true);
  f.eew({ time: time + 2_000, report: 2, max: 7 });
  const update = monitor.update(f.vm);
  assert.equal(update.isNew, false);
  assert.equal(update.id, first.id);
  assert.equal(update.maxIntensityLabel, "6弱");
  f.set("0EEW", Array(140).fill(""));
  f.earthquake({ time: Math.floor(time / 60_000) * 60_000 });
  const normal = monitor.update(f.vm);
  assert.equal(normal.id, first.id);
  assert.equal(normal.isNew, false);
});

test("cancellation is observable, never launches, and never reopens the same event", () => {
  const f = fixture();
  const monitor = new EarthquakeMonitor(f.options);
  monitor.update(f.vm);
  f.advance(1_000);
  const time = f.now;
  f.eew({ time });
  assert.equal(monitor.update(f.vm).isNew, true);
  f.eew({ time, state: -1, report: 2 });
  const cancelled = monitor.update(f.vm);
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.active, false);
  assert.equal(cancelled.isNew, false);
  assert.equal(cancelled.reason, "cancelled");
  f.eew({ time, report: 3 });
  const repeated = monitor.update(f.vm);
  assert.equal(repeated.isNew, false);
  assert.equal(repeated.active, false);
  assert.equal(repeated.reason, "cancelled");
  f.set("0EEW", []);
  f.earthquake({ time: Math.floor(time / 60_000) * 60_000 });
  assert.equal(monitor.update(f.vm).cancelled, true);
  assert.equal(monitor.update(f.vm).active, false);
});

test("replay/training never triggers, including when leaving replay", () => {
  const f = fixture();
  const monitor = new EarthquakeMonitor({ ...f.options, showActiveOnStart: true });
  f.set("#リプレイモード", 1);
  f.eew({ time: START - 10_000 });
  const replay = monitor.update(f.vm);
  assert.equal(replay.training, true);
  assert.equal(replay.reason, "replay");
  assert.equal(replay.isNew, false);
  f.set("#リプレイモード", 0);
  assert.equal(monitor.update(f.vm).isNew, false);

  // A replay loaded after monitoring began can have an origin after the seed
  // time. Merely leaving replay still must not turn that data into a live event.
  const late = fixture();
  const laterMonitor = new EarthquakeMonitor(late.options);
  laterMonitor.update(late.vm);
  late.advance(10_000);
  late.set("#リプレイモード", 1);
  late.eew();
  assert.equal(laterMonitor.update(late.vm).isNew, false);
  late.set("#リプレイモード", 0);
  assert.equal(laterMonitor.update(late.vm).isNew, false);
});

test("PLUM, assumed intensity, few stations, and unknown flags do not establish an epicentre", () => {
  for (const flags of ["100030", "010030", "001030", "000010", "000020", "", "garbage"]) {
    const f = fixture();
    f.eew({ flags });
    const monitor = new EarthquakeMonitor({ ...f.options, showActiveOnStart: true });
    const event = monitor.update(f.vm);
    assert.equal(event.reliable, false, flags);
    assert.equal(event.isNew, false, flags);
    assert.equal(event.reason, "uncertain-hypocentre", flags);
  }
});

test("malformed coordinates/timestamps and future origins cannot launch", () => {
  for (const overrides of [{ lat: "" }, { lon: "n" }, { lat: 91 }, { lon: 181 }, { lat: false }, { lat: 0, lon: 0 }]) {
    const f = fixture();
    f.eew(overrides);
    const event = new EarthquakeMonitor({ ...f.options, showActiveOnStart: true }).update(f.vm);
    assert.equal(event.located, false, JSON.stringify(overrides));
    assert.equal(event.isNew, false);
  }
  const f = fixture();
  f.eew({ time: START + 60_000 });
  assert.equal(readEarthquake(f.vm, START).reason, "future");
  assert.equal(new EarthquakeMonitor({ ...f.options, showActiveOnStart: true }).update(f.vm).isNew, false);
  f.variable("0EEW").value[4] = "not-a-time";
  assert.equal(readEarthquake(f.vm, START), null);

  const later = fixture();
  const monitor = new EarthquakeMonitor(later.options);
  monitor.update(later.vm);
  later.eew({ time: START + 60_000 });
  assert.equal(monitor.update(later.vm).isNew, false);
  later.advance(60_000);
  assert.equal(monitor.update(later.vm).isNew, false, "clock catching up does not promote corrupt future data");
});

test("stale EEW becomes inactive and disappeared native data returns null", () => {
  const f = fixture();
  f.eew();
  const monitor = new EarthquakeMonitor({ ...f.options, showActiveOnStart: true });
  assert.equal(monitor.update(f.vm).isNew, true);
  f.advance(300_001);
  const stale = monitor.update(f.vm);
  assert.equal(stale.recent, false);
  assert.equal(stale.active, false);
  assert.equal(stale.reason, "stale");
  f.set("0EEW", []);
  assert.equal(monitor.update(f.vm), null);
});

test("multiple EEWs use latest origin; corrupt future slot does not hide a valid event", () => {
  const f = fixture();
  f.eew({ time: START - 40_000, slot: 0 });
  f.eew({ time: START - 10_000, slot: 1, code: 473, lat: 35.6, lon: 140.5 });
  f.eew({ time: START + 3600_000, slot: 2 });
  assert.equal(readEarthquake(f.vm, START).regionCode, 473);
});

test("unknown native intensity and depth remain unknown instead of inventing zero", () => {
  const f = fixture();
  f.eew({ max: "h" });
  f.variable("0EEW").value[7] = "n";
  f.variable("0EEW").value[8] = "n";
  const event = readEarthquake(f.vm, START);
  assert.equal(event.maxIntensity, null);
  assert.equal(event.maxIntensityLabel, "不明");
  assert.equal(event.depth, null);
  assert.equal(event.magnitude, null);
});

test("cached stage bindings read replacements without scanning native clones each poll", () => {
  const f = fixture();
  f.eew();
  const targets = [f.stage, ...Array.from({ length: 2_000 }, () => ({ isStage: false }))];
  let scanned = 0;
  targets.find = () => { scanned++; throw new Error("unexpected clone scan"); };
  targets.indexOf = () => { scanned++; return 0; };
  f.vm.runtime.targets = targets;
  for (let i = 0; i < 20; i++) assert.equal(readEarthquake(f.vm, START).lat, 42);
  assert.equal(scanned, 1, "one initial index lookup, then cached stage identity");
  const id = Object.keys(f.stage.variables).find((id) => f.stage.variables[id].name === "0EEW");
  const replacement = structuredClone(f.stage.variables[id]);
  replacement.value[6] = 43;
  f.stage.variables[id] = replacement;
  assert.equal(readEarthquake(f.vm, START).lat, 43);
});

test("name fallback and native stage replacement seed a fresh project safely", () => {
  const f = fixture();
  f.earthquake();
  const renamed = Object.fromEntries(Object.values(f.stage.variables).map((v, i) => [`copy-${i}`, v]));
  f.stage.variables = renamed;
  assert.equal(readEarthquake(f.vm, START).name, "浦河沖");
  const monitor = new EarthquakeMonitor(f.options);
  monitor.update(f.vm);
  const second = fixture();
  second.earthquake({ time: START + 120_000 });
  f.advance(120_000);
  f.vm.runtime.targets = [second.stage];
  assert.equal(monitor.update(f.vm).isNew, false);
});

test("status observes cancellation of the displayed event behind a newer unlocated event", () => {
  const f = fixture();
  const monitor = new EarthquakeMonitor(f.options);
  monitor.update(f.vm);
  const firstTime = f.advance(1_000);
  f.eew({ time: firstTime });
  const displayed = monitor.update(f.vm);
  assert.equal(displayed.isNew, true);
  f.advance(10_000);
  f.eew({ slot: 1, lat: "", lon: "" });
  f.eew({ time: firstTime, state: -1, report: 2 });
  const latest = monitor.update(f.vm);
  assert.notEqual(latest.id, displayed.id);
  assert.equal(latest.isNew, false);
  const current = monitor.status(displayed.id);
  assert.equal(current.cancelled, true);
  assert.equal(current.active, false);
  assert.equal(current.present, true);
  assert.equal(current.isNew, false);
});

test("status accepts source aliases and older normal information cannot mask EEW quality", () => {
  const f = fixture();
  const monitor = new EarthquakeMonitor(f.options);
  monitor.update(f.vm);
  const time = f.advance(1_000);
  f.eew({ time });
  const displayed = monitor.update(f.vm);
  f.earthquake({ time: Math.floor(time / 60_000) * 60_000 });
  f.eew({ time, report: 2, flags: "100030" });
  monitor.update(f.vm);
  assert.equal(monitor.status(displayed.id).reliable, false);
  const sourceAlias = `earthquake:${Math.floor(time / 60_000)}:01`;
  assert.equal(monitor.status(sourceAlias).id, displayed.id);
  assert.equal(monitor.status(sourceAlias).plum, true);
  f.set("0EEW", []);
  monitor.update(f.vm);
  assert.equal(monitor.status(displayed.id).kind, "earthquake");
  assert.equal(monitor.status(displayed.id).reliable, true);
});

test("global replay is visible through status even with empty native event lists", () => {
  const f = fixture();
  f.eew();
  const monitor = new EarthquakeMonitor({ ...f.options, showActiveOnStart: true });
  const displayed = monitor.update(f.vm);
  f.set("0EEW", []);
  f.set("#リプレイモード", 1);
  assert.equal(monitor.update(f.vm), null);
  const current = monitor.status(displayed.id);
  assert.equal(current.replay, true);
  assert.equal(current.training, true);
  assert.equal(current.active, false);
  assert.equal(current.present, false);
  assert.equal(monitor.status("unknown-id").replay, true);
  assert.equal(monitor.status().replay, true);
  f.set("#リプレイモード", 0);
  assert.equal(monitor.status(displayed.id).replay, false);
  assert.equal(monitor.status(displayed.id).active, true, "native activity is not lost by replay normalization");
});

test("status rechecks native global replay without needing another event update", () => {
  const f = fixture();
  f.eew();
  const monitor = new EarthquakeMonitor({ ...f.options, showActiveOnStart: true });
  const displayed = monitor.update(f.vm);
  f.set("#リプレイモード", 1);
  assert.equal(monitor.status(displayed.id).replay, true);
  f.advance(300_001);
  f.set("#リプレイモード", 0);
  const stale = monitor.status(displayed.id);
  assert.equal(stale.recent, false);
  assert.equal(stale.active, false);
  assert.equal(stale.reason, "stale");
});

test("a new normal record in the boundary minute can open after an existing history baseline", () => {
  const f = fixture();
  f.earthquake({ time: START - 90_000, receivedAt: START - 60_000, id: "01" });
  const monitor = new EarthquakeMonitor(f.options);
  assert.equal(monitor.update(f.vm).isNew, false);
  f.advance(5_000);
  f.earthquake({ time: START - 30_000, receivedAt: f.now, id: "02" });
  const event = monitor.update(f.vm);
  assert.equal(event.time < START, true, "native origin is rounded to its minute");
  assert.equal(event.isNew, true, "fresh issue time recovers a new boundary-minute record");
  assert.equal(monitor.update(f.vm).isNew, false);
});

test("boundary-minute exception excludes stale issues, initial history, and its delayed first load", () => {
  for (const receivedAt of [START - 1, START + 60_000]) {
    const f = fixture();
    f.earthquake({ time: START - 90_000, id: "01" });
    const monitor = new EarthquakeMonitor(f.options);
    monitor.update(f.vm);
    f.advance(1_000);
    f.earthquake({ time: START - 30_000, id: "02", receivedAt });
    assert.equal(monitor.update(f.vm).isNew, false, "old or future issue time is not evidence of a live update");
  }
  const initial = fixture();
  initial.earthquake({ receivedAt: START + 1_000 });
  const seeded = new EarthquakeMonitor(initial.options);
  assert.equal(seeded.update(initial.vm).isNew, false);
  initial.advance(1_000);
  assert.equal(seeded.update(initial.vm).isNew, false);

  const delayed = fixture();
  const waiting = new EarthquakeMonitor(delayed.options);
  assert.equal(waiting.update(delayed.vm), null);
  delayed.advance(1_000);
  delayed.earthquake({ time: START - 30_000, receivedAt: delayed.now });
  assert.equal(waiting.update(delayed.vm).isNew, false, "first normal history is a seed even after empty startup");
});
