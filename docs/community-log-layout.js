/** One reservation shared by cameras and reports; nothing floats over the map. */
export function communityLogLayout({width, height, cameraBottom = 0, cameraTop = 0, details = false}) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return {mode:'off', side:0, bottom:0, logHeight:0, top:0};
  }
  if (width >= 960 && height >= 500) {
    return {mode:details?'inline':'side', side:336, bottom:0, logHeight:0,
      top:Math.max(0, Math.min(height - 26 - 90, cameraTop))};
  }
  const available = Math.max(0, height - 26 - 330);
  if (details) {
    return {mode:'inline', side:0, bottom:Math.min(300, available), logHeight:100, top:0};
  }
  const camera = Math.max(0, Math.min(available, cameraBottom));
  const logHeight = Math.min(available - camera, Math.max(60, Math.min(144, height - 26 - camera - 400)));
  return {mode:'bottom', side:0, bottom:camera + logHeight, logHeight, top:0};
}
