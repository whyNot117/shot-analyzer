// 纯逻辑模块的 Node 冒烟测试（不依赖浏览器/DOM，只测 metrics/views/report/draw 的纯函数）
// 运行：node test/logic-test.mjs
import {
  detectShotCycles, mergeCycles, computeMetrics, METRIC_VIEWS,
} from "../js/metrics.js";
import { isHevcFile, makePersonPicker } from "../js/media.js";
import { classifyView, windowVisibility, coverageGaps } from "../js/views.js";
import { buildReport, escHtml } from "../js/report.js";
import { SIDE, pickSide, pickShootingSide, angleAt } from "../js/draw.js";

const ASPECT = 1080 / 1920; // 竖屏视频宽高比
const FPS = 30;
let failures = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`  ✅ ${name}`);
  else { failures++; console.log(`  ❌ ${name}${detail ? " —— " + detail : ""}`); }
};

// ---- 合成帧：关键帧之间线性插值，poses[i] = { 关键点索引: [x, y, visibility?] } ----
function buildFrames(keyIdx, poses, mirror) {
  const frames = [];
  const last = keyIdx[keyIdx.length - 1];
  for (let i = 0; i <= last; i++) {
    let k = 0;
    while (k < keyIdx.length - 1 && i > keyIdx[k + 1]) k++;
    const t0 = keyIdx[k], t1 = keyIdx[Math.min(k + 1, keyIdx.length - 1)];
    const r = t1 === t0 ? 0 : (i - t0) / (t1 - t0);
    const a = poses[k], b = poses[Math.min(k + 1, poses.length - 1)];
    const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0.5 }));
    for (const idx of new Set([...Object.keys(a), ...Object.keys(b)].map(Number))) {
      const p = a[idx] ?? b[idx], q = b[idx] ?? a[idx];
      lm[idx] = { x: p[0] + (q[0] - p[0]) * r, y: p[1] + (q[1] - p[1]) * r, visibility: p[2] ?? 0.9 };
    }
    mirror?.(lm);
    frames.push({ t: i / FPS, landmarks: lm, aspect: ASPECT });
  }
  return frames;
}

// 侧面合成视频：右链朝镜头（站立 → 下蹲举球 → 蹬伸[髋先起] → 出手 → 跟随 → 落地），左链重叠且可见度低
const SIDE_POSES = [
  { 0: [0.50, 0.25], 12: [0.50, 0.32], 14: [0.54, 0.42], 16: [0.50, 0.50], 24: [0.50, 0.55], 26: [0.50, 0.75], 28: [0.49, 0.95] },
  { 0: [0.50, 0.33], 12: [0.50, 0.40], 14: [0.52, 0.47], 16: [0.48, 0.44], 24: [0.50, 0.62], 26: [0.54, 0.78], 28: [0.49, 0.95] },
  { 0: [0.50, 0.30], 12: [0.50, 0.36], 14: [0.52, 0.44], 16: [0.48, 0.44], 24: [0.50, 0.50], 26: [0.52, 0.74], 28: [0.49, 0.95] },
  { 0: [0.50, 0.28], 12: [0.50, 0.34], 14: [0.53, 0.28], 16: [0.55, 0.15], 24: [0.50, 0.50], 26: [0.52, 0.74], 28: [0.49, 0.95] },
  { 0: [0.50, 0.28], 12: [0.50, 0.34], 14: [0.52, 0.24], 16: [0.53, 0.13], 24: [0.50, 0.52], 26: [0.52, 0.75], 28: [0.49, 0.95] },
  { 0: [0.50, 0.26], 12: [0.50, 0.33], 14: [0.52, 0.30], 16: [0.52, 0.20], 24: [0.50, 0.55], 26: [0.52, 0.76], 28: [0.49, 0.95] },
];
// 左链整体右移 0.09 模拟常见 30° 转体站位（校正后比值≈0.08 属侧面带；不校正会读到 0.14 被误判斜侧）
const sideFrames = buildFrames([0, 36, 42, 50, 65, 95], SIDE_POSES, (lm) => {
  for (const [f, n] of [[12, 11], [14, 13], [16, 15], [24, 23], [26, 25], [28, 27]]) {
    lm[n] = { x: lm[f].x + 0.09, y: lm[f].y, visibility: 0.35 };
  }
});

