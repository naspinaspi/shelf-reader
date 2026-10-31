// Service worker for the phone app (phone app plan, P2). Keeps the app shell and every encrypted file the phone has fetched,
// so the app opens offline and a book opened once still opens in airplane mode.
// Cache names: the app (app.js) and the Node test read DATA_CACHE from reading.mjs; the test checks that these names agree.
// Bump SHELL_CACHE when any shell file changes, so the new app replaces the old one on the next visit.
const SHELL_CACHE = "shelf-phone-shell-v2";
const DATA_CACHE = "shelf-phone-data-v1";
const SHELL = ["./", "index.html", "app.css", "app.js", "crypto.mjs", "reading.mjs", "manifest.webmanifest", "icons/icon-180.png", "icons/icon-192.png", "icons/icon-512.png"];
// Small files that change when the Mac publishes: the newest copy wins when online, and the saved copy is used when not.
const LIVE = ["library.enc", "key.json", "check.enc"];

const base = new URL("./", self.location.href).pathname;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name.startsWith("shelf-phone-") && name !== SHELL_CACHE && name !== DATA_CACHE).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

// A file the phone has fetched is kept under its own name. A book's name stays the same across revisions, so the revision is in the query:
// each revision is its own cache entry, and older entries for the same book are removed when a new one is saved.
async function remember(cache, request, response) {
  const url = new URL(request.url);
  // The name inside the site. The pathname starts with the base path (e.g. /shelf-reader/), so it is cut first.
  const file = url.pathname.slice(base.length);
  const folder = file.match(/^(books|covers)\/([0-9a-f]{32})\.(enc)$/);
  if (folder) {
    for (const key of await cache.keys()) {
      const other = new URL(key.url);
      if (other.pathname === url.pathname && other.search !== url.search) await cache.delete(key);
    }
  }
  await cache.put(request, response.clone());
}

async function cacheFirst(cacheName, request) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  try {
    const response = await fetch(request);
    if (response.ok) await remember(cache, request, response);
    return response;
  } catch {
    // Offline and never fetched: a plain 504 that the app turns into "Connect to open this summary".
    return new Response("", { status: 504, statusText: "Offline" });
  }
}

async function networkFirst(cacheName, request) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch {
    const hit = await cache.match(request);
    return hit ?? new Response("", { status: 504, statusText: "Offline" });
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || !url.pathname.startsWith(base)) return;
  const file = url.pathname.slice(base.length);

  if (request.mode === "navigate") {
    event.respondWith(caches.open(SHELL_CACHE).then((cache) => cache.match("index.html")).then((hit) => hit ?? fetch(request)));
    return;
  }
  if (file === "" || SHELL.includes(file)) {
    event.respondWith(cacheFirst(SHELL_CACHE, request));
    return;
  }
  if (LIVE.includes(file)) {
    event.respondWith(networkFirst(DATA_CACHE, request));
    return;
  }
  if (/^(books|covers)\/[0-9a-f]{32}\.enc$/.test(file)) {
    event.respondWith(cacheFirst(DATA_CACHE, request));
  }
});
