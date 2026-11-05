// 出手高度归一化的合成测试（v5.6）
// 验证三件事：
// ① 分母改成视频级体高尺度后，站姿帧屈膝不再把分母压小；
// ② 出手时朝镜头走近（尺度变大）不再把读数放大；
// ③ 正常定点跳投的读数仍落在文献区间 1.05–1.30×身高内。
// 运行：node test/release-height-scale.mjs
import { computeMetrics, bodyHeightScale } from "../js/metrics.js";
import { buildReport } from "../js/report.js";
import { smooth, fillGaps, pointsOf } from "../js/angles.js";

const ASPECT = 1080 / 1920;
const FPS = 30;
const N = 96; // 3.2 秒
const LO = 1.05; // 出手高度区间下缘（文献校准，勿改）
const HI = 1.30; // 出手高度区间上缘（文献校准，勿改）

let failures = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`  ✅ ${name}`);
  else { failures++; console.log(`  ❌ ${name}${detail ? " —— " + detail : ""}`); }
};

const median = (arr) => {
  const a = arr.filter((x) => x != null && isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
};

// 侧面合成骨架：给定身体尺度 s（肩−踝距离）、下蹲量 c、身体抬升 lift 与出手臂位置，生成一帧
// rel = (踝y − 腕y) ÷ 身体尺度，即这一帧的「出手高度」真值
function sidePose({ s, c = 0, lift = 0, rel = 0.95 }) {
  const ankleY = 0.95 - lift;
  const span = s * (1 - 0.15 * c); // 屈膝时肩−踝 变短
  const shoulderY = ankleY - span;
  const hipY = ankleY - span * 0.55;
  const kneeY = (hipY + ankleY) / 2;
  const wristY = ankleY - rel * s;
  return {
    12: [0.5, shoulderY], 14: [0.5, (shoulderY + wristY) / 2], 16: [0.5, wristY],
    24: [0.5, hipY], 26: [0.5, kneeY], 28: [0.5, ankleY],
  };
}

function buildFrames(n, poseAt) {
  const frames = [];
  for (let i = 0; i < n; i++) {
    const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0.9 }));
    const p = poseAt(i);
    for (const k of Object.keys(p)) lm[Number(k)] = { x: p[k][0], y: p[k][1], visibility: 0.9 };
    frames.push({ t: i / FPS, landmarks: lm, aspect: ASPECT });
  }
  return frames;
}

// 一次定点跳投的动作时间线：站直 → 下蹲 → 蹬伸起跳 → 出手 → 跟随
function actionPose(i, s) {
  let c = 0; // 下蹲量
  if (i >= 30 && i < 40) c = (i - 30) / 10;
  else if (i >= 40 && i < 46) c = 1;
  else if (i >= 46 && i < 54) c = 1 - (i - 46) / 8;
  // 腾空整体上移。幅度取真实跳投的量级：髋部相对站姿抬升约 0.2 个体高（0.6×0.2=0.12），
  // 才有资格被 JUMP_MIN（5%）判成「有起跳」。原先写 0.03 只有 3.7%，那是贴地量级，
  // v5.7 起出手高度区间按起跳自适应后，它会被归到「不起跳」那一档，测的就不是跳投了。
  const lift = i >= 46 ? Math.min(0.12, (i - 46) * 0.018) : 0;
  // 出手窗（54–60 帧）保持 rel = 1.15 不变，别的时段手臂在往上走
  const rel = i <= 44 ? 0.95 : i < 54 ? 0.95 + 0.2 * ((i - 44) / 10) : 1.15;
  return sidePose({ s, c, lift, rel });
}

const CYCLE = { releaseIdx: 57, crouchIdx: 40, standIdx: 10, apexIdx: 66, scene: "spot" };

