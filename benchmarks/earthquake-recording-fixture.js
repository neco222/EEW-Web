/* LOCAL RECORDING ONLY. Never include in the published app.
 * Synthetic EEW values enter the original project's in-memory Stage lists.
 * The recording page must replace/block all external WebSockets before loading
 * the viewer. This file performs no fetch, WebSocket, cloud write, or disk write.
 */
(() => {
  if (globalThis.earthquakeRecording) return;
  const timers = new Set();
  const saved = new Map();
  let origin = null;
  let sync = null;
  const camera = { lat: 42.5, lon: 142.3, zoom: 4.2 };
  const stage = () => globalThis.vm?.runtime?.getTargetForStage?.();
  const variable = (name) => Object.values(stage()?.variables ?? {}).find((value) => value.name === name);
  const value = (name) => variable(name)?.value;
  const remember = (name) => {
    if (!saved.has(name) && variable(name)) saved.set(name, structuredClone(value(name)));
  };
  const set = (name, data) => {
    const target = variable(name);
    if (!target) throw new Error(`Recording fixture: missing ${name}`);
    remember(name); target.value = data;
    if (target.type === 'list') target._monitorUpToDate = false;
  };
  const array = (name, length, fill = 0) => {
    const data = Array.isArray(value(name)) ? [...value(name)] : [];
    while (data.length < length) data.push(fill);
    return data;
  };
  const broadcast = (name) => globalThis.vm.runtime.startHats('event_whenbroadcastreceived', { BROADCAST_OPTION: name });
  const later = (callback, delay) => {
    const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay);
    timers.add(timer); return timer;
  };
  const seconds = () => {
    const sensing = globalThis.vm?.runtime?._primitives?.sensing_dayssince2000;
    const days = sensing ? Number(sensing()) : (Date.now() - Date.UTC(2000, 0, 1)) / 86400000;
    return days * 86400 + Number(value('時間オフセット') || 0);
  };
  function dirty() {
    set('描画更新-変更', 1);
    set('描画更新-地図', 1);
  }
  function setCamera(options = camera) {
    const { lat = camera.lat, lon = camera.lon, zoom = camera.zoom } = options;
    const x = ((((lon + 44) % 360) + 360) % 360 - 180) * 10;
    const y = Math.log(Math.tan((45 + lat / 2) * Math.PI / 180)) * 572.9577951308232 - 374.04780730560344;
    const values = array('1カメラ系', 37, '');
    for (const [index, datum] of [[0, x], [1, y], [2, zoom], [5, zoom], [8, zoom], [19, x], [20, y]]) values[index] = datum;
    set('1カメラ系', values);
    set('自動カメラ移動許可', 0);
    dirty();
  }
  function dismissDialogs() {
    set('ダイアログなう', '');
    broadcast('ボタン隠し'); broadcast('ダイアログ'); broadcast('タブ更新');
    dirty();
  }
  function setTab(tab = 1) {
    set('タブ', tab);
    set('地図表示モード', tab === 0 ? 2 : 1);
    broadcast('タブ切り替え'); broadcast('タブ更新');
    setCamera();
    later(() => setCamera(), 150);
    dirty();
  }
  function clockSync() {
    const now = seconds();
    const latest = array('#r:最新クラウド変数', 10, '');
    latest[0] = String(Math.floor(now)).padStart(10, '0');
    set('#r:最新クラウド変数', latest);
    const receiver = globalThis.vm.runtime.targets.find((target) => target.isOriginal && target.getName?.() === '受信と検出');
    const received = Object.values(receiver?.variables ?? {}).find((entry) => entry.name === 'ca:受信用2000s');
    if (received) received.value = Math.floor(now);
    // Normal cloud parsing also fills the map's display-clock list. The local
    // recording bypasses that parser, so update its existing UI input directly.
    const mapClock = array('6-4地図エリア表示内容', 1, '');
    mapClock[0] = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(new Date(Date.UTC(2000, 0, 1) + now * 1000)).replaceAll('-', '/');
    set('6-4地図エリア表示内容', mapClock);
    set('t最終更新からの時間同期', (now - Number(value('時間オフセット') || 0)) / 86400);
    dirty();
  }
  function forecast(report) {
    const codes = value('細分区域連番-変換');
    const names = value('d 地名-コード全集');
    const levels = { c100: 2, c101: 3, c102: 4, c105: 2, c106: 2, c110: 1, c115: 2, c116: 3,
      c122: 3, c127: 2, c145: 4, c146: 5, c150: 5, c151: 4, c152: 4,
      c155: 2, c156: 3, c157: 3, c160: 1, c161: 2 };
    const predicted = Array(1950).fill(0), lower = Array(1950).fill(0), warning = Array(1950).fill(0);
    for (let index = 0; index < Math.min(195, codes.length); index++) {
      const code = names[(Number(codes[index]) - 1) * 8];
      const base = levels[code] ?? 0;
      const level = base ? Math.min(6, base + (report > 1 ? 1 : 0)) : 0;
      predicted[index * 10] = level;
      lower[index * 10] = Math.max(0, level - 1);
      warning[index * 10] = level >= 4 ? 5 : 0;
    }
    set('map:EEW予想震度', predicted);
    set('map:EEW予想震度上限', [...predicted]);
    set('map:EEW予想震度下限', lower);
    set('map:EEW長周期上限&警報', warning);
    set('map:EEW震源距離', Array(1950).fill(99999));
  }
  async function ready({ timeoutMs = 45000 } = {}) {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      if (Array.isArray(value('0EEW')) && value('0EEW').length >= 140 &&
          Array.isArray(value('map:EEW予想震度')) && value('map:EEW予想震度').length >= 1950) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Recording fixture: native project did not initialize');
  }
  async function prepare() {
    await ready();
    dismissDialogs();
    clear();
    setTab(1);
    if (sync === null) sync = setInterval(clockSync, 1000);
    clockSync();
    return inspect();
  }
  function startEvent({ report = 1, lat = 42.0, lon = 142.3, depth = 30, magnitude,
    maximum, originSeconds } = {}) {
    const now = seconds();
    if (originSeconds !== undefined) origin = originSeconds;
    else if (report === 1 || origin === null) origin = now - 3;
    const active = array('0EEW', 140, '');
    // 1-based fields: active, warning, report, epicentre code, origin UTC2000s,
    // longitude, latitude, depth, M, maximum intensity code, elapsed, P/S radii,
    // last-received UTC2000s. Remaining fields are updated by native VM loops.
    active.splice(0, 14, 1, 1, report, 192, origin, lon, lat, depth,
      magnitude ?? (report > 1 ? 6.8 : 6.2), maximum ?? (report > 1 ? 6 : 5), now - origin, 0, 0, now);
    set('0EEW', active);
    const flags = array('0-1EEW発表中', 10, 0);
    if (report === 1) flags[0] = 0;
    set('0-1EEW発表中', flags);
    const extra = array('0-2EEW追加情報', 140, '');
    extra[0] = 0; extra[5] = '000000'; extra[6] = '-9'; extra[7] = 0;
    set('0-2EEW追加情報', extra);
    set('EEW全体で発表中？', 1);
    forecast(report);
    clockSync();
    setTab(1);
    dirty();
    return inspect();
  }
  function clear() {
    origin = null;
    set('0EEW', Array(140).fill(''));
    set('0-1EEW発表中', Array(10).fill(0));
    set('0-2EEW追加情報', Array(140).fill(''));
    set('EEW全体で発表中？', 0);
    for (const name of ['map:EEW予想震度', 'map:EEW予想震度上限', 'map:EEW予想震度下限', 'map:EEW長周期上限&警報']) set(name, Array(1950).fill(0));
    dirty();
  }
  function finishEvent({ tab = 1 } = {}) {
    clear();
    setTab(tab);
    broadcast('タブ更新');
    return inspect();
  }
  function inspect() {
    return {
      synthetic: true, now: seconds(), offset: value('時間オフセット'), tab: value('タブ'),
      dialog: value('ダイアログなう'), camera: value('1カメラ系')?.slice(0, 9),
      eew: value('0EEW')?.slice(0, 14), active: value('0-1EEW発表中')?.slice(0, 10),
      forecastRegions: value('map:EEW予想震度')?.filter((datum) => Number(datum) > 0).length,
    };
  }
  function restore() {
    for (const timer of timers) clearTimeout(timer); timers.clear();
    if (sync !== null) clearInterval(sync); sync = null;
    for (const [name, datum] of saved) if (variable(name)) variable(name).value = structuredClone(datum);
    saved.clear(); origin = null;
    broadcast('ダイアログ'); broadcast('タブ更新');
  }
  globalThis.earthquakeRecording = { ready, prepare, startEvent, finishEvent, clear, dismissDialogs, setTab, setCamera, inspect, restore };
})();
