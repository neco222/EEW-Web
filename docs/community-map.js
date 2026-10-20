import {CommunityFocus} from './community-focus.js';
import {readView} from './viewer-bridge.js';
import {readMapControl, panCommunityFocus, cancelCommunityFocus} from './community-map-bridge.js';

// Match the original viewer's manual camera hold, without writing its timer or
// permission flags. One timer exists only while fresh live reports are pending.
export const COMMUNITY_MANUAL_HOLD_MS = 30_000;
const MAP_KEYS = new Set(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','PageUp','PageDown','Home','End','+','-','=','0','z','c','x','Z','C','X']);

export function startCommunityMapFollow({enabled = true, now = Date.now,
  doc = globalThis.document, events = globalThis,
  vm = () => globalThis.vm, scaffolding = () => globalThis.scaffolding,
  read = readView, control = readMapControl, pan = panCommunityFocus, cancelPan = cancelCommunityFocus,
  focus = new CommunityFocus({now}), schedule = globalThis.setTimeout,
  cancel = globalThis.clearTimeout, onMove = () => {}} = {}) {
  let running = true, stopped = false, timer = null, manualUntil = -Infinity, layoutReadyAt = -Infinity;
  let blockedReason = null;
  const pointers = new Set();
  const listeners = [];

  function discard() {
    if (timer !== null) cancel(timer);
    timer = null;
    layoutReadyAt = -Infinity;
    focus.clear();
  }
  function interrupt() {
    try {cancelPan(vm());} catch { /* A replaced native project owns its camera. */ }
    discard();
  }
  function active() {
    return !(stopped || !running || !enabled || doc?.hidden || pointers.size || now() < manualUntil);
  }
  function context() {
    blockedReason = null;
    if (!active()) return null;
    if (['loading','error','launch'].some(id => {
      const node = doc?.getElementById?.(id);
      return node && !node.hidden;
    })) return null;
    try {
      const machine = vm(), view = read(machine, scaffolding());
      const state = control(machine, view, now());
      blockedReason = state?.reason ?? null;
      return state?.ready && !state.blocked ? {machine, view} : null;
    } catch { return null; } // A changed/unready native project stays in charge.
  }
  function arm() {
    if (timer !== null || stopped || !running || !enabled) return;
    const state = focus.snapshot();
    if (!state.pendingCount || !Number.isFinite(state.readyAt)) return;
    timer = schedule(tick, Math.max(0, Math.max(state.readyAt, layoutReadyAt) - now()));
  }
  function tick() {
    timer = null;
    const ready = context();
    if (!ready) {discard();return;}
    const next = focus.take();
    if (next) {
      // The bridge rechecks native priority in the same task as the write.
      const result = pan(next, ready.machine, ready.view, now());
      if (result?.moved) {try {onMove(next, result);} catch { /* Optional display metadata. */ }}
    }
    arm();
  }
  function manual() {
    manualUntil = now() + COMMUNITY_MANUAL_HOLD_MS;
    interrupt();
  }
  function layout(event) {
    if (event?.detail?.source !== 'camera-reservation') {interrupt();return;}
    // Video and this map can be triggered by the same report. Its geographic
    // target survives the camera shelf opening; queued work waits for the
    // resized native geometry, then rechecks all warning/manual priorities.
    if (timer !== null) cancel(timer);
    timer = null;
    layoutReadyAt = now() + 300;
    arm();
  }
  function inViewer(event) {
    return Boolean(event.target?.closest?.('#app') || event.composedPath?.().some(node => node?.id === 'app'));
  }
  function down(event) {
    if (!inViewer(event)) return;
    pointers.add(event.pointerId);
    manual();
  }
  function up(event) {
    if (pointers.delete(event.pointerId)) manual();
  }
  function key(event) {
    const target = event.target;
    if (target?.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(target?.tagName ?? '')) return;
    // Scratch receives document key events even when the canvas has no focus.
    if (inViewer(event) || MAP_KEYS.has(event.key)) manual();
  }
  function listen(target, name, handler, options) {
    if (!target?.addEventListener) return;
    target.addEventListener(name, handler, options);
    listeners.push(() => target.removeEventListener(name, handler, options));
  }
  listen(doc, 'pointerdown', down, {capture:true,passive:true});
  listen(doc, 'pointerup', up, {capture:true,passive:true});
  listen(doc, 'pointercancel', up, {capture:true,passive:true});
  listen(doc, 'pointermove', () => {if(pointers.size)manual();}, {capture:true,passive:true});
  listen(doc, 'wheel', event => {if(inViewer(event))manual();}, {capture:true,passive:true});
  listen(doc, 'keydown', key, true);
  listen(doc, 'visibilitychange', () => {pointers.clear();interrupt();});
  listen(doc, 'eew-layout-change', layout);
  listen(events, 'resize', interrupt);
  listen(events, 'blur', () => {pointers.clear();interrupt();});

  return {
    ingestLive(next, detail) {
      if (!context()) {
        // Keep an already accepted batch through this camera-only reflow, but
        // reject new intake until the native geometry is usable. Other native
        // priorities still discard it immediately, even during that short wait.
        if (now() < layoutReadyAt && active() && blockedReason === 'layout-unsettled') return {accepted:false,reason:'layout-settling'};
        discard();return {accepted:false,reason:'native-priority'};
      }
      const result = focus.ingestLive(next, detail);
      arm();
      return result;
    },
    setEnabled(value) {enabled = Boolean(value);interrupt();},
    pause() {running = false;pointers.clear();interrupt();},
    resume() {if (!stopped) {running = true;discard();}},
    stop() {stopped = true;running = false;interrupt();for(const remove of listeners)remove();pointers.clear();},
  };
}
