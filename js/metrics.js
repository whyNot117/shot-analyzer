// 投篮周期检测与生物力学指标计算（纯函数，输入为逐帧关键点序列）
// 坐标系：归一化 0–1，y 向下为正（数值越小 = 位置越高）
// 多次出手：detectAllCycles 逐次录取、mergeCycles 逐指标取中位数，报告因此更稳也更准
import { SIDE, angleAt } from "./draw.js";

// ---------- 时序工具 ----------

function smoothNums(s, win = 3) {
  const half = win >> 1;
  const out = [];
  for (let i = 0; i < s.length; i++) {
    let sum = 0, n = 0;
    for (let k = i - half; k <= i + half; k++) if (k >= 0 && k < s.length) { sum += s[k]; n++; }
    out.push(sum / (n || 1));
  }
  return out;
}

// 点序列（{x,y}）与数值序列通用：分别平滑
function smooth(series, win = 3) {
  if (series.length && typeof series[0] === "number") return smoothNums(series, win);
  // 某关键点全程缺失时以 0 占位，避免崩溃（对应指标会被 isFinite 过滤掉）
  const xs = smoothNums(series.map((p) => p?.x ?? 0), win);
  const ys = smoothNums(series.map((p) => p?.y ?? 0), win);
  return series.map((_, i) => ({ x: xs[i], y: ys[i] }));
}

const clone = (v) => (typeof v === "number" ? v : { ...v });
function mix(a, b, r) {
  if (typeof a === "number") return a * (1 - r) + b * r;
  return { x: a.x * (1 - r) + b.x * r, y: a.y * (1 - r) + b.y * r };
}

// 用前后邻值线性插值填补空帧（未识别到人的帧）
function fillGaps(series) {
  const out = [...series];
  let last = null;
  for (let i = 0; i < out.length; i++) {
    if (out[i] != null) { last = i; continue; }
    let next = null;
    for (let j = i + 1; j < out.length; j++) if (out[j] != null) { next = j; break; }
    if (last == null && next == null) continue;
    if (last == null) { out[i] = clone(out[next]); continue; }
    if (next == null) { out[i] = clone(out[last]); continue; }
    out[i] = mix(out[last], out[next], (i - last) / (next - last));
  }
  return out;
}

function pointsOf(frames, idx) {
  const aspect = frames[0]?.aspect ?? 1; // 归一化坐标 x 乘宽高比才是真实几何（scanInto 逐帧记录）
  return frames.map((f) => {
    const l = f.landmarks?.[idx];
    return l ? { x: l.x * aspect, y: l.y } : null;
  });
}

// 逐帧计算某关节角（a-b-c，b 为顶点），返回角度数组（度）
function angleSeries(frames, a, b, c) {
  const A = smooth(fillGaps(pointsOf(frames, a)));
  const B = smooth(fillGaps(pointsOf(frames, b)));
  const C = smooth(fillGaps(pointsOf(frames, c)));
  return fillGaps(B.map((_, i) => angleAt(A[i], B[i], C[i])));
}

// ---------- 投篮周期检测 ----------

export const JUMP_MIN = 0.05; // 起跳判定阈值：髋部相对站姿抬升超过身高 5% 视为起跳

