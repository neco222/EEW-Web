import {projectPoint} from './viewer-bridge.js';

// Read-only geometry for the original viewer's stamped/pen-drawn map symbols.
// These are Stage lists, not rendered clones. Positions are native map units
// unless a source explicitly contains longitude/latitude.
const states = new WeakMap();
const EMPTY = Object.freeze([]);
const CLOUD_ID = 'w(#nQ9k*#@6t_FYZ-Ku=';
const GROUPS = ['ten:-', ...Array.from({length: 10}, (_, i) => `ten:${i}`)];
const LIST_NAMES = [
  '7システム設定', '#r:最新クラウド変数', 'map:表示する震度',
  '細分区域連番-変換', 'd 地名-コード全集', '5地震情報リスト',
  '5-4ID付き各点震度', 'd jms:x', 'd jms:y', '0EEW',
  'dtc:Xpix', 'dtc:Ypix', 'd ten:x', 'd ten:y', 'ten:震度',
  'sten:表示用', 'd sten:x', 'd sten:y', '9-1津波震源情報',
  '9-5各点津波観測状況', 'd tsta:x', 'd tsta:y', '9津波関連', ...GROUPS,
];

function numeric(value) {
  if (value === '' || value == null || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function binding(vm) {
  const runtime = vm?.runtime;
  if (!runtime) return null;
  let stage = runtime.targets?.[0];
  if (!stage?.isStage) stage = runtime.getTargetForStage?.();
  if (!stage?.variables) return null;
  let state = states.get(stage);
  if (!state || state.variables !== stage.variables) {
    const names = new Map(Object.entries(stage.variables).map(([id, variable]) => [variable.name, id]));
    state = {variables: stage.variables, names};
    states.set(stage, state);
  }
  const get = (name) => state.variables[state.names.get(name)]?.value;
  const list = (name) => {
    const value = name === '#r:最新クラウド変数'
      ? state.variables[CLOUD_ID]?.value ?? get(name) : get(name);
    return Array.isArray(value) ? value : EMPTY;
  };
  return {state, get, list};
}

/**
 * Return conservative occupied rectangles in canvas-local CSS pixels.
 *
 * The viewer stamps region/station icons into its pen layer, so renderer clone
 * bounds cannot identify them. Source: project.json target 地図 procedures
 * 地震情報スタンプ, 点描画系, 観測点描画, 震源スタンプ and 津波情報描画.
 * Region, detailed-station, active EEW, real-time station and tsunami symbols
 * receive a small clearance. Optional effects can extend beyond these bounds.
 *
 * Geometry, source sequence and data-list identity/length invalidate the cache;
 * a 250 ms maximum age also catches internal mutations without a new packet.
 * Repeated calls in a stationary animation frame do not scan all stations.
 * Treat the returned array/rectangles as read-only.
 */
export function readMapObstacles(vm, view) {
  if (!view?.camera || !view?.layout || !view?.stage || !view?.viewport) return [];
  const {camera, layout, viewport, stage} = view;
  if (![view.width, view.height, stage.width, stage.height, camera.x, camera.y,
    camera.zoom, layout.offsetX, layout.offsetY, layout.uiScale,
    viewport.left, viewport.top, viewport.right, viewport.bottom].every(Number.isFinite) ||
      stage.width <= 0 || stage.height <= 0 || camera.zoom <= 0 || layout.uiScale <= 0 ||
      viewport.right <= viewport.left || viewport.bottom <= viewport.top) return [];
  const bound = binding(vm);
  if (!bound) return [];
  const {state, get, list} = bound;
  const lists = new Map(LIST_NAMES.map(name => [name, list(name)]));
  const values = (name) => lists.get(name);
  const settings = values('7システム設定');
  const cloud = values('#r:最新クラウド変数');
  const mapMode = Number(view.mapMode ?? get('地図表示モード') ?? [2, 1, 3][Number(view.tab)]);
  const history = Math.max(0, Math.floor(Number(get('地図過去表示モード')) || 0));
  const signature = [view.width, view.height, stage.width, stage.height,
    camera.x, camera.y, camera.zoom, layout.offsetX, layout.offsetY, layout.uiScale,
    viewport.left, viewport.top, viewport.right, viewport.bottom,
    mapMode, history, get('描画更新-地図'), ...cloud.slice(0, 10),
    ...[9, 14, 16, 17, 20, 22, 23, 62, 78].map(index => settings[index])];
  for (const value of lists.values()) signature.push(value, value.length);
  const now = Date.now();
  if (state.signature?.length === signature.length && now - state.at < 250 &&
      signature.every((item, index) => Object.is(item, state.signature[index]))) return state.rectangles;

  const rectangles = [];
  const scaleX = view.width / stage.width;
  const scaleY = view.height / stage.height;
  const ui = layout.uiScale;
  const iconScale = Math.max(0.1, numeric(settings[16]) ?? 1);
  const iconBase = ui * (4 + Math.sqrt(camera.zoom)) * iconScale;

  function occupied(x, y, width, height, kind) {
    if (![x, y, width, height].every(Number.isFinite)) return;
    width = Math.max(4, width) + 8;
    height = Math.max(4, height) + 8;
    const left = x - width / 2, right = x + width / 2;
    const top = y - height / 2, bottom = y + height / 2;
    if (right < viewport.left || left > viewport.right ||
        bottom < viewport.top || top > viewport.bottom) return;
    rectangles.push({x, y, width, height, left, top, right, bottom, kind});
  }

  function native(x, y, width, height, kind, upwards = 0) {
    x = numeric(x); y = numeric(y);
    if (x === null || y === null) return;
    const stageX = (layout.offsetX + (x - camera.x) * camera.zoom) * ui;
    const stageY = (layout.offsetY + (y - camera.y) * camera.zoom) * ui;
    occupied(view.width / 2 + stageX * scaleX,
      view.height / 2 - stageY * scaleY - upwards * scaleY,
      width * scaleX, height * scaleY, kind);
  }

  function geographic(lon, lat, size, kind) {
    lon = numeric(lon); lat = numeric(lat);
    if (lon === null || lat === null) return;
    const point = projectPoint({lon, lat}, view);
    occupied(point.x, point.y, size * scaleX, size * scaleY, kind);
  }

  const earthquakes = values('5地震情報リスト');
  const eventOffset = history * 20;
  const stationOffset = numeric(earthquakes[eventOffset + 17]) ?? 0;
  const stationPreference = numeric(settings[22]) ?? 0;
  const detailed = mapMode === 2 && stationOffset > 0 && (stationPreference === 2 ||
    stationPreference === 1 && camera.zoom > 10 ** ((numeric(settings[78]) ?? 0) * 0.24 + 1));

  if (mapMode !== 3) {
    if (detailed) {
      const entries = values('5-4ID付き各点震度');
      const xs = values('d jms:x'), ys = values('d jms:y');
      for (let index = Math.floor(stationOffset); index < entries.length; index++) {
        const token = entries[index];
        if (String(token).startsWith('i')) break;
        const station = numeric(token);
        if (station === null || !Number.isInteger(station) || station <= 0) continue;
        native(xs[station - 1], ys[station - 1], 4.4 * iconBase, 4.4 * iconBase, 'station-intensity');
      }
    } else {
      const intensities = values('map:表示する震度');
      const serials = values('細分区域連番-変換');
      const names = values('d 地名-コード全集');
      for (let index = 0; index < Math.min(188, intensities.length, serials.length); index++) {
        if (!(numeric(intensities[index]) > 0)) continue;
        const record = (Number(serials[index]) - 1) * 8;
        const x = numeric(names[record + 5]), y = numeric(names[record + 6]);
        if (x === null || y === null) continue;
        native(x / 10, y / 10, 4.4 * iconBase, 4.4 * iconBase, 'region-intensity');
      }
    }
    if (mapMode === 2 && numeric(earthquakes[eventOffset + 7])) {
      geographic(earthquakes[eventOffset + 7], earthquakes[eventOffset + 8],
        28 * ui * iconScale, 'epicenter');
    }
    const eew = values('0EEW');
    for (let index = 0; index < Math.min(eew.length, 140); index += 14) {
      if (Math.abs(Number(eew[index])) !== 1) continue;
      geographic(eew[index + 5], eew[index + 6], 28 * ui * iconScale, 'eew-epicenter');
    }
  }

  // The original viewer's ten:* lists already select the drawn stations and
  // order them by intensity; do not scan every renderer target or clone.
  const stationStyle = numeric(settings[14]) ?? 1;
  if (stationStyle !== 5 || Number(settings[20]) === 2) {
    const xs = values('dtc:Xpix'), ys = values('dtc:Ypix');
    const longitude = values('d ten:x'), latitude = values('d ten:y');
    const intensity = values('ten:震度');
    const visited = new Set();
    const diameter = Math.min(10, iconScale * (mapMode === 3
      ? 1.1 * (0.6 + (camera.zoom * 3 + Math.sqrt(camera.zoom)) / 6)
      : 1.3 * (1.2 + (camera.zoom + Math.sqrt(camera.zoom)) / 3))) * ui;
    for (const name of GROUPS) {
      if (name === 'ten:-' && stationStyle === 6) continue;
      for (const token of values(name)) {
        if (token === '' || token == null) break;
        const index = Number(token) - 1;
        if (!Number.isInteger(index) || index < 0 || visited.has(index)) continue;
        visited.add(index);
        const level = numeric(intensity[index]);
        if (level === 0 && !settings[9]) continue;
        if (level !== 0 && stationStyle === 2 && settings[62] && !(level > 1)) continue;
        if (numeric(xs[index]) !== null && numeric(ys[index]) !== null) {
          native(xs[index], ys[index], diameter, diameter, 'realtime-station');
        } else geographic(longitude[index], latitude[index], diameter, 'realtime-station');
      }
    }
    if (settings[17]) {
      const seaX = values('d sten:x'), seaY = values('d sten:y');
      for (const token of values('sten:表示用')) {
        if (token === '' || token == null || Number(token) === -9) break;
        const index = Number(token) - 1;
        if (!Number.isInteger(index) || index < 0) continue;
        geographic(seaX[index], seaY[index], diameter, 'seafloor-station');
      }
    }
  }

  if (mapMode === 3) {
    const events = values('9-1津波震源情報');
    for (let offset = 0; offset < Math.min(events.length, 40); offset += 8) {
      if (!numeric(events[offset + 2])) continue;
      geographic(events[offset], events[offset + 1], 28 * ui * iconScale, 'tsunami-epicenter');
    }
    if (settings[23]) {
      const status = values('9津波関連');
      const stations = values('9-5各点津波観測状況');
      const xs = values('d tsta:x'), ys = values('d tsta:y');
      const peak = numeric(status[9]) ?? 0;
      const heightScale = peak > 5 ? 2.5 : peak > 3 ? 5 : peak > 1 ? 9.5 : 14;
      const size = 0.6 * iconBase;
      for (let index = 0; index < Math.min(xs.length, ys.length, Math.ceil(stations.length / 7)); index++) {
        const height = numeric(stations[index * 7 + 2]);
        if (height === null || (index < 200 ? !(Number(status[4]) > 0) : !(Number(status[5]) > 0))) continue;
        if (index < 200) {
          const rise = Math.max(0, size * (heightScale * height - 1));
          native(xs[index], ys[index], size * 1.75, rise + size * 1.75, 'tsunami-station', rise / 2);
        } else native(xs[index], ys[index], 2.8 * iconBase, 2.8 * iconBase, 'tsunami-station');
      }
    }
  }

  state.signature = signature;
  state.at = now;
  state.rectangles = rectangles;
  return rectangles;
}
