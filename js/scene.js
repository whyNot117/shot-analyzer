// 场景判定：定点站投（spot）/ 移动后出手（moving）/ 接球即投（catch）
// 判定规则全部集中在本模块，阈值写在文件顶部常量并注明出处，方便后续调参。
// 判定要保守：证据不足一律回退「定点站投」，并在 reason 里说明依据不足。
import { SIDE } from "./draw.js";
import { pointsOf, fillGaps, smooth, angleSeries } from "./angles.js";

// ---------- 判定阈值（出处/依据见每行注释） ----------
export const MOVE_RATIO = 0.15;      // 双足中点水平位移 ≥ 0.15×身高 → 移动出手（后撤步/横移/跳步的量级）
export const MOVE_WINDOW = 1.0;      // 移动判定窗口（秒）：出手前 1 秒
export const CATCH_WINDOW = 0.25;    // 举球点 → 出手 < 0.25s → 接球即投（接球到出手的常规反应时）
export const CATCH_KNEE_DELTA = 10;  // 该区间内膝角变化 < 10°：没有下蹲蓄力
export const CATCH_CROUCH_MAX = 12;  // 出手前 1.5s 窗口内膝角变化 < 12°：全程没有蓄力下蹲
export const CATCH_LOOKBACK = 1.5;    // 看「有没有下蹲蓄力」的回看窗口（秒），与下蹲检测窗口一致
export const CATCH_STRAIGHT = 155;   // 窗口内膝角中位数 ≥ 155°：腿是直的（不是半蹲着接球）
export const MOVE_BASE_WINDOW = 1.5; // 移动场景取站姿基线时回看的窗口（秒）
export const MIN_COVERAGE = 0.5;     // 动作窗口内有效帧覆盖率低于此值 → 证据不足

export const SCENE_LABEL = { spot: "定点站投", moving: "移动后出手", catch: "接球即投" };

// ---------- 基础测量 ----------