// 正面合成视频：双肩张开；左臂为出手臂（腕部过肩），右臂只是辅助（腕不过肩）
const FRONT_POSES = [
  { 0: [0.50, 0.25], 11: [0.42, 0.32], 12: [0.58, 0.32], 13: [0.40, 0.44], 15: [0.46, 0.48], 14: [0.60, 0.44], 16: [0.56, 0.50], 23: [0.46, 0.55], 24: [0.54, 0.55], 25: [0.46, 0.75], 26: [0.54, 0.75], 27: [0.44, 0.95], 28: [0.56, 0.95] },
  { 0: [0.50, 0.33], 11: [0.42, 0.40], 12: [0.58, 0.40], 13: [0.38, 0.47], 15: [0.45, 0.42], 14: [0.60, 0.47], 16: [0.56, 0.46], 23: [0.46, 0.64], 24: [0.54, 0.64], 25: [0.39, 0.79], 26: [0.61, 0.79], 27: [0.44, 0.95], 28: [0.56, 0.95] },
  { 0: [0.50, 0.28], 11: [0.42, 0.34], 12: [0.58, 0.34], 13: [0.43, 0.26], 15: [0.47, 0.14], 14: [0.60, 0.30], 16: [0.57, 0.40], 23: [0.46, 0.50], 24: [0.54, 0.50], 25: [0.46, 0.74], 26: [0.54, 0.74], 27: [0.44, 0.95], 28: [0.56, 0.95] },
  { 0: [0.50, 0.28], 11: [0.42, 0.34], 12: [0.58, 0.34], 13: [0.44, 0.24], 15: [0.48, 0.13], 14: [0.60, 0.30], 16: [0.57, 0.40], 23: [0.46, 0.52], 24: [0.54, 0.52], 25: [0.46, 0.75], 26: [0.54, 0.75], 27: [0.44, 0.95], 28: [0.56, 0.95] },
];
// 横向幅度按真实竖屏视频标定：widen(k) 把所有 x 相对画面中线放大 k 倍。
// k=1.7 时「肩距×宽高比÷体高」≈0.24（真实正面 0.20–0.26）；k=1.05 时≈0.15，落在斜侧带 0.12–0.17
const widen = (poses, k) =>
  poses.map((p) => Object.fromEntries(
    Object.entries(p).map(([i, xy]) => [i, [0.5 + (xy[0] - 0.5) * k, ...xy.slice(1)]])
  ));
const frontFrames = buildFrames([0, 40, 50, 65], widen(FRONT_POSES, 1.7));
const obliqueFrames = buildFrames([0, 40, 50, 65], widen(FRONT_POSES, 1.05));

console.log("— 机位判别（含宽高比校正）—");
// v5.9：classifyView 改成返回带依据的对象（{ view, ratio, sideShare, frontShare, unstable, reason }），
// 断言跟着新 API 走；同时补上「机位不固定」的判定。
const sideInfo = classifyView(sideFrames);
const frontInfo = classifyView(frontFrames);
const obliqueInfo = classifyView(obliqueFrames);
const emptyInfo = classifyView([]);
check("侧面视频判为 side（30° 转体站位，不校正会误判斜侧）", sideInfo.view === "side");
check("正面视频判为 front（校正后比值≈0.24）", frontInfo.view === "front");
check("斜侧视频判为 oblique（校正后比值≈0.15，不校正会误判 front）", obliqueInfo.view === "oblique");
check("空视频判为 unknown", emptyInfo.view === "unknown");
check("机位判定带依据（肩宽比中位数 + 中文说明）",
  Math.abs(frontInfo.ratio - 0.256) < 0.01 && typeof frontInfo.reason === "string" && frontInfo.reason.length > 0);
check("稳定的机位不算 unstable", frontInfo.unstable === false && sideInfo.unstable === false);
check("coverageGaps(side) 指向正面", coverageGaps("side").length === 1 && coverageGaps("side")[0].view === "front");

