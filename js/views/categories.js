// 分类管理：任务 / 日记 分类的 增 / 删 / 改
// 删除分类时，把使用该分类的任务 / 日记改派到同类剩余分类（无则置空），避免悬空引用。
import { db, uid } from "../db.js";
import { h, toast, openModal, closeModal, confirmDialog } from "../util.js";

const PALETTE = [
  "#3b7df6", "#8b5cf6", "#14b8a6", "#22b07d", "#f0873f", "#ec5a8d", "#ef4d56", "#f5b73f",
  "#64748b", "#0ea5e9", "#a855f7", "#84cc16", "#e11d48", "#0891b2", "#d97706", "#475569",
];
const ICONS = [
  "📦", "💼", "📚", "🌿", "🌞", "💗", "🏠", "🎯",
  "💡", "🔥", "⭐", "📌", "🚀", "🎵", "🏃", "☕",
  "🍎", "💻", "📖", "✍️", "🌟", "🧩", "🏆", "⏰",
];

function rerender() {
  openCategoryManager();
}

export async function openCategoryManager() {
  const cats = await db.getAll("categories");
  const taskCats = cats.filter((c) => c.kind === "task");
  const diaryCats = cats.filter((c) => c.kind === "diary");
  const bookCats = cats.filter((c) => c.kind === "book");

  const content = h("div", {},
    h("div", { class: "cat-group-title" }, "任务分类"),
    catList(taskCats, "task"),
    h("button", { class: "btn ghost block", style: "margin-top:10px;", onclick: () => editCategory(null, "task") }, "＋ 新增任务分类"),

    h("div", { class: "cat-group-title" }, "日记分类"),
    catList(diaryCats, "diary"),
    h("button", { class: "btn ghost block", style: "margin-top:10px;", onclick: () => editCategory(null, "diary") }, "＋ 新增日记分类"),

    h("div", { class: "cat-group-title" }, "图书分类"),
    catList(bookCats, "book"),
    h("button", { class: "btn ghost block", style: "margin-top:10px;", onclick: () => editCategory(null, "book") }, "＋ 新增图书分类"),

    h("div", { class: "muted", style: "margin-top:16px; line-height:1.6;" },
      "删除分类时，相关任务 / 日记 / 图书会自动改派到同类其他分类（若无可改派则变为「未分类」）。"
    ),
    h("div", { class: "row", style: "margin-top:14px; gap:10px;" },
      h("button", { class: "btn block", onclick: () => closeModal() }, "完成")
    )
  );

  openModal("分类管理", content);
}

function catList(list, kind) {
  const wrap = h("div", { class: "cat-list" });
  if (!list.length) {
    wrap.appendChild(h("div", { class: "muted", style: "padding:4px 2px;" }, "暂无，点下方新增"));
  }
  for (const c of list) {
    wrap.appendChild(
      h("div", { class: "cat-row" },
        h("div", { class: "cat-dot", style: `background:${c.color}` }, c.icon || "📦"),
        h("div", { class: "cat-name" }, c.name),
        h("div", { class: "cat-actions" },
          h("button", { class: "cat-mini", title: "编辑", onclick: () => editCategory(c, kind) }, "✎"),
          h("button", { class: "cat-mini del", title: "删除", onclick: () => deleteCategory(c) }, "🗑")
        )
      )
    );
  }
  return wrap;
}

function editCategory(cat, kind) {
  const isEdit = !!cat;
  const model = cat || { id: uid(), kind, name: "", color: PALETTE[0], icon: ICONS[0] };

  let selColor = model.color;
  let selIcon = model.icon || ICONS[0];

  const nameI = h("input", { class: "input", placeholder: "分类名称", value: model.name, maxlength: "12" });

  // 颜色格
  const colorGrid = h("div", { class: "color-grid" });
  PALETTE.forEach((col) => {
    const cell = h("div", { class: "color-cell" + (col === selColor ? " on" : ""), style: `background:${col}`, onclick: () => {
      selColor = col;
      [...colorGrid.children].forEach((c) => c.classList.remove("on"));
      cell.classList.add("on");
      colorI.value = col;
    } });
    colorGrid.appendChild(cell);
  });
  const colorI = h("input", { class: "input", type: "color", value: selColor, style: "width:48px; height:40px; padding:4px; flex:0 0 auto;", oninput: (e) => {
    selColor = e.target.value;
    [...colorGrid.children].forEach((c, i) => c.classList.toggle("on", PALETTE[i].toLowerCase() === selColor.toLowerCase()));
  } });

  // 图标格
  const iconGrid = h("div", { class: "icon-grid" });
  ICONS.forEach((ic) => {
    const cell = h("div", { class: "icon-cell" + (ic === selIcon ? " on" : ""), onclick: () => {
      selIcon = ic;
      [...iconGrid.children].forEach((c) => c.classList.remove("on"));
      cell.classList.add("on");
    } }, ic);
    iconGrid.appendChild(cell);
  });

  const form = h("div", {},
    h("div", { class: "field" }, h("label", {}, "名称"), nameI),
    h("div", { class: "field" }, h("label", {}, "颜色"),
      h("div", { class: "row", style: "gap:12px; align-items:center;" }, colorGrid, colorI)
    ),
    h("div", { class: "field" }, h("label", {}, "图标"), iconGrid),
    h("div", { class: "row", style: "gap:10px; margin-top:8px;" },
      h("button", { class: "btn ghost", style: "flex:1", onclick: () => rerender() }, "取消"),
      isEdit ? h("button", { class: "btn danger", style: "flex:1", onclick: async () => {
        if (await confirmDialog("确定删除该分类？相关任务 / 日记会改派到其他分类。")) { await deleteCategory(model); }
      } }, "删除") : null,
      h("button", { class: "btn", style: "flex:1", onclick: async () => {
        const name = nameI.value.trim();
        if (!name) return toast("请填写名称");
        model.name = name;
        model.color = selColor;
        model.icon = selIcon;
        model.kind = kind;
        await db.put("categories", model);
        toast(isEdit ? "已保存" : "已添加");
        rerender();
      } }, "保存")
    )
  );
  openModal(isEdit ? "编辑分类" : "新增分类", form);
}

async function deleteCategory(cat) {
  const sameKind = (await db.getAll("categories")).filter((c) => c.kind === cat.kind && c.id !== cat.id);
  const fallback = sameKind.length ? sameKind[0].id : "";
  const store = cat.kind === "task" ? "tasks" : cat.kind === "diary" ? "diary" : "books";
  const items = await db.getAll(store);
  for (const it of items) {
    if (it.category === cat.id) {
      it.category = fallback;
      await db.put(store, it);
    }
  }
  await db.del("categories", cat.id);
  toast("已删除分类");
  rerender();
}
