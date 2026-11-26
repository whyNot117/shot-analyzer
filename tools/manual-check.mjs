// 手册截图自检（开发工具）
//
// 每张图都要满足：顶部有说明条（红橙渐变）、页面里真的有红框高亮、页面不是一片空白。
// 这里不靠肉眼——把图读回画布数像素：说明条区域的红像素多不多、高亮框的红像素在不在、
// 整幅图的非白像素占比够不够（太低说明截到空白区了）。
//
// 运行：先起 node server.mjs，再 node tools/manual-check.mjs

import { spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = "D:/homecourt";
const IMG_DIR = join(ROOT, "docs/img");
const LOCAL_URL = "http://127.0.0.1:5500/docs/manual.html";
const ORCA = process.env.ORCA_CLI_COMMAND ||
  "C:/Users/LD1900/AppData/Local/Programs/orca/resources/bin/orca.exe";

function orca(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ORCA, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(`orca ${args[0]} 退出码 ${code}: ${err.slice(0, 300)}`));
      try { resolve(JSON.parse(out)); } catch { resolve({ raw: out }); }
    });
  });
}
async function evalJson(page, expression) {
  const j = await orca(["eval", "--page", page, "--expression", expression, "--json"]);
  if (!j.ok) throw new Error("页面执行失败: " + JSON.stringify(j.error || j).slice(0, 400));
  return JSON.parse(j.result.result);
}

const files = readdirSync(IMG_DIR).filter((f) => f.endsWith(".jpg")).sort();
// 15 是本机终端窗口的实拍照，本来就没有红框标注，不参与标注校验
const NO_ANN = new Set(["15-local-server.jpg"]);
if (!files.length) {
  console.log("docs/img 下没有图，先跑 tools/manual-shots.mjs");
  process.exit(1);
}

const tab = await orca(["tab", "create", "--url", LOCAL_URL, "--json"]);
const page = tab.result.browserPageId;
await sleep(2500);

const stats = [];
for (const f of files) {
  const s = await evalJson(page, `(async () => {
    const img = new Image();
    img.src = "/docs/img/${f}?t=" + Date.now();
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let bannerRed = 0, boxRed = 0, ink = 0;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const strongRed = r > 165 && g < 115 && b < 95;
        if (strongRed) { if (y < 110) bannerRed++; else boxRed++; }
        if (r < 235 || g < 235 || b < 235) ink++;
      }
    }
    const total = c.width * c.height;
    return JSON.stringify({
      w: c.width, h: c.height,
      banner: bannerRed, box: boxRed,
      inkPct: +(ink / total * 100).toFixed(1),
    });
  })()`);
  stats.push({ f, ...s });
}

console.log("文件                        尺寸          顶部说明条   红框高亮   非白占比   判定");
let bad = 0;
for (const s of stats) {
  if (NO_ANN.has(s.f)) {
    console.log(`➖ ${s.f.padEnd(24)} ${String(s.w).padStart(4)}×${String(s.h).padEnd(5)}   （实拍照，不校验标注）`);
    continue;
  }
  const okBanner = s.banner > 20000;
  const okBox = s.box > 400;
  const okInk = s.inkPct > 1.2;
  const ok = okBanner && okBox && okInk;
  if (!ok) bad++;
  console.log(
    `${ok ? "✅" : "❌"} ${s.f.padEnd(24)} ${String(s.w).padStart(4)}×${String(s.h).padEnd(5)}` +
    ` ${String(s.banner).padStart(8)}   ${String(s.box).padStart(7)}   ${String(s.inkPct).padStart(6)}%   ` +
    `${!okBanner ? "缺说明条 " : ""}${!okBox ? "缺红框 " : ""}${!okInk ? "疑似空白 " : ""}`
  );
}
const totalKb = Math.round(files.reduce((a, f) => a + statSync(join(IMG_DIR, f)).size, 0) / 1024);
console.log(`\n${files.length} 张图，合计 ${totalKb} KB${bad ? `，其中 ${bad} 张不合格 ❌` : "，全部合格 ✅"}`);
process.exit(bad ? 1 : 0);
