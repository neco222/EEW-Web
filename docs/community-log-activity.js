import {CAMERA_EEW_END_GRACE_MS, CAMERA_INFORMATION_HOLD_MS, CAMERA_EEW_STALE_MS} from './camera-lifetime.js';

const EPOCH = Date.UTC(2000, 0, 1);
const FUTURE_MS = 5_000;
const MAX_SEEN = 256;
const BINDINGS = {
  eew: ['!zoC:uBg[Uj?t;84/~_c', '0EEW'],
  eewActive: ['ry{@6d.Fj^_QYEELDK_:', 'EEW全体で発表中？'],
  tsunami: ['2`OxG=vEfNxKB1.x=g)!', '9津波関連'],
  realtime: ['pPs(Dg^SmS.v8*,O[yUP', '4リアルタイム状況(最大震度など)'],
  information: ['8+rX0Tf6a(Aknj^e5ErO', '5地震情報リスト'],
  replay: ['qM{_c9Qzrq.,$j.enLYz', '#リプレイモード'],
  grid: ['r2DN$(Tj:Tk^o%UuW]#8', '検出済みグリッド数'],
};
const names = new WeakMap();
const receivers = new WeakMap();

function variable(target, [id, name]) {
  const variables = target?.variables;
  if (!variables) return null;
  if (variables[id]?.name === name) return variables[id];
  let index = names.get(variables);
  if (!index) {
    index = new Map(Object.entries(variables).map(([key, entry]) => [entry.name, key]));
    names.set(variables, index);
  }
  return variables[index.get(name)]?.name === name ? variables[index.get(name)] : null;
}

function number(input) {
  if (typeof input !== 'number' && (typeof input !== 'string' || !input.trim())) return NaN;
  return Number(input);
}

function timestamp(input) {
  const seconds = number(input);
  return Number.isFinite(seconds) && seconds > 0 ? EPOCH + seconds * 1_000 : null;
}

function remember(set, value) {
  if (set.has(value)) return false;
  set.add(value);
  if (set.size > MAX_SEEN) set.delete(set.values().next().value);
  return true;
}

function readSource(vm) {
  const runtime = vm?.runtime;
  if (!runtime) return null;
  const stage = runtime.targets?.[0]?.isStage ? runtime.targets[0] :
    runtime.getTargetForStage?.() ?? runtime.targets?.find(target => target.isStage);
  if (!stage?.variables) return null;
  let receiver = receivers.get(runtime);
  if (!receiver || runtime.targets?.[receiver.index] !== receiver.target) {
    const target = runtime.targets?.find(item => item.isOriginal && item.getName?.() === '受信と検出');
    receiver = {target, index: runtime.targets?.indexOf(target)};
    if (target) receivers.set(runtime, receiver);
  }
  const values = Object.fromEntries(Object.entries(BINDINGS).map(([key, binding]) =>
    [key, variable(key === 'grid' ? receiver?.target : stage, binding)?.value]));
  if (!Array.isArray(values.eew) || values.eew.length < 140 ||
      !Array.isArray(values.tsunami) || values.tsunami.length < 14 ||
      !Array.isArray(values.realtime) || values.realtime.length < 8 ||
      !Array.isArray(values.information) ||
      ![values.eewActive, values.tsunami[0], values.realtime[7], values.grid, values.replay]
        .every(value => Number.isFinite(number(value)))) return null;
  return {runtime, stage, variables: stage.variables, ...values};
}

/**
 * Read-only visibility policy for the community log. Call from an existing
 * tick; this class owns no timers, connections, DOM or VM writes. Its small
 * {active,kinds} snapshot changes only when visibility or source kinds change.
 *
 * All ten native EEW slots/global flag count, including PLUM/unlocated alerts.
 * EEW and allowed shaking have one 30s end grace. Neither can hold the log
 * beyond five minutes without source progress. Tsunami uses the live
 * native maximum category: reset does not necessarily clear its map geometry.
 * Normal record zero is first seeded silently (also after an empty startup).
 * Only a newer, recent issue then holds the log for two minutes; history
 * selection, camera eligibility, layout and animation fields are irrelevant.
 */
export class CommunityLogActivity {
  #now;
  #identity = null;
  #lastNow = null;
  #eewSeen = new Set();
  #eewIssues = new Map();
  #cancelled = new Set();
  #eewProgress = -Infinity;
  #globalEEW = false;
  #eewLive = false;
  #eewUntil = -Infinity;
  #watched = new Map();
  #tsunami = false;
  #shaking = false;
  #shakingSignature = null;
  #shakingProgress = -Infinity;
  #shakingUntil = -Infinity;
  #normalIssue = null;
  #normalSeen = new Set();
  #normalUntil = -Infinity;

  constructor({now = Date.now} = {}) {
    if (typeof now !== 'function') throw new TypeError('CommunityLogActivity needs a clock');
    this.#now = now;
  }

  reset() {
    this.#identity = null;
    this.#lastNow = null;
    this.#eewSeen.clear();
    this.#eewIssues.clear();
    this.#cancelled.clear();
    this.#eewProgress = this.#eewUntil = this.#shakingProgress = this.#shakingUntil = this.#normalUntil = -Infinity;
    this.#eewLive = this.#globalEEW = this.#tsunami = this.#shaking = false;
    this.#shakingSignature = null;
    this.#watched.clear();
    this.#normalIssue = null;
    this.#normalSeen.clear();
    return {active: false, kinds: []};
  }

