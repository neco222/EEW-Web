import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { projectPoint, readView } from "../docs/viewer-bridge.js";

const project = JSON.parse(
  fs.readFileSync(new URL("../docs/assets/project.json", import.meta.url), "utf8"),
);
const originalStage = project.targets.find((target) => target.isStage);
const mapBlocks = project.targets.find((target) => target.name === "地図").blocks;
const usedNames = new Set([
  "1カメラ系",
  "3画面設定系",
  "タブ",
  "画面サイズモード",
  "地図表示モード",
  "ダイアログなう",
]);

function fixture({ width = 480, height = 360, cssScale = 1 } = {}) {
  const variables = {};
  for (const [id, [name, value]] of Object.entries({
    ...originalStage.variables,
    ...originalStage.lists,
  })) {
    if (usedNames.has(name)) {
      variables[id] = { name, value: structuredClone(value) };
    }
  }
  const stage = { isStage: true, variables };
  const canvas = {
    width: width * 4,
    height: height * 4,
    getBoundingClientRect: () => ({
      left: 25,
      top: 40,
      width: width * cssScale,
      height: height * cssScale,
    }),
  };
  const vm = { runtime: { stageWidth: width, stageHeight: height, targets: [stage] } };
  const scaffolding = { _canvas: canvas, width, height };
  const get = (name) => Object.values(stage.variables).find((v) => v.name === name);
  return { vm, scaffolding, stage, canvas, get };
}

function close(actual, expected, message = "") {
  assert.ok(Math.abs(actual - expected) < 1e-8, `${message}: ${actual} != ${expected}`);
}

// Evaluate the original Scratch expressions, rather than repeating the helper's
// projection. This catches changes to upstream constants and list positions.
function sourceExpression(id, context, blocks = mapBlocks) {
  const block = blocks[id];
  const input = (name) => {
    const value = block.inputs[name][1];
    if (Array.isArray(value)) {
      return value[0] === 12 ? context.values[value[1]] : value[1];
    }
    return sourceExpression(value, context, blocks);
  };
  switch (block.opcode) {
    case "argument_reporter_string_number":
      return context.arguments[block.fields.VALUE[0]];
    case "data_itemoflist":
      return context.values[block.fields.LIST[0]][Number(input("INDEX")) - 1];
    case "operator_add":
      return Number(input("NUM1")) + Number(input("NUM2"));
    case "operator_subtract":
      return Number(input("NUM1")) - Number(input("NUM2"));
    case "operator_multiply":
      return Number(input("NUM1")) * Number(input("NUM2"));
    case "operator_divide":
      return Number(input("NUM1")) / Number(input("NUM2"));
    case "operator_mod": {
      const a = Number(input("NUM1"));
      const b = Number(input("NUM2"));
      return ((a % b) + b) % b;
    }
    case "operator_mathop": {
      const value = Number(input("NUM"));
      if (block.fields.OPERATOR[0] === "ln") return Math.log(value);
      if (block.fields.OPERATOR[0] === "tan") return Math.tan((value * Math.PI) / 180);
      throw new Error(`Unsupported source math operation: ${block.fields.OPERATOR[0]}`);
    }
    default:
      throw new Error(`Unsupported source opcode: ${block.opcode}`);
  }
}

function sourceInput(blockId, name, context, blocks = mapBlocks) {
  const value = blocks[blockId].inputs[name][1];
  if (Array.isArray(value)) return value[0] === 12 ? context.values[value[1]] : value[1];
  return sourceExpression(value, context, blocks);
}

