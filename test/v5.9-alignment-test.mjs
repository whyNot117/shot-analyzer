// v5.9 对齐测试：轨迹聚类 / 出手事件判定 / 机位不稳定判定 / 坏姿态剔除 / 无分数条件触发
// 运行：node test/v5.9-alignment-test.mjs
//
// 这五件事是 v5.9 的全部要害：
//   ① 坏姿态（躯干高为负/过小）先剔除，否则它会污染机位、体型与每一个指标；
//   ② 主体不再按「逐帧体型最大」挑，改成按轨迹聚类 + 出手动作证据挑；
//   ③ 机位判定要带依据，机位在拍摄中变化时一律按侧面近似处理；
//   ④ 读数不可信时不出 0–100 分数与 S/A/B/C/D 等级，改成「这次读数只能作参考」。
import {
  isValidPose, poseTorsoHeight, poseBodyHeight, shoulderRatio,
  shotEvidence, findShotEvents, buildTracks, selectSubject, applySubject,
  MIN_TORSO_H, VIS_MIN, SHOT_MIN_FRAMES,
} from "../js/tracks.js";
import { classifyView } from "../js/views.js";
import { buildReport, renderReport, noScoreReasons } from "../js/report.js";

const ASPECT = 1080 / 1920; // 竖屏宽高比
const FPS = 30;
let failures = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`  ✅ ${name}`);
  else { failures++; console.log(`  ❌ ${name}${detail ? " —— " + detail : ""}`); }
};

/**
 * 造一帧可读的姿态：
 *   · x        —— 躯干中心横坐标（归一化）
 *   · scale    —— 整体体高缩放（模拟人在画面里忽远忽近）
 *   · ratio    —— 肩宽比（肩宽×宽高比 ÷ 躯干高）
 *   · wristUp  —— 手腕是否高于肩（出手证据）
 *   · torsoH   —— 直接指定躯干高（用来造坏姿态）
 *   · vis      —— 关键点可见度
 */
function makePose({
  x = 0.5, scale = 1, ratio = 0.05, wristUp = false,
  torsoH = null, vis = 0.9, aspect = ASPECT, headY = null, wristVis = null,
} = {}) {
  const th = torsoH ?? 0.4 * scale;
  const bodyH = 0.55 * scale;
  const shoulderY = 0.3;
  const gap = (ratio * th) / aspect;
  const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0.9 }));
  const head = headY ?? shoulderY + th - bodyH;
  lm[0] = { x, y: head, visibility: vis };
  lm[7] = { x, y: head, visibility: vis };
  lm[8] = { x, y: head, visibility: vis };
  lm[11] = { x: x - gap / 2, y: shoulderY, visibility: vis };
  lm[12] = { x: x + gap / 2, y: shoulderY, visibility: vis };
  lm[23] = { x, y: shoulderY + th * 0.55, visibility: vis };
  lm[24] = { x, y: shoulderY + th * 0.55, visibility: vis };
  lm[27] = { x, y: shoulderY + th, visibility: vis };
  lm[28] = { x, y: shoulderY + th, visibility: vis };
  const wristY = wristUp ? shoulderY - 0.06 : shoulderY + 0.18;
  lm[15] = { x, y: wristY, visibility: wristVis ?? vis };
  lm[16] = { x, y: wristY, visibility: wristVis ?? vis };
  return lm;
}

