import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../docs/sw.js", import.meta.url), "utf8");
const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const asset = `assets/${"d".repeat(32)}.svg`;

function fixture(scope = "https://example.test/EEW-Web/") {
  const stores = new Map();
  const calls = [];
  const liveClients = new Set();
  const failures = new Map();
  let version = A;
  let offline = false;
  let storageDenied = false;
  let writesDenied = false;
  let onFetch;
  const absolute = (path) => new URL(path, scope).href;
  const key = (request) => typeof request === "string" ? request : request.url;
  const cacheStorage = {
    async open(name) {
      if (storageDenied) throw new Error("Cache Storage unavailable");
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name);
      return {
        async match(request) { return entries.get(key(request))?.clone(); },
        async put(request, response) {
          if (writesDenied) throw new Error("Quota exceeded");
          entries.set(key(request), response.clone());
        },
        async delete(request) { return entries.delete(key(request)); },
        async keys() { return [...entries.keys()].map((url) => new Request(url)); },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
  };
  const network = async (request) => {
    const url = key(request);
    calls.push(url);
    if (offline) throw new Error("Offline");
    const path = url.slice(scope.length).split("?")[0];
    if (onFetch) await onFetch(path);
    const failure = failures.get(path);
    if (failure instanceof Error) throw failure;
    if (failure) return new Response("Unavailable", { status: failure });
    return new Response(path === "hash" ? version : `${version}:${path}`);
  };

  function worker() {
    const listeners = new Map();
    vm.runInNewContext(source, {
      URL, Request, Response, AbortSignal,
      caches: cacheStorage,
      fetch: network,
      self: {
        registration: { scope },
        clients: {
          async matchAll() {
            return [...liveClients].map((id) => ({ id, url: scope }));
          },
        },
        addEventListener(type, handler) { listeners.set(type, handler); },
      },
    }, { filename: "sw.js" });
    return {
      async lifecycle(type) {
        const pending = [];
        listeners.get(type)({ waitUntil(promise) { pending.push(promise); } });
        await Promise.all(pending);
      },
      async request(path, options = {}) {
        const pending = [];
        let response;
        if (options.clientId) liveClients.add(options.clientId);
        if (options.resultingClientId) liveClients.add(options.resultingClientId);
        listeners.get("fetch")({
          request: {
            url: absolute(path),
            method: options.method || "GET",
            mode: options.mode || "cors",
            headers: new Headers(options.headers),
          },
          clientId: options.clientId || "",
          resultingClientId: options.resultingClientId || "",
          respondWith(promise) { response = promise; },
          waitUntil(promise) { pending.push(promise); },
        });
        if (!response) return undefined;
        const [result] = await Promise.all([response, ...pending]);
        return result;
      },
    };
  }
  return {
    worker, stores, calls, failures, liveClients, absolute,
    deploy(value) { version = value; },
    offline(value = true) { offline = value; },
    denyStorage(value = true) { storageDenied = value; },
    denyWrites(value = true) { writesDenied = value; },
    onFetch(callback) { onFetch = callback; },
    count(path) { return calls.filter((url) => url === absolute(path)).length; },
    release(value) {
      const entry = [...stores].find(([name]) => name.endsWith(`release:${value}`));
      return entry?.[1];
    },
  };
}

async function navigate(worker, id) {
  return worker.request("", { mode: "navigate", resultingClientId: id });
}

for (const scope of [
  "https://example.test/renamed-repository/",
  "http://localhost:8000/docs/",
  "http://localhost:8000/",
]) {
  test(`prepares the full shell and serves it offline under ${scope}`, async () => {
    const f = fixture(scope);
    const worker = f.worker();
    await worker.lifecycle("install");
    for (const file of [
      "viewer-entry.js", "runtime-efficiency.js", "community.js", "community.css",
      "community-core.js", "community-feed.js", "p2p-areas.js", "viewer-bridge.js", "assets/project.json",
    ]) assert.equal(f.count(file), 1, `${file} must be in the offline snapshot`);
    assert.ok(f.calls.every((url) => url.startsWith(scope)));
    f.offline();
    assert.equal(await (await navigate(worker, "offline-tab")).text(), `${A}:index.html`);
    assert.equal(await (await worker.request("community.js", {
      clientId: "offline-tab",
    })).text(), `${A}:community.js`);
  });
}

test("never intercepts live APIs, other apps, non-GET requests, or partial media requests", async () => {
  const f = fixture();
  const worker = f.worker();
  for (const [path, options] of [
    ["https://api.example.test/events", {}],
    ["https://example.test/other-app/index.js", {}],
    ["api/events", {}],
    ["hash", { method: "POST" }],
    [asset, { headers: { Range: "bytes=0-99" } }],
    ["sw.js", {}],
  ]) assert.equal(await worker.request(path, options), undefined);
  assert.equal(f.calls.length, 0);
  assert.equal(f.stores.size, 0);
});

test("content-hashed assets are fetched once and remain available across releases", async () => {
  const f = fixture();
  const worker = f.worker();
  await worker.lifecycle("install");
  assert.equal(await (await worker.request(asset)).text(), `${A}:${asset}`);
  f.deploy(B);
  await navigate(worker, "new-tab");
  assert.equal(await (await worker.request(`${asset}?version=2`)).text(), `${A}:${asset}`);
  assert.equal(f.count(asset), 1);
  f.offline();
  assert.equal((await worker.request(asset)).status, 200);
});

test("a hash update switches new documents together and pins open documents across worker restarts", async () => {
  const f = fixture();
  let worker = f.worker();
  await worker.lifecycle("install");
  await navigate(worker, "old-tab");
  f.deploy(B);
  assert.equal(await (await worker.request("hash", { clientId: "old-tab" })).text(), B);
  assert.equal(await (await worker.request("assets/project.json", {
    clientId: "old-tab",
  })).text(), `${A}:assets/project.json`);
  assert.equal(await (await navigate(worker, "new-tab")).text(), `${B}:index.html`);
  worker = f.worker();
  f.offline();
  assert.equal(await (await worker.request("viewer-entry.js", {
    clientId: "old-tab",
  })).text(), `${A}:viewer-entry.js`);
  assert.equal(await (await worker.request("viewer-entry.js", {
    clientId: "new-tab",
  })).text(), `${B}:viewer-entry.js`);
  assert.equal(await (await worker.request("assets/project.json", {
    clientId: "new-tab",
  })).text(), `${B}:assets/project.json`);
});

test("an incomplete update keeps the last working release and retries successfully", async () => {
  const f = fixture();
  const worker = f.worker();
  await worker.lifecycle("install");
  f.deploy(B);
  f.failures.set("community-core.js", 503);
  assert.equal(await (await navigate(worker, "first-tab")).text(), `${A}:index.html`);
  assert.equal(await (await worker.request("community-core.js", {
    clientId: "first-tab",
  })).text(), `${A}:community-core.js`);
  f.failures.clear();
  assert.equal(await (await navigate(worker, "second-tab")).text(), `${B}:index.html`);
  assert.equal(await (await worker.request("community-core.js", {
    clientId: "second-tab",
  })).text(), `${B}:community-core.js`);
});

test("a deployment changing during download never publishes a mixed snapshot", async () => {
  const f = fixture();
  const worker = f.worker();
  await worker.lifecycle("install");
  f.deploy(B);
  f.onFetch((path) => { if (path === "index.js") f.deploy(C); });
  assert.equal(await (await navigate(worker, "first-tab")).text(), `${A}:index.html`);
  f.onFetch(undefined);
  assert.equal(await (await navigate(worker, "next-tab")).text(), `${C}:index.html`);
});

test("concurrent update requests share one complete download", async () => {
  const f = fixture();
  const worker = f.worker();
  await worker.lifecycle("install");
  await navigate(worker, "old-tab");
  f.deploy(B);
  const count = f.count("index.js");
  await Promise.all([
    worker.request("hash", { clientId: "old-tab" }),
    navigate(worker, "new-tab"),
    worker.request("hash", { clientId: "old-tab" }),
  ]);
  assert.equal(f.count("index.js") - count, 1);
});

for (const legacy of ["version-only", "older-manifest"]) {
  test(`a same-hash ${legacy} completion marker fills every new module before publishing completion`, async () => {
    const f = fixture();
    await f.worker().lifecycle("install");
    const release = f.release(A);
    const completeURL = f.absolute("__sw__/complete");
    const expected = await release.get(completeURL).clone().text();
    const newFiles = ["camera.js", "camera.css", "camera-model.js", "camera-event.js", "camera-player.js", "live-cameras.js"];
    const oldManifest = JSON.parse(expected);
    oldManifest.files = oldManifest.files.filter((file) => !newFiles.includes(file));
    const oldMarker = legacy === "version-only" ? A : JSON.stringify(oldManifest);
    for (const file of newFiles) release.delete(f.absolute(file));
    release.set(completeURL, new Response(oldMarker));

    // A failed repair must not publish a marker claiming the new shell is ready.
    f.failures.set("camera-player.js", 503);
    await assert.rejects(f.worker().lifecycle("install"), /Static file unavailable: camera-player.js/);
    assert.equal(await release.get(completeURL).clone().text(), oldMarker);
    assert.equal(release.has(f.absolute("camera-player.js")), false);
    f.failures.clear();

    let reached, resume;
    const waiting = new Promise((resolve) => { reached = resolve; });
    const blocked = new Promise((resolve) => { resume = resolve; });
    const before = new Map(newFiles.map((file) => [file, f.count(file)]));
    f.onFetch((path) => {
      if (path === "camera-player.js") { reached(); return blocked; }
    });
    const worker = f.worker();
    const installing = worker.lifecycle("install");
    await waiting;
    assert.equal(await release.get(completeURL).clone().text(), oldMarker);
    resume();
    await installing;
    assert.equal(await release.get(completeURL).clone().text(), expected);
    for (const file of newFiles) {
      assert.equal(f.count(file) - before.get(file), 1, `${file} must be included in the repaired snapshot`);
      assert.equal(await release.get(f.absolute(file)).clone().text(), `${A}:${file}`);
    }
    f.onFetch(undefined);
    f.offline();
    await navigate(worker, "camera-offline");
    for (const file of newFiles) assert.equal(await (await worker.request(file, { clientId: "camera-offline" })).text(), `${A}:${file}`);
  });
}

test("a matching hash and shell manifest reuses the completed snapshot", async () => {
  const f = fixture();
  await f.worker().lifecycle("install");
  const count = f.count("index.js");
  await f.worker().lifecycle("install");
  assert.equal(f.count("index.js"), count);
  assert.equal(f.count("hash"), 3); // The second worker only checks the current hash.
});

test("unsuccessful HTTP responses and failed cache writes do not poison asset caches", async () => {
  const f = fixture();
  const worker = f.worker();
  f.failures.set(asset, 500);
  assert.equal((await worker.request(asset)).status, 500);
  assert.equal((await worker.request(asset)).status, 500);
  assert.equal(f.count(asset), 2);
  f.failures.clear();
  f.denyWrites();
  assert.equal((await worker.request(asset)).status, 200);
  assert.equal((await worker.request(asset)).status, 200);
  assert.equal(f.count(asset), 4);
  f.denyWrites(false);
  await worker.request(asset);
  await worker.request(asset);
  assert.equal(f.count(asset), 5);
});

test("storage restrictions preserve online viewing and fail installation cleanly", async () => {
  const f = fixture();
  const worker = f.worker();
  f.denyStorage();
  await assert.rejects(worker.lifecycle("install"), /Cache Storage unavailable/);
  assert.equal((await navigate(worker, "online-tab")).status, 200);
  assert.equal((await worker.request(asset)).status, 200);
  await worker.lifecycle("activate");
});

test("evicting an old module cannot fetch a different release into an existing document", async () => {
  const f = fixture();
  const worker = f.worker();
  await worker.lifecycle("install");
  await navigate(worker, "old-tab");
  f.release(A).delete(f.absolute("community.js"));
  f.deploy(B);
  const unavailable = await worker.request("community.js", { clientId: "old-tab" });
  assert.equal(unavailable.status, 503);
  assert.ok(!(await unavailable.text()).includes(`${B}:`));
  f.deploy(A);
  assert.equal(await (await worker.request("community.js", {
    clientId: "old-tab",
  })).text(), `${A}:community.js`);
});

test("cleanup preserves live releases and every cache outside this installation", async () => {
  const f = fixture();
  const worker = f.worker();
  f.stores.set("another-app-v5", new Map());
  f.stores.set("srev 1.6.3.5", new Map());
  f.stores.set(`eew-web:${encodeURIComponent("https://example.test/other-app/")}:v1:release:${C}`, new Map());
  await worker.lifecycle("install");
  await navigate(worker, "old-tab");
  f.deploy(B);
  await navigate(worker, "new-tab");
  await worker.lifecycle("activate");
  assert.ok(f.release(A));
  assert.ok(f.release(B));
  f.liveClients.delete("old-tab");
  await worker.lifecycle("activate");
  assert.equal(f.release(A), undefined);
  assert.ok(f.release(B));
  assert.ok(f.stores.has("another-app-v5"));
  assert.ok(f.stores.has("srev 1.6.3.5"));
  assert.ok([...f.stores.keys()].some((name) => name.includes(encodeURIComponent("other-app/"))));
});

test("invalid release hashes and missing shell files reject installation", async () => {
  const badHash = fixture();
  badHash.deploy("<html>GitHub Pages error</html>");
  await assert.rejects(badHash.worker().lifecycle("install"), /Invalid release hash/);
  const missing = fixture();
  missing.failures.set("assets/project.json", 404);
  await assert.rejects(missing.worker().lifecycle("install"), /Static file unavailable/);
});
