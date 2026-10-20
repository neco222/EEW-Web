/**
 * Read-only camera trigger model for the packaged Scratch viewer.
 *
 * Source: assets/project.json, 受信と検出 procedures EEW / 地震情報リスト適用,
 * and UI's 地震情報/EEW panel. 0EEW has ten 14-item slots; the earthquake
 * list has ten 20-item records. Coordinates are native hypocentres, never
 * inferred from intensity/community reports or the selected history row.
 * Numeric native times are UTC seconds since 2000-01-01.
 */

const EPOCH = Date.UTC(2000, 0, 1);
const RECENT_MS = 5 * 60_000;
const START_ACTIVE_MS = 3 * 60_000;
const FUTURE_MS = 5_000;
const INTENSITIES = ["0", "1", "2", "3", "4", "5弱", "5強", "6弱", "6強", "7"];
const BINDINGS = {
  eew: ["!zoC:uBg[Uj?t;84/~_c", "0EEW"],
  extra: ["nJN4|m:3Ok+Ltc4mttxP", "0-2EEW追加情報"],
  earthquakes: ["8+rX0Tf6a(Aknj^e5ErO", "5地震情報リスト"],
  replay: ["qM{_c9Qzrq.,$j.enLYz", "#リプレイモード"],
  names: ["o1W$u}}%c@|Nj9IQZ{gN", "d 地名-コード全集"],
};
const stages = new WeakMap();
const nameIndexes = new WeakMap();
const placeIndexes = new WeakMap();

function stageFor(vm) {
  const runtime = vm?.runtime;
  if (!runtime || typeof runtime !== "object") return null;
  const cached = stages.get(runtime);
  if (cached && runtime.targets?.[cached.index] === cached.stage && cached.stage.variables) {
    return cached.stage;
  }
  let stage = runtime.targets?.[0];
  if (!stage?.isStage) {
    stage = runtime.getTargetForStage?.() || runtime.targets?.find((item) => item.isStage);
  }
  if (!stage?.variables) return null;
  stages.set(runtime, { stage, index: runtime.targets?.indexOf(stage) ?? -1 });
  return stage;
}

function value(stage, binding) {
  const variables = stage.variables;
  if (variables[binding[0]]) return variables[binding[0]].value;
  let index = nameIndexes.get(variables);
  if (!index) {
    index = new Map(Object.entries(variables).map(([id, item]) => [item.name, id]));
    nameIndexes.set(variables, index);
  }
  return variables[index.get(binding[1])]?.value;
}

function number(input) {
  if (typeof input !== "number" && typeof input !== "string") return null;
  if (typeof input === "string" && !input.trim()) return null;
  const result = Number(input);
  return Number.isFinite(result) ? result : null;
}

function timestamp(input) {
  const seconds = number(input);
  if (seconds === null || seconds <= 0) return null;
  const result = EPOCH + seconds * 1_000;
  return Number.isFinite(result) ? result : null;
}

function coordinates(lonInput, latInput) {
  const lat = number(latInput);
  const lon = number(lonInput);
  const located = lat !== null && lon !== null && Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);
  return { lat: located ? lat : null, lon: located ? lon : null, located };
}

function placeName(stage, code) {
  const names = value(stage, BINDINGS.names);
  if (!Array.isArray(names)) return code ? `震源地域 ${code}` : "震源地不明";
  let cached = placeIndexes.get(names);
  if (!cached || cached.length !== names.length) {
    const index = new Map();
    for (let offset = 0; offset + 1 < names.length; offset += 8) {
      index.set(String(names[offset]), String(names[offset + 1] ?? ""));
    }
    cached = { length: names.length, index };
    placeIndexes.set(names, cached);
  }
  return cached.index.get(`c${code}`) || (code ? `震源地域 ${code}` : "震源地不明");
}

function intensity(input) {
  const code = number(input);
  return code !== null && Number.isInteger(code) && code >= 0 && code <= 9 ? code : null;
}

function normalize(data, now, replay) {
  const ageMs = now - data.time;
  const recent = ageMs >= -FUTURE_MS && ageMs <= RECENT_MS;
  const nativeActive = data.nativeActive ?? data.active;
  const reason = replay ? "replay" : data.cancelled ? "cancelled" :
    ageMs < -FUTURE_MS ? "future" : !recent ? "stale" :
    !data.located ? "unlocated" : !data.reliable ? "uncertain-hypocentre" :
    !nativeActive ? "ended" : null;
  return {
    ...data,
    maxIntensityLabel: data.maxIntensity === null ? "不明" : INTENSITIES[data.maxIntensity],
    ageMs,
    nativeActive,
    recent,
    replay,
    // The package exposes historical replay, not a separate upstream training
    // classification. Treat replay as training; do not invent a missing flag.
    training: replay,
    active: nativeActive && recent && !data.cancelled && !replay,
    actionable: reason === null,
    reason,
  };
}