// ══════════════ ① 坏姿态剔除 ══════════════
console.log("— ① 坏姿态剔除 —");
{
  const good = makePose({});
  check("正常站姿判为有效姿态", isValidPose(good, ASPECT) === true);
  check("有效姿态的躯干高为正", poseTorsoHeight(good) > MIN_TORSO_H, `${poseTorsoHeight(good)}`);

  // 头顶关键点比脚踝还低 → 躯干高为负 → 关键点不可信
  const inverted = makePose({ torsoH: -0.12 });
  check("躯干高为负的坏姿态判为无效", isValidPose(inverted, ASPECT) === false);
  check("坏姿态的躯干高确实是负数", poseTorsoHeight(inverted) < 0, `${poseTorsoHeight(inverted)}`);

  // 躯干高过小（未全身入镜）→ 无效
  const tiny = makePose({ torsoH: 0.02 });
  check("躯干高过小的姿态判为无效", isValidPose(tiny, ASPECT) === false);
  check("无效阈值就是 0.05", MIN_TORSO_H === 0.05);

  // 关键点坐标非有限：这个点本身不参与统计（用其余可信点算），姿态未必整帧作废
  const broken = makePose({});
  broken[11].x = NaN;
  check("单个关键点坐标非有限 → 该点不参与统计，姿态仍可判有效",
    isValidPose(broken, ASPECT) === true);
  const allBroken = makePose({});
  for (const i of [11, 12, 27, 28]) allBroken[i].x = Infinity;
  check("肩踝关键点全部不可信 → 躯干高测不出来 → 判为无效",
    isValidPose(allBroken, ASPECT) === false);

  // 肩/踝可见度过低 → 躯干高根本测不出来 → 无效
  const faint = makePose({ vis: 0.1 });
  check("关键点可见度过低的姿态判为无效", isValidPose(faint, ASPECT) === false);
  check("可见度阈值就是 0.3", VIS_MIN === 0.3);

  // 关键点数量不足
  check("关键点不足 29 个判为无效", isValidPose([{ x: 0.5, y: 0.5, visibility: 1 }], ASPECT) === false);
  check("空输入判为无效", isValidPose(null, ASPECT) === false && isValidPose([], ASPECT) === false);

  // 坏姿态不参与机位判定：掺进坏帧不应改变判定结果
  const frames = [];
  for (let i = 0; i < 40; i++) {
    frames.push({ t: i / FPS, landmarks: makePose({ ratio: 0.25 }), aspect: ASPECT });
  }
  const withBad = frames.concat(
    Array.from({ length: 40 }, (_, i) => ({ t: (40 + i) / FPS, landmarks: makePose({ torsoH: -0.1 }), aspect: ASPECT }))
  );
  const cleanInfo = classifyView(frames);
  const dirtyInfo = classifyView(withBad);
  check("坏姿态帧不参与机位判定（判定结果不变）",
    dirtyInfo.view === cleanInfo.view && dirtyInfo.ratio === cleanInfo.ratio,
    `${cleanInfo.view}/${cleanInfo.ratio} → ${dirtyInfo.view}/${dirtyInfo.ratio}`);

  // 坏姿态也不该进轨迹
  const scan = [
    { t: 0, poses: [makePose({}), makePose({ torsoH: -0.1 })], aspect: ASPECT },
    { t: 1 / FPS, poses: [makePose({}), makePose({ torsoH: -0.1 })], aspect: ASPECT },
  ];
  const tracks = buildTracks(scan);
  check("坏姿态不进入任何轨迹（只留好姿态那一条）",
    tracks.length === 1 && tracks[0].frames.length === 2, JSON.stringify(tracks.map((t) => t.frames.length)));
}

// ══════════════ ② 出手事件判定 ══════════════
console.log("— ② 出手事件判定 —");
{
  check("手腕高于肩 → 有出手证据", shotEvidence(makePose({ wristUp: true })) === true);
  check("手腕低于肩 → 没有出手证据", shotEvidence(makePose({ wristUp: false })) === false);
  check("手腕可见度过低 → 不算证据（外推的点不能当证据）",
    shotEvidence(makePose({ wristUp: true, wristVis: 0.2 })) === false);
  check("非数组输入 → 没有证据", shotEvidence(null) === false);

  // 连续段判定：连续 ≥4 帧算一次出手事件
  const seq = (flags) => flags.map((on, i) => ({ t: i / FPS, landmarks: makePose({ wristUp: on }) }));
  const ev5 = findShotEvents(seq([false, false, true, true, true, true, true, false]));
  check("连续 5 帧手腕过肩 → 记 1 次出手事件", ev5.length === 1, JSON.stringify(ev5));
  check("出手事件的起止时间正确", ev5[0].from === 2 / FPS && ev5[0].to === 6 / FPS, JSON.stringify(ev5[0]));
  const ev3 = findShotEvents(seq([true, true, true, false]));
  check("只有 3 帧连续过肩 → 不算出手事件（阈值 4 帧）", ev3.length === 0, JSON.stringify(ev3));
  check("出手帧数阈值就是 4", SHOT_MIN_FRAMES === 4);
  const ev2 = findShotEvents(seq([true, true, true, true, false, false, false, false, true, true, true, true]));
  check("两段独立的连续过肩 → 记 2 次出手事件", ev2.length === 2, JSON.stringify(ev2));
}

