import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveCameraPlayer } from '../docs/camera-player.js';

const CAMERA = { videoId: 'abcdefghijk', label: '港のカメラ' };
const OTHER = { videoId: 'lmnopqrstuv', label: '山のカメラ' };
async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }

class Clock {
  now = 0;
  next = 0;
  timers = new Map();
  setTimeout = (callback, delay) => {
    const id = ++this.next;
    this.timers.set(id, { callback, at: this.now + delay });
    return id;
  };
  clearTimeout = id => this.timers.delete(id);
  async advance(ms) {
    const end = this.now + ms;
    for (;;) {
      const next = [...this.timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      this.now = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
      await flush();
    }
    this.now = end;
    await flush();
  }
}

class Element extends EventTarget {
  children = [];
  parentNode = null;
  style = {};
  attributes = new Map();
  constructor(tagName, document) { super(); this.tagName = tagName; this.ownerDocument = document; }
  appendChild(element) { element.remove(); this.children.push(element); element.parentNode = this; return element; }
  remove() {
    if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
    this.parentNode = null;
  }
  setAttribute(name, value) { this.attributes.set(name, value); }
  fire(name) { this.dispatchEvent(new Event(name)); }
}

function harness({ readyAPI = false, onStatus, onError, previousReady, constructionError = false } = {}) {
  const clock = new Clock(), statuses = [], errors = [], natives = [];
  const window = { location: { origin: 'https://neco222.github.io' } };
  if (previousReady) window.onYouTubeIframeAPIReady = previousReady;
  const document = {
    location: window.location,
    createElement(tag) { return new Element(tag, document); },
    querySelectorAll(tag) { return document.head.children.filter(element => element.tagName === tag); },
  };
  document.head = document.createElement('head');
  const container = document.createElement('div');
  const api = { Player: class {
    calls = [];
    destroyed = 0;
    constructor(frame, { events }) {
      if (constructionError) throw new Error('Cannot create native player');
      this.frame = frame; this.events = events; natives.push(this);
    }
    ready() { this.events.onReady({ target: this }); }
    state(data) { this.events.onStateChange({ target: this, data }); }
    error(data) { this.events.onError({ target: this, data }); }
    blocked() { this.events.onAutoplayBlocked({ target: this }); }
    mute() { this.calls.push('mute'); }
    playVideo() { this.calls.push('play'); if (this.playThrows) throw new Error('Play failed'); }
    getIframe() { return this.frame; }
    destroy() { this.destroyed++; this.frame.remove(); this.state(0); }
  } };
  if (readyAPI) window.YT = api;
  const options = { window, document, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    onStatus(status) { statuses.push(status); onStatus?.(status); },
    onError(status) { errors.push(status); onError?.(status); },
  };
  const player = new LiveCameraPlayer(options);
  const loadAPI = async () => { window.YT = api; window.onYouTubeIframeAPIReady?.(); await flush(); };
  return { clock, statuses, errors, natives, window, document, container, options, player, loadAPI };
}

test('import/construction/play/destroy are inert until a camera is shown', () => {
  const h = harness();
  assert.equal(h.player.play(), h.player);
  assert.equal(h.player.destroy(), h.player);
  assert.equal(h.document.head.children.length, 0);
  assert.equal(h.container.children.length, 0);
  assert.equal(h.clock.timers.size, 0);
  assert.deepEqual(h.statuses, []);
});

test('native-like timers retain their window receiver during loading, playback, and disposal', async () => {
  const h = harness();
  const calls = { set: 0, clear: 0 };
  const player = new LiveCameraPlayer({ ...h.options,
    setTimeout(callback, delay) {
      assert.equal(this, h.window, 'setTimeout must be called on its Window');
      calls.set++;
      return h.clock.setTimeout(callback, delay);
    },
    clearTimeout(id) {
      assert.equal(this, h.window, 'clearTimeout must be called on its Window');
      calls.clear++;
      return h.clock.clearTimeout(id);
    },
  });
  player.show(CAMERA, h.container);
  await h.loadAPI();
  assert.equal(h.natives.length, 1);
  const native = h.natives[0];
  native.ready(); native.state(1);
  assert.deepEqual(h.statuses.at(-1), { state: 'playing' });
  player.play();
  player.destroy();
  assert.equal(native.destroyed, 1);
  assert.equal(h.clock.timers.size, 0);
  assert.equal(h.container.children.length, 0);
  assert.deepEqual(h.errors, []);
  assert.equal(calls.set, 4); // API load, iframe readiness, initial play, manual play.
  assert.ok(calls.clear >= 4);
});

test('creates an identified privacy-enhanced iframe and mutes before starting playback', async () => {
  let previousCalls = 0;
  const previousReady = () => { previousCalls++; throw new Error('Another client failed'); };
  const h = harness({ previousReady });
  assert.equal(h.player.show(CAMERA, h.container), h.player);
  assert.deepEqual(h.statuses, [{ state: 'loading' }]);
  assert.equal(h.document.head.children.length, 1);
  const script = h.document.head.children[0];
  assert.equal(script.src, 'https://www.youtube.com/iframe_api');
  assert.equal(script.async, true);
  const frame = h.container.children[0], url = new URL(frame.src);
  assert.equal(url.origin, 'https://www.youtube-nocookie.com');
  assert.equal(url.pathname, '/embed/abcdefghijk');
  assert.equal(url.searchParams.get('origin'), h.window.location.origin);
  assert.equal(url.searchParams.get('enablejsapi'), '1');
  assert.equal(url.searchParams.get('playsinline'), '1');
  assert.equal(url.searchParams.get('controls'), '1');
  assert.equal(url.searchParams.get('autoplay'), '0');
  assert.equal(url.searchParams.has('mute'), false);
  assert.equal(frame.referrerPolicy, 'strict-origin-when-cross-origin');
  assert.match(frame.attributes.get('allow'), /autoplay/);
  assert.match(frame.attributes.get('allow'), /fullscreen/);
  assert.equal(frame.attributes.has('allowfullscreen'), true);
  assert.equal(frame.title, '港のカメラの映像');
  script.fire('load'); await flush();
  assert.equal(h.natives.length, 0); // Script load alone is not API readiness.
  await h.loadAPI();
  assert.equal(previousCalls, 1);
  assert.equal(h.window.onYouTubeIframeAPIReady, previousReady);
  assert.equal(h.natives.length, 1);
  const native = h.natives[0];
  assert.deepEqual(native.calls, []);
  native.ready();
  assert.deepEqual(native.calls, ['mute', 'play']);
  native.state(1); native.state(1); native.state(2); native.state(0);
  assert.deepEqual(h.statuses.map(status => status.state), ['loading', 'playing', 'paused', 'ended']);
  assert.equal(h.statuses.some(status => status.state === 'live'), false);
  assert.equal(h.clock.timers.size, 0);
  assert.deepEqual(h.errors, []);
  h.player.destroy();
  assert.equal(native.destroyed, 1);
  assert.equal(h.container.children.length, 0);
});

test('a ready API is reused, and blocked autoplay can be retried without another iframe', async () => {
  const h = harness({ readyAPI: true });
  h.player.show(CAMERA, h.container); await flush();
  assert.equal(h.document.head.children.length, 0);
  const native = h.natives[0], frame = h.container.children[0];
  native.ready(); native.blocked();
  assert.deepEqual(h.statuses.at(-1), { state: 'blocked' });
  assert.equal(h.clock.timers.size, 0);
  assert.equal(h.player.play(), h.player);
  assert.equal(h.container.children[0], frame);
  assert.deepEqual(native.calls, ['mute', 'play', 'mute', 'play']);
  native.state(3); native.state(1);
  assert.equal(h.statuses.at(-1).state, 'playing');
  assert.deepEqual(h.errors, []);
  assert.equal(h.clock.timers.size, 0);
  h.player.destroy();
});

test('destroy during API loading removes owned work and ignores late ready callbacks', async () => {
  const previousReady = () => {};
  const h = harness({ previousReady });
  h.player.show(CAMERA, h.container);
  const oldReady = h.window.onYouTubeIframeAPIReady, oldScript = h.document.head.children[0];
  h.player.destroy();
  assert.equal(h.document.head.children.length, 0);
  assert.equal(h.container.children.length, 0);
  assert.equal(h.window.onYouTubeIframeAPIReady, previousReady);
  assert.equal(h.clock.timers.size, 0);
  oldScript.fire('error'); oldReady(); await flush();
  assert.deepEqual(h.errors, []);
  assert.equal(h.natives.length, 0);
  h.player.show(OTHER, h.container);
  assert.equal(h.document.head.children.length, 1);
  assert.notEqual(h.document.head.children[0], oldScript);
  await h.loadAPI();
  assert.equal(h.natives.length, 1);
  assert.equal(new URL(h.natives[0].frame.src).pathname, '/embed/lmnopqrstuv');
  h.player.destroy();
});

test('API timeout reports one local error, cleans up, and permits a new attempt', async () => {
  const h = harness();
  h.player.show(CAMERA, h.container);
  const firstScript = h.document.head.children[0];
  await h.clock.advance(14999);
  assert.deepEqual(h.errors, []);
  await h.clock.advance(1);
  assert.deepEqual(h.errors, [{ state: 'error', code: 'api-timeout' }]);
  assert.equal(h.container.children.length, 0);
  assert.equal(h.document.head.children.length, 0);
  assert.equal(h.clock.timers.size, 0);
  assert.equal('onYouTubeIframeAPIReady' in h.window, false);
  h.player.show(CAMERA, h.container);
  assert.notEqual(h.document.head.children[0], firstScript);
  await h.loadAPI();
  h.natives[0].ready(); h.natives[0].state(1);
  assert.equal(h.statuses.at(-1).state, 'playing');
  assert.equal(h.errors.length, 1);
  h.player.destroy();
});

test('script errors are retriable and unrelated existing scripts are not removed', async () => {
  const h = harness();
  const externalScript = h.document.createElement('script');
  externalScript.src = 'https://www.youtube.com/iframe_api';
  h.document.head.appendChild(externalScript);
  h.player.show(CAMERA, h.container);
  assert.equal(h.document.head.children.length, 1);
  externalScript.fire('error'); await flush();
  assert.deepEqual(h.errors, [{ state: 'error', code: 'api-load' }]);
  assert.equal(h.document.head.children[0], externalScript);
  h.player.show(CAMERA, h.container);
  assert.equal(h.document.head.children.length, 2);
  externalScript.fire('load'); await flush();
  assert.equal(h.natives.length, 0);
  await h.loadAPI();
  assert.equal(h.natives.length, 1);
  h.player.destroy();
  assert.ok(h.document.head.children.includes(externalScript));
});

test('a stalled iframe times out and ignores all subsequent events', async () => {
  const h = harness({ readyAPI: true });
  h.player.show(CAMERA, h.container); await flush();
  const native = h.natives[0];
  await h.clock.advance(15000);
  assert.deepEqual(h.errors, [{ state: 'error', code: 'player-timeout' }]);
  assert.equal(native.destroyed, 1);
  assert.equal(h.container.children.length, 0);
  const statuses = h.statuses.length;
  native.ready(); native.state(1); native.blocked(); native.error(153);
  await h.clock.advance(60000);
  assert.equal(h.statuses.length, statuses);
  assert.equal(h.errors.length, 1);
  assert.equal(h.clock.timers.size, 0);
});

test('an unacknowledged play attempt becomes blocked and remains manually playable', async () => {
  const h = harness({ readyAPI: true });
  h.player.show(CAMERA, h.container); await flush();
  const native = h.natives[0]; native.ready();
  await h.clock.advance(15000);
  assert.deepEqual(h.statuses.at(-1), { state: 'blocked', code: 'autoplay-timeout' });
  assert.deepEqual(h.errors, []);
  h.player.play(); native.state(1);
  await h.clock.advance(15000);
  assert.deepEqual(h.statuses.at(-1), { state: 'playing' });
  assert.equal(h.clock.timers.size, 0);
  h.player.destroy();
});

test('forwards documented YouTube error codes once and destroys the failed player', async () => {
  for (const code of [2, 5, 100, 101, 150, 153]) {
    const h = harness({ readyAPI: true });
    h.player.show(CAMERA, h.container); await flush();
    const native = h.natives[0]; native.ready(); native.error(code);
    native.error(code); native.state(1);
    assert.deepEqual(h.errors, [{ state: 'error', code }]);
    assert.deepEqual(h.statuses.at(-1), { state: 'error', code });
    assert.equal(native.destroyed, 1);
    assert.equal(h.container.children.length, 0);
    assert.equal(h.clock.timers.size, 0);
  }
});

test('switching cameras leaves one player and cannot deliver events from the former one', async () => {
  const h = harness({ readyAPI: true });
  const sentinel = h.document.createElement('p'); h.container.appendChild(sentinel);
  h.player.show(CAMERA, h.container); await flush();
  const first = h.natives[0]; first.ready(); first.state(1);
  h.player.show(OTHER, h.container); await flush();
  assert.equal(first.destroyed, 1);
  assert.equal(h.container.children.length, 2); // The unrelated paragraph remains.
  assert.equal(h.container.children[0], sentinel);
  const count = h.statuses.length;
  first.ready(); first.state(0); first.error(100); first.blocked();
  assert.equal(h.statuses.length, count);
  assert.deepEqual(h.errors, []);
  const second = h.natives[1]; second.ready(); second.state(1);
  h.player.destroy(); h.player.destroy();
  assert.equal(second.destroyed, 1);
  assert.deepEqual(h.container.children, [sentinel]);
  assert.equal(h.clock.timers.size, 0);
});

test('separate adapters in the same page still cannot play two cameras', async () => {
  const h = harness({ readyAPI: true });
  h.player.show(CAMERA, h.container); await flush();
  h.natives[0].ready(); h.natives[0].state(1);
  const otherContainer = h.document.createElement('div');
  const other = new LiveCameraPlayer(h.options);
  other.show(OTHER, otherContainer); await flush();
  assert.equal(h.natives[0].destroyed, 1);
  assert.equal(h.container.children.length, 0);
  assert.equal(otherContainer.children.length, 1);
  assert.equal(h.document.head.children.length, 0);
  other.destroy();
  assert.equal(h.clock.timers.size, 0);
});

test('a loading callback may close immediately without starting network work', async () => {
  let player;
  const h = harness({ onStatus: () => player.destroy() }); player = h.player;
  player.show(CAMERA, h.container); await flush();
  assert.equal(h.container.children.length, 0);
  assert.equal(h.document.head.children.length, 0);
  assert.equal(h.clock.timers.size, 0);
  assert.deepEqual(h.errors, []);
});

test('an error status callback may switch cameras without firing an outdated fallback', async () => {
  let player, container;
  const h = harness({ readyAPI: true, onStatus: status => {
    if (status.state === 'error') player.show(OTHER, container);
  } });
  player = h.player; container = h.container;
  player.show(CAMERA, container); await flush();
  h.natives[0].error(100); await flush();
  assert.equal(h.natives.length, 2);
  assert.deepEqual(h.errors, []);
  assert.equal(h.statuses.at(-1).state, 'loading');
  player.destroy();
});

test('invalid cameras and native constructor/play failures remain local and release timers', async () => {
  const invalid = harness();
  assert.doesNotThrow(() => invalid.player.show({ videoId: 'not/a/video' }, invalid.container));
  assert.deepEqual(invalid.errors, [{ state: 'error', code: 'invalid-camera' }]);
  assert.equal(invalid.container.children.length, 0);
  assert.equal(invalid.document.head.children.length, 0);
  const construction = harness({ readyAPI: true, constructionError: true });
  construction.player.show(CAMERA, construction.container); await flush();
  assert.deepEqual(construction.errors, [{ state: 'error', code: 'player-error' }]);
  assert.equal(construction.clock.timers.size, 0);
  assert.equal(construction.container.children.length, 0);
  const play = harness({ readyAPI: true, onError: () => { throw new Error('UI callback failed'); } });
  play.player.show(CAMERA, play.container); await flush();
  play.natives[0].playThrows = true;
  assert.doesNotThrow(() => play.natives[0].ready());
  assert.deepEqual(play.errors, [{ state: 'error', code: 'player-error' }]);
  assert.equal(play.natives[0].destroyed, 1);
  assert.equal(play.clock.timers.size, 0);
});
