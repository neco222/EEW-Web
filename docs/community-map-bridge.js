import {readView} from './viewer-bridge.js';

// Native source: assets/project.json, 地図/カメラ移動 (btN),
// カメラ位置制限して自動移動 (bsE), 自動カメラ計算 (bK.), and
// 受信と検出/自動カメラ呼び出し (aK(). Scratch indices below are 1-based.
// 18=range ready, 19=follow target, 20/21=target x/y, 22=manual-input days.
// 19 remains 1 after arrival; it is not, by itself, evidence of an active move.
const DAY_MS = 86_400_000;
const MANUAL_HOLD_MS = 30_000;
const NATIVE_AUTO_SETTLE_MS = 1_000;
const NATIVE_INFORMATION_HOLD_MS = 120_000;
const EPOCH = Date.UTC(2000, 0, 1);
const TARGET_TOLERANCE_PX = 2;
const stages = new WeakMap();
const receivers = new WeakMap();
const names = new WeakMap();
const owned = new WeakMap();
const BINDINGS = {
  camera: ['/[;m=*u~4dVLN3LnqEul', '1カメラ系'],
  permission: ['3r2[u9%!:$J!~0,[!WA`', '自動カメラ移動許可'],
  settings: ['|-$]i?VXM:wz}RW[R0@W', '7システム設定'],
  history: ['~pB!9E;L(u6y}:jZJa-m', '地図過去表示モード'],
  autoTime: [':5;:e)@(WtxEhlJP+omL', '自動カメラ時間'],
  replay: ['qM{_c9Qzrq.,$j.enLYz', '#リプレイモード'],
  eew: ['!zoC:uBg[Uj?t;84/~_c', '0EEW'],
  eewActive: ['ry{@6d.Fj^_QYEELDK_:', 'EEW全体で発表中？'],
  tsunami: ['2`OxG=vEfNxKB1.x=g)!', '9津波関連'],
  tsunamiMap: [null, 'tsu: 地図表示集'],
  realtime: ['pPs(Dg^SmS.v8*,O[yUP', '4リアルタイム状況(最大震度など)'],
  information: ['8+rX0Tf6a(Aknj^e5ErO', '5地震情報リスト'],
  button: ['`~PRT$kfrxj0_k`m,AB+', 'ボタン - 操作可能対象'],
  tab: ['17rtPHAX9|+t}}[U,|`R', 'タブ'],
  mapMode: ['cOE)RT$1^[}M~v,_zl5i', '地図表示モード'],
  dialog: ['J1Wp~*zS5Y_O!z(~K:1I', 'ダイアログなう'],
  grid: ['r2DN$(Tj:Tk^o%UuW]#8', '検出済みグリッド数'],
};

