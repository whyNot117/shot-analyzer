// 主体追踪：坏姿态剔除 + 轨迹聚类 + 出手证据 + 主体选取（纯函数，Node 里可直接测）
//
// 为什么要有这一层（v5.9）：旧实现是「逐帧取占画面最大的人」（js/media.js 的 makePersonPicker），
// 它用「站高记忆 × 0.55–1.6 的体型带」做匹配——手持跟拍时人在画面里忽远忽近，
// 表观体型能差十几倍，一出带就冻结 5 秒，超时再按「占画面最大」重锁，
// 于是锁定的对象在画面里来回跳：一份报告里的读数其实来自好几个人。
//
// 这里换成「先攒下每帧的全部候选 → 聚成轨迹 → 按出手动作证据选主体」：
//   ① 坏姿态（躯干高为负/过小）先剔除，不参与任何统计与判定；
//   ② 轨迹关联的门限按「位置 + 体型相近度」软约束，允许运镜造成的体型变化；
//   ③ 主体优先选「有出手动作」的轨迹，其次有效帧最多，再次体高最大。

// 关键点可见度下限：低于此值的关键点是外推值，不能当体积/几何依据（沿用 media.js 的口径）
export const VIS_MIN = 0.3;
// 躯干高下限（归一化）：肩中点与踝中点的 y 差，低于此值视为未全身入镜/关键点不可信
export const MIN_TORSO_H = 0.05;
// 连续多少帧「手腕高于肩」算一次出手事件
export const SHOT_MIN_FRAMES = 4;

const HEAD_IDX = [0, 7, 8]; // 头顶近似点：鼻子与两只耳朵
const ANKLE_IDX = [27, 28];
const SHOULDER_IDX = [11, 12];
const HIP_IDX = [23, 24];

const finite = (v) => typeof v === "number" && Number.isFinite(v);
const visible = (p) => !!p && finite(p.x) && finite(p.y) && (p.visibility ?? 1) >= VIS_MIN;

/** 取一组关键点里「坐标有限且可见度达标」的那些点的均值（没有则返回 null） */
function meanPoint(lm, idxList) {
 const pts = idxList.map((i) => lm[i]).filter(visible);
 if (!pts.length) return null;
 return {
  x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
  y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
 };
}

/**
 * 躯干高：踝中点 y 与肩中点 y 之差（y 向下为正 → 正常站立时为正数）。
 * 负数意味着「脚比头还高」——关键点不可信（未全身入镜/误检），直接判无效。
 */
export function poseTorsoHeight(lm) {
 if (!Array.isArray(lm)) return null;
 const sh = meanPoint(lm, SHOULDER_IDX);
 const an = meanPoint(lm, ANKLE_IDX);
 if (!sh || !an) return null;
 return an.y - sh.y;
}

/**
 * 体高：头顶近似点到脚踝的纵向跨度（归一化，占画面高度的比例）。
 * 机位一致性检查里的「运镜幅度」（体高 p90/p10）用的就是这个量。
 */
export function poseBodyHeight(lm) {
 if (!Array.isArray(lm)) return null;
 const head = meanPoint(lm, HEAD_IDX);
 const an = meanPoint(lm, ANKLE_IDX);
 if (!head || !an) return null;
 return an.y - head.y;
}

/**
 * 有效姿态判定：
 *   ① 关键点齐全（至少到踝关节，索引 28）；
 *   ② 躯干中心的坐标有限；
 *   ③ 躯干高 > MIN_TORSO_H（负数直接判无效）。
 * aspect 目前不参与判定（保留参数是为了与调用方几何口径一致，也方便以后加横向判据）。
 */
export function isValidPose(landmarks, aspect = 1) {
 if (!Array.isArray(landmarks) || landmarks.length < 29) return false;
 const core = meanPoint(landmarks, [...SHOULDER_IDX, ...HIP_IDX]);
 if (!core) return false;
 const th = poseTorsoHeight(landmarks);
 if (th == null || !Number.isFinite(th)) return false;
 return th > MIN_TORSO_H;
}