// 取某帧的「踝−腕」垂直距离与站姿体高（复刻旧口径，用来对比新旧读数）
function rawGeometry(frames, cycle, sideName) {
  const s = sideName === "right"
    ? { shoulder: 12, wrist: 16, hip: 24, ankle: 28 }
    : { shoulder: 11, wrist: 15, hip: 23, ankle: 27 };
  const shoulder = smooth(fillGaps(pointsOf(frames, s.shoulder)));
  const ankle = smooth(fillGaps(pointsOf(frames, s.ankle)));
  const wrist = smooth(fillGaps(pointsOf(frames, s.wrist)));
  const hip = smooth(fillGaps(pointsOf(frames, s.hip)));
  const win = (i, half = 2) => {
    const out = [];
    for (let k = Math.max(0, i - half); k <= Math.min(frames.length - 1, i + half); k++) out.push(k);
    return out;
  };
  const standBodyH = median(win(cycle.standIdx).map((i) => Math.abs(shoulder[i].y - ankle[i].y)));
  const num = median(win(cycle.releaseIdx).map((i) => ankle[i].y - wrist[i].y));
  return { standBodyH, num, shoulder, ankle, wrist, hip, win };
}

console.log("— 体高尺度函数本身 —");
{
  const frames = buildFrames(N, (i) => actionPose(i, 0.6));
  const scale = bodyHeightScale(frames, "right");
  check("体高尺度取到站直时的肩−踝距离", Math.abs(scale - 0.6) < 1e-6, `scale=${scale}`);
  // 单帧异常（某帧踝点跳到画面顶部，肩−踝 变成 0.8）不应把尺度整体拉大
  const spiked = frames.map((f, i) =>
    i === 50 ? { ...f, landmarks: f.landmarks.map((l, k) => (k === 28 ? { ...l, y: 0.15 } : l)) } : f
  );
  const scaleSpiked = bodyHeightScale(spiked, "right");
  check("单帧异常不会拉大体高尺度（90 分位而非 max）",
    Math.abs(scaleSpiked - scale) < 1e-6 && scaleSpiked < 0.7, `scale=${scaleSpiked}`);
  const sh = smooth(fillGaps(pointsOf(frames, 12)));
  const an = smooth(fillGaps(pointsOf(frames, 28)));
  const rawMax = Math.max(...frames.map((f, i) => (i === 50 ? 0.8 : Math.abs(sh[i].y - an[i].y))));
  check("对照：max 口径会被单帧异常拉大", rawMax > 0.79, `max=${rawMax}`);
}

console.log("— 场景①：站姿帧屈膝（肩−踝 偏小）—");
{
  const base = buildFrames(N, (i) => actionPose(i, 0.6));
  // 站姿参考窗里取到屈膝没伸直的一帧：肩−踝 只有 0.51（站直时是 0.60）
  const bent = sidePose({ s: 0.6, c: 1 });
  const frames = base.map((f, i) =>
    i >= 5 && i <= 15
      ? { ...f, landmarks: f.landmarks.map((l, k) => (bent[k] ? { x: bent[k][0], y: bent[k][1], visibility: 0.9 } : l)) }
      : f
  );
  const g = rawGeometry(frames, CYCLE, "right");
  const oldReading = g.num / g.standBodyH; // 旧口径：分母取站姿帧
  const m = computeMetrics(frames, CYCLE, "right", "jump", "side", FPS);
  const rh = m.find((x) => x.id === "releaseHeight").num;
  check("站姿帧屈膝时旧口径读数被放大（超出区间上缘）", oldReading > HI,
    `old=${oldReading.toFixed(3)} 站姿体高=${g.standBodyH.toFixed(3)}`);
  check("改用视频级尺度后读数落回 1.05–1.30", rh >= LO && rh <= HI, `new=${rh.toFixed(3)}`);
  check("分母不再随站姿帧屈膝而偏小",
    Math.abs(bodyHeightScale(frames, "right") - 0.6) < 1e-6,
    `scale=${bodyHeightScale(frames, "right").toFixed(4)}`);

  // 其它指标的语义不动：起跳幅度仍用站姿帧基线（不是视频级尺度）
  const jumpMetric = m.find((x) => x.id === "jump");
  const jumpStandBased = median(g.win(CYCLE.releaseIdx).map((i) => (g.hip[CYCLE.standIdx].y - g.hip[i].y) / g.standBodyH));
  const jumpScaleBased = median(g.win(CYCLE.releaseIdx).map((i) => (g.hip[CYCLE.standIdx].y - g.hip[i].y) / bodyHeightScale(frames, "right")));
  check("起跳幅度仍按站姿帧基线计算（未被顺手改掉）",
    Math.abs(jumpMetric.num - jumpStandBased) < 1e-9 && Math.abs(jumpMetric.num - jumpScaleBased) > 1e-9,
    `jump=${jumpMetric.num} 站姿基线=${jumpStandBased} 视频级=${jumpScaleBased}`);
}

