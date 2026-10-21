import {LIVE_CAMERAS} from './live-cameras.js';
import {distanceKm, rankCameras} from './camera-model.js';
import {CAMERA_MANUAL_HOLD_MS} from './camera-lifetime.js';

export {CAMERA_MANUAL_HOLD_MS};

const sourceKinds = new Set(['eew', 'earthquake', 'community']);

/**
 * Select an existing catalogue ID without changing a native/report session.
 * Standalone camera previews have their own fixed deadline; callers own the
 * player and must not restart a native lifetime when only selected changes.
 */
export function selectMapCamera(id, {current = null, choices = [], selected = null,
  manualUntil = null} = {}, catalog = LIVE_CAMERAS, now = Date.now()) {
  if (typeof id !== 'string' || !id || !Array.isArray(catalog) ||
      !Array.isArray(choices) || !Number.isFinite(now)) return null;
  const camera = catalog.find(item => item?.id === id);
  if (!camera) return null;
  // Reuse the normal player catalogue validation. An icon cannot supply a URL
  // or turn an invalid catalogue record into an embeddable camera.
  const canonical = rankCameras(camera, [camera], {maxDistanceKm: 0, limit: 1})[0];
  if (!canonical) return null;

  if (sourceKinds.has(current?.kind)) {
    const distance = distanceKm(current, camera);
    if (!Number.isFinite(distance)) return null;
    const existing = choices.find(item => item?.id === id);
    const choice = existing || {...camera, distanceKm: distance};
    return {current, choices: existing ? choices : [...choices, choice],
      selected: choice, manualUntil};
  }
  if (current !== null && current?.kind !== 'camera') return null;

  const samePreview = current?.manual === true && current.id === `camera:${id}` &&
    (!selected || selected.id === id) && Number.isFinite(manualUntil) && now < manualUntil &&
    Number.isFinite(current.time) && now >= current.time;
  const preview = samePreview ? current : {kind: 'camera', name: camera.label,
    id: `camera:${id}`, manual: true, lat: camera.lat, lon: camera.lon, time: now};
  const deadline = samePreview ? manualUntil : now + CAMERA_MANUAL_HOLD_MS;
  if (!Number.isFinite(deadline)) return null;
  let nearby = rankCameras(camera, catalog);
  let choice = nearby.find(item => item.id === id);
  if (!choice) {
    // Co-located providers can fill all five ranked places before this ID.
    // Preserve the explicit selection as well as four nearest alternatives.
    choice = canonical;
    nearby = [choice, ...nearby.slice(0, 4)];
  }
  return {current: preview, choices: nearby, selected: choice, manualUntil: deadline};
}
