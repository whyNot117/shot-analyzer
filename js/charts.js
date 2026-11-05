// 轻量 SVG 图表（零依赖）：报告里的逐帧曲线、训练档案里的历史趋势
// 只返回 SVG 字符串，交给 innerHTML 渲染；坐标写在 viewBox 里，宽度自适应容器。

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ESC[c]);
const fmt = (v) => {
  if (!isFinite(v)) return "—";
  const a = Math.abs(v);
  return a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2);
};

/**
 * 通用折线图。
 * series: [{ label, color, points: [{x, y}], dash?:bool, fill?:bool }]
 *   points 只取有限值参与绘制；单点也能画（画成小圆点）。
 * bands:  [{ from, to, color }]     横向目标带（y 方向），画在数据下方
 * events: [{ x, label, color }]     竖向事件标注（如「下蹲」「出手」）
 * 返回 SVG 字符串；数据不足两个点时返回空串（调用方决定是否给占位文案）。
 */
export function lineChart({
  series = [],
  bands = [],
  events = [],
  width = 320,
  height = 150,
  padL = 34,
  padR = 10,
  padT = 14,
  padB = 22,
  yUnit = "",
  xUnit = "",
  xLabel = "",
  yTicks = 3,
} = {}) {
  const pts = series.flatMap((s) => s.points.filter((p) => isFinite(p.x) && isFinite(p.y)));
  if (!pts.length) return "";

  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  let xMin = Math.min(...xs), xMax = Math.max(...xs);
  let yMin = Math.min(...ys), yMax = Math.max(...ys);
  // 目标带也要纳入 y 轴范围，否则参考区间会被画到框外
  for (const b of bands) {
    if (isFinite(b.from)) yMin = Math.min(yMin, b.from);
    if (isFinite(b.to)) yMax = Math.max(yMax, b.to);
  }
  if (xMax - xMin < 1e-9) { xMin -= 0.5; xMax += 0.5; }
  if (yMax - yMin < 1e-9) { yMin -= 1; yMax += 1; }
  const padY = (yMax - yMin) * 0.08;
  yMin -= padY; yMax += padY;

  const px = (x) => padL + ((x - xMin) / (xMax - xMin)) * (width - padL - padR);
  const py = (y) => height - padB - ((y - yMin) / (yMax - yMin)) * (height - padT - padB);

  const grid = [];
  for (let k = 0; k <= yTicks; k++) {
    const y = yMin + ((yMax - yMin) * k) / yTicks;
    const yy = py(y);
    grid.push(
      `<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${width - padR}" y2="${yy.toFixed(1)}" stroke="#334155" stroke-width="1"/>` +
        `<text x="${padL - 4}" y="${(yy + 3).toFixed(1)}" fill="#94a3b8" font-size="9" text-anchor="end">${fmt(y)}</text>`
    );
  }

  const bandSvg = bands
    .filter((b) => isFinite(b.from) && isFinite(b.to))
    .map(
      (b) =>
        `<rect x="${padL}" y="${py(Math.max(b.from, b.to)).toFixed(1)}" width="${(width - padL - padR).toFixed(1)}" ` +
        `height="${Math.abs(py(b.from) - py(b.to)).toFixed(1)}" fill="${b.color ?? "rgba(56,189,248,0.12)"}"/>`
    )
    .join("");

  const eventSvg = events
    .filter((e) => isFinite(e.x))
    .map((e) => {
      const x = px(e.x);
      return (
        `<line x1="${x.toFixed(1)}" y1="${padT}" x2="${x.toFixed(1)}" y2="${height - padB}" stroke="${e.color ?? "#f97316"}" ` +
        `stroke-width="1" stroke-dasharray="3 3" opacity="0.8"/>` +
        (e.label
          ? `<text x="${(x + 3).toFixed(1)}" y="${padT + 8}" fill="${e.color ?? "#f97316"}" font-size="9">${esc(e.label)}</text>`
          : "")
      );
    })
    .join("");

  const paths = series
    .map((s) => {
      const good = s.points.filter((p) => isFinite(p.x) && isFinite(p.y));
      if (!good.length) return "";
      const d = good.map((p, i) => `${i ? "L" : "M"}${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`).join(" ");
      const area =
        s.fill && good.length > 1
          ? `<path d="${d} L${px(good[good.length - 1].x).toFixed(1)},${py(yMin).toFixed(1)} L${px(good[0].x).toFixed(1)},${py(yMin).toFixed(1)} Z" fill="${s.color}" opacity="0.12"/>`
          : "";
      const dots =
        good.length === 1
          ? `<circle cx="${px(good[0].x).toFixed(1)}" cy="${py(good[0].y).toFixed(1)}" r="3" fill="${s.color}"/>`
          : "";
      return `${area}<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" ${
        s.dash ? 'stroke-dasharray="4 3"' : ""
      } stroke-linejoin="round" stroke-linecap="round"/>${dots}`;
    })
    .join("");

  const legend = series.length > 1
    ? `<g transform="translate(${padL},${height - 4})">${series
        .map(
          (s, i) =>
            `<rect x="${i * 74}" y="-7" width="8" height="8" rx="2" fill="${s.color}"/>` +
            `<text x="${i * 74 + 12}" y="0" fill="#94a3b8" font-size="9">${esc(s.label ?? "")}</text>`
        )
        .join("")}</g>`
    : "";

  const xLabelSvg = xLabel
    ? `<text x="${((padL + width - padR) / 2).toFixed(1)}" y="${height - 4}" fill="#94a3b8" font-size="9" text-anchor="middle">${esc(xLabel)}</text>`
    : "";

  return (
    `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" ` +
    `style="display:block;max-width:100%;background:#0f172a;border-radius:10px">` +
    `<g>${grid.join("")}</g><g>${bandSvg}</g><g>${eventSvg}</g><g>${paths}</g>` +
    `<g>${legend}</g><g>${xLabelSvg}</g>` +
    (yUnit ? `<text x="2" y="10" fill="#94a3b8" font-size="9">${esc(yUnit)}</text>` : "") +
    (xUnit ? `<text x="${width - padR}" y="${height - 4}" fill="#94a3b8" font-size="9" text-anchor="end">${esc(xUnit)}</text>` : "") +
    `</svg>`
  );
}

/**
 * 迷你趋势线（报告里的指标行内嵌用）：一条线 + 首尾点，无坐标轴。
 * values: 数值数组（可含 null/NaN，空洞自动跳过）
 */
export function sparkline(values, { width = 88, height = 22, color = "#38bdf8" } = {}) {
  const good = values.map((v, i) => ({ x: i, y: v })).filter((p) => isFinite(p.y));
  if (good.length < 2) return "";
  const xs = good.map((p) => p.x);
  const ys = good.map((p) => p.y);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  const px = (x) => 2 + ((x - xMin) / (xMax - xMin || 1)) * (width - 4);
  const py = (y) => height - 3 - ((y - yMin) / (yMax - yMin || 1)) * (height - 6);
  const d = good.map((p, i) => `${i ? "L" : "M"}${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`).join(" ");
  const first = good[0], last = good[good.length - 1];
  return (
    `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" aria-hidden="true" ` +
    `style="display:block">` +
    `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<circle cx="${px(first.x).toFixed(1)}" cy="${py(first.y).toFixed(1)}" r="1.8" fill="${color}" opacity="0.6"/>` +
    `<circle cx="${px(last.x).toFixed(1)}" cy="${py(last.y).toFixed(1)}" r="2.4" fill="${color}"/>` +
    `</svg>`
  );
}