console.log("— 场景②：出手时朝镜头走近（尺度变大）—");
{
  // 身体尺度随时间从 0.40 长到 0.62（人朝镜头走近），出手帧的真实尺度就是 0.62
  const frames = buildFrames(N, (i) => actionPose(i, 0.4 + 0.22 * Math.min(1, i / 50)));
  const g = rawGeometry(frames, CYCLE, "right");
  const oldReading = g.num / g.standBodyH; // 旧口径：分母取站姿帧（那时人还小）
  const m = computeMetrics(frames, CYCLE, "right", "jump", "side", FPS);
  const rh = m.find((x) => x.id === "releaseHeight").num;
  check("走近镜头时旧口径读数被放大（超出区间上缘）", oldReading > HI,
    `old=${oldReading.toFixed(3)} 站姿体高=${g.standBodyH.toFixed(3)}`);
  check("改用视频级尺度后读数落回 1.05–1.30", rh >= LO && rh <= HI, `new=${rh.toFixed(3)}`);
  check("新读数明显小于旧读数", rh < oldReading - 0.1, `${rh.toFixed(3)} vs ${oldReading.toFixed(3)}`);
}

console.log("— 场景③：正常定点跳投 —");
{
  const frames = buildFrames(N, (i) => actionPose(i, 0.6));
  const m = computeMetrics(frames, CYCLE, "right", "jump", "side", FPS);
  const rh = m.find((x) => x.id === "releaseHeight");
  check("正常跳投读数落在 1.05–1.30", rh.num >= LO && rh.num <= HI, `num=${rh.num.toFixed(3)}`);
  check("读数接近真值 1.15", Math.abs(rh.num - 1.15) < 0.03, `num=${rh.num.toFixed(3)}`);
  check("单位与区间未被改动", rh.unit === "×身高" && rh.lo === LO && rh.hi === HI,
    `${rh.unit} ${rh.lo}–${rh.hi}`);
}

console.log("— 出手高度建议文案的类型自适应仍在 —");
{
  const frames = buildFrames(N, (i) => actionPose(i, 0.6));
  const m = computeMetrics(frames, CYCLE, "right", "jump", "side", FPS);
  const tipText = (num, type) => {
    const ms = m.map((x) => (x.id === "releaseHeight" ? { ...x, num, value: num.toFixed(2) } : x));
    return buildReport(ms, type).tips.find((t) => t.name === "出手高度")?.text ?? "";
  };
  check("罚球口径不说「跳投出手手高」", !/跳投/.test(tipText(1.55, "free")), tipText(1.55, "free"));
  check("跳投口径保留「跳投出手手高」", /跳投/.test(tipText(1.55, "jump")), tipText(1.55, "jump"));
  check("读数偏高时说的是偏高不是偏低", /高于/.test(tipText(1.55, "jump")) && !/低于/.test(tipText(1.55, "jump")),
    tipText(1.55, "jump"));
}

console.log(failures === 0 ? "\n🎉 全部通过" : `\n💥 ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