function candidates(stage, now) {
  const replay = (number(value(stage, BINDINGS.replay)) ?? 0) > 0;
  const result = [];
  const eew = value(stage, BINDINGS.eew);
  const extra = value(stage, BINDINGS.extra);
  if (Array.isArray(eew)) {
    for (let slot = 0; slot < 10; slot++) {
      const offset = slot * 14;
      const time = timestamp(eew[offset + 4]);
      const state = number(eew[offset]);
      if (time === null || ![-1, 0, 1].includes(state)) continue;
      const regionCode = number(eew[offset + 3]);
      const flags = String(extra?.[offset + 5] ?? "");
      const warning = number(eew[offset + 1]) === 1;
      // UI captions paEm9/8/5/6: PLUM, assumed intensity, or too few
      // observation stations. Such records do not establish a useful nearby
      // hypocentre, even when the native slot contains provisional coordinates.
      const metadataKnown = /^[01]{4}[0-9]{2}$/.test(flags);
      const plum = flags[0] === "1";
      const assumedIntensity = flags[1] === "1";
      const fewStations = flags[2] === "1" || (!warning && Number(flags[4]) < 3);
      const reliable = metadataKnown && !plum && !assumedIntensity && !fewStations;
      const reportValue = number(eew[offset + 2]);
      result.push(normalize({
        kind: "eew",
        id: `eew:${Math.round(time / 1_000)}`,
        time,
        timeResolutionMs: 1_000,
        receivedAt: timestamp(eew[offset + 13]),
        regionCode,
        name: placeName(stage, regionCode),
        ...coordinates(eew[offset + 5], eew[offset + 6]),
        magnitude: number(eew[offset + 8]),
        depth: number(eew[offset + 7]),
        maxIntensity: intensity(eew[offset + 9]),
        report: reportValue !== null && reportValue < 500 ? reportValue : null,
        final: eew[offset + 2] === "l",
        warning,
        slot,
        flags,
        plum,
        assumedIntensity,
        fewStations,
        reliable,
        cancelled: state === -1,
        active: state === 1,
      }, now, replay));
    }
  }

  const earthquakes = value(stage, BINDINGS.earthquakes);
  if (Array.isArray(earthquakes)) {
    // Always record zero: selecting an older history row only changes display
    // variables, which this reader intentionally never reads.
    const time = timestamp(earthquakes[4]);
    if (time !== null) {
      const regionCode = number(earthquakes[0]);
      const shortId = String(earthquakes[9] ?? "");
      result.push(normalize({
        kind: "earthquake",
        id: `earthquake:${Math.floor(time / 60_000)}:${shortId}`,
        shortId,
        time,
        timeResolutionMs: 60_000,
        receivedAt: timestamp(earthquakes[6]),
        regionCode,
        name: placeName(stage, regionCode),
        ...coordinates(earthquakes[7], earthquakes[8]),
        magnitude: number(earthquakes[2]),
        depth: earthquakes[3] === "s" ? 0 : number(earthquakes[3]),
        maxIntensity: intensity(earthquakes[1]),
        infoType: String(earthquakes[11] ?? ""),
        report: null,
        reliable: true,
        cancelled: false,
        active: true,
      }, now, replay));
    }
  }
  return result;
}

function latest(events, now) {
  // Corrupt future data must not hide a valid current earthquake. Prefer a
  // current active EEW over its later, minute-rounded normal information.
  const nonFuture = events.filter((event) => event.time <= now + FUTURE_MS);
  const pool = nonFuture.length ? nonFuture : events;
  return pool.toSorted((a, b) => b.time - a.time ||
    Number(b.kind === "eew") - Number(a.kind === "eew"))[0] ?? null;
}

/**
 * Current native event snapshot (milliseconds, lat/lon degrees), or null if no
 * event is available. maxIntensity is the native 0..9 code; use its supplied
 * label, since native 5 is 5弱, not a measured numeric intensity of five.
 * This stateless reader does not decide whether to open a camera.
 */
export function readEarthquake(vm = globalThis.vm, now = Date.now()) {
  const stage = stageFor(vm);
  if (!stage || !Number.isFinite(now)) return null;
  return latest(candidates(stage, now), now);
}

function sameEvent(previous, next) {
  const difference = Math.abs(previous.time - next.time);
  if (previous.kind === next.kind) {
    // EEW origin corrections of up to two seconds must not reopen a camera.
    return next.kind === "eew" && difference <= 2_000 &&
      previous.regionCode === next.regionCode && next.report !== 1;
  }
  // Normal information rounds origin to a minute and uses a recycled 2-digit
  // id. Associate it with an EEW only within that same origin minute and region.
  return difference < 60_000 &&
    Math.floor(previous.time / 60_000) === Math.floor(next.time / 60_000) &&
    previous.regionCode === next.regionCode;
}

/**
 * monitor.update(vm) returns event|null, with isNew true only once when a
 * located, reliable new event can open a camera. Initial normal history is
 * seeded silently, including coordinates that arrive later. Origins before
 * monitoring began stay silent. Once a normal-history baseline exists, a new
 * record in the minute before start is permitted only with an issue timestamp
 * at/after start (the source rounds normal origins to minutes). New pending
 * coordinates may become actionable later. Follow-up reports keep the same id
 * and isNew:false.
 *
 * showActiveOnStart explicitly permits the first active EEW up to 3 min old.
 * cancellation returns an object with cancelled:true; stale records return
 * recent:false/active:false after 5 min. Missing/replaced native data returns
 * null. The UI owns its camera display timeout and should close on cancellation.
 * After update(), status(id) reads a displayed event's state independently of
 * which newer event update() returned. It accepts canonical or source/alias ids,
 * reflects global replay even when native event lists are empty, and never
 * emits isNew. Its present flag describes the most recent update's native lists.
 */
