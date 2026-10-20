import { COMMUNITY_WINDOW_MS, parseP2PTime } from './community-core.js';
import { getP2PArea } from './p2p-areas.js';

export const COMMUNITY_LOG_LIMIT = 120;
const FUTURE_MS = 5_000;
const MAX_ALIASES = 32;
const MAX_AREAS = 32;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null;
const areaCode = value => {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d{1,3}$/.test(value))) return null;
  const code = Number(value);
  return Number.isInteger(code) && code >= 0 && code <= 999 ? code : null;
};

/** Source timestamps are shown in JST regardless of the browser's time zone. */
export function formatCommunityLogTime(at) {
  if (!Number.isFinite(at)) return '';
  const date = new Date(at + 9 * 60 * 60_000);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(11, 19) : '';
}

function region(code) {
  const area = getP2PArea(code);
  if (!area) return { code, name: `地域不明（コード${code}）`, known: false };
  return { code, name: area.name, known: code !== 900 && code !== 901 };
}

function row(entry) {
  const areaCodes = [...entry.codes].sort((a, b) => a - b);
  const areas = areaCodes.map(region);
  return {
    key: `report-${entry.id}`,
    id: entry.id,
    code: 561,
    count: 1,
    at: entry.at,
    timeLabel: formatCommunityLogTime(entry.at),
    receivedAt: entry.receivedAt,
    receivedTimeLabel: entry.receivedAt === null ? '' : formatCommunityLogTime(entry.receivedAt),
    areaCodes,
    areas,
    areaName: areas.map(area => area.name).join('・') || '地域不明',
    history: entry.source === 'history',
    source: entry.source,
  };
}

/**
 * Individual subjective reports, never measured intensity or earthquake data.
 * CommunityFeed's accepted onLive(next, detail) can be forwarded directly.
 * Only raw 561 messages are rows; no rows are inferred from totals, area deltas,
 * or cumulative 9611 evaluations. Current API 561 has a single `area`; a small
 * explicit array is also normalized to one row for copies supporting several
 * area codes. Retransmission aliases are one report, not separate people.
 *
 * ingestLive() returns {accepted, reason, entry?}; accepted means one new row,
 * never a retransmission/update. ingestHistory(rawMessages) returns counts and
 * marks new rows history:true. Reconnect history never promotes an existing
 * history row to live. An already-live row retains its provenance on backfill.
 * CommunityStore.snapshot() contains aggregate areas only and cannot seed this
 * model: pass the feed's raw history callback, without additional API requests.
 *
 * snapshot().entries are newest source-time first, at most maxEntries (<=150),
 * with source timestamps in (now-windowMs, now]. Receipt time never renews TTL.
 * Up to 5s of clock skew is buffered; larger future timestamps are rejected.
 * Returned objects are detached from model/input state. There are no timers,
 * network, persistence or browser globals; call snapshot() to expire old rows.
 */
export class CommunityLog {
  #now;
  #maxEntries;
  #windowMs;
  #entries = new Map();
  #ids = new Map();
  #uids = new Map();

