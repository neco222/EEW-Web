import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compatibleMap, patchMapGraph, installMapRenderEfficiency, getMapRenderEfficiency } from '../docs/map-render-efficiency.js';

const project = JSON.parse(readFileSync(new URL('../docs/assets/project.json', import.meta.url), 'utf8'));
const rawMap = project.targets.find(target => target.name === '地図');
const rawStage = project.targets.find(target => target.isStage);
const PREFIX = 'eew/cpu/';
const BG = 'WEEW CPU static background';
const dirtyID = 'k8(E0n%2Po))#zm$PT5N';
const relevantNames = new Set(['1カメラ系', '3画面設定系', '3-1設定系からの情報', '7システム設定', '描画更新-変更']);

// Normalize the actual SB3 graph into the representation consumed by Blocks and
// the compiler. Inline SB3 literals become ordinary shadow/reporter blocks.
function normalize(source) {
  const normalized = {}, pending = [];
  let next = 0;
  const literal = (value, parent) => {
    const [type, text, variableID] = value;
    const id = `fixture/literal/${++next}`;
    const numeric = type >= 4 && type <= 8;
    const opcode = numeric ? 'math_number' : type === 9 ? 'colour_picker' : type === 11 ? 'event_broadcast_menu' : type === 12 ? 'data_variable' : type === 13 ? 'data_listcontents' : 'text';
    const name = numeric ? 'NUM' : type === 9 ? 'COLOUR' : type === 11 ? 'BROADCAST_OPTION' : type === 12 ? 'VARIABLE' : type === 13 ? 'LIST' : 'TEXT';
    pending.push({ id, opcode, next: null, parent, inputs: {}, fields: { [name]: { name, value: text, ...(variableID ? { id: variableID } : {}) } }, shadow: type !== 12 && type !== 13, topLevel: false });
    return id;
  };
  for (const [id, raw] of Object.entries(source)) {
    const b = structuredClone(raw);
    b.id = id; b.next ??= null; b.parent ??= null; b.shadow ??= false; b.topLevel ??= false;
    b.fields = Object.fromEntries(Object.entries(raw.fields ?? {}).map(([name, value]) => [name, { name, value: value[0], ...(value[1] ? { id: value[1] } : {}) }]));
    b.inputs = Object.fromEntries(Object.entries(raw.inputs ?? {}).map(([name, value]) => {
      const primary = Array.isArray(value[1]) ? literal(value[1], id) : value[1] ?? null;
      const shadow = value[0] === 1 ? primary : Array.isArray(value[2]) ? literal(value[2], id) : value[2] ?? null;
      return [name, { name, block: primary, shadow }];
    }));
    normalized[id] = b;
  }
  for (const b of pending) normalized[b.id] = b;
  return normalized;
}

