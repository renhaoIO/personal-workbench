// 主页：实时时钟 + 专注热力图 + 今日概览 + 今日待办
import { db } from "../db.js";
import { h, fmtDate, fmtTime, toast, openModal, closeModal, confirmDialog } from "../util.js";

let clockTimer = null;

function aggSessions() {
  return Promise.all([db.getAll("pomodoro"), db.getAll("readingLog")]).then(([all, logs]) => {
    const byDate = {};
    // 专注时长
    for (const s of all) {
      if (s.type !== "work") continue;
      const d = fmtDate(s.startedAt);
      byDate[d] = (byDate[d] || 0) + (s.durationSec || 0);
    }
    // 阅读时长（计入热力图）
    for (const l of logs) {
      const d = fmtDate(l.ts);
      byDate[d] = (byDate[d] || 0) + (l.durationSec || 0);
    }
    return byDate;
  });
}

function weekdayCN(d) {
  return "星期" + "日一二三四五六"[d.getDay()];
}

export async function renderHome(root) {
  root.innerHTML = "";
  if (clockTimer) clearInterval(clockTimer);

  const byDate = await aggSessions();

  // ---- 今日聚焦 ----
  const todayKey = fmtDate(Date.now());
  const todaySec = byDate[todayKey] || 0;
  const todayPomo = (await db.getAll("pomodoro")).filter(
    (s) => s.type === "work" && fmtDate(s.startedAt) === todayKey
  ).length;
  const todayRead = (await db.getAll("readingLog")).filter(
    (l) => fmtDate(l.ts) === todayKey
  ).reduce((a, l) => a + (l.durationSec || 0), 0);

  // 连续天数
  let streak = 0;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  while (byDate[fmtDate(d.getTime())] > 0) {
    streak++;
    d.setDate(d.getDate() - 1);
  }

  // ---- 时钟 ----
  const timeEl = h("div", { class: "clock-time" }, "--:--:--");
  const dateEl = h("div", { class: "clock-date" });
  const statusEl = h("div", { class: "clock-status muted" },
    `今日累计 ${Math.round(todaySec / 60)} 分钟（专注 ${Math.round((todaySec - todayRead) / 60)}′ · 阅读 ${Math.round(todayRead / 60)}′）· ${todayPomo} 个番茄 · 连续 ${streak} 天`);
  function tick() {
    const n = new Date();
    const p = (x) => String(x).padStart(2, "0");
    timeEl.textContent = `${p(n.getHours())}:${p(n.getMinutes())}:${p(n.getSeconds())}`;
    dateEl.textContent = `${n.getFullYear()}年${p(n.getMonth() + 1)}月${p(n.getDate())}日 ${weekdayCN(n)}`;
  }
  tick();
  clockTimer = setInterval(tick, 1000);

  const clockCard = h("div", { class: "card clock" }, timeEl, dateEl, statusEl,
    h("button", { class: "btn block", style: "margin-top:12px;", onclick: () => window.__route("pomodoro") }, "🍅 开始专注")
  );
  root.appendChild(clockCard);

  // ---- 热力图 ----
  const heatWrap = h("div", { class: "heatmap" });
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - 181); // 约 26 周
  start.setDate(start.getDate() - start.getDay()); // 对齐到周日

  const values = Object.values(byDate);
  const maxMin = Math.max(1, ...values.map((s) => s / 60));
  const cursor = new Date(start);
  let cells = [];
  while (cursor <= today) {
    const key = fmtDate(cursor.getTime());
    const min = Math.round((byDate[key] || 0) / 60);
    let lvl = 0;
    if (min > 0) lvl = min < maxMin / 4 ? 1 : min < maxMin / 2 ? 2 : min < (maxMin * 3) / 4 ? 3 : 4;
    const cell = h("div", {
      class: "heat-cell", "data-l": String(lvl),
      title: `${key} · ${min} 分钟`,
      onclick: () => dayDetail(key),
    });
    cells.push(cell);
    cursor.setDate(cursor.getDate() + 1);
  }
  cells.forEach((c) => heatWrap.appendChild(c));

  const legend = h("div", { class: "heat-legend" },
    h("span", {}, "少"),
    h("div", { class: "heat-cell", "data-l": "0" }),
    h("div", { class: "heat-cell", "data-l": "1" }),
    h("div", { class: "heat-cell", "data-l": "2" }),
    h("div", { class: "heat-cell", "data-l": "3" }),
    h("div", { class: "heat-cell", "data-l": "4" }),
    h("span", {}, "多")
  );

  root.appendChild(h("h2", { class: "section" }, "专注 · 阅读热力图（近半年）"));
  root.appendChild(h("div", { class: "card" }, heatWrap, legend));

  // ---- 今日待办 ----
  root.appendChild(h("h2", { class: "section", style: "margin-top:8px;" }, "今日待办"));
  const tasks = (await db.getAll("tasks")).filter((t) => !t.done);
  const endToday = new Date(); endToday.setHours(23, 59, 59, 999);
  const due = tasks.filter((t) => t.due && t.due <= endToday.getTime());
  const list = h("div", {});
  if (!due.length) {
    list.appendChild(h("div", { class: "center-empty", style: "padding:24px;" }, "今天没有临近截止的任务 🎉"));
  }
  for (const t of due) {
    list.appendChild(h("div", { class: "card row", style: "align-items:flex-start; gap:12px;" },
      h("div", { class: "check", onclick: async () => { t.done = true; await db.put("tasks", t); window.__rerender(); } }, ""),
      h("div", { style: "flex:1; min-width:0;", onclick: () => window.__rerender() },
        h("div", { class: "item-title" }, t.title),
        h("div", { class: "item-sub" }, t.due ? "截止 " + fmtDate(t.due) : "")
      )
    ));
  }
  root.appendChild(list);

  // ---- 本地提醒（仅本机，需通知权限）----
  const reminderOn = await db.getSetting("reminderOn", false);
  if (reminderOn && "Notification" in window && Notification.permission === "granted") {
    const overdue = tasks.filter((t) => t.due && t.due < Date.now());
    if (overdue.length) {
      try { new Notification("个人工作台", { body: `有 ${overdue.length} 个任务已逾期，去完成吧！` }); } catch (e) {}
    }
  }
}