/** 肩宽比：肩的水平跨度 × 宽高比 ÷ 躯干高——机位判定用的量（x 必须乘宽高比才是真实几何） */
export function shoulderRatio(lm, aspect = 1) {
 if (!Array.isArray(lm)) return null;
 const th = poseTorsoHeight(lm);
 if (!th || th <= 0) return null;
 const l = lm[11], r = lm[12];
 if (!finite(l?.x) || !finite(r?.x)) return null;
 return (Math.abs(l.x - r.x) * (aspect || 1)) / th;
}

/** 躯干中心（双肩 + 双髋平均）——轨迹关联的位置特征 */
export function torsoCenter(lm) {
 if (!Array.isArray(lm)) return null;
 const c = meanPoint(lm, [...SHOULDER_IDX, ...HIP_IDX]);
 return c ? { x: c.x, y: c.y } : null;
}

/**
 * 出手证据：手腕高于肩（y 更小 = 更高）。
 * 两只手腕取「更高的那只」——正面机位下出手臂不固定，两只都看更稳；
 * 手腕可见度不达标时不作数（外推出来的点不能当动作证据）。
 */
export function shotEvidence(lm) {
 if (!Array.isArray(lm)) return false;
 const sh = meanPoint(lm, SHOULDER_IDX);
 if (!sh) return false;
 const wrists = [lm[15], lm[16]].filter(visible);
 if (!wrists.length) return false;
 return Math.min(...wrists.map((w) => w.y)) < sh.y;
}

