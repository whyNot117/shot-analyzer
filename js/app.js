// 应用主流程：选视频 → 逐帧扫描姿态 → 播放时叠加骨架
import { getLandmarker, resetLandmarker, nextTimestamp, beginScan } from "./pose.js";
import { drawFrame, pickSide, pickShootingSide, SIDE } from "./draw.js";
import { detectShotCycles, mergeCycles, computeMetrics, cycleCurves, standingBodyHeight, METRIC_NAMES, METRIC_VIEWS, LOWER_IS_BETTER, NEUTRAL_DIRECTION } from "./metrics.js";
import {
  buildReport, renderReport, TYPE_LABEL, setProfile, escHtml, noScoreReasons,
  subjectLabelText, subjectShotDesc, summaryLineText, statusLineText,
} from "./report.js";
import { classifyView, VIEW_LABEL, coverageGaps, windowVisibility, courtGuideSVG } from "./views.js";
import { normalizeSequence, dtwAlign, jointDeviations, JOINT_LABEL, JOINT_ADVICE } from "./compare.js";
import { isHevcFile } from "./media.js";
import { buildTracks, applySubject, poseBodyHeight, videoLevelFrames } from "./tracks.js";
import {
  listRecords, addRecord, removeRecord, clearRecords,
  exportText, importText, metricSeries, compareMetric, summarize, makeRecord,
} from "./history.js";
import { lineChart } from "./charts.js";
import { SCENE_LABEL } from "./scene.js";
import { assessClipQuality, renderShotChecklist, qualityCardHTML } from "./quality.js";
import { frameIndexAt, supportsFrameCallback } from "./sync.js";

console.log("🏀 投篮姿态分析 · 代码版本 v5.11（2026-11-26）——评分异常时请先确认此版本并强制刷新（Ctrl+F5）");

const $ = (id) => document.getElementById(id);
const esc = escHtml;
const video = $("video");
const overlay = $("overlay");
const octx = overlay.getContext("2d");
// 离屏 canvas 作为推理输入（尺寸与视频一致，不受显示尺寸影响）
const inferCanvas = document.createElement("canvas");
const inferCtx = inferCanvas.getContext("2d");

const SAMPLE_FPS = 30;   // 扫描采样率
const MAX_SECONDS = 30;  // 超长视频只分析前 30 秒

