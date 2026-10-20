export const CAMERA_EEW_END_GRACE_MS = 30_000;
export const CAMERA_INFORMATION_HOLD_MS = 2 * 60_000;
export const CAMERA_MANUAL_HOLD_MS = 2 * 60_000;
export const CAMERA_EEW_STALE_MS = 5 * 60_000;

const MAX_FINGERPRINTS = 256;
const FUTURE_TOLERANCE_MS = 5_000;
const kindOf = event => ['eew', 'earthquake'].includes(event?.kind) ? event.kind : null;
const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const issuedAt = (event, now) => {
  const time = finite(event?.receivedAt);
  return time !== null && time >= 0 && time <= now + FUTURE_TOLERANCE_MS ? time : null;
};

function unsafeReason(status) {
  if (status?.cancelled || status?.reason === 'cancelled') return 'cancelled';
  if (status?.replay || status?.reason === 'replay') return 'replay';
  if (status?.training) return 'training';
  if (status?.reliable === false || status?.reason === 'uncertain-hypocentre') return 'uncertain-hypocentre';
  if (status?.located === false || status?.reason === 'unlocated') return 'unlocated';
  if (status?.reason === 'future') return 'future';
  return null;
}

// Only source information is evidence of progress. Poll times, elapsed age,
// active/recent flags and animated wave radii cannot keep a frozen VM alive.
function fingerprint(event) {
  return JSON.stringify([
    kindOf(event), typeof event.sourceId === 'string' ? event.sourceId : null,
    finite(event.time), finite(event.receivedAt), finite(event.report), Boolean(event.final),
    typeof event.infoType === 'string' ? event.infoType : null,
    finite(event.lat), finite(event.lon), finite(event.regionCode),
    finite(event.maxIntensity), finite(event.magnitude), finite(event.depth), Boolean(event.warning),
  ]);
}

/**
 * Pure policy for one displayed camera event. No timers, DOM, VM writes or
 * playback are owned here. Call start() only on adoption/manual preview, then
 * update(monitor.status(current.id)) from the camera's ordinary tick.
 *
 * EEW: nativeActive=false or disappearance starts one 30-second grace period.
 * A new active report may cancel it. nativeActive=true may outlive the reader's
 * origin-based recent/active flags, but five minutes without real source
 * progress closes a stuck feed. There is no fixed ten-minute EEW limit.
 * Normal information: close two minutes after the last distinct issue/report,
 * type, location, intensity, magnitude or depth update. Repeated snapshots and
 * older out-of-order issues do not extend it. EEW -> normal switches to this
 * policy and removes the EEW grace deadline.
 * Manual previews: at most two minutes from start, even with follow-ups; an
 * earlier EEW end/safety condition still wins. A new automatic start resets it.
 *
 * Decisions are {id,generation,close,reason,expiresAt}; close is latched until
 * start()/clear(). Foreign event IDs are ignored. No delayed callback from a
 * previous event can close a new one. Invalid/backward clocks close safely.
 */
export class CameraLifetime {
  #now;
  #eewEndGraceMs;
  #informationHoldMs;
  #manualHoldMs;
  #eewStaleMs;
  #session = null;
  #generation = 0;

  constructor({ now = Date.now, eewEndGraceMs = CAMERA_EEW_END_GRACE_MS,
    informationHoldMs = CAMERA_INFORMATION_HOLD_MS, manualHoldMs = CAMERA_MANUAL_HOLD_MS,
    eewStaleMs = CAMERA_EEW_STALE_MS } = {}) {
    if (typeof now !== 'function') throw new TypeError('CameraLifetime needs a clock');
    for (const value of [eewEndGraceMs, informationHoldMs, manualHoldMs, eewStaleMs]) {
      if (!Number.isFinite(value) || value <= 0) throw new RangeError('Camera lifetime durations must be positive and finite');
    }
    this.#now = now;
    this.#eewEndGraceMs = eewEndGraceMs;
    this.#informationHoldMs = informationHoldMs;
    this.#manualHoldMs = manualHoldMs;
    this.#eewStaleMs = eewStaleMs;
  }