  update(vm) {
    try {
      const now = this.#now();
      const source = readSource(vm);
      if (!Number.isFinite(now) || (this.#lastNow !== null && now < this.#lastNow) || !source) return this.reset();
      const identity = [source.runtime, source.stage, source.variables];
      if (!this.#identity?.every((value, index) => value === identity[index])) this.reset();
      this.#identity = identity;
      this.#lastNow = now;
      if (number(source.replay) > 0) return this.reset();
      this.#updateEEW(source, now);
      // 9津波関連[0] is the current maximum category. tsu: 地図表示集 may
      // retain old geometry after 津波情報リセット; it cannot hold a live log.
      this.#tsunami = number(source.tsunami[0]) > 0;
      const shaking = number(source.grid) > 0 || number(source.realtime[7]) > 0;
      if (!shaking && this.#shaking) this.#shakingUntil = Math.min(
        now + CAMERA_EEW_END_GRACE_MS, this.#shakingProgress + CAMERA_EEW_STALE_MS);
      if (shaking) {
        // These are currently allowed detector results, not the polling clock
        // or animated waves. A frozen positive VM value must eventually close.
        const signature = JSON.stringify([number(source.grid), number(source.realtime[7])]);
        if (!this.#shaking || signature !== this.#shakingSignature) this.#shakingProgress = now;
        this.#shakingSignature = signature;
        this.#shakingUntil = -Infinity;
      }
      this.#shaking = shaking;
      this.#updateNormal(source.information, now);
      return this.#snapshot(now);
    } catch {
      return this.reset();
    }
  }

  snapshot() {
    try {
      const now = this.#now();
      return Number.isFinite(now) && (this.#lastNow === null || now >= this.#lastNow) ?
        this.#snapshot(now) : {active: false, kinds: []};
    } catch { return {active: false, kinds: []}; }
  }

  #updateEEW(source, now) {
    let hasActive = false;
    let hasCancelled = false;
    const active = new Map();
    for (let slot = 0; slot < 10; slot++) {
      const row = source.eew.slice(slot * 14, slot * 14 + 14);
      const key = JSON.stringify([slot, row[4]]);
      const state = number(row[0]);
      if (state === -1) {
        remember(this.#cancelled, key);
        hasCancelled ||= this.#watched.get(slot) === key;
        continue;
      }
      if (state !== 1) continue;
      hasActive = true;
      if (this.#cancelled.has(key)) continue;
      const issue = timestamp(row[13]) ?? timestamp(row[4]);
      // Elapsed time and P/S radii (10..12) are animated, not fresh reports.
      const fresh = remember(this.#eewSeen, JSON.stringify([slot, row.slice(1, 10), row[13]]));
      if (issue !== null && (issue > now + FUTURE_MS || now - issue > CAMERA_EEW_STALE_MS)) continue;
      active.set(slot, key);
      const previous = this.#eewIssues.get(key);
      const report = number(row[2]);
      if (fresh && (!previous || (issue ?? -Infinity) >= (previous.issue ?? -Infinity)) &&
          (!previous || !Number.isFinite(report) || !Number.isFinite(previous.report) || report >= previous.report)) {
        this.#eewProgress = now;
        this.#eewIssues.set(key, {issue, report});
        if (this.#eewIssues.size > MAX_SEEN) this.#eewIssues.delete(this.#eewIssues.keys().next().value);
      }
    }
    const globalEEW = number(source.eewActive) === 1;
    const flagOnly = !hasActive && globalEEW && !hasCancelled &&
      !source.eew.some((value, index) => index % 14 === 0 && number(value) === -1);
    // A genuine 0 -> 1 can start a later global-only event. Polling the same
    // positive flag, or merely losing its slot while it stays 1, cannot renew.
    if (flagOnly && !this.#globalEEW) this.#eewProgress = now;
    this.#globalEEW = globalEEW;
    const live = active.size > 0 || flagOnly;
    if (hasCancelled && !active.size) {
      this.#eewLive = false;
      this.#eewUntil = -Infinity;
    } else if (live) {
      this.#eewLive = now < this.#eewProgress + CAMERA_EEW_STALE_MS;
      this.#eewUntil = -Infinity;
    } else if (this.#eewLive) {
      this.#eewLive = false;
      this.#eewUntil = Math.min(now + CAMERA_EEW_END_GRACE_MS, this.#eewProgress + CAMERA_EEW_STALE_MS);
    }
    if (active.size) this.#watched = active;
  }

  #updateNormal(list, now) {
    const origin = timestamp(list[4]);
    const issue = timestamp(list[6]) ?? origin;
    if (issue === null) return;
    const signature = JSON.stringify([list[4], list[6], list[9]]);
    if (!remember(this.#normalSeen, signature)) return;
    const initial = this.#normalIssue === null;
    const previous = this.#normalIssue;
    // Future/old snapshots are remembered, so polling cannot make them live
    // when wall time eventually catches up. A future issue cannot poison the
    // high-water mark and suppress a subsequent legitimate native report.
    if (issue > now + FUTURE_MS || (origin !== null && origin > now + FUTURE_MS)) return;
    this.#normalIssue = Math.max(previous ?? -Infinity, issue);
    if (initial || issue <= previous || now - issue > CAMERA_INFORMATION_HOLD_MS) return;
    this.#normalUntil = now + CAMERA_INFORMATION_HOLD_MS;
  }

  #snapshot(now) {
    const kinds = [];
    if ((this.#eewLive && now < this.#eewProgress + CAMERA_EEW_STALE_MS) || now < this.#eewUntil) kinds.push('eew');
    if (this.#tsunami) kinds.push('tsunami');
    if ((this.#shaking && now < this.#shakingProgress + CAMERA_EEW_STALE_MS) || now < this.#shakingUntil) kinds.push('shaking');
    if (now < this.#normalUntil) kinds.push('earthquake');
    return {active: kinds.length > 0, kinds};
  }
}