let frames = [];         // [{ t, landmarks }]
let scanFrames = [];     // [{ t, poses, aspect }]：扫描原始结果（每帧全部候选姿态）
let scanSpan = 0;        // 实际扫描时长
let chosenSide = "right";
let lastCycle = null;    // 主周期：骨架叠加与对比功能用
let lastCycles = [];     // 全部检测到的出手周期（报告逐指标取中位数）
let lastDetection = null; // 周期检测缓存：切换投篮类型直接复用，避免选臂回写改变下次检测
let loopRunning = false;
let mainView = "side";   // 主视频机位（side/front/oblique/unknown）
let mainViewInfo = null; // 机位判定的依据（肩宽比中位、双峰占比、运镜幅度、是否不固定）
let subjectInfo = null;  // 主体选取结果（哪条轨迹、为什么是它、出手事件在哪几秒）
let frameStats = null;   // 帧的账：检出/无效/有效/计入主体/未计入
let mainVis = 0;         // 主视频动作窗口内出手侧关键点平均可见度
let quality = null;      // 素材质量判定缓存：同一段视频只判一次，切换投篮类型/场景不重判
let seekOffset = null;   // 视频帧时间戳栅格相对名义采样时刻的偏移（秒）

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
  lastMediaTime = null; // 换源：上屏时间戳重来
  seekOffset = null;    // 换源：帧时间戳栅格也跟着换，偏移重新测
  lastCycle = null;
  lastCycles = [];
  lastDetection = null;
  quality = null;        // 换视频后素材质量要重新判
  fusionRendered = false; // 融合报告基于主视频，一并清空
  $("fusion-report").innerHTML = "";
  $("fusion-gaps").innerHTML = "";
  updateFusionUI();
  overlay.width = video.videoWidth;
  overlay.height = video.videoHeight;
  octx.clearRect(0, 0, overlay.width, overlay.height);
  // 换源后旧的 rVFC 回调可能失效，重新挂一条（token 作废旧链）
  if (loopRunning) {
    if (supportsFrameCallback(video)) startFrameCallbackLoop();
    else startAnimationLoop();
  }
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
  quality = null; // 重新扫描 = 新素材，质量要重新判（切换投篮类型/场景不会走到这里）

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

  const scan = await scanInto(video, landmarker, (p) => {
    const pct = Math.round(p * 100);
    setStatus(`识别中… ${pct}%${note}`);
    $("progress-fill").style.width = `${pct}%`;
  }, (n) => setStatus(`⚠️ ${n}`));

  $("progress-fill").style.width = "100%";
  // 主体选取：扫描阶段保留每帧的全部候选姿态，扫完再聚成轨迹、按出手动作证据选主体。
  // 不再「逐帧取占画面最大的人」——手持跟拍时人在画面里忽远忽近，那个锁法会把不同的人混进同一份报告。
  const applied = applySubject(scan, buildTracks(scan));
  frames = applied.frames;
  scanFrames = scan;
  subjectInfo = applied.subject;
  frameStats = applied.stats;
  frames.peopleSeen = scan.peopleSeen;
  frames.failedFrames = scan.failedFrames;
  chosenSide = pickSide(frames);
  mainViewInfo = classifyView(frames);
  mainView = mainViewInfo.view;
  const detected = frames.filter((f) => f.landmarks).length;
  if (detected === 0) {
    setStatus("未识别到人像。请确认画面中有清晰的全身人像、光线充足，然后重新选择视频。");
    // 一个关键点都没测到 → 素材质量必然不合格：让质量卡片接管"该怎么重拍"的说明，
    // 但上面这句提示保留（它还负责解释"为什么会没认出人"）
    quality = retargetQualitySubject(
      assessClipQuality(videoLevelFrames(scan), chosenSide, { cycleCount: 0, peopleSeen: frames.peopleSeen ?? 1 })
    );
    $("report-body").innerHTML = qualityCardHTML(quality);
    $("step-report").classList.remove("hidden");
    $("btn-analyze").disabled = false;
    updateFusionUI();
    return;
  }
  setStatus(statusLineText({
    subjectFrames: detected,
    totalFrames: frames.length,
    detectedFrames: frameStats.detected,
    invalidFrames: frameStats.invalid,
    otherFrames: frameStats.otherFrames,
    peopleSeen: frames.peopleSeen ?? 1,
    subject: subjectInfo,
    view: mainView,
    viewInfo: mainViewInfo,
    failedFrames: frames.failedFrames ?? 0,
  }));
  runReport();
  $("btn-analyze").disabled = false;
  $("btn-analyze").textContent = "🔄 重新分析";
  $("btn-play").disabled = false;
  $("toggles").classList.remove("hidden");
  ensureRenderLoop();
}

// ---------- 3. 播放叠加 ----------
// 常驻渲染循环：按「屏幕上真正显示的那一帧」取骨架画到 overlay 上。
// v5.10：旧实现用 requestAnimationFrame + video.currentTime 反推帧号，
// currentTime 是播放时钟，可能比已经上屏的那一帧快一帧，人一动骨架就错位。
// 现在优先用 requestVideoFrameCallback 的 metadata.mediaTime（真正上屏帧的时间戳）
// 去查样本帧（js/sync.js 的 frameIndexAt），「画面这一帧」和「检测那一帧」用同一条时间轴。
let lastMediaTime = null; // 最近一次真正上屏帧的时间戳（暂停时切换开关也要用它重画）

// 把一帧画到画布上：先画画面里的其他人（暗灰），再画主体（蓝线 + 橙点），主体保持视觉主导
function paintOverlay(ctx, frame, opts) {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  for (const lm of frame?.others ?? []) {
    drawFrame(ctx, lm, { ...opts, tone: "other", clear: false, showAngles: false });
  }
  if (frame?.landmarks) {
    drawFrame(ctx, frame.landmarks, { ...opts, tone: "subject", clear: false });
  }
}

function overlayOpts() {
  return {
    showSkeleton: $("tg-skeleton").checked,
    showJoints: $("tg-joints").checked,
    showAngles: $("tg-angles").checked,
    side: chosenSide,
  };
}

