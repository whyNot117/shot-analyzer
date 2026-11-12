// 术语白话化的守门测试
// 运行：node test/glossary-test.mjs
import { METRIC_VIEWS } from "../js/metrics.js";
import { METRIC_PLAIN, UNIT_PLAIN } from "../js/glossary.js";

let failures = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failures++;
    console.log(`  ❌ ${name}${detail ? " —— " + detail : ""}`);
  }
};

// 报告口径是「只讲原因、不给方法」——出现训练方法类词汇就算破坏口径
const METHOD_WORDS = ["练习", "多练", "建议练", "训练方法", "训练", "练一练", "勤练", "刻意练", "训练计划", "多加", "针对性训练"];

const ids = Object.keys(METRIC_VIEWS);

console.log("== 覆盖率：每个指标都要有白话文案 ==");
check("指标数量符合预期（24 项）", ids.length === 24, `实际 ${ids.length} 项`);
for (const id of ids) {
  check(`${id} 有白话文案`, !!METRIC_PLAIN[id]);
}
check(
  "没有多余的文案条目",
  Object.keys(METRIC_PLAIN).every((id) => ids.includes(id)),
  `多出来的：${Object.keys(METRIC_PLAIN).filter((id) => !ids.includes(id)).join(", ")}`
);

console.log("== 文案质量 ==");
for (const id of ids) {
  const p = METRIC_PLAIN[id];
  if (!p) continue;
  const say = String(p.say ?? "");
  const why = String(p.why ?? "");
  check(`${id} 的 say 非空且长度合理`, say.trim().length >= 6 && say.length <= 40, `实际 ${say.length} 字：${say}`);
  check(`${id} 的 why 非空且长度合理`, why.trim().length >= 8 && why.length <= 60, `实际 ${why.length} 字：${why}`);
  const bad = METHOD_WORDS.filter((w) => say.includes(w) || why.includes(w));
  check(`${id} 不含方法论词`, bad.length === 0, `出现：${bad.join("、")}`);
}

console.log("== 单位白话 ==");
check("常用单位都有白话解释", ["°", "°/s", "ms", "s", "×身高"].every((u) => !!UNIT_PLAIN[u]));

if (failures) {
  console.error(`\n❌ 术语表测试失败：${failures} 项`);
  process.exit(1);
}
console.log("\n🎉 术语表测试全部通过");
