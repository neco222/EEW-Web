import {projectPoint} from './viewer-bridge.js';

const SIZE = 24;
const MAX_CAMERAS = 25;
const MAX_OFFSET = 108;
const DIRECTIONS = [-90, -45, 0, 45, 90, 135, 180, -135]
  .map(angle => [Math.cos(angle * Math.PI / 180), Math.sin(angle * Math.PI / 180)]);

function rectangle(value) {
  if (!value || typeof value !== 'object') return null;
  const left = Number(value.left ?? value.x);
  const top = Number(value.top ?? value.y);
  const right = Number(value.right ?? (left + Number(value.width)));
  const bottom = Number(value.bottom ?? (top + Number(value.height)));
  return [left, top, right, bottom].every(Number.isFinite) && right > left && bottom > top ?
    {left, top, right, bottom, width: right - left, height: bottom - top} : null;
}

function overlaps(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

// Index native station/region rectangles once; each marker has only 41 local
// candidate positions. Large or duplicated source rectangles stay bounded.
class ObstacleGrid {
  constructor(bounds) {
    this.bounds = bounds;
    this.size = Math.max(48, Math.ceil(Math.max(bounds.width, bounds.height) / 64));
    this.cells = new Map();
    this.seen = new Set();
  }

  range(rect) {
    return [Math.floor((rect.left - this.bounds.left) / this.size),
      Math.floor((rect.top - this.bounds.top) / this.size),
      Math.floor((rect.right - this.bounds.left) / this.size),
      Math.floor((rect.bottom - this.bounds.top) / this.size)];
  }

  add(value, padding = 0) {
    const rect = {left: Math.max(this.bounds.left, value.left - padding),
      top: Math.max(this.bounds.top, value.top - padding),
      right: Math.min(this.bounds.right, value.right + padding),
      bottom: Math.min(this.bounds.bottom, value.bottom + padding)};
    if (rect.right <= rect.left || rect.bottom <= rect.top) return;
    const signature = `${rect.left},${rect.top},${rect.right},${rect.bottom}`;
    if (this.seen.has(signature)) return;
    this.seen.add(signature);
    const [x1, y1, x2, y2] = this.range(rect);
    for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) {
      const key = `${x},${y}`;
      let cell = this.cells.get(key);
      if (!cell) this.cells.set(key, cell = []);
      cell.push(rect);
    }
  }

  collides(rect) {
    const [x1, y1, x2, y2] = this.range(rect);
    for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) {
      for (const obstacle of this.cells.get(`${x},${y}`) ?? []) {
        if (overlaps(rect, obstacle)) return true;
      }
    }
    return false;
  }
}

function* offsets() {
  yield [0, 0];
  for (const radius of [24, 36, 60, 84, 108]) {
    for (const [dx, dy] of DIRECTIONS) yield [dx * radius, dy * radius];
  }
}

function place(anchor, bounds, grid) {
  const tried = new Set();
  for (const [dx, dy] of offsets()) {
    const x = Math.max(bounds.left, Math.min(bounds.right - SIZE, anchor.x + dx - SIZE / 2));
    const y = Math.max(bounds.top, Math.min(bounds.bottom - SIZE, anchor.y + dy - SIZE / 2));
    const signature = `${x.toFixed(3)},${y.toFixed(3)}`;
    if (tried.has(signature)) continue;
    tried.add(signature);
    // Clamping must not turn a nearby icon into a distant, misleading location.
    if (Math.hypot(x + SIZE / 2 - anchor.x, y + SIZE / 2 - anchor.y) > MAX_OFFSET + 1e-8) continue;
    const rect = {left: x, top: y, right: x + SIZE, bottom: y + SIZE};
    if (!grid.collides(rect)) return {x, y, ...rect};
  }
  return null;
}

/**
 * Place at most 25 catalogue cameras, with the active camera first. All output
 * coordinates are CSS pixels relative to the native canvas. x/y is the icon's
 * top-left; anchor is its unchanged geographic projection for a short leader.
 *
 * Catalogue points are approximate-scene representative points, not surveyed
 * camera installations. The caller owns that label, selection, playback and
 * redraw scheduling. This function has no DOM, VM, clocks or network access.
 * Existing native symbols, caller-supplied report bubbles and map controls win;
 * icons with no nearby free position are omitted rather than covering them.
 */
export function layoutCameraMarkers(cameras, view, obstacles = [], {activeId = null} = {}) {
  if (!Array.isArray(cameras) || !view?.camera || !view?.layout || !view?.stage) return [];
  const {camera, layout, stage} = view;
  if (![view.width, view.height, stage.width, stage.height, camera.x, camera.y,
    camera.zoom, layout.offsetX, layout.offsetY, layout.uiScale].every(Number.isFinite) ||
      view.width <= 0 || view.height <= 0 || stage.width <= 0 || stage.height <= 0 ||
      camera.zoom <= 0 || layout.uiScale <= 0) return [];
  const originalViewport = rectangle(view.viewport);
  if (!originalViewport) return [];
  const viewport = rectangle({left: Math.max(0, originalViewport.left), top: Math.max(0, originalViewport.top),
    right: Math.min(view.width, originalViewport.right), bottom: Math.min(view.height, originalViewport.bottom)});
  if (!viewport) return [];
  const scaleX = Math.max(1, layout.uiScale * view.width / stage.width);
  const scaleY = Math.max(1, layout.uiScale * view.height / stage.height);
  const bounds = rectangle({left: viewport.left + 30 * scaleX, top: viewport.top + 34 * scaleY,
    right: viewport.right, bottom: viewport.bottom});
  if (!bounds || bounds.width < SIZE || bounds.height < SIZE) return [];
  const grid = new ObstacleGrid(viewport);
  // Native zoom/reset controls occupy the lower-left map corner. The full
  // left strip and top clock are excluded through bounds above as well.
  grid.add({left: viewport.left, top: viewport.bottom - 116 * scaleY,
    right: viewport.left + 44 * scaleX, bottom: viewport.bottom});
  for (const obstacle of Array.isArray(obstacles) ? obstacles : []) {
    const rect = rectangle(obstacle);
    if (rect) grid.add(rect, 3);
  }
  const ordered = cameras.slice(0, MAX_CAMERAS).map((item, index) => ({item, index}))
    .sort((a, b) => Number(b.item?.id === activeId) - Number(a.item?.id === activeId) || a.index - b.index);
  const seen = new Set();
  const result = [];
  const projectionView = {...view, viewport};
  for (const {item} of ordered) {
    if (!item || typeof item.id !== 'string' || !item.id || seen.has(item.id) ||
        item.lon == null || item.lon === '' || Math.abs(Number(item.lon)) > 180) continue;
    const point = projectPoint(item, projectionView);
    if (!point.visible) continue;
    seen.add(item.id);
    const anchor = {x: point.x, y: point.y};
    const placement = place(anchor, bounds, grid);
    if (!placement) continue;
    result.push({id: item.id, key: item.id, camera: item, ...placement,
      width: SIZE, height: SIZE, anchor, active: item.id === activeId});
    grid.add(placement);
  }
  return result;
}
