/**
 * Read-only bridge to the packaged Scratch viewer.
 *
 * All public x/y coordinates and viewport rectangles use CSS pixels relative to
 * the existing viewer canvas's top-left corner, not its backing-store pixels.
 * The caller can position a pointer-events:none overlay using canvasRect and
 * clip its drawing to viewport without intercepting the viewer's map controls.
 *
 * Projection source: docs/assets/project.json, target "地図", procedures
 * "座標変換：タイプ別" (blocks ;R, bu|, ;U, bvu) and "カメラ上で" (q]).
 */

const RADIANS = Math.PI / 180;
const MERCATOR_SCALE = 572.9577951308232;
const MERCATOR_OFFSET = 374.04780730560344;

const VARIABLES = {
  camera: ["/[;m=*u~4dVLN3LnqEul", "1カメラ系"],
  screen: ["8;}F65,+Ug?ETb7A:5TJ", "3画面設定系"],
  tab: ["17rtPHAX9|+t}}[U,|`R", "タブ"],
  mode: ["MQ)ENXr.rTAi;Dt^s(mk", "画面サイズモード"],
  mapMode: ["cOE)RT$1^[}M~v,_zl5i", "地図表示モード"],
  dialog: ["J1Wp~*zS5Y_O!z(~K:1I", "ダイアログなう"],
};

const stageBindings = new WeakMap();
const variableNames = new WeakMap();

function findStage(runtime) {
  const targets = runtime.targets;
  const cached = stageBindings.get(runtime);
  if (cached && targets?.[cached.index] === cached.stage) {
    return cached.stage;
  }

  // The stage is first in this project, including when there are many clones.
  // Only look through targets when loading or replacing an unusual project.
  let stage = targets?.[0];
  let index = 0;
  if (!stage?.isStage) {
    stage = runtime.getTargetForStage?.();
    if (!stage && targets) stage = targets.find((target) => target.isStage);
    index = stage && targets ? targets.indexOf(stage) : -1;
  }
  if (!stage?.variables) return null;

  stageBindings.set(runtime, { stage, index });
  return stage;
}

function variable(variables, [id, name]) {
  // Resolve the current object each time: Scratch can replace a Variable or its
  // value array when loading a project or resetting the viewer.
  if (variables[id]) return variables[id];

  // A one-time name index supports project copies whose variable IDs differ.
  // Keep IDs rather than object references so replacements remain observable.
  let names = variableNames.get(variables);
  if (!names) {
    names = new Map(
      Object.entries(variables).map(([key, value]) => [value.name, key]),
    );
    variableNames.set(variables, names);
  }
  return variables[names.get(name)];
}

