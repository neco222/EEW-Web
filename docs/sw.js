/* Cache only this installation's static files. Live earthquake and peer data stay online. */
const scope = new URL(self.registration.scope);
const prefix = `eew-web:${encodeURIComponent(scope.href)}:v1:`;
const metadataName = `${prefix}metadata`;
const immutableName = `${prefix}immutable`;
const releasePrefix = `${prefix}release:`;
const localURL = (path) => new URL(path, scope).href;
const hashURL = localURL("hash");
const activeURL = localURL("__sw__/active");
const completeURL = localURL("__sw__/complete");
const clientURL = (id) => localURL(`__sw__/clients/${encodeURIComponent(id)}`);
const shellFiles = [
  "index.html",
  "index.js",
  "manifest.json",
  "assets/project.json",
  "viewer-entry.js",
  "runtime-efficiency.js",
  "map-render-efficiency.js",
  "community.js",
  "community.css",
  "community-core.js",
  "community-feed.js",
  "p2p-areas.js",
  "viewer-bridge.js",
  "report-bubbles.js",
  "viewer-obstacles.js",
  "community-pulses.js",
  "watermark.js",
  "camera.js",
  "camera.css",
  "camera-model.js",
  "camera-event.js",
  "camera-player.js",
  "live-cameras.js",
  "images/icon.svg",
  "images/loading.jpg",
  "images/appicon192.webp",
  "images/appicon512.webp",
  "images/vr-disaster-watermark.webp",
];
const shellURLs = new Set(shellFiles.map(localURL));
const completeMarker = (version) => JSON.stringify({ version, files: shellFiles });
const clientReleases = new Map();
let refreshing;

const validHash = (value) => /^[a-f0-9]{40,64}$/i.test(value);
const usable = (response) => response && response.ok && response.status === 200;
const canonicalURL = (url) => `${url.origin}${url.pathname}`;
const freshFetch = (url) => fetch(new Request(url, {
  cache: "no-store",
  credentials: "same-origin",
  redirect: "error",
  signal: AbortSignal.timeout(url === hashURL ? 4000 : 20000),
}));

async function readHash(response) {
  if (!usable(response)) throw new Error("Release hash is unavailable");
  const value = (await response.clone().text()).trim();
  if (!validHash(value)) throw new Error("Invalid release hash");
  return value;
}

async function storedRelease() {
  try {
    const metadata = await caches.open(metadataName);
    const response = await metadata.match(activeURL);
    const version = response && (await response.text()).trim();
    return validHash(version) ? version : null;
  } catch {
    return null;
  }
}

async function refreshRelease() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const hashResponse = await freshFetch(hashURL);
    const version = await readHash(hashResponse);
    const release = await caches.open(`${releasePrefix}${version}`);
    const complete = await release.match(completeURL);
    // An older worker can cache this same hash using a shorter shell list.
    // Its completion marker does not prove that the new modules are present.
    if (!usable(complete) || await complete.text() !== completeMarker(version)) {
      // Finish every write before publishing the new snapshot. An interrupted
      // update never becomes the active release and is retried on the next visit.
      const results = await Promise.allSettled(shellFiles.map(async (path) => {
        const url = localURL(path);
        const response = await freshFetch(url);
        if (!usable(response)) throw new Error(`Static file unavailable: ${path}`);
        await release.put(url, response);
      }));
      const failed = results.find((result) => result.status === "rejected");
      if (failed) throw failed.reason;
      if (await readHash(await freshFetch(hashURL)) !== version) {
        throw new Error("Release changed while downloading");
      }
      await release.put(hashURL, hashResponse);
      await release.put(completeURL, new Response(completeMarker(version)));
    }
    const metadata = await caches.open(metadataName);
    await metadata.put(activeURL, new Response(version));
    return version;
  })();
  try {
    return await refreshing;
  } finally {
    refreshing = null;
  }
}

async function pinClient(id, version) {
  if (!id || !version) return;
  clientReleases.set(id, version);
  try {
    const metadata = await caches.open(metadataName);
    await metadata.put(clientURL(id), new Response(version));
  } catch {
    // Cache quota or private-mode restrictions must not break online viewing.
  }
}

