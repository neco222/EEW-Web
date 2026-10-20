import { COMMUNITY_WINDOW_MS, parseP2PTime } from './community-core.js';
import { getP2PArea } from './p2p-areas.js';

export const COMMUNITY_FOCUS_BATCH_MS = 400;
export const COMMUNITY_FOCUS_INTERVAL_MS = 3000;
export const COMMUNITY_FOCUS_MAX_AGE_MS = 5000;
export const COMMUNITY_FOCUS_SOURCE_AGE_MS = 30_000;
const SOURCE_FUTURE_MS = 5000;
const MAX_PENDING = 512;
const MAX_SEEN = 2048;
const MAX_ALIASES = 16;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null;
const areaCode = value => {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d{1,3}$/.test(value))) return null;
  const code = Number(value);
  return Number.isInteger(code) && code >= 0 && code <= 999 ? code : null;
};

function distanceKm(a, b) {
  const rad = Math.PI / 180;
  const latitude = Math.sin((b.lat - a.lat) * rad / 2);
  const longitude = Math.sin((b.lon - a.lon) * rad / 2);
  const h = latitude ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * longitude ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}

/**
 * A passive policy for panning to newly received subjective community reports.
 * Forward ONLY CommunityFeed's accepted onLive(next, detail) callback. The feed
 * is the authoritative ID/UID deduplicator; this model also suppresses accidental
 * repeated callbacks with bounded alias memory. Explicit history/replay, 9611,
 * unknown coordinates and old source timestamps never become focus candidates.
 * Coordinates always come from getP2PArea, never payload/snapshot coordinates.
 *
 * now() and detail.receivedAt use epoch milliseconds. Source timestamps must be
 * within the last 30s (sourceMaxAgeMs) or at most 5s ahead. A candidate expires
 * 5s after its ORIGINAL receipt, even while waiting for a map opportunity.
 *
 * ingestLive(next, detail) returns {accepted, reason}. next's cumulative areas
 * are deliberately unused. take({blocked}) returns null or one focus object.
 * The controller owns timers, DOM and map movement: poll at snapshot().readyAt,
 * checking earthquake/EEW/tsunami/manual-operation guards BEFORE take(). A true
 * blocked flag discards pending input; clear() does the same on pause/disable.
 * Neither resets ID memory or the 3s movement interval. Do not repeatedly clear
 * a blocked guard once it is safe and then replay earlier input into this model.
 *
 * The batch closes 400ms after the earliest pending receipt, without extending
 * on every new arrival. During the 3s movement interval, newer reports join the
 * same pending batch. The most-reported neighbourhood within nearbyKm of an
 * actual reported region wins; ties prefer the newest receipt, then area code.
 * This prevents a chain of distant areas from creating a country-wide centre.
 * take() consumes ALL pending reports, including remote losing groups, so it
 * cannot swing to them later. lat/lon is the selected group's report-weighted
 * regional centre; it is neither an epicentre nor an individual user's location.
 */
export class CommunityFocus {
  #now;
  #lastNow = -Infinity;
  #batchMs;
  #intervalMs;
  #maxAgeMs;
  #sourceMaxAgeMs;
  #nearbyKm;
  #lastFocusedAt = null;
  #pending = new Map();
  #seen = new Set();
  #ids = new Map();
  #uids = new Map();

  constructor({ now = Date.now, batchMs = COMMUNITY_FOCUS_BATCH_MS,
    intervalMs = COMMUNITY_FOCUS_INTERVAL_MS, maxAgeMs = COMMUNITY_FOCUS_MAX_AGE_MS,
    sourceMaxAgeMs = COMMUNITY_FOCUS_SOURCE_AGE_MS, nearbyKm = 250 } = {}) {
    if (typeof now !== 'function') throw new TypeError('now must return epoch milliseconds');
    if (![batchMs, intervalMs, maxAgeMs, sourceMaxAgeMs].every(value => Number.isFinite(value) && value > 0) ||
        batchMs >= maxAgeMs || !Number.isFinite(nearbyKm) || nearbyKm < 0) {
      throw new RangeError('Positive timing windows, batchMs < maxAgeMs and nearbyKm >= 0 are required');
    }
    this.#now = now;
    this.#batchMs = batchMs;
    this.#intervalMs = intervalMs;
    this.#maxAgeMs = maxAgeMs;
    this.#sourceMaxAgeMs = sourceMaxAgeMs;
    this.#nearbyKm = nearbyKm;
  }