// ══════════════ ③ 轨迹聚类与主体选取 ══════════════
console.log("— ③ 轨迹聚类与主体选取 —");
{
  // 场景：两个人同时在画面里，一个在左（不出手），一个在右（9.4–9.8 秒连续出手）
  const scan = [];
  for (let i = 0; i < 300; i++) {
    const t = i / FPS;
    const rightShooting = i >= 282 && i <= 294; // t≈9.40–9.80 秒
    scan.push({
      t,
      poses: [
        makePose({ x: 0.28, ratio: 0.05, scale: 1.0 }),
        makePose({ x: 0.72, ratio: 0.05, scale: 0.6, wristUp: rightShooting }),
      ],
      aspect: ASPECT,
    });
  }
  const tracks = buildTracks(scan);
  check("同框两个人 → 聚成两条轨迹", tracks.length === 2, `得到 ${tracks.length} 条`);
  check("两条轨迹的有效帧数都等于总帧数",
    tracks.every((tr) => tr.stats.frames === 300), JSON.stringify(tracks.map((t) => t.stats.frames)));
  const withShot = tracks.filter((tr) => tr.stats.shotEvents > 0);
  check("只有一条轨迹检测到出手事件", withShot.length === 1, JSON.stringify(tracks.map((t) => t.stats.shotEvents)));
  check("出手事件的时刻落在 9.4–9.8 秒",
    withShot[0].stats.shotSpans[0].from >= 9.3 && withShot[0].stats.shotSpans[0].to <= 9.9,
    JSON.stringify(withShot[0].stats.shotSpans));

  // 主体选取：有出手动作的轨迹优先——哪怕它体高更小、画面更靠边
  const { track, reason } = selectSubject(tracks);
  check("主体选中「有出手事件」的轨迹", track === withShot[0]);
  check("主体选取理由说明了出手时段", /出手/.test(reason), reason);

  // 没有人出手时，退回「有效帧最多 → 体高最大」
  const noShot = buildTracks(
    Array.from({ length: 100 }, (_, i) => ({
      t: i / FPS,
      poses: [makePose({ x: 0.3, scale: 0.4 }), makePose({ x: 0.7, scale: 1.0 })],
      aspect: ASPECT,
    }))
  );
  const picked = selectSubject(noShot);
  check("无人出手 → 选有效帧最多的轨迹", picked.track.stats.shotEvents === 0 && picked.track.stats.frames === 100);
  check("无人出手时理由里说清楚了", /没检测到出手动作/.test(picked.reason), picked.reason);

  // 一个人连续横向移动 → 不该被切碎成多条轨迹
  const moving = buildTracks(
    Array.from({ length: 120 }, (_, i) => ({
      t: i / FPS,
      poses: [makePose({ x: 0.3 + (i / 119) * 0.4, ratio: 0.05, scale: 1 + (i / 119) * 0.5 })],
      aspect: ASPECT,
    }))
  );
  check("同一人横向移动 → 保持一条轨迹", moving.length === 1, `得到 ${moving.length} 条`);
  check("移动中轨迹有效帧不丢", moving[0].stats.frames === 120, `${moving[0].stats.frames}`);

  // 帧的账：检出 / 无效 / 有效 / 计入主体 / 未计入
  const mixed = [
    { t: 0, poses: [makePose({ x: 0.3, scale: 1.0 })], aspect: ASPECT },
    { t: 1 / FPS, poses: [makePose({ torsoH: -0.1 })], aspect: ASPECT },
    { t: 2 / FPS, poses: [makePose({ x: 0.7, scale: 0.6 })], aspect: ASPECT },
    { t: 3 / FPS, poses: [], aspect: ASPECT },
  ];
  const applied = applySubject(mixed, buildTracks(mixed));
  check("帧账：检出 3 帧", applied.stats.detected === 3, `${applied.stats.detected}`);
  check("帧账：剔除 1 帧无效姿态", applied.stats.invalid === 1, `${applied.stats.invalid}`);
  check("帧账：有效 2 帧", applied.stats.valid === 2, `${applied.stats.valid}`);
  check("帧账：主体计入 1 帧", applied.stats.subjectFrames === 1, `${applied.stats.subjectFrames}`);
  check("帧账：1 帧有人但不是主体（未计入）", applied.stats.otherFrames === 1, `${applied.stats.otherFrames}`);
  check("未计入的帧不参与后续分析", applied.frames.filter((f) => f.landmarks === null).length === 3);
}