function fixture({ unknownGraph = false } = {}) {
  let time = 1000000, nextSkin = 1, nextDrawable = 10;
  const paints = [], clears = [], destroyed = [], qualityChanges = [];
  const counts = { vmSteps: 0, reception: 0, clock: 0, speech: 0, backgroundCalculations: 0, eew: 0, tsunami: 0, draws: 0 };
  const variables = Object.fromEntries(Object.entries({ ...rawStage.variables, ...rawStage.lists })
    .filter(([, [name]]) => relevantNames.has(name)).map(([id, [name, value]]) => [id, { id, name, value: structuredClone(value) }]));
  const stage = { variables, isStage: true };
  const blocks = { _blocks: normalize(rawMap.blocks), _scripts: [], resets: 0,
    createBlock(b) { this._blocks[b.id] = b; if (b.topLevel) this._scripts.push(b.id); this.resetCache(); },
    resetCache() { this.resets++; this._cache = { compiledScripts: {}, compiledProcedures: {} }; },
  };
  blocks._scripts = Object.values(blocks._blocks).filter(b => b.topLevel).map(b => b.id);
  const map = { isOriginal: true, getName: () => '地図', blocks, variables: {},
    sprite: { costumes: rawMap.costumes.map((costume, index) => ({ name: costume.name, skinId: 1000 + index })) },
    createVariable(id, name, type) { this.variables[id] = { id, name, type, value: 0 }; },
  };
  if (unknownGraph) blocks._blocks.sR.next = 'changed-upstream';
  const canvas = Object.assign(new EventTarget(), { width: 960, height: 720 });
  const skin = id => ({ id, renderQuality: 1, setRenderQuality(value) { qualityChanges.push({ id, value }); this.renderQuality = value; } });
  const renderer = {
    canvas, dirty: true, useHighQualityRender: true, nativeSize: [480, 360], _penSkinId: 1,
    _allSkins: { 1: skin(1) }, _allDrawables: { 10: { skin: 1 } }, _drawList: [0, 10],
    getNativeSize() { return this.nativeSize; },
    createPenSkin() { const id = ++nextSkin; this._allSkins[id] = skin(id); this._penSkinId = id; return id; },
    createDrawable() { const id = ++nextDrawable; this._allDrawables[id] = {}; this._drawList.push(id); return id; },
    updateDrawableSkinId(id, skinID) { this._allDrawables[id].skin = skinID; },
    setDrawableOrder(id, order, group) {
      assert.equal(group, 'pen'); assert.equal(order, -Infinity);
      this._drawList.splice(this._drawList.indexOf(id), 1); this._drawList.splice(1, 0, id);
    },
    destroyDrawable(id, group) { assert.equal(group, 'pen'); assert.ok(this._allDrawables[id]); destroyed.push(['drawable', id]); delete this._allDrawables[id]; this._drawList.splice(this._drawList.indexOf(id), 1); },
    destroySkin(id) { assert.ok(this._allSkins[id]); destroyed.push(['skin', id]); delete this._allSkins[id]; },
    penClear(id) { assert.ok(this._allSkins[id], `skin ${id} must exist`); clears.push(id); this.dirty = true; },
    penStamp(id, drawable) { assert.ok(this._allSkins[id]); paints.push({ kind: 'stamp', id, drawable }); this.dirty = true; },
    penPoint(id) { assert.ok(this._allSkins[id]); paints.push({ kind: 'point', id }); this.dirty = true; },
    penLine(id) { assert.ok(this._allSkins[id]); paints.push({ kind: 'line', id }); this.dirty = true; },
    skinWasAltered() { this.dirty = true; },
    draw() { if (this.dirty) { counts.draws++; this.dirty = false; } },
  };
  const runtime = Object.assign(new EventEmitter(), { renderer, targets: [stage, map], threads: [], sequencer: { activeThread: null }, getTargetForStage: () => stage });
  const vm = { runtime };
  const get = name => Object.values(stage.variables).find(v => v.name === name);
  const evaluate = id => {
    const b = blocks._blocks[id];
    assert.ok(b, `expression ${id} exists`);
    const value = name => evaluate(b.inputs[name].block);
    switch (b.opcode) {
      case 'sensing_dayssince2000': return time / 86400000;
      case 'math_number': return Number(b.fields.NUM.value);
      case 'data_variable': return (map.variables[b.fields.VARIABLE.id] ?? stage.variables[b.fields.VARIABLE.id]).value;
      case 'operator_subtract': return Number(value('NUM1')) - Number(value('NUM2'));
      case 'operator_mod': {
        const a = Number(value('NUM1')), b = Number(value('NUM2'));
        return ((a % b) + b) % b;
      }
      case 'operator_lt': return Number(value('OPERAND1')) < Number(value('OPERAND2'));
      case 'operator_not': return !value('OPERAND');
      case 'operator_or': return Boolean(value('OPERAND1')) || Boolean(value('OPERAND2'));
      case 'operator_equals': return value('OPERAND1') == value('OPERAND2');
      default: throw new Error(`unexpected gate opcode ${b.opcode}`);
    }
  };
  const consumeEntry = () => {
    let id = blocks._blocks.sR.inputs.SUBSTACK.block;
    while (id !== 'i') {
      const b = blocks._blocks[id];
      assert.equal(b.opcode, 'data_setvariableto');
      const target = map.variables[b.fields.VARIABLE.id] ?? stage.variables[b.fields.VARIABLE.id];
      target.value = evaluate(b.inputs.VALUE.block); id = b.next;
    }
  };
  const originalProcedures = {
    [BG]() { counts.backgroundCalculations++; renderer.penStamp(1, 101); renderer.penStamp(1, 102); return 'background-result'; },
    'W下地地図描画'() { return 'camera-calculations'; },
    'W津波エリア描画'() { counts.tsunami++; renderer.penStamp(1, 201); },
    'W震源スタンんプEEW %b %b'() { counts.eew++; renderer.penStamp(1, 202); },
  };
  let thread;
  const compile = () => {
    thread = { target: map, isCompiled: true, topBlock: 'dC(', procedures: { ...originalProcedures } };
    runtime.threads.push(thread); return thread;
  };
  const step = () => {
    counts.vmSteps++; counts.reception++; counts.clock++; counts.speech++;
    runtime.emit('BEFORE_EXECUTE');
    runtime.sequencer.activeThread = thread;
    if (evaluate(blocks._blocks.sR.inputs.CONDITION.block)) {
      consumeEntry(); renderer.penClear(1);
      assert.equal(thread.procedures[BG](), 'background-result');
      thread.procedures['W津波エリア描画'](); thread.procedures['W震源スタンんプEEW %b %b']();
    }
    runtime.sequencer.activeThread = null;
    runtime.emit('AFTER_EXECUTE'); renderer.draw();
  };
  return { vm, runtime, renderer, map, stage, blocks, counts, paints, clears, destroyed, qualityChanges, get,
    compile, step, evaluate, consumeEntry, originalProcedures,
    get thread() { return thread; }, setTime(value) { time = value; }, advance(ms = 100) { time += ms; }, now: () => time,
  };
}

