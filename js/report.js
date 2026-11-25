// 评分规则引擎与报告渲染：指标 → 评分/评级 → 针对性中文建议（不依赖任何外部服务）
import { JUMP_MIN, TREND_ONLY } from "./metrics.js";
import { lineChart } from "./charts.js";
import { METRIC_PLAIN, UNIT_PLAIN } from "./glossary.js";
import { describePosition } from "./tracks.js";
import { VIEW_LABEL } from "./views.js";

export const TYPE_LABEL = { jump: "跳投", mid: "中投", free: "罚球", three: "三分" };

// HTML 转义：档案文件可以从外部导入，里面的字段内容不可信——
// 所有来自记录数据的字段插进 innerHTML 前都要先过这一道
const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export function escHtml(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ESC_MAP[c]);
}

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

/**
 * 出手高度的建议文案：两个方向分开写 + 按投篮类型自适应。
 * 读数低于下缘与高于上缘是两种不同的问题，写成同一句会出现「高于区间却说偏低」的自相矛盾；
 * 自动识别成罚球时也不能说「跳投出手手高」。
 *
 * 区间数字一律取本次实际判定的 m.lo/m.hi（js/metrics.js 按起跳与否自适应），
 * 不在这里写死 105%–130%——否则定点罚球会被按跳投口径解释。
 */
function releaseHeightTip(m, type) {
  const lo = Math.round((m.lo ?? 0) * 100);
  const hi = Math.round((m.hi ?? 0) * 100);
  // 区间名跟着报告口径走：罚球口径说「罚球出手点」，跳投口径才说「跳投出手手高」。
  // 点罚球起跳与否另说，但报告口径是罚球时不能拿跳投手高去解释读数。
  const bandName = type === "free" ? "罚球出手点" : m.jumped ? "跳投出手手高" : "定点出手点";
  const band = `实测射手带（${bandName}约为身高的 ${lo}%–${hi}%）`;
  const ctx = type === "free" ? "罚球" : "跳投";
  const low = m.num < m.lo;
  if (m.verdict === "good") return `出手点 ${m.value}，落在${band}内。`;
  if (m.verdict === "warn") {
    return low
      ? `出手点 ${m.value}，略低于${band}的下缘——出手被压得偏低，出手角度略压。`
      : `出手点 ${m.value}，略高于${band}的上缘——按${ctx}口径出手点偏高，也可能是机位/透视把读数放大了，建议换侧面机位复核。`;
  }
  return low
    ? `出手点 ${m.value}，明显低于${band}——出手被压低后弧线受压，封盖风险和落点偏差同时上升。`
    : `出手点 ${m.value}，明显高于${band}——按${ctx}口径出手点偏高，球在头前离手，出手角度更难压住；也可能只是机位/透视把读数放大了，建议换侧面机位复核。`;
}

// 「较上次」差值的显示格式：数值越大越不需要小数位（角度类 100° 以上不带 .0）
function formatDelta(delta) {
  const s = Math.abs(delta) >= 100 ? delta.toFixed(0) : delta.toFixed(1);
  return delta > 0 ? `+${s}` : s;
}

/**
 * 单位与参考区间的白话说明。
 * 数值本身的呈现格式一个字不动（避免影响现有测试与读数习惯），
 * 只在展开说明里补一句"这个单位/区间是什么意思"。
 */
function plainUnitLine(m) {
  const unitName = UNIT_PLAIN[m.unit];
  const range = String(m.rangeText ?? "").trim();
  const parts = [];
  if (unitName) parts.push(`单位是${unitName}`);
  // 区间型（"0–45°"）说人话是"正常范围"；文字型（"需起跳"）原样带出
  if (/^\d/.test(range)) parts.push(`参考区间 ${range} 就是正常范围`);
  else if (range) parts.push(`参考说明：${range}`);
  return parts.length ? `${parts.join("；")}。` : "";
}