function median(arr) {
  const a = arr.filter((x) => x != null && isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

// 关键帧邻域中位数：单帧读数对关键点抖动敏感，取 ±half 帧的中位数稳健得多。
// 只适合单调/缓变段——极值点（谷底/峰顶）取中位数会被推离极值，应用 refineExtremum
function windowMedian(series, i, half = 2) {
  return median(series.slice(Math.max(0, i - half), i + half + 1));
}

// 极值点亚帧细化：过 (i-1, i, i+1) 三点的抛物线顶点值（谷底/峰顶通用），亚帧精度且无中位数偏置
function refineExtremum(series, i) {
  const a = series[i - 1], b = series[i], c = series[i + 1];
  if (![a, b, c].every((x) => isFinite(x))) return b;
  const den = a + c - 2 * b; // 谷底为正、峰顶为负
  if (Math.abs(den) < 1e-9) return b;
  return b - ((c - a) ** 2) / (8 * den);
}

// 3 点中位数滤波：压制单帧毛刺，max/范围型统计先过滤再取窗口
function median3(s) {
  return s.map((_, i) => {
    const w = [s[i - 1], s[i], s[i + 1]].filter((x) => x != null && isFinite(x));
    return w.length ? median(w) : NaN;
  });
}

// ---------- 角速度与发力时序（v5.5 新增） ----------

// 关节角速度序列（度/秒）：中心差分后做 3 点中位数滤波，压住单帧毛刺
function angularSpeed(series, fps) {
  const v = series.map((val, i) => {
    const a = series[i - 1], b = series[i + 1];
    if (!isFinite(a) || !isFinite(b)) return NaN;
    return ((b - a) * fps) / 2;
  });
  return median3(v);
}

/**
 * 发力启动帧：在 [from,to] 窗口内找角速度峰值，再从峰值往前回溯到峰值的 frac 处，
 * 即「这一次主要发力是从哪一帧开始的」。找不到有效峰值返回 null。
 */
function onsetFrame(vel, from, to, frac = 0.25) {
  let peak = -Infinity, peakIdx = -1;
  for (let i = Math.max(0, from); i <= Math.min(vel.length - 1, to); i++) {
    const v = vel[i];
    if (!isFinite(v)) continue;
    if (v > peak) { peak = v; peakIdx = i; }
  }
  if (peakIdx < 0 || !(peak > 1e-6)) return null;
  const th = peak * frac;
  for (let i = peakIdx; i >= Math.max(0, from); i--) {
    const v = vel[i];
    if (isFinite(v) && v >= th) return i;
  }
  return Math.max(0, from);
}

// 指标的显示值：角度取整、角速度取整、时差取整毫秒，其余两位小数
export function formatMetricValue(id, num, unit) {
  if (id === "jump") return num > JUMP_MIN ? "有起跳" : "基本贴地";
  if (unit === "°" || unit === "°/s" || unit === "ms" || unit === "s") return `${Math.round(num)}${unit}`;
  return num.toFixed(2);
}

/**
 * 检测视频中的全部出手周期（一段视频练多球时逐次录取，报告取中位数）。
 * 出手帧候选：手腕高于肩部、向上速度明显且为 ±3 帧内局部极大的帧；
 * 相邻录取间隔 ≥1 秒，速度不足最强出手 1/4 的视为抖动忽略。
 * 每周期再过有效门：有真实下蹲（≥8°）、腕顶点明显高于肩、窗口关键点可见、
 * 举球点高度与最强出手一致——挥手/走位举臂等假周期进不了中位数。
 * 站姿帧取「上一球顶点 0.3 秒后 ~ 本次下蹲前」最直的一帧，不伸进上一球的滞空段。
 * 返回按时间排序的周期数组（可能为空），confidence 为全片有效帧占比。
 */
export function detectAllCycles(frames, sideName, fps = 30) {
  const s = SIDE[sideName];
  const hasLm = (i) => !!frames[i]?.landmarks; // 该帧是否真有骨架（空档帧为 false）
  const valid = frames.filter((f) => f.landmarks).length;
  if (valid < fps * 0.8) return []; // 有效帧不足 0.8 秒

  const wrist = smooth(fillGaps(pointsOf(frames, s.wrist)));
  const shoulder = smooth(fillGaps(pointsOf(frames, s.shoulder)));
  const ankle = smooth(fillGaps(pointsOf(frames, s.ankle)));
  const knee = angleSeries(frames, s.hip, s.knee, s.ankle);
  const n = frames.length;

  const cand = [];
  for (let i = 2; i < n - 2; i++) {
    // 出手候选必须有真实骨架支撑：人物离场/被遮挡的长空档里，fillGaps 会把空档插值成
    // 线性斜坡，而斜坡上每帧都满足「±3 帧局部极大」——整段空档都会变成假出手候选。
    if (!hasLm(i)) continue;
    let ok = 0;
    for (let k = Math.max(0, i - 3); k <= Math.min(n - 1, i + 3); k++) if (hasLm(k)) ok++;
    if (ok < 3) continue; // 前后缺少真实帧支撑（空档边缘的插值伪峰）
    if (wrist[i].y >= shoulder[i].y) continue; // 只在腕高于肩的区间找出手机会
    const v = wrist[i - 1].y - wrist[i + 1].y; // 中心差分，向上为正
    if (v > 0.006) cand.push({ i, v }); // 低于噪声的缓慢移动不算
  }
  // ±3 帧内的局部极大才算候选峰值，避免同一次出手反复入选
  const peaks = cand.filter((c) => {
    let mx = 0;
    for (const d of cand) if (Math.abs(d.i - c.i) <= 3 && d.v > mx) mx = d.v;
    return c.v >= mx;
  });
  peaks.sort((a, b) => b.v - a.v);
  const accepted = [];
  for (const p of peaks) {
    if (accepted.every((q) => Math.abs(q.i - p.i) >= fps)) accepted.push(p); // 相邻出手间隔 ≥1 秒
  }
  if (!accepted.length) return [];
  const vMax = Math.max(...accepted.map((p) => p.v));
  accepted.sort((a, b) => a.i - b.i);

  // 速度不足最强出手 1/4 的峰值视为抖动
  const strong = accepted.filter((p) => p.v >= vMax * 0.25).sort((a, b) => a.i - b.i);
  const around = (i) => {
    const a = [];
    for (let k = Math.max(0, i - 2); k <= Math.min(n - 1, i + 2); k++) a.push(k);
    return a;
  };
  const built = [];
  let prevApex = -1; // 上一录取周期的腕部顶点帧
  let rejected = 0; // 因人物缺失而无法完整测量的出手数（对用户披露，不静默吞掉）
  let rejectNote = "";
  for (const { i: releaseIdx, v } of strong) {
    // 下蹲最深处：出手前 1.5 秒内膝角最小的帧（只取有真实骨架的帧——插值帧不能当基线）
    const from = Math.max(0, releaseIdx - Math.round(fps * 1.5));
    let crouchIdx = -1;
    let crouchValid = 0;
    for (let i = from; i < releaseIdx; i++) {
      if (!hasLm(i)) continue;
      crouchValid++;
      if (crouchIdx < 0 || knee[i] < knee[crouchIdx]) crouchIdx = i;
    }
    // 窗口里人物缺失过多 → 这次出手的屈腿过程没拍到，无法测量：计入「未计入」并说明原因。
    // 混合门：绝对下限 8 帧 + 比例 15%——长窗口跨过离场空档时纯比例门会把
    // 「空档前站着、空档后出手」的正常球误拒（首帧前的站姿帧是真实可信的基线）
    if (crouchIdx < 0 || crouchValid < Math.max(8, (releaseIdx - from) * 0.15)) {
      rejected++;
      rejectNote = rejectNote || "起跳前的下蹲过程大部分不在画面里";
      continue;
    }
    // 站姿参考帧：上一球顶点 0.3 秒后（首球从片头）~ 本次下蹲前，站得最直（膝角最大）的帧。
    // 窗口不伸进上一球的滞空/跟随段——否则归一化基线被上一球抬高，多球读数漂移。
    // 离场期间别人的骨架（体型与窗口主流不符）不能当基线——体高分母一旦被替身污染，
    // 举球点一致性门会把这球静默丢掉；先按窗口体高中位数筛掉异己骨架，再选最直帧
    const sFrom = prevApex < 0 ? 0 : Math.min(crouchIdx, prevApex + Math.round(fps * 0.3));
    const hAt = (i) => Math.abs(shoulder[i].y - ankle[i].y);
    const hs = [];
    for (let i = sFrom; i <= crouchIdx; i++) if (hasLm(i)) hs.push(hAt(i));
    const hMed = hs.length ? median(hs) : 0;
    const ownBody = (i) => hMed <= 0 || (hAt(i) >= hMed * 0.7 && hAt(i) <= hMed * 1.3);
    let standIdx = -1;
    let standValid = 0;
    for (let i = sFrom; i <= crouchIdx; i++) {
      if (!hasLm(i)) continue;
      standValid++;
      if (!ownBody(i)) continue; // 深蹲帧也不参与竞选（本就不该当站姿基线）
      if (standIdx < 0 || knee[i] > knee[standIdx]) standIdx = i;
    }
    if (standIdx < 0) { // 全窗口体型高度混杂（极少见）：退回不加筛的最直帧
      for (let i = sFrom; i <= crouchIdx; i++)
        if (hasLm(i) && (standIdx < 0 || knee[i] > knee[standIdx])) standIdx = i;
    }
    // 没有真实站姿帧就没有可信基线（体高归一化的分母），该次出手无法测量——计为「未计入」而非默默算错
    if (standIdx < 0 || standValid < Math.max(8, (crouchIdx - sFrom + 1) * 0.15)) {
      rejected++;
      rejectNote = rejectNote || "站直的基准姿势大部分不在画面里";
      continue;
    }
    // 跟随动作顶点：出手后 0.8 秒内手腕最高点
    const to = Math.min(n - 1, releaseIdx + Math.round(fps * 0.8));
    let apexIdx = releaseIdx;
    for (let i = releaseIdx; i <= to; i++) {
      if (!hasLm(i)) continue;
      if (wrist[i].y < wrist[apexIdx].y) apexIdx = i;
    }

    // 逐周期有效性特征（门限见下方过滤）
    // 体高基线只取有真实骨架的邻帧——插值帧会把体高算成两帧姿态的平均值
    const bodyH = median(around(standIdx).filter(hasLm).map((i) => Math.abs(shoulder[i].y - ankle[i].y))) || 1e-6;
    const crouchDepth = (knee[standIdx] ?? 0) - (knee[crouchIdx] ?? 0); // 站姿→下蹲的屈腿幅度
    const apexRise = (shoulder[releaseIdx].y - wrist[apexIdx].y) / bodyH; // 腕顶点高于肩的距离
    const setH = (shoulder[releaseIdx].y - wrist[releaseIdx].y) / bodyH; // 举球点高度
    let visSum = 0, visN = 0;
    // 可见度窗口覆盖「站姿基线 → 跟随顶点」整段：基线缺失时指标不可信，不能只测后半段
    for (let i = standIdx; i <= apexIdx && i < n; i++) {
      for (const idx of [s.shoulder, s.elbow, s.wrist, s.hip, s.knee, s.ankle]) {
        visSum += frames[i]?.landmarks?.[idx]?.visibility ?? 0;
        visN++;
      }
    }
    built.push({ releaseIdx, crouchIdx, standIdx, apexIdx, v, setH, crouchDepth, apexRise, vis: visSum / (visN || 1) });
    prevApex = apexIdx;
  }
  // 有效性门：假周期（挥手、走位举臂、遮挡毛刺）没有下蹲、顶点不够高或举球点明显不同，
  // 进不了中位数——真出手间隔 2 秒以上时第二球不会因此被误删（阈值取宽松筛查值）
  const best = built.find((c) => c.v >= vMax);
  const kept = built
    .filter(
      (c) =>
        c.crouchDepth >= 8 &&
        c.apexRise >= 0.15 &&
        c.vis >= 0.4 &&
        !(best && Math.abs(c.setH - best.setH) > 0.15)
    )
    .map(({ releaseIdx, crouchIdx, standIdx, apexIdx }) => ({
      releaseIdx, crouchIdx, standIdx, apexIdx, confidence: valid / n,
    }));
  // 未计入的出手（人物不在画面/基线缺失）随数组一起带出，由界面披露——不静默吞球
  kept.rejected = rejected;
  kept.rejectNote = rejectNote;
  kept.rejectedByGate = built.length - kept.length;
  return kept;
}

/**
 * 周期检测：优先 preferredSide，检不出时自动换另一侧再试。
 * 正面机位下 pickSide 可能选中非出手臂（双臂可见度接近），其手腕全程不过肩会导致漏检。
 * 返回 { cycles, side }——cycles 按时间排序（可能为空数组），side 为实际检出所用的侧。
 */
export function detectShotCycles(frames, preferredSide, fps = 30) {
  let cycles = detectAllCycles(frames, preferredSide, fps);
  if (cycles.length) return { cycles, side: preferredSide };
  const other = preferredSide === "right" ? "left" : "right";
  cycles = detectAllCycles(frames, other, fps);
  return { cycles, side: cycles.length ? other : preferredSide };
}

/**
 * 多次出手融合：逐指标取各周期读数的中位数——比单次出手更接近真实水平，
 * 也消除「同一段视频两次分析选中不同出手」造成的评分漂移。
 */
export function mergeCycles(cyclesMetrics) {
  const list = cyclesMetrics.filter(Boolean);
  if (!list.length) return [];
  if (list.length === 1) return list[0];
  const out = [];
  for (const id of Object.keys(METRIC_VIEWS)) {
    const per = list.map((m) => m.find((x) => x.id === id)).filter(Boolean);
    if (!per.length) continue;
    const num = median(per.map((x) => x.num));
    if (!isFinite(num)) continue;
    const first = per[0];
    out.push({
      ...first, // 区间/权重/容差带/verdictOverride 等口径各周期一致，取第一个即可
      num,
      value: formatMetricValue(id, num, first.unit),
    });
  }
  return out; // 已按 METRIC_VIEWS 固定顺序
}

// ---------- 指标计算 ----------

// 指标展示名（融合报告「仍未覆盖」清单用）
export const METRIC_NAMES = {
  kneeCrouch: "下蹲膝角", elbowSet: "举球肘角", elbowRelease: "出手肘伸展",
  releaseAngle: "出手方向角", releaseHeight: "出手高度", followThrough: "跟随动作伸展",
  trunkLean: "躯干倾斜", headDrift: "头部晃动", balance: "重心横移", jump: "起跳幅度",
  elbowAbduction: "肘内外展", stanceWidth: "双脚站距", lateralBalance: "左右重心偏移",
  elbowSpeed: "出手伸肘速度", legArmDelay: "腿臂分离时差", legSeq: "下肢发力顺序差",
};

// 每项指标在哪些机位下测得可靠（融合报告按此挑来源；oblique 视为两向近似可用）
export const METRIC_VIEWS = {
  kneeCrouch: ["side"], elbowSet: ["side"], elbowRelease: ["side"],
  releaseAngle: ["side"], releaseHeight: ["side", "front"],
  followThrough: ["side"], trunkLean: ["side"], headDrift: ["side"],
  balance: ["side"], jump: ["side", "front"],
  elbowAbduction: ["front"], stanceWidth: ["front"], lateralBalance: ["front"],
  // 伸肘速度是纯角度量，正面机位同样可测；发力链时序依赖矢状面内的关节顺序，只在侧面类可信
  elbowSpeed: ["side", "front"], legArmDelay: ["side"], legSeq: ["side"],
};

// 趋势参考型指标：运动学上可测但缺少专项文献阈值，不计分，靠训练档案的历史趋势看变化
export const TREND_ONLY = new Set(["legArmDelay", "legSeq", "lateralBalance"]);

// 越小越好的指标：训练档案的「较上次」对比按数值增减方向判断好坏会判反，
// 这类指标（头部晃动、重心横移、腿臂分离时差）差值方向与好坏方向相反
export const LOWER_IS_BETTER = new Set(["headDrift", "balance", "legArmDelay"]);

/**
 * 计算单次出手的投篮姿态指标。type: "jump" | "free" | "three"；view: "side" | "front" | "oblique" | "unknown"。
 * 矢状面指标（膝角/出手角等）只在侧面类机位下计算；正面指标（肘内外展/站距/左右重心）只在正面类机位下计算；
 * 出手高度与起跳为纯垂直量，两种机位都有效。关键帧读数按类型取稳健估计：极值点（下蹲/举球/跟随）
 * 用三点抛物线顶点细化，缓变段用邻域中位数——极值点取中位数会被推离谷底（已实测回归）；
 * 多次出手请对各周期的结果调用 mergeCycles 取中位数。
 * 返回指标数组，每项含 { id, name, num, unit, lo, hi, weight, rangeText, value }。
 */
export function computeMetrics(frames, cycle, sideName, type = "jump", view = "side", fps = 30) {
  const s = SIDE[sideName];
  const { releaseIdx, crouchIdx, standIdx, apexIdx } = cycle;
  const aspect = frames[0]?.aspect ?? 1; // 单帧取点时的宽高比校正（序列取点由 pointsOf 处理）
  const sagittal = view !== "front"; // side / oblique / unknown 都按侧面类近似
  const frontal = view === "front" || view === "oblique";
  const n = frames.length;
  const winIdx = (i, half = 2) => {
    const out = [];
    for (let k = Math.max(0, i - half); k <= Math.min(n - 1, i + half); k++) out.push(k);
    return out;
  };

  const wrist = smooth(fillGaps(pointsOf(frames, s.wrist)));
  const shoulder = smooth(fillGaps(pointsOf(frames, s.shoulder)));
  const hip = smooth(fillGaps(pointsOf(frames, s.hip)));
  const ankle = smooth(fillGaps(pointsOf(frames, s.ankle)));
  const knee = angleSeries(frames, s.hip, s.knee, s.ankle);
  const elbow = angleSeries(frames, s.shoulder, s.elbow, s.wrist);

  // 站姿体高（肩到踝）：站姿帧邻域中位数，作为所有归一化的分母
  const bodyH = median(winIdx(standIdx).map((i) => Math.abs(shoulder[i].y - ankle[i].y))) || 1e-6;

  // 出手高度：出手时腕高于踝的距离 / 站姿体高（纯垂直量，各机位有效，邻域中位数）
  const releaseHeight = median(winIdx(releaseIdx).map((i) => (ankle[i].y - wrist[i].y) / bodyH));

  // 起跳幅度：出手时髋部相对站姿的抬升（纯垂直量，各机位有效，邻域中位数）
  const jumpRise = median(winIdx(releaseIdx).map((i) => (hip[standIdx].y - hip[i].y) / bodyH));

  // 举球点（set point）：下蹲到出手之间肘角最小的帧（正面机位下投影角也能定位举球时刻）
  let setIdx = crouchIdx;
  for (let i = crouchIdx; i < releaseIdx; i++) if (elbow[i] < elbow[setIdx]) setIdx = i;

  const M = [];
  const add = (id, name, num, unit, lo, hi, weight, opts) => {
    if (num == null || !isFinite(num)) return; // 个别指标缺失不影响整体
    M.push({
      id, name, num, unit, lo, hi, weight,
      rangeText: unit === "°" ? `${Math.round(lo)}–${Math.round(hi)}°` : `${lo}–${hi}${unit}`,
      value: formatMetricValue(id, num, unit),
      ...opts, // 可覆盖 rangeText 等，或附 warnLo/warnHi（不对称容差带）、verdictOverride（如 info）
    });
  };

  if (sagittal) {
    const nose = smooth(fillGaps(pointsOf(frames, 0)));

    // 出手方向角：出手前后 2 帧的手腕速度与水平的夹角（90° = 垂直向上，矢状面内）；
    // 对出手帧 ±2 邻域逐帧求角再取中位数，单帧速度读数抖动大
    const velAngle = [];
    for (let i = 2; i <= n - 3; i++) {
      const vy = wrist[i - 2].y - wrist[i + 2].y; // 向上为正
      const vx = Math.abs(wrist[i + 2].x - wrist[i - 2].x);
      velAngle[i] = (Math.atan2(vy, vx || 1e-6) * 180) / Math.PI;
    }
    const releaseAngle = median(winIdx(releaseIdx).map((i) => velAngle[i]).filter((x) => x != null));

    // 躯干倾斜：出手瞬间肩-髋连线偏离竖直的角度（邻域中位数）
    const trunkLean = median(
      winIdx(releaseIdx).map(
        (i) =>
          Math.abs(
            (Math.atan2(
              Math.abs(shoulder[i].x - hip[i].x),
              Math.abs(hip[i].y - shoulder[i].y) || 1e-6
            ) * 180) / Math.PI
          )
      )
    );

    // 头部水平晃动（站姿到跟随顶点的整体范围；先 3 点中位数滤波压制单帧毛刺）
    const noseX = median3(nose.map((p) => p.x));
    let noseMinX = Infinity, noseMaxX = -Infinity;
    for (let i = standIdx; i <= apexIdx; i++) {
      if (!isFinite(noseX[i])) continue;
      noseMinX = Math.min(noseMinX, noseX[i]);
      noseMaxX = Math.max(noseMaxX, noseX[i]);
    }
    const headDrift = (noseMaxX - noseMinX) / bodyH;

    // 重心横移：出手瞬间髋部相对站姿的水平位移（邻域中位数）
    const hipDrift = median(winIdx(releaseIdx).map((i) => Math.abs(hip[i].x - hip[standIdx].x))) / bodyH;

    // 极值型指标：定位帧 + 抛物线顶点细化（邻域中位数会系统性推离极值）
    // good 带按文献校准（2026-10-29，桌面投篮资料库）：熟练罚球命中球准备期膝屈 99.5°±8.4
    // （Cabarkapa 系列），教学共识 90–100°，三分熟练组下蹲更深；上限放到 120 容纳浅蹲型个体
    add("kneeCrouch", "下蹲膝角", refineExtremum(knee, crouchIdx), "°", 90, 120, 2, { frame: crouchIdx });
    add("elbowSet", "举球肘角", refineExtremum(elbow, setIdx), "°", 75, 105, 2, { frame: setIdx });
    // 出手肘伸展在陡坡上：±1 中位数够稳，±2 会被曲率拉低
    add("elbowRelease", "出手肘伸展", windowMedian(elbow, releaseIdx, 1), "°", 150, 185, 1.5, { frame: releaseIdx });
    add("releaseAngle", "出手方向角", releaseAngle, "°", 45, 58, 2, { frame: releaseIdx });
    // 跟随动作：腕顶点 ±3 帧内找肘角最大帧再细化（腕顶点未必是肘最伸直的瞬间）
    let fIdx = apexIdx;
    for (let i = Math.max(0, apexIdx - 3); i <= Math.min(n - 1, apexIdx + 3); i++) if (elbow[i] > elbow[fIdx]) fIdx = i;
    add("followThrough", "跟随动作伸展", refineExtremum(elbow, fIdx), "°", 160, 190, 1.5, { frame: fIdx });
    // 权重高于常规指标：躯干前倾是实测中区分熟练度效应量最大的参数（d=0.880，大于出手高度 d=0.438）
    add("trunkLean", "躯干倾斜", trunkLean, "°", 0, 12, 2, { frame: releaseIdx });
    add("headDrift", "头部晃动", headDrift, "×身高", 0, 0.15, 1, { frame: releaseIdx });
    add("balance", "重心横移", hipDrift, "×身高", 0, 0.12, 1, { frame: releaseIdx });
  }

  // 出手伸肘速度（°/s）：出手时刻肘关节的角速度。
  // 文献锚点：高水平球员随距离 2.8→6.4 m，肘角速度 539→742°/s——「匀速推」是远投失败模式
  // （docs/投篮理解.md 4️⃣：不要持续向上推球，需要更快速度的伸肘）。
  // 2D 投影只能测到矢状面内的角度变化率，读数可能低于三维真值，故下限放宽到 300。
  const elbowSpeed = (() => {
    const vals = [];
    for (let i = releaseIdx - 3; i <= releaseIdx + 2; i++) {
      const a = elbow[i - 2], b = elbow[i + 2];
      if (!isFinite(a) || !isFinite(b)) continue;
      vals.push(((b - a) * fps) / 4); // ±2 帧跨度：单帧差分噪声大，跨度再大又会拉低峰值
    }
    const pos = vals.filter((v) => v > 0);
    return pos.length ? Math.max(...pos) : NaN;
  })();
  add("elbowSpeed", "出手伸肘速度", elbowSpeed, "°/s", 450, 900, 1.5, {
    frame: releaseIdx, warnLo: 300, warnHi: 1100,
  });

  // 发力链时序（趋势参考）：下肢蹬伸与上肢伸出的先后关系。
  // 测法：膝/髋/肘角速度的峰值往前回溯到 25% 处，取该次主要发力的启动帧，再换算成时间差。
  if (sagittal) {
    const hipAngle = angleSeries(frames, s.shoulder, s.hip, s.knee);
    const tKnee = onsetFrame(angularSpeed(knee, fps), crouchIdx, releaseIdx);
    const tHip = onsetFrame(angularSpeed(hipAngle, fps), crouchIdx, releaseIdx);
    const tElbow = onsetFrame(angularSpeed(elbow, fps), setIdx, releaseIdx);
    const gapMs = (a, b) => (a == null || b == null ? NaN : ((a - b) * 1000) / fps);
    // 腿臂分离时差：髋开始伸展 → 肘开始伸出的间隔。正值 = 下肢先动、上肢后动（正确的自下而上发力链）
    add("legArmDelay", "腿臂分离时差", gapMs(tElbow, tHip), "ms", 0, 9999, 1, {
      verdictOverride: "info", screeningOnly: true,
      rangeText: "正值 = 下肢领先上肢（趋势参考）",
      frame: releaseIdx,
    });
    // 下肢发力顺序差：膝开始伸展 → 髋开始伸展的间隔。正值 = 膝先蹬，符合踝→膝→髋的自下而上顺序
    add("legSeq", "下肢发力顺序差", gapMs(tHip, tKnee), "ms", 0, 9999, 1, {
      verdictOverride: "info", screeningOnly: true,
      rangeText: "正值 = 膝先于髋启动（趋势参考）",
      frame: releaseIdx,
    });
  }

  // 文献校准：移动投篮实测出手手高为身高的 112.8%–118.9%（跳投类）；下限 0.95 过松会放过贴肩出手
  add("releaseHeight", "出手高度", releaseHeight, "×身高", 1.05, 1.3, 1, { frame: releaseIdx, warnLo: 0.95 });

  if (frontal) {
    // 单帧取点（含宽高比校正），关键点缺失则跳过对应帧
    const lm = (i, idx) => {
      const l = frames[i]?.landmarks?.[idx];
      return l ? { x: l.x * aspect, y: l.y } : null;
    };

    // 肘内外展：举球点肘部偏离「肩→腕」连线的角度（正面视角，0° = 肘在肩腕线上不外展），
    // 举球点邻域逐帧求角后取中位数。
    // good 上限 15°：锚定 Cabarkapa 2021 熟练组前臂外展均值 7.9°+1SD；20° 会把非熟练组均值(19.8°)判为达标
    const abd = [];
    for (const i of winIdx(setIdx)) {
      const sh = lm(i, s.shoulder), el = lm(i, s.elbow), wr = lm(i, s.wrist);
      if (!sh || !el || !wr) continue;
      const ax = wr.x - sh.x, ay = wr.y - sh.y;
      const bx = el.x - sh.x, by = el.y - sh.y;
      const len = Math.hypot(ax, ay) || 1e-6;
      const perp = Math.abs(ax * by - ay * bx) / len; // 肘到肩腕线的垂距
      const along = (ax * bx + ay * by) / len;
      abd.push((Math.atan2(perp, Math.abs(along)) * 180) / Math.PI);
    }
    if (abd.length) {
      add("elbowAbduction", "肘内外展", median(abd), "°", 0, 15, 2, {
        warnHi: 25, // 文献建议的宽松筛查带：15–25° 提醒，>25° 判 bad
        frame: setIdx,
      });
    }

    // 双脚站距（以肩宽为单位，水平比值不受宽高比影响；站姿邻域逐帧求比值取中位数）。
    // good 0.7–1.5：下限锚定 Cabarkapa 2023 熟练罚球员实测 30–33cm ≈ 0.7–0.85×肩宽
    const sw = [];
    for (const i of winIdx(standIdx)) {
      const la = lm(i, 27), ra = lm(i, 28), ls = lm(i, 11), rs = lm(i, 12);
      if (!la || !ra || !ls || !rs) continue;
      sw.push(Math.abs(la.x - ra.x) / (Math.abs(ls.x - rs.x) || 1e-6));
    }
    if (sw.length) {
      add("stanceWidth", "双脚站距", median(sw), "×肩宽", 0.7, 1.5, 1, {
        warnLo: 0.5, warnHi: 1.8, // 0.5–0.7 过窄 / 1.5–1.8 过宽 提醒，超出判 bad
        frame: standIdx,
      });
    }

    // 左右重心偏移：动作窗口内髋中点相对双脚中点的横向偏移——取 90 分位而非最大值，
    // 对单帧毛刺稳健（筛查型指标，轻微低估可接受）
    const lat = [];
    for (let i = standIdx; i <= apexIdx; i++) {
      const h1 = lm(i, 23), h2 = lm(i, 24), a1 = lm(i, 27), a2 = lm(i, 28);
      if (!h1 || !h2 || !a1 || !a2) continue;
      lat.push(Math.abs((h1.x + h2.x) / 2 - (a1.x + a2.x) / 2));
    }
    const latMax = lat.length ? lat.sort((x, y) => x - y)[Math.ceil(lat.length * 0.9) - 1] : -1;
    // 左右重心偏移：文献中无篮球专项的左右重心阈值——降级为趋势参考（不计分），供同一球员前后对比
    if (latMax >= 0) {
      add("lateralBalance", "左右重心偏移", latMax / bodyH, "×身高", 0, 0.06, 1, {
        verdictOverride: "info", screeningOnly: true,
        rangeText: "越稳定越好（趋势参考）",
        frame: standIdx,
      });
    }
  }

  // 起跳：verdict 由 buildReport 按投篮类型判定——多次出手取中位数后才能正确判定
  const jumped = jumpRise > JUMP_MIN;
  M.push({
    id: "jump", name: type === "free" ? "罚球贴地" : "起跳幅度",
    num: jumpRise, unit: "×身高", lo: 0, hi: 1, weight: 1,
    rangeText: type === "free" ? "不起跳" : "需起跳",
    value: jumped ? "有起跳" : "基本贴地",
    frame: releaseIdx,
  });

  // 按固定顺序输出，单机位报告与融合报告的展示顺序一致
  const order = Object.keys(METRIC_VIEWS);
  M.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  return M;
}

/** 站姿体高（肩到踝的垂直距离），作为归一化分母；供对比模块复用 */
export function standingBodyHeight(frames, cycle, sideName) {
  const s = SIDE[sideName];
  const sh = frames[cycle.standIdx]?.landmarks?.[s.shoulder];
  const an = frames[cycle.standIdx]?.landmarks?.[s.ankle];
  if (!sh || !an) return null;
  const h = Math.abs(sh.y - an.y);
  return h > 0.01 ? h : null; // 过小视为异常
}

/**
 * 关键动作曲线：一次代表性出手的肘角/膝角逐帧读数，供报告画图。
 * x 轴是「相对出手帧的秒数」（读者看得懂，而不是帧号），区间为出手前 1.0s ~ 出手后 0.5s。
 * 事件竖线标注：下蹲（crouchIdx）、举球（setIdx）、出手（releaseIdx）、跟随（apexIdx）。
 * 举球点的取法与 computeMetrics 一致——下蹲到出手之间肘角最小的帧。
 */
export function cycleCurves(frames, cycle, sideName, fps = 30) {
  const s = SIDE[sideName];
  const { releaseIdx, crouchIdx, apexIdx } = cycle;
  const n = frames.length;
  const elbow = angleSeries(frames, s.shoulder, s.elbow, s.wrist);
  const knee = angleSeries(frames, s.hip, s.knee, s.ankle);

  let setIdx = crouchIdx;
  for (let i = crouchIdx; i < releaseIdx; i++) if (elbow[i] < elbow[setIdx]) setIdx = i;

  const from = Math.max(0, releaseIdx - Math.round(fps * 1.0));
  const to = Math.min(n - 1, releaseIdx + Math.round(fps * 0.5));
  const x = (i) => (i - releaseIdx) / fps;
  const slice = (series) => {
    const out = [];
    for (let i = from; i <= to; i++) out.push({ x: x(i), y: series[i] });
    return out;
  };
  const events = [];
  const mark = (idx, label) => {
    if (isFinite(idx)) events.push({ x: x(idx), label });
  };
  mark(crouchIdx, "下蹲");
  mark(setIdx, "举球");
  mark(releaseIdx, "出手");
  mark(apexIdx, "跟随");
  return { elbow: slice(elbow), knee: slice(knee), events };
}