function numeric(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return NaN;
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

function variable(target, [id, name]) {
  const variables = target?.variables;
  if (!variables) return null;
  if (id && variables[id]?.name === name) return variables[id];
  let index = names.get(variables);
  if (!index) {index = new Map(Object.entries(variables).map(([key, entry]) => [entry.name, key])); names.set(variables, index);}
  const cached = variables[index.get(name)];
  if (cached?.name === name) return cached;
  // A reset can replace a Variable in the same dictionary as well as a Stage.
  const found = Object.entries(variables).find(([, entry]) => entry.name === name);
  if (found) {index.set(name, found[0]); return found[1];}
  return null;
}

function stageFor(runtime) {
  const cached = stages.get(runtime);
  if (cached && runtime.targets?.[cached.index] === cached.target) return cached.target;
  const target = runtime.getTargetForStage?.() ?? runtime.targets?.find(item => item.isStage);
  if (!target?.variables) return null;
  stages.set(runtime, {target, index: runtime.targets?.indexOf(target) ?? -1});
  return target;
}

function receiverFor(runtime) {
  const cached = receivers.get(runtime);
  if (cached && runtime.targets?.[cached.index] === cached.target) return cached.target;
  const target = runtime.targets?.find(item => item.isOriginal && item.getName?.() === '受信と検出');
  if (target) receivers.set(runtime, {target, index: runtime.targets.indexOf(target)});
  return target;
}

function nativeDays(runtime) {
  const reporter = runtime._primitives?.sensing_dayssince2000;
  if (typeof reporter !== 'function') return NaN;
  try {return numeric(Reflect.apply(reporter, runtime._primitives, []));} catch {return NaN;}
}

function source(vm) {
  const runtime = vm?.runtime;
  if (!runtime || typeof runtime !== 'object') return null;
  const stage = stageFor(runtime);
  if (!stage) return null;
  const cameraVariable = variable(stage, BINDINGS.camera);
  const camera = cameraVariable?.value;
  if (!Array.isArray(camera) || camera.length < 37) return null;
  return {runtime, stage, cameraVariable, camera,
    autoTime: variable(stage, BINDINGS.autoTime)?.value};
}

function owner(source) {
  const previous = owned.get(source.runtime);
  return previous && previous.stage === source.stage && previous.variable === source.cameraVariable &&
    previous.list === source.camera && Number(source.camera[18]) === 1 &&
    Object.is(previous.x, source.camera[19]) && Object.is(previous.y, source.camera[20]) &&
    Object.is(previous.autoTime, source.autoTime) && Object.is(previous.manualStamp, source.camera[21]) ? previous : null;
}

function activeAnchor(value) {return value !== '' && value !== null && value !== undefined;}
function closed(reason, extra = {}) {return {ready: false, blocked: true, reason, ...extra};}

/** Read current native priority without changing the project or starting timers.
 * Native timestamps use the native sensing_dayssince2000 reporter, never a
 * Date.now-derived epoch. now is only the caller's wall-clock metadata.
 */
export function readMapControl(vm = globalThis.vm, view, now = Date.now()) {
  try {return readControl(vm, view === undefined ? readView(vm) : view, now);}
  catch {return closed('native-state-unavailable');}
}

function readControl(vm, view, now) {
  const current = source(vm);
  if (!current) return closed('not-ready');
  const {runtime, stage, camera: list} = current;
  if (!view) return closed('not-ready');
  if (view.settled !== true || ![view.width, view.height, view.layout?.uiScale, view.stage?.width, view.stage?.height].every(value => Number.isFinite(value) && value > 0)) return closed('layout-unsettled');
  if (!Number.isFinite(now)) return closed('invalid-clock');
  const document = view.canvas?.ownerDocument ?? globalThis.document;
  if (['loading', 'error', 'launch'].some(id => {const node = document?.getElementById?.(id); return node && !node.hidden;})) return closed('viewer-unavailable');
  if (Array.isArray(runtime.threads) && runtime.threads.length === 0) return closed('vm-stopped');
  const read = name => variable(stage, BINDINGS[name])?.value;
  const permission = numeric(read('permission'));
  const historyIndex = numeric(read('history'));
  const replay = numeric(read('replay'));
  const eew = read('eew'), tsunami = read('tsunami'), tsunamiMap = read('tsunamiMap');
  const settings = read('settings'), realtime = read('realtime'), information = read('information');
  const camera = {x: numeric(list[0]), y: numeric(list[1]), zoom: numeric(list[2]),
    targetX: numeric(list[19]), targetY: numeric(list[20]), targetZoom: numeric(list[5])};
  const clock = nativeDays(runtime), manualStamp = numeric(list[21]), autoStamp = numeric(current.autoTime);
  const receiver = receiverFor(runtime), grid = numeric(variable(receiver, BINDINGS.grid)?.value);
  const tab = numeric(read('tab')), mapMode = numeric(read('mapMode'));
  if (![...Object.values(camera), permission, historyIndex, replay, clock, manualStamp, autoStamp, grid, tab, mapMode].every(Number.isFinite) ||
    camera.zoom <= 0 || camera.targetZoom <= 0 || !Array.isArray(eew) || eew.length < 140 ||
    !Array.isArray(tsunami) || tsunami.length < 14 || !Array.isArray(tsunamiMap) ||
    !Array.isArray(settings) || settings.length < 1 || !Array.isArray(realtime) || realtime.length < 8 ||
    !Array.isArray(information) || read('dialog') === undefined) return closed('native-state-unavailable');
  const manualAgeMs = (clock - manualStamp) * DAY_MS;
  const nativeAutoAgeMs = (clock - autoStamp) * DAY_MS;
  // Normal-information records are UTC seconds since 2000, unlike the camera
  // control's local Scratch-day stamps. Do not treat nativeActive=true on a
  // historic normal record as a permanent alert. Its latest issue gets 2 min.
  const issued = numeric(information[6]), origin = numeric(information[4]);
  const informationTime = issued > 0 ? issued : origin > 0 ? origin : NaN;
  const nativeInformationAgeMs = Number.isFinite(informationTime) ? now - (EPOCH + informationTime * 1000) : null;
  const autoEnabled = settings[0] === true || settings[0] === 1 || settings[0] === '1';
  // Do not infer EEW priority from origin age, location reliability or which of
  // ten slots happens to be newest. An active PLUM/unlocated slot still wins.
  const eewActive = Number(read('eewActive')) === 1 || Array.from({length:10}, (_, slot) => Number(eew[slot * 14])).includes(1);
  const tsunamiActive = Number(tsunami[0]) > 0 || tsunamiMap.length > 0;
  // Native 検出許可震度算出 (aO@ / N!) writes item 8 only for allowed
  // shaking detections. Ambient/raw station samples must not block forever.
  const shaking = grid > 0 || Number(realtime[7]) > 0;
  const nativePending = Number(list[17]) !== 1;
  const zoomMoving = Math.abs(Math.log(camera.zoom / camera.targetZoom)) > .0001;
  const scaleX = view.layout.uiScale * view.width / view.stage.width;
  const scaleY = view.layout.uiScale * view.height / view.stage.height;
  const targetDistancePx = Math.hypot((camera.x - camera.targetX) * camera.zoom * scaleX,
    (camera.y - camera.targetY) * camera.zoom * scaleY);
  const following = Number(list[18]) === 1;
  const moving = following && targetDistancePx > TARGET_TOLERANCE_PX;
  const communityMoving = moving && Boolean(owner(current));
  const nativeMoving = zoomMoving || moving && !communityMoving;
  const manualMotion = activeAnchor(list[3]) || activeAnchor(list[4]) || activeAnchor(list[33]) ||
    Math.abs(Number(list[11]) || 0) > .05 || Math.abs(Number(list[32]) || 0) > 1 / 1600 ||
    Boolean(runtime.ioDevices?.mouse?.getIsDown?.()) || Number(read('button')) > 0;
  const result = {ready: true, blocked: true, reason: null, at: now, camera, permission, autoEnabled,
    historyIndex, tab, mapMode, manualAgeMs, nativeAutoAgeMs, nativePending, nativeMoving,
    communityMoving, manualMotion, eewActive, tsunamiActive, shaking, targetDistancePx, nativeInformationAgeMs};
  let reason = null;
  if (replay > 0) reason = 'replay';
  else if (String(read('dialog')) !== '') reason = 'dialog';
  else if (eewActive) reason = 'eew-active';
  else if (tsunamiActive || mapMode === 3) reason = 'tsunami-active';
  else if (!(tab === 1 && mapMode === 1 || tab === 0 && mapMode === 2)) reason = 'not-map';
  else if (historyIndex !== 0) reason = 'history';
  else if (nativeInformationAgeMs !== null && nativeInformationAgeMs <= NATIVE_INFORMATION_HOLD_MS) reason = 'native-information';
  else if (shaking) reason = 'shaking';
  else if (!autoEnabled) reason = 'native-auto-disabled';
  else if (manualMotion) reason = 'manual-motion';
  else if (permission !== 1 || manualAgeMs <= MANUAL_HOLD_MS) reason = 'manual-hold';
  else if (nativePending) reason = 'native-pending';
  else if (nativeAutoAgeMs <= NATIVE_AUTO_SETTLE_MS) reason = 'native-auto-recent';
  else if (nativeMoving) reason = 'native-moving';
  return {...result, blocked: reason !== null, reason};
}

/** Submit one low-priority target to the native animation. No direct x/y jump,
 * zoom change, permission change, manual timestamp or range calculation occurs.
 * Re-read live state immediately before writing; an old allowed snapshot grants
 * no permission. Native EEW/tsunami requests remain free to replace this target.
 */
export function panCommunityFocus(focus, vm = globalThis.vm, view, now = Date.now()) {
  try {return pan(focus, vm, view, now);}
  catch {return {moved: false, reason: 'native-state-unavailable'};}
}

function pan(focus, vm, view, now) {
  const lat = numeric(focus?.lat), lon = numeric(focus?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) >= 90 || Math.abs(lon) > 180) return {moved: false, reason: 'invalid-focus'};
  const fresh = readView(vm);
  if (view && (!fresh || view.canvas !== fresh.canvas || view.width !== fresh.width || view.height !== fresh.height || view.settled !== true)) return {moved: false, reason: 'layout-unsettled'};
  const control = readMapControl(vm, fresh, now);
  if (!control.ready || control.blocked) return {moved: false, reason: control.reason};
  const current = source(vm);
  const x = ((((lon + 44) % 360) + 360) % 360 - 180) * 10;
  const y = Math.log(Math.tan((45 + lat / 2) * Math.PI / 180)) * 572.9577951308232 - 374.04780730560344;
  if (!current || !Number.isFinite(x) || !Number.isFinite(y)) return {moved: false, reason: 'invalid-focus'};
  const previous = {stage: current.stage, variable: current.cameraVariable, list: current.camera,
    x, y, autoTime: current.autoTime, manualStamp: current.camera[21]};
  // Validate all three ordinary data slots before the first write. A frozen or
  // changed schema must not receive a partial target or throw into the feed.
  if (![18,19,20].every(index => {const descriptor = Object.getOwnPropertyDescriptor(current.camera, index); return descriptor && 'value' in descriptor && descriptor.writable;})) return {moved: false, reason: 'camera-readonly'};
  current.camera[19] = x;
  current.camera[20] = y;
  current.camera[18] = 1;
  owned.set(current.runtime, previous);
  return {moved: true, reason: null, target: {x, y}};
}

/** Stop only a still-owned request. Never restore an old camera array, clear a
 * native range request, or cancel a target after a manual/native owner changed.
 */
export function cancelCommunityFocus(vm = globalThis.vm) {
  try {return cancel(vm);}
  catch {return {cancelled: false, reason: 'native-state-unavailable'};}
}

function cancel(vm) {
  const current = source(vm);
  if (!current) return {cancelled: false, reason: 'not-ready'};
  const token = owner(current);
  owned.delete(current.runtime);
  if (!token || Number(current.camera[17]) !== 1) return {cancelled: false, reason: 'not-owned'};
  const descriptor = Object.getOwnPropertyDescriptor(current.camera, 18);
  if (!descriptor || !('value' in descriptor) || !descriptor.writable) return {cancelled: false, reason: 'camera-readonly'};
  current.camera[18] = 0;
  return {cancelled: true, reason: null};
}
