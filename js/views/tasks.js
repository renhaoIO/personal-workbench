// 任务待办模块（含分类 + 长期打卡）
import { db, uid } from "../db.js";
import { h, escapeHtml, fmtDate, fromNow, toast, openModal, closeModal, confirmDialog } from "../util.js";

let filter = "active"; // all | active | done | daily
let catFilter = "all"; // all | <categoryId>
let taskCats = [];

function dueText(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((d - today) / 86400000);
  if (days < 0) return `逾期 ${-days} 天`;
  if (days === 0) return "今天";
  if (days === 1) return "明天";
  return fmtDate(ts);
}
function priorityLabel(p) {
  return p === "hi" ? "高" : p === "mid" ? "中" : "低";
}
function catOf(id) {
  return taskCats.find((c) => c.id === id) || null;
}
function todayKey() {
  return fmtDate(Date.now());
}

// 计算连续打卡天数与总次数
function dailyStats(checks) {
  const arr = Array.from(new Set(checks || [])).sort();
  const total = arr.length;
  if (!total) return { streak: 0, total: 0, today: false };
  const today = todayKey();
  if (arr[arr.length - 1] !== today) return { streak: 0, total, today: false };
  let streak = 1;
  for (let i = arr.length - 2; i >= 0; i--) {
    const cur = new Date(arr[i + 1]); cur.setHours(0, 0, 0, 0);
    const prev = new Date(arr[i]); prev.setHours(0, 0, 0, 0);
    if ((cur - prev) / 86400000 === 1) streak++;
    else break;
  }
  return { streak, total, today: true };
}

async function load() {
  let items = await db.getAll("tasks");
  // 兼容旧数据：无 type 视为普通任务
  items.forEach((t) => { if (!t.type) t.type = "task"; });
  // 普通任务排序
  const normal = items.filter((t) => t.type === "task");
  normal.sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    const pw = { hi: 0, mid: 1, lo: 2 };
    if ((pw[a.priority] ?? 2) !== (pw[b.priority] ?? 2)) return (pw[a.priority] ?? 2) - (pw[b.priority] ?? 2);
    return (a.due || 1e15) - (b.due || 1e15);
  });
  // 长期打卡排序：未打卡在前（按创建时间），已打卡在后
  const daily = items.filter((t) => t.type === "daily");
  daily.sort((a, b) => {
    const sa = dailyStats(a.checks).today;
    const sb = dailyStats(b.checks).today;
    if (sa !== sb) return sa ? 1 : -1;
    return (b.createdAt || 0) - (a.createdAt || 0);
  });

  if (filter === "daily") return daily;
  if (filter === "done") return normal.filter((t) => t.done);
  if (filter === "active") return normal.filter((t) => !t.done);
  if (filter === "all") return [...normal, ...daily];
  return normal;
}

