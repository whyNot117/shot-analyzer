// 素材质量评估的合成测试（不依赖浏览器/DOM）
// 运行：node test/quality-test.mjs
import { assessClipQuality, qualityCardHTML, SHOT_CHECKLIST, shotChecklistHTML } from "../js/quality.js";

let failures = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failures++;
    console.log(`  ❌ ${name}${detail ? " —— " + detail : ""}`);
  }
};

/**
 * 造一段合成画面：
 * height —— 人在画面里占的高度（0–1）；top —— 头顶所在的 y；
 * vis —— 关键点可见度；nullFrames —— 这些帧没认出人（landmarks 为 null）。
 */
function makeFrames(count, { height = 0.5, top = 0.2, vis = 0.9, nullFrames = [] } = {}) {
  const frames = [];
  for (let i = 0; i < count; i++) {
    if (nullFrames.includes(i)) {
      frames.push({ t: i / 30, landmarks: null, aspect: 0.5625 });
      continue;
    }
    const lm = Array.from({ length: 33 }, (_, k) => ({
      x: 0.5,
      y: k === 0 || k === 7 || k === 8 ? top : k === 27 || k === 28 ? top + height : 0.5,
      visibility: vis,
    }));
    frames.push({ t: i / 30, landmarks: lm, aspect: 0.5625 });
  }
  return frames;
}

console.log("== 拍摄清单 ==");
check("清单有 6 条", SHOT_CHECKLIST.length === 6, `实际 ${SHOT_CHECKLIST.length} 条`);
check("清单每条都是非空文字", SHOT_CHECKLIST.every((t) => typeof t === "string" && t.trim().length > 0));
check("清单渲染成真正的 checkbox 标签", /<label[^>]*>\s*<input type="checkbox"/.test(shotChecklistHTML()));
check("清单不含 localStorage/持久化痕迹", !/localStorage|sessionStorage/i.test(shotChecklistHTML()));

console.log("== 情形 1：人像占比过小 → bad ==");
{
  // 人只占画面高度 8%（< 12%），但每一帧都认出了人
  const q = assessClipQuality(makeFrames(30, { height: 0.08 }), "right", { cycleCount: 2, peopleSeen: 1 });
  check("级别是 bad", q.level === "bad", `实际 ${q.level}`);
  check("有「人太小」的问题", q.issues.some((i) => i.id === "personTooSmall"), JSON.stringify(q.issues.map((i) => i.id)));
  check("personHeight 统计正确（约 0.08）", Math.abs(q.stats.personHeight - 0.08) < 0.02, `实际 ${q.stats.personHeight}`);
  check("每条问题都有可执行的 fix", q.issues.every((i) => i.fix && i.fix.trim().length > 0));
  check("每条问题都有非空 title/text", q.issues.every((i) => i.title?.trim() && i.text?.trim()));
}

console.log("== 情形 2：有效帧过少 → bad ==");
{
  // 30 帧里只有 6 帧认出人（20% < 40%）
  const nullFrames = [];
  for (let i = 6; i < 30; i++) nullFrames.push(i);
  const q = assessClipQuality(makeFrames(30, { height: 0.5, nullFrames }), "right", { cycleCount: 1, peopleSeen: 1 });
  check("级别是 bad", q.level === "bad", `实际 ${q.level}`);
  check("有「大半画面没识别到人」的问题", q.issues.some((i) => i.id === "tooFewValidFrames"), JSON.stringify(q.issues.map((i) => i.id)));
  check("frameRatio 统计正确（约 0.2）", Math.abs(q.stats.frameRatio - 0.2) < 0.02, `实际 ${q.stats.frameRatio}`);
}

console.log("== 情形 3：正常素材 → ok ==");
{
  const q = assessClipQuality(makeFrames(30, { height: 0.5, vis: 0.9 }), "right", { cycleCount: 3, peopleSeen: 1 });
  check("级别是 ok", q.level === "ok", `实际 ${q.level}（${JSON.stringify(q.issues)}）`);
  check("没有 issues", q.issues.length === 0);
  check("cycleCount 统计正确", q.stats.cycleCount === 3, `实际 ${q.stats.cycleCount}`);
  check("peopleSeen 统计正确", q.stats.peopleSeen === 1, `实际 ${q.stats.peopleSeen}`);
  check("visibility 统计正确（约 0.9）", Math.abs(q.stats.visibility - 0.9) < 0.02, `实际 ${q.stats.visibility}`);
}

console.log("== 情形 4：画面有多人 → warn（带说明） ==");
{
  const q = assessClipQuality(makeFrames(30, { height: 0.5 }), "right", { cycleCount: 2, peopleSeen: 3 });
  check("级别是 warn", q.level === "warn", `实际 ${q.level}`);
  const multi = q.issues.find((i) => i.id === "multiplePeople");
  check("有「画面里有 3 个人」的问题", !!multi, JSON.stringify(q.issues.map((i) => i.id)));
  check("多人问题文案里写明了人数", !!multi && multi.text.includes("3"));
  check("多人问题给了可执行的 fix", !!multi && multi.fix.trim().length > 0);
}

console.log("== 补充：没拍到完整出手 → bad ==");
{
  const q = assessClipQuality(makeFrames(30, { height: 0.5 }), "right", { cycleCount: 0, peopleSeen: 1 });
  check("级别是 bad", q.level === "bad", `实际 ${q.level}`);
  check("有「没看到一次完整的出手」的问题", q.issues.some((i) => i.id === "noShotCycle"));
}

console.log("== 补充：一个关键点都没认出来 → bad ==");
{
  const nullFrames = [];
  for (let i = 0; i < 30; i++) nullFrames.push(i);
  const q = assessClipQuality(makeFrames(30, { height: 0.5, nullFrames }), "right", { cycleCount: 0, peopleSeen: 1 });
  check("级别是 bad", q.level === "bad", `实际 ${q.level}`);
  check("有「画面里没认出人」的问题", q.issues.some((i) => i.id === "noPersonDetected"));
}

console.log("== 质量卡片渲染 ==");
{
  const bad = assessClipQuality(makeFrames(30, { height: 0.08 }), "right", { cycleCount: 2, peopleSeen: 1 });
  const badHtml = qualityCardHTML(bad);
  check("bad 卡片有标题", badHtml.includes("这段素材还读不出结果"));
  check("bad 卡片把清单也列了一遍", (badHtml.match(/class="check-item"/g) ?? []).length === 6);
  check("bad 卡片每条问题都带 fix", badHtml.includes("qi-fix"));

  const warn = assessClipQuality(makeFrames(30, { height: 0.5 }), "right", { cycleCount: 2, peopleSeen: 3 });
  const warnHtml = qualityCardHTML(warn);
  check("warn 卡片是提醒而不是拦截", warnHtml.includes("素材质量提醒") && !warnHtml.includes("这段素材还读不出结果"));

  const ok = assessClipQuality(makeFrames(30, { height: 0.5 }), "right", { cycleCount: 2, peopleSeen: 1 });
  const okHtml = qualityCardHTML(ok);
  check("ok 卡片只有一行轻量说明", okHtml.includes("素材质量：良好") && !okHtml.includes("qi-item"));
}

if (failures) {
  console.error(`\n❌ 素材质量测试失败：${failures} 项`);
  process.exit(1);
}
console.log("\n🎉 素材质量测试全部通过");
