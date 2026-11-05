// 真实素材端到端验证工具：用无头 Edge + Chrome DevTools Protocol 跑一次真实分析，
// 把报告里的指标读数打印出来。v5.7 的两个关键修复（出手高度区间按起跳自适应、
// 关键点定位漂移过滤）都是靠这个工具在真人素材上发现并验证的。
//
// 用法：
//   node tools/e2e-real.mjs <视频文件名> [站点地址]
//   例如 node tools/e2e-real.mjs _v1.mp4 http://127.0.0.1:5500/
//
// 前置条件：
//   1) 本地服务器已启动（默认 http://127.0.0.1:5500/，即 `node server.mjs`）；
//   2) 视频文件放在站点根目录下（工具用 fetch 从站点取，不用本地文件协议，
//      因此视频不离开本机，浏览器端也不会有跨域限制）；
//   3) 机器上装有 Edge（可用环境变量 SHOT_EDGE 指定路径）。
//
// 视频素材不入库：这里只接受文件名参数，仓库里不含任何用户视频。

import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const VIDEO = process.argv[2];
if (!VIDEO) {
  console.error("用法：node tools/e2e-real.mjs <视频文件名> [站点地址]");
  process.exit(1);
}
const SITE = (process.argv[3] || "http://127.0.0.1:5500/").replace(/\/?$/, "/");
const PORT = Number(process.env.SHOT_CDP_PORT || 9333);
const EDGE = process.env.SHOT_EDGE || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
// 浏览器配置目录放系统临时目录，不写死在某台机器的路径上
const PROFILE = process.env.SHOT_PROFILE || join(tmpdir(), "shot-e2e-profile");

const proc = spawn(
  EDGE,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    "--autoplay-policy=no-user-gesture-required",
    "--window-size=900,1400",
    SITE,
  ],
  { stdio: "ignore" }
);

async function cdpTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page;
    } catch {
      /* Edge 还没起来 */
    }
    await sleep(500);
  }
  throw new Error("Edge CDP 没起来（检查 Edge 是否安装在 SHOT_EDGE 指定的路径）");
}

const target = await cdpTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});

let id = 0;
const pending = new Map();
const logs = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
  if (msg.method === "Runtime.consoleAPICalled") {
    logs.push(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
  }
  if (msg.method === "Runtime.exceptionThrown") {
    logs.push("[EXCEPTION] " + (msg.params.exceptionDetails.exception?.description ?? ""));
  }
};
const send = (method, params = {}) =>
  new Promise((res) => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });

await send("Runtime.enable");
await send("Page.enable");

const evaluate = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) {
    throw new Error(r.result.exceptionDetails.exception?.description ?? "eval failed");
  }
  return r.result?.result?.value;
};

await sleep(1500);

// 注入视频：从站点取，素材不经过本地文件协议
await evaluate(`(async () => {
  const blob = await (await fetch('/${VIDEO}')).blob();
  const file = new File([blob], '${VIDEO}', { type: 'video/mp4' });
  const dt = new DataTransfer();
  dt.items.add(file);
  const inp = document.getElementById('video-input');
  inp.files = dt.files;
  inp.dispatchEvent(new Event('change', { bubbles: true }));
  return inp.files.length;
})()`);

await evaluate(`(() => { document.getElementById('btn-analyze').click(); return true; })()`);

let ready = false;
for (let i = 0; i < 180; i++) {
  await sleep(1000);
  const has = await evaluate(
    `!!(document.getElementById('report-body') && document.getElementById('report-body').innerHTML.length > 50)`
  );
  if (has) {
    ready = true;
    break;
  }
  if (i % 15 === 0) {
    console.log(`  [${i}s] ${await evaluate(`document.getElementById('status-text')?.textContent`)}`);
  }
}

if (!ready) {
  console.log("超时未出报告。最后状态：", await evaluate(`document.getElementById('status-text')?.textContent`));
} else {
  const out = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('#report-body .metric-row')].map((r) => ({
      name: r.querySelector('.m-name')?.textContent.trim(),
      value: r.querySelector('.m-value')?.childNodes[0]?.textContent.trim(),
      verdict: r.className.replace('metric-row', '').trim(),
    }));
    const summary = document.querySelector('#report-body .summary-text')?.textContent.replace(/\s+/g, ' ').trim();
    const tips = [...document.querySelectorAll('#report-body .tip-card')].map((t) => t.textContent.replace(/\s+/g, ' ').trim());
    return JSON.stringify({ rows, summary, tips }, null, 1);
  })()`);
  console.log("\n=== 报告 ===");
  console.log(out);
  console.log("\n=== 状态行 ===");
  console.log(await evaluate(`document.getElementById('status-text')?.textContent`));
  const hist = await evaluate(`(() => {
    const hb = document.getElementById('history-body');
    return JSON.stringify({
      records: hb?.querySelectorAll('.hist-item').length ?? 0,
      charts: hb?.querySelectorAll('svg').length ?? 0,
    });
  })()`);
  console.log("\n=== 训练档案 ===");
  console.log(hist);
}

if (logs.length) {
  console.log("\n=== 控制台 ===");
  for (const l of logs.slice(0, 30)) console.log(" ", l);
}

ws.close();
proc.kill();
process.exit(0);