function ensureRenderLoop() {
  // 先画一帧：分析刚结束时视频是暂停的，rVFC 不会触发，得先把当前帧画出来
  drawOverlayAt(video.currentTime);
  if (loopRunning) return;
  loopRunning = true;
  if (supportsFrameCallback(video)) {
    startFrameCallbackLoop();
  } else {
    // 不支持 rVFC 的浏览器退回旧驱动方式（帧号仍然按媒体时间查，不再按 currentTime 猜）
    startAnimationLoop();
  }
}

// 按媒体时间画一帧：媒体时间来自真正上屏的那一帧（rVFC），不是播放时钟
function drawOverlayAt(mediaTime) {
  if (typeof mediaTime === "number" && Number.isFinite(mediaTime)) lastMediaTime = mediaTime;
  if (!frames.length) return;
  const mt = lastMediaTime ?? video.currentTime;
  const idx = frameIndexAt(frames, mt);
  paintOverlay(octx, frames[idx], overlayOpts());
}

// 换源后旧的 rVFC 回调可能失效，用 token 作废旧链，只保留一条
let renderToken = 0;

function startFrameCallbackLoop() {
  const token = ++renderToken;
  // rVFC 回调与「这一帧上屏」是同一时刻：在回调里画，骨架和真人就是同一帧
  const step = (_now, meta) => {
    if (token !== renderToken) return;
    drawOverlayAt(meta?.mediaTime ?? video.currentTime);
    video.requestVideoFrameCallback(step);
  };
  video.requestVideoFrameCallback(step);
}

