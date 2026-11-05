// 应用主流程：选视频 → 逐帧扫描姿态 → 播放时叠加骨架
import { getLandmarker, resetLandmarker, nextTimestamp, beginScan } from "./pose.js";
import { drawFrame, pickSide, pickShootingSide, SIDE } from "./draw.js";
import { detectShotCycles, mergeCycles, computeMetrics, cycleCurves, standingBodyHeight, METRIC_NAMES, METRIC_VIEWS, LOWER_IS_BETTER } from "./metrics.js";
import { buildReport, renderReport, TYPE_LABEL, setProfile } from "./report.js";
import { classifyView, VIEW_LABEL, coverageGaps, windowVisibility, courtGuideSVG } from "./views.js";
import { normalizeSequence, dtwAlign, jointDeviations, JOINT_LABEL, JOINT_ADVICE } from "./compare.js";
import { isHevcFile, makePersonPicker } from "./media.js";
import {
  listRecords, addRecord, removeRecord, clearRecords,
  exportText, importText, metricSeries, compareMetric, summarize, makeRecord,
} from "./history.js";
import { lineChart } from "./charts.js";
import { SCENE_LABEL } from "./scene.js";

console.log("🏀 投篮姿态分析 · 代码版本 v5.4（2026-10-30）——评分异常时请先确认此版本并强制刷新（Ctrl+F5）");

const $ = (id) => document.getElementById(id);
const video = $("video");
const overlay = $("overlay");
const octx = overlay.getContext("2d");
// 离屏 canvas 作为推理输入（尺寸与视频一致，不受显示尺寸影响）
const inferCanvas = document.createElement("canvas");
const inferCtx = inferCanvas.getContext("2d");

const SAMPLE_FPS = 30;   // 扫描采样率
const MAX_SECONDS = 30;  // 超长视频只分析前 30 秒

let frames = [];         // [{ t, landmarks }]
let scanSpan = 0;        // 实际扫描时长
let chosenSide = "right";
let lastCycle = null;    // 主周期：骨架叠加与对比功能用
let lastCycles = [];     // 全部检测到的出手周期（报告逐指标取中位数）
let lastDetection = null; // 周期检测缓存：切换投篮类型直接复用，避免选臂回写改变下次检测
let loopRunning = false;
let mainView = "side";   // 主视频机位（side/front/oblique/unknown）
let mainVis = 0;         // 主视频动作窗口内出手侧关键点平均可见度

// PWA：注册 Service Worker，缓存应用与模型，二次访问离线可用
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  navigator.serviceWorker.register("./sw.js").catch(() => {
    // 注册失败可能是残留的旧 SW 损坏：清理掉，避免永远命中旧缓存
    navigator.serviceWorker.getRegistrations?.()
      .then((rs) => rs.forEach((r) => r.unregister()))
      .catch(() => {});
  });
}

// ---------- 1. 选择视频 ----------
// HEVC(H.265) 解码失败时的针对性指引（微信高清视频常用该编码，部分浏览器/系统解不了）
const HEVC_HINT =
  "❌ 这个视频是 <b>HEVC（H.265）</b>编码，当前浏览器解不了——微信发的高清视频常用这种格式。免费解决办法（任选其一）：<br>" +
  "① 转一次格式：电脑装 <b>VLC</b>（免费）→ 媒体 → 转换/保存 → 添加这个文件 → 转换 → 配置文件选「Video - H.264 + MP3 (MP4)」→ 开始，转完上传新文件；<br>" +
  "② 或用免费软件「格式工厂」转成 MP4；<br>" +
  "③ 视频是 iPhone 拍的话：设置 → 相机 → 格式 → 选「兼容性最佳」，以后录出来就是通用格式；<br>" +
  "④ 让发送方用微信直接发送（不勾「原图」），压缩后的视频通常是通用格式。";

let mainFile = null; // 当前主视频文件（解码失败时用于嗅探编码）

$("video-input").addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  mainFile = file;
  $("file-name").textContent = `${file.name}（${(file.size / 1024 / 1024).toFixed(1)} MB）`;
  video.src = URL.createObjectURL(file);
  video.load();
});

// 浏览器解不了码（如缺 HEVC 解码器）时明确告知原因与办法，而不是默默没反应
video.addEventListener("error", async () => {
  if (!mainFile) return;
  const hevc = await isHevcFile(mainFile);
  $("file-name").innerHTML = hevc
    ? HEVC_HINT
    : "❌ 浏览器无法解码这个视频，请换 MP4（H.264）格式的文件。";
  $("btn-analyze").disabled = true;
});

video.addEventListener("loadedmetadata", () => {
  if (!video.videoWidth) return; // 元数据可读但视频轨解不了码——等 error 事件给出针对性指引
  $("step-analyze").classList.remove("hidden");
  $("btn-analyze").disabled = false;
  $("progress-wrap").classList.add("hidden");
  $("toggles").classList.add("hidden");
  $("step-report").classList.add("hidden"); // 换新视频时隐藏上一份报告
  frames = [];
  lastCycle = null;
  lastCycles = [];
  lastDetection = null;
  fusionRendered = false; // 融合报告基于主视频，一并清空
  $("fusion-report").innerHTML = "";
  $("fusion-gaps").innerHTML = "";
  updateFusionUI();
  overlay.width = video.videoWidth;
  overlay.height = video.videoHeight;
  inferCanvas.width = video.videoWidth;
  inferCanvas.height = video.videoHeight;
  $("btn-analyze").scrollIntoView({ behavior: "smooth", block: "center" });
});

// ---------- 1b. 个人资料（存本机 localStorage，用于报告个性化展示） ----------
const PF_KEY = "shot-analyzer-profile";
const profile = (() => {
  try { return JSON.parse(localStorage.getItem(PF_KEY)) ?? {}; } catch { return {}; }
})();
setProfile(profile);
for (const k of ["height", "weight", "age"]) {
  const el = $(`pf-${k}`);
  if (profile[k]) el.value = profile[k];
  el.addEventListener("change", () => {
    const v = parseFloat(el.value);
    if (isFinite(v) && v > 0) profile[k] = v;
    else { delete profile[k]; el.value = ""; }
    try { localStorage.setItem(PF_KEY, JSON.stringify(profile)); } catch { /* 隐私模式存不进去就算了 */ }
  });
}

