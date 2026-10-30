// 第五轮（收官）对抗审查：回归 + 突破 + 端到端（node test/round5-final.mjs）
import { makePersonPicker } from "../js/media.js";
import { detectShotCycles, computeMetrics } from "../js/metrics.js";
import { drawFrame } from "../js/draw.js";

const ASPECT = 1080 / 1920, FPS = 30;
let fails = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`  ✅ ${name}`);
  else { fails++; console.log(`  ❌ ${name}${detail ? " —— " + detail : ""}`); }
};
const log = (s) => console.log(`  · ${s}`);

const mkPose = (cx, cy, size, vis = 0.9) => {
  const lm = Array.from({ length: 33 }, () => ({ x: cx, y: cy, visibility: vis }));
  lm[0] = { x: cx, y: cy - size / 2, visibility: vis };
  for (const i of [11, 12]) lm[i] = { x: cx, y: cy - size / 2 + 0.04, visibility: vis };
  for (const i of [23, 24]) lm[i] = { x: cx, y: cy, visibility: vis };
  for (const i of [25, 26]) lm[i] = { x: cx, y: cy + size / 2 - 0.08, visibility: vis };
  for (const i of [27, 28]) lm[i] = { x: cx, y: cy + size / 2, visibility: vis };
  return lm;
};

// 完整侧面姿态（供周期检测）：远侧链可见度 0.35
function sidePose({ nose, sh, el, wr, hip, knee, ank, kx = 0.04, vis = 0.9 }) {
  const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: hip, visibility: vis }));
  const put = (i, dx, y, v = vis) => (lm[i] = { x: 0.5 + dx, y, visibility: v });
  put(0, 0, nose);
  put(11, -0.02, sh, 0.35); put(12, 0, sh);
  put(13, -0.02, el, 0.35); put(14, kx, el);
  put(15, -0.02, wr, 0.35); put(16, 0, wr);
  put(23, -0.02, hip, 0.35); put(24, 0, hip);
  put(25, -0.02, knee, 0.35); put(26, kx, knee);
  put(27, -0.02, ank, 0.35); put(28, 0, ank);
  return lm;
}
// 关键帧间线性插值（插值 {x,y,visibility} 对象本身）
function buildFrames(keyIdx, poses) {
  const frames = [];
  const last = keyIdx[keyIdx.length - 1];
  for (let i = 0; i <= last; i++) {
    let k = 0;
    while (k < keyIdx.length - 1 && i > keyIdx[k + 1]) k++;
    const t0 = keyIdx[k], t1 = keyIdx[Math.min(k + 1, keyIdx.length - 1)];
    const r = t1 === t0 ? 0 : (i - t0) / (t1 - t0);
    const a = poses[k], b = poses[Math.min(k + 1, poses.length - 1)];
    frames.push(Array.from({ length: 33 }, (_, j) => {
      const p = a[j] ?? b[j], q = b[j] ?? a[j];
      if (!p || !q) return p ?? q ?? { x: 0.5, y: 0.5, visibility: 0.5 };
      return { x: p.x + (q.x - p.x) * r, y: p.y + (q.y - p.y) * r,
        visibility: Math.min(p.visibility ?? 1, q.visibility ?? 1) };
    }));
  }
  return frames;
}
// 一次完整出手（站→蹲→蹬→出手→跟随→落地），96 帧
const SHOT_KEYS = [0, 36, 42, 50, 65, 95];
const SHOT_POSES = [
  sidePose({ nose: 0.25, sh: 0.32, el: 0.42, wr: 0.50, hip: 0.55, knee: 0.75, ank: 0.95 }),
  sidePose({ nose: 0.33, sh: 0.40, el: 0.47, wr: 0.44, hip: 0.62, knee: 0.78, ank: 0.95, kx: 0.12 }), // 膝角≈135°——真下蹲必屈膝，共线三点物理上蹲不下去
  sidePose({ nose: 0.30, sh: 0.36, el: 0.44, wr: 0.44, hip: 0.50, knee: 0.74, ank: 0.95, kx: 0.10 }),
  sidePose({ nose: 0.28, sh: 0.34, el: 0.28, wr: 0.15, hip: 0.50, knee: 0.74, ank: 0.95 }),
  sidePose({ nose: 0.28, sh: 0.34, el: 0.24, wr: 0.13, hip: 0.50, knee: 0.74, ank: 0.95 }),
  sidePose({ nose: 0.26, sh: 0.33, el: 0.30, wr: 0.20, hip: 0.55, knee: 0.76, ank: 0.95 }),
];
const shotSeq = buildFrames(SHOT_KEYS, SHOT_POSES);
const STAND = SHOT_POSES[0];

