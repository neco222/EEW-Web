import {CommunityFocus} from './community-focus.js';
import {rankCameras} from './camera-model.js';

export const COMMUNITY_CAMERA_HOLD_MS = 30_000;
export const COMMUNITY_CAMERA_DURATION_MS = 120_000;

/** ReadMapControl is read-only. Its native pan setting does not control video.
 * Actual shaking is a reason to offer a report camera, not a reason to block it.
 * A native warning, recent earthquake, replay/history or manual move still wins.
 */
export function communityCameraAllowed(state, current = null) {
  if (!state?.ready || current && current.kind !== 'community') return false;
  if (communityCameraMustYield(state)) return false;
  if (['dialog', 'history', 'not-map'].includes(state.reason)) return false;
  if (state.historyIndex !== 0 || state.manualMotion || state.nativeMoving || state.nativePending) return false;
  if (!Number.isFinite(state.manualAgeMs) || state.manualAgeMs <= COMMUNITY_CAMERA_HOLD_MS) return false;
  return true;
}

export function communityCameraMustYield(state) {
  return Boolean(state?.eewActive || state?.tsunamiActive || ['replay','tsunami-active'].includes(state?.reason) ||
    Number.isFinite(state?.nativeInformationAgeMs) && state.nativeInformationAgeMs <= COMMUNITY_CAMERA_DURATION_MS);
}

/**
 * Passive, bounded policy for accepted live 561 callbacks. No timers, network,
 * DOM, native writes or media players. Source/receipt freshness, regional
 * coordinates and ID/UID suppression are delegated to CommunityFocus.
 *
 * ingestLive(next, detail) -> {accepted,reason}; take({blocked}) -> null or
 * {event,choices,selected}. snapshot() supplies pendingCount/readyAt for one
 * controller timer, plus active id/expiresAt/close for its ordinary 1s tick.
 * The controller must check native priority at intake AND immediately before
 * take(). blocked/clearPending drop inputs; they never save them for a replay.
 *
 * Selection is held for 30s, then another fresh local batch can choose a new
 * camera only if the present camera is no longer within 300km of that region.
 * Existing selected cameras win ties over a slightly nearer alternative. The
 * session expires two minutes after its FIRST adoption, never extended by more
 * reports or a retarget. dismiss() keeps that deadline and suppresses auto
 * reopening, while allowing the user to reopen the same camera manually.
 * Native earthquake/EEW adoption calls cancel() and always takes priority.
 */
export class CommunityCameraPolicy {
  #now;
  #focus;
  #catalogue;
  #holdMs;
  #durationMs;
  #session = null;
  #nextSelectionAt = -Infinity;
  #dismissUntil = -Infinity;
  #sequence = 0;
  #checkedAt = -Infinity;

  constructor({now = Date.now, catalogue = [], holdMs = COMMUNITY_CAMERA_HOLD_MS,
    durationMs = COMMUNITY_CAMERA_DURATION_MS} = {}) {
    if (typeof now !== 'function' || !Array.isArray(catalogue)) throw new TypeError('A clock and camera catalogue are required');
    if (![holdMs,durationMs].every(value => Number.isFinite(value) && value > 0)) throw new RangeError('Camera durations must be positive');
    this.#now = now;
    this.#catalogue = catalogue.map(camera => ({...camera}));
    this.#holdMs = holdMs;
    this.#durationMs = durationMs;
    this.#focus = new CommunityFocus({now, intervalMs:400});
  }

  #clock() {
    const now = this.#now();
    if (!Number.isFinite(now)) throw new TypeError('now must return epoch milliseconds');
    if(now<this.#checkedAt&&this.#session){this.#session.expiresAt=now;this.clearPending();}
    this.#checkedAt=Math.max(this.#checkedAt,now);
    return now;
  }

  ingestLive(next, detail) {
    const now = this.#clock();
    if (now < this.#nextSelectionAt || now < this.#dismissUntil) {
      this.clearPending();
      return {accepted:false,reason:'camera-held'};
    }
    return this.#focus.ingestLive(next,detail);
  }

  take({blocked = false} = {}) {
    const now = this.#clock();
    if (blocked || now < this.#nextSelectionAt || now < this.#dismissUntil) {this.clearPending();return null;}
    const focus = this.#focus.take();
    if (!focus) return null;
    const nearby = rankCameras(focus,this.#catalogue,{limit:Math.max(5,this.#catalogue.length)});
    if (!nearby.length) return null;
    if (this.#session && now >= this.#session.expiresAt) this.#session = null;
    this.#nextSelectionAt = now + this.#holdMs;
    if (this.#session && nearby.some(camera => camera.id === this.#session.cameraId)) return null;
    const choices = nearby.slice(0,5);
    const selected = choices[0];
    const id = this.#session?.id ?? `community-camera:${++this.#sequence}`;
    const expiresAt = this.#session?.expiresAt ?? now + this.#durationMs;
    this.#session = {id,cameraId:selected.id,expiresAt};
    const area = focus.areas.toSorted((a,b) => b.count-a.count || a.code-b.code)[0];
    const event = {id,kind:'community',source:'561',unit:'reports',measured:false,
      lat:focus.lat,lon:focus.lon,time:focus.receivedAt,receivedAt:focus.receivedAt,
      name:focus.areas.length > 1 ? `${area.name} ほか${focus.areas.length-1}地域` : area.name,
      areas:focus.areas.map(item => ({...item})),count:focus.count,expiresAt};
    return {event,choices,selected};
  }

  snapshot() {
    const now = this.#clock();
    const pending = this.#focus.snapshot();
    return {...pending,id:this.#session?.id ?? null,expiresAt:this.#session?.expiresAt ?? null,
      close:Boolean(this.#session && now >= this.#session.expiresAt)};
  }

  select(id) {
    if (!this.#session || typeof id !== 'string') return;
    this.#session.cameraId = id;
    this.#nextSelectionAt = this.#clock() + this.#holdMs;
    this.clearPending();
  }

  dismiss() {
    const now = this.#clock();
    this.#dismissUntil = Math.max(this.#dismissUntil,this.#session?.expiresAt ?? now + this.#holdMs);
    this.clearPending();
  }

  clearPending() {this.#focus.clear();}
  cancel() {this.#session = null;this.clearPending();}
}
