// 训练档案：把每次分析的指标存到本机，支持「较上次」对比、历史趋势曲线、导出/导入
// 存储层可注入（Node 测试用内存实现），默认用 localStorage；
// 隐私模式/清缓存会丢数据，所以提供 JSON 导出与导入，档案不困死在浏览器里。
//
// 记录结构：
// { id, ts, date, type, view, source, score, grade, cycleCount, metrics: { [指标id]: {num, value, unit, verdict, name} } }

export const HISTORY_KEY = "shot-analyzer-history-v1";
export const MAX_RECORDS = 200; // 只留最近 200 次，localStorage 容量有限

/** 默认存储层：localStorage 不可用时返回 null（调用方静默降级为「无档案」） */
function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** 读取全部记录（按时间倒序）；存储不可用或数据损坏时返回空数组 */
export function listRecords(storage = defaultStorage()) {
  if (!storage) return [];
  try {
    const raw = storage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((r) => r && typeof r.id === "string") : [];
  } catch {
    return [];
  }
}

/** 覆盖写入（内部使用） */
function writeRecords(storage, list) {
  if (!storage) return false;
  try {
    storage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, MAX_RECORDS)));
    return true;
  } catch {
    return false; // 配额满或隐私模式：静默失败，不影响主流程
  }
}

/**
 * 存入一次分析。返回存档后的完整列表（新的在最前）。
 * 同一条视频重复分析会各存一条——趋势要看的是「随时间的表现」，重复分析也是真实数据。
 */
export function addRecord(storage, record) {
  const list = listRecords(storage);
  list.unshift(record);
  writeRecords(storage, list);
  return list;
}

/** 删除一条记录 */
export function removeRecord(storage, id) {
  const list = listRecords(storage).filter((r) => r.id !== id);
  writeRecords(storage, list);
  return list;
}

/** 清空档案 */
export function clearRecords(storage = defaultStorage()) {
  if (!storage) return [];
  try {
    storage.removeItem(HISTORY_KEY);
  } catch {
    /* 忽略 */
  }
  return [];
}

/** 导出为 JSON 文本（可存文件、可发给自己换设备） */
export function exportText(storage = defaultStorage()) {
  return JSON.stringify(
    { app: "shot-analyzer", version: 1, exportedAt: new Date().toISOString(), records: listRecords(storage) },
    null,
    2
  );
}

/**
 * 导入 JSON 文本。按 id 去重后与现有记录合并（同 id 保留新导入的），并按时间倒序。
 * 返回 { ok, count, error }。
 */
export function importText(storage, text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, count: 0, error: "不是合法的 JSON 文件" };
  }
  const incoming = Array.isArray(parsed) ? parsed : parsed?.records;
  if (!Array.isArray(incoming)) {
    return { ok: false, count: 0, error: "文件里没有找到 records 记录列表" };
  }
  const valid = incoming.filter((r) => r && typeof r.id === "string" && isFinite(r.ts));
  const byId = new Map();
  for (const r of listRecords(storage)) byId.set(r.id, r);
  for (const r of valid) byId.set(r.id, r);
  const merged = [...byId.values()].sort((a, b) => b.ts - a.ts);
  writeRecords(storage, merged);
  return { ok: true, count: valid.length, error: null };
}

/**
 * 某项指标的历史序列（按时间正序），供趋势曲线使用。
 * 只含有该指标读数的记录——不同机位能测的指标不同，缺项的记录自然跳过。
 */
export function metricSeries(records, metricId) {
  return records
    .filter((r) => r.metrics && isFinite(r.metrics[metricId]?.num))
    .map((r) => ({ ts: r.ts, num: r.metrics[metricId].num, id: r.id }))
    .sort((a, b) => a.ts - b.ts);
}

/**
 * 与上一次（以及历史最好一次）的对比。
 * lowerIsBetter: 越小越好（如头部晃动）时，delta 的正负含义相反——这里统一返回「变好/变差」方向。
 */
export function compareMetric(records, metricId, num, { lowerIsBetter = false } = {}) {
  const series = metricSeries(records, metricId);
  const prev = series.length ? series[series.length - 1] : null;
  let best = null;
  for (const p of series) {
    if (!best) { best = p; continue; }
    if (lowerIsBetter ? p.num < best.num : p.num > best.num) best = p;
  }
  const delta = prev && isFinite(num) ? num - prev.num : null;
  const better = delta == null ? null : lowerIsBetter ? delta < 0 : delta > 0;
  return {
    count: series.length,
    prev: prev?.num ?? null,
    prevTs: prev?.ts ?? null,
    delta,
    better,
    best: best?.num ?? null,
    bestTs: best?.ts ?? null,
  };
}

/** 档案总览：次数、平均分、最近分数、最近三次相对更早三次的走向 */
export function summarize(records) {
  const scored = records.filter((r) => isFinite(r.score));
  const avg = (arr) => (arr.length ? arr.reduce((s, r) => s + r.score, 0) / arr.length : null);
  const recent3 = scored.slice(0, 3);
  const prev3 = scored.slice(3, 6);
  const a = avg(recent3), b = avg(prev3);
  return {
    count: records.length,
    avgScore: avg(scored),
    lastScore: scored.length ? scored[0].score : null,
    firstScore: scored.length ? scored[scored.length - 1].score : null,
    trend: a != null && b != null ? a - b : null, // 最近三次均分 − 更早三次均分
    dates: records.map((r) => r.date).filter(Boolean),
  };
}

/** 生成一条记录（供 app.js 调用，避免各处手拼字段） */
export function makeRecord({ report, metrics, ts = Date.now(), source = "主视频", view = "unknown" }) {
  const map = {};
  for (const m of metrics ?? report?.metrics ?? []) {
    map[m.id] = { num: m.num, value: m.value, unit: m.unit, verdict: m.verdict, name: m.name };
  }
  const d = new Date(ts);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return {
    id: `${ts}-${Math.abs(hashStr(date + ts))}`,
    ts,
    date,
    type: report?.type ?? "unknown",
    view,
    source,
    score: report?.score ?? null,
    grade: report?.grade ?? null,
    cycleCount: report?.cycleCount ?? 1,
    metrics: map,
  };
}

// 稳定字符串哈希：只用于生成记录 id，不需要密码学强度
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