// 机位不固定（v5.9 改动 3）：合成可控比值的帧，分别构造「双峰」与「运镜」两种情形
// mkViewFrame(t, ratio, scale)：造一帧肩宽比恰为 ratio 的姿态；scale 缩放整体体高（模拟运镜远近）
const mkViewFrame = (t, ratio, scale = 1) => {
  const torsoH = 0.4 * scale;
  const bodyH = 0.55 * scale;
  const shoulderY = 0.3;
  const gap = (ratio * torsoH) / ASPECT;
  const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0.9 }));
  const headY = shoulderY + torsoH - bodyH;
  // 头部三个关键点都要给：体高按「头顶三点均值 → 踝两点均值」算，漏一个就会被默认值带偏
  lm[0] = { x: 0.5, y: headY, visibility: 0.9 };
  lm[7] = { x: 0.5, y: headY, visibility: 0.9 };
  lm[8] = { x: 0.5, y: headY, visibility: 0.9 };
  lm[11] = { x: 0.5 - gap / 2, y: shoulderY, visibility: 0.9 };
  lm[12] = { x: 0.5 + gap / 2, y: shoulderY, visibility: 0.9 };
  lm[27] = { x: 0.5, y: shoulderY + torsoH, visibility: 0.9 };
  lm[28] = { x: 0.5, y: shoulderY + torsoH, visibility: 0.9 };
  return { t, landmarks: lm, aspect: ASPECT };
};
const bimodalFrames = [
  ...Array.from({ length: 50 }, (_, i) => mkViewFrame(i / FPS, 0.05)),
  ...Array.from({ length: 50 }, (_, i) => mkViewFrame((50 + i) / FPS, 0.25)),
];
const zoomFrames = [
  ...Array.from({ length: 10 }, (_, i) => mkViewFrame(i / FPS, 0.25, 0.15)),
  ...Array.from({ length: 10 }, (_, i) => mkViewFrame((10 + i) / FPS, 0.25, 1)),
];
const bimodalInfo = classifyView(bimodalFrames);
const zoomInfo = classifyView(zoomFrames);
check("双峰（侧/正各占一半）判为机位不固定", bimodalInfo.unstable === true);
check("双峰时按侧面近似处理（宁可少报）", bimodalInfo.view === "side");
check("双峰时写明占比依据", /双峰/.test(bimodalInfo.reason) && bimodalInfo.sideShare > 0.2 && bimodalInfo.frontShare > 0.2);
check("运镜（体高 p90/p10 > 3）判为机位不固定", zoomInfo.unstable === true);
check("运镜时写明运镜幅度依据", /运镜/.test(zoomInfo.reason) && zoomInfo.zoomRatio > 3);
check("手动指定机位时跳过 unstable 判定", classifyView(bimodalFrames, { manual: true }).unstable === false);

console.log("— 选边 —");
check("侧面自动选可见侧", pickSide(sideFrames) === "right");

console.log("— 周期检测（换侧重试 + 多球）—");
const sideDetect = detectShotCycles(sideFrames, "right", FPS);
const sideCycle = sideDetect.cycles[0];
check("侧面检出 1 次出手", sideDetect.cycles.length === 1, `n=${sideDetect.cycles.length}`);
check("出手帧在预期窗口", sideCycle && sideCycle.releaseIdx >= 40 && sideCycle.releaseIdx <= 55,
  `releaseIdx=${sideCycle?.releaseIdx}`);
// 正面视频 pickSide 平票选 right，但右臂腕部不过肩——必须靠换侧重试才检得出
const frontDetect = detectShotCycles(frontFrames, pickSide(frontFrames), FPS);
check("正面经换侧重试检出周期", frontDetect.cycles.length === 1 && frontDetect.side === "left",
  `side=${frontDetect.side}`);
const frontSide = pickShootingSide(frontFrames, frontDetect.cycles[0], frontDetect.side);
check("正面选出更高的出手臂", frontSide === "left", frontSide);

// 同样动作隔 4.5 秒再来一次：应检出 2 个周期；两次读数相同 → 中位数合并后与单次评分一致
const twoShotFrames = [...sideFrames, ...sideFrames.map((f) => ({ ...f, t: f.t + 4.5 }))];
const twoDetect = detectShotCycles(twoShotFrames, "right", FPS);
check("双球视频检出 2 次出手", twoDetect.cycles.length === 2, `n=${twoDetect.cycles.length}`);
const mergedTwo = mergeCycles(twoDetect.cycles.map((c) => computeMetrics(twoShotFrames, c, sideDetect.side, "jump", "side")));
const singleReport = buildReport(computeMetrics(sideFrames, sideCycle, sideDetect.side, "jump", "side"), "jump");
const mergedReport = buildReport(mergedTwo, "jump", 2);
check("双球合并后 16 项侧面指标无缺失", mergedTwo.length === 16, `n=${mergedTwo.length}`);
check("两次相同出手的合并评分与单次一致", mergedReport.score === singleReport.score,
  `${mergedReport.score} vs ${singleReport.score}`);
check("合并报告标注出手次数", mergedReport.cycleCount === 2);

console.log("— 指标计算（按机位门控）—");
const sideMetrics = computeMetrics(sideFrames, sideCycle, sideDetect.side, "jump", "side");
const sideIds = new Set(sideMetrics.map((m) => m.id));
check("侧面含膝角/举球肘角/出手角", ["kneeCrouch", "elbowSet", "releaseAngle"].every((id) => sideIds.has(id)));
check("侧面不含正面指标",
  !["elbowAbduction", "stanceWidth", "lateralBalance", "kneeAsym", "trunkSideTilt"].some((id) => sideIds.has(id)));
