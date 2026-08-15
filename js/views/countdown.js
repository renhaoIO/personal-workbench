// 倒数日：列表、增删改、首页可引用
import { db, uid } from "../db.js";
import { h, fmtDate, toast, openModal, closeModal, confirmDialog } from "../util.js";

const PRESET_COLORS = ["#3b6ef5", "#22b07d", "#f5a623", "#ef4d56", "#8b5cf6", "#33b1cf", "#ec5a8d", "#6c63ff", "#10b3a3", "#bd7b46"];

function daysUntil(target) {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const t = new Date(target);
  t.setHours(0, 0, 0, 0);
  return Math.round((t - now) / 86400000);
}

export async function renderCountdown(root) {
  root.innerHTML = "";
  let items = await db.getAll("countdowns");
  items.sort((a, b) => new Date(a.targetDate) - new Date(b.targetDate));

  const header = h("div", { class: "row spread", style: "margin-bottom:12px;" },
    h("div", {}, h("b", {}, "倒数日"), h("div", { class: "muted", style: "font-size:.75rem;" }, "重要的日子，提前准备")),
    h("button", { class: "btn", style: "padding:8px 14px; font-size:.8125rem;", onclick: () => editCountdown(null) }, "＋ 添加")
  );
  root.appendChild(header);

  if (!items.length) {
    root.appendChild(h("div", { class: "center-empty" }, "还没有倒数日，点右上角添加"));
    return;
  }

  const grid = h("div", { class: "cd-grid" });
  for (const c of items) {
    const d = daysUntil(c.targetDate);
    const isPast = d < 0;
    grid.appendChild(h("div", {
      class: "cd-card",
      style: `--cd-color:${c.color || PRESET_COLORS[0]};`,
      onclick: () => editCountdown(c),
    },
      h("div", { class: "cd-top" },
        h("span", { class: "cd-name" }, c.title),
        h("span", { class: "cd-date" }, fmtDate(c.targetDate))
      ),
      h("div", { class: "cd-num" + (isPast ? " past" : "") },
        h("b", {}, String(Math.abs(d))),
        h("span", {}, isPast ? "天前" : "天后")
      ),
      c.note ? h("div", { class: "cd-note" }, c.note) : null
    ));
  }
  root.appendChild(grid);
}

function editCountdown(c) {
  const isEdit = !!c;
  const model = c || {
    id: uid(),
    title: "",
    targetDate: fmtDate(Date.now() + 86400000),
    color: PRESET_COLORS[0],
    note: "",
  };

  const titleI = h("input", { class: "input", placeholder: "例如：考研、生日", value: model.title });
  const dateI = h("input", { class: "input", type: "date", value: model.targetDate });
  const noteI = h("textarea", { class: "textarea", placeholder: "备注（可选）", style: "min-height:64px;" }, model.note || "");

  const colorRow = h("div", { class: "sch-color-row" });
  for (const col of PRESET_COLORS) {
    const dot = h("span", {
      class: "sch-color-dot" + (model.color === col ? " on" : ""),
      style: `background:${col};`,
      onclick: () => {
        model.color = col;
        [...colorRow.children].forEach((x) => x.classList.remove("on"));
        dot.classList.add("on");
      },
    });
    colorRow.appendChild(dot);
  }

  const form = h("div", {},
    h("div", { class: "field" }, h("label", {}, "标题"), titleI),
    h("div", { class: "field" }, h("label", {}, "目标日期"), dateI),
    h("div", { class: "field" }, h("label", {}, "颜色"), colorRow),
    h("div", { class: "field" }, h("label", {}, "备注"), noteI),
    h("div", { class: "row", style: "gap:10px; margin-top:8px;" },
      h("button", { class: "btn ghost", style: "flex:1", onclick: () => closeModal() }, "取消"),
      isEdit ? h("button", { class: "btn danger", style: "flex:1", onclick: async () => {
        if (await confirmDialog("确定删除该倒数日？")) { await db.del("countdowns", model.id); closeModal(); window.__rerender(); }
      } }, "删除") : null,
      h("button", { class: "btn", style: "flex:1", onclick: async () => {
        const title = titleI.value.trim();
        if (!title) return toast("请填写标题");
        if (!dateI.value) return toast("请选择日期");
        model.title = title;
        model.targetDate = dateI.value;
        model.note = noteI.value.trim();
        await db.put("countdowns", model);
        closeModal();
        window.__rerender();
      } }, "保存")
    )
  );
  openModal(isEdit ? "编辑倒数日" : "添加倒数日", form);
}

// 供首页引用：取最近 3 个未过期的倒数日
export async function getUpcomingCountdowns(limit = 3) {
  const items = await db.getAll("countdowns");
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return items
    .map((c) => ({ ...c, days: daysUntil(c.targetDate) }))
    .filter((c) => c.days >= 0)
    .sort((a, b) => a.days - b.days)
    .slice(0, limit);
}