console.log("—— 第 1 部分：前四轮攻击序列在终版上的回归 ——");

{ // R1 贴身遮挡
  const p = makePersonPicker();
  const H = mkPose(0.5, 0.5, 0.6), Q = mkPose(0.25, 0.5, 0.35);
  check("R1 首帧锁定", p.pick([H]) === H);
  let bad = 0;
  for (let i = 0; i < 30; i++) if (p.pick([Q]) !== null) bad++;
  check("R1 遮挡期 30 帧全冻结、锁不交给遮挡者", bad === 0, `bad=${bad}`);
  check("R1 主人公回归即恢复", p.pick([H, Q]) === H);
}
{ // R2 教练蹲姿期夺锁（教练更近镜头、随主人公同步蹲低；短保持）
  const p = makePersonPicker();
  p.pick([mkPose(0.5, 0.5, 0.6)]);
  let bad = 0, first = null;
  for (let f = 0; f < 60; f++) {
    const r = f / 59;
    const H = mkPose(0.5, 0.5 + 0.12 * r, 0.6 - 0.18 * r);
    const C = mkPose(0.68, 0.5 + 0.10 * r, 0.75 - 0.20 * r);
    const got = p.pick([H, C]);
    if (got !== H) { bad++; first ??= f; }
  }
  check("R2 教练蹲姿期 60 帧全程不夺锁", bad === 0, `bad=${bad} first=${first}`);
}
{ // R3 取球往返：整段离场（画面无人，lost 不推进）→ 回归记忆未塌
  const p = makePersonPicker();
  p.pick([mkPose(0.5, 0.5, 0.6)]);
  let bad = 0;
  for (let i = 0; i < 90; i++) if (p.pick([]) !== null) bad++;
  check("R3 离场 3s 全 null", bad === 0, `bad=${bad}`);
  const back = mkPose(0.5, 0.5, 0.54);
  check("R3 回归即恢复（记忆未塌、0.9 倍体型仍在带内）", p.pick([back]) === back);
}
{ // R4 大队友贴站 60 帧
  const p = makePersonPicker();
  const H = mkPose(0.5, 0.5, 0.6), M = mkPose(0.6, 0.5, 0.84);
  p.pick([H]); p.pick([H, M]);
  let bad = 0;
  for (let f = 0; f < 60; f++) if (p.pick([H, M]) !== H) bad++;
  check("R4 1.4× 队友贴站 60 帧不夺锁（距离平票 + 1.8 线双保险）", bad === 0, `bad=${bad}`);
}
{ // R5 超时重锁远处小人 + 回归夺回
  const p = makePersonPicker();
  const Q = mkPose(0.25, 0.5, 0.2);
  p.pick([mkPose(0.5, 0.5, 0.6)]);
  let held = 0, relockAt = -1;
  for (let i = 0; i < 200; i++) {
    const got = p.pick([Q]);
    if (got === null) held++;
    else if (relockAt < 0) relockAt = i;
  }
  check("R5 恰好 150 帧冻结后重锁（HOLD_MAX 单位=pick 调用帧）", held === 150 && relockAt === 150,
    `held=${held} relockAt=${relockAt}`);
  const H = mkPose(0.5, 0.5, 0.6);
  check("R5 主人公回归凭体积夺回", p.pick([H, Q]) === H);
}
{ // R6 体型不符替身站进原位 → 不许继承
  const p = makePersonPicker();
  const H0 = mkPose(0.5, 0.5, 0.6);
  p.pick([H0]);
  const Sub = mkPose(0.5, 0.5, 0.3), Big = mkPose(0.5, 0.5, 1.0);
  let bad = 0;
  for (let i = 0; i < 30; i++) { if (p.pick([Sub]) !== null) bad++; if (p.pick([Big]) !== null) bad++; }
  check("R6 小替身/过大替身（1.67×）各 30 帧全部拒绝", bad === 0, `bad=${bad}`);
  const H = mkPose(0.5, 0.5, 0.6);
  check("R6 主人公回归恢复", p.pick([H, Sub]) === H);
}
{ // R7 深蹲塌缩 + 透视队友（站高 0.55 蹲到 0.36，队友 0.5=0.91× 在 0.22 外）
  const p = makePersonPicker();
  const mate = mkPose(0.28, 0.5, 0.5);
  p.pick([mkPose(0.5, 0.5, 0.55)]);
  p.pick([mkPose(0.5, 0.5, 0.55), mate]);
  let bad = 0;
  for (let f = 0; f < 60; f++) {
    const r = Math.min(1, f / 8);
    const Hc = mkPose(0.5, 0.5 + 0.1 * r, 0.55 - 0.19 * r);
    if (p.pick([Hc, mate]) !== Hc) bad++;
  }
  check("R7 深蹲塌缩+0.91× 队友 60 帧不丢锁", bad === 0, `bad=${bad}`);
}
{ // R8 HOLD_MAX 单位：空帧（无人）不推进等待计数
  const p = makePersonPicker();
  const Q = mkPose(0.25, 0.5, 0.2);
  p.pick([mkPose(0.5, 0.5, 0.6)]);
  for (let i = 0; i < 100; i++) p.pick([]);
  let held = 0;
  for (let i = 0; i < 60; i++) if (p.pick([Q]) === null) held++;
  const H = mkPose(0.5, 0.5, 0.6);
  check("R8 空帧不推进计数 → 60 帧替身期后回归直接恢复", held === 60 && p.pick([H, Q]) === H, `held=${held}`);
}

