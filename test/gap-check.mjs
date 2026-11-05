// 长段 null 帧（主人公离场）穿过整条分析链路的实测（node test/gap-check.mjs）
// 每个场景都带断言：全部符合预期时输出「🎉 全部通过」，否则退出码非 0
import { detectShotCycles, computeMetrics } from "../js/metrics.js";

const ASPECT = 1080 / 1920, FPS = 30;
let fails = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`  ✅ ${name}`);
  else { fails++; console.log(`  ❌ ${name}${detail ? " —— " + detail : ""}`); }
};
function buildFrames(keyIdx, poses, mirror) {
  const frames = [];
  const last = keyIdx[keyIdx.length - 1];
  for (let i = 0; i <= last; i++) {
    let k = 0;
    while (k < keyIdx.length - 1 && i > keyIdx[k + 1]) k++;
    const t0 = keyIdx[k], t1 = keyIdx[Math.min(k + 1, keyIdx.length - 1)];
    const r = t1 === t0 ? 0 : (i - t0) / (t1 - t0);
    const a = poses[k], b = poses[Math.min(k + 1, poses.length - 1)];
    const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0.5 }));
    for (const idx of new Set([...Object.keys(a), ...Object.keys(b)].map(Number))) {
      const p = a[idx] ?? b[idx], q = b[idx] ?? a[idx];
      lm[idx] = { x: p[0] + (q[0] - p[0]) * r, y: p[1] + (q[1] - p[1]) * r, visibility: p[2] ?? 0.9 };
    }
    mirror?.(lm);
    frames.push({ t: i / FPS, landmarks: lm, aspect: ASPECT });
  }
  return frames;
}
const SIDE_POSES = [
  { 0: [0.50, 0.25], 12: [0.50, 0.32], 14: [0.54, 0.42], 16: [0.50, 0.50], 24: [0.50, 0.55], 26: [0.50, 0.75], 28: [0.49, 0.95] },
  { 0: [0.50, 0.33], 12: [0.50, 0.40], 14: [0.52, 0.47], 16: [0.48, 0.44], 24: [0.50, 0.62], 26: [0.54, 0.78], 28: [0.49, 0.95] },
  { 0: [0.50, 0.30], 12: [0.50, 0.36], 14: [0.52, 0.44], 16: [0.48, 0.44], 24: [0.50, 0.50], 26: [0.52, 0.74], 28: [0.49, 0.95] },
  { 0: [0.50, 0.28], 12: [0.50, 0.34], 14: [0.53, 0.28], 16: [0.55, 0.15], 24: [0.50, 0.50], 26: [0.52, 0.74], 28: [0.49, 0.95] },
  { 0: [0.50, 0.28], 12: [0.50, 0.34], 14: [0.52, 0.24], 16: [0.53, 0.13], 24: [0.50, 0.52], 26: [0.52, 0.75], 28: [0.49, 0.95] },
  { 0: [0.50, 0.26], 12: [0.50, 0.33], 14: [0.52, 0.30], 16: [0.52, 0.20], 24: [0.50, 0.55], 26: [0.52, 0.76], 28: [0.49, 0.95] },
];
const mirror = (lm) => {
  for (const [f, n] of [[12, 11], [14, 13], [16, 15], [24, 23], [26, 25], [28, 27]]) {
    lm[n] = { x: lm[f].x + 0.09, y: lm[f].y, visibility: 0.35 };
  }
};
const shot = buildFrames([0, 36, 42, 50, 65, 95], SIDE_POSES, mirror);

