import {projectPoint} from './viewer-bridge.js';

const WIDTH = 128;
const HEIGHT = 48;
const GAP = 6;
const MAX_BUBBLES = 8;
const MERGE_DISTANCE = 32;
const DIRECTIONS = [-90, -45, -135, 0, 180, 45, 135, 90, -67.5, -112.5, -22.5, -157.5, 22.5, 157.5, 67.5, 112.5]
  .map(angle => [Math.cos(angle * Math.PI / 180), Math.sin(angle * Math.PI / 180)]);

function rectangle(value) {
  if (!value || typeof value !== 'object') return null;
  const left = Number(value.left ?? value.x);
  const top = Number(value.top ?? value.y);
  const right = Number(value.right ?? (left + Number(value.width)));
  const bottom = Number(value.bottom ?? (top + Number(value.height)));
  if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top) return null;
  return {left, top, right, bottom, width: right - left, height: bottom - top};
}

function intersects(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

class ObstacleGrid {
  constructor(bounds) {
    this.bounds = bounds;
    this.size = Math.max(64, Math.ceil(Math.max(bounds.width, bounds.height) / 64));
    this.cells = new Map();
    this.entries = new Set();
  }

  cellsFor(rect) {
    return {
      x1: Math.floor((rect.left - this.bounds.left) / this.size),
      x2: Math.floor((rect.right - this.bounds.left) / this.size),
      y1: Math.floor((rect.top - this.bounds.top) / this.size),
      y2: Math.floor((rect.bottom - this.bounds.top) / this.size),
    };
  }

  add(value, padding = GAP) {
    const rect = {
      left: Math.max(this.bounds.left, value.left - padding),
      top: Math.max(this.bounds.top, value.top - padding),
      right: Math.min(this.bounds.right, value.right + padding),
      bottom: Math.min(this.bounds.bottom, value.bottom + padding),
    };
    if (rect.right <= rect.left || rect.bottom <= rect.top) return;
    const signature = `${rect.left},${rect.top},${rect.right},${rect.bottom}`;
    if (this.entries.has(signature)) return;
    this.entries.add(signature);
    const range = this.cellsFor(rect);
    for (let y = range.y1; y <= range.y2; y++) {
      for (let x = range.x1; x <= range.x2; x++) {
        const key = `${x},${y}`;
        let cell = this.cells.get(key);
        if (!cell) this.cells.set(key, cell = []);
        cell.push(rect);
      }
    }
  }

  collides(rect) {
    const seen = new Set();
    const range = this.cellsFor(rect);
    for (let y = range.y1; y <= range.y2; y++) {
      for (let x = range.x1; x <= range.x2; x++) {
        const cell = this.cells.get(`${x},${y}`);
        if (!cell) continue;
        for (const obstacle of cell) {
          if (seen.has(obstacle)) continue;
          seen.add(obstacle);
          if (intersects(rect, obstacle)) return true;
        }
      }
    }
    return false;
  }
}

function groupsFor(posts, view) {
  const valid = [];
  const seenKeys = new Set();
  for (const post of posts) {
    if (!post || typeof post !== 'object' || post.lat == null || post.lon == null) continue;
    const count = Number(post.count);
    if (!Number.isSafeInteger(count) || count <= 0) continue;
    const key = String(post.key ?? post.code ?? '');
    if (!key || seenKeys.has(key)) continue;
    const anchor = projectPoint(post, view);
    if (!anchor.visible) continue;
    seenKeys.add(key);
    valid.push({post, key, count, anchor: {x: anchor.x, y: anchor.y}, expiresAt: Number(post.expiresAt) || 0});
  }
  valid.sort((a, b) => b.expiresAt - a.expiresAt || a.key.localeCompare(b.key));

  const groups = [];
  for (const item of valid) {
    // Keep each cluster close to its representative map point. Unlike a moving
    // average, this anchor remains an exact projection of a real report region.
    const group = groups.find(value =>
      Math.hypot(value.anchor.x - item.anchor.x, value.anchor.y - item.anchor.y) <= MERGE_DISTANCE &&
      Number.isSafeInteger(value.count + item.count));
    if (group) {
      group.items.push(item);
      group.count += item.count;
    } else {
      groups.push({anchor: item.anchor, count: item.count, items: [item]});
    }
  }
  return groups;
}

function samples(start, end, step, maximum = 64) {
  const count = Math.min(maximum, Math.max(1, Math.ceil((end - start) / step)));
  return Array.from({length: count + 1}, (_, index) => start + (end - start) * index / count);
}

function* positions(anchor, bounds) {
  const diagonal = Math.hypot(bounds.width, bounds.height);
  const distances = [38, 64, 96, 144, 208, 288, 400, 560, 784].filter(value => value < diagonal);
  distances.push(diagonal);
  for (const distance of distances) {
    for (const [dx, dy] of DIRECTIONS) {
      yield {x: anchor.x + dx * distance - WIDTH / 2, y: anchor.y + dy * distance - HEIGHT / 2};
    }
  }

  // Longer leaders can reach the outer free space when dense native intensity
  // labels surround the report's geographic anchor.
  const edges = [];
  for (const x of samples(bounds.left, bounds.right - WIDTH, 24)) {
    edges.push({x, y: bounds.top}, {x, y: bounds.bottom - HEIGHT});
  }
  for (const y of samples(bounds.top, bounds.bottom - HEIGHT, 20)) {
    edges.push({x: bounds.left, y}, {x: bounds.right - WIDTH, y});
  }
  const distance = point => (point.x + WIDTH / 2 - anchor.x) ** 2 + (point.y + HEIGHT / 2 - anchor.y) ** 2;
  edges.sort((a, b) => distance(a) - distance(b));
  yield* edges;

  // Search interior gaps as well, with bounded work even for very large canvases.
  const gaps = [];
  for (const y of samples(bounds.top, bounds.bottom - HEIGHT, 24, 48)) {
    for (const x of samples(bounds.left, bounds.right - WIDTH, 32, 48)) gaps.push({x, y});
  }
  gaps.sort((a, b) => distance(a) - distance(b));
  yield* gaps;
}

function place(anchor, bounds, grid) {
  const tried = new Set();
  for (const point of positions(anchor, bounds)) {
    const x = Math.max(bounds.left, Math.min(bounds.right - WIDTH, point.x));
    const y = Math.max(bounds.top, Math.min(bounds.bottom - HEIGHT, point.y));
    const signature = `${x.toFixed(3)},${y.toFixed(3)}`;
    if (tried.has(signature)) continue;
    tried.add(signature);
    const candidate = {left: x, top: y, right: x + WIDTH, bottom: y + HEIGHT};
    // Always test after clamping: moving a bubble inside the viewport can move
    // it back onto an intensity label or an already placed bubble.
    if (!grid.collides(candidate)) return {x, y, ...candidate};
  }
  return null;
}

/**
 * Lay out live report bubbles without mutating posts, view, or obstacles.
 * x/y, anchor, and all rectangles are canvas-local CSS pixels. Expiration is
 * managed by the caller; this pure function never reads the wall clock.
 * Unplaceable/overflow groups are omitted so the footer can retain their totals.
 */
export function layoutReportBubbles(posts, view, obstacles = []) {
  if (!Array.isArray(posts) || !view?.camera || !view?.layout || !view?.stage) return [];
  const viewport = rectangle(view.viewport);
  if (!viewport) return [];
  const bounds = {
    left: viewport.left + 30,
    top: viewport.top + 34,
    right: viewport.right,
    bottom: viewport.bottom,
    width: viewport.width - 30,
    height: viewport.height - 34,
  };
  if (bounds.width < WIDTH || bounds.height < HEIGHT) return [];
  const grid = new ObstacleGrid(viewport);
  // Protect the existing tab strip and clock regardless of native obstacle data.
  grid.add({left: viewport.left, top: viewport.top, right: bounds.left, bottom: viewport.bottom}, 0);
  grid.add({left: viewport.left, top: viewport.top, right: viewport.right, bottom: bounds.top}, 0);
  for (const obstacle of Array.isArray(obstacles) ? obstacles : []) {
    const normalized = rectangle(obstacle);
    if (normalized) grid.add(normalized);
  }

  const result = [];
  for (const group of groupsFor(posts, view).slice(0, MAX_BUBBLES)) {
    const placement = place(group.anchor, bounds, grid);
    if (!placement) continue;
    const primary = group.items[0].post;
    const keys = group.items.map(item => item.key).sort();
    const codes = [...new Set(group.items.map(item => item.post.code))];
    const names = [...new Set(group.items.map(item => String(item.post.name ?? item.post.code ?? '揺れ報告')))];
    result.push({
      ...placement,
      key: keys.length === 1 ? keys[0] : `group:${keys.map(encodeURIComponent).join('|')}`,
      width: WIDTH,
      height: HEIGHT,
      anchor: {...group.anchor},
      count: group.count,
      name: names.length === 1 ? names[0] : `${names[0]} ほか${names.length - 1}地域`,
      code: primary.code,
      lat: primary.lat,
      lon: primary.lon,
      expiresAt: Math.max(...group.items.map(item => item.expiresAt)),
      keys,
      codes,
      posts: group.items.map(item => item.post),
    });
    grid.add(placement);
  }
  return result;
}