export async function renderTasks(root) {
  root.innerHTML = "";
  taskCats = (await db.getAll("categories")).filter((c) => c.kind === "task");

  const statusRow = h("div", { class: "row", style: "gap:8px; margin-bottom:10px; flex-wrap:wrap;" },
    ...["active", "all", "done", "daily"].map((f) =>
      h("button", {
        class: "chip",
        style: filter === f ? "background:var(--primary);color:#fff;" : "cursor:pointer;",
        onclick: () => { filter = f; refresh(); },
      }, f === "active" ? "进行中" : f === "all" ? "全部" : f === "done" ? "已完成" : "长期打卡")
    )
  );

  const catRow = h("div", { class: "row", style: "gap:8px; margin-bottom:12px; overflow-x:auto; flex-wrap:nowrap;" },
    h("button", {
      class: "chip",
      style: catFilter === "all" ? "background:var(--primary);color:#fff; flex:0 0 auto;" : "cursor:pointer; flex:0 0 auto;",
      onclick: () => { catFilter = "all"; refresh(); },
    }, "全部分类"),
    ...taskCats.map((c) =>
      h("button", {
        class: "chip",
        style: catFilter === c.id ? "background:" + c.color + ";color:#fff; flex:0 0 auto;" : "cursor:pointer; flex:0 0 auto;",
        onclick: () => { catFilter = c.id; refresh(); },
      }, (c.icon || "") + " " + c.name)
    )
  );

  const list = h("div", { id: "taskList" });
  root.appendChild(statusRow);
  root.appendChild(catRow);
  root.appendChild(list);

  root.appendChild(h("button", { class: "fab", title: "新增任务", onclick: () => editTask(null) }, "＋"));

  await refresh();

  async function refresh() {
    const items = await load();
    list.innerHTML = "";
    if (!items.length) {
      const emptyMap = { active: "还没有进行中的任务", all: "暂无任务", done: "还没有完成的任务", daily: "还没有长期打卡，点右下角 ＋ 添加" };
      list.appendChild(h("div", { class: "center-empty" }, emptyMap[filter] || "暂无任务"));
      return;
    }
    if (filter === "daily") {
      // 长期打卡区块
      const today = todayKey();
      const doneToday = items.filter((t) => dailyStats(t.checks).today);
      const pendingToday = items.filter((t) => !dailyStats(t.checks).today);
      if (pendingToday.length) {
        list.appendChild(h("div", { class: "task-section-label" }, "今日待打卡"));
        for (const t of pendingToday) list.appendChild(dailyCard(t));
      }
      if (doneToday.length) {
        list.appendChild(h("div", { class: "task-section-label" }, "今日已打卡"));
        for (const t of doneToday) list.appendChild(dailyCard(t));
      }
    } else {
      for (const t of items) list.appendChild(taskCard(t));
    }
  }

  function taskCard(t) {
    const cat = catOf(t.category);
    const check = h("div", {
      class: "check" + (t.done ? " done" : ""),
      onclick: async () => {
        t.done = !t.done;
        t.completedAt = t.done ? Date.now() : null;
        await db.put("tasks", t);
        refresh();
      },
    }, t.done ? "✓" : "");
    const title = h("div", { class: "item-title" + (t.done ? " done" : "") }, t.title);
    const sub = h("div", { class: "item-sub" });
    if (t.due) sub.appendChild(h("span", {}, "📅 " + dueText(t.due) + "  "));
    sub.appendChild(h("span", { class: "pdot p-" + (t.priority || "lo") }));
    sub.appendChild(document.createTextNode(" " + priorityLabel(t.priority || "lo") + "  "));
    if (cat) sub.appendChild(h("span", { class: "tag", style: `background:${cat.color}22; color:${cat.color};` }, (cat.icon || "") + cat.name));
    sub.appendChild(document.createTextNode("  " + fromNow(t.createdAt)));

    const body = h("div", { style: "flex:1; min-width:0; cursor:pointer;", onclick: () => editTask(t) }, title, sub);
    return h("div", { class: "card row", style: "align-items:flex-start; gap:12px;" }, check, body);
  }

  function dailyCard(t) {
    const s = dailyStats(t.checks);
    const check = h("div", {
      class: "check" + (s.today ? " done" : ""),
      onclick: async () => {
        const checks = Array.from(new Set(t.checks || []));
        const today = todayKey();
        const idx = checks.indexOf(today);
        if (idx >= 0) checks.splice(idx, 1);
        else checks.push(today);
        t.checks = checks;
        await db.put("tasks", t);
        refresh();
      },
    }, s.today ? "✓" : "");
    const title = h("div", { class: "item-title" }, t.title);
    const sub = h("div", { class: "item-sub" },
      h("span", { class: "tag", style: "background:var(--primary-soft);color:var(--primary);" }, s.today ? `连续 ${s.streak} 天` : "今日未打卡"),
      document.createTextNode(`  累计 ${s.total} 次 · ${fromNow(t.createdAt)}`)
    );
    const body = h("div", { style: "flex:1; min-width:0; cursor:pointer;", onclick: () => editTask(t) }, title, sub);
    return h("div", { class: "card row", style: "align-items:flex-start; gap:12px;" }, check, body);
  }
}