// ---------- 2. 逐帧扫描 ----------
$("btn-analyze").addEventListener("click", analyze);

async function analyze() {
  $("btn-analyze").disabled = true;
  $("btn-play").disabled = true;
  $("progress-wrap").classList.remove("hidden");
  setStatus("加载识别模型中…（首次约 5–10 MB，之后有缓存）");
  lastDetection = null; // 重扫的 frames 与旧缓存未必逐位一致（CPU/GPU 差异、间歇失败帧），周期索引必须重算

  let landmarker;
  try {
    landmarker = await getLandmarker();
  } catch (err) {
    setStatus(`模型加载失败：${err?.message ?? err}。请检查网络后重试。`);
    $("btn-analyze").disabled = false;
    return;
  }

  video.pause();
  scanSpan = Math.min(video.duration || 0, MAX_SECONDS);
  const note = video.duration > MAX_SECONDS ? `（视频较长，仅分析前 ${MAX_SECONDS} 秒）` : "";

  frames = await scanInto(video, landmarker, (p) => {
    const pct = Math.round(p * 100);
    setStatus(`识别中… ${pct}%${note}`);
    $("progress-fill").style.width = `${pct}%`;
  }, (n) => setStatus(`⚠️ ${n}`));

  $("progress-fill").style.width = "100%";
  const detected = frames.filter((f) => f.landmarks).length;
  if (detected === 0) {
    setStatus("未识别到人像。请确认画面中有清晰的全身人像、光线充足，然后重新选择视频。");
    $("btn-analyze").disabled = false;
    updateFusionUI();
    return;
  }
  chosenSide = pickSide(frames);
  mainView = classifyView(frames);
  setStatus(`识别完成：${detected}/${frames.length} 帧检测到人像${frames.peopleSeen > 1 ? `（画面出现 ${frames.peopleSeen} 人，已锁定占画面最大的投篮者）` : ""}，机位：${VIEW_LABEL[mainView]}。${frames.failedFrames ? `⚠️ ${frames.failedFrames} 帧推理失败已插值。` : ""}报告已生成，也可点击播放查看骨架叠加。`);
  runReport();
  $("btn-analyze").disabled = false;
  $("btn-analyze").textContent = "🔄 重新分析";
  $("btn-play").disabled = false;
  $("toggles").classList.remove("hidden");
  ensureRenderLoop();
}

// ---------- 3. 播放叠加 ----------
// 常驻渲染循环：按视频当前时间取最近一帧结果画到 overlay 上
function ensureRenderLoop() {
  if (loopRunning) return;
  loopRunning = true;
  const dt = 1 / SAMPLE_FPS;
  const draw = () => {
    if (frames.length) {
      const idx = Math.max(0, Math.min(frames.length - 1, Math.round(video.currentTime / dt)));
      drawFrame(octx, frames[idx]?.landmarks ?? null, {
        showSkeleton: $("tg-skeleton").checked,
        showJoints: $("tg-joints").checked,
        showAngles: $("tg-angles").checked,
        side: chosenSide,
      });
    }
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);
}

$("btn-play").addEventListener("click", () => {
  if (video.paused) {
    if (video.currentTime >= scanSpan - 0.05) video.currentTime = 0;
    video.play();
    $("btn-play").textContent = "⏸ 暂停";
  } else {
    video.pause();
    $("btn-play").textContent = "▶ 播放";
  }
});