function medianOf(arr) {
  const a = arr.filter((x) => isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/** 区间 [a,b] 内有限值的中位数（对单帧抖动稳健） */
function medianRange(arr, a, b) {
  const out = [];
  for (let i = Math.max(0, a); i <= Math.min(arr.length - 1, b); i++) if (isFinite(arr[i])) out.push(arr[i]);
  return medianOf(out);
}

/** 体高（肩到踝的垂直距离）：位移类指标的归一化分母 */
export function bodyHeight(frames, s, from, to) {
  const sh = pointsOf(frames, s.shoulder);
  const an = pointsOf(frames, s.ankle);
  const hs = [];
  for (let i = from; i <= to; i++) {
    if (!frames[i]?.landmarks) continue;
    const h = Math.abs(sh[i].y - an[i].y);
    if (isFinite(h) && h > 0.01) hs.push(h);
  }
  return medianOf(hs);
}

/** 双足中点的水平位置序列（缺一只脚时用另一只；两只都缺则为空值） */
export function footMidSeries(frames) {
  const left = smooth(fillGaps(pointsOf(frames, 27)));
  const right = smooth(fillGaps(pointsOf(frames, 28)));
  const out = [];
  for (let i = 0; i < frames.length; i++) {
    const xl = left[i]?.x;
    const xr = right[i]?.x;
    if (isFinite(xl) && isFinite(xr)) out.push((xl + xr) / 2);
    else if (isFinite(xl)) out.push(xl);
    else if (isFinite(xr)) out.push(xr);
    else out.push(NaN);
  }
  return out;
}

/**
 * 出手前 1.0s 双足中点的水平位移（单位：×身高）。
 * 移动场景的「出手前移动距离/速度」两个指标都用它。
 */
export function moveDistance(frames, cycle, sideName, fps = 30) {
  const s = SIDE[sideName] ?? SIDE.right;
  const releaseIdx = cycle?.releaseIdx ?? 0;
  const from = Math.max(0, releaseIdx - Math.round(fps * MOVE_WINDOW));
  const bodyH = bodyHeight(frames, s, from, releaseIdx);
  if (!(bodyH > 0)) return NaN;
  const footX = footMidSeries(frames);
  const x0 = medianRange(footX, from, Math.min(releaseIdx, from + 3));
  const x1 = medianRange(footX, Math.max(from, releaseIdx - 2), releaseIdx);
  if (!isFinite(x0) || !isFinite(x1)) return NaN;
  return Math.abs(x1 - x0) / bodyH;
}

/** 髋部上下起落的次数（窗口内垂直速度的符号翻转次数）：反复上下 = 站得不稳 */
function hipBobCount(frames, from, to) {
  const hip = smooth(fillGaps(pointsOf(frames, 24)));
  let flips = 0;
  let prevSign = 0;
  for (let i = Math.max(1, from); i <= to; i++) {
    const d = hip[i].y - hip[i - 1].y;
    if (!isFinite(d) || Math.abs(d) < 1e-4) continue; // 忽略噪声级抖动
    const sign = Math.sign(d);
    if (prevSign && sign !== prevSign) flips++;
    prevSign = sign;
  }
  return flips;
}

/**
 * 场景判定。返回 { scene, confidence, reason }：
 * - scene: "spot" | "moving" | "catch"
 * - confidence: 0–1，越低说明证据越不足
 * - reason: 中文一句话说明依据（报告里直接展示）
 * cycle 需要 releaseIdx（必填）与 crouchIdx（可选，用于找举球点）。
 */
export function classifyScene(frames, cycle, sideName, fps = 30) {
  const s = SIDE[sideName] ?? SIDE.right;
  const n = frames?.length ?? 0;
  const releaseIdx = cycle?.releaseIdx;
  if (!n || !isFinite(releaseIdx)) {
    return { scene: "spot", confidence: 0.2, reason: "缺少出手帧信息，按定点站投处理" };
  }
  const from = Math.max(0, releaseIdx - Math.round(fps * MOVE_WINDOW));

  // 动作窗口内人物在画面里的比例——证据够不够的第一道底线
  let real = 0;
  for (let i = from; i <= releaseIdx; i++) if (frames[i]?.landmarks) real++;
  const coverage = real / Math.max(1, releaseIdx - from + 1);

  const bodyH = bodyHeight(frames, s, from, releaseIdx);
  const footX = footMidSeries(frames);
  const x0 = medianRange(footX, from, Math.min(releaseIdx, from + 3));
  const x1 = medianRange(footX, Math.max(from, releaseIdx - 2), releaseIdx);
  const ratio = bodyH > 0 && isFinite(x0) && isFinite(x1) ? Math.abs(x1 - x0) / bodyH : NaN;

  // 证据不足 → 保守回退定点站投
  if (coverage < MIN_COVERAGE || !(bodyH > 0) || !isFinite(ratio)) {
    return {
      scene: "spot",
      confidence: 0.3,
      reason: `未能确认移动/接球特征（出手前窗口内有效帧 ${Math.round(coverage * 100)}%），按定点站投处理`,
    };
  }

  // 接球即投：举球点到出手很快，且这段区间没有屈膝蓄力
  const elbow = angleSeries(frames, s.shoulder, s.elbow, s.wrist);
  const knee = angleSeries(frames, s.hip, s.knee, s.ankle);
  let setIdx = isFinite(cycle?.crouchIdx) ? cycle.crouchIdx : from;
  for (let i = setIdx; i < releaseIdx; i++) if (elbow[i] < elbow[setIdx]) setIdx = i;
  const setToRelease = (releaseIdx - setIdx) / fps;
  const kneeInWindow = knee.slice(setIdx, releaseIdx + 1).filter((x) => isFinite(x));
  const kneeDelta = kneeInWindow.length ? Math.max(...kneeInWindow) - Math.min(...kneeInWindow) : NaN;
  // 有没有下蹲蓄力：看整个出手前窗口（下蹲可能比 1 秒更早开始，只看 1 秒会漏掉）
  const crouchFrom = Math.max(0, releaseIdx - Math.round(fps * CATCH_LOOKBACK));
  const kneeAll = knee.slice(crouchFrom, releaseIdx + 1).filter((x) => isFinite(x));
  const crouchDelta = kneeAll.length ? Math.max(...kneeAll) - Math.min(...kneeAll) : NaN;
  const kneeMedian = medianOf(kneeAll);
  const isCatch =
    setToRelease < CATCH_WINDOW &&
    isFinite(kneeDelta) && kneeDelta < CATCH_KNEE_DELTA &&
    isFinite(crouchDelta) && crouchDelta < CATCH_CROUCH_MAX &&
    isFinite(kneeMedian) && kneeMedian >= CATCH_STRAIGHT;
  if (isCatch) {
    return {
      scene: "catch",
      confidence: 0.8,
      reason: `举球点到出手 ${setToRelease.toFixed(2)}s（<${CATCH_WINDOW}s）、出手前 ${CATCH_LOOKBACK.toFixed(1)}s 膝角仅变化 ${crouchDelta.toFixed(0)}°（没有下蹲蓄力），判为接球即投`,
    };
  }

  // 移动后出手：出手前 1 秒双足中点水平位移超过 0.15×身高
  if (ratio >= MOVE_RATIO) {
    // 刚过阈值把握有限，超出越多越有把握
    const conf = Math.min(0.95, 0.55 + 0.4 * Math.min(1, (ratio - MOVE_RATIO) / MOVE_RATIO));
    return {
      scene: "moving",
      confidence: conf,
      reason: `出手前 ${MOVE_WINDOW.toFixed(1)}s 双足中点水平位移 ${ratio.toFixed(2)}×身高（≥${MOVE_RATIO}×身高），判为移动后出手`,
    };
  }

  // 定点站投：位移在阈值内。髋部反复上下起落说明站得不稳，把握相应降低
  const bob = hipBobCount(frames, from, releaseIdx);
  return {
    scene: "spot",
    confidence: bob > 2 ? 0.6 : 0.85,
    reason: `出手前 ${MOVE_WINDOW.toFixed(1)}s 双足中点水平位移 ${ratio.toFixed(2)}×身高（<${MOVE_RATIO}×身高），未见移动或接球特征，按定点站投处理`,
  };
}