// 轻量 SVG 环形图（无第三方依赖，毛玻璃友好）
// donut(segments, opts) -> DOM 节点
//   segments: [{ label, value, color?, display? }]
//   opts: { size, thickness, centerLabel, centerSub, unit, mono, legend }
import { h } from "../util.js";

const NS = "http://www.w3.org/2000/svg";
// 墨水屏下的灰度梯度
const GRAYS = ["#1f1f1f", "#454545", "#6c6c6c", "#939393", "#b9b9b9", "#dcdcdc", "#efefef"];

export function donut(segments, opts = {}) {
  const {
    size = 180,
    thickness = 22,
    centerLabel,
    centerSub,
    unit = "′",
    mono = false,
    legend = true,
  } = opts;

  const total = segments.reduce((a, s) => a + (s.value || 0), 0) || 1;
  const r = (size - thickness) / 2;
  const cx = size / 2;
  const circ = 2 * Math.PI * r;

  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.style.width = "100%";
  svg.style.height = "auto";
  svg.style.display = "block";

  const track = circle(cx, r, {
    fill: "none",
    stroke: "var(--surface-2)",
    "stroke-width": thickness,
  });
  svg.appendChild(track);

  let acc = 0;
  segments.forEach((s, i) => {
    const v = s.value || 0;
    if (v <= 0) return;
    const frac = v / total;
    const color = mono ? GRAYS[i % GRAYS.length] : s.color || "var(--primary)";
    const seg = circle(cx, r, {
      fill: "none",
      stroke: color,
      "stroke-width": thickness,
      "stroke-dasharray": `${(frac * circ).toFixed(2)} ${circ.toFixed(2)}`,
      "stroke-dashoffset": `${(-acc * circ).toFixed(2)}`,
      transform: `rotate(-90 ${cx} ${cx})`,
      "stroke-linecap": "butt",
    });
    seg.style.transition = "stroke-dasharray .45s ease, stroke-dashoffset .45s ease";
    svg.appendChild(seg);
    acc += frac;
  });

  const wrap = h("div", { class: "donut-wrap" },
    h("div", { class: "donut-svg" }, svg,
      h("div", { class: "donut-center" },
        h("b", {}, centerLabel != null ? centerLabel : Math.round(total) + unit),
        centerSub ? h("span", { class: "muted" }, centerSub) : null
      )
    )
  );

  if (legend) {
    const lg = h("div", { class: "donut-legend" });
    segments.forEach((s, i) => {
      if (!s.value) return;
      const color = mono ? GRAYS[i % GRAYS.length] : s.color || "var(--primary)";
      lg.appendChild(
        h("div", { class: "dl-item" },
          h("span", { class: "dl-dot", style: `background:${color}` }),
          h("span", { class: "dl-name" }, s.label),
          h("span", { class: "dl-val muted" }, s.display || (Math.round(s.value) + unit))
        )
      );
    });
    wrap.appendChild(lg);
  }
  return wrap;
}

function circle(cx, r, attrs) {
  const el = document.createElementNS(NS, "circle");
  el.setAttribute("cx", cx);
  el.setAttribute("cy", cx);
  el.setAttribute("r", r);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}