function installedFixture(options) {
  const h = fixture(options);
  const installation = installMapRenderEfficiency(h.vm, { now: h.now });
  h.compile();
  return { ...h, installation };
}

test('matches the real normalized upstream graph and extracts only the pure background span', () => {
  const h = fixture(), original = structuredClone(h.blocks._blocks), scripts = [...h.blocks._scripts];
  assert.equal(compatibleMap(h.map, h.stage), true);
  const graph = patchMapGraph(h.map, h.stage);
  assert.ok(graph);
  assert.equal(h.blocks._blocks['bn#'].parent, PREFIX + 'bgDefinition');
  assert.equal(h.blocks._blocks.bpr.next, null);
  assert.equal(h.blocks._blocks.pY.next, PREFIX + 'bgCall');
  assert.equal(h.blocks._blocks[PREFIX + 'bgCall'].next, 'bpJ');
  assert.equal(h.blocks._blocks[PREFIX + 'bgPrototype'].mutation.warp, 'true');
  for (const id of ['bpJ', 'bpK', 'c|', 'db', ']-', '].', 'bFy', 'bFB', 'dDf']) {
    if (id === 'bpJ') assert.equal(h.blocks._blocks[id].next, original[id].next);
    else assert.deepEqual(h.blocks._blocks[id], original[id], `dynamic calculation block ${id} remains unchanged`);
  }
  for (const id of graph.added) for (const entry of Object.values(h.blocks._blocks[id].inputs)) {
    assert.equal(entry.name.length > 0, true);
    assert.equal(h.blocks._blocks[entry.block].parent, id);
  }
  graph.restoreBeforeRun();
  assert.deepEqual(h.blocks._blocks, original);
  assert.deepEqual(h.blocks._scripts, scripts);
  assert.deepEqual(h.map.variables, {});
});

test('refuses changed upstream layouts and invalid rates without mutating the project', () => {
  const h = fixture({ unknownGraph: true }), original = structuredClone(h.blocks._blocks);
  assert.equal(compatibleMap(h.map, h.stage), false);
  assert.equal(patchMapGraph(h.map, h.stage), null);
  assert.deepEqual(h.blocks._blocks, original);
  assert.deepEqual(h.map.variables, {});
  const valid = fixture();
  for (const fps of [0, -1, Infinity, NaN, 61]) assert.equal(patchMapGraph(valid.map, valid.stage, { fps }), null);
  assert.deepEqual(valid.map.variables, {});
});