// v5.6：出手/起跳速度是纯垂直量，侧面正面都该测得到
check("侧面含出手垂直速度/起跳上升速度",
  ["releaseVel", "takeoffRiseSpeed"].every((id) => sideIds.has(id)));
check("侧面指标值全部有限", sideMetrics.every((m) => isFinite(m.num)));
check("跳投标准下起跳达标", buildReport(sideMetrics, "jump").metrics.find((m) => m.id === "jump")?.verdict === "good");
// 起跳判定在报告阶段按类型进行（多次出手取中位数后才能正确判定），同一份指标可直接换类型评估
check("罚球标准下起跳判 warn", buildReport(sideMetrics, "free").metrics.find((m) => m.id === "jump")?.verdict === "warn");

const frontMetrics = computeMetrics(frontFrames, frontDetect.cycles[0], frontSide, "jump", "front");
const frontIds = new Set(frontMetrics.map((m) => m.id));
check("正面含肘内外展/站距/左右重心", ["elbowAbduction", "stanceWidth", "lateralBalance"].every((id) => frontIds.has(id)));
check("正面不含矢状面指标", !["kneeCrouch", "releaseAngle", "trunkLean"].some((id) => frontIds.has(id)));
// v5.6：正面机位专有的两项新指标（膝角差 / 躯干侧倾）
check("正面含双膝角度差/躯干侧倾", ["kneeAsym", "trunkSideTilt"].every((id) => frontIds.has(id)));
check("正面同样含出手垂直速度/起跳上升速度",
  ["releaseVel", "takeoffRiseSpeed"].every((id) => frontIds.has(id)));
check("正面仍测出手高度/起跳", frontIds.has("releaseHeight") && frontIds.has("jump"));
check("正面指标值全部有限", frontMetrics.every((m) => isFinite(m.num)));
check("正面产出 11 项指标", frontMetrics.length === 11, `n=${frontMetrics.length}`);
const frontReport = buildReport(frontMetrics, "jump");
check("站距 0.75×肩宽 落入 good（文献修正区间 0.7–1.5）",
  frontReport.metrics.find((m) => m.id === "stanceWidth")?.verdict === "good");
check("左右重心为趋势参考（info，不计分）",
  frontReport.metrics.find((m) => m.id === "lateralBalance")?.verdict === "info");

console.log("— METRIC_VIEWS 与实际产出一致 —");
const allIds = new Set([...sideIds, ...frontIds]);
// 场景专属指标（移动/接球才有）：定点站投的视频里不该出现，也就不该「对得上」
const SCENE_ONLY = ["moveDist", "moveSpeed", "dipAmount"];
const coreIds = Object.keys(METRIC_VIEWS).filter((id) => !SCENE_ONLY.includes(id));
check("指标注册共 24 项（20 核心 + 4 场景专属）", Object.keys(METRIC_VIEWS).length === 24,
  `n=${Object.keys(METRIC_VIEWS).length}`);
check("核心指标 id 全部对得上（场景专属项除外）", coreIds.every((id) => allIds.has(id)),
  [...coreIds.filter((id) => !allIds.has(id))].join(","));
check("场景专属指标在定点站投视频里不产出", !SCENE_ONLY.some((id) => allIds.has(id)),
  SCENE_ONLY.filter((id) => allIds.has(id)).join(","));

console.log("— 多次出手中位数合并 —");
const fake = (id, num, extra = {}) => ({ id, name: id, num, unit: "°", lo: 0, hi: 180, weight: 1, rangeText: "", value: "", ...extra });
const m1 = [fake("kneeCrouch", 100), fake("jump", 0.02, { unit: "×身高" })];
const m2 = [fake("kneeCrouch", 120), fake("jump", 0.08, { unit: "×身高" })];
const m3 = [fake("kneeCrouch", 140)];
const mergedFake = mergeCycles([m1, m2, m3]);
check("奇数个周期取中位数", mergedFake.find((m) => m.id === "kneeCrouch")?.num === 120);
const mj = mergedFake.find((m) => m.id === "jump");
check("偶数个周期取中间均值", mj?.num === 0.05, `num=${mj?.num}`);
check("jump 合并后按中位数重算显示值", mj?.value === "基本贴地", `value=${mj?.value}`);