// ══════════════ ④ 机位不稳定判定 ══════════════
console.log("— ④ 机位不稳定判定 —");
{
  const mkFrame = (t, ratio, scale = 1) => ({ t, landmarks: makePose({ ratio, scale }), aspect: ASPECT });
  const stable = classifyView(Array.from({ length: 40 }, (_, i) => mkFrame(i / FPS, 0.25)));
  check("稳定机位 → 不算 unstable", stable.unstable === false, stable.reason);
  check("稳定机位 → 判定依据写在 reason 里", /肩宽比中位/.test(stable.reason), stable.reason);

  const bimodal = classifyView([
    ...Array.from({ length: 50 }, (_, i) => mkFrame(i / FPS, 0.05)),
    ...Array.from({ length: 50 }, (_, i) => mkFrame((50 + i) / FPS, 0.25)),
  ]);
  check("双峰 → 判为机位不固定", bimodal.unstable === true);
  check("机位不固定 → 一律按侧面近似处理", bimodal.view === "side", bimodal.view);
  check("机位不固定 → 写明双峰占比依据", /双峰/.test(bimodal.reason), bimodal.reason);
  check("机位不固定 → 侧面占比与正面占比都有数",
    bimodal.sideShare > 0.2 && bimodal.frontShare > 0.2, JSON.stringify(bimodal));

  const zoom = classifyView([
    ...Array.from({ length: 10 }, (_, i) => mkFrame(i / FPS, 0.25, 0.16)),
    ...Array.from({ length: 10 }, (_, i) => mkFrame((10 + i) / FPS, 0.25, 1)),
  ]);
  check("运镜（体高 p90/p10 > 3）→ 判为机位不固定", zoom.unstable === true);
  check("机位不固定 → 写明运镜幅度依据", /运镜/.test(zoom.reason), zoom.reason);

  const spread = classifyView([
    ...Array.from({ length: 40 }, (_, i) => mkFrame(i / FPS, 0.05)),
    ...Array.from({ length: 40 }, (_, i) => mkFrame((40 + i) / FPS, 0.19)),
  ]);
  check("比值分散 → 判为机位不固定", spread.unstable === true, spread.reason);

  check("手动指定机位 → 跳过 unstable 判定",
    classifyView([
      ...Array.from({ length: 50 }, (_, i) => mkFrame(i / FPS, 0.05)),
      ...Array.from({ length: 50 }, (_, i) => mkFrame((50 + i) / FPS, 0.25)),
    ], { manual: true }).unstable === false);
}

