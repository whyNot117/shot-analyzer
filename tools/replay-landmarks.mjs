// 真实素材离线回放：把 MediaPipe 导出的关键点 dump 喂给 v5.9 的分析流水线，
// 在 Node 里跑完「选主体 → 判机位 → 检测出手 → 出指标 → 出报告」全流程。
//
// 为什么要有这个工具：
//   tools/e2e-real.mjs 需要能起浏览器（本机沙箱里浏览器起不来），
//   而调轨迹聚类/出手判定这类算法时，真正需要的只是关键点，不是图像。
//   一次导出、反复回放，比每次重跑一遍 MediaPipe 快一个量级。
//
// 用法：
//   node tools/replay-landmarks.mjs <landmarks.json> [--json]
//   node tools/replay-landmarks.mjs <landmarks.json> --check   （按验收标准 B1–B6 自检）
//
// landmarks.json 的格式（由上一轮的一次性导出脚本生成）：
//   { w, h, duration, frames: [{ t, poses: [[ [x, y, z, visibility], ...33 ], ... ] }] }
// 注意：dump 里是「每帧的全部候选姿态」，与 v5.9 扫描阶段保留的内容一致。

import { readFileSync } from "node:fs";
import { buildTracks, applySubject, videoLevelFrames, poseBodyHeight } from "../js/tracks.js";
import { classifyView } from "../js/views.js";
import { pickSide, pickShootingSide } from "../js/draw.js";
import { detectShotCycles, mergeCycles, computeMetrics, METRIC_VIEWS } from "../js/metrics.js";
import { assessClipQuality } from "../js/quality.js";
import {
  buildReport, renderReport, noScoreReasons,
  subjectLabelText, summaryLineText, statusLineText,
} from "../js/report.js";

const FILE = process.argv[2];
const AS_JSON = process.argv.includes("--json");
const CHECK = process.argv.includes("--check");
if (!FILE) {
  console.error("用法：node tools/replay-landmarks.mjs <landmarks.json> [--json]");
  process.exit(1);
}

const SAMPLE_FPS = 30;
const dump = JSON.parse(readFileSync(FILE, "utf8"));
const aspect = dump.w / dump.h || 1;

// ① 扫描结果：每帧的全部候选姿态（与 app.js 的 scanIntoInner 产出同构）
const scanFrames = dump.frames.map((f) => ({
  t: f.t,
  aspect,
  poses: (f.poses ?? []).map((pts) =>
    pts.map(([x, y, z, visibility]) => ({ x, y, z, visibility: visibility ?? 1 }))
  ),
}));
// 人数提示只统计「像真人」的姿态（占画面高度 ≥15%），与 app.js 同一口径
let peopleSeen = 1;
for (const f of scanFrames) {
  const credible = f.poses.filter((lm) => (poseBodyHeight(lm) ?? 0) >= 0.15).length;
  if (credible > peopleSeen) peopleSeen = credible;
}

// ② 主体选取：轨迹聚类 + 出手证据
const applied = applySubject(scanFrames, buildTracks(scanFrames));
const frames = applied.frames;
frames.peopleSeen = peopleSeen;
frames.failedFrames = 0;
const subject = applied.subject;
const frameStats = applied.stats;

// ③ 机位判定（带依据 + 一致性检查）
const viewInfo = classifyView(frames);
const mainView = viewInfo.view;

// ④ 出手周期检测
let chosenSide = pickSide(frames);
const detect = detectShotCycles(frames, chosenSide, SAMPLE_FPS, "auto");
const cycles = detect.cycles;
if (cycles.length) chosenSide = detect.side;

// ⑤ 素材质量（问的是素材本身，用视频级帧）
const quality = assessClipQuality(videoLevelFrames(scanFrames), chosenSide, {
  cycleCount: cycles.length,
  peopleSeen,
});

const out = {
  total: frames.length,
  peopleSeen,
  frameStats,
  subject: {
    reason: subject.reason,
    label: subjectLabelText(subject),
    shotEvents: subject.track?.stats?.shotEvents ?? 0,
    shotSpans: subject.track?.stats?.shotSpans ?? [],
    frames: subject.track?.stats?.frames ?? 0,
    bodyHeight: subject.track?.stats?.bodyHeight ?? 0,
    x: subject.track?.stats?.x ?? 0,
  },
  view: {
    view: mainView,
    ratio: viewInfo.ratio,
    sideShare: viewInfo.sideShare,
    frontShare: viewInfo.frontShare,
    iqr: viewInfo.iqr,
    zoomRatio: viewInfo.zoomRatio,
    unstable: viewInfo.unstable,
    reasons: viewInfo.reasons,
    reason: viewInfo.reason,
  },
  cycles: cycles.length,
  rejected: detect.rejected,
  quality: { level: quality.level, issues: quality.issues?.map((i) => i.title) ?? [] },
};

const status = statusLineText({
  subjectFrames: frameStats.subjectFrames,
  totalFrames: frames.length,
  detectedFrames: frameStats.detected,
  invalidFrames: frameStats.invalid,
  otherFrames: frameStats.otherFrames,
  peopleSeen,
  subject,
  view: mainView,
  viewInfo,
  failedFrames: 0,
});
out.status = status;