// ---------- 4. 姿态报告 ----------
// archive=true 时把本次结果存进训练档案（重新分析同一段视频也算一次真实数据）；
// 切换投篮类型只是重新评分，不该在档案里堆重复记录
function runReport(archive = true) {
  const type = $("shot-type").value;
  const sceneHint = $("shot-scene").value; // auto = 自动识别，也可手动指定场景
  // 检测结果按视频缓存：切换投篮类型时不重新检测——否则 pickShootingSide 的选臂
  // 回写会成为下次检测的首选侧，同一视频换一次类型评分就可能不同。
  // 场景例外：移动/接球的基线选取与场景判定有关，改场景必须重新检测。
  const detect =
    lastDetection && lastDetection.sceneHint === sceneHint
      ? lastDetection
      : detectShotCycles(frames, chosenSide, SAMPLE_FPS, sceneHint);
  lastDetection = detect;
  const cycles = detect.cycles;
  lastCycle = cycles[0] ?? null;
  lastCycles = cycles;
  const cycle = lastCycle;
  if (cycle) chosenSide = detect.side; // 正面机位下可能靠另一侧才检出出手
  const body = $("report-body");
  $("step-report").classList.remove("hidden");
  // 人物在画面里的时间太短 → 连一次出手都测不了（周期检测要求有效帧 ≥0.8 秒）
  const validRatio = frames.length ? frames.filter((f) => f.landmarks).length / frames.length : 0;
  const rejectNote = cycles.rejected
    ? `⚠️ 有 ${cycles.rejected} 次出手未计入（${cycles.rejectNote || "人物未完整出现在画面里"}）——这段动作无法可靠测量，报告只基于已计入的出手。`
    : "";
  if (!cycle) {
    body.innerHTML =
      '<p class="report-empty">未能检测到明显的出手动作（需要手腕高于肩部的瞬间）。请确认视频包含完整的投篮过程：持球 → 下蹲 → 出手 → 跟随。</p>'
      + (validRatio < 0.3
        ? '<p class="report-empty">⚠️ 画面中能识别到人的时间太短（不足全程的 30%），请让投篮者完整入镜。</p>'
        : "")
      + (frames.peopleSeen > 1
        ? '<p class="report-empty">⚠️ 画面中有多人，可能锁定到了非投篮者——建议重拍：主人公占画面一半以上、其余人远离镜头或出画。</p>'
        : "")
      + (rejectNote ? `<p class="report-empty">${rejectNote}</p>` : "");
    updateFusionUI();
    return;
  }
  // 正面/斜侧机位下双臂都可见，按「出手瞬间腕部更高的一侧」选定出手臂
  if (mainView === "front" || mainView === "oblique") chosenSide = pickShootingSide(frames, cycles, chosenSide);
  mainVis = windowVisibility(frames, Object.values(SIDE[chosenSide]), cycle.crouchIdx, cycle.apexIdx);
  // 多次出手逐次计算后取中位数：比单次出手更接近真实水平，也消除「两次分析选中不同出手」的评分漂移
  const metrics = mergeCycles(cycles.map((c) => computeMetrics(frames, c, chosenSide, type, mainView)));
  const report = buildReport(metrics, type, cycles.length);
  // 存档 + 「较上次」对比（对比基准是存档前的历史，所以先取历史再写入当前记录）
  const cmp = saveToArchive(report, metrics, "主视频", mainView, archive);
  // 关键动作曲线：用第一个（代表性）出手画肘角/膝角走势
  const curves = cycle ? cycleCurves(frames, cycle, chosenSide, SAMPLE_FPS) : null;
  // 场景判定结果（scene/sceneConfidence/sceneReason 由检测周期带着）
  const sceneId = cycle.scene ?? "spot";
  const sceneInfo = {
    scene: sceneId,
    label: SCENE_LABEL[sceneId] ?? sceneId,
    confidence: cycle.sceneConfidence ?? 0,
    reason: cycle.sceneReason ?? "",
    manual: sceneHint !== "auto",
  };
  renderReport(body, report, {
    jump: true, note: rejectNote, // 建议卡可点击回看视频瞬间
    compare: cmp.compare, compareSummary: cmp.summary,
    curves,
    curveNote: mainView === "front" ? "正面机位读数为投影角，参考意义有限。" : "",
    scene: sceneInfo,
    // 移动/接球场景是实验性功能，结论要打上醒目提示
    experimental: sceneId === "moving" || sceneId === "catch",
  });
  renderGapCard(body);
  body.scrollIntoView({ behavior: "smooth", block: "start" });
  updateFusionUI();
}

// 报告下方的「补拍建议」：机位盲区 + 识别质量提示 + 机位示意图
function renderGapCard(body) {
  const card = document.createElement("div");
  card.className = "gap-card";
  let html = "<h3>📷 补拍建议</h3>";

  if (mainVis < 0.5) {
    html += `<p class="gap-quality">⚠️ 本视频识别质量偏低（出手侧关键点平均置信度 ${Math.round(mainVis * 100)}%），建议同机位重拍：光线更充足、全身入镜、手机固定、背景干净。</p>`;
  }
  if (lastCycle && lastCycle.confidence < 0.5) {
    html += `<p class="gap-quality">⚠️ 仅 ${Math.round(lastCycle.confidence * 100)}% 的帧识别到人像，关键帧定位可能不准，重拍一段更清晰的视频会更可靠。</p>`;
  }

  const gaps = coverageGaps(mainView);
  const needViews = [...new Set(gaps.map((g) => g.view))];
  let intro;
  if (mainView === "oblique") {
    intro = `当前是<b>斜侧机位</b>，两向指标只能近似测量，建议补拍<b>${needViews.map((v) => VIEW_LABEL[v]).join("、")}</b>机位以获得更准的数据`;
  } else if (mainView === "unknown") {
    intro = `未能自动判别机位（已按侧面近似分析），建议补拍<b>${needViews.map((v) => VIEW_LABEL[v]).join("、")}</b>机位`;
  } else {
    intro = `当前是<b>${VIEW_LABEL[mainView]}机位</b>，以下因素在此视角被遮挡、无法测量：${gaps
      .map((g) => `<b>${g.reason}</b>（需${VIEW_LABEL[g.view]}机位）`)
      .join("；")}`;
  }
  html += `<p>${intro}。</p>`;
  if (mainView === "side") {
    html += `<p class="gap-note">💡 侧面视频里背对镜头的半边身体同样会被遮挡——本报告分析的是朝向镜头的一侧；想同时对照两侧手臂，可再拍另一侧面一起融合。</p>`;
  }
  html += `<p>👇 按示意图补拍一段，到「4. 多角度融合」上传，即可生成覆盖全部指标的完整报告：</p>`;
  html += `<div class="guide-wrap small">${courtGuideSVG(needViews)}</div>`;

  card.innerHTML = html;
  body.appendChild(card);
}

// 手动指定场景 → 重新判定基线并重新出报告（不写入档案，避免同一段视频堆重复记录）
$("shot-scene").addEventListener("change", () => {
  if (frames.length && !$("btn-play").disabled) runReport(false);
});

// 分析完成后切换投篮类型 → 按新标准直接重新生成报告（无需重新识别）
$("shot-type").addEventListener("change", () => {
  if (frames.length && !$("btn-play").disabled) runReport(false);
  if (fusionRendered) generateFusion(false); // 融合报告按新标准同步重算
});

// 点击建议卡 → 视频跳到出问题的瞬间，让用户亲眼看到原因
$("report-body").addEventListener("click", (e) => {
  const card = e.target.closest(".tip-card[data-frame]");
  if (!card) return;
  const idx = Math.max(0, Math.min(frames.length - 1, Number(card.dataset.frame)));
  const f = frames[idx];
  if (!f) return;
  video.pause();
  $("btn-play").textContent = "▶ 播放";
  video.currentTime = f.t;
  $("video-wrap").scrollIntoView({ behavior: "smooth", block: "center" });
});

// ---------- 5. 动作对比（参考视频） ----------
const dualMy = $("dual-my");
const dualMyOverlay = $("dual-my-overlay");
const dualMyCtx = dualMyOverlay.getContext("2d");
const refVideo = $("ref-video");
const refOverlay = $("ref-overlay");
const refCtx = refOverlay.getContext("2d");
let refFrames = [];
let dualRunning = false;