function editTask(t) {
  const isEdit = !!t;
  const model = t || { id: uid(), title: "", note: "", done: false, priority: "mid", due: null, category: "", createdAt: Date.now(), type: "task", checks: [] };
  if (!model.type) model.type = "task";
  let type = model.type;

  const titleI = h("input", { class: "input", placeholder: "任务标题", value: model.title });
  const noteI = h("textarea", { class: "textarea", placeholder: "备注（可选）" }, model.note || "");
  const dueI = h("input", { class: "input", type: "date", value: model.due ? fmtDate(model.due) : "" });
  const catSel = h("select", { class: "input" },
    h("option", { value: "" }, "未分类"),
    ...taskCats.map((c) => h("option", { value: c.id, selected: c.id === model.category ? "selected" : null }, (c.icon || "") + " " + c.name))
  );

  let pri = model.priority || "mid";
  const seg = h("div", { class: "seg" },
    ...["hi", "mid", "lo"].map((p) =>
      h("button", {
        class: p === pri ? "on" : "",
        onclick: () => { pri = p; [...seg.children].forEach((c, i) => c.classList.toggle("on", ["hi", "mid", "lo"][i] === pri)); },
      }, priorityLabel(p))
    )
  );

  const typeSeg = h("div", { class: "seg" },
    h("button", {
      class: type === "task" ? "on" : "",
      onclick: () => {
        type = "task";
        [...typeSeg.children].forEach((c, i) => c.classList.toggle("on", ["task", "daily"][i] === type));
        if (dueWrap) dueWrap.style.display = type === "task" ? "block" : "none";
      },
    }, "一次性任务"),
    h("button", {
      class: type === "daily" ? "on" : "",
      onclick: () => {
        type = "daily";
        [...typeSeg.children].forEach((c, i) => c.classList.toggle("on", ["task", "daily"][i] === type));
        if (dueWrap) dueWrap.style.display = type === "task" ? "block" : "none";
      },
    }, "每日打卡")
  );

  const dueWrap = h("div", { class: "field" }, h("label", {}, "截止日期"), dueI);

  const form = h("div", {},
    h("div", { class: "field" }, h("label", {}, "标题"), titleI),
    h("div", { class: "field" }, h("label", {}, "类型"), typeSeg),
    h("div", { class: "field" }, h("label", {}, "分类"), catSel),
    h("div", { class: "field" }, h("label", {}, "优先级"), seg),
    dueWrap,
    h("div", { class: "field" }, h("label", {}, "备注"), noteI),
    h("div", { class: "row", style: "gap:10px; margin-top:8px;" },
      h("button", { class: "btn ghost", style: "flex:1", onclick: () => closeModal() }, "取消"),
      isEdit ? h("button", { class: "btn danger", style: "flex:1", onclick: async () => {
        if (await confirmDialog("确定删除该任务？")) { await db.del("tasks", model.id); closeModal(); toast("已删除"); routeRefresh(); }
      } }, "删除") : null,
      h("button", { class: "btn", style: "flex:1", onclick: async () => {
        const title = titleI.value.trim();
        if (!title) return toast("请填写标题");
        model.title = title;
        model.type = type;
        model.note = noteI.value.trim();
        model.category = catSel.value || "";
        model.priority = pri;
        if (type === "task") {
          model.due = dueI.value ? new Date(dueI.value + "T23:59:59").getTime() : null;
        } else {
          model.due = null;
          if (!Array.isArray(model.checks)) model.checks = [];
        }
        if (!isEdit) model.createdAt = Date.now();
        await db.put("tasks", model);
        closeModal(); toast(isEdit ? "已保存" : "已添加"); routeRefresh();
      } }, "保存")
    )
  );
  openModal(isEdit ? (type === "daily" ? "编辑打卡" : "编辑任务") : "新增", form);
}

function routeRefresh() {
  window.__rerender && window.__rerender();
}