export class EarthquakeMonitor {
  constructor({ now = Date.now, showActiveOnStart = false } = {}) {
    this.now = now;
    this.showActiveOnStart = showActiveOnStart;
    this.startedAt = now();
    this.stage = null;
    this.seeded = false;
    this.seen = new Map();
    this.allowStartupEEW = showActiveOnStart;
    this.hasNormalBaseline = false;
    this.sequence = 0;
  }

  update(vm = globalThis.vm) {
    this.sequence++;
    const now = this.now();
    const stage = stageFor(vm);
    if (!stage || !Number.isFinite(now)) return null;
    if (this.stage && this.stage !== stage) {
      this.seen.clear();
      this.seeded = false;
      this.startedAt = now;
      this.allowStartupEEW = this.showActiveOnStart;
      this.hasNormalBaseline = false;
    }
    this.stage = stage;
    const events = candidates(stage, now);
    const initial = !this.seeded;
    const startup = this.allowStartupEEW && now - this.startedAt <= START_ACTIVE_MS;
    const observations = new Map();
    for (const event of events) {
      let entry = this.seen.get(event.id);
      if (!entry) {
        entry = [...new Set(this.seen.values())].find((old) => sameEvent(old.event, event));
      }
      if (!entry) {
        const startupEEW = startup && event.kind === "eew" && event.active &&
          event.ageMs >= -FUTURE_MS && event.ageMs <= START_ACTIVE_MS;
        // +6 is the provider's issue/update timestamp, not a client receipt
        // timestamp. Require a prior history baseline so an initially empty
        // project followed by its first history load cannot masquerade as live.
        const boundaryNormal = this.hasNormalBaseline && event.kind === "earthquake" &&
          event.time >= this.startedAt - 60_000 && event.receivedAt >= this.startedAt &&
          event.receivedAt <= now + FUTURE_MS;
        entry = {
          id: event.id,
          event,
          opened: false,
          cancelled: false,
          replayed: false,
          future: false,
          eligible: startupEEW || (!initial && (event.time >= this.startedAt || boundaryNormal)),
          lastSeen: now,
        };
      }
      entry.cancelled ||= event.cancelled;
      entry.replayed ||= event.replay;
      entry.future ||= event.ageMs < -FUTURE_MS;
      entry.event = event;
      entry.lastSeen = now;
      entry.sequence = this.sequence;
      this.seen.set(event.id, entry);
      const observed = observations.get(entry) ?? [];
      observed.push(event);
      observations.set(entry, observed);
    }
    // One earthquake can have both an EEW slot and a normal-information record.
    // Their loop order must not let older normal metadata mask the latest EEW's
    // cancellation/quality state when the UI checks status(displayedId).
    for (const [entry, observed] of observations) entry.event = latest(observed, now);
    this.hasNormalBaseline ||= events.some((event) => event.kind === "earthquake");
    this.seeded = true;
    for (const [id, entry] of this.seen) {
      if (now - entry.lastSeen > 24 * 60 * 60_000) this.seen.delete(id);
    }
    // Keep memory bounded even if malformed inputs continually change ids.
    while (this.seen.size > 256) this.seen.delete(this.seen.keys().next().value);
    const event = latest(events, now);
    if (!event) return null;
    const entry = this.seen.get(event.id);
    const isNew = event.actionable && entry.eligible && !entry.opened &&
      !entry.cancelled && !entry.replayed && !entry.future;
    if (isNew) {
      entry.opened = true;
      if (event.kind === "eew") this.allowStartupEEW = false;
    }
    return {
      ...event,
      sourceId: event.id,
      id: entry.id,
      cancelled: entry.cancelled,
      active: event.active && !entry.cancelled,
      actionable: event.actionable && !entry.cancelled,
      reason: entry.cancelled ? "cancelled" : event.reason,
      isNew,
    };
  }

  status(id) {
    const now = this.now();
    const replay = this.stage?.variables &&
      (number(value(this.stage, BINDINGS.replay)) ?? 0) > 0;
    const entry = this.seen.get(id) ||
      [...new Set(this.seen.values())].find((known) => known.id === id);
    if (!entry || !Number.isFinite(now)) {
      return {
        id: id ?? null,
        present: false,
        replay: Boolean(replay),
        training: Boolean(replay),
        cancelled: false,
        reliable: null,
        active: false,
        recent: false,
        reason: replay ? "replay" : "missing",
        isNew: false,
      };
    }
    const event = normalize({ ...entry.event, cancelled: entry.cancelled }, now, Boolean(replay));
    return {
      ...event,
      sourceId: event.id,
      id: entry.id,
      present: entry.sequence === this.sequence,
      isNew: false,
    };
  }
}
