// 统计视图：累计 / 连续天数 / 趋势柱 / 分类分布 / 周活动时间轴 / 月状态
import { db } from "../db.js";
import { h, fmtDate, fmtTime, openModal, closeModal } from "../util.js";
import { donut } from "./charts.js";

function streakOf(byDate) {
  let s = 0;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  while (byDate[fmtDate(d.getTime())] > 0) {
    s++;
    d.setDate(d.getDate() - 1);
  }
  return s;
}

function sameDay(a, b) {
  return fmtDate(a) === fmtDate(b);
}

function startOfWeek(ts, firstDay = 1) {
  // firstDay: 0=周日, 1=周一
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  const diff = (day - firstDay + 7) % 7;
  d.setDate(d.getDate() - diff);
  return d;
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function hm(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h}:${String(m).padStart(2, "0")}`;
}

// 统一活动时间轴数据源：activities + pomodoro + readingLog
async function loadWeekActivities(start, end) {
  const [activities, pomos, reads, books, cats] = await Promise.all([
    db.getAll("activities"),
    db.getAll("pomodoro"),
    db.getAll("readingLog"),
    db.getAll("books"),
    db.getAll("categories"),
  ]);
  const catColor = (id) => (cats.find((c) => c.id === id) || {}).color || "#9aa3b2";
  const catName = (id) => (cats.find((c) => c.id === id) || {}).name || "未分类";
  const bookOf = (id) => books.find((b) => b.id === id) || {};

  const list = [];

  for (const a of activities) {
    if (a.start >= start && a.start <= end) {
      list.push({
        id: a.id,
        title: a.title,
        category: a.category,
        catName: catName(a.category),
        color: a.color || catColor(a.category) || "#9aa3b2",
        start: a.start,
        end: a.end,
        source: a.source || "manual",
      });
    }
  }

  for (const p of pomos) {
    if (p.type !== "work" || p.startedAt < start || p.startedAt > end) continue;
    const s = p.startedAt;
    const e = s + (p.durationSec || 0) * 1000;
    list.push({
      id: "pomo-" + p.id,
      title: "🍅 专注",
      category: p.category || "",
      catName: catName(p.category),
      color: catColor(p.category),
      start: s,
      end: e,
      source: "pomodoro",
    });
  }

  for (const r of reads) {
    const e = r.ts;
    const s = e - (r.durationSec || 0) * 1000;
    if (s < start || e > end) continue;
    const b = bookOf(r.bookId);
    list.push({
      id: "read-" + r.id,
      title: "📖 " + (b.title || "阅读"),
      category: b.category || "",
      catName: catName(b.category),
      color: catColor(b.category),
      start: s,
      end: e,
      source: "reading",
    });
  }

  return list.sort((a, b) => a.start - b.start);
}

export async function renderStats(root) {
  root.innerHTML = "";

  const sessions = (await db.getAll("pomodoro")).filter((s) => s.type === "work");
  const byDate = {};
  const catMap = {};
  const tasksAll = await db.getAll("tasks");
  tasksAll.forEach((t) => (catMap[t.id] = t.category));
  const cats = await db.getAll("categories");
  const catName = (id) => (cats.find((c) => c.id === id) || {}).name || "未分类";
  const catColor = (id) => (cats.find((c) => c.id === id) || {}).color || "#9aa3b2";

  for (const s of sessions) {
    const d = fmtDate(s.startedAt);
    byDate[d] = (byDate[d] || 0) + (s.durationSec || 0);
  }
  const totalSec = sessions.reduce((a, s) => a + (s.durationSec || 0), 0);
  const totalMin = Math.round(totalSec / 60);
  const streak = streakOf(byDate);
  const bestDay = Math.max(0, ...Object.values(byDate).map((s) => Math.round(s / 60)));

  // 卡片统计
  root.appendChild(h("div", { class: "stat-grid" },
    stat(totalMin, "累计专注(分)"),
    stat(sessions.length, "完成番茄"),
    stat(streak, "连续天数"),
    stat(bestDay, "最佳单日(分)")
  ));

  // 近 14 天趋势
  root.appendChild(h("h2", { class: "section", style: "margin-top:20px;" }, "近 14 天专注趋势"));
  const days = 14;
  const arr = [];
  const today = new Date(); today.setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    const min = Math.round((byDate[fmtDate(d.getTime())] || 0) / 60);
    arr.push({ min, label: (d.getMonth() + 1) + "/" + d.getDate() });
  }
  const max = Math.max(1, ...arr.map((a) => a.min));
  const bars = h("div", { class: "bars" });
  const xs = h("div", { class: "bar-x" });
  for (const a of arr) {
    bars.appendChild(h("div", { class: "bar", style: `height:${(a.min / max) * 100}%;`, title: a.min + " 分钟" },
      a.min ? h("span", {}, String(a.min)) : null));
    xs.appendChild(h("div", {}, a.label.slice(-3)));
  }
  root.appendChild(h("div", { class: "card" }, bars, xs));

  // 按分类的专注分布（环形图）
  root.appendChild(h("h2", { class: "section", style: "margin-top:12px;" }, "分类专注分布"));
  const byCat = {};
  for (const s of sessions) {
    const cid = s.category || catMap[s.taskId] || "none";
    byCat[cid] = (byCat[cid] || 0) + Math.round((s.durationSec || 0) / 60);
  }
  const segList = Object.entries(byCat)
    .map(([cid, min]) => ({ label: catName(cid), value: min, color: catColor(cid) }))
    .sort((a, b) => b.value - a.value);
  const mono = document.documentElement.getAttribute("data-theme") === "eink";
  if (!segList.length || totalMin === 0) {
    root.appendChild(h("div", { class: "center-empty" }, "还没有专注记录"));
  } else {
    root.appendChild(h("div", { class: "card" },
      donut(segList, { centerLabel: totalMin + "′", centerSub: "总专注", mono })
    ));
  }

  // 周活动时间轴
  root.appendChild(h("h2", { class: "section", style: "margin-top:20px;" }, "周活动时间轴"));
  await renderWeekTimeline(root);

  // 月状态
  root.appendChild(h("h2", { class: "section", style: "margin-top:20px;" }, "月状态"));
  await renderMonthStatus(root);
}

async function renderWeekTimeline(root) {
  const now = new Date();
  const start = startOfWeek(now, 1).getTime();
  const end = addDays(startOfWeek(now, 1), 6).setHours(23, 59, 59, 999);
  const acts = await loadWeekActivities(start, end);

  const wrap = h("div", { class: "card timeline-card" });
  const header = h("div", { class: "timeline-header" },
    h("span", { class: "muted" }, `${fmtDate(start)} 至 ${fmtDate(end)}`),
    h("button", { class: "btn ghost", style: "padding:8px 12px; font-size:.8125rem;", onclick: () => addActivity() }, "＋ 手动记录")
  );
  wrap.appendChild(header);

  if (!acts.length) {
    wrap.appendChild(h("div", { class: "center-empty", style: "padding:28px 0;" }, "本周还没有活动记录，开始一次专注或阅读吧"));
    root.appendChild(wrap);
    return;
  }

  // 图例：按分类聚合
  const legendMap = new Map();
  for (const a of acts) {
    const key = a.category || a.source;
    if (!legendMap.has(key)) legendMap.set(key, { name: a.catName || sourceLabel(a.source), color: a.color });
  }
  const legend = h("div", { class: "timeline-legend" });
  for (const [, v] of legendMap) {
    legend.appendChild(h("div", { class: "tl-legend-item" },
      h("span", { class: "tl-dot", style: `background:${v.color};` }),
      h("span", {}, v.name)
    ));
  }
  wrap.appendChild(legend);

  // 7 列容器
  const grid = h("div", { class: "timeline-grid" });
  const weekDays = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  const dayStart = new Date(start); dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart); dayEnd.setHours(23, 59, 59, 999);

  // 时间刻度（左侧）
  const scale = h("div", { class: "timeline-scale" });
  for (let h_ = 6; h_ <= 24; h_ += 3) {
    scale.appendChild(h("div", { class: "tl-scale-label" }, `${String(h_).padStart(2, "0")}:00`));
  }

  const columns = h("div", { class: "timeline-columns" });
  for (let i = 0; i < 7; i++) {
    const colStart = addDays(dayStart, i).getTime();
    const colEnd = addDays(dayEnd, i).getTime();
    const colActs = acts.filter((a) => a.start >= colStart && a.start <= colEnd);
    const col = h("div", { class: "timeline-col" });
    const d = addDays(dayStart, i);
    col.appendChild(h("div", { class: "tl-col-head" },
      h("span", { class: "tl-dow" }, weekDays[i]),
      h("span", { class: "tl-date" }, `${d.getMonth() + 1}/${d.getDate()}`)
    ));

    const track = h("div", { class: "tl-track" });
    for (const a of colActs) {
      const topPct = timeToPct(a.start, colStart);
      const heightPct = Math.max(2, durationPct(a.end - a.start));
      const block = h("div", {
        class: "tl-block",
        style: `top:${topPct}%;height:${heightPct}%;background:${a.color};`,
        title: `${fmtTime(a.start)}-${fmtTime(a.end)} ${a.title}`,
        onclick: () => showActivityDetail(a),
      },
        h("div", { class: "tl-time" }, `${fmtTime(a.start)}-${fmtTime(a.end)}`),
        h("div", { class: "tl-title" }, a.title)
      );
      track.appendChild(block);
    }
    col.appendChild(track);
    columns.appendChild(col);
  }

  grid.appendChild(scale);
  grid.appendChild(columns);
  wrap.appendChild(grid);
  root.appendChild(wrap);
}

function timeToPct(ts, dayStartTs) {
  const min = (ts - dayStartTs) / 60000;
  // 6:00 -> 0%, 24:00 -> 100%
  const visibleMin = Math.max(0, min - 6 * 60);
  const totalVisible = 18 * 60;
  return Math.min(100, (visibleMin / totalVisible) * 100);
}

function durationPct(ms) {
  const min = ms / 60000;
  const totalVisible = 18 * 60;
  return Math.min(100, (min / totalVisible) * 100);
}

function sourceLabel(s) {
  return s === "pomodoro" ? "专注" : s === "reading" ? "阅读" : "手动";
}

function showActivityDetail(a) {
  const content = h("div", {},
    h("div", { class: "detail-row" },
      h("div", { class: "detail-ico" }, a.source === "pomodoro" ? "🍅" : a.source === "reading" ? "📖" : "📝"),
      h("div", { class: "detail-main" },
        h("div", { class: "dt" }, a.title),
        h("div", { class: "ds" }, `${fmtDate(a.start)} ${fmtTime(a.start)} - ${fmtTime(a.end)} · ${Math.round((a.end - a.start) / 60000)} 分钟`)
      )
    ),
    h("div", { class: "row", style: "margin-top:16px; gap:10px;" },
      h("button", { class: "btn ghost", style: "flex:1", onclick: () => closeModal() }, "关闭")
    )
  );
  openModal("活动详情", content);
}

function addActivity() {
  const titleI = h("input", { class: "input", placeholder: "活动名称", value: "" });
  const startI = h("input", { class: "input", type: "datetime-local", value: "" });
  const endI = h("input", { class: "input", type: "datetime-local", value: "" });
  const form = h("div", {},
    h("div", { class: "field" }, h("label", {}, "活动名称"), titleI),
    h("div", { class: "field" }, h("label", {}, "开始时间"), startI),
    h("div", { class: "field" }, h("label", {}, "结束时间"), endI),
    h("div", { class: "row", style: "gap:10px; margin-top:8px;" },
      h("button", { class: "btn ghost", style: "flex:1", onclick: () => closeModal() }, "取消"),
      h("button", { class: "btn", style: "flex:1", onclick: async () => {
        const title = titleI.value.trim();
        if (!title) return;
        const s = startI.value ? new Date(startI.value).getTime() : Date.now();
        const e = endI.value ? new Date(endI.value).getTime() : s + 3600000;
        if (e <= s) return;
        const { logActivity } = await import("../db.js");
        await logActivity({ title, start: s, end: e, source: "manual" });
        closeModal();
        window.__rerender();
      } }, "保存")
    )
  );
  openModal("手动记录活动", form);
}

async function renderMonthStatus(root) {
  const statuses = await db.getAll("dailyStatus");
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const year = today.getFullYear();
  const month = today.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const map = new Map(statuses.map((s) => [s.date, s]));

  const wrap = h("div", { class: "card month-status-card" });
  const header = h("div", { class: "row spread", style: "margin-bottom:12px;" },
    h("b", {}, `${month + 1} 月每日状态`),
    h("button", { class: "btn ghost", style: "padding:8px 12px; font-size:.8125rem;", onclick: () => recordStatus() }, "📝 记录今日")
  );
  wrap.appendChild(header);

  const grid = h("div", { class: "month-grid" });
  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const s = map.get(date);
    const cell = h("div", {
      class: "month-cell" + (s ? " has" : ""),
      title: s ? `${date} 学习${s.study || "—"} · 身体${s.body || "—"}` : date,
      onclick: () => s ? showStatusDetail(s) : recordStatus(date),
    },
      h("span", { class: "mc-day" }, d),
      s ? h("div", { class: "mc-dots" },
        h("span", { class: "mc-dot", style: `background:${levelColor(s.study)};` }),
        h("span", { class: "mc-dot", style: `background:${levelColor(s.body)};` })
      ) : null
    );
    grid.appendChild(cell);
  }
  wrap.appendChild(grid);

  // 趋势图：学习/身体 7 级折线
  const trend = h("div", { class: "status-trend" });
  const labels = ["学习", "身体"];
  const colors = ["#3b6ef5", "#22b07d"];
  for (let i = 0; i < 2; i++) {
    const key = i === 0 ? "study" : "body";
    const data = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const date = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      data.push(map.get(date)?.[key] || 0);
    }
    trend.appendChild(buildMiniLine(data, labels[i], colors[i]));
  }
  wrap.appendChild(trend);

  root.appendChild(wrap);
}

function levelColor(n) {
  const c = ["#e5e7eb", "#ff6b6b", "#ffa94d", "#ffd43b", "#69db7c", "#4dabf7", "#9775fa"];
  return c[n] || "#e5e7eb";
}

function buildMiniLine(data, label, color) {
  const max = 5;
  const w = 280;
  const h_ = 80;
  const pad = 10;
  const step = data.length > 1 ? (w - pad * 2) / (data.length - 1) : 0;
  const points = data.map((v, i) => {
    const x = pad + (data.length === 1 ? w / 2 : i * step);
    const y = h_ - pad - (v / max) * (h_ - pad * 2);
    return `${x},${y}`;
  }).join(" ");
  const polyline = h("polyline", {
    fill: "none", stroke: color, "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round",
    points,
  });
  const svg = h("svg", { width: "100%", viewBox: `0 0 ${w} ${h_}`, preserveAspectRatio: "none", style: "overflow:visible;" }, polyline);
  // 数据点
  for (let i = 0; i < data.length; i++) {
    if (!data[i]) continue;
    const x = pad + (data.length === 1 ? w / 2 : i * step);
    const y = h_ - pad - (data[i] / max) * (h_ - pad * 2);
    svg.appendChild(h("circle", { cx: x, cy: y, r: 2.5, fill: color }));
  }
  return h("div", { class: "status-trend-item" },
    h("div", { class: "st-label" },
      h("span", { class: "st-dot", style: `background:${color};` }),
      label
    ),
    svg
  );
}

function showStatusDetail(s) {
  const moods = ["—", "😞", "😕", "😐", "🙂", "😄"];
  const content = h("div", {},
    h("div", { class: "detail-row" },
      h("div", { class: "detail-main" },
        h("div", { class: "dt" }, s.date),
        h("div", { class: "ds" }, `学习状态：${moods[s.study || 0] || "—"} · 身体状态：${moods[s.body || 0] || "—"}`)
      )
    ),
    s.goal ? h("div", { class: "field", style: "margin-top:8px;" }, h("label", {}, "今日目标"), h("div", { class: "muted" }, s.goal)) : null,
    h("div", { class: "row", style: "margin-top:16px; gap:10px;" },
      h("button", { class: "btn ghost", style: "flex:1", onclick: () => closeModal() }, "关闭"),
      h("button", { class: "btn danger", style: "flex:1", onclick: async () => {
        await db.del("dailyStatus", s.id);
        closeModal();
        window.__rerender();
      } }, "删除")
    )
  );
  openModal("状态详情", content);
}

function recordStatus(date) {
  const targetDate = date || fmtDate(Date.now());
  const studyI = h("input", { class: "input", type: "range", min: "1", max: "5", step: "1", value: "3" });
  const bodyI = h("input", { class: "input", type: "range", min: "1", max: "5", step: "1", value: "3" });
  const goalI = h("textarea", { class: "textarea", placeholder: "今日目标/备注（可选）", style: "min-height:64px;" });
  const studyVal = h("span", { class: "muted" }, "3");
  const bodyVal = h("span", { class: "muted" }, "3");
  studyI.addEventListener("input", () => studyVal.textContent = studyI.value);
  bodyI.addEventListener("input", () => bodyVal.textContent = bodyI.value);

  const form = h("div", {},
    h("div", { class: "field" }, h("label", {}, `日期 · ${targetDate}`)),
    h("div", { class: "field" },
      h("label", {}, "学习状态"),
      h("div", { class: "row", style: "gap:10px;" }, studyI, studyVal)
    ),
    h("div", { class: "field" },
      h("label", {}, "身体状态"),
      h("div", { class: "row", style: "gap:10px;" }, bodyI, bodyVal)
    ),
    h("div", { class: "field" }, h("label", {}, "今日目标"), goalI),
    h("div", { class: "row", style: "gap:10px; margin-top:8px;" },
      h("button", { class: "btn ghost", style: "flex:1", onclick: () => closeModal() }, "取消"),
      h("button", { class: "btn", style: "flex:1", onclick: async () => {
        const id = targetDate;
        await db.put("dailyStatus", {
          id,
          date: targetDate,
          study: +studyI.value,
          body: +bodyI.value,
          goal: goalI.value.trim(),
          updatedAt: Date.now(),
        });
        closeModal();
        window.__rerender();
      } }, "保存")
    )
  );
  openModal("记录状态", form);
}

function stat(n, label) {
  return h("div", { class: "stat" }, h("b", {}, String(n)), h("span", {}, label));
}