console.log("— HEVC 编码嗅探 —");
const mkFile = (s) => new File([new TextEncoder().encode(s)], "v.mp4", { type: "video/mp4" });
check("hvc1 嗅探为 HEVC", (await isHevcFile(mkFile("xxftypisom\x00\x00\x02\x00hvc1mp42"))) === true);
check("avc1 不误报 HEVC", (await isHevcFile(mkFile("xxftypisom\x00\x00\x02\x00avc1mp42"))) === false);
check("空内容不误报", (await isHevcFile(mkFile(""))) === false);

console.log("— 逐周期有效性门控与站姿窗口 —");
// 挥手假周期：腕部快速过肩但没有屈腿——应被「下蹲深度门」挡住
const waveSeg = sideFrames.slice(0, 20).map((f) => ({ ...f, landmarks: f.landmarks.map((l) => ({ ...l })) }));
for (let i = 0; i < waveSeg.length; i++) {
  waveSeg[i].landmarks[16] = { x: 0.5, y: 0.5 - 0.25 * Math.sin((i / (waveSeg.length - 1)) * Math.PI), visibility: 0.9 };
}
const waveDetect = detectShotCycles([...waveSeg, ...sideFrames], "right", FPS);
check("挥手（无下蹲）被门控剔除", waveDetect.cycles.length === 1 && waveDetect.cycles[0].releaseIdx > 20,
  `n=${waveDetect.cycles.length}`);
// 短间隔多球：站姿帧不得伸进上一球的滞空/跟随段
const shiftF = (fr, dt) => fr.map((f) => ({ ...f, t: f.t + dt }));
const threeFrames = [...sideFrames, ...shiftF(sideFrames, 2.0), ...shiftF(sideFrames, 4.0)];
const d3 = detectShotCycles(threeFrames, "right", FPS);
check("2.0 秒间隔三球全部检出", d3.cycles.length === 3, `n=${d3.cycles.length}`);
for (let i = 1; i < d3.cycles.length; i++) {
  const prev = d3.cycles[i - 1], cur = d3.cycles[i];
  check(`第 ${i + 1} 球站姿帧在上一球滞空段之外`,
    cur.standIdx <= prev.releaseIdx || cur.standIdx > prev.apexIdx,
    `standIdx=${cur.standIdx} prev=[${prev.releaseIdx},${prev.apexIdx}]`);
}

console.log("— 抖动回归（高斯噪声重采样）—");
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const gauss = () => (rand() + rand() + rand() + rand() - 2) * 0.006; // 近似 σ≈0.012
const jitter = (fr) => fr.map((f) => ({
  ...f, landmarks: f.landmarks.map((l) => ({ ...l, x: l.x + gauss(), y: l.y + gauss() })),
}));
const setNums = [], scoresJ = [];
for (let s = 0; s < 8; s++) {
  const jf = jitter(sideFrames);
  const d = detectShotCycles(jf, "right", FPS);
  if (!d.cycles.length) continue;
  const mts = mergeCycles(d.cycles.map((c) => computeMetrics(jf, c, d.side, "jump", "side")));
  setNums.push(mts.find((m) => m.id === "elbowSet")?.num);
  scoresJ.push(buildReport(mts, "jump", d.cycles.length).score);
}
const std = (a) => {
  const ok = a.filter(isFinite);
  if (ok.length < 2) return 0;
  const m = ok.reduce((x, y) => x + y, 0) / ok.length;
  return Math.sqrt(ok.reduce((s2, x) => s2 + (x - m) ** 2, 0) / ok.length);
};
const spread = scoresJ.length ? Math.max(...scoresJ) - Math.min(...scoresJ) : 99;
check("抖动下每次都能检出出手", scoresJ.length >= 6, `n=${scoresJ.length}`);
check("举球肘角抖动 σ ≤ 8°（旧邻域中位数回归实测 12.8°）", std(setNums) <= 8, `σ=${std(setNums).toFixed(1)}°`);
check("抖动下评分波动 ≤ 20 分", spread <= 20, `spread=${spread}`);

