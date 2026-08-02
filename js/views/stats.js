// 统计视图：累计 / 连续天数 / 趋势柱 / 分类分布
import { db } from "../db.js";
import { h, fmtDate } from "../util.js";
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
  root.appendChild(h("h2", { class: "section", style: "margin-top:16px;" }, "近 14 天专注趋势"));
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
  root.appendChild(h("h2", { class: "section", style: "margin-top:8px;" }, "分类专注分布"));
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
}

function stat(n, label) {
  return h("div", { class: "stat" }, h("b", {}, String(n)), h("span", {}, label));
}