/**
 * 读数可信度前置（v5.9 改动 4）：判断这份读数能不能给分数与等级。
 * 满足任一条件就只出「这次读数只能作参考」+ 具体原因，不出 0–100 分数与 S/A/B/C/D 等级——
 * 分数在这种素材上是最具误导性的东西：它看起来最正式，却最没有依据。
 *
 * ctx:
 *   · unstable / unstableReasons —— 机位判定是否不固定及其依据
 *   · peopleSeen                 —— 画面里出现的人数
 *   · hasShot                    —— 主体轨迹是否检测到出手动作
 *   · subjectFrames / totalFrames—— 计入主体的有效帧 / 总帧
 *   · droppedFrames              —— 锁定/剔除导致没计入的帧
 *   · qualityLevel               —— 素材质量等级（bad 时同样不出分）
 */
export function noScoreReasons(ctx = {}) {
  const {
    unstable = false, unstableReasons = [],
    peopleSeen = 1, hasShot = false,
    subjectFrames = 0, totalFrames = 0, droppedFrames = 0,
    qualityLevel = null,
  } = ctx;
  const reasons = [];
  if (unstable) {
    reasons.push(
      `机位在拍摄过程中变化，本次读数为近似值（${unstableReasons.join("；") || "机位判定不稳定"}）`
    );
  }
  if (peopleSeen > 1 && !hasShot) {
    reasons.push(`画面里有 ${peopleSeen} 个人，但没能确定谁在投`);
  }
  if (!hasShot) {
    reasons.push("没有检测到完整的投篮动作（手腕连续高于肩 4 帧以上），读数仅供参考");
  }
  const total = totalFrames || 1;
  const validShare = subjectFrames / total;
  if (validShare < 0.7) {
    reasons.push(`主体有效帧占比只有 ${Math.round(validShare * 100)}%（${subjectFrames}/${total}），不足 70%`);
  }
  if (droppedFrames / total > 0.2) {
    reasons.push(`锁定/剔除导致的丢帧 ${Math.round((droppedFrames / total) * 100)}%，超过 20%`);
  }
  if (qualityLevel === "bad") {
    reasons.push("素材质量不合格（见下方质量提醒）");
  }
  return reasons;
}

/**
 * 主体是谁：一句话说明（画面哪个位置、有没有出手动作、出手在哪几秒）
 * 纯函数：app.js 与离线回放工具（tools/replay-landmarks.mjs）共用同一份口径，
 * 报告里写的和验收脚本看到的永远是同一句话。
 */
export function subjectLabelText(subject) {
  const tr = subject?.track;
  if (!tr) return "未能确定";
  const spans = tr.stats.shotSpans ?? [];
  if (spans.length) {
    const s = spans[0];
    // 位置用「出手那一刻」的横向位置：整条轨迹的中位会把位置说偏
    // （真实素材里，人是出手的同时往画面右边走出画面的）
    const pos = describePosition(tr.stats.shotX ?? tr.stats.x);
    return `${pos}正在出手的那个（${s.from.toFixed(1)}–${s.to.toFixed(1)} 秒）`;
  }
  const pos = describePosition(tr.stats.x);
  return `${pos}的那个人（未检测到出手动作）`;
}

/**
 * 主体是谁（短版）：位置 + 出手时刻区间，给「画面里有几个人」这类提示用。
 * 没有出手动作时返回 null——调用方据此区分「按出手证据选到了人」和「没选到」。
 */
export function subjectShotDesc(subject) {
  const tr = subject?.track;
  if (!tr) return null;
  const spans = tr.stats.shotSpans ?? [];
  if (!spans.length) return null;
  const s = spans[0];
  const pos = describePosition(tr.stats.shotX ?? tr.stats.x);
  return `${pos}，${s.from.toFixed(1)}–${s.to.toFixed(1)} 秒`;
}

/**
 * 报告顶部固定一行摘要：测到几项 · 机位与依据 · 主体是谁 · 有效帧多少
 */
