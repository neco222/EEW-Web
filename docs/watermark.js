import {readView} from './viewer-bridge.js';

const CLONE_LIST_ID = 'ptlHBkTqRuo)f7tkgB7t';
const VERSION = 'v1.6.3+5';
const VERSION_WIDTH = 41.494;
const VERSION_RIGHT_INSET = 0.339149;
let active;

function isVersionClone(target) {
  if (target?.isStage || target?.isOriginal !== false || target.sprite?.name !== 'UI') return false;
  const variables = target.variables;
  const clone = variables?.[CLONE_LIST_ID] ??
    Object.values(variables ?? {}).find(value => value.name === '@3 クローン');
  return clone?.value?.[0] === 'ver' && typeof target.setVisible === 'function';
}

/** Place the logo over the original version label, keeping the label as fallback. */
export function startWatermark() {
  if (active) return active;
  if (typeof document === 'undefined') return {stop() {}};
  const page = document;
  const browser = globalThis.window ?? globalThis;
  const image = page.createElement('img');
  image.className = 'eew-watermark';
  image.alt = `VR災害情報センター · リアルタイム地震ビューアー ${VERSION}`;
  image.title = image.alt;
  image.decoding = 'async';
  image.draggable = false;
  image.hidden = true;
  image.style.opacity = '.85';
  image.style.position = 'fixed';
  image.style.zIndex = '13';
  image.style.userSelect = 'none';
  image.style.pointerEvents = 'none';
  image.style.height = 'auto';
  image.style.maxWidth = 'none';

  let stopped = false;
  let loaded = false;
  let runtime;
  let targets;
  let targetCount = -1;
  let stage;
  let scanNeeded = true;
  let candidates = [];
  const hidden = new Map();
  const runtimeEvents = ['targetWasCreated', 'targetWasRemoved', 'PROJECT_LOADED'];
  const invalidate = () => { scanNeeded = true; };

  function restore(target) {
    const record = hidden.get(target);
    if (!record) return;
    // A removed/disposed target no longer needs restoration. This membership
    // lookup happens only on transitions or stop, never in the rendering loop.
    if (record.runtime.targets?.includes(target) && target.visible === false) {
      target.setVisible(record.visible);
    }
    hidden.delete(target);
  }

  function restoreAll() {
    for (const target of hidden.keys()) restore(target);
  }

  function detachRuntime() {
    if (!runtime) return;
    const remove = runtime.off ?? runtime.removeListener;
    if (typeof remove === 'function') {
      for (const event of runtimeEvents) remove.call(runtime, event, invalidate);
    }
  }

  function bindRuntime(next) {
    if (runtime === next) return;
    restoreAll();
    detachRuntime();
    runtime = next;
    targets = undefined;
    targetCount = -1;
    stage = undefined;
    candidates = [];
    scanNeeded = true;
    if (typeof runtime?.on === 'function') {
      for (const event of runtimeEvents) runtime.on(event, invalidate);
    }
  }

  function findCandidates() {
    const current = runtime?.targets;
    if (!Array.isArray(current)) return;
    if (current !== targets || current.length !== targetCount || current[0] !== stage ||
        candidates.some(({target, index}) => current[index] !== target || !isVersionClone(target))) {
      scanNeeded = true;
    }
    if (!scanNeeded) return;
    const next = [];
    for (let index = 0; index < current.length; index++) {
      if (isVersionClone(current[index])) next.push({target: current[index], index});
    }
    const retained = new Set(next.map(({target}) => target));
    for (const target of hidden.keys()) if (!retained.has(target)) restore(target);
    candidates = next;
    targets = current;
    targetCount = current.length;
    stage = current[0];
    scanNeeded = false;
  }

  const setStyle = (name, value) => {
    if (image.style[name] !== value) image.style[name] = value;
  };

  function update() {
    if (stopped || page.hidden) return;
    const vm = globalThis.vm;
    bindRuntime(vm?.runtime);
    const view = readView(vm, globalThis.scaffolding);
    const loading = page.getElementById('loading');
    if (!loaded || !view || (loading && !loading.hidden)) {
      image.hidden = true;
      restoreAll();
      return;
    }

    const scaleX = view.width / view.stage.width;
    setStyle('width', `${VERSION_WIDTH * view.layout.uiScale * scaleX}px`);
    setStyle('right', `${browser.innerWidth - view.canvasRect.right +
      Math.min(1, VERSION_RIGHT_INSET * view.layout.uiScale * scaleX)}px`);
    setStyle('bottom', `${browser.innerHeight - view.canvasRect.bottom}px`);
    image.hidden = false;

    findCandidates();
    for (const {target} of candidates) {
      if (target.visible === false) continue;
      if (!hidden.has(target)) hidden.set(target, {runtime, visible: target.visible});
      target.setVisible(false);
    }
  }

  function onLoad() {
    if (stopped) return;
    loaded = image.naturalWidth > 0;
    scanNeeded = true;
    update();
  }

  function onError() {
    loaded = false;
    image.hidden = true;
    restoreAll();
  }

  image.addEventListener('load', onLoad);
  image.addEventListener('error', onError);
  browser.addEventListener('resize', update);
  page.addEventListener('visibilitychange', update);
  page.body.append(image);
  image.src = './images/vr-disaster-watermark.webp';
  // The version label is fixed in a corner; a low-frequency layout check plus
  // resize/visibility events follows UI-scale changes without another 60 fps loop.
  const timer = browser.setInterval(update, 200);
  active = {
    stop() {
      if (stopped) return;
      stopped = true;
      browser.clearInterval(timer);
      browser.removeEventListener('resize', update);
      page.removeEventListener('visibilitychange', update);
      image.removeEventListener('load', onLoad);
      image.removeEventListener('error', onError);
      restoreAll();
      detachRuntime();
      image.remove();
      active = undefined;
    },
  };
  if (image.complete && image.naturalWidth > 0) onLoad();
  else update();
  return active;
}
