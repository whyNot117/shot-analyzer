// 骨架绘制与关节角度计算（MediaPipe 33 关键点，坐标归一化 0–1）

export const POSE_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 7], [0, 4], [4, 5], [5, 6], [6, 8], [9, 10],
  [11, 12], [11, 13], [13, 15], [15, 17], [15, 19], [15, 21], [17, 19],
  [12, 14], [14, 16], [16, 18], [16, 20], [16, 22], [18, 20],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [27, 29], [27, 31], [29, 31],
  [24, 26], [26, 28], [28, 30], [28, 32], [30, 32],
];

// 与投篮直接相关的关节（放大高亮）
const KEY_JOINTS = new Set([11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]);

// 左右两条链的关键点索引，用于侧面机位自动选边
export const SIDE = {
  right: { shoulder: 12, elbow: 14, wrist: 16, hip: 24, knee: 26, ankle: 28 },
  left:  { shoulder: 11, elbow: 13, wrist: 15, hip: 23, knee: 25, ankle: 27 },
};

/** 三点夹角：b 为顶点，返回角度（度，0–180），退化时返回 null。
 *  aspect 为视频宽高比：归一化坐标里 x/y 的物理比例不同，校正后才反映真实角度 */
export function angleAt(a, b, c, aspect = 1) {
  const abx = (a.x - b.x) * aspect, aby = a.y - b.y;
  const bcx = (c.x - b.x) * aspect, bcy = c.y - b.y;
  const magA = Math.hypot(abx, aby);
  const magB = Math.hypot(bcx, bcy);
  if (magA === 0 || magB === 0) return null;
  const dot = abx * bcx + aby * bcy;
  return (Math.acos(Math.min(1, Math.max(-1, dot / (magA * magB)))) * 180) / Math.PI;
}

/** 根据整段视频的平均可见度选择面向镜头的一侧 */
export function pickSide(frames) {
  const avg = (idx) =>
    frames.reduce((s, f) => s + (f.landmarks?.[idx]?.visibility ?? 0), 0) / (frames.length || 1);
  const sum = (side) => Object.values(side).reduce((s, i) => s + avg(i), 0);
  return sum(SIDE.right) >= sum(SIDE.left) ? "right" : "left";
}

/** 正面/斜侧机位下选出手侧：各检出周期出手帧「更高的腕部」多数投票。
 *  双腕高度接近（<0.02，约 3% 体高）时按可见度决断——避免单帧抖动让整组手臂指标换臂 */
export function pickShootingSide(frames, cycle, fallback = "right") {
  const cycles = Array.isArray(cycle) ? cycle : [cycle].filter(Boolean);
  let left = 0, right = 0;
  for (const c of cycles) {
    const l = frames[c?.releaseIdx]?.landmarks?.[15];
    const r = frames[c?.releaseIdx]?.landmarks?.[16];
    if (!l || !r) continue;
    if (Math.abs(l.y - r.y) < 0.02) {
      ((l.visibility ?? 0) >= (r.visibility ?? 0) ? left++ : right++);
    } else if (l.y < r.y) left++;
    else right++;
  }
  if (left === right) return fallback;
  return left > right ? "left" : "right";
}

/**
 * 在 canvas 上绘制一帧骨架。
 * landmarks: 33 个 {x, y, visibility}（归一化 0–1），可为 null（该帧未识别到人）
 */
export function drawFrame(ctx, landmarks, { showSkeleton, showJoints, showAngles, side } = {}) {
  const w = ctx.canvas.width, h = ctx.canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (!landmarks) return;
  const P = (l) => ({ x: l.x * w, y: l.y * h, v: l.visibility ?? 1 });

  if (showSkeleton) {
    ctx.lineWidth = Math.max(2, w / 240);
    ctx.lineCap = "round";
    for (const [i, j] of POSE_CONNECTIONS) {
      const a = P(landmarks[i]), b = P(landmarks[j]);
      const vis = Math.min(a.v, b.v);
      if (vis < 0.3) continue;
      ctx.strokeStyle = `rgba(56, 189, 248, ${Math.min(1, vis)})`;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }

  if (showJoints) {
    landmarks.forEach((l, i) => {
      const p = P(l);
      if (p.v < 0.3) return;
      const key = KEY_JOINTS.has(i);
      ctx.fillStyle = key ? "#f97316" : "rgba(148, 163, 184, 0.9)";
      ctx.beginPath();
      ctx.arc(p.x, p.y, key ? Math.max(4, w / 160) : Math.max(2.5, w / 280), 0, Math.PI * 2);
      ctx.fill();
    });
  }

  if (showAngles && side) {
    const s = SIDE[side];
    drawAngle(ctx, landmarks, s.shoulder, s.elbow, s.wrist, "肘");
    drawAngle(ctx, landmarks, s.hip, s.knee, s.ankle, "膝");
  }
}

function drawAngle(ctx, landmarks, a, b, c, label) {
  if ((landmarks[b].visibility ?? 1) < 0.3) return;
  const deg = angleAt(landmarks[a], landmarks[b], landmarks[c], ctx.canvas.width / ctx.canvas.height || 1);
  if (deg == null) return;
  const w = ctx.canvas.width, h = ctx.canvas.height;
  const p = { x: landmarks[b].x * w, y: landmarks[b].y * h };
  const r = Math.max(14, w / 45);
  ctx.font = `bold ${Math.max(12, w / 50)}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(250, 204, 21, 0.95)";
  ctx.fill();
  ctx.fillStyle = "#1e293b";
  ctx.fillText(`${Math.round(deg)}°`, p.x, p.y + Math.max(4, w / 130));
  ctx.fillStyle = "rgba(250, 204, 21, 0.95)";
  ctx.fillText(label, p.x, p.y - r - 4);
}
