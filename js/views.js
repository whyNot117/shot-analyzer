// 机位判别、识别质量评估与拍摄机位示意图（多角度分析支撑模块）
// 坐标仍为归一化 0–1：classifyView 的比值混用横向(x)/纵向(y)量，x 须乘宽高比（帧上的 aspect）才是真实几何

export const VIEW_LABEL = { side: "侧面", front: "正面", oblique: "斜侧", unknown: "未知" };

/**
 * 判别拍摄机位：正对镜头时双肩水平张开（肩宽/体高比值大），侧对镜头时双肩几乎重叠（比值小）。
 * 逐帧取「双肩水平距离 × 宽高比 ÷ 体高」后取中位数，抗异常帧。返回 "side" | "front" | "oblique" | "unknown"。
 */
export function classifyView(frames) {
  const ratios = [];
  for (const f of frames) {
    const lm = f.landmarks;
    if (!lm) continue;
    const ls = lm[11], rs = lm[12];
    const shoulderY = (ls.y + rs.y) / 2;
    const ankleY = (lm[27].y + lm[28].y) / 2;
    const bodyH = Math.abs(ankleY - shoulderY);
    if (bodyH < 0.15) continue; // 未全身入镜或倒地等异常帧不参与统计
    ratios.push((Math.abs(ls.x - rs.x) * (f.aspect ?? 1)) / bodyH);
  }
  if (ratios.length < 5) return "unknown";
  ratios.sort((a, b) => a - b);
  const mid = ratios[Math.floor(ratios.length / 2)];
  // 校正后的比值≈真实「肩宽/身高」：正面约 0.20–0.26，纯侧约 0.02–0.06，斜侧约 0.15。
  // 上限 0.17 压在正面物理下限之下，防止正面被误判成斜侧而丢掉正面指标；下限 0.12 容纳常见 30° 转体站位
  if (mid < 0.12) return "side";
  if (mid > 0.17) return "front";
  return "oblique";
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
