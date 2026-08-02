// 任务待办模块（含分类）
import { db, uid } from "../db.js";
import { h, escapeHtml, fmtDate, fromNow, toast, openModal, closeModal, confirmDialog } from "../util.js";

let filter = "active"; // all | active | done
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

async function load() {
  let items = await db.getAll("tasks");
  items.sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    const pw = { hi: 0, mid: 1, lo: 2 };
    if ((pw[a.priority] ?? 2) !== (pw[b.priority] ?? 2)) return (pw[a.priority] ?? 2) - (pw[b.priority] ?? 2);
    return (a.due || 1e15) - (b.due || 1e15);
  });
  if (filter === "active") items = items.filter((t) => !t.done);
  if (filter === "done") items = items.filter((t) => t.done);
  if (catFilter !== "all") items = items.filter((t) => (t.category || "") === catFilter);
  return items;
}

export async function renderTasks(root) {
  root.innerHTML = "";
  taskCats = (await db.getAll("categories")).filter((c) => c.kind === "task");

  const statusRow = h("div", { class: "row", style: "gap:8px; margin-bottom:10px; flex-wrap:wrap;" },
    ...["active", "all", "done"].map((f) =>
      h("button", {
        class: "chip",
        style: filter === f ? "background:var(--primary);color:#fff;" : "cursor:pointer;",
        onclick: () => { filter = f; refresh(); },
      }, f === "active" ? "进行中" : f === "all" ? "全部" : "已完成")
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
      list.appendChild(h("div", { class: "center-empty" }, filter === "done" ? "还没有完成的任务" : "暂无任务，点右下角 ＋ 添加"));
      return;
    }
    for (const t of items) list.appendChild(taskCard(t));
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
}

function editTask(t) {
  const isEdit = !!t;
  const model = t || { id: uid(), title: "", note: "", done: false, priority: "mid", due: null, category: "", createdAt: Date.now() };

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

  const form = h("div", {},
    h("div", { class: "field" }, h("label", {}, "标题"), titleI),
    h("div", { class: "field" }, h("label", {}, "分类"), catSel),
    h("div", { class: "field" }, h("label", {}, "优先级"), seg),
    h("div", { class: "field" }, h("label", {}, "截止日期"), dueI),
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
        model.note = noteI.value.trim();
        model.category = catSel.value || "";
        model.priority = pri;
        model.due = dueI.value ? new Date(dueI.value + "T23:59:59").getTime() : null;
        if (!isEdit) model.createdAt = Date.now();
        await db.put("tasks", model);
        closeModal(); toast(isEdit ? "已保存" : "已添加"); routeRefresh();
      } }, "保存")
    )
  );
  openModal(isEdit ? "编辑任务" : "新增任务", form);
}

function routeRefresh() {
  window.__rerender && window.__rerender();
}
