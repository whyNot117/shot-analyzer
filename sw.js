// Service Worker：应用与模型缓存，离线可用
const CACHE = "shot-analyzer-v5.4";
const APP_SHELL = [
  "./",
  "./index.html",
  "./css/style.css",
  "./js/pose.js",
  "./js/media.js",
  "./js/draw.js",
  "./js/views.js",
  "./js/metrics.js",
  "./js/report.js",
  "./js/compare.js",
  "./js/app.js",
  "./manifest.json",
  "./icon.svg",
];
self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = e.request.url;
  if (!url.startsWith(self.location.origin)) return; // 站内资源全部自托管，无 CDN 依赖
  // 缓存优先；未命中则网络获取并写入缓存（模型与 WASM 首次访问后即离线可用）
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) =>
      hit ||
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
          return res;
        })
        .catch(() => hit)
    )
  );
});
