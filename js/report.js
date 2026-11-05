// 评分规则引擎与报告渲染：指标 → 评分/评级 → 针对性中文建议（不依赖任何外部服务）
import { JUMP_MIN, TREND_ONLY } from "./metrics.js";
import { lineChart } from "./charts.js";

export const TYPE_LABEL = { jump: "跳投", mid: "中投", free: "罚球", three: "三分" };

// 个人资料（身高/体重/年龄）：app.js 从 localStorage 载入后注入，报告头部展示
let userProfile = null;
export function setProfile(p) {
  userProfile = p && typeof p === "object" ? p : null;
}

// 建议只讲「原因」（含实测值 {v}），不写训练方法——用户要的是为什么，怎么练用户自己定
const TIPS = {
  kneeCrouch: {
    bad: "下蹲膝角 {v}，偏离熟练射手实测带（命中罚球准备期约 90–110°，三分蹲得更深）——过浅蹬伸无力，过深拖慢出手节奏，腿部蓄力效率打折。",
    warn: "下蹲膝角 {v}，处于合理区间边缘——熟练射手的实测蓄力深度在 90–110° 附近。",
    good: "下蹲膝角 {v}，蓄力深度落在熟练射手实测带内。",
  },
  elbowSet: {
    bad: "举球肘角 {v}，不在 75–105° 发力结构内——肘部没有收在球正下方，力量链从举球点开始就是歪的。",
    warn: "举球肘角 {v}，「L」型发力结构略有偏差。",
    good: "举球肘角 {v}，发力结构稳定。",
  },
  elbowRelease: {
    bad: "出手瞬间肘角仅 {v}，手臂没有打直——力量传导在球离手前就中断，射程和稳定性直接受损。",
    warn: "出手瞬间肘角 {v}，伸展接近充分，出手后有提前收臂迹象。",
    good: "出手瞬间肘角 {v}，手臂充分伸展。",
  },
  releaseAngle: {
    bad: "出手方向角 {v}，偏离高效弧线（熟练射手实测 51.4°±3.2，物理建模最优约 52°）：偏低弧线平、易被封盖且砸筐前沿，偏高浪费射程。",
    warn: "出手方向角 {v}，弧线略偏离熟练射手实测带（约 48–55°）。",
    good: "出手方向角 {v}，弧线贴近熟练射手实测值（51.4°±3.2）。",
  },
  releaseHeight: {
    bad: "出手点 {v}，明显偏低于实测射手带（跳投出手手高约为身高的 113%–119%）——出手被压低后弧线受压，封盖风险和落点偏差同时上升。",
    warn: "出手点 {v}，低于实测射手带下缘（约身高 113%）。",
    good: "出手点 {v}，落在实测射手带内（身高 113%–119%）。",
  },
  followThrough: {
    bad: "出手后肘角 {v}，跟随动作没有保持伸展——球在离手瞬间受到额外的干扰力，方向控制变差。",
    warn: "出手后肘角 {v}，跟随伸展保持得不够充分。",
    good: "出手后肘角 {v}，跟随动作完整。",
  },
  trunkLean: {
    bad: "出手瞬间躯干倾斜 {v}，核心失稳——力量沿倾斜方向散失，落点出现系统性偏移。",
    warn: "躯干倾斜 {v}，出手时身体略失正直。",
    good: "躯干倾斜 {v}，出手时身体正直。",
  },
  headDrift: {
    bad: "动作全程头部水平晃动 {v}——瞄准基准一直在动，命中率的波动很大程度来自这里。",
    warn: "头部晃动 {v}，瞄准基准有轻微移动。",
    good: "头部晃动 {v}，瞄准基准稳定。",
  },
  balance: {
    bad: "出手过程重心横移 {v}，蹬伸方向偏斜——力量没有沿直线送向篮筐。",
    warn: "重心横移 {v}，蹬伸方向略偏。",
    good: "重心横移 {v}，出手方向稳定。",
  },
  // 正面机位指标（多角度融合报告中出现）
  elbowAbduction: {
    bad: "肘内外展 {v}，肘尖指向侧面而不是篮筐——球离手时被赋予侧向分量，方向控制差。（常规 20–45° 转体站位会放大此读数）",
    warn: "肘内外展 {v}，肘部有外展倾向，出手中线略有偏移。（转体站位会放大读数）",
    good: "肘内外展 {v}，肘部沿中线发力。",
  },
  stanceWidth: {
    bad: "站距 {v}×肩宽，偏离 0.7–1.5 常见范围：过窄支撑不稳，过宽蹬伸启动慢。（前后脚站位会让正面读数失真）",
    warn: "站距 {v}×肩宽，略偏离常见范围。",
    good: "站距 {v}×肩宽，支撑面稳定。",
  },
  lateralBalance: {
    bad: "动作过程左右重心偏移 {v}，两侧发力不对称。",
    warn: "左右重心偏移 {v}，两侧受力略有差异。",
    good: "左右重心偏移 {v}，出手对称性良好。",
  },
  // 出手伸肘速度：只讲原因不给方法（口径见 docs/投篮理解.md 4️⃣）
  elbowSpeed: {
    bad: "出手伸肘速度 {v}，明显慢于文献实测带（高水平球员随距离 2.8→6.4 m，肘角速度 539→742°/s）——伸肘推球的过程拖得太长，球是被\"匀速推\"出去的，远距离时这个差异会直接放大成射程不足。",
    warn: "出手伸肘速度 {v}，伸肘速度低于实测带下缘——出球过程偏\"匀速推\"，还够不上快速释放。",
    good: "出手伸肘速度 {v}，伸肘释放速度落在实测带内。",
  },
  // 起跳指标按类型取不同文案
  jumpShot: {
    bad: "出手时几乎没有起跳（{v}×身高）——跳投的力量主要来自蹬伸，不起跳等于几乎全靠上肢硬扔。",
    warn: "出手时起跳幅度很小（{v}×身高），腿部参与不足。",
    good: "起跳 {v}×身高，腿-臂发力衔接良好。",
  },
  freeThrow: {
    bad: "罚球时有明显起跳（{v}×身高）——罚球讲究贴地稳定发力，起跳会引入不必要的动作变量。",
    warn: "罚球时有起跳倾向（{v}×身高），偏离贴地发力要求。",
    good: "罚球贴地发力（抬升 {v}×身高），稳定。",
  },
};