const median = (arr) => {
 const a = arr.filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
 if (!a.length) return 0;
 const m = a.length >> 1;
 return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

/**
 * 找出连续的手腕过肩段：返回 [{ from, to, frames }]，只保留长度 ≥ SHOT_MIN_FRAMES 的段。
 * frames 需按时间排序；相邻两帧的间隔超过 gapFrames 视为断开（中间人不见了）。
 */
export function findShotEvents(frames, gapFrames = 2) {
 const events = [];
 let run = [];
 const flush = () => {
  if (run.length >= SHOT_MIN_FRAMES) {
    events.push({ from: run[0].t, to: run[run.length - 1].t, frames: run.length });
  }
  run = [];
 };
 let lastT = null;
 for (const f of frames ?? []) {
  const on = shotEvidence(f.landmarks);
  if (on) {
    if (lastT != null && f.t - lastT > gapFrames / 30 + 1e-6) flush();
    run.push({ t: f.t, landmarks: f.landmarks });
  } else if (run.length) {
    flush();
  }
  lastT = on ? f.t : lastT;
 }
 flush();
 return events;
}

// 轨迹关联参数（运镜友好：门限放宽，体型用软约束）
const DIST_GATE = 0.15;   // 位置门限（宽高比校正后的归一化距离）
const SIZE_COST = 0.15;   // 体型相近度的代价权重（log 比值）
const SIZE_GATE = 3;      // 体型允许的 log 差（≈20 倍，容得下忽远忽近）
const MAX_GAP = 45;       // 连续多少帧没匹配上就判定轨迹结束（1.5s @30fps：人出画/被误检后回来）
const MAX_PRED_GAP = 0.2; // 间隔超过这个秒数就不做速度外推（长时间失联后位置不可信）

/**
 * 轨迹聚类：把每帧的全部候选姿态聚成若干条轨迹（贪心关联）。
 * 输入 frames: [{ t, poses: [lm, ...], aspect }]，输出 [{ id, frames: [{t, landmarks}], stats }]。
 * 无效姿态不参与关联（几何不可信，位置也不可信），因此不会进任何统计。
 */
export function buildTracks(frames, opts = {}) {
 const distGate = opts.distGate ?? DIST_GATE;
 const sizeCost = opts.sizeCost ?? SIZE_COST;
 const sizeGate = opts.sizeGate ?? SIZE_GATE;
 const maxGap = opts.maxGap ?? MAX_GAP;
 const tracks = [];
 let nextId = 1;
 const decisions = [];

 for (const f of frames ?? []) {
  const aspect = f.aspect ?? 1;
  const cands = [];
  for (const lm of f.poses ?? []) {
    if (!isValidPose(lm, aspect)) continue;
    const c = torsoCenter(lm);
    const bh = poseBodyHeight(lm);
    const th = poseTorsoHeight(lm);
    if (!c || bh == null || th == null) continue;
    cands.push({ lm, x: c.x, y: c.y, bh, th });
  }

  // 所有「轨迹 × 候选」的配对代价，贪心取最小
  const pairs = [];
  for (const tr of tracks) {
   if (tr.closed) continue;
   const dt = Math.max(1e-6, f.t - tr.lastT);
   // 位置预测：短暂失联时用速度外推（人不是原地不动的）；
   // 失联久了速度本身不可信，就用最后已知位置（门限放宽到 0.15，够人走一段再被认回）
   const useVel = dt <= MAX_PRED_GAP;
   const px = tr.lastX + (useVel ? tr.vx * dt : 0);
   const py = tr.lastY + (useVel ? tr.vy * dt : 0);
   for (let ci = 0; ci < cands.length; ci++) {
    const c = cands[ci];
    const d = Math.hypot((c.x - px) * aspect, c.y - py);
    if (d > distGate) continue;
    const ref = tr.bhRef > 0 ? tr.bhRef : c.bh;
    const lr = Math.abs(Math.log(c.bh / ref));
    if (lr > sizeGate) continue;
    pairs.push({ cost: d + sizeCost * lr, tr, ci, d });
   }
  }
  pairs.sort((a, b) => a.cost - b.cost);
  const usedTrack = new Set();
  const usedCand = new Set();
  for (const p of pairs) {
   if (usedTrack.has(p.tr) || usedCand.has(p.ci)) continue;
   usedTrack.add(p.tr);
   usedCand.add(p.ci);
   decisions.push({ t: f.t, track: p.tr.id, cand: p.ci, cost: p.cost, d: p.d });
   p.tr.frames.push({ t: f.t, landmarks: cands[p.ci].lm });
   p.tr.bhs.push(cands[p.ci].bh);
   p.tr.xs.push(cands[p.ci].x);
   // 体型基准跟着轨迹更新（取中位数）：镜头推拉时人的表观体型会变，
   // 固定基准会把「人变远了」误判成「换人了」
   p.tr.bhRef = median(p.tr.bhs);
   const prevX = p.tr.lastX, prevY = p.tr.lastY, prevT = p.tr.lastT;
   p.tr.vx = (cands[p.ci].x - prevX) / (f.t - prevT || 1);
   p.tr.vy = (cands[p.ci].y - prevY) / (f.t - prevT || 1);
   p.tr.lastX = cands[p.ci].x;
   p.tr.lastY = cands[p.ci].y;
   p.tr.lastT = f.t;
   p.tr.missed = 0;
  }
  // 没被任何轨迹认领的候选 → 新开一条轨迹
  for (let ci = 0; ci < cands.length; ci++) {
   if (usedCand.has(ci)) continue;
   const c = cands[ci];
   decisions.push({ t: f.t, track: null, cand: ci, cost: null, d: null });
   tracks.push({
    id: nextId++,
    frames: [{ t: f.t, landmarks: c.lm }],
    bhs: [c.bh],
    xs: [c.x],
    lastX: c.x, lastY: c.y, lastT: f.t, vx: 0, vy: 0, missed: 0, closed: false,
    bhRef: c.bh,
   });
  }
  // 长时间没匹配上的轨迹结束（人可以走出画面再回来，回来时另起一条）
  for (const tr of tracks) {
   if (usedTrack.has(tr)) continue;
   tr.missed++;
   if (tr.missed > maxGap) tr.closed = true;
  }
 }

 for (const tr of tracks) {
  const events = findShotEvents(tr.frames);
  // 出手时刻的横向位置：报告里说「画面 x 处正在出手的那个」，
  // 指的是他出手时站在哪——用整条轨迹的中位会把位置说偏
  // （真实素材里，人是在出手的同时往画面右边走出画面的）
  const shotFrames = tr.frames.filter((f) =>
   events.some((e) => f.t >= e.from - 1e-6 && f.t <= e.to + 1e-6)
  );
  tr.stats = {
   frames: tr.frames.length,
   shotEvents: events.length,
   shotSpans: events.map((e) => ({ from: e.from, to: e.to })),
   bodyHeight: median(tr.bhs),
   torsoHeight: median(tr.frames.map((fr) => poseTorsoHeight(fr.landmarks) ?? 0)),
   x: median(tr.xs),
   shotX: shotFrames.length ? median(shotFrames.map((f) => torsoCenter(f.landmarks)?.x ?? NaN)) : null,
   from: tr.frames[0]?.t ?? 0,
   to: tr.frames[tr.frames.length - 1]?.t ?? 0,
  };
 }
 const result = tracks.filter((tr) => tr.frames.length > 0);
 if (typeof opts.onDecision === "function") opts.onDecision(decisions, result);
 return result;
}

/**
 * 选主体：优先「有出手事件」的轨迹 → 其次有效帧最多 → 再次体高最大。
 * 返回 { track, reason }（reason 是给用户看的中文说明）。
 */
export function selectSubject(tracks) {
 const list = (tracks ?? []).filter((t) => t && t.frames?.length);
 if (!list.length) return { track: null, reason: "没有找到任何有效的人体轨迹" };
 const sorted = [...list].sort((a, b) => {
  const sa = a.stats.shotEvents > 0 ? 1 : 0;
  const sb = b.stats.shotEvents > 0 ? 1 : 0;
  if (sa !== sb) return sb - sa; // 有出手动作的优先
  if (b.stats.frames !== a.stats.frames) return b.stats.frames - a.stats.frames; // 有效帧多的优先
  return b.stats.bodyHeight - a.stats.bodyHeight; // 体高大的优先
 });
 const best = sorted[0];
 const reason = best.stats.shotEvents > 0
  ? `有出手动作（${best.stats.shotSpans
      .map((s) => `${s.from.toFixed(1)}–${s.to.toFixed(1)}s`)
      .join("、")}），有效帧 ${best.stats.frames}`
  : `有效帧最多（${best.stats.frames} 帧），但没检测到出手动作`;
 return { track: best, reason, candidates: sorted };
}

/** 画面位置的粗略描述（用于报告里说明「画面 x 处」） */
export function describePosition(x) {
 if (!Number.isFinite(x)) return "画面中";
 if (x < 0.34) return "画面左侧";
 if (x > 0.66) return "画面右侧";
 return "画面中间";
}

/**
 * 把扫描结果（每帧全部候选姿态）变成分析用的帧序列：
 * 只有被选中轨迹的帧带 landmarks，其余帧 landmarks = null（算「未计入」）。
 * 同时把帧的账算清楚：检出多少帧、剔除了多少无效姿态、有效多少帧、主体占多少帧。
 */
export function applySubject(scanFrames, tracks) {
 const { track, reason } = selectSubject(tracks);
 const subjectAt = new Map();
  if (track) for (const f of track.frames) subjectAt.set(f.t, f.landmarks);
  const frames = [];
  let detected = 0, invalid = 0, valid = 0, subjectFrames = 0, otherFrames = 0;
  for (const f of scanFrames ?? []) {
    const poses = f.poses ?? [];
    if (poses.length) detected++;
    const validCount = poses.filter((lm) => isValidPose(lm, f.aspect)).length;
    if (poses.length && !validCount) invalid++; // 这一帧有人，但姿态几何不可信 → 剔除
    if (validCount) valid++;
    const lm = subjectAt.get(f.t) ?? null;
    if (lm) subjectFrames++;
    else if (validCount) otherFrames++; // 有有效姿态但不属于主体（别人）→ 未计入
    frames.push({ t: f.t, landmarks: lm, aspect: f.aspect });
  }
  return {
    frames,
    subject: { track, reason },
    stats: { total: frames.length, detected, invalid, valid, subjectFrames, otherFrames },
  };
}

/**
 * 视频级帧序列（每帧取「任何一个可信的人」）——素材质量评估用：
 * 质量问的是「这段素材本身好不好」，不是「锁定的那个人好不好」。
 */
export function videoLevelFrames(scanFrames) {
  return (scanFrames ?? []).map((f) => {
    const poses = (f.poses ?? []).filter((lm) => isValidPose(lm, f.aspect));
    return { t: f.t, landmarks: poses[0] ?? null, aspect: f.aspect };
  });
}
