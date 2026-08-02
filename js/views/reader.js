// 阅读 · 书库：本地图书导入（txt/epub/pdf/fb2，mobi/azw3 提示转换）、图书卡片（封面/进度/分类）、
// 分类筛选、阅读时长统计（总 + 本周 + 分书）。数据存 IndexedDB "books" / "readingLog"。
import { db, uid } from "../db.js";
import { h, fmtDate, toast, openModal, closeModal, confirmDialog, escapeHtml } from "../util.js";
import { parseEpub, parseFb2 } from "../epub.js";

let curCat = "all";

export async function renderReader(root) {
  root.innerHTML = "";
  const books = (await db.getAll("books")).sort((a, b) => (b.lastReadAt || b.addedAt || 0) - (a.lastReadAt || a.addedAt || 0));
  const logs = await db.getAll("readingLog");
  const cats = (await db.getAll("categories")).filter((c) => c.kind === "book");

  // 统计
  const totalSec = logs.reduce((a, l) => a + (l.durationSec || 0), 0);
  const weekStart = weekMonday();
  const weekSec = logs.filter((l) => l.ts >= weekStart).reduce((a, l) => a + (l.durationSec || 0), 0);
  const reading = books.filter((b) => (b.progress || 0) > 0 && (b.progress || 0) < 0.999).length;
  const finished = books.filter((b) => (b.progress || 0) >= 0.999).length;

  root.appendChild(h("div", { class: "card read-stats" },
    h("div", { class: "stat-grid" },
      h("div", { class: "stat" }, h("b", {}, fmtDur(totalSec)), h("span", {}, "累计阅读")),
      h("div", { class: "stat" }, h("b", {}, fmtDur(weekSec)), h("span", {}, "本周阅读")),
      h("div", { class: "stat" }, h("b", {}, String(books.length)), h("span", {}, "藏书"))
    )
  ));

  // 导入
  const fileI = h("input", { type: "file", accept: ".txt,.epub,.pdf,.fb2,.mobi,.azw3", style: "display:none" });
  fileI.addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (f) await importBook(f, cats, () => renderReader(root));
    fileI.value = "";
  });
  const importBtn = h("button", { class: "btn block", style: "margin-bottom:6px;", onclick: () => fileI.click() }, "📥 导入本地图书");
  root.appendChild(importBtn);
  root.appendChild(fileI);

  // 分类筛选
  const chips = h("div", { class: "row", style: "gap:8px; overflow-x:auto; padding:8px 0 4px; flex-wrap:nowrap;" },
    h("span", { class: "chip" + (curCat === "all" ? " on" : ""), onclick: () => { curCat = "all"; renderReader(root); } }, "全部"),
    ...cats.map((c) =>
      h("span", { class: "chip" + (curCat === c.id ? " on" : ""), onclick: () => { curCat = c.id; renderReader(root); } },
        h("span", { class: "cat-dot sm", style: `background:${c.color}` }, c.icon || "📦"), c.name)
    )
  );
  root.appendChild(chips);

  // 书列表
  const list = h("div", { class: "book-grid" });
  const shown = curCat === "all" ? books : books.filter((b) => b.category === curCat);
  if (!shown.length) {
    list.appendChild(h("div", { class: "center-empty", style: "padding:40px 16px;" },
      books.length ? "该分类下还没有书。" : "还没有书。\n点上方「导入本地图书」，支持 TXT / EPUB / PDF / FB2。"));
  }
  for (const b of shown) {
    list.appendChild(bookCard(b, logs, cats, () => renderReader(root)));
  }
  root.appendChild(list);

  // FAB
  root.appendChild(h("button", { class: "fab", title: "导入图书", onclick: () => fileI.click() }, "＋"));
}

function bookCard(b, logs, cats, rerender) {
  const sec = logs.filter((l) => l.bookId === b.id).reduce((a, l) => a + (l.durationSec || 0), 0);
  const cat = cats.find((c) => c.id === b.category);
  const prog = b.progress || 0;
  const card = h("div", { class: "card book-card cv", onclick: () => window.__openBook && window.__openBook(b.id) },
    h("div", { class: "book-cover", style: coverStyle(b.title) }, (b.title || "?").slice(0, 1)),
    h("div", { class: "book-info" },
      h("div", { class: "item-title", style: "display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;" }, b.title || "未命名"),
      h("div", { class: "item-sub" }, (b.author || "未知作者") + " · " + fmtFormat(b.format)),
      cat ? h("span", { class: "tag", style: `background:${cat.color}1a;color:${cat.color}` }, cat.name) : null,
      h("div", { class: "book-prog" },
        h("div", { class: "book-prog-bar" }, h("div", { class: "book-prog-fill", style: `width:${Math.round(prog * 100)}%` })),
        h("div", { class: "item-sub", style: "margin-top:4px;" }, `已读 ${Math.round(prog * 100)}% · 已读 ${fmtDur(sec)}`)
      )
    )
  );
  // 更多操作
  const menu = h("button", { class: "cat-mini book-menu", title: "更多", onclick: (e) => { e.stopPropagation(); bookMenu(b, cats, rerender); } }, "⋮");
  card.appendChild(menu);
  return card;
}