function judge(m) {
  const { num, lo, hi } = m;
  if (num >= lo && num <= hi) return "good";
  // 部分指标带文献建议的不对称容差带（warnLo/warnHi），其余按区间宽度的 25%
  const margin = (hi - lo) * 0.25;
  const wl = m.warnLo ?? lo - margin;
  const wh = m.warnHi ?? hi + margin;
  if (num >= wl && num <= wh) return "warn";
  return "bad";
}

function tipId(m, type) {
  if (m.id === "jump") return type === "free" ? "freeThrow" : "jumpShot";
  return m.id;
}

// 「较上次」差值的显示格式：数值越大越不需要小数位（角度类 100° 以上不带 .0）
function formatDelta(delta) {
  const s = Math.abs(delta) >= 100 ? delta.toFixed(0) : delta.toFixed(1);
  return delta > 0 ? `+${s}` : s;
}

export function buildReport(metrics, type, cycleCount = 1) {
  // 自动识别：三分/中投/跳投的评分标准相同（都要求起跳），真正要区分的只有罚球（贴地）——
  // 起跳幅度本身就是测量值，按中位数直接判定即可
  let autoType = false;
  if (type === "auto") {
    const jump = metrics.find((m) => m.id === "jump")?.num ?? 0;
    type = jump > JUMP_MIN ? "jump" : "free";
    autoType = true;
  }
  // 起跳的判定与投篮类型相关（罚球应贴地、跳投应起跳），放到报告阶段：
  // 多次出手逐指标取中位数之后才能按中位数值正确判定
  const judged = metrics.map((m) => {
    let verdict = m.verdictOverride ?? judge(m);
    let name = m.name;
    if (m.id === "jump") {
      verdict = m.num > JUMP_MIN ? (type === "free" ? "warn" : "good") : type === "free" ? "good" : "warn";
      if (type === "free") name = "罚球贴地"; // 自动识别为罚球时按罚球口径命名
    }
    return { ...m, verdict, name };
  });
  const scored = judged.filter((m) => m.verdict !== "info"); // info=趋势参考，不计分
  const totalW = scored.reduce((s, m) => s + m.weight, 0);
  const score = Math.round(
    (scored.reduce((s, m) => s + m.weight * ({ good: 1, warn: 0.5, bad: 0 })[m.verdict], 0) /
      (totalW || 1)) * 100
  );
  const grade = score >= 90 ? "S" : score >= 75 ? "A" : score >= 60 ? "B" : score >= 45 ? "C" : "D";
  // 建议带实测值与回看帧号（frame 由 computeMetrics 附带），渲染层据此提供「点击回看视频瞬间」
  const tips = judged
    .filter((m) => m.verdict === "warn" || m.verdict === "bad")
    .sort((a, b) => b.weight - a.weight)
    .map((m) => {
      const t = TIPS[tipId(m, type)];
      return {
        name: m.name, level: m.verdict, value: m.value, frame: m.frame,
        text: (t?.[m.verdict] ?? "").replace("{v}", m.value),
      };
    })
    .filter((t) => t.text);
  return { type, score, grade, metrics: judged, tips, cycleCount, autoType };
}