console.log("— 人物离场空档（null 帧）穿过分析链路 —");
// 空档 = 人物不在画面里的帧。fillGaps 会把空档线性插值成「假运动」，
// 若不设防：① 空档插值出的斜坡每帧都满足「±3 帧局部极大」→ 伪造出手；② 站姿基线落进
// 插值帧 → 用伪造基线算屈腿幅度。两种情况都会让空档两侧的球被静默丢掉或算成废数据。
const nullFrames = (from, count) => Array.from({ length: count }, (_, i) => ({
  t: (from + i) / FPS, landmarks: null, aspect: ASPECT,
}));
{
  // 场景：150 帧空档夹在两次出手之间
  const GAP = 150;
  const gap = nullFrames(sideFrames.length, GAP);
  const after = sideFrames.map((f, i) => ({ ...f, t: (sideFrames.length + GAP + i) / FPS }));
  const d = detectShotCycles([...sideFrames, ...gap, ...after], "right", FPS);
  check("空档两侧的两次出手都保留", d.cycles.length === 2, `n=${d.cycles.length}`);
  check("空档后的球基线取真实帧而非插值帧",
    d.cycles.length === 2 && d.cycles[1].standIdx >= sideFrames.length + GAP,
    `standIdx=${d.cycles[1]?.standIdx} 空档结束=${sideFrames.length + GAP}`);
}
{
  // 场景：空档两端姿态差异大 → 插值斜坡不得被当成出手
  const mk = (wristY) => {
    const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0.9 }));
    lm[0] = { x: 0.5, y: 0.25, visibility: 0.9 };
    lm[12] = { x: 0.5, y: 0.34, visibility: 0.9 };
    lm[14] = { x: 0.52, y: 0.3, visibility: 0.9 };
    lm[16] = { x: 0.52, y: wristY, visibility: 0.9 };
    lm[24] = { x: 0.5, y: 0.55, visibility: 0.9 };
    lm[26] = { x: 0.52, y: 0.75, visibility: 0.9 };
    lm[28] = { x: 0.49, y: 0.95, visibility: 0.9 };
    return lm;
  };
  const pre = Array.from({ length: 30 }, (_, i) => ({ t: i / FPS, landmarks: mk(0.5), aspect: ASPECT }));
  const gap = nullFrames(30, 120);
  const post = Array.from({ length: 30 }, (_, i) => ({ t: (150 + i) / FPS, landmarks: mk(0.1), aspect: ASPECT }));
  const d = detectShotCycles([...pre, ...gap, ...post], "right", FPS);
  check("空档插值出的斜坡不产生假出手", d.cycles.length === 0, `n=${d.cycles.length}`);
}
{
  // 场景：屈腿过程大部分在空档里 → 该次出手无法测量，应计入「未计入」并说明原因
  const gap = nullFrames(5, 41);
  const tail = sideFrames.slice(46).map((f, i) => ({ ...f, t: (46 + i) / FPS }));
  const d = detectShotCycles([...sideFrames.slice(0, 5), ...gap, ...tail], "right", FPS);
  check("基线缺失的球计入「未计入」而不是静默消失",
    d.cycles.length === 0 && d.cycles.rejected === 1 && !!d.cycles.rejectNote,
    `n=${d.cycles.length} rejected=${d.cycles.rejected}`);
}