function bookMenu(b, cats, rerender) {
  const catSel = h("select", { class: "input" },
    h("option", { value: "" }, "未分类"),
    ...cats.map((c) => h("option", { value: c.id, selected: c.id === b.category ? "" : null }, c.name))
  );
  catSel.onchange = async () => { b.category = catSel.value; await db.put("books", b); toast("已更新分类"); rerender(); };
  const content = h("div", {},
    h("div", { class: "field" }, h("label", {}, "图书分类"), catSel),
    h("div", { class: "row", style: "gap:10px; margin-top:6px;" },
      h("button", { class: "btn danger", style: "flex:1", onclick: async () => {
        if (await confirmDialog("删除《" + (b.title || "该书") + "》？阅读记录会保留统计。")) {
          await db.del("books", b.id); toast("已删除"); closeModal(); rerender();
        }
      } }, "删除图书"),
      h("button", { class: "btn ghost", style: "flex:1", onclick: () => closeModal() }, "关闭")
    )
  );
  openModal("图书操作", content);
}

// ---------------- 导入 ----------------
async function importBook(file, cats, rerender) {
  const name = file.name;
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (ext === "mobi" || ext === "azw" || ext === "azw3") {
    toast("MOBI / AZW3 暂不支持，请先用 Calibre 转为 EPUB 或 TXT 再导入");
    return;
  }
  toast("解析中…");
  try {
    let title = name.replace(/\.[^.]+$/, "");
    let author = "未知作者";
    let chapters = [];
    let raw = null;
    let format = ext;

    if (ext === "txt") {
      const text = new TextDecoder("utf-8").decode(await file.arrayBuffer()).replace(/^﻿/, "");
      chapters = parseTxt(text);
    } else if (ext === "epub") {
      const r = await parseEpub(await file.arrayBuffer());
      title = r.title; author = r.author; chapters = r.chapters;
    } else if (ext === "fb2") {
      const r = await parseFb2(await file.arrayBuffer());
      title = r.title; author = r.author; chapters = r.chapters;
    } else if (ext === "pdf") {
      raw = await file.arrayBuffer();
      format = "pdf";
    } else {
      toast("不支持的格式：" + ext);
      return;
    }

    const book = {
      id: uid(), title, author, format,
      category: (cats[0] && cats[0].id) || "",
      addedAt: Date.now(), lastReadAt: 0, progress: 0,
      chapters, raw, totalChars: chapters.reduce((a, c) => a + (c.html ? c.html.length : 0), 0),
    };
    await db.put("books", book);
    toast("已导入：" + title);
    rerender();
  } catch (err) {
    console.error(err);
    toast("导入失败：" + (err.message || "解析错误"));
  }
}

function parseTxt(text) {
  const lines = text.split(/\r?\n/);
  const re = /^\s*(第\s*[一二三四五六七八九十百千0-9]+\s*[章回节卷]|chapter\s+\d+|卷\s*[一二三四五六七八九十\d]+)/i;
  const chapters = [];
  let cur = null;
  const push = () => { if (cur && cur.paras.length) chapters.push(cur); };
  for (const line of lines) {
    if (re.test(line)) {
      push();
      cur = { title: line.trim().slice(0, 40) || `第 ${chapters.length + 1} 章`, paras: [] };
    } else {
      const t = line.trim();
      if (!t) continue;
      if (!cur) cur = { title: "正文", paras: [] };
      cur.paras.push(t);
    }
  }
  push();
  if (!chapters.length) {
    const paras = lines.map((l) => l.trim()).filter(Boolean);
    chapters.push({ title: "正文", paras });
  }
  return chapters.map((c) => ({
    title: c.title,
    html: `<h2 class="r-ch">${escapeHtml(c.title)}</h2>` + c.paras.map((p) => `<p>${escapeHtml(p)}</p>`).join(""),
  }));
}

// ---------------- 工具 ----------------
function coverStyle(title) {
  let hash = 0;
  for (let i = 0; i < (title || "").length; i++) hash = (hash * 31 + title.charCodeAt(i)) >>> 0;
  const h1 = hash % 360;
  const h2 = (h1 + 35) % 360;
  return `background:linear-gradient(135deg, hsl(${h1},52%,52%), hsl(${h2},58%,42%));`;
}
function fmtFormat(f) {
  return ({ txt: "TXT", epub: "EPUB", pdf: "PDF", fb2: "FB2" })[f] || (f || "").toUpperCase();
}
function fmtDur(s) {
  s = Math.round(s / 60);
  const h = Math.floor(s / 60), m = s % 60;
  return h ? `${h}小时${m}分` : `${m}分`;
}
function weekMonday() {
  const n = new Date();
  const d = new Date(n);
  d.setDate(n.getDate() - ((n.getDay() + 6) % 7));
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