if (quality.level === "bad") {
  out.report = { blocked: "素材质量不合格（bad），按 v5.8 既有逻辑不出评分报告" };
} else if (!cycles.length) {
  out.report = { blocked: "没有检测到完整的出手动作" };
} else {
  if (mainView === "front" || mainView === "oblique") {
    chosenSide = pickShootingSide(frames, cycles, chosenSide);
  }
  const type = "auto";
  const metrics = mergeCycles(
    cycles.map((c) => computeMetrics(frames, c, chosenSide, type, mainView, SAMPLE_FPS))
  );
  const reasons = noScoreReasons({
    unstable: !!viewInfo.unstable,
    unstableReasons: viewInfo.reasons,
    peopleSeen,
    hasShot: (subject.track?.stats?.shotEvents ?? 0) > 0,
    subjectFrames: frameStats.subjectFrames,
    totalFrames: frames.length,
    droppedFrames: frameStats.otherFrames + frameStats.invalid,
    qualityLevel: quality.level,
  });
  const report = buildReport(metrics, type, cycles.length, { noScoreReasons: reasons });
  const summary = summaryLineText({
    metricCount: metrics.length,
    metricTotal: Object.keys(METRIC_VIEWS).length,
    view: mainView,
    viewInfo,
    subject,
    subjectFrames: frameStats.subjectFrames,
    totalFrames: frames.length,
    detectedFrames: frameStats.detected,
    invalidFrames: frameStats.invalid,
  });
  const el = { innerHTML: "" };
  renderReport(el, report, { summaryLine: summary, quality });
  out.report = {
    summary,
    metricCount: metrics.length,
    metricTotal: Object.keys(METRIC_VIEWS).length,
    score: report.score,
    grade: report.grade,
    noScore: report.noScore,
    htmlHasScoreRing: el.innerHTML.includes("score-ring"),
    htmlHasGrade: /<small>[SABCD]<\/small>/.test(el.innerHTML),
    htmlHasSummary: /本次测到 \d+\/24 项/.test(el.innerHTML),
    htmlHasNoScoreNote: el.innerHTML.includes("这次读数只能作参考"),
    tips: report.tips.map((t) => `${t.level}｜${t.name}｜${t.text}`),
  };
}

if (AS_JSON) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log("════ v5.9 真实素材离线回放 ════");
  console.log("状态行：\n  " + out.status);
  console.log("\n主体：", JSON.stringify(out.subject, null, 1));
  console.log("机位：", JSON.stringify(out.view, null, 1));
  console.log("帧的账：", JSON.stringify(out.frameStats));
  console.log("出手周期：", out.cycles, "未计入：", out.rejected, "素材质量：", out.quality.level, out.quality.issues);
  console.log("\n报告：", JSON.stringify(out.report, null, 1));
}

if (CHECK) {
  // 按 v5.9 规格的验收标准自检（用真实素材跑出来的结果对照）
  console.log("\n════ 验收标准自检 ════");
  let bad = 0;
  const ck = (name, cond, detail = "") => {
    if (cond) console.log(`  ✅ ${name}`);
    else { bad++; console.log(`  ❌ ${name}${detail ? " —— " + detail : ""}`); }
  };
  const spans = out.subject.shotSpans ?? [];
  const inShotWindow = spans.some((s) => s.from >= 9.3 && s.from <= 9.6 && s.to >= 9.6);
  ck("B1 主体是「有出手事件」的轨迹，且出手落在 t≈9.4–9.8 秒", out.subject.shotEvents > 0 && inShotWindow,
    JSON.stringify(spans));
  ck("B1 报告里能看出主体来自哪一段（摘要带出手时段）",
    /正在出手的那个（\d+\.\d+–\d+\.\d+ 秒）/.test(out.report?.summary ?? ""), out.report?.summary);
  ck("B2 机位判为不固定并写明依据", out.view.unstable === true && out.view.reasons.length > 0,
    JSON.stringify(out.view.reasons));
  ck("B3 报告不出 0–100 分数，也不出 S/A/B/C/D 等级",
    out.report?.score == null && out.report?.grade == null &&
    !out.report?.htmlHasScoreRing && !out.report?.htmlHasGrade);
  ck("B3 报告改为「这次读数只能作参考」并说明原因",
    out.report?.htmlHasNoScoreNote === true && (out.report?.noScore?.length ?? 0) > 0);
  ck("B4 报告顶部有「本次测到 N/24 项」摘要", /本次测到 \d+\/24 项/.test(out.report?.summary ?? ""));
  ck("B5 有效帧数明显高于旧实现的 336（目标 ≥380）", out.frameStats.detected >= 380,
    `检出 ${out.frameStats.detected} 帧`);
  ck("B5 状态行/摘要披露了被剔除的无效姿态帧数",
    out.frameStats.invalid > 0 && /已剔除 \d+ 帧无效姿态/.test(out.status) &&
    /已剔除 \d+ 帧无效姿态/.test(out.report?.summary ?? ""));
  console.log(bad === 0 ? "\n🎉 验收标准全部通过" : `\n💥 ${bad} 项不通过`);
  process.exit(bad === 0 ? 0 : 1);
}
