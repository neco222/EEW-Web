export const CAMERA_MAX_DISTANCE_KM = 300;
export const CAMERA_EVENT_HOLD_MS = 10 * 60 * 1000;
export const CAMERA_SIDE_WIDTH = 336;
export const CAMERA_SHELF_HEIGHT = 310;

const position = value => value && typeof value.lat === 'number' && typeof value.lon === 'number' &&
  Number.isFinite(value.lat) && Number.isFinite(value.lon) && Math.abs(value.lat) <= 90 && Math.abs(value.lon) <= 180;

/** Great-circle distance. Both endpoints are public earthquake/camera locations. */
export function distanceKm(a, b) {
  if (!position(a) || !position(b)) return Infinity;
  const rad = Math.PI / 180;
  const lat = (b.lat - a.lat) * rad;
  const lon = (b.lon - a.lon) * rad;
  const hav = Math.sin(lat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(lon / 2) ** 2;
  return 6371.0088 * 2 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, hav))));
}

/** Only verified catalogue entries within the local radius can be auto-selected. */
export function rankCameras(earthquake, catalogue, {maxDistanceKm = CAMERA_MAX_DISTANCE_KM, limit = 5} = {}) {
  if (!position(earthquake) || !Array.isArray(catalogue) || !Number.isFinite(maxDistanceKm) || maxDistanceKm < 0 || !Number.isInteger(limit) || limit <= 0) return [];
  const seen = new Set();
  return catalogue.filter(camera => camera && position(camera) && /^[A-Za-z0-9_-]{11}$/.test(camera.videoId ?? '') &&
    typeof camera.sourceURL === 'string' && camera.sourceURL.startsWith('https://') && camera.label && camera.owner)
    .map(camera => ({...camera, distanceKm: distanceKm(earthquake, camera)}))
    .filter(camera => camera.distanceKm <= maxDistanceKm)
    .sort((a, b) => a.distanceKm - b.distanceKm || String(a.id).localeCompare(String(b.id)))
    .filter(camera => {if (seen.has(camera.videoId)) return false; seen.add(camera.videoId); return true;})
    .slice(0, limit);
}

/** Reserve real space outside the Scratch canvas. Never float over its history. */
export function cameraLayout({width, height, expanded, communityDetails = false, hasEvent = false}) {
  if (!expanded || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return {mode: 'off', side: 0, bottom: 0, video: false};
  if (width >= 960 && height >= 500) return {mode: 'side', side: CAMERA_SIDE_WIDTH, bottom: 0, video: hasEvent};
  // A narrow community drawer gets priority. Opening camera again closes that
  // drawer through its normal details/toggle event rather than stacking panels.
  if (communityDetails) return {mode: 'off', side: 0, bottom: 0, video: false};
  if (width >= 320 && height >= 690) return {mode: 'bottom', side: 0, bottom: CAMERA_SHELF_HEIGHT, video: hasEvent};
  // A 200px-high YouTube player would consume the warning/history area here.
  // Keep a source link and controls, and do not create a hidden background video.
  return {mode: 'compact', side: 0, bottom: Math.min(106, Math.max(0, height - 350)), video: false};
}

export function youtubeEmbedURL(videoId, origin) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId ?? '')) throw new TypeError('Invalid camera video ID');
  const host = new URL(origin);
  if (!['http:', 'https:'].includes(host.protocol)) throw new TypeError('An HTTP origin is required');
  const url = new URL(`https://www.youtube-nocookie.com/embed/${videoId}`);
  url.search = new URLSearchParams({enablejsapi: '1', origin: host.origin, playsinline: '1', controls: '1', autoplay: '1', mute: '1', rel: '0'}).toString();
  return url.href;
}
