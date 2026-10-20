import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {startWatermark} from '../docs/watermark.js';

const cloneId = 'ptlHBkTqRuo)f7tkgB7t';
function versionClone({visible = true, name = 'UI', type = 'ver', original = false} = {}) {
  return {
    sprite: {name}, isOriginal: original, visible, writes: [],
    variables: {[cloneId]: {name: '@3 クローン', value: [type]}},
    setVisible(value) { this.visible = value; this.writes.push(value); },
  };
}

function setup() {
  const saved = new Map(['document', 'window', 'vm', 'scaffolding'].map(key => [key, globalThis[key]]));
  class FakeImage extends EventTarget {
    constructor() { super(); this.style = {}; this.naturalWidth = 0; this.complete = false; }
    remove() { page.body.children.splice(page.body.children.indexOf(this), 1); }
    load() { this.naturalWidth = 240; this.complete = true; this.dispatchEvent(new Event('load')); }
    fail() { this.naturalWidth = 0; this.dispatchEvent(new Event('error')); }
  }
  const page = new EventTarget();
  const loading = {hidden: true};
  page.hidden = false;
  page.body = {children: [], append(node) { this.children.push(node); }};
  page.createElement = () => new FakeImage();
  page.getElementById = id => id === 'loading' ? loading : null;
  const browser = new EventTarget();
  browser.innerWidth = 1000;
  browser.innerHeight = 800;
  const timers = new Map();
  let nextTimer = 0;
  browser.setInterval = callback => { timers.set(++nextTimer, callback); return nextTimer; };
  browser.clearInterval = id => timers.delete(id);
  browser.tick = () => { for (const callback of timers.values()) callback(); };
  const stage = {
    isStage: true,
    variables: {
      '/[;m=*u~4dVLN3LnqEul': {value: [16, 41, 1.8]},
      '8;}F65,+Ug?ETb7A:5TJ': {value: [60, 0, 180, 180, 15, 1]},
    },
  };
  const version = versionClone();
  const runtime = new EventEmitter();
  Object.assign(runtime, {stageWidth: 480, stageHeight: 360, targets: [stage, version]});
  const vm = {runtime};
  const canvasRect = {left: 25, top: 40, width: 480, height: 360};
  const scaffolding = {_canvas: {getBoundingClientRect: () => canvasRect}};
  Object.assign(globalThis, {document: page, window: browser, vm, scaffolding});
  let controller;
  return {
    page, browser, loading, stage, version, runtime, vm, canvasRect, scaffolding,
    start() { controller = startWatermark(); return {controller, image: page.body.children[0]}; },
    cleanup() {
      controller?.stop();
      for (const [key, value] of saved) {
        if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
      }
    },
  };
}

test('uses the original version width and corner, hiding it only after a successful image load', () => {
  const s = setup();
  try {
    const {controller, image} = s.start();
    assert.equal(startWatermark(), controller);
    assert.equal(image.hidden, true);
    assert.equal(s.version.visible, true);
    image.load();
    assert.equal(image.className, 'eew-watermark');
    assert.equal(image.style.width, '41.494px');
    assert.ok(Math.abs(parseFloat(image.style.right) - 495.339149) < 1e-8);
    assert.equal(image.style.bottom, '400px');
    assert.equal(image.style.opacity, '.85');
    assert.equal(image.style.pointerEvents, 'none');
    assert.match(image.alt, /VR災害情報センター/);
    assert.match(image.title, /v1\.6\.3\+5/);
    assert.equal(image.hidden, false);
    assert.equal(s.version.visible, false);
    s.browser.tick();
    assert.deepEqual(s.version.writes, [false]);
    s.stage.variables['8;}F65,+Ug?ETb7A:5TJ'].value[5] = 2;
    s.browser.tick();
    assert.equal(image.style.width, '82.988px');
    controller.stop();
    assert.equal(s.version.visible, true);
    assert.equal(s.page.body.children.length, 0);
    assert.equal(s.runtime.listenerCount('PROJECT_LOADED'), 0);
  } finally { s.cleanup(); }
});

test('image errors and loading transitions restore the existing version as fallback', () => {
  const s = setup();
  try {
    const {image} = s.start();
    image.fail();
    assert.equal(s.version.visible, true);
    image.load();
    assert.equal(s.version.visible, false);
    image.fail();
    assert.equal(image.hidden, true);
    assert.equal(s.version.visible, true);
    image.load();
    s.loading.hidden = false;
    s.browser.tick();
    assert.equal(image.hidden, true);
    assert.equal(s.version.visible, true);
    s.loading.hidden = true;
    s.browser.tick();
    assert.equal(image.hidden, false);
    assert.equal(s.version.visible, false);
  } finally { s.cleanup(); }
});

test('identifies only UI version clones and follows project and runtime replacements', () => {
  const s = setup();
  try {
    const others = [versionClone({name: '地図'}), versionClone({type: 'htv'}), versionClone({original: true})];
    s.runtime.targets.push(...others);
    const {image} = s.start();
    image.load();
    for (const target of others) assert.equal(target.visible, true);
    const replacement = versionClone();
    s.runtime.targets[1] = replacement; // Same array and length; cached target differs.
    s.browser.tick();
    assert.equal(replacement.visible, false);
    const nextRuntime = new EventEmitter();
    const nextVersion = versionClone();
    Object.assign(nextRuntime, {stageWidth: 480, stageHeight: 360, targets: [s.stage, nextVersion]});
    globalThis.vm = {runtime: nextRuntime};
    s.browser.tick();
    assert.equal(replacement.visible, true);
    assert.equal(nextVersion.visible, false);
    assert.equal(s.runtime.listenerCount('PROJECT_LOADED'), 0);
  } finally { s.cleanup(); }
});

test('waits for a late VM and never reveals a version that was already hidden', () => {
  const s = setup();
  try {
    delete globalThis.vm;
    const {image, controller} = s.start();
    image.load();
    assert.equal(image.hidden, true);
    s.version.visible = false;
    globalThis.vm = s.vm;
    s.browser.tick();
    assert.equal(image.hidden, false);
    controller.stop();
    assert.equal(s.version.visible, false);
    assert.deepEqual(s.version.writes, []);
  } finally { s.cleanup(); }
});

test('does not repeatedly scan clones during steady operation', () => {
  const s = setup();
  try {
    s.runtime.targets.push(...Array.from({length: 1000}, () => versionClone({type: 'other'})));
    let cloneReads = 0;
    s.runtime.targets = new Proxy(s.runtime.targets, {
      get(target, key, receiver) {
        if (/^\d+$/.test(String(key)) && Number(key) > 1) cloneReads++;
        return Reflect.get(target, key, receiver);
      },
    });
    const {image} = s.start();
    image.load();
    assert.ok(cloneReads > 0);
    cloneReads = 0;
    for (let i = 0; i < 100; i++) s.browser.tick();
    assert.equal(cloneReads, 0);
    s.runtime.emit('PROJECT_LOADED');
    s.browser.tick();
    assert.ok(cloneReads > 0);
  } finally { s.cleanup(); }
});
