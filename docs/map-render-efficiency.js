// A reversible, version-checked in-memory patch for the packaged Scratch map.
// The shipped project/runtime stay byte-for-byte intact. Only the map's paint
// branch is scheduled; reception, camera calculations, audio and other scripts
// continue at the user's original VM rate.
const installed = new WeakMap();
const PREFIX = 'eew/cpu/';
const BG_PROC = 'EEW CPU static background';
const IDS = {
  enabled: `${PREFIX}enabled`, last: `${PREFIX}last`, interval: `${PREFIX}interval`,
  dirty: 'k8(E0n%2Po))#zm$PT5N',
};
const MAIN_HAT = 'dC(';
const BACKGROUND_STAMPS = ['bpg', 'dk[', 'dlc', 'dlg', 'dlp', 'dlA'];
const LISTS = {
  camera: ['/[;m=*u~4dVLN3LnqEul', '1カメラ系', 3],
  screen: ['8;}F65,+Ug?ETb7A:5TJ', '3画面設定系', 6],
  info: ['b3GDYQs4T:0syQ,wApn}', '3-1設定系からの情報', 3],
  settings: ['|-$]i?VXM:wz}RW[R0@W', '7システム設定', 66],
};

const input = block => ({name: '', block, shadow: null});
function block(id, opcode, inputs = {}, fields = {}, extra = {}) {
  return {id, opcode, next: null, parent: null, inputs: Object.fromEntries(
    Object.entries(inputs).map(([name, id]) => [name, {...input(id), name}])), fields, shadow: false, topLevel: false, ...extra};
}
function field(name, value, id) {return {[name]: {name, value, ...(id ? {id} : {})}};}

/** Refuse a changed upstream graph rather than guessing about script semantics. */
export function compatibleMap(map, stage) {
  const b = map?.blocks?._blocks;
  if (!map?.isOriginal || !b || stage?.variables?.[IDS.dirty]?.name !== '描画更新-変更') return false;
  if (!Object.values(LISTS).every(([id, name, size]) => {
    const list = stage.variables[id];
    return list?.name === name && Array.isArray(list.value) && list.value.length >= size;
  })) return false;
  const expected = {
    'dC(': ['event_whenbroadcastreceived', ']C'], bFk: ['control_forever', null],
    sR: ['control_if', 'bFy'], 'c{': ['pen_clear', 'T'],
    'bn!': ['procedures_definition', 'pY'], pY: ['control_if', 'bn#'],
    'bn#': ['looks_cleargraphiceffects', 'ct'], ct: ['control_if_else', 'cu'],
    cu: ['control_if_else', 'bpr'], bpr: ['motion_pointindirection', 'bpJ'],
    bpJ: ['procedures_call', 'bpK'],
  };
  if (!Object.entries(expected).every(([id, [opcode, next]]) => b[id]?.opcode === opcode && b[id].next === next)) return false;
  return b.sR.inputs?.CONDITION?.block === ']Q' && b.sR.inputs?.SUBSTACK?.block === 'i' &&
    b.dkf?.mutation?.proccode === '下地地図描画' && String(b.dkf.mutation.warp) === 'true' &&
    b.bpJ.mutation?.proccode === '津波エリア描画' && BACKGROUND_STAMPS.every(id => b[id]?.opcode === 'pen_stamp');
}

