export const COMMUNITY_PULSE_MS = 3000;

const countOf = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const located = (area) => typeof area?.lat === 'number' && typeof area?.lon === 'number' &&
  Number.isFinite(area.lat) && Number.isFinite(area.lon) && Math.abs(area.lat) < 90 && Math.abs(area.lon) <= 180;
const exactCount = new Intl.NumberFormat('ja-JP');
const compactCount = new Intl.NumberFormat('ja-JP', { notation: 'compact', maximumFractionDigits: 1 });

/** Keep the short counter legible; full counts remain in DOM attributes/title. */
export function formatPulseCount(value) {
  const count = countOf(value);
  return `+${count >= 10000 ? compactCount.format(count) : exactCount.format(count)}件`;
}

/** Short-lived positive report deltas, timed by a monotonic clock, never intensity. */
export class CommunityPulses {
  #now;
  #duration;
  #lastNow = -Infinity;
  #pulses = new Map();

  constructor({ now = () => performance.now(), durationMs = COMMUNITY_PULSE_MS } = {}) {
    if (typeof now !== 'function' || !Number.isFinite(durationMs) || durationMs <= 0) {
      throw new TypeError('A monotonic clock and positive duration are required');
    }
    this.#now = now;
    this.#duration = durationMs;
  }

  #clock() {
    const next = this.#now();
    if (!Number.isFinite(next)) throw new TypeError('Clock must return milliseconds');
    this.#lastNow = Math.max(this.#lastNow, next);
    return this.#lastNow;
  }

  #prune(now) {
    for (const [key, pulse] of this.#pulses) if (pulse.expiresAt <= now) this.#pulses.delete(key);
  }

  /**
   * Only an accepted live 561 is one newly received report. A 9611 is cumulative
   * event state and must NEVER create/extend a new-report counter, even when it
   * arrives before startup history. Its previous baseline is unknowable then.
   * Count the 561 itself once, including when a prior 9611 already covers it and
   * the rolling total therefore stays unchanged. The feed performs ID/UID dedup.
   */
  ingestLive(next, { message } = {}) {
    if (message?.code !== 561) return this.snapshot();
    const area = (Array.isArray(next?.areas) ? next.areas : [])
      .find((entry) => entry && Number(entry.code) === message.area && located(entry));
    if (!area) return this.snapshot();
    return this.ingest({ areas: [{ ...area, count: 1 }] }, { areas: [] });
  }

  /** Explicit/demo deltas only. Live network messages must use ingestLive(). */
  ingest(next, previous) {
    const now = this.#clock();
    this.#prune(now);
    const before = new Map((Array.isArray(previous?.areas) ? previous.areas : [])
      .filter((area) => area && typeof area === 'object')
      .map((area) => [String(area.code), countOf(area.count)]));
    for (const area of Array.isArray(next?.areas) ? next.areas : []) {
      if (!located(area) || area.code === null || area.code === undefined) continue;
      const key = `area-${String(area.code)}`;
      const delta = countOf(area.count) - (before.get(String(area.code)) ?? 0);
      if (delta <= 0) continue;
      const prior = this.#pulses.get(key);
      this.#pulses.set(key, {
        key, code: area.code, name: String(area.name ?? ''), lat: area.lat, lon: area.lon,
        count: (prior?.count ?? 0) + delta,
        createdAt: prior?.createdAt ?? now, updatedAt: now, expiresAt: now + this.#duration,
      });
    }
    return [...this.#pulses.values()].map((pulse) => ({ ...pulse }));
  }

  snapshot() {
    this.#prune(this.#clock());
    return [...this.#pulses.values()].map((pulse) => ({ ...pulse }));
  }

  clear() { this.#pulses.clear(); }
}
