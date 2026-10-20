import {installMapRenderEfficiency} from './map-render-efficiency.js';
// The VM keeps its original cadence; only map painting/presentation is limited.
const patched = new WeakMap();
const orderPatches = new WeakMap();

export function optimizeDrawableEffects(Drawable) {
  const prototype = Drawable?.prototype;
  if (!prototype || typeof prototype.updateEffect !== 'function') return null;
  if (patched.has(prototype)) return patched.get(prototype);
  const original = prototype.updateEffect;
  const values = new WeakMap();
  const stats = {effectWrites:0, repeatedEffectsSkipped:0};
  function updateEffect(effect, value) {
    let effects = values.get(this);
    if (effects?.has(effect) && Object.is(effects.get(effect), value)) {
      stats.repeatedEffectsSkipped++;
      return;
    }
    const result = original.call(this, effect, value);
    if (!effects) { effects = new Map(); values.set(this, effects); }
    effects.set(effect, value);
    stats.effectWrites++;
    return result;
  }
  prototype.updateEffect = updateEffect;
  const result = {stats, uninstall() { if (prototype.updateEffect === updateEffect) prototype.updateEffect = original; patched.delete(prototype); }};
  patched.set(prototype,result);
  return result;
}

export function optimizeFrontLayer(renderer) {
  if (!renderer || typeof renderer.setDrawableOrder !== 'function') return null;
  if (orderPatches.has(renderer)) return orderPatches.get(renderer);
  const original = renderer.setDrawableOrder;
  const stats = {repeatedFrontMovesSkipped:0};
  function setDrawableOrder(id, order, group, relative, minimum) {
    const list = this._drawList;
    const groups = this._groupOrdering;
    // Limit the shortcut to the final group; all other ordering operations
    // retain upstream's exact behavior and its original return value.
    if (order === Infinity && (relative === undefined || relative === false) &&
        (minimum === undefined || minimum === 0) && Array.isArray(list) &&
        Array.isArray(groups) && groups.length && group === groups[groups.length-1] &&
        this._layerGroups?.[group] && list.length && list[list.length-1] === id) {
      stats.repeatedFrontMovesSkipped++;
      return list.length;
    }
    return original.apply(this,arguments);
  }
  renderer.setDrawableOrder = setDrawableOrder;
  const result = {stats,uninstall(){if(renderer.setDrawableOrder===setDrawableOrder)renderer.setDrawableOrder=original;orderPatches.delete(renderer);}};
  orderPatches.set(renderer,result);
  return result;
}

export function installRuntimeEfficiency(vm) {
  const renderer = vm?.runtime?.renderer ?? vm?.renderer;
  const result = optimizeDrawableEffects(renderer?.exports?.Drawable);
  const order = optimizeFrontLayer(renderer);
  if (result && typeof document !== 'undefined') document.documentElement.dataset.eewEfficiency = 'active';
  if(result) result.order = order;
  if(result && (typeof location === 'undefined' || new URLSearchParams(location.search).get('cpuRender') !== '0')) result.map = installMapRenderEfficiency(vm);
  return result;
}