console.log("\n—— 第 2 部分：突破攻击（数值边界） ——");

{ // A. 突破点①：站高记忆被蹲姿拉低 → 1.8 换锁线被侵蚀（1.8×蹲姿 ≈ 1.26–1.44×站高，透视范围内）
  console.log("  A. 蹲深 × 队友体型（×站高）→ 队友夺锁所需保持帧（120 帧内未夺锁记 —）");
  const ratios = [0.85, 0.78, 0.75, 0.72, 0.65, 0.60];
  const mates = [1.15, 1.2, 1.3, 1.4, 1.5];
  let header = "  蹲深\\队友 ";
  for (const m of mates) header += ` | ${String(m).padStart(4)}`;
  console.log(header);
  for (const ratio of ratios) {
    let row = `  ${(ratio * 100).toFixed(0).padStart(4)}%    `;
    for (const mf of mates) {
      const p = makePersonPicker();
      const M = mkPose(0.15, 0.5, 0.6 * mf);
      for (let i = 0; i < 30; i++) p.pick([mkPose(0.5, 0.5, 0.6)]); // 站立稳定记忆
      for (let i = 0; i < 8; i++) { // 8 帧蹲下
        const r = (i + 1) / 8;
        p.pick([mkPose(0.5, 0.5 + 0.12 * r, 0.6 + (0.6 * ratio - 0.6) * r)]);
      }
      let steal = -1;
      for (let i = 0; i < 120; i++) { // 队友从保持第 0 帧起就在画面里
        const got = p.pick([mkPose(0.5, 0.62, 0.6 * ratio), M]);
        if (got === M) { steal = i; break; }
      }
      row += ` | ${String(steal < 0 ? "—" : steal).padStart(4)}`;
    }
    console.log(row);
  }
  log("解读：队友因子 > 1.8×蹲深 时换锁必触发；触发帧 ≈ ln(f/1.8)/ln(0.99)。设计注释①声称『更大的队友贴站都不动摇』、" +
    "②声称『蹲起不拉低』——蹲持 ≳0.9–1.4s 后两者同时失效");
}
{ // A2. 突破点①完整后果链：蹲持期被夺锁 → 起身+出手全程夺不回
  const p = makePersonPicker();
  const M = mkPose(0.15, 0.5, 0.84); // 1.4× 站高
  for (let i = 0; i < 30; i++) p.pick([mkPose(0.5, 0.5, 0.6)]);
  for (let i = 0; i < 8; i++) p.pick([mkPose(0.5, 0.5 + 0.019 * (i + 1), 0.6 - 0.019 * (i + 1))]); // 蹲到 0.45（0.75×）
  let steal = -1;
  for (let i = 0; i < 90; i++) if (p.pick([mkPose(0.5, 0.62, 0.45), M]) === M) { steal = i; break; }
  const H = mkPose(0.5, 0.5, 0.6);
  const r1 = p.pick([H, M]); // 起身第一帧
  let hero = 0;
  for (let i = 0; i < 100; i++) if (p.pick([H, M]) === H) hero++;
  check("A2 蹲持 0.75× 深度时 1.4× 队友中途夺锁（记忆衰减→换锁通道）", steal >= 0, `steal=${steal}`);
  check("A2 起身后当帧夺回（换锁时刻的 ghost 印象）", steal >= 0 && r1 === H && hero === 100,
    `r1=${r1 === M ? "队友" : r1 === H ? "主人公" : "null"} hero=${hero}`);
}
{ // B. 离场 160 帧重锁到路人（体型=主人公×t，站在主人公原位）后，主人公回归能否夺回
  console.log("  B. 离场 160 帧重锁到路人（体型=主人公×t，站原位）后，主人公回归 170 帧内首次夺回帧：");
  const probe = (t) => {
    const p = makePersonPicker();
    p.pick([mkPose(0.5, 0.5, 0.6)]);
    for (let i = 0; i < 160; i++) p.pick([mkPose(0.5, 0.5, 0.6 * t)]); // 路人就站在主人公原位
    const H = mkPose(0.5, 0.5, 0.6);
    for (let i = 0; i < 170; i++) if (p.pick([H, mkPose(0.5, 0.5, 0.6 * t)]) === H) return i;
    return -1;
  };
  const ts = [0.2, 0.4, 0.54, 0.55, 0.556, 0.56, 0.7, 1.0, 1.3];
  let row = "  t(比值)  ";
  for (const t of ts) row += ` | ${String(t).padStart(4)}`;
  console.log(row);
  row = "  首次夺回 ";
  for (const t of ts) row += ` | ${String(probe(t)).padStart(4)}`;
  console.log(row);
  log("解读：t<0.556 路人带外→冻结期记 ghost，回归当帧认回；t≥1.15 继承瞬间体型跳升>1.15×" +
    "同样记 ghost（原主回归凭更低体型偏差夺回）；只剩 0.556–1.15× 带内平替无缝继承无任何" +
    "事件可记，现任平局裁决永远赢——2D 骨架物理不可分（极限a）；t=1.0 同体同位纯属喂入顺序巧合");
  check("B2 带外替身（0.4×）：冻结期 ghost 认回，回归当帧夺回", probe(0.4) === 0, `first=${probe(0.4)}`);
  check("B3 已知极限a：0.58× 带内平替无缝继承，170 帧内夺不回（物理不可分）", probe(0.58) === -1, `first=${probe(0.58)}`);
  check("B4 已知极限a：0.7× 同上", probe(0.7) === -1, `first=${probe(0.7)}`);
  check("B5 更大替身（1.3×）：继承瞬间的体型跳升触发 ghost，回归当帧夺回", probe(1.3) === 0, `first=${probe(1.3)}`);
}
{ // C. 主人公远去（每帧体型收缩 r）——0.55 下限何时断链；单人场景能否自愈
  console.log("  C. 远去扫描（单人，900 帧）：每帧收缩率 → 首个 null 帧 / 冻结后重锁目标");
  for (const r of [0.004, 0.008, 0.010, 0.012, 0.015, 0.020, 0.030]) {
    const p = makePersonPicker();
    p.pick([mkPose(0.5, 0.5, 0.6)]);
    let firstNull = -1, nulls = 0;
    for (let f = 1; f <= 900; f++) {
      const got = p.pick([mkPose(0.5, 0.5, Math.max(0.05, 0.6 * (1 - r) ** f))]);
      if (got === null) { nulls++; if (firstNull < 0) firstNull = f; }
    }
    console.log(`  r=${r.toFixed(3)}/帧 (${(r * 30 * 100).toFixed(0)}%/s): 首null帧=${firstNull} 总null=${nulls}（单人重锁回主人公，可自愈）`);
  }
  log("解读：记忆按 max(现值, 0.99×记忆) 衰减——r≤1%/帧全程跟随；r≥1.5%/帧（3m 外 1.4m/s 步行 away）" +
    "在体型仍可检测（≈0.1）时断链 → 冻结 150 帧");
}
{ // C2. 快速远去 + 静态更大队友 → 重锁给队友 → 主人公回身夺不回（路线并入突破点②）
  const p = makePersonPicker();
  const M = mkPose(0.15, 0.5, 0.78);
  p.pick([mkPose(0.5, 0.5, 0.6)]);
  p.pick([mkPose(0.5, 0.5, 0.6), M]);
  let nulls = 0, relock = null;
  for (let f = 1; f <= 600; f++) {
    const H = mkPose(0.5, 0.5, Math.max(0.08, 0.6 * 0.985 ** f));
    const got = p.pick([H, M]);
    if (got === null) nulls++;
    else if (got === M && nulls > 100) { relock = f; break; }
  }
  const H = mkPose(0.5, 0.5, 0.6);
  let hero = 0;
  for (let i = 0; i < 100; i++) if (p.pick([H, M]) === H) hero++;
  check("C2 快速远去断链→重锁给 1.3× 队友→主人公回原位：冻结起点的 ghost 印象夺回（原以为断链点远离原位必丢，实测记忆体型足够接近仍可认回）",
    hero === 100, `relock=${relock} hero=${hero}`);
}
{ // D. 从画面深处走近镜头（渐大）——记忆即时抬升，1.6 上限不应拒匹配
  const run = (label, from, to, frames) => {
    const p = makePersonPicker();
    p.pick([mkPose(0.5, 0.5, from)]);
    let miss = 0;
    for (let f = 1; f <= frames; f++) if (p.pick([mkPose(0.5, 0.5, from + (to - from) * f / frames)]) === null) miss++;
    log(`${label}: null=${miss}`);
  };
  run("D1 渐大 1.3×/120帧", 0.45, 0.585, 120);
  run("D2 渐大 1.44×/60帧", 0.45, 0.65, 60);
  run("D3 单帧跳 1.58×（0.6→0.95）", 0.6, 0.95, 1);
  const p = makePersonPicker();
  p.pick([mkPose(0.5, 0.5, 0.6)]);
  let miss = 0, relock = -1;
  for (let f = 1; f <= 250; f++) { if (p.pick([mkPose(0.5, 0.5, 1.0)]) === null) miss++; else if (relock < 0) relock = f; }
  log(`D4 单帧跳 1.67×（0.6→1.0，带外但未到 1.8 换锁线，检测器突见全身才可能出现）: null=${miss} 重锁帧=${relock}（5s 后自愈）`);
}
{ // E. 手持抖动 ±0.05 与双人分离度的交互
  console.log("  E. 双人分离度扫描（队友 1.4×，整体抖动 ±0.05，120 帧）：队友被拾取帧数 / 交替次数");
  for (const sep of [0.06, 0.10, 0.14, 0.18, 0.22, 0.26]) {
    const p = makePersonPicker();
    const H0 = mkPose(0.5, 0.5, 0.6), M0 = mkPose(0.5 + sep, 0.5, 0.84);
    p.pick([H0]); p.pick([H0, M0]);
    let mate = 0, flips = 0, prev = "H";
    for (let f = 1; f <= 120; f++) {
      const shake = 0.05 * Math.sin((2 * Math.PI * f) / 10);
      const H = mkPose(0.5 + shake + 0.01 * Math.sin(f * 1.7), 0.5 + 0.3 * shake, 0.6);
      const M = mkPose(0.5 + sep + shake + 0.01 * Math.cos(f * 1.3), 0.5 + 0.3 * shake, 0.84);
      const got = p.pick([H, M]);
      const who = got === H ? "H" : "M";
      if (who === "M") mate++;
      if (who !== prev) flips++;
      prev = who;
    }
    console.log(`  sep=${sep.toFixed(2)}: 队友帧=${mate} 交替=${flips}`);
  }
  log("解读：分离 ≲ 抖动幅度时拾取在两人间闪烁——属已接受极限①（0.2 内体型相近者无法区分）的伴生现象，单人不丢锁");
}
{ // F. 1.8 换锁线数值边界（严格大于）
  const t = (ratio) => {
    const p = makePersonPicker();
    const H = mkPose(0.5, 0.5, 0.6), M = mkPose(0.9, 0.5, 0.6 * ratio);
    p.pick([H]);
    return p.pick([H, M]) === M;
  };
  check("F1 恰好 1.8× 不触发换锁（严格 >）", t(1.8) === false);
  check("F2 1.8001× 触发换锁（已接受极限②）", t(1.8001) === true);
}
{ // G. 相机摇走再摇回：空帧不推进 lost → 主人公在新位置入画后仍要再冻结满 150 帧
  const p = makePersonPicker();
  p.pick([mkPose(0.5, 0.5, 0.6)]);
  for (let i = 0; i < 300; i++) p.pick([]); // 摇向观众席 10s
  let nulls = 0, relock = -1;
  for (let i = 0; i < 250; i++) { if (p.pick([mkPose(0.15, 0.5, 0.6)]) === null) nulls++; else if (relock < 0) relock = i; }
  check("G1 对照：摇回后主人公在原位入画立即恢复", (() => {
    const q = makePersonPicker(); q.pick([mkPose(0.5, 0.5, 0.6)]);
    for (let i = 0; i < 300; i++) q.pick([]);
    return q.pick([mkPose(0.5, 0.5, 0.6)]) !== null;
  })());
  check("G2 摇回后在新位置入画：冻结整整 150 帧（≈5s 空洞）才重锁", nulls === 150 && relock === 150,
    `nulls=${nulls} relock=${relock}`);
  log("解读：锁点位置在场景整体移动后已失效，但 freeze 不区分『遮挡』与『场景已变』——若同框有更大路人，重锁并入突破点②");
}
{ // H. 衰减数值表
  const row = [30, 47, 60, 90, 120, 150, 300].map((n) => `${n}帧:${(0.99 ** n).toFixed(3)}`).join("  ");
  log(`0.99^N 衰减表（对『比记忆小』的帧逐帧累乘）：${row}`);
  log("『缓慢远去 10s』：只要收缩 ≤1%/帧，记忆=当前体型精确跟随（0.99^N 是理论上限，实际到体型即停）；" +
    "『1.5× 队友何时能继承』：与衰减无关——1.5 < 1.6 恒在带内，只要距锁定点 ≤0.2（已接受极限①）");
}