function startAnimationLoop() {
  const token = ++renderToken;
  const loop = () => {
    if (token !== renderToken) return;
    drawOverlayAt(video.currentTime);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

// 暂停时视频不再上屏、rVFC 不再触发，但开关还是要立刻有反应：
// 用最近一次的上屏时间戳重画一次。
for (const id of ["tg-skeleton", "tg-joints", "tg-angles"]) {
  $(id).addEventListener("change", () => {
    if (!frames.length) return;
    const mt = lastMediaTime ?? video.currentTime;
    paintOverlay(octx, frames[frameIndexAt(frames, mt)], overlayOpts());
  });
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
// v5.9：quality.js 里「已经锁定占画面最大的那个」是旧逻辑的说法——
// v5.9 主体是按出手动作证据选的。这里按新口径重写这一条，
// 免得质量提醒卡片和顶部摘要（主体是谁）两处说法互相打架。
function retargetQualitySubject(q) {
  if (!q || !Array.isArray(q.issues)) return q;
  const item = q.issues.find((i) => i.id === "multiplePeople");
  if (!item) return q;
  const n = q.stats?.peopleSeen ?? 2;
  const desc = subjectShotDesc(subjectInfo);
  item.text = desc
    ? `本次分析的是有出手动作的那个（${desc}）；如果那不是你，这段结果就不能用。`
    : "没有检测到完整的投篮动作，读数仅供参考。";
  item.fix = "确认被分析的是你本人；不是本人的话，请换一段只有你一个人的视频。";
  return q;
}

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
  // 素材质量：扫描完成、拿到出手周期之后再判一次。同一段视频只判一次并缓存——
  // 切换投篮类型/场景会重跑 runReport（不重扫），没必要反复重判，也不该反复弹同一张卡片
  if (!quality) {
    // 质量问的是「这段素材本身好不好」，所以用视频级帧（每帧取任意一个可信的人），
    // 不用「锁定的那个人」的帧——那是主体选取的结果，不是素材的属性
    quality = retargetQualitySubject(
      assessClipQuality(videoLevelFrames(scanFrames), chosenSide, {
        cycleCount: cycles.length,
        peopleSeen: frames.peopleSeen ?? 1,
      })
    );
  }
  if (quality.level === "bad") {
    // 素材不合格就不出评分报告：一份看起来很正式的评分会让用户把噪声当成结论
    // 素材质量卡片直接放进报告区顶部：摘要、质量、结论在同一个块里说，不在页面上下两处各说一遍
    body.innerHTML = subjectEndNote()
      + qualityCardHTML(quality)
      + (cycle
        ? '<p class="report-empty">这段素材的拍摄条件不足以给出可信读数，已暂停生成评分报告——按上面卡片里的建议重拍一段再试。</p>'
        : '<p class="report-empty">未能检测到明显的出手动作（需要手腕高于肩部的瞬间）。请确认视频包含完整的投篮过程：持球 → 下蹲 → 出手 → 跟随。</p>')
        + (validRatio < 0.3
          ? '<p class="report-empty">⚠️ 画面中能识别到人的时间太短（不足全程的 30%），请让投篮者完整入镜。</p>'
          : "")
        + (frames.peopleSeen > 1
          ? `<p class="report-empty">⚠️ 画面中有多人，本次分析的是${esc(subjectLabelText(subjectInfo))}——如果那不是你，这段结果就不能用。</p>`
          : "")
        + (rejectNote ? `<p class="report-empty">${rejectNote}</p>` : "");
    updateFusionUI();
    return; // 不滚动过去：用户改投篮类型/场景时不该被这张卡片拽走
  }
  if (!cycle) {
    // 没有出手动作 → 读数只能作参考（同一条出口，不出分数）
    body.innerHTML = subjectEndNote()
      + `<div class="report-head"><p class="summary-line">${esc(summaryLineText(summaryArgs(0)))}</p>` +
      `<div class="report-noscore"><b>⚠️ 这次读数只能作参考</b><ul><li>没有检测到完整的投篮动作（需要手腕高于肩部的瞬间），读数仅供参考</li></ul></div></div>`
      + '<p class="report-empty">未能检测到明显的出手动作（需要手腕高于肩部的瞬间）。请确认视频包含完整的投篮过程：持球 → 下蹲 → 出手 → 跟随。</p>'
      + (validRatio < 0.3
        ? '<p class="report-empty">⚠️ 画面中能识别到人的时间太短（不足全程的 30%），请让投篮者完整入镜。</p>'
        : "")
      + (frames.peopleSeen > 1
        ? `<p class="report-empty">⚠️ 画面中有多人，本次分析的是${esc(subjectLabelText(subjectInfo))}——如果那不是你，这段结果就不能用。</p>`
        : "")
      + (rejectNote ? `<p class="report-empty">${rejectNote}</p>` : "");
    updateFusionUI();
    return;
  }
  // 正面/斜侧机位下双臂都可见，按「出手瞬间腕部更高的一侧」选定出手臂
  if (mainView === "front" || mainView === "oblique") chosenSide = pickShootingSide(frames, cycles, chosenSide);
  mainVis = windowVisibility(frames, Object.values(SIDE[chosenSide]), cycle.crouchIdx, cycle.apexIdx);
  // 多次出手逐次计算后取中位数：比单次出手更接近真实水平，也消除「两次分析选中不同出手」的评分漂移
  const metrics = mergeCycles(cycles.map((c) => computeMetrics(frames, c, chosenSide, type, mainView, SAMPLE_FPS)));
  // 读数可信度：满足任一条就不出分数与等级（v5.9 改动 4）
  const noScoreReasonsList = noScoreReasons({
    unstable: !!mainViewInfo?.unstable,
    unstableReasons: mainViewInfo?.reasons ?? [],
    peopleSeen: frames.peopleSeen ?? 1,
    hasShot: (subjectInfo?.track?.stats?.shotEvents ?? 0) > 0,
    subjectFrames: frameStats?.subjectFrames ?? 0,
    totalFrames: frames.length,
    droppedFrames: (frameStats?.otherFrames ?? 0) + (frameStats?.invalid ?? 0),
    qualityLevel: quality?.level ?? null,
  });
  const report = buildReport(metrics, type, cycles.length, { noScoreReasons: noScoreReasonsList });
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
    summaryLine: summaryLineText(summaryArgs(metrics.length)),
    quality,
    // 移动/接球场景是实验性功能，结论要打上醒目提示
    experimental: sceneId === "moving" || sceneId === "catch",
  });
  body.insertAdjacentHTML("afterbegin", subjectEndNote());
  renderGapCard(body);
  body.scrollIntoView({ behavior: "smooth", block: "start" });
  updateFusionUI();
}