console.log("— 多人锁定 makePersonPicker —");
// 简化姿态：躯干中心 + 头到踝跨度（span==size）；断言用引用相等区分选中的是哪个人
function mkPose(cx, cy, size, vis = 0.9) {
  const lm = Array.from({ length: 33 }, () => ({ x: cx, y: cy, visibility: vis }));
  lm[0] = { x: cx, y: cy - size / 2, visibility: vis };
  for (const i of [11, 12]) lm[i] = { x: cx, y: cy - size / 2 + 0.04, visibility: vis };
  for (const i of [23, 24]) lm[i] = { x: cx, y: cy, visibility: vis };
  for (const i of [25, 26]) lm[i] = { x: cx, y: cy + size / 2 - 0.08, visibility: vis };
  for (const i of [27, 28]) lm[i] = { x: cx, y: cy + size / 2, visibility: vis };
  return lm;
}
const P1 = mkPose(0.5, 0.5, 0.6); // 主人公：大、居中
const P2 = mkPose(0.1, 0.5, 0.3); // 路人：小、画面边缘
{
  const p = makePersonPicker();
  check("首帧锁定占画面最大者", p.pick([P1, P2]) === P1);
  const bigMate = mkPose(0.6, 0.5, 0.85); // 比主人公大 1.4 倍的队友贴着站（透视半步）
  check("更大路人在旁也不抢已确立的锁", p.pick([P1, bigMate]) === P1);
  check("peopleSeen 统计同框最大人数", p.peopleSeen === 2);
  check("主人公消失后冻结等待（不追锁到路人）", p.pick([P2]) === null);
  check("主人公回归即恢复跟踪", p.pick([P1, P2]) === P1);
  const ghost = mkPose(0.5, 0.5, 0.9, 0.05); // 半身路人：肢体全不可见、坐标被外推
  check("低可见度外推肢体不撑大体积", makePersonPicker().pick([P2, ghost]) === P2);
  const nanPose = mkPose(0.2, 0.5, 0.8);
  nanPose[11] = { x: NaN, y: 0.2, visibility: 0.9 };
  const r = makePersonPicker();
  check("NaN 姿态整条剔除且不毒化后续跟踪", r.pick([nanPose, P1]) === P1 && r.pick([P1]) === P1);
  const w = makePersonPicker();
  w.pick([ghost, P2]);
  check("幽灵姿态不计入多人提示", w.peopleSeen === 1);
  const r2 = makePersonPicker();
  r2.pick([nanPose, P1]);
  check("NaN 姿态不计入多人提示", r2.peopleSeen === 1);
}
{ // 贴身遮挡：主人公消失、遮挡者在近旁 → 冻结等待，不锁遮挡者，回归即恢复
  const s = makePersonPicker();
  s.pick([P1]);
  const Q2 = mkPose(0.25, 0.5, 0.35);
  check("遮挡期不把锁交给遮挡者", s.pick([Q2]) === null && s.pick([Q2]) === null);
  check("主人公回归后恢复跟踪", s.pick([P1, Q2]) === P1);
}
{ // 下蹲体积塌缩 vs 旁边站着队友：不丢锁（1.8× 门槛挡住 1.47× 的队友）
  const u = makePersonPicker();
  const T = mkPose(0.28, 0.5, 0.5); // 队友站在 0.22 外
  const Pstand = mkPose(0.5, 0.5, 0.55);
  u.pick([Pstand, T]);
  const Pcrouch = mkPose(0.5, 0.62, 0.34); // 主人公下蹲：体积塌缩、中心下移
  check("主人公下蹲体积塌缩不丢锁给旁边队友", u.pick([Pcrouch, T]) === Pcrouch);
}
{ // 消失超过等待窗口 → 重置基准重锁远处小人，主人公回归凭体积夺回
  const v = makePersonPicker();
  v.pick([P1]);
  const Qsmall = mkPose(0.25, 0.5, 0.2); // 篮下远处小篮板手
  let held = 0;
  for (let i = 0; i < 150; i++) if (v.pick([Qsmall]) === null) held++;
  check("等待窗口内一直冻结（150 帧 null ≈ 5s）", held === 150);
  check("超时后按当前画面重置基准", v.pick([Qsmall]) === Qsmall);
  check("主人公回归凭体积夺回（候选 > 重置基准 1.8×）", v.pick([P1, Qsmall]) === P1);
}
{ // 第四轮审查场景①：主人公出画，体型不符的替身站进锁定点 → 不许继承锁
  const s2 = makePersonPicker();
  s2.pick([P1]);
  const Sub = mkPose(0.5, 0.5, 0.3); // 小替身站在主人公原位（远处的递球/抢板者）
  check("体型不符的替身不能继承锁（位置对也不行）", s2.pick([Sub]) === null && s2.pick([Sub]) === null);
  check("主人公回归恢复跟踪", s2.pick([P1, Sub]) === P1);
  const s3 = makePersonPicker();
  s3.pick([P1]);
  const Big = mkPose(0.5, 0.5, 1.0); // 更近镜头的大替身（1.67×，未到 1.8× 换锁线）
  check("过大的替身同样不能继承锁", s3.pick([Big]) === null);
  check("主人公回归恢复跟踪", s3.pick([P1, Big]) === P1);
}
{ // 第四轮审查场景②：主人公站高 0.55 深蹲塌到 0.36，旁边透视队友 0.5（蹲姿期 1.39×）→ 不丢锁
  const u2 = makePersonPicker();
  const mate = mkPose(0.28, 0.5, 0.5); // 近镜头半步的队友（站高仍小于主人公）
  const hero = mkPose(0.5, 0.5, 0.55);
  u2.pick([hero, mate]);
  const heroCrouch = mkPose(0.5, 0.6, 0.36); // 深蹲底部（塌到站高 65%）
  check("深蹲塌缩 + 透视队友在旁都不丢锁（换锁对比站高记忆而非瞬时值）",
    u2.pick([heroCrouch, mate]) === heroCrouch && u2.pick([heroCrouch, mate]) === heroCrouch);
}
{ // 首帧误锁小路人，主人公稍后入镜：自纠换锁
  const m = makePersonPicker();
  m.pick([P2]);
  check("现任偏小时允许更大候选自纠换锁", m.pick([P2, P1]) === P1);
}

