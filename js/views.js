// 机位判别、识别质量评估与拍摄机位示意图（多角度分析支撑模块）
// 坐标仍为归一化 0–1：classifyView 的比值混用横向(x)/纵向(y)量，x 须乘宽高比（帧上的 aspect）才是真实几何
import { isValidPose, poseBodyHeight, shoulderRatio } from "./tracks.js";

export const VIEW_LABEL = { side: "侧面", front: "正面", oblique: "斜侧", unknown: "未知" };

// 肩宽比阈值（沿用 v5.8 的口径，不动）：<0.12 侧面，>0.17 正面，中间是斜侧
export const SIDE_MAX = 0.12;
export const FRONT_MIN = 0.17;

const pct = (v) => `${Math.round(v * 100)}%`;

/**
 * 判别拍摄机位（v5.9：返回带依据的形式，不再无依据地硬判一个机位）。
 * 正对镜头时双肩水平张开（肩宽/躯干高比值大），侧对镜头时双肩几乎重叠（比值小）。
 * 逐帧取「双肩水平距离 × 宽高比 ÷ 躯干高」后取中位数，抗异常帧。
 *
 * 返回 { view, ratio, sideShare, frontShare, unstable, reason, reasons }：
 *   · view      —— "side" | "front" | "oblique" | "unknown"；机位不固定时一律按 "side"（保守：宁可少报）
 *   · ratio     —— 肩宽比中位数
 *   · sideShare —— 侧面帧（比值 < 0.12）占比
 *   · frontShare—— 正面帧（比值 > 0.17）占比
 *   · unstable  —— 机位在拍摄过程中是否变化（满足任一条件即成立）
 *   · reason    —— 中文依据说明（报告里直接引用）
 *
 * 判「机位不固定」的三个条件：
 *   a) 双峰：侧面帧占比 ≥25% 且正面帧占比 ≥25%
 *   b) 运镜：主体体高在时间上的 p90/p10 > 3（人在画面里忽远忽近）
 *   c) 比值分散：肩宽比的四分位距（p75−p25）> 0.08
 * opts.manual = true 时跳过 unstable 判定（融合区手动指定机位时用）。
 */
export function classifyView(frames, opts = {}) {
  const ratios = [];
  const heights = [];
  for (const f of frames) {
    const lm = f.landmarks;
    if (!lm) continue;
    // 坏姿态（躯干高为负/过小、关键点不可信）不参与机位判定
    if (!isValidPose(lm, f.aspect)) continue;
    const r = shoulderRatio(lm, f.aspect);
    if (r != null) ratios.push(r);
    const h = poseBodyHeight(lm);
    if (h != null && h > 0) heights.push(h);
  }
  if (ratios.length < 5) {
    return {
      view: "unknown", rawView: "unknown", ratio: null,
      sideShare: 0, frontShare: 0, iqr: 0, zoomRatio: 0,
      unstable: false, reasons: [],
      reason: "有效帧太少，无法判别机位（已按侧面近似处理）",
    };
  }
  ratios.sort((a, b) => a - b);
  const mid = ratios[Math.floor(ratios.length / 2)];
  // 校正后的比值≈真实「肩宽/身高」：正面约 0.20–0.26，纯侧约 0.02–0.06，斜侧约 0.15。
  // 上限 0.17 压在正面物理下限之下，防止正面被误判成斜侧而丢掉正面指标；下限 0.12 容纳常见 30° 转体站位
  const rawView = mid < SIDE_MAX ? "side" : mid > FRONT_MIN ? "front" : "oblique";
  const q = (p) => ratios[Math.min(ratios.length - 1, Math.floor(ratios.length * p))];
  const sideShare = ratios.filter((r) => r < SIDE_MAX).length / ratios.length;
  const frontShare = ratios.filter((r) => r > FRONT_MIN).length / ratios.length;
  const iqr = q(0.75) - q(0.25);
  const hs = [...heights].sort((a, b) => a - b);
  const hq = (p) => (hs.length ? hs[Math.min(hs.length - 1, Math.floor(hs.length * p))] : 0);
  const zoomRatio = hq(0.9) / Math.max(1e-6, hq(0.1));

  const reasons = [];
  if (sideShare >= 0.25 && frontShare >= 0.25) {
    reasons.push(`侧面帧占 ${pct(sideShare)}、正面帧占 ${pct(frontShare)}（双峰）`);
  }
  if (zoomRatio > 3) {
    reasons.push(`运镜幅度 ${zoomRatio.toFixed(1)} 倍（体高 p90/p10）`);
  }
  if (iqr > 0.08) {
    reasons.push(`比值分散（四分位距 ${iqr.toFixed(3)}）`);
  }
  const unstable = opts.manual ? false : reasons.length > 0;
  // 机位不固定时一律按侧面近似处理：侧面专属指标比正面专属指标更少出错，宁可少报
  const view = unstable ? "side" : rawView;
  const basis = `肩宽比中位 ${mid.toFixed(3)}`;
  const reason = unstable
    ? `${basis}；${reasons.join("；")}`
    : `${basis}（${rawView === "side" ? "低于 0.12，接近侧面" : rawView === "front" ? "高于 0.17，接近正面" : "介于 0.12–0.17，斜侧"}）`;
  return { view, rawView, ratio: mid, sideShare, frontShare, iqr, zoomRatio, unstable, reasons, reason };
}

