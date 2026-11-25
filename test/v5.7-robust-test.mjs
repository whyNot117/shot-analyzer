// v5.7 回归测试：修 4 个在真实素材上查出来的缺陷
// ① 出手高度区间按「这一次出手有没有离地」自适应（含多次出手合并后的自洽）
// ② 关键点单帧跳变（MediaPipe 定位漂移）不再污染出手高度与速度类指标
// ③ 离线壳（Service Worker）补全所有 js 模块、缓存名升版、分层缓存策略
// ④ 版本号统一到 v5.7
// 运行：node test/v5.7-robust-test.mjs
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  computeMetrics, mergeCycles, repairJointOutliers, bodyHeightScale,
  RELEASE_HEIGHT_BAND_JUMP, RELEASE_HEIGHT_BAND_GROUND, JUMP_MIN,
} from "../js/metrics.js";
import { buildReport } from "../js/report.js";
import { smooth, fillGaps, pointsOf } from "../js/angles.js";
import { angleAt } from "../js/draw.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ASPECT = 1080 / 1920;
const FPS = 30;
const N = 96;

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

// 侧面合成骨架：s = 肩−踝距离，c = 下蹲量，lift = 腾空抬升，rel = (踝−腕)÷s
function sidePose({ s, c = 0, lift = 0, rel = 0.95 }) {
  const ankleY = 0.95 - lift;
  const span = s * (1 - 0.15 * c);
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

const CYCLE = { releaseIdx: 57, crouchIdx: 40, standIdx: 10, apexIdx: 66, scene: "spot" };

/**
 * 一次定点出手的动作时间线。
 * jumpAmp > 0 → 腾空（髋部相对站姿抬升 jumpAmp 个体高，真实跳投约 0.2）
 * relAtRelease → 出手帧的出手高度真值（踝→腕 ÷ 体高）
 */
function actionPose(i, { s, jumpAmp = 0, relAtRelease = 0.8, ramp = 6 }) {
  let c = 0;
  if (i >= 30 && i < 40) c = (i - 30) / 10;
  else if (i >= 40 && i < 46) c = 1;
  else if (i >= 46 && i < 54) c = 1 - (i - 46) / 8;
  // 腾空：46 帧蹬伸起，53 帧到顶
  const lift = jumpAmp > 0 && i >= 46 ? Math.min(jumpAmp, (i - 46) * (jumpAmp / 7)) : 0;
  // 手臂：51 帧开始上举，57 帧到出手高度，之后保持
  const rel = i < 51 ? 0.95 : Math.min(relAtRelease, 0.95 + (relAtRelease - 0.95) * ((i - 51) / ramp));
  return sidePose({ s, c, lift, rel });
}

const spotFrames = (opts) => buildFrames(N, (i) => actionPose(i, opts));

// 复刻 computeMetrics 里的出手垂直速度算法，但直接喂原始帧——用来演示「过滤前」的读数
function rawReleaseVel(frames, releaseIdx, fps = FPS) {
  const wrist = smooth(fillGaps(pointsOf(frames, 16)));
  const bodyScale = bodyHeightScale(frames, "right");
  const vals = [];
  for (let i = releaseIdx - 3; i <= releaseIdx + 2; i++) {
    const a = wrist[i - 2], b = wrist[i + 2];
    if (!a || !b || !Number.isFinite(a.y) || !Number.isFinite(b.y)) continue;
    vals.push(((a.y - b.y) * fps) / 4);
  }
  const pos = vals.filter((v) => v > 0);
  return { max: pos.length ? Math.max(...pos) / bodyScale : NaN, median: pos.length ? median(pos) / bodyScale : NaN };
}

console.log("— 缺陷一：出手高度区间按起跳与否自适应 —");
{
  // 不起跳的定点出手：出手点在肩高，踝→腕只有 0.80 个体高
  const frames = spotFrames({ s: 0.35, jumpAmp: 0, relAtRelease: 0.8 });
  const m = computeMetrics(frames, CYCLE, "right", "auto", "side", FPS);
  const rh = m.find((x) => x.id === "releaseHeight");
  const jump = m.find((x) => x.id === "jump");
  check("不起跳时读数落在 0.80 附近", Math.abs(rh.num - 0.8) < 0.02, `num=${rh.num.toFixed(3)}`);
  check("不起跳时判定区间是 0.75–1.00",
    rh.lo === RELEASE_HEIGHT_BAND_GROUND.lo && rh.hi === RELEASE_HEIGHT_BAND_GROUND.hi,
    `${rh.lo}–${rh.hi}`);
  check("区间文案同步更新", rh.rangeText === "0.75–1×身高", rh.rangeText);

  const report = buildReport(m, "auto");
  check("自动识别为罚球（贴地）", report.type === "free", report.type);
  const rhJudged = report.metrics.find((x) => x.id === "releaseHeight");
  check("定点罚球出手高度不判 bad", rhJudged.verdict === "good", rhJudged.verdict);
  check("报告里不出现出手高度建议", !report.tips.some((t) => t.name === "出手高度"),
    JSON.stringify(report.tips.map((t) => t.name)));

  // 起跳的定点出手：仍按跳投区间 1.05–1.30
  const jFrames = spotFrames({ s: 0.35, jumpAmp: 0.12, relAtRelease: 1.15 });
  const jm = computeMetrics(jFrames, CYCLE, "right", "auto", "side", FPS);
  const jrh = jm.find((x) => x.id === "releaseHeight");
  const jjump = jm.find((x) => x.id === "jump");
  check("起跳被识别（有起跳）", jjump.num > JUMP_MIN, `jump=${jjump.num.toFixed(3)}`);
  check("起跳时判定区间仍是 1.05–1.30",
    jrh.lo === RELEASE_HEIGHT_BAND_JUMP.lo && jrh.hi === RELEASE_HEIGHT_BAND_JUMP.hi,
    `${jrh.lo}–${jrh.hi}`);
  check("起跳时读数落在 1.05–1.30", jrh.num >= 1.05 && jrh.num <= 1.3, `num=${jrh.num.toFixed(3)}`);
  check("起跳时判定为 good", buildReport(jm, "auto").metrics.find((x) => x.id === "releaseHeight").verdict === "good");
}

console.log("— 缺陷一（续）：多次出手合并后，区间与合并后的起跳值自洽 —");
{
  const jumped = spotFrames({ s: 0.35, jumpAmp: 0.12, relAtRelease: 1.15 });
  const grounded = spotFrames({ s: 0.35, jumpAmp: 0, relAtRelease: 0.8 });
  const mJ = computeMetrics(jumped, CYCLE, "right", "auto", "side", FPS);
  const mG = computeMetrics(grounded, CYCLE, "right", "auto", "side", FPS);

  // 2 次起跳 + 1 次不起跳 → 合并后仍应算「有起跳」，区间必须是跳投区间
  const mergedA = mergeCycles([mJ, mJ, mG]);
  const aJump = mergedA.find((x) => x.id === "jump");
  const aRh = mergedA.find((x) => x.id === "releaseHeight");
  check("2 起跳 + 1 不起跳：合并后仍显示有起跳", aJump.num > JUMP_MIN, `jump=${aJump.num.toFixed(3)}`);
  check("2 起跳 + 1 不起跳：出手高度按跳投区间判（与合并后起跳值一致）",
    aRh.lo === RELEASE_HEIGHT_BAND_JUMP.lo && aRh.hi === RELEASE_HEIGHT_BAND_JUMP.hi,
    `${aRh.lo}–${aRh.hi} jump=${aJump.num.toFixed(3)}`);

  // 2 次不起跳 + 1 次起跳 → 合并后算「贴地」，区间必须跟着换成不起跳那一档
  const mergedB = mergeCycles([mG, mG, mJ]);
  const bJump = mergedB.find((x) => x.id === "jump");
  const bRh = mergedB.find((x) => x.id === "releaseHeight");
  check("2 不起跳 + 1 起跳：合并后显示基本贴地", bJump.num <= JUMP_MIN, `jump=${bJump.num.toFixed(3)}`);
  check("2 不起跳 + 1 起跳：出手高度按不起跳区间判（与合并后起跳值一致）",
    bRh.lo === RELEASE_HEIGHT_BAND_GROUND.lo && bRh.hi === RELEASE_HEIGHT_BAND_GROUND.hi,
    `${bRh.lo}–${bRh.hi} jump=${bJump.num.toFixed(3)}`);

  // 自洽性：报告里显示的起跳口径与出手高度用的区间必须来自同一个判定
  for (const [label, merged] of [["A", mergedA], ["B", mergedB]]) {
    const j = merged.find((x) => x.id === "jump").num;
    const rh = merged.find((x) => x.id === "releaseHeight");
    const expect = j > JUMP_MIN ? RELEASE_HEIGHT_BAND_JUMP.lo : RELEASE_HEIGHT_BAND_GROUND.lo;
    check(`合并 ${label}：区间与合并后起跳值口径一致`, rh.lo === expect, `lo=${rh.lo} jump=${j.toFixed(3)}`);
  }
}

console.log("— 缺陷二：关键点单帧跳变过滤 —");
{
  const clean = spotFrames({ s: 0.35, jumpAmp: 0.12, relAtRelease: 1.15 });
  const spikeFrame = CYCLE.releaseIdx;
  // MediaPipe 定位漂移时整条手臂会被带偏：腕部被甩走，肘部（肩→腕连线的中间点）跟着偏。
  const spike = (l, k) => {
    if (k === 16) return { ...l, y: l.y - 0.37 }; // 腕部：整条手臂里偏得最多
    if (k === 14) return { ...l, y: l.y - 0.185 }; // 肘部：肩→腕中点，约一半
    return l;
  };
  const spiked = clean.map((f, i) =>
    i === spikeFrame
      ? { ...f, landmarks: f.landmarks.map(spike) }
      : f
  );
  // 对照：原始关键点上的腕部单帧跳变量（归一化坐标）
  const jumpAmt = Math.abs(
    spiked[spikeFrame - 1].landmarks[16].y - spiked[spikeFrame].landmarks[16].y
  );
  check("构造的确实是 0.37 量级的单帧跳变", jumpAmt > 0.3, `jump=${jumpAmt.toFixed(3)}`);

  const cleanM = computeMetrics(clean, CYCLE, "right", "auto", "side", FPS);
  const spikeM = computeMetrics(spiked, CYCLE, "right", "auto", "side", FPS);
  const rhClean = cleanM.find((x) => x.id === "releaseHeight").num;
  const rhSpike = spikeM.find((x) => x.id === "releaseHeight").num;
  const before = rawReleaseVel(spiked, CYCLE.releaseIdx, FPS);

  // (a) 出手高度读数不被跳变带偏
  check("(a) 有跳变时的出手高度与干净序列一致（偏差 < 0.05）",
    Math.abs(rhSpike - rhClean) < 0.05, `clean=${rhClean.toFixed(3)} spiked=${rhSpike.toFixed(3)}`);
  // (b) 出手垂直速度落在物理可能范围内
  const rvSpike = spikeM.find((x) => x.id === "releaseVel").num;
  check("(b) 出手垂直速度 < 3×身高/s", rvSpike < 3, `releaseVel=${rvSpike.toFixed(3)}`);
  // 对照：不过滤时读数会被污染（复现真实素材里的 6.00×身高/s 那种假读数）
  check("对照：不过滤时的峰值速度远超物理上限（证明过滤有用）",
    before.max > 3, `rawMax=${before.max.toFixed(2)}`);
  // (c) 干净序列读数不变：过滤器对无失真帧是恒等的
  const repaired = repairJointOutliers(clean, "right");
  const identical = repaired.every((f, i) =>
    f.landmarks.every((l, k) =>
      Math.abs(l.x - clean[i].landmarks[k].x) < 1e-12 && Math.abs(l.y - clean[i].landmarks[k].y) < 1e-12
    )
  );
  check("(c) 干净序列一个关键点都没被改动", identical);
  const cleanM2 = computeMetrics(clean, CYCLE, "right", "auto", "side", FPS);
  const same = cleanM.every((x, i) => x.num === cleanM2[i].num);
  check("(c) 干净序列过滤前后读数完全一致", same);
  check("干净序列的出手高度读数仍是 1.15", Math.abs(rhClean - 1.15) < 0.02, `num=${rhClean.toFixed(3)}`);

  // 过滤确实定位到了失真帧（腕部）
  const fixed = repairJointOutliers(spiked, "right");
  const wristFixed = fixed[spikeFrame].landmarks[16].y;
  const wristSpiked = spiked[spikeFrame].landmarks[16].y;
  check("失真帧的腕部被修补回轨迹上", Math.abs(wristFixed - wristSpiked) > 0.2,
    `${wristSpiked.toFixed(3)} → ${wristFixed.toFixed(3)}`);

  // 漂移会沿关节链连坐：腕部被甩走时肘部也偏离了自己的轨迹，
  // 只修腕部会留下一个被污染的肘角（出手伸肘速度这类计分指标会被带偏）
  const elbowFixed = fixed[spikeFrame].landmarks[14].y;
  const elbowSpiked = spiked[spikeFrame].landmarks[14].y;
  check("同帧的肘部也一并修补（关节链连坐）", Math.abs(elbowFixed - elbowSpiked) > 0.1,
    `${elbowSpiked.toFixed(3)} → ${elbowFixed.toFixed(3)}`);
  const ang = (f) => {
    const sh = f.landmarks[12], el = f.landmarks[14], wr = f.landmarks[16];
    return angleAt({ x: sh.x * ASPECT, y: sh.y }, { x: el.x * ASPECT, y: el.y }, { x: wr.x * ASPECT, y: wr.y });
  };
  const angClean = ang(clean[spikeFrame]);
  const angFixed = ang(fixed[spikeFrame]);
  check("修补后该帧的肘角与干净序列一致", Math.abs(angFixed - angClean) < 2,
    `${angClean.toFixed(1)}° vs ${angFixed.toFixed(1)}°`);
}

console.log("— 缺陷三：离线壳与缓存策略 —");
{
  const sw = readFileSync(join(ROOT, "sw.js"), "utf8");
  check("缓存名升到 v5.9", sw.includes('"shot-analyzer-v5.9"'), sw.match(/shot-analyzer-v[\d.]+/)?.[0]);
  check("不再残留 v5.4 缓存名", !sw.includes("shot-analyzer-v5.4"));
  const jsFiles = readdirSync(join(ROOT, "js")).filter((f) => f.endsWith(".js"));
  const missing = jsFiles.filter((f) => !sw.includes(`./js/${f}`));
  check(`APP_SHELL 覆盖全部 ${jsFiles.length} 个 js 模块`, missing.length === 0, `缺：${missing.join(", ")}`);
  check("旧缓存清理逻辑仍在（activate）", sw.includes("activate") && sw.includes("caches.delete"));
  check("模型与 WASM 仍是 cache-first", sw.includes("/model/") && sw.includes("/vendor/") && sw.includes("ignoreSearch"));
  check("应用外壳走 stale-while-revalidate（先给旧版、后台更新）",
    sw.includes("fresh") && sw.includes("return hit"), "");
}

console.log("— 缺陷四：版本号 —");
{
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  const app = readFileSync(join(ROOT, "js/app.js"), "utf8");
  check("index.html 徽章是 v5.9", /·\s*v5\.9/.test(html), html.match(/·\s*v[\d.]+/)?.[0]);
  check("app.js 横幅是 v5.9", /代码版本 v5\.9/.test(app), app.match(/代码版本 v[\d.]+/)?.[0]);
  check("两处都不再残留旧版本号", !/v5\.5|v5\.7/.test(html) && !/v5\.5|v5\.7/.test(app));
}

console.log(failures === 0 ? "\n🎉 全部通过" : `\n💥 ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
