/**
 * Keeps the built app on the device, so it opens with the server unreachable. The build (vite.config.ts) writes
 * this file out as /sw.js with two constants in front: CACHE, a cache name for this build, and FILES, the paths
 * of the build's files.
 *
 * Install stores the page and every file of the build, so the stored set is always one whole build. A build's
 * files have their content hash in the name, so they are answered from the cache. The page is asked from the
 * server first and the stored one answers only when the server cannot be reached: a new build shows on the next
 * load, and the dev server works on an origin where a build registered this worker. Every app route gets the same
 * page, because the server renders none of them. Requests to /api/fate are not touched: fate queues them itself.
 */
const PAGE = "/";
const files = new Set(FILES);

const stored = async (path) => (await caches.open(CACHE)).match(path);

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll([new Request(PAGE, { cache: "reload" }), ...FILES]);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) if (name !== CACHE) await caches.delete(name);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== location.origin) return;
  if (files.has(url.pathname)) {
    event.respondWith(stored(url.pathname).then((hit) => hit ?? fetch(request)));
  } else if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(async () => (await stored(PAGE)) ?? Response.error()));
  }
});