/** Move a pure drawing span into its own warp procedure, preserving all bodies. */
export function patchMapGraph(map, stage, {fps = 15} = {}) {
  if (!Number.isFinite(fps) || fps <= 0 || fps > 60 || !compatibleMap(map, stage)) return null;
  if (typeof map.createVariable !== 'function' || !['createBlock', 'resetCache'].every(name => typeof map.blocks[name] === 'function')) return null;
  const blocks = map.blocks, b = blocks._blocks;
  if (Object.keys(b).some(id => id.startsWith(PREFIX)) || Object.values(IDS).some(id => map.variables?.[id])) return null;
  const originals = new Map();
  const keep = id => {if (!originals.has(id)) originals.set(id, structuredClone(b[id])); return b[id];};
  const added = [];
  const add = value => {added.push(value.id); blocks.createBlock(value); return value.id;};
  const make = (name, opcode, inputs, fields, extra) => add(block(PREFIX + name, opcode, inputs, fields, extra));
  const number = (name, value) => make(name, 'math_number', {}, field('NUM', String(value)), {shadow: true});
  const variable = (name, id) => make(name, 'data_variable', {}, field('VARIABLE', map.variables[id].name, id));
  for (const [id, name, value] of [[IDS.enabled, 'EEW CPU paint enabled', 1], [IDS.last, 'EEW CPU last paint', 0], [IDS.interval, 'EEW CPU paint interval', 1000 / fps / 86400000]]) {
    map.createVariable(id, name, ''); map.variables[id].value = value;
  }
  // dayssince2000 is independent of Scratch's resettable timer. A backward
  // system-clock change also permits the next frame instead of freezing it.
  const now = () => make(`now${added.length}`, 'sensing_dayssince2000');
  const delta = name => make(name, 'operator_subtract', {NUM1: now(), NUM2: variable(`${name}last`, IDS.last)});
  const early = make('early', 'operator_lt', {OPERAND1: delta('delta'), OPERAND2: variable('interval', IDS.interval)});
  const due = make('due', 'operator_not', {OPERAND: early});
  const backwards = make('backwards', 'operator_lt', {OPERAND1: delta('negativeDelta'), OPERAND2: number('zeroTime', 0)});
  const timeGate = make('timeGate', 'operator_or', {OPERAND1: due, OPERAND2: backwards});
  const disabled = make('disabled', 'operator_equals', {OPERAND1: variable('enabled', IDS.enabled), OPERAND2: number('zero', 0)});
  const gate = make('gate', 'operator_or', {OPERAND1: disabled, OPERAND2: timeGate});
  // Always paint the dynamic layers at this cadence, even when no dirty bit is
  // raised: the upstream clock, P/S waves and tsunami flashes need a heartbeat.
  keep('sR').inputs.CONDITION = {...b.sR.inputs.CONDITION, block: gate};
  const consumeValue = make('consumeValue', 'operator_subtract', {NUM1: number('one', 1), NUM2: variable('consumeEnabled', IDS.enabled)});
  const consume = make('consume', 'data_setvariableto', {VALUE: consumeValue}, field('VARIABLE', stage.variables[IDS.dirty].name, IDS.dirty), {next: PREFIX + 'recordTime', parent: 'sR'});
  const remainder = make('remainder', 'operator_mod', {NUM1: delta('phaseDelta'), NUM2: variable('phaseInterval', IDS.interval)});
  const phase = make('phase', 'operator_subtract', {NUM1: now(), NUM2: remainder});
  const record = make('recordTime', 'data_setvariableto', {VALUE: phase}, field('VARIABLE', map.variables[IDS.last].name, IDS.last), {next: 'i', parent: consume});
  keep('sR').inputs.SUBSTACK = {...b.sR.inputs.SUBSTACK, block: consume};
  keep('i').parent = record;
  const mutation = {tagName: 'mutation', children: [], proccode: BG_PROC, argumentids: '[]', argumentnames: '[]', argumentdefaults: '[]', warp: 'true'};
  const definition = make('bgDefinition', 'procedures_definition', {custom_block: PREFIX + 'bgPrototype'}, {}, {topLevel: true, next: 'bn#'});
  make('bgPrototype', 'procedures_prototype', {}, {}, {parent: definition, shadow: true, mutation});
  const call = make('bgCall', 'procedures_call', {}, {}, {parent: 'pY', next: 'bpJ', mutation: {...mutation}});
  keep('pY').next = call; keep('bn#').parent = definition; keep('bpr').next = null; keep('bpJ').parent = call;
  // Set parents for every newly added input, as the normal SB3 loader does.
  for (const id of added) for (const value of Object.values(b[id].inputs)) if (b[value.block]) b[value.block].parent = id;
  blocks.resetCache();
  return {enabled: map.variables[IDS.enabled], added, originals, restoreBeforeRun({keepVariables = false} = {}) {
    for (const [id, value] of originals) b[id] = value;
    for (const id of added) delete b[id];
    if (Array.isArray(blocks._scripts)) blocks._scripts = blocks._scripts.filter(id => !added.includes(id));
    if (!keepVariables) for (const id of [IDS.enabled, IDS.last, IDS.interval]) delete map.variables[id];
    blocks.resetCache();
  }};
}