  #clock() {
    const now = this.#now();
    if (!Number.isFinite(now)) throw new TypeError('now must return epoch milliseconds');
    this.#lastNow = Math.max(this.#lastNow, now);
    return this.#lastNow;
  }

  #removeSeen(entry) {
    this.#seen.delete(entry);
    for (const id of entry.ids) if (this.#ids.get(id) === entry) this.#ids.delete(id);
    for (const uid of entry.uids) if (this.#uids.get(uid) === entry) this.#uids.delete(uid);
  }

  #prune(now) {
    for (const [id, entry] of this.#pending) {
      if (entry.receivedAt + this.#maxAgeMs <= now) this.#pending.delete(id);
    }
    for (const entry of this.#seen) {
      if (entry.receivedAt + COMMUNITY_WINDOW_MS <= now) this.#removeSeen(entry);
    }
  }

  #alias(entry, id, uid) {
    if (entry.ids.size < MAX_ALIASES || entry.ids.has(id)) { entry.ids.add(id); this.#ids.set(id, entry); }
    if (uid && (entry.uids.size < MAX_ALIASES || entry.uids.has(uid))) { entry.uids.add(uid); this.#uids.set(uid, entry); }
  }

  #readyAt() {
    if (!this.#pending.size) return null;
    const firstAt = Math.min(...[...this.#pending.values()].map(entry => entry.receivedAt));
    return Math.max(firstAt + this.#batchMs, this.#lastFocusedAt === null ? -Infinity : this.#lastFocusedAt + this.#intervalMs);
  }

  ingestLive(next, detail = {}) {
    const now = this.#clock();
    this.#prune(now);
    if (!object(detail) || detail.source !== undefined && detail.source !== 'live' || detail.history || detail.replay || detail.accepted === false) {
      return { accepted: false, reason: 'non-live' };
    }
    const message = detail.message;
    if (!object(message) || message.code !== 561) return { accepted: false, reason: 'not-individual' };
    const id = identifier(message.id);
    const uid = identifier(message.uid);
    const at = parseP2PTime(message.time);
    if (!id || at === null) return { accepted: false, reason: 'invalid-message' };
    if (at < now - this.#sourceMaxAgeMs) return { accepted: false, reason: 'old-source' };
    if (at > now + SOURCE_FUTURE_MS) return { accepted: false, reason: 'future-source' };
    const receivedAt = detail.receivedAt;
    if (!Number.isFinite(receivedAt) || receivedAt > now) return { accepted: false, reason: 'invalid-receipt' };
    if (receivedAt + this.#maxAgeMs <= now) return { accepted: false, reason: 'expired' };
    const code = areaCode(message.area);
    const area = code === null ? null : getP2PArea(code);
    if (!area || !Number.isFinite(area.lat) || !Number.isFinite(area.lon)) return { accepted: false, reason: 'unlocated' };

    const matches = [...new Set([this.#ids.get(id), uid && this.#uids.get(uid)].filter(Boolean))];
    if (matches.length) {
      const existing = matches[0];
      const consumed = matches.some(entry => !this.#pending.has(entry.id));
      for (const other of matches.slice(1)) {
        this.#pending.delete(other.id);
        this.#removeSeen(other);
        for (const alias of other.ids) this.#alias(existing, alias, null);
        for (const alias of other.uids) this.#alias(existing, existing.id, alias);
      }
      this.#alias(existing, id, uid);
      // Linking a queued alias to an already consumed/blocked report must not
      // reintroduce that report as a second movement.
      if (consumed) this.#pending.delete(existing.id);
      return { accepted: false, reason: 'duplicate' };
    }
    const entry = { id, area, receivedAt, ids: new Set(), uids: new Set() };
    this.#seen.add(entry);
    this.#alias(entry, id, uid);
    this.#pending.set(id, entry);
    // The accepted feed already removes duplicates; these bounds only protect
    // the policy from an accidental callback storm or a copied integration.
    while (this.#pending.size > MAX_PENDING) this.#pending.delete(this.#pending.keys().next().value);
    while (this.#seen.size > MAX_SEEN) this.#removeSeen(this.#seen.values().next().value);
    return { accepted: true, reason: 'report' };
  }

  take({ blocked = false } = {}) {
    const now = this.#clock();
    this.#prune(now);
    if (blocked) { this.clear(); return null; }
    const readyAt = this.#readyAt();
    if (readyAt === null || now < readyAt) return null;
    const byArea = new Map();
    for (const entry of this.#pending.values()) {
      const area = byArea.get(entry.area.code) ?? { code: entry.area.code, name: entry.area.name,
        lat: entry.area.lat, lon: entry.area.lon, count: 0, receivedAt: -Infinity, firstReceivedAt: Infinity };
      area.count++;
      area.receivedAt = Math.max(area.receivedAt, entry.receivedAt);
      area.firstReceivedAt = Math.min(area.firstReceivedAt, entry.receivedAt);
      byArea.set(area.code, area);
    }
    const areas = [...byArea.values()].sort((a, b) => a.code - b.code);
    const groups = areas.map(anchor => {
      const members = areas.filter(area => distanceKm(anchor, area) <= this.#nearbyKm);
      return { anchor, members, count: members.reduce((sum, area) => sum + area.count, 0),
        receivedAt: Math.max(...members.map(area => area.receivedAt)) };
    }).sort((a, b) => b.count - a.count || b.receivedAt - a.receivedAt || a.anchor.code - b.anchor.code);
    const group = groups[0];
    const result = {
      kind: 'community-reports',
      lat: group.members.reduce((sum, area) => sum + area.lat * area.count, 0) / group.count,
      lon: group.members.reduce((sum, area) => sum + area.lon * area.count, 0) / group.count,
      count: group.count,
      areas: group.members.map(area => ({ ...area })),
      bounds: { south: Math.min(...group.members.map(area => area.lat)), north: Math.max(...group.members.map(area => area.lat)),
        west: Math.min(...group.members.map(area => area.lon)), east: Math.max(...group.members.map(area => area.lon)) },
      receivedAt: group.receivedAt,
      firstReceivedAt: Math.min(...group.members.map(area => area.firstReceivedAt)),
      expiresAt: group.receivedAt + this.#maxAgeMs,
      discardedCount: this.#pending.size - group.count,
    };
    this.#pending.clear();
    this.#lastFocusedAt = now;
    return result;
  }

  snapshot() {
    this.#prune(this.#clock());
    return { pendingCount: this.#pending.size, readyAt: this.#readyAt(), lastFocusedAt: this.#lastFocusedAt };
  }

  /** Discard candidates on a higher-priority map action, pause or disable. */
  clear() { this.#pending.clear(); }
}