console.log("— 类型自动识别与建议改版 —");
check("auto：有起跳 → 按跳投标准", buildReport(sideMetrics, "auto").type === "jump");
check("auto：无起跳 → 按罚球标准",
  buildReport(sideMetrics.map((m) => (m.id === "jump" ? { ...m, num: 0.02 } : m)), "auto").type === "free");
check("auto 报告带 autoType 标记", buildReport(sideMetrics, "auto").autoType === true);
check("指标附带回看帧号", typeof sideMetrics.find((m) => m.id === "releaseHeight")?.frame === "number");
const singleReportTips = buildReport(sideMetrics, "jump").tips;
check("建议文本已替换 {v} 占位符", singleReportTips.every((t) => !t.text.includes("{v}")));

// 出手高度：读数高于区间上缘时，文案不能说「偏低」；自动识别成罚球时也不能说「跳投出手手高」
const rhTip = (num, type) => {
  const ms = sideMetrics.map((m) => (m.id === "releaseHeight" ? { ...m, num, value: num.toFixed(2) } : m));
  return buildReport(ms, type).tips.find((t) => t.name === "出手高度")?.text ?? "";
};
check("出手高度偏高（1.32）说的是偏高不是偏低", /高于/.test(rhTip(1.32, "jump")) && !/低于/.test(rhTip(1.32, "jump")), rhTip(1.32, "jump"));
check("出手高度偏高（1.55）说的是偏高不是偏低", /高于/.test(rhTip(1.55, "jump")) && !/低于/.test(rhTip(1.55, "jump")), rhTip(1.55, "jump"));
check("出手高度偏低说的是偏低", /低于/.test(rhTip(0.98, "jump")), rhTip(0.98, "jump"));
check("罚球口径不说「跳投出手手高」", !/跳投/.test(rhTip(1.55, "free")), rhTip(1.55, "free"));
check("跳投口径保留「跳投出手手高」", /跳投/.test(rhTip(1.55, "jump")), rhTip(1.55, "jump"));

// 档案可以外部导入：字段进 innerHTML 前必须转义（报告渲染层的 escHtml）
const hostile = `<img src=x onerror="alert('x')">`;
check("escHtml 转义尖括号与引号", !/[<>"]/.test(escHtml(hostile)), escHtml(hostile));
check("escHtml 转义 & 与单引号",
  !escHtml("a & b 'c'").includes("'") && !escHtml("a & b 'c'").includes(" & "), escHtml("a & b 'c'"));
check("escHtml 处理空值", escHtml(undefined) === "" && escHtml(null) === "");

console.log("— 融合合并（复刻 app.js generateFusion 逻辑）—");
const viewsOf = (a) => (a.view === "oblique" ? ["side", "front"] : [a.view === "unknown" ? "side" : a.view]);
const analyses = [
  { label: "主视频", view: "side", vis: 0.9, metrics: sideMetrics },
  { label: "补拍1", view: "front", vis: 0.85, metrics: frontMetrics },
];
const merged = [], missing = [];
for (const id of Object.keys(METRIC_VIEWS)) {
  const cands = analyses.filter(
    (a) => viewsOf(a).some((v) => METRIC_VIEWS[id].includes(v)) && a.metrics.some((m) => m.id === id)
  );
  if (!cands.length) { missing.push(id); continue; }
  const src = cands[0];
  merged.push({ ...src.metrics.find((m) => m.id === id), src: src.label });
}
check("融合后核心指标无缺失（缺的只有场景专属项）",
  merged.length === coreIds.length && missing.every((id) => SCENE_ONLY.includes(id)),
  `merged=${merged.length} missing=${missing.join(",")}`);
check("融合项带来源标签", merged.every((m) => m.src));

console.log("— 报告引擎 —");
const report = buildReport(merged, "jump");
check("评分在 0–100", report.score >= 0 && report.score <= 100, `score=${report.score}`);
check("评级有效", ["S", "A", "B", "C", "D"].includes(report.grade), report.grade);

console.log("— 宽高比校正与可见度 —");
const deg = angleAt({ x: 1, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 1 }, ASPECT);
check("angleAt 按宽高比校正", Math.abs(deg - 60.6) < 0.5, `deg=${deg?.toFixed(1)}（未校正会是 45°）`);
const vis = windowVisibility(sideFrames, Object.values(SIDE.right), 0, 10);
check("窗口可见度在 (0,1]", vis > 0 && vis <= 1, `vis=${vis}`);

console.log(failures === 0 ? "\n🎉 全部通过" : `\n💥 ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
