import { youtubeEmbedURL } from './camera-model.js';

const API_URL = 'https://www.youtube.com/iframe_api';
const TIMEOUT_MS = 15000;
const apiLoads = new WeakMap();
const activePlayers = new WeakMap();
const failedScripts = new WeakSet();
let nextFrameId = 0;

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function safely(callback, value) {
  try { callback(value); } catch { /* A camera callback cannot stop the viewer. */ }
}

/** Share a lazy load, but cancel an abandoned attempt so it can be retried. */
function acquireAPI(window, document, setTimer, clearTimer) {
  if (typeof window.YT?.Player === 'function') return { promise: Promise.resolve(window.YT), release() {} };
  let load = apiLoads.get(window);
  if (!load) {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    load = { promise, users: 0, settled: false, cancel: null };
    apiLoads.set(window, load);
    const previousReady = window.onYouTubeIframeAPIReady;
    let script, owned = false, timer;
    const finish = (error) => {
      if (load.settled) return;
      load.settled = true;
      clearTimer(timer);
      script?.removeEventListener('error', onError);
      script?.removeEventListener('load', onLoad);
      if (window.onYouTubeIframeAPIReady === onReady) {
        if (previousReady === undefined) delete window.onYouTubeIframeAPIReady;
        else window.onYouTubeIframeAPIReady = previousReady;
      }
      if (apiLoads.get(window) === load) apiLoads.delete(window);
      if (error) {
        if (script) failedScripts.add(script);
        if (owned) script?.remove();
        reject(error);
      } else resolve(window.YT);
    };
    const onLoad = () => { if (typeof window.YT?.Player === 'function') finish(); };
    const onError = () => finish(failure('api-load'));
    const onReady = () => {
      if (typeof previousReady === 'function') safely(previousReady.bind(window));
      if (typeof window.YT?.Player === 'function') finish();
      else finish(failure('api-unavailable'));
    };
    load.cancel = () => finish(failure('cancelled'));
    try {
      window.onYouTubeIframeAPIReady = onReady;
      script = [...document.querySelectorAll('script')].find(element => element.src === API_URL && !failedScripts.has(element));
      if (!script) {
        script = document.createElement('script');
        script.src = API_URL;
        script.async = true;
        script.referrerPolicy = 'strict-origin-when-cross-origin';
        owned = true;
      }
      script.addEventListener('error', onError);
      script.addEventListener('load', onLoad);
      timer = setTimer(() => finish(failure('api-timeout')), TIMEOUT_MS);
      if (owned) (document.head ?? document.documentElement).appendChild(script);
    } catch { finish(failure('api-load')); }
  }
  load.users++;
  let released = false;
  return {
    promise: load.promise,
    release() {
      if (released) return;
      released = true;
      if (--load.users === 0 && !load.settled) load.cancel();
    },
  };
}

/**
 * A single visible YouTube player. No requests are made until show().
 * The caller reserves a visible viewport of at least 200x200px and calls
 * destroy() whenever that pane or the page is hidden; show() recreates it.
 * show()/play()/destroy() return this. Failures use callbacks, never rejected
 * promises. onError receives the same {state:'error', code} as onStatus.
 * Playing means playback, not proof that a source is currently broadcasting.
 */
export class LiveCameraPlayer {
  #window;
  #document;
  #setTimer;
  #clearTimer;
  #onStatus;
  #onError;
  #session = null;
  #generation = 0;

  constructor({ onStatus = () => {}, onError = () => {},
    window = globalThis.window ?? globalThis, document = globalThis.document,
    setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout } = {}) {
    this.#window = window;
    this.#document = document;
    // Window timers require their native receiver, even when held in fields.
    this.#setTimer = (...args) => setTimeout.call(window, ...args);
    this.#clearTimer = (...args) => clearTimeout.call(window, ...args);
    this.#onStatus = typeof onStatus === 'function' ? onStatus : () => {};
    this.#onError = typeof onError === 'function' ? onError : () => {};
  }