let refFile = null; // 当前参考视频文件（解码失败时用于嗅探编码）

$("ref-input").addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  refFile = file;
  refVideo.src = URL.createObjectURL(file);
  refVideo.load();
});

refVideo.addEventListener("error", async () => {
  if (!refFile) return;
  $("cmp-status").innerHTML = (await isHevcFile(refFile))
    ? HEVC_HINT
    : "❌ 参考视频无法解码，请换 MP4（H.264）格式的文件。";
  $("btn-compare").disabled = true;
});

refVideo.addEventListener("loadedmetadata", () => {
  refOverlay.width = refVideo.videoWidth;
  refOverlay.height = refVideo.videoHeight;
  $("btn-compare").disabled = false;
  $("cmp-status").textContent = "参考视频已就绪，点击开始对比。";
});

$("btn-compare").addEventListener("click", runCompare);

async function runCompare() {
  if (!frames.length || !lastCycle) {
    $("cmp-status").textContent = "请先完成上方第 2 步的视频分析，再进行对比。";
    return;
  }
  $("btn-compare").disabled = true;
  $("cmp-status").textContent = "识别参考视频中…（约需 10–30 秒）";

  let landmarker;
  try {
    landmarker = await getLandmarker();
  } catch (err) {
    $("cmp-status").textContent = `模型加载失败：${err?.message ?? err}`;
    $("btn-compare").disabled = false;
    return;
  }
  refFrames = await scanInto(refVideo, landmarker, (p) => {
    $("cmp-status").textContent = `识别参考视频… ${Math.round(p * 100)}%`;
  }, (n) => { $("cmp-status").textContent = `⚠️ ${n}`; });

  const refDetect = detectShotCycles(refFrames, pickSide(refFrames), SAMPLE_FPS);
  let refSide = refDetect.side;
  const refCycle = refDetect.cycles[0] ?? null;
  if (!refCycle) {
    $("cmp-status").textContent = "参考视频中未检测到出手动作（需要手腕高于肩部的瞬间），请换一段参考视频。";
    $("btn-compare").disabled = false;
    return;
  }

  const bodyA = standingBodyHeight(frames, lastCycle, chosenSide);
  const bodyB = standingBodyHeight(refFrames, refCycle, refSide);
  if (!bodyA || !bodyB) {
    $("cmp-status").textContent = "关键点缺失，无法归一化对比，请更换更清晰的视频。";
    $("btn-compare").disabled = false;
    return;
  }

  // 截取「下蹲→跟随顶点」的动作窗口，归一化后 DTW 对齐
  const winA = normalizeSequence(frames.slice(lastCycle.crouchIdx, lastCycle.apexIdx + 1), chosenSide, bodyA);
  const winB = normalizeSequence(refFrames.slice(refCycle.crouchIdx, refCycle.apexIdx + 1), refSide, bodyB);
  const { path, mapAtoB } = dtwAlign(winA, winB);
  renderDeviations(jointDeviations(winA, winB, path));
  startDualPlayback(mapAtoB, refCycle, refSide);
  $("cmp-status").textContent = "对比完成：点击同步播放，参考视频会逐帧对齐你的动作。";
  $("btn-compare").disabled = false;
}

function renderDeviations(devs) {
  const level = (d) => (d < 0.06 ? "good" : d < 0.12 ? "warn" : "bad");
  const sorted = [...devs].sort((a, b) => b.dev - a.dev);
  $("dev-list").innerHTML = sorted
    .map(
      (d) => `
      <div class="dev-row">
        <span class="d-name">${JOINT_LABEL[d.joint]}</span>
        <div class="d-bar"><i class="${level(d.dev)}" style="width:${Math.min(100, Math.round((d.dev / 0.2) * 100))}%"></i></div>
        <span class="d-val">${(d.dev * 100).toFixed(1)}%身高</span>
      </div>`
    )
    .join("");
  const top = sorted[0];
  $("cmp-advice").textContent =
    top && level(top.dev) !== "good"
      ? `差异最大的部位：${JOINT_LABEL[top.joint]} —— ${JOINT_ADVICE[top.joint]}`
      : "整体动作与参考已相当接近，继续保持！";
}

