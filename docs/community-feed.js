import { parseP2PTime } from './community-core.js';

export const COMMUNITY_WEBSOCKET_URL = 'wss://api.p2pquake.net/v2/ws';
const API_BASE = 'https://api.p2pquake.net/v2/history';
const CHANNEL = 'eewgit-community-feed-v1';
const REQUEST_TIMEOUT_MS = 10000;
const MAX_RECENT_MESSAGES = 1000;
let nextClientId = 0;

function abortable(work, signal) {
  return new Promise((resolve, reject) => {
    const aborted = () => {
      const error = new Error('Request aborted');
      error.name = 'AbortError';
      reject(error);
    };
    if (signal.aborted) { aborted(); return; }
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(work).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

/**
 * P2P JSON API v2 transport. It never contacts the original viewer's server.
 * https://www.p2pquake.net/develop/json_api_v2/
 *
 * start()/stop() return this and are idempotent. refresh() resolves to a store
 * snapshot; transport failures are reported through onStatus, not rejections.
 * One refresh batch contains two requests (9611:30, 561:100). Concurrent calls
 * share its Promise and never replace an existing WebSocket.
 * onLive(snapshot, { previous, message, receivedAt }) runs only for accepted
 * live 561/9611 messages, including live delivery from a leader tab. previous
 * is captured immediately before ingestion with expired reports pruned. History,
 * reconnect backfills, cached replays, invalid messages, and duplicates are silent.
 * onHistory(messages) supplies the original history/replay records separately;
 * a log can show their individual reports without replaying a live notification.
 *
 * Where BOTH Web Locks and BroadcastChannel exist, the lock holder owns the
 * socket/history and other tabs receive its reports. A queued lock request is
 * aborted on stop/offline/pagehide; a held lock is released after socket close.
 * Without these APIs, each tab has one connection. Call stop() on disposal.
 * All dependencies are injectable for tests; importing does not open a socket.
 */
export class CommunityFeed {
  #store;
  #onChange;
  #onStatus;
  #onLive;
  #onHistory;
  #fetch;
  #WebSocket;
  #now;
  #random;
  #setTimeout;
  #clearTimeout;
  #eventTarget;
  #navigator;
  #locks;
  #BroadcastChannel;
  #AbortController;
  #id;
  #started = false;
  #running = false;
  #hidden = false;
  #online;
  #epoch = 0;
  #leader = false;
  #sharing = false;
  #channel = null;
  #lockAbort = null;
  #releaseLock = null;
  #socket = null;
  #connectTimer = null;
  #reconnectTimer = null;
  #historyRetryTimer = null;
  #historyTimeout = null;
  #historyAbort = null;
  #refreshPromise = null;
  #retryAttempt = 0;
  #historyAttempt = 0;
  #opened = false;
  #historyError = null;
  #lastSync = null;
  #status = null;
  #recent = new Map();
  #handlers;

  constructor(options = {}) {
    const { store, onChange = () => {}, onStatus = () => {}, onLive = () => {}, onHistory = () => {} } = options;
    if (!store || !['ingest', 'ingestHistory', 'snapshot'].every((name) => typeof store[name] === 'function')) {
      throw new TypeError('CommunityFeed requires a CommunityStore');
    }
    this.#store = store;
    this.#onChange = onChange;
    this.#onStatus = onStatus;
    this.#onLive = onLive;
    this.#onHistory = onHistory;
    this.#fetch = options.fetch ?? globalThis.fetch?.bind(globalThis);
    this.#WebSocket = options.WebSocket ?? globalThis.WebSocket;
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
    this.#setTimeout = options.setTimeout ?? globalThis.setTimeout.bind(globalThis);
    this.#clearTimeout = options.clearTimeout ?? globalThis.clearTimeout.bind(globalThis);
    this.#eventTarget = options.eventTarget ?? globalThis.window;
    const nav = options.navigator ?? globalThis.navigator;
    this.#navigator = nav;
    this.#online = nav?.onLine !== false;
    this.#locks = Object.hasOwn(options, 'locks') ? options.locks : nav?.locks;
    this.#BroadcastChannel = Object.hasOwn(options, 'BroadcastChannel') ? options.BroadcastChannel : globalThis.BroadcastChannel;
    this.#AbortController = options.AbortController ?? globalThis.AbortController;
    this.#id = `${this.#now()}-${++nextClientId}-${this.#random()}`;
    this.#handlers = {
      offline: () => { this.#online = false; if (this.#started) { this.#deactivate(); this.#emit('offline', 'オフラインです。接続の復帰を待っています。'); } },
      online: () => { this.#online = true; this.#activate(); },
      pagehide: () => { this.#hidden = true; if (this.#started) { this.#deactivate(); this.#emit('stopped', 'ページを一時停止しています。'); } },
      pageshow: () => { this.#hidden = false; this.#online = this.#navigator?.onLine !== false; this.#activate(); },
    };
  }

  start() {
    if (this.#started) return this;
    this.#started = true;
    this.#online = this.#navigator?.onLine !== false;
    for (const [event, handler] of Object.entries(this.#handlers)) this.#eventTarget?.addEventListener(event, handler);
    this.#change();
    this.#activate();
    return this;
  }

  stop() {
    if (!this.#started) return this;
    this.#started = false;
    for (const [event, handler] of Object.entries(this.#handlers)) this.#eventTarget?.removeEventListener(event, handler);
    this.#deactivate();
    this.#emit('stopped', '接続を停止しました。');
    return this;
  }

  refresh() {
    if (!this.#started || !this.#running) return Promise.resolve(this.#store.snapshot());
    if (this.#sharing && !this.#leader) {
      this.#post({ type: 'refresh' });
      this.#post({ type: 'hello' });
      return Promise.resolve(this.#store.snapshot());
    }
    return this.#requestHistory(this.#epoch);
  }

  #current(epoch) { return this.#started && this.#running && epoch === this.#epoch; }

  #activate() {
    if (!this.#started || this.#running || this.#hidden) return;
    if (!this.#online) { this.#emit('offline', 'オフラインです。接続の復帰を待っています。'); return; }
    this.#running = true;
    const epoch = ++this.#epoch;
    this.#retryAttempt = 0;
    this.#historyAttempt = 0;
    this.#opened = false;
    this.#historyError = null;
    this.#sharing = !!(this.#locks?.request && this.#BroadcastChannel);
    if (!this.#sharing) { this.#leader = true; this.#beginNetwork(epoch); return; }
    try {
      this.#channel = new this.#BroadcastChannel(CHANNEL);
      this.#channel.onmessage = (event) => this.#receive(event.data, epoch);
      this.#lockAbort = new this.#AbortController();
      this.#emit('shared', '他のタブとの接続を確認しています。');
      this.#post({ type: 'hello' });
      const request = this.#locks.request(CHANNEL, { signal: this.#lockAbort.signal }, async () => {
        if (!this.#current(epoch)) return;
        this.#leader = true;
        // Establish the release callback before any user callback can stop us.
        const held = new Promise((resolve) => { this.#releaseLock = resolve; });
        this.#beginNetwork(epoch);
        await held;
      });
      Promise.resolve(request).catch((error) => {
        if (this.#current(epoch) && error?.name !== 'AbortError') this.#directFallback(epoch);
      });
    } catch {
      this.#directFallback(epoch);
    }
  }

  #directFallback(epoch) {
    if (!this.#current(epoch)) return;
    this.#lockAbort?.abort();
    this.#releaseLock?.();
    this.#releaseLock = null;
    this.#channel?.close();
    this.#channel = null;
    this.#sharing = false;
    this.#leader = true;
    this.#beginNetwork(epoch);
  }

  #deactivate() {
    this.#running = false;
    this.#epoch++;
    this.#clearTimer('reconnect');
    this.#clearTimer('historyRetry');
    this.#clearTimer('historyTimeout');
    this.#historyAbort?.abort();
    this.#historyAbort = null;
    this.#refreshPromise = null;
    this.#closeSocket();
    this.#leader = false;
    this.#lockAbort?.abort();
    this.#lockAbort = null;
    this.#releaseLock?.();
    this.#releaseLock = null;
    this.#channel?.close();
    this.#channel = null;
    this.#sharing = false;
  }

  #beginNetwork(epoch) {
    if (!this.#current(epoch) || !this.#leader) return;
    this.#connect(epoch);
    this.#requestHistory(epoch);
  }

  #clearTimer(name) {
    const field = {
      connect: [() => this.#connectTimer, (value) => { this.#connectTimer = value; }],
      reconnect: [() => this.#reconnectTimer, (value) => { this.#reconnectTimer = value; }],
      historyRetry: [() => this.#historyRetryTimer, (value) => { this.#historyRetryTimer = value; }],
      historyTimeout: [() => this.#historyTimeout, (value) => { this.#historyTimeout = value; }],
    }[name];
    if (field[0]() !== null) this.#clearTimeout(field[0]());
    field[1](null);
  }

  #closeSocket() {
    this.#clearTimer('connect');
    const socket = this.#socket;
    this.#socket = null;
    if (!socket) return;
    socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
    if (socket.readyState === 0 || socket.readyState === 1) { try { socket.close(); } catch { /* already closing */ } }
  }

  #connect(epoch) {
    if (!this.#current(epoch) || !this.#leader || this.#socket) return;
    this.#clearTimer('reconnect');
    this.#emit(this.#retryAttempt ? 'reconnecting' : 'connecting', 'コミュニティ投稿の配信に接続しています。');
    if (!this.#current(epoch)) return;
    let socket;
    try { socket = new this.#WebSocket(COMMUNITY_WEBSOCKET_URL); }
    catch { this.#scheduleReconnect(epoch, 'リアルタイム接続を開始できませんでした。'); return; }
    this.#socket = socket;
    const valid = () => this.#current(epoch) && this.#socket === socket;
    socket.onopen = () => {
      if (!valid()) return;
      this.#clearTimer('connect');
      this.#retryAttempt = 0;
      const reconnect = this.#opened;
      this.#opened = true;
      this.#operationalStatus();
      if (reconnect) this.#requestHistory(epoch);
    };
    socket.onmessage = (event) => {
      if (!valid()) return;
      let message;
      try { message = JSON.parse(event.data); }
      catch { this.#emit('error', '受信データを読み取れませんでした。次の更新を待っています。'); return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        this.#emit('error', '受信データの形式が正しくありません。'); return;
      }
      if (message.code !== 561 && message.code !== 9611) {
        if (Number.isInteger(message.code)) this.#operationalStatus();
        return;
      }
      const receivedAt = this.#now();
      this.#ingestLive(message, receivedAt);
      this.#remember([message]);
      this.#lastSync = this.#now();
      this.#post({ type: 'messages', source: 'live', messages: [message], receivedAt });
      this.#change();
      this.#operationalStatus();
    };
    const failed = (message) => {
      if (!valid()) return;
      this.#closeSocket();
      this.#scheduleReconnect(epoch, message);
    };
    socket.onerror = () => failed('リアルタイム接続でエラーが発生しました。');
    socket.onclose = () => failed('リアルタイム接続が切れました。');
    this.#connectTimer = this.#setTimeout(() => failed('リアルタイム接続がタイムアウトしました。'), REQUEST_TIMEOUT_MS);
  }

  #backoff(attempt) {
    return Math.min(30000, Math.round(1000 * 2 ** Math.min(attempt, 5) * (0.8 + this.#random() * 0.4)));
  }

  #scheduleReconnect(epoch, message) {
    if (!this.#current(epoch) || !this.#leader || this.#reconnectTimer !== null) return;
    const delay = this.#backoff(this.#retryAttempt++);
    this.#emit('reconnecting', `${message} 自動で再接続します。`, { retryInMs: delay, nextRetryAt: this.#now() + delay });
    this.#reconnectTimer = this.#setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect(epoch);
    }, delay);
  }

  async #fetchHistory(code, limit, signal) {
    const work = Promise.resolve().then(() => this.#fetch(`${API_BASE}?codes=${code}&limit=${limit}`, {
      signal, cache: 'no-store', credentials: 'omit',
    })).then(async (response) => {
      if (!response.ok) {
        const error = new Error(response.status === 429 ? 'アクセスが集中しています。' : `履歴の取得に失敗しました（HTTP ${response.status}）。`);
        const retry = response.headers?.get?.('retry-after');
        const retryMs = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : Math.max(0, Date.parse(retry) - this.#now()) || 0;
        error.retryAfterMs = Number.isFinite(retryMs) ? Math.min(86400000, retryMs) : 86400000;
        throw error;
      }
      const data = await response.json();
      if (!Array.isArray(data) || data.length > 1000 || data.some((message) => !message || message.code !== code)) {
        throw new Error('履歴データの形式が正しくありません。');
      }
      return data;
    });
    return abortable(work, signal);
  }

  #requestHistory(epoch) {
    if (!this.#current(epoch) || !this.#leader) return Promise.resolve(this.#store.snapshot());
    if (this.#refreshPromise) return this.#refreshPromise;
    this.#clearTimer('historyRetry');
    const controller = new this.#AbortController();
    this.#historyAbort = controller;
    let timedOut = false;
    this.#historyTimeout = this.#setTimeout(() => { timedOut = true; controller.abort(); }, REQUEST_TIMEOUT_MS);
    this.#emit('history', '過去のコミュニティ投稿を取得しています。');
    if (!this.#current(epoch)) return Promise.resolve(this.#store.snapshot());
    const pending = Promise.allSettled([
      this.#fetchHistory(9611, 30, controller.signal), this.#fetchHistory(561, 100, controller.signal),
    ]).then((results) => {
      if (!this.#current(epoch)) return this.#store.snapshot();
      this.#clearTimer('historyTimeout');
      const messages = results.flatMap((entry) => entry.status === 'fulfilled' ? entry.value : []);
      if (messages.length) {
        this.#store.ingestHistory(messages);
        this.#history(messages);
        this.#remember(messages);
        this.#post({ type: 'messages', source: 'history', messages });
      }
      this.#change();
      const failures = results.filter((entry) => entry.status === 'rejected');
      if (failures.length) {
        const delay = Math.max(this.#backoff(this.#historyAttempt++), ...failures.map((entry) => entry.reason?.retryAfterMs || 0));
        this.#historyError = timedOut ? '履歴の取得がタイムアウトしました。' : failures[0].reason?.message || '履歴の取得に失敗しました。';
        this.#emit('error', `${this.#historyError} 自動で再試行します。`, { retryInMs: delay, nextRetryAt: this.#now() + delay });
        this.#historyRetryTimer = this.#setTimeout(() => {
          this.#historyRetryTimer = null;
          this.#requestHistory(epoch);
        }, delay);
      } else {
        this.#historyError = null;
        this.#historyAttempt = 0;
        this.#lastSync = this.#now();
        this.#operationalStatus();
      }
      return this.#store.snapshot();
    }).finally(() => {
      if (this.#refreshPromise === pending) {
        this.#refreshPromise = null;
        this.#historyAbort = null;
      }
    });
    this.#refreshPromise = pending;
    return pending;
  }

  #remember(messages) {
    const cutoff = this.#now() - 10 * 60 * 1000;
    for (const message of messages) {
      if (typeof message?.id !== 'string') continue;
      const at = parseP2PTime(message.updated_at ?? message.time);
      if (at === null || at <= cutoff || at > this.#now() + 5000) continue;
      const key = message.code === 9611 ? `9611:${message.started_at}` : `561:${message.id}`;
      const previous = this.#recent.get(key);
      if (previous) {
        const order = at - parseP2PTime(previous.updated_at ?? previous.time) ||
          parseP2PTime(message.time) - parseP2PTime(previous.time) || message.id.localeCompare(previous.id);
        if (order <= 0) continue;
      }
      this.#recent.delete(key);
      this.#recent.set(key, message);
    }
    for (const [id, message] of this.#recent) {
      if (parseP2PTime(message.updated_at ?? message.time) <= cutoff) this.#recent.delete(id);
    }
    // Keep cumulative snapshots when trimming a busy event's raw-report cache.
    while (this.#recent.size > MAX_RECENT_MESSAGES) {
      const rawKey = [...this.#recent].find(([, message]) => message.code !== 9611)?.[0];
      this.#recent.delete(rawKey ?? this.#recent.keys().next().value);
    }
  }

  #post(message) {
    if (!this.#channel) return;
    try { this.#channel.postMessage({ protocol: CHANNEL, from: this.#id, ...message }); } catch { /* tab is closing */ }
  }

  #receive(message, epoch) {
    if (!this.#current(epoch) || !message || message.protocol !== CHANNEL || message.from === this.#id ||
        message.to && message.to !== this.#id) return;
    if (this.#leader) {
      if (message.type === 'hello') {
        this.#remember([]);
        this.#post({ type: 'replay', source: 'replay', to: message.from, messages: [...this.#recent.values()], status: this.#status });
      } else if (message.type === 'refresh') this.#requestHistory(epoch);
      return;
    }
    if ((message.type === 'messages' || message.type === 'replay') && Array.isArray(message.messages) && message.messages.length <= MAX_RECENT_MESSAGES) {
      if (message.type === 'messages' && message.source === 'live') {
        for (const entry of message.messages) this.#ingestLive(entry, this.#now());
      } else {this.#store.ingestHistory(message.messages);this.#history(message.messages);}
      this.#remember(message.messages);
      this.#change();
    }
    const status = message.type === 'status' ? message.status : message.type === 'replay' ? message.status : null;
    if (status && typeof status.state === 'string') {
      this.#lastSync = status.lastSync ?? this.#lastSync;
      const state = ['error', 'offline', 'stopped'].includes(status.state) ? status.state : 'shared';
      this.#emit(state, state === 'shared' ? '他のタブとコミュニティ投稿の接続を共有しています。' : status.message,
        { upstreamState: status.state, retryInMs: status.retryInMs, nextRetryAt: status.nextRetryAt });
    }
  }

  #operationalStatus() {
    if (this.#historyError) this.#emit('error', `${this.#historyError} 自動で再試行します。`);
    else if (this.#socket?.readyState === 1) this.#emit('live', 'リアルタイム接続中です。');
    else this.#emit(this.#reconnectTimer !== null ? 'reconnecting' : 'connecting', 'リアルタイム接続を待っています。');
  }

  #emit(state, message, extra = {}) {
    this.#status = { state, message, lastSync: this.#lastSync, shared: this.#sharing,
      role: this.#sharing ? this.#leader ? 'leader' : 'follower' : 'direct', ...extra };
    try { this.#onStatus({ ...this.#status }); } catch { /* UI errors must not duplicate the transport */ }
    if (this.#leader) this.#post({ type: 'status', status: this.#status });
  }

  #change() {
    try { this.#onChange(this.#store.snapshot()); } catch { /* UI errors must not interrupt the feed */ }
  }

  #history(messages) {
    try { this.#onHistory(messages); } catch { /* Log rendering cannot stop reception. */ }
  }

  #ingestLive(message, receivedAt) {
    if (!message || message.code !== 561 && message.code !== 9611) return;
    const previous = this.#store.snapshot();
    const accepted = this.#store.ingest(message).accepted;
    if (!accepted) return;
    const snapshot = this.#store.snapshot();
    try { this.#onLive(snapshot, { previous, message, receivedAt }); } catch { /* UI effects must not interrupt the feed */ }
  }
}