  start(event, { manual = Boolean(event?.manual) } = {}) {
    this.#generation++;
    this.#session = null;
    const kind = kindOf(event);
    if (typeof event?.id !== 'string' || !event.id || !kind) {
      return { ...this.#empty(), close: true, reason: 'invalid-event' };
    }
    const now = this.#time();
    const session = { id: event.id, generation: this.#generation, kind, manual: Boolean(manual),
      startedAt: now, checkedAt: now, lastInformationAt: now, lastProgressAt: now,
      endedAt: null, closedReason: null, expiresAt: null, seen: new Set(), issued: new Map(), reports: new Map() };
    this.#session = session;
    if (now === null) return this.#close(session, 'invalid-clock', null);
    const unsafe = unsafeReason(event);
    if (unsafe) return this.#close(session, unsafe, now);
    this.#observe(session, event, now);
    if (kind === 'eew' && (event.present === false || !(event.nativeActive ?? event.active))) session.endedAt = now;
    return this.#decision(session, now);
  }

  update(status) {
    const session = this.#session;
    if (!session) return this.#empty();
    if (session.closedReason) return this.#snapshot(session);
    const now = this.#time();
    if (now === null || now < session.checkedAt) return this.#close(session, 'invalid-clock', now);
    session.checkedAt = now;
    // A poll/callback belonging to a previous event has no authority here.
    if (status && status.id !== session.id) return this.#decision(session, now);
    const unsafe = unsafeReason(status);
    if (unsafe) return this.#close(session, unsafe, now);
    const present = status && status.present !== false && status.reason !== 'missing';
    if (present) {
      const progress = this.#observe(session, status, now);
      const kind = kindOf(status);
      if (kind && kind !== session.kind) {
        // A replayed EEW/normal alias must not roll the current policy back.
        // Same-kind end flags remain meaningful without a new source report.
        if (!progress) return this.#decision(session, now);
        session.kind = kind;
        session.endedAt = null;
      }
      if (session.kind === 'eew') {
        const active = status.nativeActive ?? status.active;
        if (!active) session.endedAt ??= now;
        else if (progress) session.endedAt = null;
      }
    } else if (session.kind === 'eew') session.endedAt ??= now;
    return this.#decision(session, now);
  }

  clear() {
    this.#generation++;
    this.#session = null;
    return this.#empty();
  }

  #time() {
    try { return finite(this.#now()); } catch { return null; }
  }

  #observe(session, status, now) {
    const key = fingerprint(status);
    if (session.seen.has(key)) return false;
    session.seen.add(key);
    if (session.seen.size > MAX_FINGERPRINTS) session.seen.delete(session.seen.values().next().value);
    const kind = kindOf(status) ?? session.kind;
    const issue = issuedAt(status, now), previousIssue = session.issued.get(kind);
    const report = finite(status.report), previousReport = session.reports.get(kind);
    if (issue !== null && previousIssue !== undefined && issue < previousIssue) return false;
    if (kind === 'eew' && report !== null && previousReport !== undefined && report < previousReport &&
      (issue === null || previousIssue !== undefined && issue <= previousIssue)) return false;
    if (issue !== null) session.issued.set(kind, Math.max(issue, previousIssue ?? -Infinity));
    if (report !== null) session.reports.set(kind, Math.max(report, previousReport ?? -Infinity));
    session.lastInformationAt = now;
    session.lastProgressAt = now;
    return true;
  }

  #decision(session, now) {
    if (session.closedReason) return this.#snapshot(session);
    let expiresAt, reason;
    if (session.kind === 'eew' && session.endedAt !== null) {
      expiresAt = session.endedAt + this.#eewEndGraceMs;
      reason = 'eew-ended';
    } else if (session.kind === 'eew') {
      expiresAt = session.lastProgressAt + this.#eewStaleMs;
      reason = 'eew-stale';
    } else {
      expiresAt = session.lastInformationAt + this.#informationHoldMs;
      reason = 'information-timeout';
    }
    const manualEnd = session.startedAt + this.#manualHoldMs;
    if (session.manual && manualEnd <= expiresAt) { expiresAt = manualEnd; reason = 'manual-timeout'; }
    session.expiresAt = expiresAt;
    if (now >= expiresAt) session.closedReason = reason;
    return this.#snapshot(session);
  }

  #close(session, reason, now) {
    session.closedReason = reason;
    session.expiresAt = now;
    return this.#snapshot(session);
  }

  #snapshot(session) {
    return { id: session.id, generation: session.generation, close: Boolean(session.closedReason),
      reason: session.closedReason, expiresAt: session.expiresAt };
  }

  #empty() {
    return { id: null, generation: this.#generation, close: false, reason: null, expiresAt: null };
  }
}