// 场景 A：无空档（基线）——应检出 1 次
{
  const d = detectShotCycles(shot, "right", FPS);
  console.log(`A 基线（无空档）：检出 ${d.cycles.length} 次，releaseIdx=${d.cycles.map(c=>c.releaseIdx)}`);
  check("A 基线：检出 1 次出手", d.cycles.length === 1, `n=${d.cycles.length}`);
}
// 场景 B：中间插 150 帧 null（主人公离场 5 秒），前后各一次出手
{
  const GAP = 150;
  const gap = Array.from({ length: GAP }, (_, i) => ({ t: (96 + i) / FPS, landmarks: null, aspect: ASPECT }));
  const after = shot.map((f, i) => ({ ...f, t: (96 + GAP + i) / FPS }));
  const frames = [...shot, ...gap, ...after];
  const d = detectShotCycles(frames, "right", FPS);
  console.log(`B 150 帧空档：检出 ${d.cycles.length} 次，releaseIdx=${d.cycles.map(c=>c.releaseIdx)}（期望 2 次）`);
  check("B 150 帧空档：前后两球都检出", d.cycles.length === 2, `n=${d.cycles.length}`);
  check("B 两次出手帧号正确（48 / 294）", JSON.stringify(d.cycles.map((c) => c.releaseIdx)) === "[48,294]",
    JSON.stringify(d.cycles.map((c) => c.releaseIdx)));
  if (d.cycles.length) {
    for (const c of d.cycles) {
      const m = computeMetrics(frames, c, "right", "jump", "side");
      const crouch = m.find((x) => x.id === "kneeCrouch");
      console.log(`   周期 release=${c.releaseIdx} crouch=${c.crouchIdx} stand=${c.standIdx} → 下蹲膝角 ${crouch?.value}`);
    }
  }
}
// 场景 C：空档紧贴第二球之前（第二球的下蹲落在空档里）——期望第二球不该被静默丢掉
{
  const GAP = 40;
  const gap = Array.from({ length: GAP }, (_, i) => ({ t: (96 + i) / FPS, landmarks: null, aspect: ASPECT }));
  const after = shot.map((f, i) => ({ ...f, t: (96 + GAP + i) / FPS }));
  const frames = [...shot, ...gap, ...after];
  const d = detectShotCycles(frames, "right", FPS);
  console.log(`C 空档紧贴第二球（40 帧）：检出 ${d.cycles.length} 次，releaseIdx=${d.cycles.map(c=>c.releaseIdx)}（期望 2 次）`);
  check("C 空档紧贴第二球：两球都检出", d.cycles.length === 2, `n=${d.cycles.length}`);
  check("C 两次出手帧号正确（48 / 184）", JSON.stringify(d.cycles.map((c) => c.releaseIdx)) === "[48,184]",
    JSON.stringify(d.cycles.map((c) => c.releaseIdx)));
  for (const c of d.cycles) {
    const m = computeMetrics(frames, c, "right", "jump", "side");
    const crouch = m.find((x) => x.id === "kneeCrouch");
    const rel = m.find((x) => x.id === "elbowRelease");
    console.log(`   周期 release=${c.releaseIdx} crouch=${c.crouchIdx} stand=${c.standIdx} → 下蹲膝角 ${crouch?.value}，出手肘 ${rel?.value}`);
  }
}
// 场景 D：空档两端姿态差异大 → 插值斜坡可能伪造「出手」，不应产生任何周期
{
  const mk = (wristY) => {
    const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0.9 }));
    lm[0] = { x: 0.5, y: 0.25, visibility: 0.9 };
    lm[12] = { x: 0.5, y: 0.34, visibility: 0.9 };
    lm[14] = { x: 0.52, y: 0.3, visibility: 0.9 };
    lm[16] = { x: 0.52, y: wristY, visibility: 0.9 };
    lm[24] = { x: 0.5, y: 0.55, visibility: 0.9 };
    lm[26] = { x: 0.52, y: 0.75, visibility: 0.9 };
    lm[28] = { x: 0.49, y: 0.95, visibility: 0.9 };
    return lm;
  };
  const pre = Array.from({ length: 30 }, (_, i) => ({ t: i / FPS, landmarks: mk(0.5), aspect: ASPECT }));
  const gap = Array.from({ length: 120 }, (_, i) => ({ t: (30 + i) / FPS, landmarks: null, aspect: ASPECT }));
  const post = Array.from({ length: 30 }, (_, i) => ({ t: (150 + i) / FPS, landmarks: mk(0.1), aspect: ASPECT }));
  const d = detectShotCycles([...pre, ...gap, ...post], "right", FPS);
  console.log(`D 空档插值斜坡：检出 ${d.cycles.length} 次（期望 0——空档里的运动是插值假象，不是出手）`);
  check("D 空档插值斜坡：不产生假出手", d.cycles.length === 0, `n=${d.cycles.length}`);
}
// 场景 E：屈腿过程大部分落在空档里（人物当时不在画面）→ 该球无法测量，应计入「未计入」
{
  // 站姿（0–4 帧可见）→ 空档盖住屈腿段（5–45 帧）→ 出手在空档之后（46 帧起可见）
  const gap = Array.from({ length: 41 }, (_, i) => ({ t: (5 + i) / FPS, landmarks: null, aspect: ASPECT }));
  const frames = [...shot.slice(0, 5), ...gap, ...shot.slice(46).map((f, i) => ({ ...f, t: (46 + i) / FPS }))];
  const d = detectShotCycles(frames, "right", FPS);
  console.log(`E 屈腿段被遮挡：检出 ${d.cycles.length} 次，未计入 ${d.cycles.rejected ?? 0} 次（${d.cycles.rejectNote || "-"}）`);
  check("E 屈腿段被遮挡：测不出就不产出周期", d.cycles.length === 0, `n=${d.cycles.length}`);
  check("E 屈腿段被遮挡：计入「未计入」并说明原因", (d.cycles.rejected ?? 0) === 1 && !!d.cycles.rejectNote,
    `rejected=${d.cycles.rejected ?? 0} note=${d.cycles.rejectNote || "-"}`);
}

console.log(fails === 0 ? "\n🎉 全部通过" : `\n💥 ${fails} 项未达预期`);
process.exit(fails === 0 ? 0 : 1);
