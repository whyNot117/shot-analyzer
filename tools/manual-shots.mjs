// 图解操作手册的截图生成器（开发工具，不参与网站运行）
//
// 用途：把真实界面「按哪一步、点哪个键」拍成带标注的图片，供 docs/manual.html 与
// docs/使用手册.md 使用。标注直接画在页面上（红框 + 编号 + 顶部说明条），
// 再由 Orca 内置浏览器截图——文字是 Chromium 自己渲染的，中文字形不会错。
//
// 每拍完一张都会把 JPEG 读回画布校验：顶部说明条的红像素够不够。
// 不合格就重新标注再拍一次——偶发情况下浏览器会拍到还没重绘的空白帧。
//
// 运行前提（只在开发机上需要，网站本身零依赖）：
//   1. Orca 桌面端在运行，且本机装了 Orca CLI（环境变量 ORCA_CLI_COMMAND，或默认路径）
//   2. 本机已装 Node 18+（用来起 server.mjs）
//   3. 素材视频：默认取 C:/Users/LD1900/Videos/7119354509dc4f0017380799964f2476.mp4
//
// 用法：
//   node server.mjs                 （另开一个终端，先把本地服务起起来）
//   node tools/manual-shots.mjs      （生成 docs/img/ 下的全部图）
//   node tools/manual-shots.mjs redo 03 07        （只重拍某几张）
//   node tools/manual-shots.mjs github            （只重拍 GitHub 下载页那张）
//
// 生成的图片进 git（手册离线可看），素材视频绝不入库。

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, copyFileSync, writeFileSync, existsSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = "D:/homecourt";
const OUT_DIR = join(ROOT, "docs/img");
const LOCAL_URL = "http://127.0.0.1:5500/";
const REPO_URL = "https://github.com/whyNot117/shot-analyzer";
const CLIP = "C:/Users/LD1900/Videos/7119354509dc4f0017380799964f2476.mp4";
const ORCA = process.env.ORCA_CLI_COMMAND ||
  "C:/Users/LD1900/AppData/Local/Programs/orca/resources/bin/orca.exe";

