// 场景判定专项测试（合成骨架数据）：定点站投 / 移动后出手 / 接球即投 / 证据不足
// 运行：node test/scene-test.mjs
// 仓库里没有真实视频，场景判定只能靠合成骨架验证——合成数据的姿势参数见各段注释。
import { detectShotCycles, computeMetrics } from "../js/metrics.js";
import { classifyScene } from "../js/scene.js";
import { buildReport } from "../js/report.js";

const ASPECT = 1080 / 1920, FPS = 30;
let fails = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`  ✅ ${name}`);
  else { fails++; console.log(`  ❌ ${name}${detail ? " —— " + detail : ""}`); }
};

// 侧面骨架：远侧链可见度 0.35（与其它测试同口径）
// ex/wx 是近侧（出手侧）肘/腕的水平偏移：接球即投要把手放到身前，
// 只改 y 的话肘角算出来会退化成「手臂完全折叠」的假读数
function sidePose({ nose, sh, el, wr, hip, knee, ank, kx = 0.04, ex = 0, wx = 0, vis = 0.9, dx = 0 }) {
  const lm = Array.from({ length: 33 }, () => ({ x: 0.5 + dx, y: hip, visibility: vis }));
  const put = (i, x, y, v = vis) => (lm[i] = { x: 0.5 + x + dx, y, visibility: v });
  put(0, 0, nose);
  put(11, -0.02, sh, 0.35); put(12, 0, sh);
  put(13, -0.02, el, 0.35); put(14, kx + ex, el);
  put(15, -0.02, wr, 0.35); put(16, wx, wr);
  put(23, -0.02, hip, 0.35); put(24, 0, hip);
  put(25, -0.02, knee, 0.35); put(26, kx, knee);
  put(27, -0.02, ank, 0.35); put(28, 0, ank);
  return lm;
}

// 关键帧之间线性插值
function buildFrames(keyIdx, poses) {
  const frames = [];
  const last = keyIdx[keyIdx.length - 1];
  for (let i = 0; i <= last; i++) {
    let k = 0;
    while (k < keyIdx.length - 1 && i > keyIdx[k + 1]) k++;
    const t0 = keyIdx[k], t1 = keyIdx[Math.min(k + 1, keyIdx.length - 1)];
    const r = t1 === t0 ? 0 : (i - t0) / (t1 - t0);
    const a = poses[k], b = poses[Math.min(k + 1, poses.length - 1)];
    frames.push({
      t: i / FPS,
      aspect: ASPECT,
      landmarks: Array.from({ length: 33 }, (_, j) => {
        const p = a[j] ?? b[j], q = b[j] ?? a[j];
        if (!p || !q) return p ?? q ?? { x: 0.5, y: 0.5, visibility: 0.5 };
        return {
          x: p.x + (q.x - p.x) * r,
          y: p.y + (q.y - p.y) * r,
          visibility: Math.min(p.visibility ?? 1, q.visibility ?? 1),
        };
      }),
    });
  }
  return frames;
}

// 一次完整出手（站→蹲→蹬→出手→跟随→落地），96 帧；出手帧约在第 50 帧
const SHOT_KEYS = [0, 36, 42, 50, 65, 95];
const SHOT_POSES = [
  sidePose({ nose: 0.25, sh: 0.32, el: 0.42, wr: 0.50, hip: 0.55, knee: 0.75, ank: 0.95 }),
  sidePose({ nose: 0.33, sh: 0.40, el: 0.47, wr: 0.44, hip: 0.62, knee: 0.78, ank: 0.95, kx: 0.12 }), // 膝角≈135°——真下蹲必屈膝
  sidePose({ nose: 0.30, sh: 0.36, el: 0.44, wr: 0.44, hip: 0.50, knee: 0.74, ank: 0.95, kx: 0.10 }),
  sidePose({ nose: 0.28, sh: 0.34, el: 0.28, wr: 0.15, hip: 0.50, knee: 0.74, ank: 0.95 }),
  sidePose({ nose: 0.28, sh: 0.34, el: 0.24, wr: 0.13, hip: 0.50, knee: 0.74, ank: 0.95 }),
  sidePose({ nose: 0.26, sh: 0.33, el: 0.30, wr: 0.20, hip: 0.55, knee: 0.76, ank: 0.95 }),
];

