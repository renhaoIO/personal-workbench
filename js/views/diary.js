// 日记模块：按日期写日记、心情评分、分类、历史时间线
import { db, uid } from "../db.js";
import { h, escapeHtml, fmtDate, fromNow, toast, openModal, closeModal, confirmDialog } from "../util.js";

const MOODS = ["😞", "😕", "😐", "🙂", "😄"];

let catFilter = "all";
let diaryCats = [];

export async function renderDiary(root) {
  root.innerHTML = "";
  diaryCats = (await db.getAll("categories")).filter((c) => c.kind === "diary");

  let items = (await db.getAll("diary")).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  if (catFilter !== "all") items = items.filter((d) => (d.category || "") === catFilter);

  const today = fmtDate(Date.now());
  const todayEntry = items.find((d) => d.date === today);
  root.appendChild(h("div", { class: "card", style: "cursor:pointer;", onclick: () => editDiary(today) },
    h("div", { class: "row spread" },
      h("b", {}, "📅 今天"),
      h("span", { class: "muted" }, todayEntry ? MOODS[(todayEntry.mood || 3) - 1] + " 已写" : "写点什么")
    )
  ));

  // 分类筛选
  root.appendChild(h("div", { class: "row", style: "gap:8px; margin:12px 0 4px; overflow-x:auto; flex-wrap:nowrap;" },
    h("button", { class: "chip", style: catFilter === "all" ? "background:var(--primary);color:#fff; flex:0 0 auto;" : "cursor:pointer; flex:0 0 auto;", onclick: () => { catFilter = "all"; window.__rerender(); } }, "全部分类"),
    ...diaryCats.map((c) =>
      h("button", { class: "chip", style: catFilter === c.id ? "background:" + c.color + ";color:#fff; flex:0 0 auto;" : "cursor:pointer; flex:0 0 auto;", onclick: () => { catFilter = c.id; window.__rerender(); } }, (c.icon || "") + " " + c.name)
    )
  ));

  root.appendChild(h("h2", { class: "section", style: "margin-top:8px;" }, "历史日记"));
  const list = h("div", {});
  root.appendChild(list);

  const shown = items.filter((d) => d.date !== today);
  if (!shown.length) {
    list.appendChild(h("div", { class: "center-empty" }, "还没有日记，从「今天」开始写吧"));
  }
  for (const d of shown) {
    const cat = diaryCats.find((c) => c.id === d.category);
    const preview = (d.content || "").replace(/\n/g, " ").slice(0, 60);
    list.appendChild(h("div", { class: "card row spread", style: "cursor:pointer;", onclick: () => editDiary(d.date) },
      h("div", { style: "min-width:0; flex:1;" },
        h("div", { class: "item-title" }, MOODS[(d.mood || 3) - 1] + "  " + d.date + (cat ? "  ·  " + (cat.icon || "") + cat.name : "")),
        h("div", { class: "item-sub" }, (preview || "（无内容）") + (preview.length >= 60 ? "…" : ""))
      ),
      h("span", { class: "muted" }, fromNow(d.updatedAt || d.createdAt))
    ));
  }

  root.appendChild(h("button", { class: "fab", title: "写日记", onclick: () => editDiary(today) }, "＋"));
}

function editDiary(dateKey) {
  const date = dateKey || fmtDate(Date.now());
  let entry = null;
  db.get("diary", date).then((e) => { if (e) entry = e; });

  let mood = 3;
  let cat = "";
  db.get("diary", date).then((e) => {
    if (e) { mood = e.mood || 3; cat = e.category || ""; paintMood(); if (catSel) catSel.value = cat; }
  });

  const contentI = h("textarea", { class: "textarea", placeholder: "今天怎样？记下来…", style: "min-height:200px;" });
  db.get("diary", date).then((e) => { if (e) contentI.value = e.content || ""; });

  const catSel = h("select", { class: "input" },
    h("option", { value: "" }, "未分类"),
    ...diaryCats.map((c) => h("option", { value: c.id }, (c.icon || "") + " " + c.name))
  );

  const moodRow = h("div", { class: "moods" },
    ...MOODS.map((m, i) =>
      h("span", { class: "mood" + (i + 1 === mood ? " on" : ""), "data-m": i + 1, onclick: () => { mood = i + 1; paintMood(); } }, m)
    )
  );
  function paintMood() {
    [...moodRow.children].forEach((c, i) => c.classList.toggle("on", i + 1 === mood));
  }

  const form = h("div", {},
    h("div", { class: "field" }, h("label", {}, "日期"), h("input", { class: "input", value: date, disabled: "" })),
    h("div", { class: "field" }, h("label", {}, "分类"), catSel),
    h("div", { class: "field" }, h("label", {}, "心情"), moodRow),
    h("div", { class: "field" }, h("label", {}, "内容"), contentI),
    h("div", { class: "row", style: "gap:10px;" },
      h("button", { class: "btn ghost", style: "flex:1", onclick: () => closeModal() }, "取消"),
      h("button", { class: "btn danger", style: "flex:1", onclick: async () => {
        if (await confirmDialog("删除这篇日记？")) { await db.del("diary", date); closeModal(); toast("已删除"); window.__rerender(); }
      } }, "删除"),
      h("button", { class: "btn", style: "flex:1", onclick: async () => {
        await db.put("diary", { id: date, date, mood, category: catSel.value || "", content: contentI.value, createdAt: (entry && entry.createdAt) || Date.now(), updatedAt: Date.now() });
        closeModal(); toast("已保存"); window.__rerender();
      } }, "保存")
    )
  );
  openModal(date + " 的日记", form);
  paintMood();
}