/** 关键点在 [from, to] 帧窗口内的平均可见度（0–1），用于评估识别质量 */
export function windowVisibility(frames, idxList, from = 0, to = frames.length - 1) {
  let sum = 0, n = 0;
  for (let i = Math.max(0, from); i <= Math.min(frames.length - 1, to); i++) {
    const lm = frames[i]?.landmarks;
    if (!lm) continue;
    for (const idx of idxList) {
      sum += lm[idx]?.visibility ?? 0;
      n++;
    }
  }
  return n ? sum / n : 0;
}

// 只有特定机位才能看懂的因素（补拍建议文案）
const VIEW_UNLOCKS = {
  front: "肘内外展、双脚站距、左右重心对称",
  side: "下蹲膝角、出手方向角、举球/跟随肘角、躯干前后倾",
};

/**
 * 当前机位还缺什么：返回需要补拍的机位列表 [{ view, reason }]。
 * 侧面缺正面，正面缺侧面，斜侧/未知两边都建议拍。
 */
export function coverageGaps(view) {
  if (view === "side") return [{ view: "front", reason: VIEW_UNLOCKS.front }];
  if (view === "front") return [{ view: "side", reason: VIEW_UNLOCKS.side }];
  return [
    { view: "side", reason: VIEW_UNLOCKS.side },
    { view: "front", reason: VIEW_UNLOCKS.front },
  ];
}

/**
 * 拍摄机位示意图（俯视）：篮筐在上、球员居中，三个机位以虚线视线标出。
 * highlight: 需强调的机位（如 ["front"]），会高亮并标注「建议补拍」，其余机位淡化。
 */
export function courtGuideSVG(highlight = []) {
  const on = (v) => highlight.includes(v);
  const anyHi = highlight.length > 0;
  const dim = (v) => (anyHi && !on(v) ? ' opacity="0.4"' : "");
  const sight = (x1, y1, x2, y2, v) =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${on(v) ? "#f97316" : "#475569"}" stroke-width="2" stroke-dasharray="5 4"${dim(v)}/>`;
  const cam = (x, y, v, label, lx, ly, anchor = "middle") => `<g${dim(v)}>${on(v) ? `<circle cx="${x}" cy="${y}" r="18" fill="none" stroke="#f97316" stroke-width="2" stroke-dasharray="4 3"/>` : ""}<text x="${x}" y="${y + 6}" font-size="17" text-anchor="middle">🎥</text><text x="${lx}" y="${ly}" font-size="11" text-anchor="${anchor}" fill="${on(v) ? "#f97316" : "#94a3b8"}" font-weight="${on(v) ? "700" : "400"}">${label}${on(v) ? " · 建议补拍" : ""}</text></g>`;
  return `<svg viewBox="0 0 360 212" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="拍摄机位示意图（俯视）">
  <rect x="1" y="1" width="358" height="210" rx="14" fill="rgba(148,163,184,0.06)"/>
  <rect x="152" y="16" width="56" height="5" rx="2.5" fill="#94a3b8"/>
  <circle cx="180" cy="34" r="8" fill="none" stroke="#f97316" stroke-width="2.5"/>
  <text x="240" y="30" font-size="10" fill="#94a3b8">篮筐</text>
  <text x="180" y="62" font-size="10" text-anchor="middle" fill="#38bdf8">⬆ 出手方向</text>
  ${sight(180, 104, 180, 138, "front")}
  ${cam(180, 92, "front", "正面机位", 202, 96, "start")}
  ${sight(58, 156, 146, 156, "side")}
  ${cam(40, 156, "side", "侧面机位·左", 40, 190)}
  ${sight(302, 156, 214, 156, "side")}
  ${cam(320, 156, "side", "侧面机位·右", 320, 190)}
  <text x="180" y="170" font-size="26" text-anchor="middle">🧍</text>
  <text x="180" y="196" font-size="11" text-anchor="middle" fill="#e2e8f0">投篮者</text>
</svg>`;
}