// 热力图单元格点击：弹出当天明细
async function dayDetail(key) {
  const start = new Date(key + "T00:00:00").getTime();
  const end = new Date(key + "T23:59:59").getTime();

  const pomo = (await db.getAll("pomodoro")).filter((s) => s.type === "work" && fmtDate(s.startedAt) === key);
  const min = Math.round(pomo.reduce((a, s) => a + (s.durationSec || 0), 0) / 60);
  const reads = (await db.getAll("readingLog")).filter((l) => l.ts >= start && l.ts <= end);
  const readMin = Math.round(reads.reduce((a, l) => a + (l.durationSec || 0), 0) / 60);

  const tasksAll = await db.getAll("tasks");
  const done = tasksAll.filter((t) => t.completedAt && t.completedAt >= start && t.completedAt <= end);
  const created = tasksAll.filter((t) => t.createdAt && t.createdAt >= start && t.createdAt <= end);
  const caps = (await db.getAll("captures")).filter((c) => c.createdAt >= start && c.createdAt <= end);
  const notes = (await db.getAll("notes")).filter((n) => (n.createdAt >= start && n.createdAt <= end) || (n.updatedAt >= start && n.updatedAt <= end));
  const diaryEntry = (await db.getAll("diary")).find((d) => d.date === key);

  const MOODS = ["😞", "😕", "😐", "🙂", "😄"];
  const titleOf = (arr) => arr.slice(0, 2).map((t) => t.title || "（无标题）").join("、") + (arr.length > 2 ? "…" : "");

  const rows = [];
  rows.push(detailRow("🍅", "专注时长", `${pomo.length} 个番茄`, `${min}′`));
  rows.push(detailRow("📖", "阅读时长", readMin ? `${readMin} 分钟` : "无", readMin ? `${readMin}′` : "—"));
  rows.push(detailRow("✅", "完成任务", done.length ? titleOf(done) : "无", String(done.length)));
  rows.push(detailRow("📋", "新增任务", created.length ? titleOf(created) : "无", String(created.length)));
  rows.push(detailRow("⚡", "速记", caps.length ? `${caps.length} 条灵感` : "无", String(caps.length)));
  rows.push(detailRow("📝", "笔记", notes.length ? `${notes.length} 篇` : "无", String(notes.length)));
  if (diaryEntry) {
    const preview = (diaryEntry.content || "").replace(/\n/g, " ").slice(0, 24);
    rows.push(detailRow("📔", "日记", MOODS[(diaryEntry.mood || 3) - 1] + " " + (preview || "（已写）"), "✓"));
  } else {
    rows.push(detailRow("📔", "日记", "今天还没写", "—"));
  }

  const content = h("div", {},
    ...rows,
    h("div", { class: "row", style: "margin-top:16px; gap:10px;" },
      h("button", { class: "btn ghost", style: "flex:1", onclick: () => closeModal() }, "关闭")
    )
  );
  openModal(key + " 的明细", content);
}

function detailRow(ico, title, sub, val) {
  return h("div", { class: "detail-row" },
    h("div", { class: "detail-ico" }, ico),
    h("div", { class: "detail-main" },
      h("div", { class: "dt" }, title),
      h("div", { class: "ds" }, sub)
    ),
    h("div", { class: "detail-val" }, val)
  );
}
