/* Local recording harness. Inject BEFORE viewer-entry.js; never ship this file.
 * Only the community P2P transport is simulated. Other viewer traffic passes
 * through unchanged. After welcome closes, use eewRecording.emitReports(area,
 * count). The parent recording page owns all labels and event timing.
 */
(() => {
  if (globalThis.__communityRecording) return;
  const WS_URL = 'wss://api.p2pquake.net/v2/ws';
  const CHANNEL = 'eewgit-community-feed-v1';
  const original = {
    WebSocket: globalThis.WebSocket,
    fetch: globalThis.fetch,
    BroadcastChannel: globalThis.BroadcastChannel,
  };
  const sockets = new Set();
  const timers = new Set();
  const log = [];
  const session = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let sequence = 0;
  let startedAt = null;
  let playing = false;
  let removed = false;
  let finish = null;

  const later = (fn, ms) => {
    const id = setTimeout(() => { timers.delete(id); fn(); }, ms);
    timers.add(id);
    return id;
  };
  const connected = () => [...sockets].filter((socket) => socket.readyState === 1);
  const elapsed = () => startedAt === null ? 0 : Math.round(performance.now() - startedAt);
  const announce = (type, detail = {}) => {
    const item = { type, elapsedMs: elapsed(), ...detail };
    log.push(item);
    globalThis.dispatchEvent(new CustomEvent('community-recording', { detail: item }));
  };

  class RecordingSocket extends EventTarget {
    constructor(url) {
      super();
      this.url = String(url);
      this.readyState = 0;
      this.bufferedAmount = 0;
      this.extensions = '';
      this.protocol = '';
      this.binaryType = 'blob';
      this.onopen = this.onmessage = this.onerror = this.onclose = null;
      sockets.add(this);
      later(() => {
        if (this.readyState !== 0) return;
        this.readyState = 1;
        this.emit('open', new Event('open'));
        announce('connected');
      }, 0);
    }
    emit(type, event) {
      this.dispatchEvent(event);
      this[`on${type}`]?.call(this, event);
    }
    receive(message) {
      if (this.readyState === 1) this.emit('message', new MessageEvent('message', { data: JSON.stringify(message) }));
    }
    send() { /* This feed does not send client messages. */ }
    close(code = 1000, reason = '') {
      if (this.readyState === 3) return;
      this.readyState = 3;
      sockets.delete(this);
      this.emit('close', new CloseEvent('close', { code, reason, wasClean: true }));
    }
  }
  for (const [name, value] of Object.entries({ CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 })) {
    Object.defineProperty(RecordingSocket, name, { value });
    Object.defineProperty(RecordingSocket.prototype, name, { value });
  }

  function SelectiveWebSocket(url, protocols) {
    if (!new.target) throw new TypeError('WebSocket constructor requires new');
    if (String(url) === WS_URL) return new RecordingSocket(url);
    return protocols === undefined ? new original.WebSocket(url) : new original.WebSocket(url, protocols);
  }
  Object.setPrototypeOf(SelectiveWebSocket, original.WebSocket);
  SelectiveWebSocket.prototype = original.WebSocket.prototype;
  globalThis.WebSocket = SelectiveWebSocket;

  const selectiveFetch = function (input, options) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, location.href);
    if (url.origin === 'https://api.p2pquake.net' && url.pathname === '/v2/history') {
      const signal = options?.signal ?? input?.signal;
      if (signal?.aborted) return Promise.reject(new DOMException('Request aborted', 'AbortError'));
      return Promise.resolve(new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    return original.fetch.call(globalThis, input, options);
  };
  globalThis.fetch = selectiveFetch;

  // Do not join a real tab's shared feed. The app already has a supported direct
  // fallback when constructing this particular BroadcastChannel fails.
  let SelectiveBroadcastChannel;
  if (original.BroadcastChannel) {
    SelectiveBroadcastChannel = function (name) {
      if (!new.target) throw new TypeError('BroadcastChannel constructor requires new');
      if (String(name) === CHANNEL) throw new DOMException('Isolated local recording', 'NotSupportedError');
      return new original.BroadcastChannel(name);
    };
    Object.setPrototypeOf(SelectiveBroadcastChannel, original.BroadcastChannel);
    SelectiveBroadcastChannel.prototype = original.BroadcastChannel.prototype;
    globalThis.BroadcastChannel = SelectiveBroadcastChannel;
  }

  const defaultPlan = Object.freeze([
    { at: 1500, area: 10, count: 1 },
    { at: 2300, area: 10, count: 2 },
    { at: 2900, area: 60, count: 1 },
    { at: 3600, area: 70, count: 1 },
    { at: 4400, area: 60, count: 2 },
    // The first wave has disappeared by 7.4 s; these are new counters.
    { at: 9000, area: 10, count: 1 },
    { at: 9800, area: 70, count: 1 },
    { at: 10800, area: 10, count: 4 },
    { at: 11800, area: 60, count: 2 },
    { at: 13200, area: 70, count: 2 },
    { at: 14800, area: 10, count: 1 },
  ]);

  function send(area, count = 1) {
    if (removed) throw new Error('Recording harness was disposed');
    if (!Number.isInteger(area) || !Number.isSafeInteger(count) || count < 1 || count > 10000) {
      throw new TypeError('Use a numeric P2P region and 1..10000 individual reports');
    }
    const recipients = connected();
    if (!recipients.length) throw new Error('Community feed is not connected yet');
    for (let i = 0; i < count; i++) {
      const id = `local-recording-${session}-${++sequence}`;
      const message = { code: 561, id, uid: id, time: new Date().toISOString(), area };
      for (const socket of recipients) socket.receive(message);
      announce('report', { area, id });
    }
    return { area, count, sent: sequence };
  }

  function cancel() {
    for (const id of timers) clearTimeout(id);
    timers.clear();
    if (playing) { playing = false; announce('cancelled'); }
    finish?.({ cancelled: true, sent: sequence, log: [...log] });
    finish = null;
  }

  const controller = {
    defaultPlan,
    send,
    emitReports: send,
    get state() {
      return { connected: connected().length, playing, elapsedMs: elapsed(), sent: sequence, log: [...log] };
    },
    play({ plan = defaultPlan, durationMs = 20000 } = {}) {
      if (removed) throw new Error('Recording harness was disposed');
      if (playing) throw new Error('A recording sequence is already running');
      if (!connected().length) throw new Error('Wait until __communityRecording.state.connected > 0');
      if (!Array.isArray(plan) || plan.some((entry) => !Number.isFinite(entry?.at) || entry.at < 0 ||
          !Number.isInteger(entry.area) || !Number.isSafeInteger(entry.count ?? 1) ||
          (entry.count ?? 1) < 1 || (entry.count ?? 1) > 10000)) throw new TypeError('Invalid timed report plan');
      const lastAt = Math.max(0, ...plan.map((entry) => entry.at));
      if (!Number.isFinite(durationMs) || durationMs < lastAt + 3200) {
        throw new RangeError('Allow at least 3.2 seconds after the final report');
      }
      startedAt = performance.now();
      playing = true;
      announce('started', { durationMs, scheduledReports: plan.reduce((sum, entry) => sum + (entry.count ?? 1), 0) });
      const complete = new Promise((resolve) => { finish = resolve; });
      for (const entry of plan) later(() => {
        try { send(entry.area, entry.count ?? 1); }
        catch (error) { announce('error', { message: error.message }); cancel(); }
      }, entry.at);
      later(() => {
        playing = false;
        announce('complete');
        finish?.({ cancelled: false, sent: sequence, log: [...log] });
        finish = null;
      }, durationMs);
      return complete;
    },
    cancel,
    dispose() {
      cancel();
      removed = true;
      for (const socket of sockets) socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      for (const socket of [...sockets]) socket.close();
      if (globalThis.WebSocket === SelectiveWebSocket) globalThis.WebSocket = original.WebSocket;
      if (globalThis.fetch === selectiveFetch) globalThis.fetch = original.fetch;
      if (SelectiveBroadcastChannel && globalThis.BroadcastChannel === SelectiveBroadcastChannel) globalThis.BroadcastChannel = original.BroadcastChannel;
    },
  };
  globalThis.__communityRecording = globalThis.eewRecording = controller;
})();
