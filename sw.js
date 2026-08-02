const CACHE = "workbench-v1";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./css/styles.css",
  "./js/app.js",
  "./js/db.js",
  "./js/util.js",
  "./js/views/tasks.js",
  "./js/views/capture.js",
  "./js/views/notes.js",
  "./js/views/pomodoro.js",
  "./js/views/diary.js",
  "./js/views/settings.js",
  "./js/views/home.js",
  "./js/views/stats.js",
  "./js/views/whitenoise.js",
  "./js/views/achievements.js",
  "./js/views/charts.js",
  "./js/views/categories.js",
  "./icons/icon.svg"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const network = fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