console.log("\n—— 第 3 部分：端到端（scanIntoInner→detectShotCycles→computeMetrics→drawFrame 链路） ——");

function runScene(scenePerFrame) {
  const picker = makePersonPicker();
  const out = [];
  scenePerFrame.forEach((scene, i) => {
    out.push({ t: i / FPS, landmarks: picker.pick(scene), aspect: ASPECT });
  });
  out.peopleSeen = picker.peopleSeen;
  return out;
}

{ // S1: 4.9s 空 null 段（画面无人）穿过整条链路
  const gapStart = 126, gap = 147;
  const hero = [...shotSeq, ...Array(30).fill(STAND), ...Array(gap).fill(null), ...shotSeq, ...Array(30).fill(STAND)];
  const frames = runScene(hero.map((lm, i) => (i >= gapStart && i < gapStart + gap ? [] : [lm])));
  const detected = frames.filter((f) => f.landmarks).length;
  const { cycles } = detectShotCycles(frames, "right", FPS);
  const inGap = cycles.filter((c) => c.releaseIdx >= gapStart && c.releaseIdx <= gapStart + gap + 2);
  let finite = true;
  for (const c of cycles) for (const m of computeMetrics(frames, c, "right", "jump", "side")) if (!isFinite(m.num)) finite = false;
  check("S1 4.9s 空 null 段：2 次出手全部检出", cycles.length === 2, `n=${cycles.length}`);
  check("S1 检出周期不在 null 段内", inGap.length === 0, JSON.stringify(inGap.map((c) => c.releaseIdx)));
  check("S1 两周期指标全部有限", finite);
  check("S1 detected 计数 = 399-147 = 252", detected === 252, `detected=${detected}`);
  check("S1 peopleSeen=1", frames.peopleSeen === 1, `${frames.peopleSeen}`);
}
{ // S2: 4.9s 离场期间画面里留着一个远处小替身（147 帧 < 150 → 不重锁）
  const gapStart = 126, gap = 147;
  const dbl = mkPose(0.2, 0.5, 0.2);
  const hero = [...shotSeq, ...Array(30).fill(STAND), ...Array(gap).fill(null), ...shotSeq, ...Array(30).fill(STAND)];
  const frames = runScene(hero.map((lm, i) => (i >= gapStart && i < gapStart + gap ? [dbl] : [lm])));
  const { cycles } = detectShotCycles(frames, "right", FPS);
  const inGap = cycles.filter((c) => c.releaseIdx >= gapStart && c.releaseIdx <= gapStart + gap + 2);
  check("S2 离场期有小替身：仍冻结不重锁，回归后 2 周期全检出", cycles.length === 2 && inGap.length === 0,
    `n=${cycles.length}`);
}
{ // S3: 5.1s 离场（153 帧 > 150 → 第 151 帧重锁到小替身）→ 回归后 1.8× 夺回
  const gapStart = 126, gap = 153;
  const dbl = mkPose(0.2, 0.5, 0.2);
  const hero = [...shotSeq, ...Array(30).fill(STAND), ...Array(gap).fill(null), ...shotSeq, ...Array(30).fill(STAND)];
  const frames = runScene(hero.map((lm, i) => (i >= gapStart && i < gapStart + gap ? [dbl] : [lm])));
  const { cycles } = detectShotCycles(frames, "right", FPS);
  const dblPicked = frames.filter((f) => f.landmarks === dbl).length;
  const inGap = cycles.filter((c) => c.releaseIdx >= gapStart && c.releaseIdx <= gapStart + gap + 2);
  check("S3 超时重锁到小替身（3 帧替身被拾取）", dblPicked === gap - 150, `dblPicked=${dblPicked}`);
  check("S3 主人公回归夺回且 2 周期全检出、无周期落在空洞", cycles.length === 2 && inGap.length === 0,
    `n=${cycles.length}`);
}
{ // S4: 深蹲捡球保持 2s 后起身出手（单人）——确认不会自我锁丢
  const deep = sidePose({ nose: 0.53, sh: 0.56, el: 0.60, wr: 0.66, hip: 0.72, knee: 0.84, ank: 0.95 });
  const keys = [0, 30, 38, 98, 104, 118, 132, 160, 190];
  const poses = [SHOT_POSES[0], SHOT_POSES[0], deep, deep, SHOT_POSES[0], SHOT_POSES[3], SHOT_POSES[4], SHOT_POSES[5], STAND];
  const frames = runScene(buildFrames(keys, poses).map((lm) => [lm]));
  const nullCount = frames.filter((f) => f.landmarks === null).length;
  const { cycles } = detectShotCycles(frames, "right", FPS);
  check("S4 深蹲(0.60×)保持 60 帧→起身：全程零 null（起身渐大被记忆即时抬升，1.6 上限不拒匹配）",
    nullCount === 0, `null=${nullCount}`);
  check("S4 起身后的出手被正常检出（1 周期，指标有限）", (() => {
    if (cycles.length !== 1) return false;
    return computeMetrics(frames, cycles[0], "right", "jump", "side").every((m) => isFinite(m.num));
  })(), `n=${cycles.length}`);
}
{ // S5: 突破点①端到端——蹲持期被队友夺锁，起身后的第二次出手全程被路人骨架顶替
  const deep = sidePose({ nose: 0.53, sh: 0.56, el: 0.60, wr: 0.66, hip: 0.72, knee: 0.84, ank: 0.95 });
  const mate = mkPose(0.15, 0.5, 0.84); // 1.4× 站高，远处
  const squatSeq = buildFrames([0, 8, 68, 75], [SHOT_POSES[0], deep, deep, SHOT_POSES[0]]); // 蹲下→保持 3s→起身
  const scene = [];
  for (let i = 0; i < 300; i++) {
    if (i < 126) scene.push([shotSeq[i]]);            // 出手 A + 站姿
    else if (i < 201) scene.push([squatSeq[i - 126], mate]); // 蹲下/保持/起身（队友第 8 帧入画）
    else scene.push([shotSeq[i - 201], mate]);        // 出手 B（起身之后）
  }
  const frames = runScene(scene);
  const mateFrom = frames.findIndex((f) => f.landmarks === mate);
  const shotB = frames.slice(226);
  const shotBPickedByMate = shotB.filter((f) => f.landmarks === mate).length;
  const { cycles } = detectShotCycles(frames, "right", FPS);
  check("S5 蹲持期内队友夺锁（记忆衰减→换锁通道，但换锁时刻已记 ghost 印象）", mateFrom > 0 && mateFrom < 190,
    `mateFrom=${mateFrom}`);
  check("S5 起身后主人公凭 ghost 夺回，第二次出手全部回到本人骨架",
    shotB.filter((f) => f.landmarks && f.landmarks !== mate).length === shotB.filter((f) => f.landmarks).length
      && shotBPickedByMate < shotB.length,
    `${shotBPickedByMate}/${shotB.length} 被顶替`);
  check("S5 两次出手全部检出（无静默丢失）", cycles.length === 2, `n=${cycles.length}`);
  log(`S5 peopleSeen=${frames.peopleSeen}（状态栏提示「画面出现 N 人」）`);
}
{ // S6: 骨架绘制：null 帧与全零可见度帧都不得抛错
  const stub = new Proxy({}, {
    get: (t, k) => (k === "canvas" ? { width: 1080, height: 1920 } : (t[k] ??= (..._a) => stub)),
    set: () => true,
  });
  let ok = true;
  try {
    drawFrame(stub, null, { showSkeleton: true, showJoints: true, showAngles: true, side: "right" });
    drawFrame(stub, STAND, { showSkeleton: true, showJoints: true, showAngles: true, side: "right" });
    drawFrame(stub, STAND.map((l) => ({ ...l, visibility: 0 })), { showSkeleton: true, showJoints: true, showAngles: true, side: "right" });
  } catch (e) { ok = false; console.log(e); }
  check("S6 drawFrame 对 null / 全零可见度帧不抛错", ok);
}

console.log(fails === 0 ? "\n🎉 全部通过" : `\n💥 ${fails} 项未达预期（突破点见 A/B/G 与 S5）`);