// ---------- 调 Orca CLI ----------
function orca(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ORCA, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(`orca ${args[0]} 退出码 ${code}: ${err.slice(0, 400)}`));
      try { resolve(JSON.parse(out)); } catch { resolve({ raw: out, err }); }
    });
  });
}
async function evalJs(page, expression) {
  const j = await orca(["eval", "--page", page, "--expression", expression, "--json"]);
  if (!j.ok) throw new Error("页面执行失败: " + JSON.stringify(j.error || j).slice(0, 500));
  return j.result?.result;
}
async function evalJson(page, expression) {
  const raw = await evalJs(page, expression);
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

// ---------- 页面内的标注层 ----------
// 说明条在顶部，红框 + 编号圈在目标元素上；红框外压一层暗色，突出要点的那个控件。
const ANNOTATE = `
(async (cfg) => {
  document.getElementById("__ann")?.remove();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let rect = null;
  if (cfg.target) {
    const el = document.querySelector(cfg.target);
    if (!el) return "NOT_FOUND:" + cfg.target;
    el.scrollIntoView({ block: "center", behavior: "instant" });
    await sleep(600);
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return "NOT_VISIBLE:" + cfg.target;
    rect = { x: r.left, y: r.top, w: r.width, h: r.height };
  }
  const layer = document.createElement("div");
  layer.id = "__ann";
  layer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
  const banner = document.createElement("div");
  banner.style.cssText = "position:fixed;left:0;right:0;top:0;z-index:30;display:flex;gap:12px;align-items:flex-start;" +
    "background:linear-gradient(90deg,#b91c1c,#ea580c);color:#fff;padding:12px 18px;" +
    "font:700 19px/1.45 'Microsoft YaHei',system-ui,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.35);";
  const num = document.createElement("span");
  num.textContent = cfg.n;
  num.style.cssText = "flex:0 0 auto;background:#fff;color:#b91c1c;border-radius:50%;width:34px;height:34px;" +
    "display:inline-flex;align-items:center;justify-content:center;font-size:20px;";
  const cap = document.createElement("span");
  cap.textContent = cfg.caption;
  banner.append(num, cap);
  layer.appendChild(banner);
  const boxes = [];
  if (rect) boxes.push(rect);
  for (const b of (cfg.extra || [])) boxes.push(b);
  for (const b of boxes) {
    const d = document.createElement("div");
    d.style.cssText = "position:fixed;z-index:20;left:" + (b.x - 5) + "px;top:" + (b.y - 5) + "px;width:" + (b.w + 10) +
      "px;height:" + (b.h + 10) + "px;border:4px solid #dc2626;border-radius:12px;" +
      "box-shadow:0 0 0 9999px rgba(2,6,23,.45),0 0 22px rgba(220,38,38,.8);";
    layer.appendChild(d);
    const badge = document.createElement("div");
    badge.textContent = cfg.n;
    badge.style.cssText = "position:fixed;z-index:25;left:" + Math.max(2, b.x - 20) + "px;top:" + Math.max(66, b.y - 26) +
      "px;width:36px;height:36px;border-radius:50%;background:#dc2626;color:#fff;" +
      "display:flex;align-items:center;justify-content:center;font:800 20px 'Microsoft YaHei',system-ui;" +
      "box-shadow:0 3px 10px rgba(0,0,0,.45);";
    layer.appendChild(badge);
  }
  document.body.appendChild(layer);
  await sleep(500);
  return "OK";
})
`;

// 高亮某个 <select> 的指定选项（先把它临时展开成列表框，选项名是真的）
const EXPAND_SELECT = `
(async (sel, value) => {
  const s = document.querySelector(sel);
  if (!s) return "NOT_FOUND";
  s.size = 6;
  s.style.background = "#fff";
  await new Promise((res) => setTimeout(res, 300));
  const opt = [...s.options].find((o) => o.value === value) || s;
  const r = opt.getBoundingClientRect();
  return JSON.stringify({ x: r.left, y: r.top, w: r.width, h: r.height });
})
`;

async function clearAnn(page) {
  await evalJs(page, `(()=>{document.getElementById("__ann")?.remove();return "ok"})()`).catch(() => {});
}

// 把拍好的 JPEG 读回画布，数说明条的红像素：拍糊了（空白帧）就是红像素不够
async function verifyShot(verifyPage, file) {
  try {
    const r = await evalJson(verifyPage, `(async () => {
      const img = new Image();
      img.src = "/docs/img/${file}?t=" + Date.now();
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const g = c.getContext("2d");
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let banner = 0, box = 0, ink = 0;
      for (let y = 0; y < c.height; y++) {
        for (let x = 0; x < c.width; x++) {
          const i = (y * c.width + x) * 4;
          const r = d[i], gg = d[i + 1], b = d[i + 2];
          const strongRed = r > 165 && gg < 115 && b < 95;
          if (strongRed) { if (y < 110) banner++; else box++; }
          if (r < 235 || gg < 235 || b < 235) ink++;
        }
      }
      const n = c.width * c.height;
      return JSON.stringify({ banner, box, inkPct: +(ink / n * 100).toFixed(1) });
    })()`);
    return r;
  } catch (e) {
    return { banner: -1, box: -1, inkPct: -1 };
  }
}

// 拍一张：标注 → 截图 → 校验 → 不合格重拍
async function shootAnnotated(page, verifyPage, file, cfg, opts = {}) {
  const { width = 980, height = 1300, needBox = true } = opts;
  await orca(["viewport", "--page", page, "--width", String(width), "--height", String(height), "--json"]);
  mkdirSync(OUT_DIR, { recursive: true });
  const dst = join(OUT_DIR, file);
  for (let attempt = 1; attempt <= 4; attempt++) {
    const r = await evalJs(page, `(${ANNOTATE})(${JSON.stringify(cfg)})`);
    if (String(r).startsWith("NOT_FOUND")) throw new Error(`${file} 找不到目标元素: ${r}`);
    if (String(r).startsWith("NOT_VISIBLE")) {
      await sleep(1200);
      const r2 = await evalJs(page, `(${ANNOTATE})(${JSON.stringify(cfg)})`);
      if (String(r2).startsWith("NOT_VISIBLE")) throw new Error(`${file} 目标元素不可见: ${r2}`);
    }
    await sleep(500);
    const j = await orca(["screenshot", "--page", page, "--format", "jpeg", "--json"]);
    if (!j.result?.path) throw new Error("截图失败: " + JSON.stringify(j).slice(0, 300));
    copyFileSync(j.result.path, dst);
    const kb = Math.round(statSync(dst).size / 1024);
    const v = await verifyShot(verifyPage, file);
    const okBanner = v.banner > 20000;
    const okBox = !needBox || v.box > 400;
    if (okBanner && okBox) {
      console.log(`  📷 ${file}  (${kb} KB)`);
      return dst;
    }
    console.log(`  ⚠️ ${file} 拍糊了（红像素 banner=${v.banner} box=${v.box}），重拍…`);
    await clearAnn(page);
    await sleep(900);
  }
  console.log(`  ❌ ${file} 连拍四次都不合格，保留最后一张，请人工看一眼`);
  return dst;
}

// 把本机素材喂给页面的文件框：起一个临时静态服务，页面里用 DataTransfer 塞进去。
// 不用 orca upload 的原因是它要靠无障碍快照里的 ref，而本机 Orca 版本的快照
// 不给无障碍名字，label 的 ref 认不出来。
async function feedVideo(page) {
  const vbuf = readFileSync(CLIP);
  const vsrv = createServer((req, res) => {
    res.writeHead(200, {
      "Content-Type": "video/mp4",
      "Access-Control-Allow-Origin": "*",
      "Content-Length": vbuf.length,
    });
    res.end(vbuf);
  });
  await new Promise((r) => vsrv.listen(5671, "127.0.0.1", r));
  const fed = await evalJs(page, `(async () => {
    const blob = await (await fetch("http://127.0.0.1:5671/clip.mp4")).blob();
    const file = new File([blob], "投篮示例.mp4", { type: "video/mp4" });
    const dt = new DataTransfer(); dt.items.add(file);
    const inp = document.getElementById("video-input");
    inp.files = dt.files;
    inp.dispatchEvent(new Event("change", { bubbles: true }));
    return "fed";
  })()`);
  vsrv.close();
  if (fed !== "fed") throw new Error("喂素材失败: " + fed);
  // 等视频元数据出来，第 2 步区块才会显示
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const ok = await evalJson(page, `(()=>!document.getElementById("step-analyze").classList.contains("hidden"))()`);
    if (ok) break;
  }
  await sleep(800);
}

