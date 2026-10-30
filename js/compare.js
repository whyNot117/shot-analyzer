// 双视频动作对比：序列归一化、DTW 时间对齐、逐关节偏差
import { SIDE } from "./draw.js";

const JOINTS = ["nose", "shoulder", "elbow", "wrist", "hip", "knee", "ankle"];

// DTW 距离中各关节的权重（上肢与出手链路最重要）
const W = { nose: 0.5, shoulder: 1, elbow: 1.5, wrist: 1.5, hip: 0.5, knee: 1, ankle: 0.5 };

export const JOINT_LABEL = {
  nose: "头部", shoulder: "肩部", elbow: "肘部", wrist: "手腕/出手",
  hip: "髋部/重心", knee: "膝部", ankle: "脚部/步法",
};

export const JOINT_ADVICE = {
  nose: "注意头部位置与视线指向，出手全程盯筐不晃动。",
  shoulder: "肩部高度与姿态和参考不同，注意举球高度与沉肩发力。",
  elbow: "肘部轨迹差异明显：对照参考的举球-伸展路径，做「射箭定姿」慢动作练习。",
  wrist: "手腕/出手点轨迹差异明显：模仿参考的出手高度与出手后的跟随动作。",
  hip: "髋部重心移动路径不同：注意下蹲深度与发力方向是否与参考一致。",
  knee: "膝部动作差异明显：对照参考的下蹲深度与蹬伸时机。",
  ankle: "脚步与落点和参考不同：注意站位宽度与起跳、落地位置。",
};

/**
 * 归一化一段帧序列：以髋为原点、站姿体高为单位。
 * 消除身高和拍摄距离差异；空帧（未识别）沿用上一帧关键点。
 */
export function normalizeSequence(frames, sideName, bodyH) {
  const s = SIDE[sideName];
  const H = bodyH || 1e-6;
  const aspect = frames[0]?.aspect ?? 1; // 与 metrics 一致的宽高比校正，保证两段视频可比
  const out = [];
  let last = null;
  for (const f of frames) {
    const lm = f.landmarks ?? last;
    if (!lm) continue;
    last = lm;
    const hx = lm[s.hip].x * aspect, hy = lm[s.hip].y;
    const pt = (i) => ({ x: (lm[i].x * aspect - hx) / H, y: (lm[i].y - hy) / H });
    out.push({
      nose: pt(0),
      shoulder: pt(s.shoulder),
      elbow: pt(s.elbow),
      wrist: pt(s.wrist),
      hip: pt(s.hip),
      knee: pt(s.knee),
      ankle: pt(s.ankle),
    });
  }
  return out;
}

function dist(a, b) {
  let s = 0, wsum = 0;
  for (const j of JOINTS) {
    const w = W[j];
    s += w * ((a[j].x - b[j].x) ** 2 + (a[j].y - b[j].y) ** 2);
    wsum += w;
  }
  return Math.sqrt(s / wsum);
}

/**
 * 经典 DTW：返回 { path, mapAtoB, avgCost }。
 * path: [[a,b], ...] 对齐路径；mapAtoB: A 每帧对应的 B 帧；avgCost: 平均对齐代价。
 */
export function dtwAlign(A, B) {
  const n = A.length, m = B.length;
  const INF = 1e9;
  const cost = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(INF));
  const len = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  cost[0][0] = 0;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const d = dist(A[i - 1], B[j - 1]);
      let best = cost[i - 1][j], bl = len[i - 1][j];
      if (cost[i][j - 1] < best) { best = cost[i][j - 1]; bl = len[i][j - 1]; }
      if (cost[i - 1][j - 1] < best) { best = cost[i - 1][j - 1]; bl = len[i - 1][j - 1]; }
      cost[i][j] = best + d;
      len[i][j] = bl + 1;
    }
  }
  // 回溯对齐路径
  const path = [];
  let i = n, j = m;
  while (i > 0 && j > 0) {
    path.push([i - 1, j - 1]);
    const c = cost[i - 1][j - 1], u = cost[i - 1][j], l = cost[i][j - 1];
    if (c <= u && c <= l) { i--; j--; }
    else if (u <= l) i--;
    else j--;
  }
  path.reverse();
  const mapAtoB = new Array(n).fill(0);
  for (const [a, b] of path) mapAtoB[a] = b; // 每帧 a 至少出现一次，后写覆盖即最终对齐
  return { path, mapAtoB, avgCost: cost[n][m] / (len[n][m] || 1) };
}

/** 沿对齐路径求各关节平均偏差（单位：×身高） */
export function jointDeviations(A, B, path) {
  const acc = Object.fromEntries(JOINTS.map((j) => [j, 0]));
  for (const [a, b] of path) {
    for (const j of JOINTS) {
      acc[j] += Math.hypot(A[a][j].x - B[b][j].x, A[a][j].y - B[b][j].y);
    }
  }
  return JOINTS.map((j) => ({ joint: j, dev: acc[j] / (path.length || 1) }));
}