test('only the paint branch is capped while 60 VM steps retain reception, clocks and speech', () => {
  const h = installedFixture();
  for (let frame = 0; frame < 60; frame++) { h.setTime(1000000 + frame * 1000 / 60); h.step(); }
  assert.equal(h.counts.vmSteps, 60);
  assert.equal(h.counts.reception, 60); assert.equal(h.counts.clock, 60); assert.equal(h.counts.speech, 60);
  assert.ok(h.installation.stats.mapFrames >= 11 && h.installation.stats.mapFrames <= 16);
  assert.ok(h.installation.stats.finalDrawsSkipped >= 40);
  assert.equal(h.counts.eew, h.installation.stats.mapFrames);
  assert.equal(h.counts.tsunami, h.installation.stats.mapFrames);
  assert.equal(h.counts.backgroundCalculations, h.installation.stats.mapFrames);
  assert.equal(h.get('描画更新-変更').value, 0);
  h.installation.dispose();
});

test('the gate has a heartbeat without dirty flags and handles a backward system clock', () => {
  const h = fixture();
  const graph = patchMapGraph(h.map, h.stage);
  const gate = h.blocks._blocks.sR.inputs.CONDITION.block;
  h.get('描画更新-変更').value = 0;
  assert.equal(h.evaluate(gate), true); h.consumeEntry();
  const phaseMS = h.map.variables[PREFIX + 'last'].value * 86400000;
  h.setTime(phaseMS + 30); assert.equal(h.evaluate(gate), false);
  h.setTime(phaseMS + 70); assert.equal(h.evaluate(gate), true); h.consumeEntry();
  h.setTime(900000); assert.equal(h.evaluate(gate), true);
  graph.enabled.value = 0;
  h.consumeEntry();
  assert.equal(h.get('描画更新-変更').value, 1);
  assert.equal(h.evaluate(gate), true);
});

test('cached backgrounds keep calculations and every EEW/tsunami stamp running', () => {
  const h = installedFixture();
  const originalEEW = h.originalProcedures['W震源スタンんプEEW %b %b'];
  const originalTsunami = h.originalProcedures['W津波エリア描画'];
  h.step(); h.advance(); h.step();
  assert.equal(h.installation.stats.staticBuilds, 1);
  assert.equal(h.installation.stats.staticCacheHits, 1);
  assert.equal(h.installation.stats.staticStamps, 2);
  assert.equal(h.installation.stats.staticStampsSkipped, 2);
  assert.equal(h.counts.backgroundCalculations, 2);
  assert.equal(h.counts.eew, 2); assert.equal(h.counts.tsunami, 2);
  assert.equal(h.thread.procedures['W震源スタンんプEEW %b %b'], originalEEW);
  assert.equal(h.thread.procedures['W津波エリア描画'], originalTsunami);
  assert.equal(h.renderer._penSkinId, 1);
  const staticID = Object.keys(h.renderer._allSkins).map(Number).find(id => id !== 1);
  assert.ok(staticID);
  assert.equal(h.paints.filter(paint => paint.id === staticID).length, 2);
  assert.equal(h.paints.filter(paint => paint.id === 1).length, 4);
  assert.deepEqual(h.renderer._drawList, [0, 11, 10]);
  h.installation.dispose();
});

test('camera, layout, palette, source skin and native canvas changes rebuild the background', () => {
  const h = installedFixture(); h.step();
  const changes = [
    () => { h.get('1カメラ系').value[0]++; },
    () => { h.get('3画面設定系').value[2]++; },
    () => { h.get('3-1設定系からの情報').value[2]++; },
    () => { h.get('7システム設定').value[64] = !h.get('7システム設定').value[64]; },
    () => { h.get('7システム設定').value[65] = !h.get('7システム設定').value[65]; },
    () => { h.map.sprite.costumes[0].skinId++; },
    () => { h.renderer.nativeSize = [500, 360]; },
    () => { h.renderer.canvas.width += 20; },
    () => { h.renderer.canvas.height += 20; },
    () => { h.renderer.useHighQualityRender = false; },
  ];
  for (const [index, change] of changes.entries()) {
    change(); h.advance(); h.step();
    assert.equal(h.installation.stats.staticBuilds, index + 2);
  }
  assert.equal(h.renderer._allSkins[1].renderQuality, 1);
  assert.equal(Object.keys(h.renderer._allSkins).length, 2); // Reuse the one extra texture.
  h.installation.dispose();
});