// ---------- 步骤定义 ----------
const STEP_DEFS = {
  "01": {
    file: "01-open.jpg",
    caption: "两种用法：① 直接用网页版——浏览器打开 https://whyNot117.github.io/shot-analyzer/ ，不用装任何东西；" +
      "② 下载到本机自己跑——在本地打开 http://127.0.0.1:5500/ ，之后都是这个页面。",
    target: "#step-upload h2",
  },
  "02": {
    file: "02-pick-video.jpg",
    caption: "第 1 步：点「📷 选择 / 拍摄视频」，在弹出的文件框里选你拍好的投篮视频（手机相册里的 MP4 也行）。",
    target: "label.upload-btn[for='video-input']",
  },
  "03": {
    file: "03-file-loaded.jpg",
    caption: "选好后这里会显示文件名和大小；下面「2. 分析」这一整块会自动出现，说明视频已经就位。",
    target: "#file-name",
  },
  "04": {
    file: "04-checklist.jpg",
    caption: "「📹 怎么拍才准」是拍摄时的自查清单，下一次拍摄照着它来，读数会准很多。不勾也能正常分析。",
    target: "#shot-checklist",
  },
  "05": {
    file: "05-shot-type.jpg",
    caption: "投篮类型：一般保持默认的「自动识别（按是否起跳）」就行。只有你确定是定点罚球、又怕误判时才手动选。",
    select: { sel: "#shot-type", value: "auto" },
  },
  "06": {
    file: "06-scene.jpg",
    caption: "场景：同样保持「自动识别」。它靠画面里有没有横向移动，来判断是定点站投还是移动后出手。",
    select: { sel: "#shot-scene", value: "auto" },
  },
  "07": {
    file: "07-analyze.jpg",
    caption: "点「🧠 开始分析」。第一次会先下载识别模型（约 5–10 MB，之后有缓存），然后逐帧扫描，十几秒到一分钟出结果。",
    target: "#btn-analyze",
  },
  "08": {
    file: "08-report.jpg",
    caption: "第 3 步：报告在这里。分数只是筛查参考，不是命中率预测；每个指标点后面的 ⓘ 能看到它到底在量什么。",
    target: "#step-report h2",
  },
  "09": {
    file: "09-overlay.jpg",
    caption: "播放时骨架会跟着人走：蓝色骨架 + 橙色关节 = 本次分析的那个人，灰色骨架 = 画面里的其他人。" +
      "灰色骨架出现说明主体已经走出画面、现在跟拍的是别人，报告里会写明。",
    target: "#video-wrap",
  },
  "10": {
    file: "10-toggles.jpg",
    caption: "三个开关可以随时改：关掉「关键点」只看骨架线，关掉「角度」去掉角度数字。想看骨架长什么样点一下就行。",
    target: "#toggles",
  },
  "11": {
    file: "11-fusion.jpg",
    caption: "第 4 步（可选）：侧面机位看不到肘内外展和左右对称。按报告里的补拍建议补一段正面，再传到这里生成融合报告。",
    target: "#step-fusion",
  },
  "12": {
    file: "12-compare.jpg",
    caption: "第 5 步（可选）：传一段参考视频（教练示范或职业球员片段），它会逐帧对齐后对比你们各关节的差异。",
    target: "#step-compare",
  },
  "13": {
    file: "13-history.jpg",
    caption: "第 6 步：每次分析自动存进本机档案，可以导出成文件带走、换设备时导入。档案和视频一样不上传。",
    target: "#step-history",
  },
};

