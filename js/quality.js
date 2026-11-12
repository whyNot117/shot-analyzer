// 素材质量评估 + 拍摄清单
// 为什么单独做一层：报告里的分数只反映"动作长什么样"，读数准不准取决于素材本身——
// 人太小、镜头里没认出人、画面糊了、没拍到完整出手，这些都会让噪声被当成结论。
// 这里的判定只读 frames，不改 frames，也不参与任何评分。

// 第 1 步的拍摄清单：普通球友最容易踩的坑，逐条写成能照做的话。
// 纯行动提示：不持久化、不参与任何判定，也不做成"必须全勾上才能分析"的门槛。
export const SHOT_CHECKLIST = [
  "手机横平竖直，镜头跟胸口差不多高（别俯拍下巴，也别仰拍天花板）",
  "全身入镜：从头到脚都在画面里，人至少占画面高度的三分之一",
  "画面里只有你一个",
  "光线够，别逆光；窗边或室外阴凉处都行",
  "连着投 3–5 次，每次之间留一秒空档（程序会逐次取中位数）",
  "视频 30 秒以内（只分析前 30 秒，太长手机会卡）",
];

// HTML 转义：卡片里的文案虽然都是内部常量，但统一过一道总比漏掉强
const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ESC_MAP[c]);
}

/**
 * 拍摄清单的可复用 HTML：第 1 步的行动清单与「素材不合格」卡片里复用同一份，
 * 免得两处文案各写一遍、日后改一处忘一处。
 */
export function shotChecklistHTML() {
  return (
    '<ul class="checklist">' +
    SHOT_CHECKLIST.map(
      (text) =>
        `<li><label class="check-item"><input type="checkbox" class="shot-check"><span>${esc(text)}</span></label></li>`
    ).join("") +
    "</ul>"
  );
}

// 把清单渲染进容器（第 1 步的卡片）
export function renderShotChecklist(container) {
  if (!container) return;
  container.innerHTML = shotChecklistHTML();
}

/**
 * 素材质量卡片的 HTML。
 * 放在这里而不是 app.js 里：卡片长什么样是"素材质量"这件事的一部分，
 * 和判定逻辑放在一起才不用在两个文件里来回找；app.js 只负责把它插进页面。
 */
export function qualityCardHTML(q) {
  if (!q) return "";
  const items = q.issues
    .map(
      (i) => `<li class="qi-item">
        <b>${esc(i.title)}</b>
        <p>${esc(i.text)}</p>
        <p class="qi-fix">👉 ${esc(i.fix)}</p>
      </li>`
    )
    .join("");
  if (q.level === "bad") {
    return `<div class="quality-card bad">
      <h3>🚫 这段素材还读不出结果</h3>
      <p class="qc-lead">问题不在你的动作，在这段素材本身没法可靠地量。下面每一条都写清了怎么重拍：</p>
      <ul class="qi-list">${items}</ul>
      <h4 class="qc-sub">📹 下次这样拍（这几条直接决定读数准不准）</h4>
      ${shotChecklistHTML()}
      <p class="qc-foot">按上面这几条重拍一段再传，这次就能出报告了。</p>
    </div>`;
  }
  if (q.level === "warn") {
    return `<div class="quality-card warn">
      <h3>⚠️ 素材质量提醒（报告还能看，但读数可能不稳）</h3>
      <ul class="qi-list">${items}</ul>
    </div>`;
  }
  const st = q.stats ?? {};
  const heightText = st.personHeight > 0 ? `，人占画面高度 ${Math.round(st.personHeight * 100)}%` : "";
  return `<p class="quality-ok">✅ 素材质量：良好（认出 ${Math.round((st.frameRatio ?? 0) * 100)}% 的画面${heightText}），这次读数可以信。</p>`;
}

// MediaPipe 33 点里没有"头顶"点：用鼻子与两只耳朵里最高的一个近似头顶
const HEAD_IDX = [0, 7, 8];
const ANKLE_IDX = [27, 28];

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function pct(v) {
  return `${Math.round((v ?? 0) * 100)}%`;
}

/**
 * 单帧的人体纵向高度：头顶到脚踝的 y 跨度。
 * 归一化坐标的 y 本来就是相对画面高度（0–1），跨度即"人占了画面高度的百分之多少"。
 * 缺头顶或脚踝关键点的帧直接跳过——宁可少一帧，不要用猜出来的点凑数。
 */
function frameBodyHeight(lm, sideName) {
  if (!lm || !lm.length) return null;
  const headYs = HEAD_IDX.map((i) => lm[i]?.y).filter((y) => typeof y === "number");
  // 优先用面向镜头那一侧的脚踝；另一侧缺失时退回另一只脚踝
  const preferred = sideName === "left" ? 27 : 28;
  const order = [preferred, ...ANKLE_IDX.filter((i) => i !== preferred)];
  const ankleYs = order.map((i) => lm[i]?.y).filter((y) => typeof y === "number");
  if (!headYs.length || !ankleYs.length) return null;
  const height = Math.max(...ankleYs) - Math.min(...headYs);
  return height > 0 ? height : null;
}

