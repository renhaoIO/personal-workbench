// 笔记知识库模块：本地 Markdown 笔记，支持搜索 / 置顶 / 标签
import { db, uid } from "../db.js";
import { h, escapeHtml, linkify, fromNow, toast, openModal, closeModal, confirmDialog } from "../util.js";

// 极简 Markdown 渲染（标题 / 列表 / 粗体 / 行内代码 / 链接 / 换行）
function renderMD(src = "") {
  const lines = src.split("\n");
  let html = "";
  let inUl = false;
  const closeUl = () => { if (inUl) { html += "</ul>"; inUl = false; } };
  for (let raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (/^#\s+/.test(line)) { closeUl(); html += `<h3 style="margin:10px 0 4px;">${inline(line.slice(2))}</h3>`; continue; }
    if (/^##\s+/.test(line)) { closeUl(); html += `<h4 style="margin:8px 0 4px;">${inline(line.slice(3))}</h4>`; continue; }
    if (/^[-*]\s+/.test(line)) { if (!inUl) { html += "<ul style='margin:4px 0 4px 18px;'>"; inUl = true; } html += `<li>${inline(line.replace(/^[-*]\s+/, ""))}</li>`; continue; }
    closeUl();
    if (line.trim() === "") { html += "<div style='height:6px'></div>"; continue; }
    html += `<p style="margin:4px 0;">${inline(line)}</p>`;
  }
  closeUl();
  return html;
}
function inline(s) {
  return linkify(
    escapeHtml(s)
      .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
      .replace(/`(.+?)`/g, "<code style='background:var(--surface-2);padding:1px 5px;border-radius:5px;'>$1</code>")
  );
}

export async function renderNotes(root) {
  root.innerHTML = "";

  const search = h("input", { class: "input", placeholder: "🔍 搜索标题 / 内容 / 标签", style: "margin-bottom:12px;" });
  const list = h("div", {});
  root.appendChild(h("div", { class: "searchbar" }, search));
  root.appendChild(list);

  const fab = h("button", { class: "fab", title: "新建笔记", onclick: () => editNote(null) }, "＋");
  root.appendChild(fab);

  let items = await db.getAll("notes");
  sortItems(items);
  draw(items);

  search.addEventListener("input", () => {
    const q = search.value.trim().toLowerCase();
    const filtered = !q
      ? items
      : items.filter((n) =>
          (n.title + " " + n.body + " " + (n.tags || []).join(" ")).toLowerCase().includes(q)
        );
    draw(filtered);
  });

  function sortItems(arr) {
    arr.sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      return (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt);
    });
  }

  function draw(arr) {
    list.innerHTML = "";
    if (!arr.length) {
      list.appendChild(h("div", { class: "center-empty" }, "还没有笔记，点右下角 ＋ 新建"));
      return;
    }
    for (const n of arr) list.appendChild(noteCard(n));
  }

  function noteCard(n) {
    const preview = (n.body || "").replace(/[#*`>\-\n]/g, " ").slice(0, 80);
    const tags = h("div", {}, ...(n.tags || []).map((t) => h("span", { class: "tag" }, "#" + t)));
    const head = h(
      "div",
      { class: "row spread", style: "cursor:pointer;", onclick: () => editNote(n) },
      h("div", { style: "min-width:0; flex:1;" },
        h("div", { class: "item-title" }, (n.pinned ? "📌 " : "") + (n.title || "无标题")),
        h("div", { class: "item-sub" }, preview + (preview ? "…" : "") + "  ·  " + fromNow(n.updatedAt || n.createdAt))
      )
    );
    const actions = h(
      "div",
      { class: "row", style: "gap:8px; margin-top:8px;" },
      h("button", { class: "btn ghost", style: "flex:1; font-size:13px;", onclick: async () => {
          n.pinned = !n.pinned; await db.put("notes", n); window.__rerender();
        } }, n.pinned ? "取消置顶" : "置顶"),
      h("button", { class: "btn ghost", style: "flex:1; font-size:13px;", onclick: async () => {
          if (await confirmDialog("删除这条笔记？")) { await db.del("notes", n.id); window.__rerender(); }
        } }, "删除")
    );
    return h("div", { class: "card" }, head, tags.childNodes.length ? tags : null, actions);
  }
}

function editNote(n) {
  const isEdit = !!n;
  const model = n || { id: uid(), title: "", body: "", tags: [], pinned: false, createdAt: Date.now(), updatedAt: Date.now() };

  const titleI = h("input", { class: "input", placeholder: "标题", value: model.title });
  const bodyI = h("textarea", { class: "textarea", placeholder: "支持 # 标题、- 列表、**粗体**、`代码`、链接", style: "min-height:200px;" }, model.body || "");
  const tagsI = h("input", { class: "input", placeholder: "标签，用逗号分隔", value: (model.tags || []).join(", ") });
  const preview = h("div", { class: "card", style: "background:var(--surface-2); min-height:60px;" });
  const updatePreview = () => { preview.innerHTML = renderMD(bodyI.value); };
  bodyI.addEventListener("input", updatePreview);
  updatePreview();

  const form = h(
    "div",
    {},
    h("div", { class: "field" }, h("label", {}, "标题"), titleI),
    h("div", { class: "field" }, h("label", {}, "内容"), bodyI),
    h("div", { class: "field" }, h("label", {}, "标签"), tagsI),
    h("div", { class: "field" }, h("label", {}, "预览"), preview),
    h("div", { class: "row", style: "gap:10px; margin-top:8px;" },
      h("button", { class: "btn ghost", style: "flex:1", onclick: () => closeModal() }, "取消"),
      isEdit ? h("button", { class: "btn danger", style: "flex:1", onclick: async () => {
          if (await confirmDialog("确定删除？")) { await db.del("notes", model.id); closeModal(); toast("已删除"); window.__rerender(); }
        } }, "删除") : null,
      h("button", { class: "btn", style: "flex:1", onclick: async () => {
          model.title = titleI.value.trim() || "无标题";
          model.body = bodyI.value;
          model.tags = tagsI.value.split(",").map((s) => s.trim()).filter(Boolean);
          model.updatedAt = Date.now();
          if (!isEdit) model.createdAt = Date.now();
          await db.put("notes", model);
          closeModal();
          toast(isEdit ? "已保存" : "已创建");
          window.__rerender();
        } }, "保存")
    )
  );
  openModal(isEdit ? "编辑笔记" : "新建笔记", form);
}