export function summaryLineText({
  metricCount = 0, metricTotal = 0,
  view = "unknown", viewInfo = null,
  subject = null, subjectFrames = 0, totalFrames = 0,
  detectedFrames = 0, invalidFrames = 0,
} = {}) {
  const viewText = viewInfo
    ? `${VIEW_LABEL[view]}（依据：${viewInfo.reason}）`
    : VIEW_LABEL[view];
  const items = metricCount ? `本次测到 ${metricCount}/${metricTotal} 项` : "";
  // 帧的账一次说清，三个口径分开写：同一个词「有效帧」在摘要和「只能作参考」里
  // 说的不是一回事，会让人以为算错了。
  //   · 检出 = 认出有人像的帧
  //   · 有效 = 姿态可用、没被剔除的帧（检出 − 无效姿态）
  //   · 主体 = 其中算在主体头上的帧（别人的帧不计入）
  const validFrames = Math.max(0, detectedFrames - invalidFrames);
  const frameNote = invalidFrames
    ? `（主体计入 ${subjectFrames}，已剔除 ${invalidFrames} 帧无效姿态）`
    : `（主体计入 ${subjectFrames}）`;
  return [
    items,
    `机位：${viewText}`,
    `主体：${subjectLabelText(subject)}`,
    `检出 ${detectedFrames}/${totalFrames} 帧人像`,
    `有效 ${validFrames}/${totalFrames} 帧${frameNote}`,
  ].filter(Boolean).join(" · ");
}

/**
 * 状态行：识别完成后那句话（主体有效帧 / 剔除的无效姿态 / 主体是谁 / 机位）
 */
export function statusLineText({
  subjectFrames = 0, totalFrames = 0,
  detectedFrames = 0, invalidFrames = 0, otherFrames = 0,
  peopleSeen = 1, subject = null,
  view = "unknown", viewInfo = null, failedFrames = 0,
} = {}) {
  return (
    `识别完成：${detectedFrames}/${totalFrames} 帧检测到人像` +
    `（已剔除 ${invalidFrames} 帧无效姿态；主体有效帧 ${subjectFrames}，${otherFrames} 帧未计入）` +
    `${peopleSeen > 1 ? `（画面出现 ${peopleSeen} 人）` : ""}` +
    `，主体：${subjectLabelText(subject)}，机位：${VIEW_LABEL[view]}${viewInfo?.unstable ? "（不固定）" : ""}。` +
    `${failedFrames ? `⚠️ ${failedFrames} 帧推理失败已插值。` : ""}报告已生成，也可点击播放查看骨架叠加。`
  );
}

export function buildReport(metrics, type, cycleCount = 1, opts = {}) {
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
    // 斜侧近似项：读数会偏大，不直接判「需重点纠正」（降级为待改进，并在行内标注）
    if (m.approxNote && verdict === "bad") verdict = "warn";
    if (m.id === "jump") {
      verdict = m.num > JUMP_MIN ? (type === "free" ? "warn" : "good") : type === "free" ? "good" : "warn";
      if (type === "free") name = "罚球贴地"; // 自动识别为罚球时按罚球口径命名
    }
    return { ...m, verdict, name };
  });
  const scored = judged.filter((m) => m.verdict !== "info"); // info=趋势参考，不计分
  const totalW = scored.reduce((s, m) => s + m.weight, 0);
  const rawScore = Math.round(
    (scored.reduce((s, m) => s + m.weight * ({ good: 1, warn: 0.5, bad: 0 })[m.verdict], 0) /
      (totalW || 1)) * 100
  );
  const rawGrade = rawScore >= 90 ? "S" : rawScore >= 75 ? "A" : rawScore >= 60 ? "B" : rawScore >= 45 ? "C" : "D";
  // v5.9：读数不可信时不出分数与等级（机位不固定 / 主体存疑 / 有效帧太少 / 素材质量差）。
  // 分数与等级在这种素材上是最具误导性的东西——它看起来最正式，却最没有依据。
  const noScoreReasons = (opts.noScoreReasons ?? []).filter(Boolean);
  const score = noScoreReasons.length ? null : rawScore;
  const grade = noScoreReasons.length ? null : rawGrade;
  // 建议带实测值与回看帧号（frame 由 computeMetrics 附带），渲染层据此提供「点击回看视频瞬间」
  const tips = judged
    .filter((m) => m.verdict === "warn" || m.verdict === "bad")
    .sort((a, b) => b.weight - a.weight)
    .map((m) => {
      if (m.id === "releaseHeight") {
        return { name: m.name, level: m.verdict, value: m.value, frame: m.frame, text: releaseHeightTip(m, type) };
      }
      const t = TIPS[tipId(m, type)];
      return {
        name: m.name, level: m.verdict, value: m.value, frame: m.frame,
        text: (t?.[m.verdict] ?? "").replace("{v}", m.value),
      };
    })
    .filter((t) => t.text);
  return { type, score, grade, metrics: judged, tips, cycleCount, autoType, noScore: noScoreReasons.length ? noScoreReasons : null };
}