// ══════════════ ⑤ 无分数条件触发 ══════════════
console.log("— ⑤ 无分数条件触发 —");
{
  const metrics = [
    { id: "kneeBend", name: "下蹲膝角", num: 160, lo: 150, hi: 175, value: "160°", rangeText: "150°–175°", weight: 1 },
    { id: "elbow", name: "出手肘角", num: 95, lo: 80, hi: 110, value: "95°", rangeText: "80°–110°", weight: 1 },
  ];
  const scored = buildReport(metrics, "jump", 1);
  check("正常情况出 0–100 分数", scored.score >= 0 && scored.score <= 100, `${scored.score}`);
  check("正常情况出 S/A/B/C/D 等级", ["S", "A", "B", "C", "D"].includes(scored.grade), `${scored.grade}`);
  check("正常情况没有 noScore 说明", !scored.noScore);

  // 条件判定本身（纯函数）
  const base = { peopleSeen: 1, hasShot: true, subjectFrames: 400, totalFrames: 451, droppedFrames: 20 };
  check("条件都满足 → 不出分", noScoreReasons(base).length === 0, JSON.stringify(noScoreReasons(base)));
  check("机位不固定 → 出分理由", /机位在拍摄过程中变化/.test(noScoreReasons({ ...base, unstable: true, unstableReasons: ["双峰"] })[0]));
  check("多人且没确定谁在投 → 出分理由", /没能确定谁在投/.test(noScoreReasons({ ...base, peopleSeen: 3, hasShot: false }).join()));
  check("没有出手动作 → 出分理由", /没有检测到完整的投篮动作/.test(noScoreReasons({ ...base, hasShot: false }).join()));
  check("有效帧占比不足 70% → 出分理由", /不足 70%/.test(noScoreReasons({ ...base, subjectFrames: 200 }).join()));
  check("丢帧超过 20% → 出分理由", /丢帧/.test(noScoreReasons({ ...base, droppedFrames: 200 }).join()));
  check("素材质量 bad → 出分理由", /素材质量/.test(noScoreReasons({ ...base, qualityLevel: "bad" }).join()));

  // 不出分时，报告里没有分数也没有等级
  const reasons = noScoreReasons({ ...base, unstable: true, unstableReasons: ["双峰"] });
  const report = buildReport(metrics, "jump", 1, { noScoreReasons: reasons });
  check("触发条件 → 分数为 null", report.score === null, `${report.score}`);
  check("触发条件 → 等级为 null", report.grade === null, `${report.grade}`);
  check("触发条件 → 带上具体原因", Array.isArray(report.noScore) && report.noScore.length > 0);

  const el = { innerHTML: "" };
  renderReport(el, report, { summaryLine: "本次测到 12/24 项 · 机位：侧面（依据：肩宽比中位 0.13）· 主体：画面右侧正在出手的那个 · 有效帧 400/451" });
  check("报告里写明「这次读数只能作参考」", el.innerHTML.includes("这次读数只能作参考"));
  check("报告里不出现分数环", !el.innerHTML.includes("score-ring"));
  check("报告里不出现 S/A/B/C/D 等级", !/<small>[SABCD]<\/small>/.test(el.innerHTML));
  check("报告里显示「不出分」", el.innerHTML.includes("不出分"));
  check("报告顶部有「本次测到 N/24 项」摘要", /本次测到 12\/24 项/.test(el.innerHTML));
  check("摘要里写了机位依据", /依据：肩宽比中位 0\.13/.test(el.innerHTML));
  check("摘要里写了主体与有效帧", /主体：画面右侧正在出手的那个/.test(el.innerHTML) && /有效帧 400\/451/.test(el.innerHTML));

  const el2 = { innerHTML: "" };
  renderReport(el2, scored, { summaryLine: "本次测到 2/24 项 · 机位：正面（依据：肩宽比中位 0.25）" });
  check("正常报告仍然有分数环", el2.innerHTML.includes("score-ring"));
}

console.log(failures === 0 ? "\n🎉 全部通过" : `\n💥 ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