async function releaseForClient(id) {
  if (id && clientReleases.has(id)) return clientReleases.get(id);
  if (id) {
    try {
      const metadata = await caches.open(metadataName);
      const saved = await metadata.match(clientURL(id));
      const version = saved && (await saved.text()).trim();
      if (validHash(version)) {
        clientReleases.set(id, version);
        return version;
      }
    } catch {
      // The network remains usable even when Cache Storage is unavailable.
    }
  }
  const version = await storedRelease();
  await pinClient(id, version);
  return version;
}

async function safePut(cache, url, response) {
  if (!usable(response)) return;
  try {
    await cache.put(url, response.clone());
  } catch {
    // Return the successful network response even if persistent storage is full.
  }
}

async function cachedFile(version, url, request) {
  if (!version) return fetch(request);
  let release;
  try {
    release = await caches.open(`${releasePrefix}${version}`);
    const cached = await release.match(url);
    if (cached) return cached;
  } catch {
    return fetch(request);
  }
  if (shellURLs.has(url)) {
    // A partially evicted old snapshot must not silently load a new project or
    // module into a document from an older release.
    try {
      if (await readHash(await freshFetch(hashURL)) !== version) {
        return new Response("A newer version is available. Reload to update.", {
          status: 503,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }
      const response = await freshFetch(url);
      if (await readHash(await freshFetch(hashURL)) !== version) {
        return new Response("The application is updating. Please reload.", { status: 503 });
      }
      await safePut(release, url, response);
      return response;
    } catch {
      return new Response("This file is not available offline yet.", { status: 503 });
    }
  }
  const response = await fetch(request);
  await safePut(release, url, response);
  return response;
}

async function navigate(event) {
  let version;
  try {
    version = await refreshRelease();
  } catch {
    version = await storedRelease();
  }
  await pinClient(event.resultingClientId || event.clientId, version);
  return cachedFile(version, localURL("index.html"), event.request);
}

async function serveHash(event) {
  // Pin an existing document before an update changes the default release.
  const previous = await releaseForClient(event.clientId);
  let version;
  try {
    version = await refreshRelease();
  } catch {
    version = previous || await storedRelease();
  }
  await pruneReleases().catch(() => {});
  return cachedFile(version, hashURL, event.request);
}

async function immutableFile(event, url) {
  let cache;
  try {
    cache = await caches.open(immutableName);
    const cached = await cache.match(url);
    if (cached) return cached;
  } catch {
    return fetch(event.request);
  }
  const response = await fetch(event.request);
  await safePut(cache, url, response);
  return response;
}

async function pruneReleases() {
  const active = await storedRelease();
  if (!active) return;
  const keep = new Set([active]);
  const metadata = await caches.open(metadataName);
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  const live = new Set(clients.map((client) => client.id));
  const clientPrefix = localURL("__sw__/clients/");
  for (const request of await metadata.keys()) {
    if (!request.url.startsWith(clientPrefix)) continue;
    const id = decodeURIComponent(request.url.slice(clientPrefix.length));
    if (live.has(id)) {
      const version = await releaseForClient(id);
      if (version) keep.add(version);
    } else {
      clientReleases.delete(id);
      await metadata.delete(request);
    }
  }
  await Promise.all((await caches.keys()).filter((name) => (
    name.startsWith(releasePrefix) && !keep.has(name.slice(releasePrefix.length))
  )).map((name) => caches.delete(name)));
}

self.addEventListener("install", (event) => {
  // Let an existing worker finish serving its open documents before activation.
  event.waitUntil(refreshRelease());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(pruneReleases().catch(() => {}));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || request.headers.has("range")) return;
  const url = new URL(request.url);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  const path = url.pathname.slice(scope.pathname.length);
  const canonical = canonicalURL(url);
  let task;
  if ((path === "" || path === "index.html") && request.mode === "navigate") {
    task = navigate(event);
  } else if (path === "hash") {
    task = serveHash(event);
  } else if (/^assets\/[a-f\d]{32}\.[a-z\d]+$/i.test(path)) {
    task = immutableFile(event, canonical);
  } else if (shellURLs.has(canonical) || path.startsWith("images/")) {
    task = releaseForClient(event.clientId).then((version) => (
      cachedFile(version, canonical, request)
    ));
  } else {
    return;
  }
  event.respondWith(task);
  event.waitUntil(task.then(() => {}).catch(() => {}));
});