  constructor({ now = Date.now, maxEntries = COMMUNITY_LOG_LIMIT, windowMs = COMMUNITY_WINDOW_MS } = {}) {
    if (typeof now !== 'function') throw new TypeError('now must be a function returning milliseconds');
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 150) {
      throw new RangeError('maxEntries must be an integer between 1 and 150');
    }
    if (!Number.isFinite(windowMs) || windowMs <= 0) throw new RangeError('windowMs must be positive');
    this.#now = now;
    this.#maxEntries = maxEntries;
    this.#windowMs = windowMs;
  }

  #clock() {
    const now = this.#now();
    if (!Number.isFinite(now)) throw new TypeError('now must return milliseconds');
    return now;
  }

  #remove(entry) {
    this.#entries.delete(entry.id);
    for (const id of entry.ids) if (this.#ids.get(id) === entry) this.#ids.delete(id);
    for (const uid of entry.uids) if (this.#uids.get(uid) === entry) this.#uids.delete(uid);
  }

  #ordered() {
    return [...this.#entries.values()].sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
  }

  #prune(now) {
    for (const entry of this.#entries.values()) {
      if (entry.at <= now - this.#windowMs) this.#remove(entry);
    }
    const ordered = this.#ordered();
    for (const entry of ordered.slice(this.#maxEntries)) this.#remove(entry);
  }

  #alias(entry, id, uid) {
    if (entry.ids.size < MAX_ALIASES || entry.ids.has(id)) {
      entry.ids.add(id); this.#ids.set(id, entry);
    }
    if (uid && (entry.uids.size < MAX_ALIASES || entry.uids.has(uid))) {
      entry.uids.add(uid); this.#uids.set(uid, entry);
    }
  }

  #ingest(message, source, receivedAt, now) {
    this.#prune(now);
    if (!object(message) || message.code !== 561) return { accepted: false, reason: 'not-individual' };
    const id = identifier(message.id);
    const uid = identifier(message.uid);
    const at = parseP2PTime(message.time);
    if (!id || at === null) return { accepted: false, reason: 'invalid-message' };
    if (at > now + FUTURE_MS) return { accepted: false, reason: 'future-time' };
    if (at <= now - this.#windowMs) return { accepted: false, reason: 'expired' };
    const inputAreas = Array.isArray(message.area) ? message.area : [message.area];
    if (!inputAreas.length || inputAreas.length > MAX_AREAS) return { accepted: false, reason: 'invalid-area' };
    const codes = inputAreas.map(areaCode);
    if (codes.some(code => code === null)) return { accepted: false, reason: 'invalid-area' };
    const matches = [...new Set([this.#ids.get(id), uid && this.#uids.get(uid)].filter(Boolean))];
    if (matches.length) {
      const existing = matches[0];
      for (const other of matches.slice(1)) {
        this.#remove(other);
        existing.at = Math.min(existing.at, other.at);
        for (const code of other.codes) if (existing.codes.size < MAX_AREAS) existing.codes.add(code);
        for (const alias of other.ids) this.#alias(existing, alias, null);
        for (const alias of other.uids) this.#alias(existing, existing.id, alias);
        if (other.source === 'live' && existing.source === 'history') {
          existing.source = 'live'; existing.receivedAt = other.receivedAt;
        } else if (other.receivedAt !== null && existing.receivedAt !== null) {
          existing.receivedAt = Math.min(existing.receivedAt, other.receivedAt);
        }
      }
      existing.at = Math.min(existing.at, at);
      for (const code of codes) if (existing.codes.size < MAX_AREAS) existing.codes.add(code);
      this.#alias(existing, id, uid);
      // Do not turn a replay/backfill copy into a fresh live notification or
      // refresh either its occurrence time or its original arrival provenance.
      this.#prune(now);
      return { accepted: false, reason: 'duplicate', entry: row(existing) };
    }
    const entry = { id, at, codes: new Set(codes), source, receivedAt,
      ids: new Set(), uids: new Set() };
    this.#entries.set(id, entry);
    this.#alias(entry, id, uid);
    this.#prune(now);
    if (!this.#entries.has(id)) return { accepted: false, reason: 'capacity' };
    return { accepted: true, reason: source === 'history' ? 'history' : 'report', entry: row(entry) };
  }

  ingestLive(next, detail = {}) {
    const now = this.#clock();
    if (!object(detail) || detail.source && detail.source !== 'live') {
      this.#prune(now);
      return { accepted: false, reason: 'non-live' };
    }
    const receivedAt = Number.isFinite(detail.receivedAt) ? detail.receivedAt : now;
    return this.#ingest(detail.message, 'live', receivedAt, now);
  }

  ingestHistory(messages) {
    const now = this.#clock();
    this.#prune(now);
    if (!Array.isArray(messages)) return { accepted: 0, skipped: 0, invalid: true };
    const sorted = [...messages].sort((a, b) => (parseP2PTime(a?.time) ?? 0) -
      (parseP2PTime(b?.time) ?? 0) || String(a?.id ?? '').localeCompare(String(b?.id ?? '')));
    let accepted = 0;
    for (const message of sorted) if (this.#ingest(message, 'history', null, now).accepted) accepted++;
    return { accepted, skipped: messages.length - accepted, invalid: false };
  }

  snapshot() {
    const now = this.#clock();
    this.#prune(now);
    const entries = this.#ordered().filter(entry => entry.at <= now).map(row);
    return {
      kind: 'user-reports', unit: 'reports', source: '561', entries, total: entries.length,
      latestAt: entries[0]?.at ?? null, generatedAt: now, since: now - this.#windowMs,
      windowMs: this.#windowMs, maxEntries: this.#maxEntries,
    };
  }
}