console.log("—— 场景①：定点站投 ——");
{
  const frames = buildFrames(SHOT_KEYS, SHOT_POSES);
  const { cycles, side } = detectShotCycles(frames, "right", FPS);
  check("检出 1 次出手", cycles.length === 1, `n=${cycles.length}`);
  const cycle = cycles[0];
  const scene = classifyScene(frames, cycle, side, FPS);
  check("判定为定点站投 spot", scene.scene === "spot", `scene=${scene.scene}`);
  check("把握较高（≥0.6）", scene.confidence >= 0.6, `confidence=${scene.confidence}`);
  check("周期上带着场景字段", cycle.scene === "spot", `cycle.scene=${cycle.scene}`);
  const metrics = computeMetrics(frames, cycle, side, "jump", "side");
  const ids = metrics.map((m) => m.id);
  check("定点站投不产出移动距离/移动速度", !ids.includes("moveDist") && !ids.includes("moveSpeed"), ids.join(","));
  check("定点站投不产出沉球量", !ids.includes("dipAmount"), ids.join(","));
}

console.log("\n—— 场景②：移动后出手（后撤步，出手前 1.0s 足部位移 0.4×身高）——");
{
  // 整体平移：第 20 帧开始后撤，第 32 帧到位（位移 0.4×身高），之后双脚站定再出手
  const BODY_H = 0.95 - 0.32; // 站姿体高（归一化 y 单位）
  const shift = (0.4 * BODY_H) / ASPECT; // 归一化 x 位移（pointsOf 会乘宽高比还原真实几何）
  const frames = buildFrames(SHOT_KEYS, SHOT_POSES).map((f, i) => {
    const r = i <= 20 ? 0 : i >= 32 ? 1 : (i - 20) / 12;
    const dx = -shift * r; // 后撤：往后退
    return { ...f, landmarks: f.landmarks.map((l) => ({ ...l, x: l.x + dx })) };
  });
  const { cycles, side } = detectShotCycles(frames, "right", FPS);
  check("检出 1 次出手", cycles.length === 1, `n=${cycles.length}`);
  const cycle = cycles[0];
  const scene = classifyScene(frames, cycle, side, FPS);
  check("判定为移动后出手 moving", scene.scene === "moving", `scene=${scene.scene}`);
  check("理由里带出位移量", /0\.\d+×身高/.test(scene.reason), scene.reason);
  check("把握 ≥0.6", scene.confidence >= 0.6, `confidence=${scene.confidence}`);
  check("周期场景字段为 moving", cycle.scene === "moving", `cycle.scene=${cycle.scene}`);

  const metrics = computeMetrics(frames, cycle, side, "jump", "side");
  const ids = metrics.map((m) => m.id);
  check("产出移动距离与移动速度", ids.includes("moveDist") && ids.includes("moveSpeed"), ids.join(","));
  const moveDist = metrics.find((m) => m.id === "moveDist");
  check("移动距离约 0.4×身高", Math.abs(moveDist.num - 0.4) < 0.12, `num=${moveDist?.num?.toFixed(3)}`);
  check("移动类指标为趋势参考型（不计分）", moveDist.verdictOverride === "info", `${moveDist?.verdictOverride}`);

  // 移动中的横移不应被算成「重心不稳」：balance 的基准改用出手前 0.5s 平均髋位
  const balance = metrics.find((m) => m.id === "balance");
  const verdict = buildReport(metrics, "jump").metrics.find((m) => m.id === "balance")?.verdict;
  check("移动场景下重心横移不判 bad", verdict !== "bad", `balance=${balance?.value} verdict=${verdict}`);
  check("重心横移读数很小（位移被基准吸收）", balance.num < 0.05, `num=${balance?.num?.toFixed(3)}`);
}

