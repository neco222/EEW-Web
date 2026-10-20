import { getP2PArea } from './p2p-areas.js';

// These are subjective user reports, NOT instrument readings, seismic intensity,
// earthquake locations, or an independent confirmation that an earthquake exists.
// API: https://www.p2pquake.net/develop/json_api_v2/
// 9611 semantics: https://github.com/p2pquake/userquake-aggregator/tree/master/pkg
export const COMMUNITY_WINDOW_MS = 10 * 60 * 1000;
const FUTURE_TOLERANCE_MS = 5000;
const MAX_COUNT = 2147483647;

/** Parse API timestamps in JST, independently of the browser/OS time zone. */
export function parseP2PTime(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})[/-](\d{2})[/-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})?$/.exec(value);
  if (!match) return null;
  const [, y, m, d, h, min, sec, fraction = '', zone] = match;
  const [year, month, day, hour, minute, second] = [y, m, d, h, min, sec].map(Number);
  if (year < 1970 || month < 1 || month > 12 || day < 1 || day > 31 ||
      hour > 23 || minute > 59 || second > 59) return null;
  const ms = Number(fraction.padEnd(3, '0'));
  const utc = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const check = new Date(utc);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 ||
      check.getUTCDate() !== day) return null;
  let offsetMinutes = 9 * 60;
  if (zone === 'Z') offsetMinutes = 0;
  else if (zone) {
    const hours = Number(zone.slice(1, 3));
    const minutes = Number(zone.slice(4, 6));
    if (hours > 23 || minutes > 59) return null;
    offsetMinutes = (hours * 60 + minutes) * (zone[0] === '+' ? 1 : -1);
  }
  return utc - offsetMinutes * 60000;
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isCount = (value) => Number.isInteger(value) && value >= 0 && value <= MAX_COUNT;
const identifier = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null;
const areaCode = (value) => {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d{1,3}$/.test(value))) return null;
  const code = Number(value);
  return Number.isInteger(code) && code >= 0 && code <= 999 ? code : null;
};
const unknownArea = (code) => ({ code, name: `地域コード ${code}`, prefecture: '', region: '', lat: null, lon: null });
const result = (accepted, reason) => ({ accepted, reason });

/**
 * Pure in-memory rolling-window store. Supply the same JSON objects from /ws
 * and /history; no network, timers, persistence, or browser globals are used.
 *
 * snapshot timestamps are epoch milliseconds. Intervals are (since, now].
 * Future timestamps up to 5 seconds are buffered until the clock catches up;
 * anything further ahead is rejected. Receipt/backfill time never renews TTL.
 *
 * Each 9611 is a replacement cumulative snapshot keyed by started_at. Only the
 * newest (updated_at, time, id) is kept. 561 reports inside its covered interval
 * are not added to an area already in that snapshot. For count < 3, upstream
 * legitimately sends an empty area_confidences object, so 561 can supply areas.
 * Any remaining top-level count is exposed as unattributedCount, with no marker.
 *
 * A cumulative event crossing the left edge of the window cannot be accurately
 * split into ages. It is excluded and only in-window 561 reports are used for
 * that event. This may undercount a limited history backfill; quality says so.
 */
export class CommunityStore {
  #now;
  #windowMs;
  #reports = new Map();
  #reportIds = new Map();
  #reportUids = new Map();
  #events = new Map();

  constructor({ now = Date.now, windowMs = COMMUNITY_WINDOW_MS } = {}) {
    if (typeof now !== 'function') throw new TypeError('now must be a function returning epoch milliseconds');
    if (!Number.isFinite(windowMs) || windowMs <= 0) throw new RangeError('windowMs must be positive');
    this.#now = now;
    this.#windowMs = windowMs;
  }