test('changing native pen render quality rebuilds the cache even when viewport fields are unchanged', () => {
  const h = installedFixture(); h.step();
  h.renderer._allSkins[1].setRenderQuality(2);
  h.advance(); h.step();
  assert.equal(h.installation.stats.staticBuilds, 2);
  assert.equal(h.installation.stats.staticCacheHits, 0);
  assert.equal(h.installation.stats.staticStamps, 4);
  const staticID = Object.keys(h.renderer._allSkins).map(Number).find(id => id !== 1);
  assert.equal(h.renderer._allSkins[staticID].renderQuality, 2);
  h.installation.dispose();
});

test('SVG content changes with a stable background skin ID invalidate cache without invalidating unrelated icons', () => {
  const h = installedFixture(); h.step();
  const background = h.map.sprite.costumes.find(costume => costume.name === 'allocean');
  const epicenter = h.map.sprite.costumes.find(costume => costume.name === 'epc00');
  h.renderer.skinWasAltered({ id: epicenter.skinId });
  assert.equal(h.installation.cacheActive, true);
  h.advance(); h.step();
  assert.equal(h.installation.stats.staticBuilds, 1);
  h.renderer.skinWasAltered({ id: background.skinId });
  assert.equal(h.installation.cacheActive, false);
  h.advance(); h.step();
  assert.equal(h.installation.stats.staticBuilds, 2);
  h.installation.dispose();
});

test('non-map pen clear and project stop invalidate background content', () => {
  const h = installedFixture(); h.step();
  h.renderer.penClear(1);
  assert.equal(h.installation.cacheActive, false);
  h.advance(); h.step();
  assert.equal(h.installation.stats.staticBuilds, 2);
  h.runtime.emit('PROJECT_STOP_ALL');
  assert.equal(h.installation.cacheActive, false);
  h.advance(); h.step();
  assert.equal(h.installation.stats.staticBuilds, 3);
  h.installation.dispose();
});

test('explicit draw calls remain synchronous outside the final step presentation', () => {
  const h = installedFixture(); h.step();
  const before = h.counts.draws;
  for (let i = 0; i < 3; i++) { h.renderer.dirty = true; h.renderer.draw(); }
  assert.equal(h.counts.draws, before + 3);
  assert.equal(h.installation.stats.finalDrawsSkipped, 0);
  h.advance(5); h.step();
  assert.equal(h.installation.stats.finalDrawsSkipped, 1);
  h.installation.dispose();
});

test('disabled optimizations preserve compiled scripts and no longer cache their pen operations', () => {
  const h = installedFixture(); h.step();
  const thread = h.thread;
  h.installation.setEnabled(false);
  assert.equal(h.installation.active, false);
  h.advance(1); h.step(); h.advance(1); h.step();
  assert.equal(h.thread, thread);
  assert.equal(h.counts.backgroundCalculations, 3);
  assert.equal(h.counts.eew, 3); assert.equal(h.counts.tsunami, 3);
  assert.equal(Object.keys(h.renderer._allSkins).length, 1);
  assert.equal(h.get('描画更新-変更').value, 1);
  h.installation.setEnabled(true);
  h.advance(); h.step();
  assert.equal(h.installation.active, true);
  assert.equal(h.installation.stats.staticBuilds, 2);
  h.installation.dispose();
});

test('context loss never reuses a texture and restore falls back to uncached native painting', () => {
  const h = installedFixture(); h.step();
  h.renderer.canvas.dispatchEvent(new Event('webglcontextlost'));
  assert.equal(h.installation.cacheActive, false);
  h.advance(); h.step();
  assert.equal(h.counts.backgroundCalculations, 2);
  assert.equal(h.installation.stats.staticBuilds, 1);
  h.renderer.canvas.dispatchEvent(new Event('webglcontextrestored'));
  h.advance(); h.step();
  assert.equal(h.installation.cacheActive, false);
  assert.equal(Object.keys(h.renderer._allSkins).length, 1);
  assert.equal(h.counts.eew, 3); assert.equal(h.counts.tsunami, 3);
  h.installation.dispose();
});

