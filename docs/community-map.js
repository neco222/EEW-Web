import {CommunityFocus} from './community-focus.js';
import {readView} from './viewer-bridge.js';
import {readMapControl, panCommunityFocus, cancelCommunityFocus} from './community-map-bridge.js';

// Match the original viewer's manual camera hold, without writing its timer or
// permission flags. One timer exists only while fresh live reports are pending.
export const COMMUNITY_MANUAL_HOLD_MS = 30_000;
export const COMMUNITY_NATIVE_RETRY_MS = 100;
const TRANSIENT_NATIVE = new Set(['native-pending','native-auto-recent','native-moving']);
const MAP_KEYS = new Set(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','PageUp','PageDown','Home','End','+','-','=','0','z','c','x','Z','C','X']);

export function startCommunityMapFollow({enabled = true, now = Date.now,
  doc = globalThis.document, events = globalThis,
  vm = () => globalThis.vm, scaffolding = () => globalThis.scaffolding,
  read = readView, control = readMapControl, pan = panCommunityFocus, cancelPan = cancelCommunityFocus,
  focus = new CommunityFocus({now}), schedule = globalThis.setTimeout,
  cancel = globalThis.clearTimeout, onMove = () => {}, onState = () => {}} = {}) {
  let running = true, stopped = false, timer = null, manualUntil = -Infinity, layoutReadyAt = -Infinity;
  let blockedReason = null, nativeStateReady = false, retryAt = -Infinity, flight = null, lastState = '';
  const pointers = new Set();
  const listeners = [];

  function report(state, reason = null) {
    const key = `${state}:${reason}`;
    if (key === lastState) return;
    lastState = key;
    try {onState({state,reason,at:now()});} catch { /* Optional status UI. */ }
  }

  function discard() {
    if (timer !== null) cancel(timer);
    timer = null;
    layoutReadyAt = -Infinity;
    retryAt = -Infinity;
    flight = null;
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
    blockedReason = null;nativeStateReady=false;
    if (!active()) {blockedReason = !enabled?'disabled':doc?.hidden?'hidden':!running?'paused':'manual-hold';return null;}
    if (['loading','error','launch'].some(id => {
      const node = doc?.getElementById?.(id);
      return node && !node.hidden;
    })) {blockedReason = 'viewer-unavailable';return null;}
    try {
      const machine = vm(), view = read(machine, scaffolding());
      const state = control(machine, view, now());
      nativeStateReady=state?.ready===true;
      blockedReason = state?.reason ?? null;
      return state?.ready && !state.blocked ? {machine, view, state} : null;
    } catch {blockedReason='native-state-unavailable';return null;} // A changed/unready native project stays in charge.
  }
  function canWait() {
    return active() && (nativeStateReady && TRANSIENT_NATIVE.has(blockedReason) ||
      blockedReason === 'layout-unsettled' && now() < layoutReadyAt);
  }
  function arm() {
    if (timer !== null || stopped || !running || !enabled) return;
    const state = focus.snapshot();
    let next = state.pendingCount && Number.isFinite(state.readyAt) ? Math.max(state.readyAt, layoutReadyAt, retryAt) : Infinity;
    if (flight) next = Math.min(next, Math.max(now() + COMMUNITY_NATIVE_RETRY_MS,layoutReadyAt));
    if (Number.isFinite(next)) timer = schedule(tick, Math.max(0, next - now()));
  }
  function tick() {
    timer = null;
    if(!flight&&!focus.snapshot().pendingCount){report('ignored','expired');return;}
    const ready = context();
    if (!ready) {
      if (canWait() && focus.snapshot().pendingCount) {
        flight=null;retryAt=now()+COMMUNITY_NATIVE_RETRY_MS;report('waiting',blockedReason);arm();return;
      }
      report('blocked',blockedReason);discard();return;
    }
    if (flight) {
      const state=ready.state;
      const stillTarget = Math.abs(state.camera?.targetX-flight.target.x)<1e-8 && Math.abs(state.camera?.targetY-flight.target.y)<1e-8;
      if (!stillTarget) {report('blocked','native-replaced');flight=null;}
      else if (state.targetDistancePx <= 2 && !state.nativeMoving) {report('arrived');flight=null;}
      else if (now() >= flight.until) {report('blocked','movement-timeout');flight=null;}
    }
    retryAt=-Infinity;
    const next = focus.take();
    if (next) {
      // The bridge rechecks native priority in the same task as the write.
      const result = pan(next, ready.machine, ready.view, now());
      if (result?.moved) {
        flight=result.target?{target:result.target,until:now()+3000}:null;
        report('moving');
        try {onMove(next, result);} catch { /* Optional display metadata. */ }
      } else report('blocked',result?.reason ?? 'native-priority');
    }
    else if (!flight && !focus.snapshot().pendingCount && lastState.startsWith('waiting:')) report('ignored','expired');
    arm();
  }
  function manual() {
    manualUntil = now() + COMMUNITY_MANUAL_HOLD_MS;
    report('blocked','manual-hold');
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
  listen(doc, 'visibilitychange', () => {pointers.clear();interrupt();report(doc.hidden?'paused':enabled?'idle':'disabled');});
  listen(doc, 'eew-layout-change', layout);
  listen(events, 'resize', interrupt);
  listen(events, 'blur', () => {pointers.clear();interrupt();});

  return {
    ingestLive(next, detail) {
      if (!context()) {
        // Keep fresh input through a brief native adjustment, with the original
        // five-second receipt deadline. Warnings, history, manual actions and
        // unrelated layout changes still discard it immediately.
        if (now() < layoutReadyAt && active() && blockedReason === 'layout-unsettled') return {accepted:false,reason:'layout-settling'};
        if (canWait()) {
          const result=focus.ingestLive(next,detail);
          if(result.accepted){retryAt=now()+COMMUNITY_NATIVE_RETRY_MS;report('waiting',blockedReason);arm();}
          return result;
        }
        report('blocked',blockedReason);discard();return {accepted:false,reason:blockedReason ?? 'native-priority'};
      }
      const result = focus.ingestLive(next, detail);
      report(result.accepted?'pending':'ignored',result.accepted?null:result.reason);
      arm();
      return result;
    },
    setEnabled(value) {enabled = Boolean(value);interrupt();report(enabled?'idle':'disabled');},
    pause() {running = false;pointers.clear();interrupt();report('paused');},
    resume() {if (!stopped) {running = true;discard();report(enabled?'idle':'disabled');}},
    stop() {stopped = true;running = false;interrupt();for(const remove of listeners)remove();pointers.clear();},
  };
}
