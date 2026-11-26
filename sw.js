// Service Worker：应用与模型缓存，离线可用
// 缓存名带版本号：代码一升级就换名，旧缓存会在 activate 时被清掉，
// 否则「缓存优先」会让用户一直拿到旧文件，改了代码也看不到效果。
const CACHE = "shot-analyzer-v5.11";
const APP_SHELL = [
  "./",
  "./index.html",
  "./css/style.css",
  "./js/angles.js",
  "./js/charts.js",
  "./js/history.js",
  "./js/pose.js",
  "./js/media.js",
  "./js/tracks.js",
  "./js/draw.js",
  "./js/views.js",
  "./js/metrics.js",
  "./js/report.js",
  "./js/compare.js",
  "./js/scene.js",
  "./js/quality.js",
  "./js/glossary.js",
  "./js/sync.js",
  "./js/app.js",
  "./manifest.json",
  "./icon.svg",
  "./docs/manual.html",
  // docs/img/ 下的手册截图也一并缓存，离线时手册也能看
  "./docs/使用手册.md",
  "./docs/img/01-open.jpg",
  "./docs/img/02-pick-video.jpg",
  "./docs/img/03-file-loaded.jpg",
  "./docs/img/04-checklist.jpg",
  "./docs/img/05-shot-type.jpg",
  "./docs/img/06-scene.jpg",
  "./docs/img/07-analyze.jpg",
  "./docs/img/08-report.jpg",
  "./docs/img/09-overlay.jpg",
  "./docs/img/10-toggles.jpg",
  "./docs/img/11-fusion.jpg",
  "./docs/img/12-compare.jpg",
  "./docs/img/13-history.jpg",
  "./docs/img/14-download-zip.jpg",
  "./docs/img/15-local-server.jpg",
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
  // 两类资源两套策略：
  // · 应用外壳（html/css/js/manifest）走 stale-while-revalidate——先给旧版本顶上让页面立刻可用，
  //   同时后台拉新版写回缓存。用户下次打开就是新代码，不会被「缓存优先」卡在旧版本上。
  // · 模型与 WASM（model/、vendor/）保持 cache-first——MediaPipe 模型与 WASM 运行时合计约 25MB，
   //   每次重下既慢又费流量，而它们几乎不变版本；首次访问后即离线可用。
  const isHeavy = url.includes("/model/") || url.includes("/vendor/");
  if (isHeavy) {
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
    return;
  }
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(e.request, { ignoreSearch: true });
      const fresh = fetch(e.request)
        .then((res) => {
          if (res && res.ok) cache.put(e.request, res.clone()).catch(() => {});
          return res;
        })
        .catch(() => null);
      if (hit) {
        fresh.catch(() => {}); // 后台更新，失败无所谓（旧版本仍能用）
        return hit;
      }
      const res = await fresh;
      return res || new Response("离线且未缓存", { status: 504, statusText: "offline" });
    })
  );
});