/**
 * 评估一段素材能不能读出可信结果。
 *
 * @param {Array} frames 逐帧扫描结果 [{ t, landmarks, aspect }]
 * @param {string} sideName 面向镜头的一侧（"left" / "right"），只影响脚踝取点偏好
 * @param {object} opts { cycleCount, peopleSeen }——周期检测与人脸锁定在别处跑，由调用方传入
 * @returns {{ level: "ok"|"warn"|"bad", stats: object, issues: Array }}
 */
export function assessClipQuality(frames, sideName, opts = {}) {
  const list = Array.isArray(frames) ? frames : [];
  const total = list.length;
  const valid = list.filter((f) => f && f.landmarks && f.landmarks.length);

  // 认出人像的帧数占比：低于 0.4 说明大半画面根本没测到
  const frameRatio = total ? valid.length / total : 0;

  // 人体高度：逐帧取中位数，抗个别异常帧
  const heights = [];
  for (const f of valid) {
    const h = frameBodyHeight(f.landmarks, sideName);
    if (h != null) heights.push(h);
  }
  const personHeight = heights.length ? median(heights) : 0;

  // 关键点可见度：有效帧里所有关键点 visibility 的平均值（越低说明画面糊或被挡）
  let visSum = 0;
  let visCount = 0;
  for (const f of valid) {
    for (const p of f.landmarks) {
      if (p && typeof p.visibility === "number") {
        visSum += p.visibility;
        visCount++;
      }
    }
  }
  const visibility = visCount ? visSum / visCount : 0;

  const cycleCount = Number.isFinite(opts.cycleCount) ? opts.cycleCount : 0;
  const peopleSeen = Number.isFinite(opts.peopleSeen) ? opts.peopleSeen : list.peopleSeen ?? 1;

  const issues = [];

  // 一段画面里连人都没认出来：后面的人太小/有效帧太少都是它的表现，单独说清楚
  if (valid.length === 0) {
    issues.push({
      id: "noPersonDetected",
      level: "bad",
      title: "画面里没认出人",
      text: "整段视频都没有识别到人像，一个关键点都没测到，读不出任何动作。",
      fix: "确认人在画面里、光线够、别逆光，然后重拍一段。",
    });
  } else if (heights.length === 0) {
    // 认出了人，但每帧都缺头顶或脚踝关键点：量不出人高，
    // 这时不能拿 0 当"人太小"下结论——宁可不下结论，也不要冤枉素材
  } else if (personHeight < 0.12) {
    issues.push({
      id: "personTooSmall",
      level: "bad",
      title: "人太小",
      text: `画面里的人只占画面高度的 ${pct(personHeight)}，骨架细节看不清，量出来的角度会明显偏。`,
      fix: "往镜头前站两步，让人至少占画面高度的三分之一。",
    });
  } else if (personHeight < 0.2) {
    issues.push({
      id: "personSmall",
      level: "warn",
      title: "人偏小",
      text: `画面里的人只占画面高度的 ${pct(personHeight)}，读数可能不太稳。`,
      fix: "再站近一点，让人占到画面高度的三分之一以上。",
    });
  }

  if (frameRatio < 0.4) {
    issues.push({
      id: "tooFewValidFrames",
      level: "bad",
      title: "大半画面没识别到人",
      text: `只有 ${pct(frameRatio)} 的画面认出了人，其余部分没测到——读数只代表零碎几帧。`,
      fix: "把灯打开或换个阴凉的室外，别逆光；人别被挡住，手机架稳别晃。",
    });
  } else if (frameRatio < 0.7) {
    issues.push({
      id: "someFramesMissing",
      level: "warn",
      title: "部分画面没识别到人",
      text: `有 ${pct(1 - frameRatio)} 的画面没认出人，这些片段的数据是缺的。`,
      fix: "光线调亮一点、画面里别有遮挡物，尽量把手机架稳。",
    });
  }

  if (visibility < 0.5) {
    issues.push({
      id: "lowVisibility",
      level: "warn",
      title: "画面偏糊或身体被挡住",
      text: `关键点平均只认出 ${pct(visibility)}，量出来的角度容易糊。`,
      fix: "光线足一点、背景干净一点，避免球挡住手。",
    });
  }

  if (cycleCount === 0) {
    issues.push({
      id: "noShotCycle",
      level: "bad",
      title: "没看到一次完整的出手",
      text: "整段视频里没有一次完整的出手动作（站姿 → 下蹲 → 出手 → 跟随），没有动作就没法量。",
      fix: "把整段动作一次拍全：站直 → 下蹲 → 出手 → 跟着甩出去。",
    });
  }

  if (peopleSeen > 1) {
    issues.push({
      id: "multiplePeople",
      level: "warn",
      title: `画面里有 ${peopleSeen} 个人`,
      text: `画面里出现了 ${peopleSeen} 个人，已经锁定占画面最大的那个；如果锁的不是你，这段结果就不能用。`,
      fix: "确认被锁定的是你；锁错了就换一段只有你一个人的视频。",
    });
  }

  const level = issues.some((i) => i.level === "bad") ? "bad" : issues.length ? "warn" : "ok";

  return {
    level,
    stats: { frameRatio, personHeight, visibility, cycleCount, peopleSeen },
    issues,
  };
}