function sourceLayout(setup, mode, uiScale) {
  const blocks = project.targets.find((target) => target.name === "UI").blocks;
  const screen = setup.get("3画面設定系").value;
  screen[5] = uiScale;
  const context = {
    arguments: {},
    values: {
      "3画面設定系": screen,
      "@3 xyキャッシュ": [
        setup.vm.runtime.stageWidth / 2 / uiScale,
        setup.vm.runtime.stageHeight / 2 / uiScale,
      ],
    },
  };
  // Evaluate the actual source UI assignments instead of deriving expected
  // geometry from the bridge's consistency checks.
  const assignments = mode === "w" ? ["bS%", "bS@", "aaj", "aak"] : ["bS#", "~_", "~`", "aaa"];
  assignments.forEach((id, index) => { screen[index] = Number(sourceInput(id, "ITEM", context, blocks)); });
  screen[10] = setup.vm.runtime.stageWidth / 2;
  screen[11] = setup.vm.runtime.stageHeight / 2;
  setup.get("画面サイズモード").value = mode;
}

function originalProjection(point, setup) {
  const context = {
    arguments: { x: point.lon, y: point.lat },
    values: {
      "1カメラ系": setup.get("1カメラ系").value,
      "3画面設定系": setup.get("3画面設定系").value,
      xy相互変換: [],
    },
  };
  const mapX = sourceInput(";R", "ITEM", context);
  const mapY = sourceInput("bu|", "ITEM", context);
  context.arguments = { x: mapX, y: mapY };
  context.values.xy相互変換[4] = sourceInput(";U", "ITEM", context);
  context.values.xy相互変換[5] = sourceInput("bvu", "ITEM", context);
  const stageX = sourceInput("q]", "X", context);
  const stageY = sourceInput("q]", "Y", context);
  const measured = setup.canvas.getBoundingClientRect();
  return {
    x: (stageX / setup.vm.runtime.stageWidth + 0.5) * measured.width,
    y: (0.5 - stageY / setup.vm.runtime.stageHeight) * measured.height,
  };
}

test("matches the original project's saved conversion example", () => {
  const setup = fixture();
  const saved = Object.values(originalStage.lists).find(([name]) => name === "xy相互変換")[1];
  const view = readView(setup.vm, setup.scaffolding);
  const projected = projectPoint({ lon: saved[0], lat: saved[1] }, view);
  // Original example: internal (57.6,-100.8), camera (16,41,1.8),
  // camera-relative (74.88,-255.24), map offset (60,0).
  close(projected.x, 374.88);
  close(projected.y, 435.24);
  assert.equal(projected.visible, false);
  assert.equal(view.coordinateSpace, "canvas-css-pixels");
  assert.deepEqual(view.viewport, {
    x: 120, y: 0, left: 120, top: 0, right: 480, bottom: 360, width: 360, height: 360,
  });
});

test("matches actual Scratch block expressions for station locations and western longitudes", () => {
  const setup = fixture();
  const lists = Object.fromEntries(Object.values(originalStage.lists));
  const points = [0, 500, 900, 1747].map((index) => ({
    lon: lists["d ten:x"][index],
    lat: lists["d ten:y"][index],
  }));
  points.push({ lon: -155, lat: 19 }, { lon: -170, lat: -30 });
  const view = readView(setup.vm, setup.scaffolding);
  for (const point of points) {
    const expected = originalProjection(point, setup);
    const actual = projectPoint(point, view);
    close(actual.x, expected.x);
    close(actual.y, expected.y);
  }
});

test("follows live pan and current animated zoom without changing the viewer", () => {
  const setup = fixture();
  const point = { lon: 139.6917, lat: 35.6895 };
  const before = projectPoint(point, readView(setup.vm, setup.scaffolding));
  const camera = setup.get("1カメラ系").value;
  camera[0] += 10;
  camera[1] -= 5;
  const panned = projectPoint(point, readView(setup.vm, setup.scaffolding));
  close(panned.x - before.x, -18);
  close(panned.y - before.y, -9);

  camera[2] = 3.2;
  camera[5] = 99; // This is the requested zoom, not the displayed zoom.
  const snapshot = structuredClone(setup.stage.variables);
  const projected = projectPoint(point, readView(setup.vm, setup.scaffolding));
  const expected = originalProjection(point, setup);
  close(projected.x, expected.x);
  close(projected.y, expected.y);
  assert.deepEqual(setup.stage.variables, snapshot);
});