function rect(left, top, right, bottom) {
  return {
    x: left,
    y: top,
    left,
    top,
    right,
    bottom,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

function latitudeForMapY(y) {
  return (
    (2 * Math.atan(Math.exp((y + MERCATOR_OFFSET) / MERCATOR_SCALE))) /
      RADIANS -
    90
  );
}

function geometrySettled(layout, mapViewport, width, height, scaleX) {
  const near = (actual, expected) => Math.abs(actual - expected) <= 1;
  // Source UI procedure 画面サイズ更新 always aligns the map's top/right
  // edges with the stage in both layouts. Scaffolding resizes the stage and
  // canvas synchronously; these Scratch list values can lag for a frame or two.
  if (!near(mapViewport.top, 0) || !near(mapViewport.right, width)) return false;
  if (layout.mode === "w") {
    return near(mapViewport.left, 120 * layout.uiScale * scaleX) &&
      near(mapViewport.bottom, height);
  }
  if (layout.mode === "s") {
    // Portrait blocks ~_, ~`, aaa: offsetY + halfHeight = stageHalfHeight /
    // uiScale; the remaining map height is 3/4 * (1 - .04 * uiScale).
    return near(mapViewport.left, 0) &&
      near(mapViewport.bottom, height * 0.75 * (1 - 0.04 * layout.uiScale));
  }
  return false;
}

/**
 * Snapshot the live camera and map viewport; return null until they are ready.
 *
 * camera and bounds.world use the original map's internal coordinate system.
 * layout uses the source lists' values before multiplying by uiScale. The
 * geographic bounds' longitudes are unwrapped around 136 degrees east.
 * tab, mapMode, and dialog expose source state for the caller's display policy.
 * settled is false while stage/canvas resizing and the source UI layout lists
 * disagree. Existing callers can still read the snapshot during that transition.
 */
export function readView(vm = globalThis.vm, scaffolding = globalThis.scaffolding) {
  const runtime = vm?.runtime;
  if (!runtime || typeof runtime !== "object") return null;
  const stage = findStage(runtime);
  if (!stage) return null;

  const values = stage.variables;
  const cameraList = variable(values, VARIABLES.camera)?.value;
  const screen = variable(values, VARIABLES.screen)?.value;
  if (!Array.isArray(cameraList) || !Array.isArray(screen)) return null;

  // Scratch list positions are 1-based. Use the current zoom in item 3,
  // rather than the animation's target zoom in item 6.
  const camera = {
    x: Number(cameraList[0]),
    y: Number(cameraList[1]),
    zoom: Number(cameraList[2]),
  };
  const layout = {
    mode: String(variable(values, VARIABLES.mode)?.value ?? ""),
    offsetX: Number(screen[0]),
    offsetY: Number(screen[1]),
    halfWidth: Number(screen[2]),
    halfHeight: Number(screen[3]),
    uiScale: Number(screen[5]),
  };
  const stageSize = {
    width: Number(runtime.stageWidth ?? scaffolding?.width),
    height: Number(runtime.stageHeight ?? scaffolding?.height),
  };
  if (
    ![
      camera.x,
      camera.y,
      camera.zoom,
      layout.offsetX,
      layout.offsetY,
      layout.halfWidth,
      layout.halfHeight,
      layout.uiScale,
      stageSize.width,
      stageSize.height,
    ].every(Number.isFinite) ||
    camera.zoom <= 0 ||
    layout.uiScale <= 0 ||
    layout.halfWidth <= 0 ||
    layout.halfHeight <= 0 ||
    stageSize.width <= 0 ||
    stageSize.height <= 0
  ) {
    return null;
  }

  const canvas =
    scaffolding?._canvas ?? vm.renderer?.canvas ?? runtime.renderer?.canvas;
  const measured = canvas?.getBoundingClientRect?.() ?? scaffolding?.layersRect;
  if (
    !measured ||
    !Number.isFinite(measured.width) ||
    !Number.isFinite(measured.height) ||
    measured.width <= 0 ||
    measured.height <= 0
  ) {
    return null;
  }
  const width = measured.width;
  const height = measured.height;
  const left = Number(measured.left ?? measured.x ?? 0);
  const top = Number(measured.top ?? measured.y ?? 0);
  const canvasRect = rect(left, top, left + width, top + height);
  const scaleX = width / stageSize.width;
  const scaleY = height / stageSize.height;
  const mapViewport = rect(
    width / 2 + (layout.offsetX - layout.halfWidth) * layout.uiScale * scaleX,
    height / 2 - (layout.offsetY + layout.halfHeight) * layout.uiScale * scaleY,
    width / 2 + (layout.offsetX + layout.halfWidth) * layout.uiScale * scaleX,
    height / 2 - (layout.offsetY - layout.halfHeight) * layout.uiScale * scaleY,
  );
  const clampX = (x) => Math.max(0, Math.min(width, x));
  const clampY = (y) => Math.max(0, Math.min(height, y));
  const viewport = rect(
    clampX(mapViewport.left),
    clampY(mapViewport.top),
    clampX(mapViewport.right),
    clampY(mapViewport.bottom),
  );
  const world = {
    left: camera.x - layout.halfWidth / camera.zoom,
    right: camera.x + layout.halfWidth / camera.zoom,
    bottom: camera.y - layout.halfHeight / camera.zoom,
    top: camera.y + layout.halfHeight / camera.zoom,
  };

  return {
    coordinateSpace: "canvas-css-pixels",
    canvas,
    canvasRect,
    width,
    height,
    viewport,
    mapViewport,
    settled: geometrySettled(layout, mapViewport, width, height, scaleX),
    stage: stageSize,
    camera,
    layout,
    tab: variable(values, VARIABLES.tab)?.value,
    mapMode: variable(values, VARIABLES.mapMode)?.value,
    dialog: variable(values, VARIABLES.dialog)?.value,
    bounds: {
      world,
      west: world.left / 10 + 136,
      east: world.right / 10 + 136,
      south: latitudeForMapY(world.bottom),
      north: latitudeForMapY(world.top),
    },
  };
}

/** Project a geographic point into canvas-local CSS pixels. */
export function projectPoint(point, view) {
  const invalid = { x: NaN, y: NaN, visible: false };
  if (!view || point?.lat == null || point?.lon == null) return invalid;
  if (point.lat === "" || point.lon === "") return invalid;
  const lat = Number(point.lat);
  const lon = Number(point.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) >= 90) {
    return invalid;
  }

  // Scratch's modulo is non-negative, including for western longitudes.
  const mapX = ((((lon + 44) % 360) + 360) % 360 - 180) * 10;
  const mapY =
    Math.log(Math.tan((45 + lat / 2) * RADIANS)) * MERCATOR_SCALE -
    MERCATOR_OFFSET;
  const { camera, layout, stage, viewport } = view;
  const stageX =
    (layout.offsetX + (mapX - camera.x) * camera.zoom) * layout.uiScale;
  const stageY =
    (layout.offsetY + (mapY - camera.y) * camera.zoom) * layout.uiScale;
  const x = (stageX / stage.width + 0.5) * view.width;
  const y = (0.5 - stageY / stage.height) * view.height;
  const visible =
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    viewport.width > 0 &&
    viewport.height > 0 &&
    x >= viewport.left &&
    x <= viewport.right &&
    y >= viewport.top &&
    y <= viewport.bottom;
  return { x, y, visible };
}