const PRE_STEPS = ["01", "02", "03", "04", "05", "06", "07"];
const POST_STEPS = ["08", "09", "10", "11", "12", "13"];

async function runSteps(page, verifyPage, ids) {
  for (const id of ids) {
    const d = STEP_DEFS[id];
    if (!d) continue;
    let extra = [];
    if (d.select) {
      const r = JSON.parse(await evalJs(page, `(${EXPAND_SELECT})(${JSON.stringify(d.select.sel)}, ${JSON.stringify(d.select.value)})`));
      extra = [r];
    }
    await shootAnnotated(page, verifyPage, d.file, { n: Number(id), caption: d.caption, target: d.target || null, extra });
    await clearAnn(page);
    if (d.select) {
      await evalJs(page, `(()=>{const s=document.querySelector(${JSON.stringify(d.select.sel)});s.size=1;s.removeAttribute("size");return "ok"})()`);
    }
  }
}

// ---------- GitHub 下载页那张 ----------
async function githubShot(existingPage) {
  let gpage = existingPage;
  if (!gpage) {
    const t = await orca(["tab", "create", "--url", REPO_URL, "--json"]);
    gpage = t.result.browserPageId;
  }
  // 本机到 github.com 经常撞上被重置的连接，失败就重试
  for (let i = 0; i < 8; i++) {
    const title = await evalJs(gpage, "document.title").catch(() => "");
    if (title && !title.includes("error")) break;
    const t = await orca(["tab", "create", "--url", REPO_URL, "--json"]);
    gpage = t.result.browserPageId;
    await sleep(9000);
  }
  await orca(["viewport", "--page", gpage, "--width", "1200", "--height", "900", "--json"]);
  await sleep(2000);
  // 页面里有两个带 "Code" 字样的东西：左边栏的 Code 标签页，和右上角带下拉箭头的
  // 「Code」按钮。要的是后者——取位置最靠右的那个。
  const PICK_CODE = `
    (()=>{
      const cands = [...document.querySelectorAll("button, summary, a")]
        .filter((b) => /^Code\\b/.test((b.textContent||"").trim()))
        .map((b) => ({ b, r: b.getBoundingClientRect() }))
        .filter((x) => x.r.width > 4 && x.r.height > 4);
      if (!cands.length) return null;
      cands.sort((a, z) => z.r.left - a.r.left);
      return cands[0].b;
    })()
  `;
  const found = await evalJson(gpage, `(()=>{
    const btn = ${PICK_CODE};
    if (!btn) return JSON.stringify({ ok: false, title: document.title });
    btn.scrollIntoView({ block: "center" });
    btn.click();
    return JSON.stringify({ ok: true });
  })()`);
  if (!found.ok) throw new Error("GitHub 页上没找到 Code 按钮（title=" + found.title + "）");
  await sleep(1800);
  // 菜单展开后页面会重排，坐标必须在展开之后重新量
  const boxes = await evalJson(gpage, `(()=>{
    const out = [];
    const btn = ${PICK_CODE};
    if (btn) { const r = btn.getBoundingClientRect(); out.push({ x: r.left, y: r.top, w: r.width, h: r.height }); }
    const a = [...document.querySelectorAll("a")].find((x) => /Download ZIP/.test(x.textContent));
    if (a) { const r = a.getBoundingClientRect(); out.push({ x: r.left, y: r.top, w: r.width, h: r.height }); }
    return JSON.stringify({ out, scrollY: window.scrollY, vh: window.innerHeight });
  })()`);
  const extra = boxes.out.filter((b) => b.w > 4 && b.h > 4 && b.y > 100 && b.y < boxes.vh - 10);
  if (!extra.length) throw new Error("GitHub 页上没量到 Code / Download ZIP 的位置: " + JSON.stringify(boxes));
  // 校验页用本地站点（要能读到 /docs/img/ 下的成品）
  const vtab = await orca(["tab", "create", "--url", LOCAL_URL + "docs/manual.html", "--json"]);
  await sleep(2000);
  await shootAnnotated(gpage, vtab.result.browserPageId, "14-download-zip.jpg", {
    n: 14,
    caption: "下载源码：仓库页右上角点「Code」→「Download ZIP」，解压后按手册第 2 部分在本机跑起来。",
    target: null,
    extra,
  }, { width: 1200, height: 900 });
  await clearAnn(gpage);
}