// 双窗同步：播放「我的动作」，参考视频按 DTW 映射逐帧 seek 对齐（无需播放参考视频）
function startDualPlayback(mapAtoB, refCycle, refSide) {
  dualMy.src = video.src;
  dualMy.muted = true;
  $("dual-pane").classList.remove("hidden");
  dualMy.addEventListener(
    "loadedmetadata",
    () => {
      dualMyOverlay.width = dualMy.videoWidth;
      dualMyOverlay.height = dualMy.videoHeight;
    },
    { once: true }
  );

  if (!dualRunning) {
    dualRunning = true;
    const dt = 1 / SAMPLE_FPS;
    const tick = () => {
      if (refFrames.length && lastCycle && !$("dual-pane").classList.contains("hidden")) {
        const g = Math.round(dualMy.currentTime / dt);
        const a = Math.max(0, Math.min(mapAtoB.length - 1, g - lastCycle.crouchIdx));
        const rg = refCycle.crouchIdx + mapAtoB[a];
        const target = refFrames[rg]?.t ?? 0;
        if (Math.abs(refVideo.currentTime - target) > 0.08) refVideo.currentTime = target;
        drawFrame(
          dualMyCtx,
          frames[Math.max(0, Math.min(frames.length - 1, g))]?.landmarks ?? null,
          { showSkeleton: true, showJoints: true, showAngles: false, side: chosenSide }
        );
        drawFrame(
          refCtx,
          refFrames[Math.max(0, Math.min(refFrames.length - 1, rg))]?.landmarks ?? null,
          { showSkeleton: true, showJoints: true, showAngles: false, side: refSide }
        );
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  $("btn-dual-play").onclick = () => {
    if (dualMy.paused) {
      if (dualMy.currentTime >= scanSpan - 0.05) dualMy.currentTime = 0;
      dualMy.play();
      $("btn-dual-play").textContent = "⏸ 暂停";
    } else {
      dualMy.pause();
      $("btn-dual-play").textContent = "▶ 同步播放";
    }
  };
}

﻿// ---------- 6. 训练档案（纵向追踪） ----------
// 档案只存在本机 localStorage：隐私模式下访问 localStorage 会抛错，捕获后按「无档案」降级，
// 主流程不能因为存不进去而报错（视频与档案都不出本机）。
function historyStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

// 指标对比基准：优先「同一投篮类型 + 同一来源」的历史，没有才退回全部历史
function comparableRecords(records, report, source) {
  const same = records.filter((r) => r.type === report.type && r.source === source);
  return same.length ? same : records;
}

// 报告头部的总览句：分数只在「同一投篮类型 + 同一来源」之间比较，类型不同只报历史次数
function buildCompareSummary(records, report, source) {
  const same = records.filter((r) => r.type === report.type && r.source === source);
  if (!same.length) {
    return records.length ? `历史共 ${records.length} 次分析（投篮类型/来源不同，不比较分数）` : "";
  }
  const parts = [];
  const delta = report.score - same[0].score;
  parts.push(delta === 0 ? "与上次同分" : `较上次 ${delta > 0 ? "+" : ""}${delta} 分`);
  const scored = same.filter((r) => isFinite(r.score));
  const avg = (arr) => (arr.length ? arr.reduce((s, r) => s + r.score, 0) / arr.length : null);
  const recent = avg(scored.slice(0, 3));
  const earlier = avg(scored.slice(3, 6));
  if (recent != null && earlier != null) parts.push(`近 3 次均分 ${recent.toFixed(0)}（此前 ${earlier.toFixed(0)}）`);
  else if (recent != null) parts.push(`近 3 次均分 ${recent.toFixed(0)}`);
  return parts.join(" · ");
}

// 存一次分析并返回「较上次」的对比数据（对比用的是写入前的历史，所以先算再存）
// archive=false 时只算对比不写记录——切换投篮类型只是重新评分，不该在档案里堆重复记录
function saveToArchive(report, metrics, source, view, archive = true) {
  const store = historyStorage();
  const prev = store ? listRecords(store) : [];
  const base = comparableRecords(prev, report, source);
  const compare = {};
  for (const m of report.metrics) {
    const cmp = compareMetric(base, m.id, m.num, { lowerIsBetter: LOWER_IS_BETTER.has(m.id) });
    if (cmp.count) compare[m.id] = cmp; // 没有历史就不显示「较上次」
  }
  const summary = buildCompareSummary(prev, report, source);
  if (store && archive) {
    try {
      addRecord(store, makeRecord({ report, metrics, source, view }));
    } catch {
      /* 写入失败（配额满/隐私模式）静默降级，不影响主流程 */
    }
  }
  renderHistory();
  return { compare, summary };
}

// 档案区当前选中的指标（重绘后要保留）
let historyMetric = "";

// 档案区渲染：总览条 → 评分历史曲线 → 单指标趋势 → 记录列表
function renderHistory() {
  const store = historyStorage();
  const body = $("history-body");
  if (!store) {
    body.innerHTML = '<p class="report-empty">当前浏览器无法保存档案（隐私模式或存储已满），可用导出/导入在其他设备查看。</p>';
    return;
  }
  const records = listRecords(store);
  if (!records.length) {
    body.innerHTML = '<p class="report-empty">还没有记录。完成一次分析后会自动存入档案。</p>';
    return;
  }
  const sum = summarize(records);
  const scored = records.filter((r) => isFinite(r.score));
  const avg = (arr) => (arr.length ? arr.reduce((s, r) => s + r.score, 0) / arr.length : null);
  const recent = avg(scored.slice(0, 3));
  const earlier = avg(scored.slice(3, 6));
  const trendText =
    sum.trend == null ? "样本不足" : sum.trend > 0 ? `↗ 上升 ${sum.trend.toFixed(1)}` : sum.trend < 0 ? `↘ 下降 ${Math.abs(sum.trend).toFixed(1)}` : "→ 持平";

  // 评分历史：x 轴用时间戳（图表不画 x 轴刻度，日期在下方记录列表里逐条列出）
  const scorePts = [...records].reverse().map((r) => ({ x: r.ts, y: r.score })).filter((p) => isFinite(p.y));
  const scoreChart = lineChart({
    series: [{ label: "得分", color: "#38bdf8", points: scorePts }],
    bands: [{ from: 60, to: 80, color: "rgba(74,222,128,0.16)" }], // 60–80 分参考带
    xLabel: "日期",
    yUnit: "分",
    height: 160,
  });

  // 单指标趋势：列出档案里出现过的全部指标
  const ids = [...new Set(records.flatMap((r) => Object.keys(r.metrics ?? {})))];
  // 上次选的指标要留住——整块重绘后下拉框会被重建
  if (historyMetric && !ids.includes(historyMetric)) historyMetric = "";
  const metricId = historyMetric || (ids.length ? ids[0] : "");
  const metric = metricId ? records.find((r) => r.metrics?.[metricId])?.metrics[metricId] : null;
  const series = metricId ? metricSeries(records, metricId) : [];
  const band =
    metric && isFinite(metric.lo) && isFinite(metric.hi) && metric.hi > metric.lo
      ? [{ from: metric.lo, to: metric.hi, color: "rgba(56,189,248,0.16)" }]
      : [];
  const trendChart = series.length
    ? lineChart({
        series: [{ label: METRIC_NAMES[metricId] ?? metricId, color: "#f97316", points: series.map((p) => ({ x: p.ts, y: p.num })) }],
        bands: band,
        xLabel: "日期",
        yUnit: metric?.unit ?? "",
        height: 160,
      })
    : "";
  const lastNum = series.length ? series[series.length - 1].num : null;

  // 记录列表：每行日期/类型/来源/分数/评级，可展开看该次各项读数，可删除
  const list = records
    .map((r) => {
      const rows = Object.entries(r.metrics ?? {})
        .map(([id, m]) => `<div class="hist-metric"><span>${METRIC_NAMES[id] ?? m.name ?? id}</span><b>${m.value ?? m.num}</b></div>`)
        .join("");
      return `
        <li class="hist-item">
          <div class="hist-row">
            <span class="hist-date">${r.date ?? ""}</span>
            <span class="hist-type">${TYPE_LABEL[r.type] ?? r.type ?? "—"}</span>
            <span class="hist-src">${r.source ?? ""}</span>
            <span class="hist-score">${isFinite(r.score) ? `${r.score} ${r.grade ?? ""}` : "—"}</span>
            <button class="hist-del" data-id="${r.id}" title="删除这条记录">✕</button>
          </div>
          <details><summary>展开 ${Object.keys(r.metrics ?? {}).length} 项指标</summary><div class="hist-metrics">${rows}</div></details>
        </li>`;
    })
    .join("");

  body.innerHTML = `
    <div class="hist-overview">
      <div class="hist-stat"><b>${sum.count}</b><span>累计分析</span></div>
      <div class="hist-stat"><b>${sum.avgScore != null ? sum.avgScore.toFixed(0) : "—"}</b><span>平均分</span></div>
      <div class="hist-stat"><b>${sum.lastScore != null ? sum.lastScore : "—"}</b><span>最近分数</span></div>
      <div class="hist-stat"><b>${recent != null ? recent.toFixed(0) : "—"}</b><span>近 3 次均分</span></div>
      <div class="hist-stat"><b class="trend-${sum.trend > 0 ? "up" : sum.trend < 0 ? "down" : "flat"}">${trendText}</b><span>此前 ${earlier != null ? earlier.toFixed(0) : "—"}</span></div>
    </div>
    <h3 class="hist-title">评分历史</h3>
    ${scoreChart || '<p class="report-empty">暂无评分数据。</p>'}
    <h3 class="hist-title">单指标趋势</h3>
    <select id="history-metric" class="hist-select">${ids.map((id) => `<option value="${id}">${METRIC_NAMES[id] ?? id}</option>`).join("")}</select>
    ${trendChart || '<p class="report-empty">该指标暂无历史读数。</p>'}
    ${lastNum != null ? `<p class="hint">最近一次：${METRIC_NAMES[metricId] ?? metricId} ${typeof lastNum === "number" ? lastNum.toFixed(2) : lastNum}${metric?.unit ?? ""}</p>` : ""}
    <h3 class="hist-title">历史记录</h3>
    <ul class="hist-list">${list}</ul>
  `;
  // 整块重绘后原来的下拉失效，重新绑定（用 change 事件避免输入即重绘）
  const sel = $("history-metric");
  if (sel) {
    sel.value = metricId;
    sel.addEventListener("change", (e) => {
      historyMetric = e.target.value;
      renderHistory();
    });
  }
}

// 删除单条记录（列表里的 ✕）
$("history-body").addEventListener("click", (e) => {
  const btn = e.target.closest(".hist-del");
  if (!btn) return;
  const store = historyStorage();
  if (!store) return;
  removeRecord(store, btn.dataset.id);
  $("history-status").textContent = "已删除该条记录。";
  renderHistory();
});

// 导出：Blob + 本地下载，不联网
$("btn-history-export").addEventListener("click", () => {
  const store = historyStorage();
  if (!store) {
    $("history-status").textContent = "当前浏览器无法读取档案，导出不可用。";
    return;
  }
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const blob = new Blob([exportText(store)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `shot-analyzer-档案-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  $("history-status").textContent = "已导出档案文件（保存在本机，可发给自己换设备）。";
});

// 导入：读本地文件文本 → importText → 刷新档案区；失败给出原因
$("btn-history-import").addEventListener("click", () => $("history-file").click());
$("history-file").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const store = historyStorage();
  if (!store) {
    $("history-status").textContent = "当前浏览器无法保存档案，导入不可用。";
    return;
  }
  const text = await file.text();
  const res = importText(store, text);
  $("history-status").textContent = res.ok ? `已导入 ${res.count} 条记录。` : `导入失败：${res.error}`;
  e.target.value = ""; // 允许重复选同一个文件
  renderHistory();
});

// 清空：二次确认后清档案
$("btn-history-clear").addEventListener("click", () => {
  if (!confirm("确定清空全部训练档案？此操作不可恢复（可先导出备份）。")) return;
  const store = historyStorage();
  if (store) clearRecords(store);
  $("history-status").textContent = "档案已清空。";
  renderHistory();
});

// ---------- 工具函数 ----------
// 通用视频扫描：逐帧 seek + 推理，返回 [{t, landmarks, aspect}]（主/参考/融合视频共用）。
// 链式排队串行执行：多段视频同时分析时不会互相抢占共享的推理画布
let scanChain = Promise.resolve();
function scanInto(el, landmarker, onProgress, onNote) {
  const run = scanChain.then(() => scanIntoInner(el, landmarker, onProgress, onNote));
  scanChain = run.catch(() => {});
  return run;
}

async function scanIntoInner(el, landmarker, onProgress, onNote) {
  beginScan(landmarker); // 重置 VIDEO 模式跟踪状态：同一视频两次扫描相互独立
  const out = [];
  const span = Math.min(el.duration || 0, MAX_SECONDS);
  const dt = 1 / SAMPLE_FPS;
  const prevW = inferCanvas.width, prevH = inferCanvas.height;
  inferCanvas.width = el.videoWidth; // 各视频分辨率可能不同
  inferCanvas.height = el.videoHeight;
  const aspect = el.videoWidth / el.videoHeight || 1; // 归一化坐标 x 乘此值才是真实几何
  let failStreak = 0; // 连续推理失败计数（GPU 上下文丢失时重建模型）
  let failedFrames = 0; // 最终失败的帧数（已插值；在状态栏披露，避免无声拉低评分）
  const picker = makePersonPicker(); // 多人同框时锁定主人公（实现与门控见 media.js；每次扫描独立状态）
  for (let t = 0; t < span; t += dt) {
    await seekOn(el, t);
    inferCtx.drawImage(el, 0, 0, inferCanvas.width, inferCanvas.height);
    let landmarks = null;
    try {
      const res = landmarker.detectForVideo(inferCanvas, nextTimestamp());
      landmarks = picker.pick(res.landmarks);
      failStreak = 0;
    } catch {
      // 个别帧失败重试一次；连续多帧失败视为 GPU 上下文丢失，重建模型（改用 CPU）继续
      failStreak++;
      try {
        const res = landmarker.detectForVideo(inferCanvas, nextTimestamp());
        landmarks = picker.pick(res.landmarks);
        failStreak = 0;
      } catch { failedFrames++; /* 放弃该帧 */ }
      if (failStreak >= 5) {
        onNote?.("推理异常，已切换到 CPU 模式继续");
        landmarker = await resetLandmarker();
        failStreak = 0;
      }
    }
    out.push({ t, landmarks, aspect });
    if (out.length % 5 === 0) {
      onProgress?.(span ? t / span : 1);
      await nextTick(); // 让出主线程，避免页面卡死
    }
  }
  inferCanvas.width = prevW;
  inferCanvas.height = prevH;
  out.failedFrames = failedFrames; // 挂在返回值上，由调用方决定是否披露
  out.peopleSeen = picker.peopleSeen; // >1 时提示「已锁定占画面最大的投篮者」
  return out;
}

function seekOn(el, t) {
  return new Promise((resolve) => {
    const onSeeked = async () => {
      el.removeEventListener("seeked", onSeeked);
      // 等待新帧真正上屏再取，避免旧帧/黑帧：优先 requestVideoFrameCallback
      //（拿到的是浏览器确认 present 的帧）；不支持时退回双 rAF
      if (typeof el.requestVideoFrameCallback === "function") {
        let done = false;
        const timer = setTimeout(() => { if (!done) { done = true; resolve(); } }, 120);
        el.requestVideoFrameCallback(() => { if (!done) { done = true; clearTimeout(timer); resolve(); } });
      } else {
        await nextTick();
        await nextTick();
        resolve();
      }
    };
    el.addEventListener("seeked", onSeeked);
    el.currentTime = Math.min(t, Math.max(0, (el.duration || 0) - 0.05));
  });
}

function nextTick() {
  return new Promise((r) => requestAnimationFrame(r));
}

function setStatus(text) {
  $("status-text").textContent = text;
}

// ---------- 4. 多角度融合（可选） ----------
// 单机位总有盲区：侧面看不到肘内外展/左右对称，正面看不到下蹲深度/出手角。
// 每段补拍视频独立扫描并判别机位；融合时每个指标取「机位匹配且置信度最高」的来源。
const fusionSlots = [null, null]; // { label, frames, cycle, side, view, vis }
const fusionVideos = [$("fusion-video-1"), $("fusion-video-2")];
let fusionRendered = false;

[1, 2].forEach((n) => {
  $(`fusion-input-${n}`).addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    $(`fusion-name-${n}`).textContent = `${file.name}（${(file.size / 1024 / 1024).toFixed(1)} MB）`;
    await analyzeFusionSlot(n - 1, file);
  });
  // 机位自动判别有误时可手动指定（正面/斜侧需重选出手侧）
  $(`fusion-view-${n}`).addEventListener("change", (e) => {
    const slot = fusionSlots[n - 1];
    if (!slot) return;
    slot.view = e.target.value;
    if (slot.view === "front" || slot.view === "oblique") {
      slot.side = pickShootingSide(slot.frames, slot.cycle, slot.side);
    } else {
      // 改回侧面类时恢复侧面语义：按可见度选面向镜头的一侧（正面逻辑选中的可能是被遮挡的远端臂）
      slot.side = pickSide(slot.frames);
    }
    // 可见度随所选侧链重算——融合排序按 vis 挑来源，不能沿用旧值
    slot.vis = windowVisibility(slot.frames, Object.values(SIDE[slot.side]), slot.cycle?.crouchIdx, slot.cycle?.apexIdx);
    $(`fusion-status-${n}`).textContent = `✅ 已手动指定为${VIEW_LABEL[slot.view]}机位`;
    if (fusionRendered) generateFusion(true);
  });
});

$("btn-fusion").addEventListener("click", () => generateFusion(true));

async function analyzeFusionSlot(i, file) {
  const n = i + 1;
  const st = $(`fusion-status-${n}`);
  const v = fusionVideos[i];
  st.textContent = "加载视频…";
  v.src = URL.createObjectURL(file);
  v.load();
  const ok = await new Promise((res) => {
    v.addEventListener("loadedmetadata", () => res(true), { once: true });
    v.addEventListener("error", () => res(false), { once: true });
  });
  if (!ok) {
    st.innerHTML = (await isHevcFile(file))
      ? HEVC_HINT
      : "❌ 视频无法解码，请换一段（推荐 MP4 / H.264）。";
    fusionSlots[i] = null;
    updateFusionUI();
    return;
  }

  st.textContent = "加载识别模型…（首次较慢）";
  let landmarker;
  try {
    landmarker = await getLandmarker();
  } catch (err) {
    st.textContent = `模型加载失败：${err?.message ?? err}`;
    return;
  }
  const fr = await scanInto(v, landmarker, (p) => {
    st.textContent = `识别中… ${Math.round(p * 100)}%`;
  }, (n) => { st.textContent = `⚠️ ${n}`; });
  if (!fr.some((f) => f.landmarks)) {
    st.textContent = "❌ 未识别到人像，请换更清晰的视频。";
    fusionSlots[i] = null;
    updateFusionUI();
    return;
  }

  let view = classifyView(fr);
  const detect = detectShotCycles(fr, pickSide(fr), SAMPLE_FPS);
  let side = detect.side;
  const cycles = detect.cycles;
  const cycle = cycles[0] ?? null;
  if (!cycle) {
    st.textContent = "❌ 未检测到出手动作（需手腕高于肩部的出手瞬间），请换一段。";
    fusionSlots[i] = null;
    updateFusionUI();
    return;
  }
  let note = "";
  if (view === "unknown") {
    view = "side";
    note = "（机位未能自动判别，已按侧面处理，可手动指定）";
  }
  if (view === "front" || view === "oblique") side = pickShootingSide(fr, cycles, side);
  const vis = windowVisibility(fr, Object.values(SIDE[side]), cycle.crouchIdx, cycle.apexIdx);
  fusionSlots[i] = { label: `补拍${n}`, frames: fr, cycles, cycle, side, view, vis };
  $(`fusion-view-${n}`).classList.remove("hidden");
  $(`fusion-view-${n}`).value = view;
  st.innerHTML = `✅ ${VIEW_LABEL[view]}机位 · 检测到 ${cycles.length} 次出手${cycles.rejected ? ` · ⚠️ ${cycles.rejected} 次未计入（人物不在画面）` : ""}${fr.failedFrames ? ` · ⚠️ ${fr.failedFrames} 帧识别失败` : ""}${note}`;
  if (fusionRendered) generateFusion(true); // 已有融合报告时自动按新视频重算
  updateFusionUI();
}

function updateFusionUI() {
  const hasMain = !!(frames.length && lastCycle);
  const hasExtra = fusionSlots.some(Boolean);
  $("btn-fusion").disabled = !(hasMain && hasExtra);
  $("fusion-status").textContent = !hasMain
    ? "需先完成第 2 步主视频分析。"
    : hasExtra
      ? "已就绪：点击生成融合报告。"
      : "主视频已分析。按报告下方的补拍建议拍一段其他机位，上传即可融合。";
}

function generateFusion(archive = false) {
  const type = $("shot-type").value;
  const analyses = [];
  if (frames.length && lastCycle) {
    analyses.push({ label: "主视频", frames, cycles: lastCycles, cycle: lastCycle, side: chosenSide, view: mainView, vis: mainVis });
  }
  for (const slot of fusionSlots) if (slot) analyses.push({ ...slot });
  if (analyses.length < 2) {
    $("fusion-status").textContent = "至少需要主视频 + 一段补拍视频才能融合。";
    return;
  }

  // oblique 两向近似可用；unknown 已在录入时按 side 归一
  const viewsOf = (a) => (a.view === "oblique" ? ["side", "front"] : [a.view === "unknown" ? "side" : a.view]);
  for (const a of analyses) {
    // 每段视频先对多次出手取中位数，再参与跨视频融合
    const per = (a.cycles?.length ? a.cycles : [a.cycle].filter(Boolean))
      .map((c) => computeMetrics(a.frames, c, a.side, type, a.view));
    a.metrics = mergeCycles(per);
  }

  // 每个指标取「机位匹配」的来源，主视频优先、其次置信度高者
  const merged = [];
  const missing = [];
  for (const id of Object.keys(METRIC_VIEWS)) {
    const cands = analyses.filter(
      (a) => viewsOf(a).some((v) => METRIC_VIEWS[id].includes(v)) && a.metrics.some((m) => m.id === id)
    );
    if (!cands.length) {
      missing.push(id);
      continue;
    }
    cands.sort((x, y) => (y.label === "主视频" ? 1 : 0) - (x.label === "主视频" ? 1 : 0) || y.vis - x.vis);
    const src = cands[0];
    merged.push({ ...src.metrics.find((m) => m.id === id), src: `${VIEW_LABEL[src.view]}·${src.label}` });
  }

  const report = buildReport(merged, type); // type 为 auto 时在此解析为罚球/跳投
  report.title = `${TYPE_LABEL[report.type]}多角度融合评分${report.autoType ? "（自动识别）" : ""}`;
  // 融合报告同样入档案，来源标成「多角度融合」，方便和单机位报告区分
  const cmp = saveToArchive(report, merged, "多角度融合", mainView, archive);
  renderReport($("fusion-report"), report, { compare: cmp.compare, compareSummary: cmp.summary });
  fusionRendered = true;

  // 仍未覆盖的指标与所需机位
  const have = new Set(analyses.flatMap((a) => viewsOf(a)));
  if (missing.length) {
    const items = missing
      .map((id) => {
        const views = METRIC_VIEWS[id].filter((v) => !have.has(v)).map((v) => VIEW_LABEL[v]);
        return `<li><b>${METRIC_NAMES[id]}</b> —— ${
          views.length ? `需补拍${views.join("/")}机位` : "该机位视频中关键点不足，建议重拍更清晰的一段"
        }</li>`;
      })
      .join("");
    const needViews = [...new Set(missing.flatMap((id) => METRIC_VIEWS[id]))].filter((v) => !have.has(v));
    $("fusion-gaps").innerHTML = `<div class="gap-card"><h3>📷 仍未覆盖的指标</h3><ul>${items}</ul>${
      needViews.length ? `<div class="guide-wrap small">${courtGuideSVG(needViews)}</div>` : ""
    }</div>`;
  } else {
    $("fusion-gaps").innerHTML = `<div class="gap-card ok"><h3>🎉 覆盖完整</h3><p>侧面 + 正面指标均已覆盖，以上为当前版本全部 ${merged.length} 项指标的完整报告。</p></div>`;
  }
  $("fusion-report").scrollIntoView({ behavior: "smooth", block: "start" });
}

// 第 1 步拍摄建议里的机位示意图（无高亮，展示全部三个机位）
$("guide-slot").innerHTML = courtGuideSVG();

// 训练档案区：进入页面先把已有档案渲染出来（空档案显示引导文案）
renderHistory();