  #clock() {
    const now = this.#now();
    if (!Number.isFinite(now)) throw new TypeError('now must return epoch milliseconds');
    return now;
  }

  #prune(now) {
    const cutoff = now - this.#windowMs;
    for (const [key, report] of this.#reports) {
      if (report.at > cutoff) continue;
      this.#reports.delete(key);
      for (const id of report.ids) this.#reportIds.delete(id);
      for (const uid of report.uids) this.#reportUids.delete(uid);
    }
    for (const [key, event] of this.#events) {
      if (event.updatedAt <= cutoff) this.#events.delete(key);
    }
  }

  ingest(message) {
    const now = this.#clock();
    this.#prune(now);
    if (!isObject(message)) return result(false, 'invalid-message');
    if (message.code !== 561 && message.code !== 9611) return result(false, 'unsupported-code');
    const id = identifier(message.id);
    const at = parseP2PTime(message.time);
    if (!id || at === null) return result(false, 'invalid-message');
    if (at > now + FUTURE_TOLERANCE_MS) return result(false, 'future-time');
    if (message.code === 561) return this.#ingestReport(message, id, at, now);
    return this.#ingestEvaluation(message, id, at, now);
  }

  #ingestReport(message, id, at, now) {
    const code = areaCode(message.area);
    if (code === null) return result(false, 'invalid-area');
    if (at <= now - this.#windowMs) return result(false, 'expired');
    const uid = identifier(message.uid);
    const matches = [...new Set([this.#reportIds.get(id), uid && this.#reportUids.get(uid)].filter(Boolean))];
    if (matches.length) {
      const key = matches[0];
      const existing = this.#reports.get(key);
      // Both an API id and a protocol UID identify a report, not a user. Merge
      // alias groups if a retransmission links them. The earliest occurrence
      // wins so reconnect order cannot refresh a report's TTL.
      const candidates = [{ at, code }];
      for (const otherKey of matches.slice(1)) {
        const other = this.#reports.get(otherKey);
        candidates.push(other);
        for (const alias of other.ids) { existing.ids.add(alias); this.#reportIds.set(alias, key); }
        for (const alias of other.uids) { existing.uids.add(alias); this.#reportUids.set(alias, key); }
        this.#reports.delete(otherKey);
      }
      for (const candidate of candidates) {
        if (candidate.at < existing.at || candidate.at === existing.at && candidate.code < existing.code) {
          existing.at = candidate.at;
          existing.code = candidate.code;
        }
      }
      // Remember both identifiers: a retransmission may have a different API id.
      existing.ids.add(id);
      this.#reportIds.set(id, key);
      if (uid) {
        existing.uids.add(uid);
        this.#reportUids.set(uid, key);
      }
      return result(false, 'duplicate');
    }
    const report = { id, code, at, ids: new Set([id]), uids: new Set(uid ? [uid] : []) };
    this.#reports.set(id, report);
    this.#reportIds.set(id, id);
    if (uid) this.#reportUids.set(uid, id);
    return result(true, 'report');
  }

  #ingestEvaluation(message, id, at, now) {
    const startedAt = parseP2PTime(message.started_at);
    const updatedAt = parseP2PTime(message.updated_at);
    if (startedAt === null || updatedAt === null || startedAt > updatedAt || updatedAt > at ||
        !isCount(message.count) || !isObject(message.area_confidences) ||
        typeof message.confidence !== 'number' || !Number.isFinite(message.confidence) ||
        message.confidence < 0 || message.confidence > 1) return result(false, 'invalid-evaluation');
    if (updatedAt <= now - this.#windowMs) return result(false, 'expired');
    const areas = new Map();
    for (const [key, value] of Object.entries(message.area_confidences)) {
      const code = areaCode(key);
      if (code === null || !isObject(value) || !isCount(value.count) || areas.has(code)) {
        return result(false, 'invalid-evaluation');
      }
      areas.set(code, value.count);
    }
    if ([...areas.values()].reduce((sum, count) => sum + count, 0) > message.count) {
      return result(false, 'invalid-evaluation');
    }
    const next = { id, at, startedAt, updatedAt, count: message.count, areas };
    const previous = this.#events.get(startedAt);
    if (previous) {
      const order = updatedAt - previous.updatedAt || at - previous.at || id.localeCompare(previous.id);
      if (order <= 0) return result(false, order === 0 ? 'duplicate' : 'stale-evaluation');
    }
    this.#events.set(startedAt, next);
    return result(true, 'evaluation');
  }

  /** Merge newest-first REST histories in chronological order; do not clear live data. */
  ingestHistory(messages) {
    if (!Array.isArray(messages)) return { accepted: 0, skipped: 0, invalid: true };
    const sorted = [...messages].sort((a, b) =>
      (parseP2PTime(a?.time) ?? 0) - (parseP2PTime(b?.time) ?? 0) ||
      String(a?.id ?? '').localeCompare(String(b?.id ?? '')));
    let accepted = 0;
    for (const message of sorted) if (this.ingest(message).accepted) accepted++;
    return { accepted, skipped: messages.length - accepted, invalid: false };
  }

  snapshot() {
    const now = this.#clock();
    this.#prune(now);
    const since = now - this.#windowMs;
    const quality = { windowClippedEvents: 0, incompleteAreaEvents: 0, overlappingEvents: 0, inconsistentEvents: 0, notes: [] };
    const events = [];
    const orderedEvents = [...this.#events.values()].filter((event) => event.at <= now)
      .sort((a, b) => b.updatedAt - a.updatedAt || b.at - a.at || b.id.localeCompare(a.id));
    for (const event of orderedEvents) {
      if (event.startedAt <= since) { quality.windowClippedEvents++; continue; }
      if (events.some((other) => event.startedAt <= other.updatedAt && event.updatedAt >= other.startedAt)) {
        quality.overlappingEvents++;
        continue;
      }
      events.push({ ...event, counts: new Map([...event.areas].map(([code, count]) => [code, { count, raw: false, aggregate: true }])) });
    }
    const areas = new Map();
    let latestAt = null;
    let rawUsed = false;
    let aggregateUsed = false;
    const add = (code, count, at, raw, aggregate) => {
      if (count === 0) return;
      const existing = areas.get(code) ?? { ...(getP2PArea(code) ?? unknownArea(code)), count: 0, latestAt: null, raw: false, aggregate: false };
      existing.count += count;
      existing.latestAt = Math.max(existing.latestAt ?? at, at);
      existing.raw ||= raw;
      existing.aggregate ||= aggregate;
      rawUsed ||= raw;
      aggregateUsed ||= aggregate;
      areas.set(code, existing);
      latestAt = Math.max(latestAt ?? at, at);
    };
    for (const report of this.#reports.values()) {
      if (report.at > now) continue;
      const event = events.find((entry) => report.at >= entry.startedAt && report.at <= entry.updatedAt);
      if (event) {
        // An explicit zero snapshot clears the covered event, including raw copies.
        if (event.count === 0 || event.areas.has(report.code)) continue;
        const existing = event.counts.get(report.code) ?? { count: 0, raw: true, aggregate: false };
        existing.count++;
        event.counts.set(report.code, existing);
      } else add(report.code, 1, report.at, true, false);
    }
    let unattributedCount = 0;
    for (const event of events) {
      let attributed = 0;
      for (const [code, entry] of event.counts) {
        attributed += entry.count;
        add(code, entry.count, event.updatedAt, entry.raw, entry.aggregate);
      }
      const missing = Math.max(0, event.count - attributed);
      unattributedCount += missing;
      if (missing > 0) { quality.incompleteAreaEvents++; aggregateUsed = true; }
      if (attributed > event.count) quality.inconsistentEvents++;
      latestAt = Math.max(latestAt ?? event.updatedAt, event.updatedAt);
    }
    if (quality.windowClippedEvents) quality.notes.push('window-clipped');
    if (quality.incompleteAreaEvents) quality.notes.push('missing-area-breakdown');
    if (quality.overlappingEvents) quality.notes.push('overlapping-evaluations');
    if (quality.inconsistentEvents) quality.notes.push('inconsistent-evaluation');
    const rows = [...areas.values()].map(({ raw, aggregate, ...area }) => ({
      ...area, source: raw && aggregate ? 'mixed' : aggregate ? '9611' : '561',
    })).sort((a, b) => b.count - a.count || a.code - b.code);
    const locatedCount = rows.filter((area) => area.lat !== null && area.lon !== null)
      .reduce((sum, area) => sum + area.count, 0);
    const total = rows.reduce((sum, area) => sum + area.count, unattributedCount);
    return {
      kind: 'user-reports', unit: 'reports', source: 'P2P地震情報',
      total, locatedCount, unlocatedCount: total - locatedCount, unattributedCount,
      areas: rows, latestAt, windowMs: this.#windowMs, since, generatedAt: now,
      mode: total === 0 ? 'empty' : rawUsed && aggregateUsed ? 'mixed' : aggregateUsed ? 'aggregate' : 'individual',
      quality,
    };
  }
}