console.log("\n—— 场景③：接球即投（无下蹲、举球到出手 <0.25s）——");
{
  // 腿是直的（膝角≈167°，全程没有下蹲蓄力）：接球时手压到最低（第 26 帧），
  // 第 42 帧举球（肘角最小），第 46–47 帧出手——举球到出手约 0.13–0.17s
  const CATCH_POSES = [
    sidePose({ nose: 0.25, sh: 0.32, el: 0.42, wr: 0.50, hip: 0.55, knee: 0.75, ank: 0.95 }),
    sidePose({ nose: 0.30, sh: 0.34, el: 0.44, wr: 0.52, hip: 0.55, knee: 0.75, ank: 0.95, ex: 0.02, wx: 0.01 }), // 接球：手压到最低（沉球）
    sidePose({ nose: 0.29, sh: 0.34, el: 0.42, wr: 0.40, hip: 0.55, knee: 0.75, ank: 0.95, ex: 0.02, wx: 0.10 }), // 举球点（肘角最小）
    sidePose({ nose: 0.28, sh: 0.34, el: 0.28, wr: 0.16, hip: 0.55, knee: 0.75, ank: 0.95, ex: 0.02 }), // 出手
    sidePose({ nose: 0.27, sh: 0.33, el: 0.26, wr: 0.14, hip: 0.55, knee: 0.75, ank: 0.95, ex: 0.02 }),
  ];
  const frames = buildFrames([0, 26, 42, 48, 60], CATCH_POSES);
  const { cycles, side } = detectShotCycles(frames, "right", FPS);
  check("检出 1 次出手（接球即投没有下蹲也要检得出）", cycles.length === 1, `n=${cycles.length}`);
  if (cycles.length) {
    const cycle = cycles[0];
    const scene = classifyScene(frames, cycle, side, FPS);
    check("判定为接球即投 catch", scene.scene === "catch", `scene=${scene.scene} ${scene.reason}`);
    check("周期场景字段为 catch", cycle.scene === "catch", `cycle.scene=${cycle.scene}`);
    const metrics = computeMetrics(frames, cycle, side, "jump", "side");
    const ids = metrics.map((m) => m.id);
    check("产出沉球量", ids.includes("dipAmount"), ids.join(","));
    check("不产出移动距离/移动速度", !ids.includes("moveDist") && !ids.includes("moveSpeed"), ids.join(","));
    const dip = metrics.find((m) => m.id === "dipAmount");
    check("沉球量是趋势参考型", dip.verdictOverride === "info", `${dip?.verdictOverride}`);
    check("沉球量是有限正数", isFinite(dip.num) && dip.num > 0, `num=${dip.num}`);
    // 接球即投没有蓄力下蹲，膝角读数天然在区间外，不能当成「bad」扣分
    const kneeCrouch = metrics.find((m) => m.id === "kneeCrouch");
    check("接球场景不下蹲膝角不计分（趋势参考）", kneeCrouch.verdictOverride === "info", `${kneeCrouch?.verdictOverride}`);
  }
}

console.log("\n—— 场景④：证据不足 → 保守回退定点站投 ——");
{
  // 人物在出手前就离开画面 → 出手前窗口内有效帧不足，判定依据不成立
  const full = buildFrames(SHOT_KEYS, SHOT_POSES);
  const frames = full.map((f, i) => (i > 30 ? { ...f, landmarks: null } : f));
  const { cycles, side } = detectShotCycles(frames, "right", FPS);
  const cycle = cycles[0];
  const scene = classifyScene(frames, cycle ?? { releaseIdx: 48, crouchIdx: 40 }, side, FPS);
  check("回退为定点站投", scene.scene === "spot", `scene=${scene.scene}`);
  check("把握低（≤0.6）", scene.confidence <= 0.6, `confidence=${scene.confidence}`);
  check("理由里说明未能确认", /未能确认|按定点站投处理/.test(scene.reason), scene.reason);
}

console.log("\n—— 场景⑤：手动指定场景可覆盖自动判定 ——");
{
  const frames = buildFrames(SHOT_KEYS, SHOT_POSES);
  const { cycles, side } = detectShotCycles(frames, "right", FPS, "moving");
  check("手动指定 moving 后周期场景为 moving", cycles[0]?.scene === "moving", `scene=${cycles[0]?.scene}`);
  check("手动指定时理由写明是手动指定", /手动指定/.test(cycles[0]?.sceneReason ?? ""), cycles[0]?.sceneReason);
}

console.log(fails === 0 ? "\n🎉 全部通过" : `\n💥 ${fails} 项未达预期`);
process.exit(fails === 0 ? 0 : 1);
