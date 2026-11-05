// v5.5 新模块测试：训练档案存储层（js/history.js）+ 零依赖 SVG 图表（js/charts.js）
// 跑法：node test/v5.5-module-test.mjs
// 存储层用内存实现注入，不碰 localStorage（Node 里没有这个全局）。
import {
  listRecords, addRecord, removeRecord, clearRecords,
  exportText, importText, metricSeries, compareMetric, summarize, makeRecord,
  HISTORY_KEY, MAX_RECORDS,
} from "../js/history.js";
import { lineChart, sparkline } from "../js/charts.js";

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name}${detail ? ` —— ${detail}` : ""}`); fail++; }
}

// 内存版 localStorage
function memStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

const fakeReport = (over = {}) => ({
  type: "jump", score: 82, grade: "A", cycleCount: 2,
  metrics: [
    { id: "kneeCrouch", num: 100, value: "100°", unit: "°", verdict: "good", name: "下蹲膝角", lo: 90, hi: 120 },
    { id: "headDrift", num: 0.05, value: "0.05", unit: "×身高", verdict: "good", name: "头部晃动", lo: 0, hi: 0.15 },
  ],
  ...over,
});

console.log("— 训练档案：存取 —");
{
  const s = memStorage();
  check("空档案读取返回空数组", listRecords(s).length === 0);

  const rec = makeRecord({ report: fakeReport(), ts: 1700000000000, view: "side" });
  addRecord(s, rec);
  const list = listRecords(s);
  check("存入后能读回 1 条", list.length === 1, `n=${list.length}`);
  check("记录含日期字段", /^\d{4}-\d{2}-\d{2}$/.test(rec.date), rec.date);
  check("记录含指标读数", rec.metrics.kneeCrouch?.num === 100);
  check("记录存了指标区间（趋势图要画参考带）", rec.metrics.kneeCrouch?.lo === 90 && rec.metrics.kneeCrouch?.hi === 120);

  addRecord(s, makeRecord({ report: fakeReport({ score: 90, grade: "S" }), ts: 1700000001000 }));
  check("新的记录排在最前（倒序）", listRecords(s)[0].score === 90);
  check("id 唯一", new Set(listRecords(s).map((r) => r.id)).size === 2);

  removeRecord(s, rec.id);
  check("删除后剩 1 条", listRecords(s).length === 1);
  clearRecords(s);
  check("清空后为空", listRecords(s).length === 0);
}

console.log("— 训练档案：损坏数据不崩 —");
{
  const s = memStorage();
  s.setItem(HISTORY_KEY, "{不是合法 JSON");
  check("损坏的 JSON 读取返回空数组", listRecords(s).length === 0);
  s.setItem(HISTORY_KEY, JSON.stringify([{ "没有 id 字段": 1 }]));
  check("缺 id 的记录被过滤掉", listRecords(s).length === 0);
  s.setItem(HISTORY_KEY, JSON.stringify("我不是数组"));
  check("非数组内容返回空数组", listRecords(s).length === 0);
  check("存储层为 null 时返回空数组（隐私模式降级）", listRecords(null).length === 0);
}

console.log("— 训练档案：导出/导入 —");
{
  const s1 = memStorage();
  addRecord(s1, makeRecord({ report: fakeReport(), ts: 1700000000000 }));
  addRecord(s1, makeRecord({ report: fakeReport({ score: 70 }), ts: 1700000002000 }));
  const text = exportText(s1);
  const parsed = JSON.parse(text);
  check("导出的是带 records 的 JSON", Array.isArray(parsed.records) && parsed.records.length === 2);

  const s2 = memStorage();
  const r = importText(s2, text);
  check("导入成功并写入 2 条", r.ok && listRecords(s2).length === 2, JSON.stringify(r));

  const r2 = importText(s2, text); // 重复导入应按 id 去重，不翻倍
  check("重复导入按 id 去重", listRecords(s2).length === 2, `n=${listRecords(s2).length}`);

  const bad = importText(s2, "{{{ 不是 JSON");
  check("非法 JSON 导入给出错误提示", !bad.ok && !!bad.error);
  const bad2 = importText(s2, JSON.stringify({ foo: 1 }));
  check("没有 records 字段时给出错误提示", !bad2.ok && !!bad2.error);
}

console.log("— 训练档案：趋势对比 —");
{
  const recs = [
    { id: "r3", ts: 300, score: 90, metrics: { kneeCrouch: { num: 100 } } },
    { id: "r2", ts: 200, score: 80, metrics: { kneeCrouch: { num: 105 } } },
    { id: "r1", ts: 100, score: 70, metrics: { kneeCrouch: { num: 110 } } },
  ];
  const series = metricSeries(recs, "kneeCrouch");
  check("指标序列按时间正序", series.map((p) => p.ts).join(",") === "100,200,300");
  check("缺该指标的记录被跳过", metricSeries(recs, "headDrift").length === 0);

  const c = compareMetric(recs, "kneeCrouch", 95, { lowerIsBetter: true });
  check("与上次的差值 = 当前 − 上次", c.delta === -5, `delta=${c.delta}`);
  check("越小越好时方向翻转（数值下降算变好）", c.better === true);
  const c2 = compareMetric(recs, "kneeCrouch", 95, { lowerIsBetter: false });
  check("越大越好时数值变小判为变差", c2.better === false);
  check("越小越好时历史最好值取最小", c.best === 100, `best=${c.best}`);
  check("越大越好时历史最好值取最大", compareMetric(recs, "kneeCrouch", 95).best === 110);

  const none = compareMetric([], "kneeCrouch", 95);
  check("没有历史时不报错且 delta 为 null", none.delta === null && none.count === 0);
}

console.log("— 训练档案：总览 —");
{
  const recs = [
    { id: "a", ts: 300, score: 90 },
    { id: "b", ts: 200, score: 80 },
    { id: "c", ts: 100, score: 70 },
  ];
  const sum = summarize(recs);
  check("次数统计正确", sum.count === 3);
  check("平均分正确", sum.avgScore === 80, `avg=${sum.avgScore}`);
  check("最近分数正确", sum.lastScore === 90);
  check("最近 3 次 vs 更早 3 次的走向可计算", sum.trend === null || typeof sum.trend === "number");
}

console.log("— 训练档案：条数上限 —");
{
  const s = memStorage();
  for (let i = 0; i < MAX_RECORDS + 20; i++) {
    addRecord(s, makeRecord({ report: fakeReport(), ts: 1700000000000 + i * 1000 }));
  }
  check(`最多保留 ${MAX_RECORDS} 条`, listRecords(s).length === MAX_RECORDS, `n=${listRecords(s).length}`);
}

console.log("— SVG 图表 —");
{
  const svg = lineChart({
    series: [{ label: "肘角", color: "#38bdf8", points: [{ x: 0, y: 90 }, { x: 1, y: 120 }, { x: 2, y: 170 }] }],
    bands: [{ from: 150, to: 185 }],
    events: [{ x: 2, label: "出手" }],
    yUnit: "°",
  });
  check("折线图输出 SVG", svg.startsWith("<svg") && svg.endsWith("</svg>"));
  check("折线图含路径", svg.includes("<path"));
  check("折线图含参考带", svg.includes("<rect"));
  check("折线图含事件标注", svg.includes("出手"));
  check("折线图含 Y 轴刻度", svg.includes("<text"));

  check("没有数据时返回空串", lineChart({ series: [] }) === "");
  check("单点也能画（画成圆点）", lineChart({ series: [{ label: "x", color: "#fff", points: [{ x: 0, y: 1 }] }] }).includes("<circle"));
  check("非法数值被跳过而不是崩溃", lineChart({
    series: [{ label: "x", color: "#fff", points: [{ x: 0, y: null }, { x: 1, y: 5 }] }],
  }).includes("<svg"));

  const sp = sparkline([1, 2, 3, 2]);
  check("迷你趋势线输出 SVG", sp.startsWith("<svg"));
  check("迷你趋势线少于两个点时返回空串", sparkline([1]) === "" && sparkline([]) === "");
}

console.log(`\n${fail ? `💥 ${fail} 项失败` : `🎉 全部通过（${pass} 项）`}`);
process.exit(fail ? 1 : 0);