test("tracks portrait map placement and UI scaling using the live screen list", () => {
  const setup = fixture({ width: 390, height: 844 });
  const uiScale = 1.5;
  const halfWidth = 195 / uiScale;
  const halfHeight = 422 / uiScale;
  // These values are set by source UI procedure 画面サイズ更新 (blocks ~_, aaa).
  const topFraction = 0.04 * uiScale;
  setup.get("3画面設定系").value = [
    0,
    (halfHeight * (1 - topFraction)) / 4 + halfHeight * topFraction,
    halfWidth,
    (halfHeight * (1 - topFraction) * 3) / 4,
    15,
    uiScale,
  ];
  setup.get("画面サイズモード").value = "s";
  const view = readView(setup.vm, setup.scaffolding);
  close(view.viewport.left, 0);
  close(view.viewport.top, 0);
  close(view.viewport.width, 390);
  close(view.viewport.height, 844 * 0.705);
  assert.equal(view.layout.mode, "s");
  const point = { lon: 139.6917, lat: 35.6895 };
  const expected = originalProjection(point, setup);
  const actual = projectPoint(point, view);
  close(actual.x, expected.x);
  close(actual.y, expected.y);
});

test("uses CSS size independently from stage size, backing pixels, and page position", () => {
  const setup = fixture({ cssScale: 2 });
  const view = readView(setup.vm, setup.scaffolding);
  assert.deepEqual(view.canvasRect, {
    x: 25, y: 40, left: 25, top: 40, right: 985, bottom: 760, width: 960, height: 720,
  });
  const projected = projectPoint({ lon: 141.76, lat: 26.344250361649102 }, view);
  close(projected.x, 749.76);
  close(projected.y, 870.48);
  close(view.viewport.left, 240);
});

test("clips points to the map area and reports matching geographic bounds", () => {
  const setup = fixture();
  const view = readView(setup.vm, setup.scaffolding);
  const center = {
    lon: (view.bounds.west + view.bounds.east) / 2,
    lat: view.bounds.north,
  };
  const edge = projectPoint(center, view);
  close(edge.x, (view.viewport.left + view.viewport.right) / 2);
  close(edge.y, view.viewport.top);
  const behindPanel = projectPoint({ lon: view.bounds.west - 1, lat: 35 }, view);
  assert.equal(behindPanel.visible, false);
  const farSouth = projectPoint({ lon: center.lon, lat: -50 }, view);
  assert.equal(farSouth.visible, false);
});

test("handles loading and replaced stages, arrays, and variable objects", () => {
  const setup = fixture();
  assert.equal(readView(), null);
  assert.equal(readView({ runtime: { targets: [] } }, setup.scaffolding), null);
  assert.equal(readView(setup.vm, {}), null);
  assert.ok(readView(setup.vm, setup.scaffolding));

  const cameraEntry = Object.entries(setup.stage.variables).find(([, value]) => value.name === "1カメラ系");
  setup.stage.variables[cameraEntry[0]] = { name: "1カメラ系", value: [12, 15, 4] };
  assert.deepEqual(readView(setup.vm, setup.scaffolding).camera, { x: 12, y: 15, zoom: 4 });

  const replacement = fixture();
  setup.vm.runtime.targets = [replacement.stage];
  assert.equal(readView(setup.vm, setup.scaffolding).camera.zoom, 1.8);
  replacement.get("タブ").value = 5;
  replacement.get("地図表示モード").value = 3;
  replacement.get("ダイアログなう").value = "settings";
  const view = readView(setup.vm, setup.scaffolding);
  assert.equal(view.tab, 5);
  assert.equal(view.mapMode, 3);
  assert.equal(view.dialog, "settings");
});

