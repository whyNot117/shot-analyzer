// 关节几何计算的公共部分：从逐帧关键点取点、补空档、平滑、逐帧关节角
// metrics.js 与 scene.js 共用这套算法（放在独立模块里是为了避免两个模块互相 import 形成环）
import { angleAt } from "./draw.js";

/** 数值序列平滑（滑动窗口均值） */
export function smoothNums(s, win = 3) {
  const half = win >> 1;
  const out = [];
  for (let i = 0; i < s.length; i++) {
    let sum = 0, n = 0;
    for (let k = i - half; k <= i + half; k++) if (k >= 0 && k < s.length) { sum += s[k]; n++; }
    out.push(sum / (n || 1));
  }
  return out;
}

const clone = (v) => (typeof v === "number" ? v : { ...v });

function mix(a, b, r) {
  if (typeof a === "number") return a * (1 - r) + b * r;
  return { x: a.x * (1 - r) + b.x * r, y: a.y * (1 - r) + b.y * r };
}

/** 点序列（{x,y}）与数值序列通用：分别平滑 */
export function smooth(series, win = 3) {
  if (series.length && typeof series[0] === "number") return smoothNums(series, win);
  // 某关键点全程缺失时以 0 占位，避免崩溃（对应指标会被 isFinite 过滤掉）
  const xs = smoothNums(series.map((p) => p?.x ?? 0), win);
  const ys = smoothNums(series.map((p) => p?.y ?? 0), win);
  return series.map((_, i) => ({ x: xs[i], y: ys[i] }));
}

/** 用前后邻值线性插值填补空帧（未识别到人的帧） */
export function fillGaps(series) {
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

/** 逐帧取某个关键点的坐标；x 乘宽高比才是真实几何（归一化坐标 x/y 的物理比例不同） */
export function pointsOf(frames, idx) {
  const aspect = frames[0]?.aspect ?? 1;
  return frames.map((f) => {
    const l = f.landmarks?.[idx];
    return l ? { x: l.x * aspect, y: l.y } : null;
  });
}

/** 逐帧计算某关节角（a-b-c，b 为顶点），返回角度数组（度） */
export function angleSeries(frames, a, b, c) {
  const A = smooth(fillGaps(pointsOf(frames, a)));
  const B = smooth(fillGaps(pointsOf(frames, b)));
  const C = smooth(fillGaps(pointsOf(frames, c)));
  return fillGaps(B.map((_, i) => angleAt(A[i], B[i], C[i])));
}