export function renderReport(el, report, opts = {}) {
  const vIcon = { good: "✅", warn: "⚠️", bad: "❌", info: "ℹ️" };
  const count = (v) => report.metrics.filter((m) => m.verdict === v).length;
  const canJump = (f) => f != null && !!opts.jump; // 只有主报告接了回看监听，才显示点击跳转
  const compare = opts.compare ?? {}; // 由 app.js 用 compareMetric 算好：{ [指标id]: {prev, delta, better, count} }
  // 读数只能作参考（机位不固定 / 主体存疑 / 有效帧不足）时，判语必须带限定：
  // 「❌ 需重点纠正」看上去像硬结论，但读数只是近似值，不能那么读。
  const referenceOnly = !!report.noScore;
  const approxBadge = '<i class="m-approx">近似值，仅供参考</i>';

  // 「较上次」标记：箭头跟数值增减（↑ 就是比上次大），颜色跟「变好/变差」（better 字段）——
  // 头部晃动、重心横移这类越小越好的指标，数值下降才是变好，颜色不能跟着数值走
  const trendTag = (m) => {
    const c = compare[m.id];
    if (!c || c.delta == null || !isFinite(c.delta) || c.delta === 0) return "";
    const better = c.better === true;
    const worse = c.better === false;
    // 方向不明的指标（腿臂分离时差等：正值代表顺序正确，不是「越大越好」）不标好坏，只报差值
    const cls = better ? "good" : worse ? "bad" : "neutral";
    return `<small class="m-trend ${cls}">${c.delta > 0 ? "↑" : "↓"} 比上次 ${formatDelta(c.delta)}${
      TREND_ONLY.has(m.id) || m.verdict === "info" ? "（趋势）" : ""
    }</small>`;
  };

  // 每个指标行后面挂一个可展开的白话说明：点一下就在这一行下面摊开，
  // 不做 hover 提示——普通球友是截图发群的，悬停提示进了截图就不存在了
  const rows = report.metrics
    .map((m) => {
      const plain = METRIC_PLAIN[m.id];
      const infoBtn = plain
        ? `<button type="button" class="m-info" aria-expanded="false" title="这一项在说什么？">ⓘ</button>`
        : "";
      const plainPanel = plain
        ? `<div class="metric-plain" hidden>
            <p class="mp-say">${escHtml(plain.say)}</p>
            <p class="mp-why"><b>为什么值得看：</b>${escHtml(plain.why)}</p>
            <p class="mp-unit">${escHtml(plainUnitLine(m))}</p>
          </div>`
        : "";
      return `
      <div class="metric-item" data-metric="${escHtml(m.id)}">
        <div class="metric-row ${m.verdict}">
          <span class="m-name">${m.name}${m.src ? ` <i class="m-src">${m.src}</i>` : ""}${infoBtn}${
            m.approxNote ? `<i class="m-approx">${escHtml(m.approxNote)}</i>` : ""
          }</span>
          <span class="m-value">${m.value}<small>参考 ${m.rangeText}</small>${trendTag(m)}</span>
          <span class="m-icon">${vIcon[m.verdict]}</span>${
            referenceOnly && (m.verdict === "bad" || m.verdict === "warn") ? approxBadge : ""
          }
        </div>${plainPanel}
      </div>`;
    })
    .join("");

  const tips = report.tips
    .map(
      (t) => `
      <div class="tip-card${canJump(t.frame) ? " clickable" : ""}"${canJump(t.frame) ? ` data-frame="${t.frame}"` : ""}>
        <b>${t.level === "bad" && !referenceOnly ? "❌" : "⚠️"} ${t.name} ${t.value ?? ""}</b>
        <p>${t.text}</p>
        ${referenceOnly ? `<p class="m-approx">近似值，仅供参考（本次读数只能作参考）</p>` : ""}
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

  // 术语表：只列本次报告里真实出现过的指标，方便想一次看完的人
  const appeared = report.metrics.filter((m) => METRIC_PLAIN[m.id]);
  const glossaryBox = appeared.length
    ? `<details class="glossary-box">
        <summary>📖 术语表（本次报告出现的 ${appeared.length} 项指标）</summary>
        <ul class="glossary-list">${appeared
          .map((m) => `<li><b>${escHtml(m.name)}</b> —— ${escHtml(METRIC_PLAIN[m.id].say)}</li>`)
          .join("")}</ul>
      </details>`
    : "";

  // v5.9：报告顶部固定一行摘要（测到几项 / 机位与依据 / 主体是谁 / 有效帧多少）
  const summaryLine = opts.summaryLine
    ? `<p class="summary-line">${escHtml(opts.summaryLine)}</p>`
    : "";

  // 素材质量提醒与「读数只能作参考」合并成同一个提示块：
  // 页面上下两处各说一遍会互相打架（一边说「锁定占画面最大的那个」，一边说主体是按出手动作选的）。
  const qualityItems =
    opts.quality && opts.quality.level !== "ok"
      ? (opts.quality.issues ?? []).map((i) => `${i.title}：${i.text}`)
      : [];
  const noticeItems = [...(report.noScore ?? []), ...qualityItems];
  const noticeBlock = noticeItems.length
    ? `<div class="report-noscore">
        <b>${
          report.noScore
            ? "⚠️ 这次读数只能作参考"
            : "⚠️ 素材质量提醒（报告还能看，但读数可能不稳）"
        }</b>
        <ul>${noticeItems.map((r) => `<li>${escHtml(r)}</li>`).join("")}</ul>
      </div>`
    : "";

  // 素材质量良好时只是一行轻量说明，不算提醒块（没有提醒可合并时单独出现）
  const qualityOkLine =
    opts.quality?.level === "ok" && !noticeBlock
      ? `<p class="report-quality ok">✅ 素材质量：良好（认出 ${Math.round((opts.quality.stats?.frameRatio ?? 0) * 100)}% 的画面${
          opts.quality.stats?.personHeight > 0
            ? `，人占画面高度 ${Math.round(opts.quality.stats.personHeight * 100)}%`
            : ""
        }）。</p>`
      : "";

  el.innerHTML = `
    <div class="report-head">
      ${summaryLine}
      ${noticeBlock}
      ${qualityOkLine}
    </div>
    <div class="report-summary">
      ${
        report.score == null
          ? `<div class="score-none"><b>—</b><small>不出分</small></div>`
          : `<div class="score-ring" style="--p:${report.score}">
              <div class="score-inner"><b>${report.score}</b><small>${report.grade}</small></div>
            </div>`
      }
      <div class="summary-text">
        <h3>${report.title ?? (report.autoType ? `自动识别：按${TYPE_LABEL[report.type]}标准` : `${TYPE_LABEL[report.type]}姿态评分`)}</h3>
        <p>${count("good")} 项达标 · ${count("warn")} 项待改进 · ${count("bad")} ${
          referenceOnly ? "项值得留意（读数为近似值）" : "项需重点纠正"
        }${count("info") ? ` · ${count("info")} 项趋势参考` : ""}${report.cycleCount > 1 ? ` · 共 ${report.cycleCount} 次出手（指标取中位数）` : ""}</p>
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
    ${glossaryBox}
    ${opts.note ? `<p class="report-warn">${opts.note}</p>` : ""}
    ${experimentalWarn}
    <p class="report-note">指标基于 2D 骨架估算，存在测量误差；投篮常有 20–45° 转体站位，会放大正面视角的肘外展/左右偏移读数。下蹲膝角、出手方向角、出手高度、躯干倾斜四项区间已按投篮科研实测数据校准，其余为文献常识启发值；各项均为动作形态筛查而非命中率预测；单机位视角盲区见「补拍建议」，多角度融合可补全。主报告、融合报告与不同机位/投篮类型的计分口径不同（计分指标与权重不同），分数不能跨报告、跨版本直接比较。请作为训练参考而非绝对标准。</p>
  `;
}
