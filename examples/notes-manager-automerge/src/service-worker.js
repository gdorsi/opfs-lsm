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