export function installMapRenderEfficiency(vm, {fps = 15, now = () => performance.now()} = {}) {
  const runtime = vm?.runtime, renderer = runtime?.renderer ?? vm?.renderer;
  if (!runtime?.on || !renderer || !Number.isFinite(fps) || fps <= 0 || fps > 60) return null;
  if (!['penClear', 'penStamp', 'penPoint', 'penLine', 'draw', 'createPenSkin', 'createDrawable', 'updateDrawableSkinId', 'setDrawableOrder', 'destroyDrawable', 'destroySkin'].every(name => typeof renderer[name] === 'function')) return null;
  if (installed.has(runtime)) return installed.get(runtime);
  let map, stage, graph, staticSkin = null, staticDrawable = null, originalPenSkin = null;
  let background = null, cachedKey = null, cacheValid = false, enabled = true, finalPhase = false, lastDraw = -Infinity;
  let disposed = false, contextLost = false, fallback = false;
  const wrapped = new WeakSet();
  const stats = {mapFrames: 0, staticBuilds: 0, staticCacheHits: 0, staticStamps: 0, staticStampsSkipped: 0, finalDraws: 0, finalDrawsSkipped: 0, fallbacks: 0};
  const original = Object.fromEntries(['penClear', 'penStamp', 'penPoint', 'penLine', 'draw', 'skinWasAltered'].map(name => [name, renderer[name]]));
  const backgroundSkinIds = new Set();
  const live = () => enabled && graph && graph.enabled.value !== 0 && !disposed;
  const main = () => {const t = runtime.sequencer?.activeThread; return t?.target === map && t.topBlock === MAIN_HAT;};
  const invalidate = () => {cacheValid = false; cachedKey = null;};
  const clearStatic = () => {if (staticSkin !== null) original.penClear.call(renderer, staticSkin); invalidate();};
  function destroyStatic() {
    if (staticDrawable !== null) renderer.destroyDrawable(staticDrawable, 'pen');
    if (staticSkin !== null) renderer.destroySkin(staticSkin);
    staticDrawable = staticSkin = null; invalidate();
  }
  function ensureStatic(penSkin) {
    originalPenSkin = penSkin;
    if (staticSkin === null) {
      const saved = renderer._penSkinId;
      try {staticSkin = renderer.createPenSkin();} finally {renderer._penSkinId = saved;}
      staticDrawable = renderer.createDrawable('pen');
      renderer.updateDrawableSkinId(staticDrawable, staticSkin);
      renderer.setDrawableOrder(staticDrawable, -Infinity, 'pen');
    }
    const source = renderer._allSkins?.[penSkin], cache = renderer._allSkins?.[staticSkin];
    if (source && cache && source.renderQuality !== cache.renderQuality) {
      cache.setRenderQuality(source.renderQuality); clearStatic();
      if (background) background.reuse = false;
    }
  }
  const list = name => stage.variables[LISTS[name][0]].value;
  function backgroundKey() {
    for (const costume of map.sprite?.costumes ?? []) if (/^(allocean|100l|wld[01][0-2]|outsvg[01][01]|wlg[01][01])$/.test(costume.name)) backgroundSkinIds.add(costume.skinId);
    return JSON.stringify([
      list('camera').slice(0, 3), list('screen'), list('info'), list('settings').slice(64, 66),
      renderer.getNativeSize?.(), renderer.canvas?.width, renderer.canvas?.height, renderer.useHighQualityRender,
      (map.sprite?.costumes ?? []).map(c => c.skinId),
    ]);
  }
  function fail() {fallback = true; background = null; stats.fallbacks++; invalidate();}
  function wrapBackgrounds() {
    if (!graph || disposed) return;
    for (const thread of runtime.threads ?? []) {
      if (thread.target !== map || !thread.isCompiled || !thread.procedures) continue;
      for (const [key, fn] of Object.entries(thread.procedures)) {
        if (!key.includes(BG_PROC) || typeof fn !== 'function' || wrapped.has(fn) || fn.constructor?.name === 'GeneratorFunction') continue;
        const replacement = function (...args) {
          if (!live() || fallback || contextLost || !main()) return fn.apply(this, args);
          let state;
          try {
            const key = backgroundKey();
            state = {key, reuse: cacheValid && cachedKey === key, stamps: 0};
            if (!state.reuse && staticSkin !== null) clearStatic();
            background = state;
            const value = fn.apply(this, args);
            if (value?.next) {fail(); return value;}
            if (state.stamps) {
              if (state.reuse) stats.staticCacheHits++; else stats.staticBuilds++;
              cachedKey = key; cacheValid = true;
            } else clearStatic();
            return value;
          } finally {background = null;}
        };
        wrapped.add(replacement); thread.procedures[key] = replacement;
      }
    }
  }
  function penClear(id, ...args) {
    if (main()) {
      stats.mapFrames++;
      if (!live() || fallback) {if (staticSkin !== null) destroyStatic();}
    } else if (id === originalPenSkin || staticSkin !== null && id !== staticSkin) clearStatic();
    return original.penClear.call(this, id, ...args);
  }
  const paints = {};
  for (const name of ['penStamp', 'penPoint', 'penLine']) paints[name] = function(id, ...args) {
    if (!background || !live() || fallback || contextLost) return original[name].call(this, id, ...args);
    try {
      ensureStatic(id); background.stamps++;
      if (background.reuse) {stats.staticStampsSkipped++; return;}
      stats.staticStamps++;
      return original[name].call(this, staticSkin, ...args);
    } catch {fail(); return original[name].call(this, id, ...args);}
  };
  function draw(...args) {
    // Only the runtime's final presentation is capped. Extraction/sensing and
    // explicit renderer calls retain the original synchronous behavior.
    const final = finalPhase; finalPhase = false;
    if (final && live()) {
      const time = now();
      if (time + .2 < lastDraw) {stats.finalDrawsSkipped++; return;}
      const period = 1000 / fps;
      if (!Number.isFinite(lastDraw) || time < lastDraw - period) lastDraw = time;
      lastDraw += (Math.floor(Math.max(0, time - lastDraw) / period) + 1) * period;
      if (this.dirty) stats.finalDraws++;
    }
    return original.draw.apply(this, args);
  }
  const before = () => {finalPhase = false; wrapBackgrounds();};
  const after = () => {finalPhase = true;};
  function load() {
    if (disposed) return;
    if (staticSkin !== null) destroyStatic();
    map = runtime.targets?.find(t => t.isOriginal && t.getName?.() === '地図'); stage = runtime.getTargetForStage?.();
    // A running compiled graph cannot be safely replaced without restarting its
    // scripts. Only install during PROJECT_LOADED, before greenFlag compiles.
    if (runtime.threads?.some(t => t.target === map)) return;
    graph = patchMapGraph(map, stage, {fps});
    if (graph) {graph.enabled.value = enabled ? 1 : 0; fallback = false; invalidate();}
  }
  const lost = () => {contextLost = true; invalidate();};
  const restored = () => {contextLost = false; fallback = true; invalidate();};
  const stopped = () => {clearStatic();};
  function skinWasAltered(skin, ...args) {
    // SVG content can finish loading or change while retaining the same skin ID.
    if (backgroundSkinIds.has(skin?.id)) invalidate();
    return original.skinWasAltered.call(this, skin, ...args);
  }
  renderer.penClear = penClear;
  for (const [name, fn] of Object.entries(paints)) renderer[name] = fn;
  renderer.draw = draw;
  if (typeof original.skinWasAltered === 'function') renderer.skinWasAltered = skinWasAltered;
  runtime.on('PROJECT_LOADED', load); runtime.on('BEFORE_EXECUTE', before); runtime.on('AFTER_EXECUTE', after); runtime.on('PROJECT_STOP_ALL', stopped);
  renderer.canvas?.addEventListener('webglcontextlost', lost); renderer.canvas?.addEventListener('webglcontextrestored', restored);
  const result = {stats, get active() {return Boolean(live());}, get cacheActive() {return cacheValid && !fallback;}, invalidate,
    setEnabled(value) {enabled = Boolean(value); if (graph) graph.enabled.value = enabled ? 1 : 0; invalidate(); lastDraw = -Infinity;},
    dispose() {
      if (disposed) return;
      result.setEnabled(false); disposed = true;
      runtime.removeListener('PROJECT_LOADED', load); runtime.removeListener('BEFORE_EXECUTE', before); runtime.removeListener('AFTER_EXECUTE', after); runtime.removeListener('PROJECT_STOP_ALL', stopped);
      renderer.canvas?.removeEventListener('webglcontextlost', lost); renderer.canvas?.removeEventListener('webglcontextrestored', restored);
      // The added gate reads enabled=0 even in already compiled scripts, so
      // disabling never restarts reception, resets timers or clears user data.
      destroyStatic();
      if (renderer.penClear === penClear) renderer.penClear = original.penClear;
      for (const [name, fn] of Object.entries(paints)) if (renderer[name] === fn) renderer[name] = original[name];
      if (renderer.draw === draw) renderer.draw = original.draw;
      if (renderer.skinWasAltered === skinWasAltered) renderer.skinWasAltered = original.skinWasAltered;
      // Already compiled closures retain their disabled gate variables until
      // they finish. Restore the original graph for all future scripts now.
      if (graph) graph.restoreBeforeRun({keepVariables: Boolean(runtime.threads?.some(t => t.target === map))});
      installed.delete(runtime);
    }};
  installed.set(runtime, result);
  if (runtime.targets?.length && !runtime.threads?.length) load();
  return result;
}

export const getMapRenderEfficiency = vm => installed.get(vm?.runtime) ?? null;
