// 边界场景手检（不进主测试套件，作为对抗审查的本地补充；node test/boundary-check.mjs）
import { makePersonPicker } from "../js/media.js";

const mkPose = (cx, cy, size, vis = 0.9) => {
  const lm = Array.from({ length: 33 }, () => ({ x: cx, y: cy, visibility: vis }));
  lm[0] = { x: cx, y: cy - size / 2, visibility: vis };
  for (const i of [11, 12]) lm[i] = { x: cx, y: cy - size / 2 + 0.04, visibility: vis };
  for (const i of [23, 24]) lm[i] = { x: cx, y: cy, visibility: vis };
  for (const i of [25, 26]) lm[i] = { x: cx, y: cy + size / 2 - 0.08, visibility: vis };
  for (const i of [27, 28]) lm[i] = { x: cx, y: cy + size / 2, visibility: vis };
  return lm;
};

// ① 主人公缓慢远去 10s（300 帧，体型 0.6→0.42），期间无他人——锁应全程保持
{
  const p = makePersonPicker();
  let nulls = 0;
  for (let f = 0; f < 300; f++) if (p.pick([mkPose(0.5, 0.5, 0.6 - 0.18 * f / 300)]) === null) nulls++;
  console.log(`① 远走10s：null ${nulls}/300（应=0，记忆衰减跟随真实体型）`);
  // 之后 1.5× 体型的队友站进原位：落在 0.55–1.6 匹配带内 → 按已声明极限继承
  const r = p.pick([mkPose(0.5, 0.5, 0.63)]);
  console.log(`① 接续：远走后队友站进原位 → ${r ? "继承锁（已接受极限：体型相近带）" : "null 拒绝"}`);
}

// ② 手持拍摄抖动（±0.04 正弦，90 帧）——不应误判消失导致 null 闪烁
{
  const s = makePersonPicker();
  const H = (f) => mkPose(0.5 + 0.04 * Math.sin(f / 3), 0.5, 0.6);
  s.pick([H(0)]);
  let flick = 0;
  for (let f = 1; f < 90; f++) if (s.pick([H(f)]) === null) flick++;
  console.log(`② 手持抖动90帧：null ${flick}（应=0）`);
}

// ③ 主人公从画面深处走近镜头（体型 0.45→0.65，120 帧）——渐大不应被 1.6 上限拒匹配
{
  const c = makePersonPicker();
  const A = (f) => mkPose(0.5, 0.5, 0.45 + 0.2 * f / 120);
  c.pick([A(0)]);
  let miss = 0;
  for (let f = 1; f < 120; f++) if (c.pick([A(f)]) === null) miss++;
  console.log(`③ 走近镜头120帧：null ${miss}（应=0，记忆随匹配帧即时抬升）`);
}

// ④ 出手动作中的快速位移（横向移动接球后急停出手，帧间位移 0.05）——EMA 应跟得上
{
  const q = makePersonPicker();
  const Q = (f) => mkPose(0.2 + 0.05 * f, 0.5, 0.6);
  q.pick([Q(0)]);
  let miss = 0;
  for (let f = 1; f < 8; f++) if (q.pick([Q(f)]) === null) miss++;
  console.log(`④ 快速横移8帧：null ${miss}（应=0，位移0.05≪0.2匹配半径）`);
}