// v5.10：主体跟拍到哪里结束——「主体跟到 9.7 秒，之后画面里是其他人」。
// 主体跟完了整段视频时不加这句（没有可说的就别说）。
function subjectEndNote() {
  const to = subjectInfo?.track?.stats?.to;
  if (!Number.isFinite(to)) return "";
  const lastT = frames.length ? frames[frames.length - 1].t : to;
  if (to >= lastT - 0.3) return ""; // 主体跟完了整段视频（或只差最后几帧），不用多说什么
  const hasOther = frames.some((f) => f.t > to + 1e-3 && (f.others?.length ?? 0) > 0);
  const text = hasOther
    ? `主体跟到 ${to.toFixed(1)} 秒，之后画面里是其他人。`
    : `主体跟到 ${to.toFixed(1)} 秒，之后画面里没有再跟拍到这个人。`;
  return `<p class="report-note">${text}</p>`;
}

// 摘要行的参数：把运行态（机位判定、主体选取、帧的账）交给 report.js 的纯函数拼成那一行
function summaryArgs(metricCount) {
  return {
    metricCount,
    metricTotal: Object.keys(METRIC_VIEWS).length,
    view: mainView,
    viewInfo: mainViewInfo,
    subject: subjectInfo,
    subjectFrames: frameStats?.subjectFrames ?? frames.filter((f) => f.landmarks).length,
    totalFrames: frames.length || 1,
    detectedFrames: frameStats?.detected ?? 0,
    invalidFrames: frameStats?.invalid ?? 0,
  };
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
  const refScan = await scanInto(refVideo, landmarker, (p) => {
    $("cmp-status").textContent = `识别参考视频… ${Math.round(p * 100)}%`;
  }, (n) => { $("cmp-status").textContent = `⚠️ ${n}`; });
  // 参考视频同样走「主体提取」：refFrames 需要 landmarks（画叠加层用）与 pt（帧级硬绑定）
  const refApplied = applySubject(refScan, buildTracks(refScan));
  refFrames = refApplied.frames;
  refFrames.peopleSeen = refScan.peopleSeen;
  refFrames.failedFrames = refScan.failedFrames;

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

  dualState.mapAtoB = mapAtoB;
  dualState.refCycle = refCycle;
  dualState.refSide = refSide;

  if (!dualRunning) {
    dualRunning = true;
    startDualLoops();
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

// 双窗播放状态（映射表 + 参考视频的出手周期/侧）
const dualState = { mapAtoB: null, refCycle: null, refSide: "right" };

/**
 * 双窗对比：两侧叠加层都由「真正上屏那一帧」驱动（rVFC 的 mediaTime），
 * 帧号一律用 frameIndexAt 查——不再用 Math.round(currentTime / dt) 猜。
 * 左侧（我的动作）播放时按 DTW 映射去 seek 参考视频；参考视频是程序 seek 的，
 * 它自己的叠加层用参考视频的上屏时间戳取帧。
 */
function startDualLoops() {
  const dualOpts = { showSkeleton: true, showJoints: true, showAngles: false };
  const drawDualMy = (mediaTime) => {
    const mt = mediaTime ?? dualMy.currentTime;
    const g = frameIndexAt(frames, mt);
    if (frames.length && lastCycle && refFrames.length && !$("dual-pane").classList.contains("hidden")) {
      const map = dualState.mapAtoB ?? [];
      const a = Math.max(0, Math.min(map.length - 1, g - lastCycle.crouchIdx));
      const rg = (dualState.refCycle?.crouchIdx ?? 0) + (map[a] ?? 0);
      // 参考视频要跳到的那一帧：优先用真正上屏的时间戳（pt），没有才用采样时刻
      const target = refFrames[rg]?.pt ?? refFrames[rg]?.t ?? 0;
      if (Math.abs(refVideo.currentTime - target) > 0.08) refVideo.currentTime = target;
    }
    paintOverlay(dualMyCtx, frames[g], { ...dualOpts, side: chosenSide });
  };
  const drawDualRef = (mediaTime) => {
    const mt = mediaTime ?? refVideo.currentTime;
    paintOverlay(refCtx, refFrames[frameIndexAt(refFrames, mt)], { ...dualOpts, side: dualState.refSide });
  };
  if (supportsFrameCallback(dualMy)) {
    const myStep = (_now, meta) => {
      drawDualMy(meta?.mediaTime);
      dualMy.requestVideoFrameCallback(myStep);
    };
    dualMy.requestVideoFrameCallback(myStep);
  } else {
    const loop = () => {
      drawDualMy(dualMy.currentTime);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
  if (supportsFrameCallback(refVideo)) {
    const refStep = (_now, meta) => {
      drawDualRef(meta?.mediaTime);
      refVideo.requestVideoFrameCallback(refStep);
    };
    refVideo.requestVideoFrameCallback(refStep);
  } else {
    const loop = () => {
      drawDualRef(refVideo.currentTime);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
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
  // 导入的档案里分数可能是字符串：一律按数字取，避免比较与求和出错
  const delta = report.score - Number(same[0].score);
  parts.push(delta === 0 ? "与上次同分" : `较上次 ${delta > 0 ? "+" : ""}${delta} 分`);
  const scored = same.filter((r) => isFinite(Number(r.score)));
  const avg = (arr) => (arr.length ? arr.reduce((s, r) => s + Number(r.score), 0) / arr.length : null);
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
    const cmp = compareMetric(base, m.id, m.num, {
      lowerIsBetter: LOWER_IS_BETTER.has(m.id),
      neutral: NEUTRAL_DIRECTION.has(m.id),
    });
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
  const scored = records.filter((r) => isFinite(Number(r.score)));
  const avg = (arr) => (arr.length ? arr.reduce((s, r) => s + Number(r.score), 0) / arr.length : null);
  const recent = avg(scored.slice(0, 3));
  const earlier = avg(scored.slice(3, 6));
  const trendText =
    sum.trend == null ? "样本不足" : sum.trend > 0 ? `↗ 上升 ${sum.trend.toFixed(1)}` : sum.trend < 0 ? `↘ 下降 ${Math.abs(sum.trend).toFixed(1)}` : "→ 持平";

  // 评分历史：x 轴用时间戳（图表不画 x 轴刻度，日期在下方记录列表里逐条列出）
  const scorePts = [...records].reverse().map((r) => ({ x: Number(r.ts), y: Number(r.score) })).filter((p) => isFinite(p.y));
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
        .map(([id, m]) => `<div class="hist-metric"><span>${esc(METRIC_NAMES[id] ?? m.name ?? id)}</span><b>${esc(m.value ?? m.num)}</b></div>`)
        .join("");
      return `
        <li class="hist-item">
          <div class="hist-row">
            <span class="hist-date">${esc(r.date)}</span>
            <span class="hist-type">${esc(TYPE_LABEL[r.type] ?? r.type ?? "—")}</span>
            <span class="hist-src">${esc(r.source)}</span>
            <span class="hist-score">${isFinite(r.score) ? `${Number(r.score)} ${esc(r.grade)}` : "—"}</span>
            <button class="hist-del" data-id="${esc(r.id)}" title="删除这条记录">✕</button>
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
    <select id="history-metric" class="hist-select">${ids.map((id) => `<option value="${esc(id)}">${esc(METRIC_NAMES[id] ?? id)}</option>`).join("")}</select>
    ${trendChart || '<p class="report-empty">该指标暂无历史读数。</p>'}
    ${lastNum != null ? `<p class="hint">最近一次：${esc(METRIC_NAMES[metricId] ?? metricId)} ${esc(typeof lastNum === "number" ? lastNum.toFixed(2) : lastNum)}${esc(metric?.unit)}</p>` : ""}
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
  seekOffset = null; // 每次扫描重新测这个视频的栅格偏移（不同视频的帧栅格未必一样）
  const out = [];
  const span = Math.min(el.duration || 0, MAX_SECONDS);
  const dt = 1 / SAMPLE_FPS;
  const prevW = inferCanvas.width, prevH = inferCanvas.height;
  inferCanvas.width = el.videoWidth; // 各视频分辨率可能不同
  inferCanvas.height = el.videoHeight;
  const aspect = el.videoWidth / el.videoHeight || 1; // 归一化坐标 x 乘此值才是真实几何
  let failStreak = 0; // 连续推理失败计数（GPU 上下文丢失时重建模型）
  let failedFrames = 0; // 最终失败的帧数（已插值；在状态栏披露，避免无声拉低评分）
  // v5.9：扫描阶段保留每帧的全部候选姿态，不再在这里挑人。
  // 「挑人」这件事挪到扫描之后统一做（js/tracks.js 的轨迹聚类 + 出手证据），
  // 因为逐帧挑「占画面最大的人」在手持跟拍里会挑到不同的人（画面里忽远忽近）。
  let peopleSeen = 1;
  const normalizePoses = (list) =>
    (list ?? []).filter((lm) => Array.isArray(lm) && lm.length >= 29);
  for (let t = 0; t < span; t += dt) {
    // pt = 这一帧真正上屏的时间戳；
    // 拿不到真值时用「名义时刻 + 已测得的栅格偏移」回退，而不是直接用名义时刻——
    // 栅格偏个 1.7 毫秒，播放时按时间轴查样本就会跳到前一帧（骨架画到前一帧的人身上）。
    const mt = await seekOn(el, t);
    const pt = mt != null ? mt : (seekOffset != null ? t + seekOffset : t);
    inferCtx.drawImage(el, 0, 0, inferCanvas.width, inferCanvas.height);
    let poses = [];
    try {
      const res = landmarker.detectForVideo(inferCanvas, nextTimestamp());
      poses = normalizePoses(res.landmarks);
      failStreak = 0;
    } catch {
      // 个别帧失败重试一次；连续多帧失败视为 GPU 上下文丢失，重建模型（改用 CPU）继续
      failStreak++;
      try {
        const res = landmarker.detectForVideo(inferCanvas, nextTimestamp());
        poses = normalizePoses(res.landmarks);
        failStreak = 0;
      } catch { failedFrames++; /* 放弃该帧 */ }
      if (failStreak >= 5) {
        onNote?.("推理异常，已切换到 CPU 模式继续");
        landmarker = await resetLandmarker();
        failStreak = 0;
      }
    }
    // 多人提示只统计「像真人」的姿态（占画面高度 ≥15%），避免幽灵/误检把单人视频报成多人
    const credible = poses.filter((lm) => (poseBodyHeight(lm) ?? 0) >= 0.15).length;
    if (credible > peopleSeen) peopleSeen = credible;
    out.push({ t, pt, poses, aspect });
    if (out.length % 5 === 0) {
      onProgress?.(span ? t / span : 1);
      await nextTick(); // 让出主线程，避免页面卡死
    }
  }
  inferCanvas.width = prevW;
  inferCanvas.height = prevH;
  out.failedFrames = failedFrames; // 挂在返回值上，由调用方决定是否披露
  out.peopleSeen = peopleSeen; // >1 时提示「画面里有 N 个人，本次分析的是谁」
  return out;
}

/**
 * 跳到 t 并等这一帧真正上屏。
 * v5.10：resolve 时一并返回「真正上屏那一帧」的时间戳（rVFC 的 metadata.mediaTime），
 * 这样「检测用的采样帧」和「视频帧」有了硬绑定——叠加层才能按同一条时间轴取骨架。
 *
 * v5.10.1：改成「先注册 requestVideoFrameCallback，再设置 currentTime」。
 * 旧写法（先等 seeked 再注册）注册时新帧往往已经上屏，rVFC 要等下一次上屏才触发；
 * 而扫描时视频是暂停的，下一次上屏迟迟不来——于是大约一半的 seek 走 120ms 超时回退，
 * 只能拿到名义采样时刻 t。
 *
 * 注册在 seek 之前，回调有可能对应「seek 之前就上屏的旧帧」，所以同时监听 'seeked'：
 * 只有 'seeked' 之后才接受 rVFC 的 mediaTime；rVFC 先到就重新注册一次继续等
 * （每次注册都要在回调里判断 'seeked' 是否已经发生，没发生就再注册一次）。
 *
 * 不支持 rVFC 的浏览器返回 null（调用方回退用采样时刻 t）。
 */
function seekOn(el, t) {
  return new Promise((resolve) => {
    let settled = false;
    let seeked = false;
    let attempts = 0;
    const TIMEOUT = 120;   // 兜底：拿不到就返回 null，行为与旧版一致
    const MAX_REARM = 8;   // 兜底：旧帧反复先到时的重挂次数上限
    const target = Math.min(t, Math.max(0, (el.duration || 0) - 0.05));

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      el.removeEventListener("seeked", onSeeked);
      resolve(value);
    };

    const onSeeked = () => { seeked = true; };

    const arm = () => {
      if (settled) return;
      if (typeof el.requestVideoFrameCallback === "function") {
        el.requestVideoFrameCallback((_now, meta) => {
          if (settled) return;
          if (!seeked) {
            // 这一帧是 seek 之前就上屏的旧帧：不算数，重新注册等下一次上屏
            if (++attempts > MAX_REARM) { finish(null); return; }
            setTimeout(arm, 0);
            return;
          }
          const mt = meta?.mediaTime;
          if (typeof mt === "number" && Number.isFinite(mt)) {
            // 帧时间戳栅格相对名义采样时刻的偏移（同一视频里是常量）：拿不到真值时按它回退
            seekOffset = mt - target;
            finish(mt);
          } else {
            finish(null);
          }
        });
      } else {
        // 不支持 rVFC 的浏览器：等 seeked 之后再稳定两拍，回退用采样时刻 t
        el.addEventListener("seeked", () => {
          nextTick().then(() => nextTick()).then(() => finish(null));
        }, { once: true });
      }
    };

    const timer = setTimeout(() => finish(null), TIMEOUT);
    el.addEventListener("seeked", onSeeked);
    arm(); // 先注册 rVFC 再 seek：注册晚一步就抓不到这次 seek 上屏的那一帧
    el.currentTime = target;
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
    // 手动指定机位 = 用户自己确认过了，跳过「机位不固定」的判定
    slot.viewInfo = { ...(slot.viewInfo ?? {}), view: slot.view, unstable: false, manual: true };
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
  // 补拍视频同样先聚轨迹再选主体（与主视频同一套口径）
  const applied = applySubject(fr, buildTracks(fr));
  const slotFrames = applied.frames;
  slotFrames.peopleSeen = fr.peopleSeen;
  slotFrames.failedFrames = fr.failedFrames;
  if (!slotFrames.some((f) => f.landmarks)) {
    st.textContent = "❌ 未识别到人像，请换更清晰的视频。";
    fusionSlots[i] = null;
    updateFusionUI();
    return;
  }

  const viewInfo = classifyView(slotFrames);
  let view = viewInfo.view;
  const detect = detectShotCycles(slotFrames, pickSide(slotFrames), SAMPLE_FPS);
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
  if (view === "front" || view === "oblique") side = pickShootingSide(slotFrames, cycles, side);
  const vis = windowVisibility(slotFrames, Object.values(SIDE[side]), cycle.crouchIdx, cycle.apexIdx);
  fusionSlots[i] = { label: `补拍${n}`, frames: slotFrames, cycles, cycle, side, view, vis, viewInfo };
  $(`fusion-view-${n}`).classList.remove("hidden");
  $(`fusion-view-${n}`).value = view;
  st.innerHTML = `✅ ${VIEW_LABEL[view]}机位${viewInfo.unstable ? "（机位不固定，按侧面近似）" : ""} · 检测到 ${cycles.length} 次出手${cycles.rejected ? ` · ⚠️ ${cycles.rejected} 次未计入（人物不在画面）` : ""}${fr.failedFrames ? ` · ⚠️ ${fr.failedFrames} 帧识别失败` : ""}${note}`;
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
      .map((c) => computeMetrics(a.frames, c, a.side, type, a.view, SAMPLE_FPS));
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

// 第 1 步的拍摄清单（可勾选，只当行动提示，不持久化、不参与任何判定）
renderShotChecklist($("shot-checklist"));

// 指标白话说明的展开/收起：点一下就地摊开，同一时刻只展开一行
// （普通球友是截图发群的，所以不能用 hover 提示；展开状态不持久化，刷新即收起）
document.addEventListener("click", (e) => {
  const btn = e.target.closest(".m-info");
  if (!btn) return;
  const item = btn.closest(".metric-item");
  const panel = item?.querySelector(".metric-plain");
  if (!panel) return;
  const wasOpen = !panel.hidden;
  document.querySelectorAll(".metric-plain").forEach((p) => { p.hidden = true; });
  document.querySelectorAll(".m-info").forEach((b) => b.setAttribute("aria-expanded", "false"));
  if (!wasOpen) {
    panel.hidden = false;
    btn.setAttribute("aria-expanded", "true");
  }
});

// 训练档案区：进入页面先把已有档案渲染出来（空档案显示引导文案）
renderHistory();