test("does not scan clones during repeated rendering and supports copied variable IDs", () => {
  const setup = fixture();
  let cloneReads = 0;
  const clone = new Proxy({}, { get() { cloneReads += 1; return undefined; } });
  setup.vm.runtime.targets.push(...Array(1000).fill(clone));
  for (let i = 0; i < 100; i += 1) assert.ok(readView(setup.vm, setup.scaffolding));
  assert.equal(cloneReads, 0);

  setup.stage.variables = Object.fromEntries(
    Object.values(setup.stage.variables).map((value) => [`copy-${value.name}`, value]),
  );
  assert.ok(readView(setup.vm, setup.scaffolding));
  setup.stage.variables["copy-1カメラ系"] = { name: "1カメラ系", value: [1, 2, 3] };
  assert.equal(readView(setup.vm, setup.scaffolding).camera.zoom, 3);
});

test("rejects unusable camera state and undefined geographic points", () => {
  const setup = fixture();
  const view = readView(setup.vm, setup.scaffolding);
  for (const point of [null, {}, { lat: null, lon: 139 }, { lat: "", lon: 139 },
    { lat: 90, lon: 139 }, { lat: -90, lon: 139 }, { lat: NaN, lon: 139 }]) {
    assert.equal(projectPoint(point, view).visible, false);
  }
  assert.equal(projectPoint({ lat: 35, lon: 139 }, null).visible, false);
  setup.get("1カメラ系").value[2] = 0;
  assert.equal(readView(setup.vm, setup.scaffolding), null);
});

test("source landscape and portrait layouts are settled at arbitrary UI and CSS scales", () => {
  for (const mode of ["w", "s"]) {
    for (const uiScale of [0.5, 0.75, 1, 1.13, 1.5, 2, 3.75, 5]) {
      for (const cssScale of [0.75, 1, 2]) {
        const setup = fixture({
          width: mode === "w" ? 1200 : 390,
          height: mode === "w" ? 800 : 844,
          cssScale,
        });
        sourceLayout(setup, mode, uiScale);
        const view = readView(setup.vm, setup.scaffolding);
        assert.equal(view.settled, true, `${mode}, UI=${uiScale}, CSS=${cssScale}`);
        close(view.mapViewport.top, 0);
        close(view.mapViewport.right, view.width);
        if (mode === "w") close(view.viewport.left, 120 * uiScale * cssScale);
        else close(view.viewport.left, 0);
      }
    }
  }
});

test("detects new stage plus old screen geometry and recovers after the source UI catches up", () => {
  const setup = fixture({width: 582, height: 470});
  sourceLayout(setup, "w", 1.48);
  assert.equal(readView(setup.vm, setup.scaffolding).settled, true);

  // Opening the mobile drawer resizes the canvas/stage immediately, while
  // Scratch's screen list and automatic UI scale update on later frames.
  setup.vm.runtime.stageHeight = 296.4;
  setup.scaffolding.height = 296.4;
  setup.canvas.getBoundingClientRect = () => ({left: 0, top: 0, width: 582, height: 296.4});
  let view = readView(setup.vm, setup.scaffolding);
  assert.ok(view, "existing consumers still receive the transitional snapshot");
  assert.equal(view.settled, false);

  // Merely updating the stored physical dimensions is insufficient: source
  // bounds may still refer to the previous screen size.
  const screen = setup.get("3画面設定系").value;
  screen[10] = 291;
  screen[11] = 148.2;
  assert.equal(readView(setup.vm, setup.scaffolding).settled, false);

  sourceLayout(setup, "w", 1.48);
  assert.equal(readView(setup.vm, setup.scaffolding).settled, true);
  screen[5] = 1.2; // UI size changes after bounds calculation in the source loop.
  assert.equal(readView(setup.vm, setup.scaffolding).settled, false);
  sourceLayout(setup, "w", 1.2);
  view = readView(setup.vm, setup.scaffolding);
  assert.equal(view.settled, true);
  close(view.viewport.left, 144);

  setup.vm.runtime.stageWidth = 390;
  setup.vm.runtime.stageHeight = 844;
  setup.canvas.getBoundingClientRect = () => ({left: 0, top: 0, width: 390, height: 844});
  setup.get("画面サイズモード").value = "s";
  assert.equal(readView(setup.vm, setup.scaffolding).settled, false);
  sourceLayout(setup, "s", 1.2);
  assert.equal(readView(setup.vm, setup.scaffolding).settled, true);
});
