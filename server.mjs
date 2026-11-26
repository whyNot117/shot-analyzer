// 本地测试服务器（零依赖，Node 18+）：node server.mjs
// Live Server 插件的替代品——不想装插件时直接用它看页面。
// 端口从 5500 起，被占用则自动顺延；Ctrl+C 或关掉进程即可停止。
// 注意：/sw.js 一律返回 404——本地开发不注册 Service Worker，避免缓存旧版本干扰调试（线上 GitHub Pages 不受影响）。
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".md": "text/markdown; charset=utf-8",
};

function listen(port) {
  return new Promise((resolve, reject) => {
    const srv = createServer(handler);
    srv.once("error", reject);
    srv.listen(port, "127.0.0.1", () => resolve(srv));
  });
}

async function handler(req, res) {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/sw.js") {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("本地开发模式不提供 sw.js（避免 Service Worker 缓存旧版本干扰调试）");
      return;
    }
    let p = decodeURIComponent(url.pathname);
    if (p.endsWith("/")) p += "index.html";
    const file = normalize(join(ROOT, p));
    if (!file.startsWith(ROOT)) throw Object.assign(new Error("forbidden"), { code: "EACCES" });
    const data = await readFile(file);
    res.writeHead(200, {
      "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
      "Cache-Control": "no-store", // 本地调试不吃缓存，改完刷新即是最新
    });
    res.end(data);
  } catch (err) {
    const notFound = err.code === "ENOENT" || err.code === "EACCES";
    res.writeHead(notFound ? 404 : 500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(notFound ? "404 Not Found" : `500 ${err.message}`);
  }
}

let port = 5500;
let srv = null;
while (!srv) {
  srv = await listen(port).catch(() => null); // 端口被占用就顺延
  if (!srv) port += 1;
}
console.log(`已启动: http://127.0.0.1:${port}/  （Ctrl+C 停止）`);