export function renderReport(el, report, opts = {}) {
  const vIcon = { good: "✅", warn: "⚠️", bad: "❌", info: "ℹ️" };
  const count = (v) => report.metrics.filter((m) => m.verdict === v).length;
  const canJump = (f) => f != null && !!opts.jump; // 只有主报告接了回看监听，才显示点击跳转
  const compare = opts.compare ?? {}; // 由 app.js 用 compareMetric 算好：{ [指标id]: {prev, delta, better, count} }

  // 「较上次」标记：箭头跟数值增减（↑ 就是比上次大），颜色跟「变好/变差」（better 字段）——
  // 头部晃动、重心横移这类越小越好的指标，数值下降才是变好，颜色不能跟着数值走
  const trendTag = (m) => {
    const c = compare[m.id];
    if (!c || c.delta == null || !isFinite(c.delta) || c.delta === 0) return "";
    const better = c.better === true;
    return `<small class="m-trend ${better ? "good" : "bad"}">${c.delta > 0 ? "↑" : "↓"} 比上次 ${formatDelta(c.delta)}${
      TREND_ONLY.has(m.id) || m.verdict === "info" ? "（趋势）" : ""
    }</small>`;
  };

  const rows = report.metrics
    .map(
      (m) => `
      <div class="metric-row ${m.verdict}">
        <span class="m-name">${m.name}${m.src ? ` <i class="m-src">${m.src}</i>` : ""}</span>
        <span class="m-value">${m.value}<small>参考 ${m.rangeText}</small>${trendTag(m)}</span>
        <span class="m-icon">${vIcon[m.verdict]}</span>
      </div>`
    )
    .join("");

  const tips = report.tips
    .map(
      (t) => `
      <div class="tip-card${canJump(t.frame) ? " clickable" : ""}"${canJump(t.frame) ? ` data-frame="${t.frame}"` : ""}>
        <b>${t.level === "bad" ? "❌" : "⚠️"} ${t.name} ${t.value ?? ""}</b>
        <p>${t.text}</p>
        ${canJump(t.frame) ? '<span class="tip-jump">▶ 点击回看视频瞬间</span>' : ""}
      </div>`
    )
    .join("");

  // 关键动作曲线：一次代表性出手的肘角/膝角逐帧读数（x 轴是相对出手帧的秒数）
  const curves = opts.curves;
  const curveCard = curves
    ? `<div class="curve-card">
        <h3>📈 关键动作曲线</h3>
        ${lineChart({
          series: [
            { label: "肘角", color: "#38bdf8", points: curves.elbow ?? [] },
            { label: "膝角", color: "#f97316", points: curves.knee ?? [] },
          ],
          events: curves.events ?? [],
          xLabel: "相对出手时刻（秒）",
          yUnit: "°",
          height: 180,
        })}
        <p class="hint">竖线依次标出下蹲 / 举球 / 出手 / 跟随四个关键节点。${opts.curveNote ?? ""}</p>
      </div>`
    : "";

  const pfBits = [
    userProfile?.height && `身高 ${userProfile.height}cm`,
    userProfile?.weight && `体重 ${userProfile.weight}kg`,
    userProfile?.age && `年龄 ${userProfile.age}岁`,
  ].filter(Boolean);

  // 场景判定：结论与把握都摊开给用户看；把握偏低时明说「场景判定不确定」
  const scene = opts.scene;
  const sceneLine = scene
    ? `<p class="scene-line">场景：${scene.label}（${scene.reason}）· 判定把握 ${scene.confidence.toFixed(1)}${
        scene.confidence >= 0.4 && scene.confidence <= 0.6 ? " · 场景判定不确定" : ""
      }${scene.manual ? " · 手动指定" : ""}</p>`
    : "";

  // 移动/接球场景是实验性功能：区间没有真实素材校准，底部必须醒目提示
  const experimentalWarn = opts.experimental
    ? '<p class="experimental-warn">⚠️ 移动/接球场景判定为实验性功能，指标区间尚未用真实素材校准，结论仅供参考。</p>'
    : "";

  el.innerHTML = `
    <div class="report-summary">
      <div class="score-ring" style="--p:${report.score}">
        <div class="score-inner"><b>${report.score}</b><small>${report.grade}</small></div>
      </div>
      <div class="summary-text">
        <h3>${report.title ?? (report.autoType ? `自动识别：按${TYPE_LABEL[report.type]}标准` : `${TYPE_LABEL[report.type]}姿态评分`)}</h3>
        <p>${count("good")} 项达标 · ${count("warn")} 项待改进 · ${count("bad")} 项需重点纠正${count("info") ? ` · ${count("info")} 项趋势参考` : ""}${report.cycleCount > 1 ? ` · 共 ${report.cycleCount} 次出手（指标取中位数）` : ""}</p>
        ${opts.compareSummary ? `<p class="compare-line">${opts.compareSummary}</p>` : ""}
        ${sceneLine}
        ${pfBits.length ? `<p class="profile-line">${pfBits.join(" · ")}</p>` : ""}
      </div>
    </div>
    <div class="metric-list">${rows}</div>
    ${curveCard}
    <div class="tips">
      <h3>🔧 问题与原因（按重要性排序）</h3>
      ${tips || "<p>全部指标达标，保持当前动作！</p>"}
    </div>
    ${opts.note ? `<p class="report-warn">${opts.note}</p>` : ""}
    ${experimentalWarn}
    <p class="report-note">指标基于 2D 骨架估算，存在测量误差；投篮常有 20–45° 转体站位，会放大正面视角的肘外展/左右偏移读数。下蹲膝角、出手方向角、出手高度、躯干倾斜四项区间已按投篮科研实测数据校准，其余为文献常识启发值；各项均为动作形态筛查而非命中率预测；单机位视角盲区见「补拍建议」，多角度融合可补全。主报告、融合报告与不同机位/投篮类型的计分口径不同（计分指标与权重不同），分数不能跨报告、跨版本直接比较。请作为训练参考而非绝对标准。</p>
  `;
}