// ---------- 主流程 ----------
async function main() {
  if (!existsSync(CLIP)) throw new Error("找不到素材视频: " + CLIP);
  mkdirSync(OUT_DIR, { recursive: true });

  // 校验页：本地站点，能读到 /docs/img/ 下的成品
  const vtab = await orca(["tab", "create", "--url", LOCAL_URL + "docs/manual.html", "--json"]);
  const verifyPage = vtab.result.browserPageId;
  await sleep(2000);

  if (process.argv[2] === "github") {
    await githubShot(process.argv[3]);
    return;
  }

  const tab = await orca(["tab", "create", "--url", LOCAL_URL, "--json"]);
  const page = tab.result.browserPageId;
  console.log("本地页面:", page);
  await orca(["viewport", "--page", page, "--width", "980", "--height", "1300", "--json"]);
  await sleep(2500);

  const redoIds = process.argv[2] === "redo" ? process.argv.slice(3) : null;
  if (redoIds) {
    // 重拍的都是「已经喂过素材之后」的界面
    await feedVideo(page);
    await runSteps(page, verifyPage, redoIds);
    console.log("重拍完成");
    return;
  }

  // 01、02 是还没选视频时的界面
  await runSteps(page, verifyPage, ["01", "02"]);
  await feedVideo(page);
  await runSteps(page, verifyPage, ["03", "04", "05", "06", "07"]);

  // 跑分析，后面的图需要报告与叠加层
  console.log("  ⏳ 开始分析…");
  await evalJs(page, `document.getElementById("btn-analyze").click(); "clicked"`);
  for (let i = 0; i < 300; i++) {
    await sleep(1000);
    const st = await evalJson(page, `(()=>{const b=document.getElementById("report-body");return JSON.stringify({len:(b?.innerHTML||"").length, txt:(document.getElementById("status-text")?.textContent||"")})})()`);
    if (st.len > 200) break;
    if (i % 15 === 0) console.log(`     ${st.txt || "分析中…"}`);
  }
  await sleep(1500);
  await evalJs(page, `(async()=>{const v=document.getElementById("video");v.pause();v.currentTime=9.6;await new Promise(r=>setTimeout(r,1500));return "ok"})()`);
  await sleep(1000);

  await runSteps(page, verifyPage, POST_STEPS);

  writeFileSync(join(OUT_DIR, "manifest.json"), JSON.stringify(
    Object.entries(STEP_DEFS).map(([id, d]) => ({ id, file: d.file, caption: d.caption })), null, 2));
  console.log("\n✅ 全部完成");
}

main().catch((e) => { console.error("失败:", e.message); process.exit(1); });