test('installation is idempotent and disposal removes textures/listeners and restores hooks', () => {
  const h = fixture();
  const originalHooks = Object.fromEntries(['penClear', 'penStamp', 'penPoint', 'penLine', 'draw', 'skinWasAltered'].map(name => [name, h.renderer[name]]));
  const result = installMapRenderEfficiency(h.vm, { now: h.now });
  assert.equal(installMapRenderEfficiency(h.vm), result);
  assert.equal(getMapRenderEfficiency(h.vm), result);
  for (const event of ['PROJECT_LOADED', 'BEFORE_EXECUTE', 'AFTER_EXECUTE', 'PROJECT_STOP_ALL']) assert.equal(h.runtime.listenerCount(event), 1);
  h.compile(); h.step();
  result.dispose();
  assert.deepEqual(h.destroyed.map(([kind]) => kind), ['drawable', 'skin']);
  for (const [name, fn] of Object.entries(originalHooks)) assert.equal(h.renderer[name], fn);
  for (const event of ['PROJECT_LOADED', 'BEFORE_EXECUTE', 'AFTER_EXECUTE', 'PROJECT_STOP_ALL']) assert.equal(h.runtime.listenerCount(event), 0);
  assert.equal(getMapRenderEfficiency(h.vm), null);
  assert.equal(h.map.variables[PREFIX + 'enabled'].value, 0);
  assert.equal(h.runtime.threads.length, 1); // Reception and compiled generators were not restarted.
  assert.equal(h.blocks._blocks.sR.inputs.CONDITION.block, ']Q');
  assert.equal(h.blocks._blocks.pY.next, 'bn#');
  assert.equal(Object.keys(h.blocks._blocks).some(id => id.startsWith(PREFIX)), false);
});

test('disposal before execution restores the original graph and allows a clean reinstall', () => {
  const h = fixture(), original = structuredClone(h.blocks._blocks);
  const first = installMapRenderEfficiency(h.vm, { now: h.now });
  first.dispose();
  assert.deepEqual(h.blocks._blocks, original);
  const second = installMapRenderEfficiency(h.vm, { now: h.now });
  assert.notEqual(first, second); assert.equal(second.active, true);
  second.dispose();
  assert.deepEqual(h.blocks._blocks, original);
});

test('repeated disposal cannot tear down a newer installation or delete its graph variables', () => {
  const h = fixture();
  const first = installMapRenderEfficiency(h.vm, { now: h.now }); first.dispose();
  const second = installMapRenderEfficiency(h.vm, { now: h.now });
  const enabled = h.map.variables[PREFIX + 'enabled'];
  first.dispose();
  assert.equal(getMapRenderEfficiency(h.vm), second);
  assert.equal(second.active, true);
  assert.equal(h.map.variables[PREFIX + 'enabled'], enabled);
  assert.equal(h.blocks._blocks.sR.inputs.CONDITION.block, PREFIX + 'gate');
  for (const event of ['PROJECT_LOADED', 'BEFORE_EXECUTE', 'AFTER_EXECUTE', 'PROJECT_STOP_ALL']) assert.equal(h.runtime.listenerCount(event), 1);
  second.dispose();
});

test('unavailable renderer APIs do not install hooks, listeners, variables, or a graph patch', () => {
  const h = fixture(), original = structuredClone(h.blocks._blocks), originalDraw = h.renderer.draw;
  h.renderer.createPenSkin = undefined;
  assert.equal(installMapRenderEfficiency(h.vm), null);
  assert.deepEqual(h.blocks._blocks, original);
  assert.deepEqual(h.map.variables, {});
  assert.equal(h.renderer.draw, originalDraw);
  assert.equal(h.runtime.listenerCount('PROJECT_LOADED'), 0);
});

test('cache allocation failure falls back to original pen operations without stopping other scripts', () => {
  const h = fixture();
  h.renderer.createDrawable = () => { throw new Error('Texture allocation unavailable'); };
  const installation = installMapRenderEfficiency(h.vm, { now: h.now }); h.compile();
  assert.doesNotThrow(() => h.step());
  assert.equal(installation.stats.fallbacks, 1);
  assert.equal(installation.cacheActive, false);
  h.advance(); assert.doesNotThrow(() => h.step());
  assert.equal(h.counts.backgroundCalculations, 2);
  assert.equal(h.counts.reception, 2); assert.equal(h.counts.clock, 2); assert.equal(h.counts.speech, 2);
  assert.equal(h.counts.eew, 2); assert.equal(h.counts.tsunami, 2);
  assert.equal(h.renderer._penSkinId, 1);
  assert.equal(Object.keys(h.renderer._allSkins).length, 1);
  assert.ok(h.paints.every(paint => paint.id === 1));
  installation.dispose();
});