  show(camera, container) {
    this.destroy();
    activePlayers.get(this.#window)?.destroy();
    activePlayers.set(this.#window, this);
    const session = { generation: this.#generation, frame: null, player: null,
      lease: null, readyTimer: null, playTimer: null, ready: false, lastStatus: null, destroyedPlayer: null };
    this.#session = session;
    this.#status(session, 'loading');
    if (!this.#current(session)) return this;
    try {
      const document = this.#document ?? container?.ownerDocument;
      if (!document || typeof container?.appendChild !== 'function') throw failure('invalid-container');
      const url = new URL(youtubeEmbedURL(camera?.videoId, this.#window.location?.origin ?? document.location?.origin));
      // Playback only begins after the documented mute() API has completed.
      url.searchParams.set('autoplay', '0');
      url.searchParams.delete('mute');
      const frame = document.createElement('iframe');
      session.frame = frame;
      frame.id = `eew-live-camera-${++nextFrameId}`;
      frame.src = url.href;
      frame.title = `${camera?.label || 'カメラ'}の映像`;
      frame.width = '100%';
      frame.height = '100%';
      frame.style.cssText = 'display:block;width:100%;height:100%;border:0';
      frame.referrerPolicy = 'strict-origin-when-cross-origin';
      frame.setAttribute('allow', 'autoplay; fullscreen; encrypted-media; picture-in-picture');
      frame.setAttribute('allowfullscreen', '');
      container.appendChild(frame);
      this.#load(session, document);
    } catch (error) { this.#fail(session, error.code ?? 'invalid-camera'); }
    return this;
  }

  play() {
    if (this.#session?.ready) this.#play(this.#session);
    return this;
  }

  destroy() {
    this.#generation++;
    const session = this.#session;
    this.#session = null;
    if (activePlayers.get(this.#window) === this) activePlayers.delete(this.#window);
    if (session) this.#dispose(session);
    return this;
  }

  #current(session) { return this.#session === session && this.#generation === session.generation; }

  #status(session, state, code) {
    if (!this.#current(session)) return;
    const key = `${state}:${code ?? ''}`;
    if (session.lastStatus === key) return;
    session.lastStatus = key;
    safely(this.#onStatus, code === undefined ? { state } : { state, code });
  }

  async #load(session, document) {
    let lease;
    try {
      lease = acquireAPI(this.#window, document, this.#setTimer, this.#clearTimer);
      session.lease = lease;
      const api = await lease.promise;
      lease.release();
      session.lease = null;
      if (!this.#current(session)) return;
      session.readyTimer = this.#setTimer(() => this.#fail(session, 'player-timeout'), TIMEOUT_MS);
      const player = new api.Player(session.frame, { events: {
        onReady: event => {
          if (!this.#current(session)) return;
          session.player = event.target;
          session.ready = true;
          this.#clearTimer(session.readyTimer);
          session.readyTimer = null;
          this.#play(session);
        },
        onStateChange: event => this.#stateChange(session, event.data),
        onAutoplayBlocked: () => {
          if (!this.#current(session)) return;
          this.#clearPlayTimer(session);
          this.#status(session, 'blocked');
        },
        onError: event => this.#fail(session, event.data ?? 'player-error'),
      } });
      if (this.#current(session)) session.player = player;
      else this.#destroyNative(session, player);
    } catch (error) { this.#fail(session, error.code ?? 'player-error'); }
    finally {
      lease?.release();
      if (session.lease === lease) session.lease = null;
    }
  }

  #play(session) {
    if (!this.#current(session)) return;
    this.#clearPlayTimer(session);
    session.playTimer = this.#setTimer(() => {
      if (!this.#current(session)) return;
      session.playTimer = null;
      this.#status(session, 'blocked', 'autoplay-timeout');
    }, TIMEOUT_MS);
    this.#status(session, 'loading');
    if (!this.#current(session)) return;
    try {
      session.player.mute();
      if (this.#current(session)) session.player.playVideo();
    } catch { this.#fail(session, 'player-error'); }
  }

  #stateChange(session, state) {
    if (!this.#current(session)) return;
    if (state === 1 || state === 2 || state === 0) {
      this.#clearPlayTimer(session);
      this.#status(session, state === 1 ? 'playing' : state === 2 ? 'paused' : 'ended');
    } else if (state === -1 || state === 3 || state === 5) this.#status(session, 'loading');
  }

  #clearPlayTimer(session) {
    this.#clearTimer(session.playTimer);
    session.playTimer = null;
  }

  #destroyNative(session, player) {
    if (!player || session.destroyedPlayer === player) return;
    session.destroyedPlayer = player;
    let frame;
    try { frame = player.getIframe?.(); } catch { /* A failed embed may have no iframe. */ }
    try { player.destroy(); } catch { /* Already detached players are still disposed. */ }
    try { frame?.remove(); } catch { /* The API may have removed it already. */ }
  }

  #dispose(session) {
    this.#clearTimer(session.readyTimer);
    this.#clearPlayTimer(session);
    session.lease?.release();
    session.lease = null;
    this.#destroyNative(session, session.player);
    try { session.frame?.remove(); } catch { /* Only our own iframe is removed. */ }
  }

  #fail(session, code) {
    if (!this.#current(session)) return;
    this.#session = null;
    if (activePlayers.get(this.#window) === this) activePlayers.delete(this.#window);
    this.#dispose(session);
    const status = { state: 'error', code };
    safely(this.#onStatus, status);
    // onStatus can synchronously open a different camera or close the pane.
    if (this.#generation === session.generation) safely(this.#onError, status);
  }
}
