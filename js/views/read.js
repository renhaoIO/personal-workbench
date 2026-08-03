// 阅读器：全屏阅读界面 + 目录 + 书签 + 批注（荧光笔/下划线 多色）。
// 富文本渲染（图片/粗体/斜体均在 innerHTML 中保留），阅读计时，进度自动保存。
import { db } from "../db.js";
import { h, toast } from "../util.js";

let layer = null;     // 阅读器全屏层
let session = null;   // 当前阅读会话状态
let annoBar = null;   // 批注浮动工具栏
let selTimer = null;  // 选区防抖定时器

const HL_COLORS = [
  { v: "#ffeb3b", n: "黄" }, { v: "#ff8a80", n: "红" }, { v: "#82b1ff", n: "蓝" },
  { v: "#b9f6ca", n: "绿" }, { v: "#ffe082", n: "橙" }, { v: "#b388ff", n: "紫" },
];

async function getReaderSettings() {
  return {
    font: (await db.getSetting("readerFont", 18)),
    line: (await db.getSetting("readerLine", 1.7)),
    theme: (await db.getSetting("readerTheme", "day")),
    margin: (await db.getSetting("readerMargin", "normal")),
  };
}

function applyContentStyle(content, s) {
  content.style.fontSize = s.font + "px";
  content.style.lineHeight = s.line;
  const pad = { narrow: "14px", normal: "22px", wide: "40px" }[s.margin] || "22px";
  content.style.paddingLeft = pad;
  content.style.paddingRight = pad;
  content.className = "reader-content r-theme-" + s.theme;
  if (layer) layer.className = "reader-layer theme-" + s.theme + (session && session.uiHidden ? " ui-hidden" : "");
}

// ============ 主入口 ============
export async function openBook(id) {
  const book = await db.get("books", id);
  if (!book) return toast("图书不存在");
  if (book.format === "pdf") return openPdf(book);

  const s = await getReaderSettings();
  const bookmarks = await db.getAll("bookmarks");
  const annotations = await db.getAll("annotations");
  document.body.classList.add("reading");
  session = { book, settings: s, lastFlush: Date.now(), acc: 0, raf: 0, bookmarks, annotations,
    uiHidden: false, panel: null };

  // 顶栏
  const top = h("div", { class: "reader-top" },
    h("button", { class: "icon-btn", onclick: closeReader }, "←"),
    h("div", { class: "reader-title" }, book.title || "未命名"),
    h("div", { class: "reader-top-actions" },
      h("button", { class: "icon-btn", title: "目录", onclick: toggleTOC }, "☰"),
      h("button", { class: "icon-btn", title: "书签", onclick: toggleBookmarks }, "🔖"),
      h("button", { class: "icon-btn", title: "批注总览", onclick: toggleAnnotations }, "📝"),
      h("button", { class: "icon-btn", title: "设置", onclick: () => openReaderSettings() }, "Aa")
    )
  );

  // 内容区
  const content = h("div", {});
  renderContent(content, book, annotations);
  applyContentStyle(content, s);

  const progText = h("div", { class: "reader-prog-text" }, Math.round((book.progress || 0) * 100) + "%");
  const chapText = h("div", { class: "reader-chap" }, "");
  const bottom = h("div", { class: "reader-bottom" },
    h("button", { class: "reader-nav", onclick: () => gotoPrevChapter(content) }, "‹ 上一"),
    h("div", { class: "reader-center" }, chapText, progText),
    h("button", { class: "reader-nav", onclick: () => gotoNextChapter(content) }, "下一 ›")
  );

  // 点击分区翻页（有活动选区时不翻页，避免长按选中文字后误翻页）
  content.addEventListener("click", (e) => {
    if (session.uiHidden) { toggleUI(true); return; }
    // 有活动选区：可能是长按选字后的点击，只收起工具栏、不翻页
    if (hasActiveSelection()) { hideAnnoBar(); return; }
    // 工具栏显示时点击内容 → 收起
    if (annoBar && annoBar.style.display !== "none") { hideAnnoBar(); return; }
    const y = e.clientY;
    const h2 = window.innerHeight / 2;
    if (y < h2 * 0.62) content.scrollBy({ top: -window.innerHeight * 0.9, behavior: "smooth" });
    else if (y > h2 * 1.38) content.scrollBy({ top: window.innerHeight * 0.9, behavior: "smooth" });
    else toggleUI();
  });

  // 选中文字 → 弹出批注工具栏（selectionchange 对手机长按/PC 拖动都可靠，防抖后显示）
  document.addEventListener("selectionchange", onSelectionChange);
  // PC 右键选中兜底：阻止系统菜单，直接弹我们的工具栏
  content.addEventListener("contextmenu", (e) => {
    if (hasActiveSelection()) { e.preventDefault(); checkSelection(); }
  });

  // 滚动：更新进度 + 章节名（不因滚动隐藏批注工具栏——点颜色时系统菜单弹出常伴随滚动，
  // 若此时因选区被清空而隐藏，工具栏会在操作中被误关）
  content.addEventListener("scroll", () => {
    if (session.raf) return;
    session.raf = requestAnimationFrame(() => {
      session.raf = 0;
      const frac = content.scrollHeight > content.clientHeight
        ? content.scrollTop / (content.scrollHeight - content.clientHeight) : 1;
      session.book.progress = Math.max(0, Math.min(1, frac));
      progText.textContent = Math.round(session.book.progress * 100) + "%";
      updateChapterName(content, chapText);
    });
  }, { passive: true });

  layer = h("div", { class: "reader-layer" }, top, content, bottom,
    buildSettingsPanel(content), buildTOCPanel(content), buildBookmarkPanel(content), buildAnnoPanel(content));
  document.body.appendChild(layer);

  // 定位到上次进度
  requestAnimationFrame(() => {
    const target = (book.progress || 0) * (content.scrollHeight - content.clientHeight);
    content.scrollTop = Math.max(0, target || 0);
    updateChapterName(content, chapText);
  });

  // 计时与自动保存
  session.flushTimer = setInterval(flush, 15000);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("beforeunload", flush);
}

// ============ 内容渲染 ============
function renderContent(content, book, annotations) {
  const bookAnnos = annotations.filter((a) => a.bookId === book.id);
  content.innerHTML = book.chapters.map((c, i) => {
    let html = c.html;
    // 批量应用该章节所有批注
    const chapAnnos = bookAnnos.filter((a) => a.chapterIndex === i);
    // 按文本长度倒序（长文本先匹配，避免短段匹配到长段内部被重复包裹干扰）
    chapAnnos.sort((a, b) => (b.selectedText || "").length - (a.selectedText || "").length);
    for (const a of chapAnnos) {
      html = applyAnnotation(html, a);
    }
    return `<div class="reader-chapter" data-chapter="${i}">${html}</div>`;
  }).join("");
}

function applyAnnotation(html, a) {
  const cls = a.type === "highlight" ? "anno-hl" : "anno-ul";
  const text = a.selectedText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // 只替换不在标签内的文本
  const re = new RegExp(`(${text})(?![^<]*>)`, "g");
  return html.replace(re, `<span class="${cls}" style="--anno-color:${a.color}">$1</span>`);
}

// ============ 目录面板 ============
function buildTOCPanel(content) {
  const panel = h("div", { class: "reader-toc" });
  panel.style.display = "none";
  const back = h("button", { class: "icon-btn", style: "margin-bottom:10px;", onclick: closePanel }, "←");
  panel.appendChild(back);
  const list = h("div", { class: "toc-list" });
  const chapters = session.book.chapters;
  if (!chapters.length) list.appendChild(h("div", { class: "muted", style: "padding:12px;" }, "暂无目录"));
  else chapters.forEach((c, i) => {
    const item = h("div", { class: "toc-item", onclick: () => { scrollToChapter(content, i); closePanel(); } },
      h("span", { class: "toc-num" }, String(i + 1)),
      h("span", { class: "toc-title" }, c.title || `第 ${i + 1} 节`)
    );
    list.appendChild(item);
  });
  panel.appendChild(list);
  return panel;
}

function toggleTOC() { openPanel("reader-toc"); }
function toggleBookmarks() { openPanel("reader-bookmarks"); refreshBookmarkList(); }

function openPanel(cls) {
  const existing = layer.querySelector("." + cls);
  if (!existing) return;
  const visible = existing.style.display !== "none";
  // 关闭所有面板
  layer.querySelectorAll(".reader-toc,.reader-bookmarks,.reader-settings,.reader-annotations").forEach((p) => p.style.display = "none");
  hideAnnoBar();
  closeAnnoEditor();
  if (!visible) existing.style.display = "block";
}
function closePanel() {
  layer.querySelectorAll(".reader-toc,.reader-bookmarks,.reader-settings,.reader-annotations").forEach((p) => p.style.display = "none");
}

function scrollToChapter(content, idx) {
  const el = content.querySelector(`.reader-chapter[data-chapter="${idx}"]`);
  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ============ 书签面板 ============
function buildBookmarkPanel(content) {
  const panel = h("div", { class: "reader-bookmarks" });
  panel.style.display = "none";
  panel.appendChild(h("button", { class: "icon-btn", style: "margin-bottom:10px;", onclick: closePanel }, "✕"));
  panel.appendChild(h("button", { class: "btn block", style: "margin-bottom:12px;", onclick: () => addBookmark(content) }, "＋ 添加当前位置书签"));
  const list = h("div", { class: "bm-list" });
  list.id = "bm-list";
  panel.appendChild(list);
  return panel;
}

function refreshBookmarkList() {
  const list = layer.querySelector("#bm-list");
  if (!list) return;
  list.innerHTML = "";
  const bms = session.bookmarks.filter((b) => b.bookId === session.book.id);
  if (!bms.length) { list.appendChild(h("div", { class: "muted", style: "padding:12px;" }, "暂无书签")); return; }
  bms.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  bms.forEach((bm) => {
    const item = h("div", { class: "bm-item" },
      h("span", { class: "bm-title" }, bm.title || "未命名书签"),
      h("div", { class: "bm-meta" },
        h("span", {}, "第" + (bm.chapterIndex + 1) + "章 · " + fmtPct(bm.fraction)),
        h("button", { class: "icon-btn", style: "font-size:14px;", title: "删除", onclick: (ev) => { ev.stopPropagation(); confirmRemoveBookmark(item, bm); } }, "✕")
      )
    );
    item.addEventListener("click", () => { if (!item.classList.contains("confirming")) { jumpToBookmark(bm); closePanel(); } });
    list.appendChild(item);
  });
}

async function addBookmark(content) {
  const ci = currentChapterIndex(content);
  const frac = scrollFraction(content);
  const ch = session.book.chapters[ci];
  const title = (ch ? ch.title : "") || `第 ${ci + 1} 章`;
  const bm = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    bookId: session.book.id,
    chapterIndex: ci,
    fraction: frac,
    title,
    createdAt: Date.now(),
  };
  await db.put("bookmarks", bm);
  session.bookmarks.push(bm);
  toast("已添加书签");
  refreshBookmarkList();
}

// 书签删除：阅读界面内两段式确认（✕ → 删除/取消），避免弹出被阅读器遮挡的全局弹窗
function confirmRemoveBookmark(item, bm) {
  if (item.classList.contains("confirming")) return;
  item.classList.add("confirming");
  const meta = item.querySelector(".bm-meta");
  meta.innerHTML = "";
  meta.appendChild(h("span", { style: "color:var(--text-soft);" }, "删除此书签？"));
  meta.appendChild(h("span", {},
    h("button", { class: "bm-del-btn yes", onclick: (ev) => { ev.stopPropagation(); doRemoveBookmark(item, bm); } }, "删除"),
    h("button", { class: "bm-del-btn no", onclick: (ev) => { ev.stopPropagation(); refreshBookmarkList(); } }, "取消")
  ));
  item._confirmTimer = setTimeout(() => refreshBookmarkList(), 4000); // 超时自动还原
}

async function doRemoveBookmark(item, bm) {
  clearTimeout(item._confirmTimer);
  await db.del("bookmarks", bm.id);
  session.bookmarks = session.bookmarks.filter((b) => b.id !== bm.id);
  toast("已删除书签");
  refreshBookmarkList();
}

// ============ 批注总览面板 ============
function toggleAnnotations() { openPanel("reader-annotations"); refreshAnnoList(); }

function buildAnnoPanel(content) {
  const panel = h("div", { class: "reader-annotations" });
  panel.style.display = "none";
  panel.appendChild(h("button", { class: "icon-btn", style: "margin-bottom:10px;", onclick: closePanel }, "✕"));
  const list = h("div", { class: "anno-list" });
  list.id = "anno-list";
  panel.appendChild(list);
  return panel;
}

function refreshAnnoList() {
  const list = layer.querySelector("#anno-list");
  if (!list) return;
  list.innerHTML = "";
  const annos = session.annotations.filter((a) => a.bookId === session.book.id);
  if (!annos.length) { list.appendChild(h("div", { class: "muted", style: "padding:12px;" }, "暂无批注")); return; }
  // 按章节分组
  const groups = {};
  annos.forEach((a) => { const k = a.chapterIndex; if (!groups[k]) groups[k] = []; groups[k].push(a); });
  Object.keys(groups).sort((a, b) => a - b).forEach((ci) => {
    const ch = session.book.chapters[ci];
    const title = ch ? (ch.title || `第 ${+ci + 1} 节`) : `第 ${+ci + 1} 节`;
    list.appendChild(h("div", { class: "anno-group-title" }, title));
    groups[ci].forEach((a) => {
      const item = h("div", { class: "anno-item" },
        h("span", { class: "anno-dot", style: `background:${a.color}` + (a.type === "underline" ? ";border-radius:0;height:3px;align-self:center" : "") }),
        h("span", { class: "anno-text" }, a.selectedText.slice(0, 30) + (a.selectedText.length > 30 ? "…" : "")),
        h("span", { class: "anno-note-text", title: a.note || "", onclick: (ev) => { ev.stopPropagation(); editAnnoNote(a, item); } }, a.note || "＋笔记"),
        h("button", { class: "icon-btn", style: "font-size:13px;width:28px;height:28px;", title: "删除", onclick: (ev) => { ev.stopPropagation(); confirmRemoveAnno(a, item); } }, "✕")
      );
      item.addEventListener("click", () => { jumpToAnno(a); closePanel(); });
      list.appendChild(item);
    });
  });
}

function jumpToAnno(a) {
  const content = layer.querySelector(".reader-content");
  if (!content) return;
  const ch = content.querySelector(`.reader-chapter[data-chapter="${a.chapterIndex}"]`);
  if (!ch) { toast("未找到章节"); return; }
  // 在章节内定位批注文本的精确位置
  const range = findTextRange(ch, a.selectedText);
  if (range) {
    const rect = range.getBoundingClientRect();
    const target = ch.offsetTop + (rect.top - content.getBoundingClientRect().top) + content.scrollTop - 60;
    content.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
    flashAnno(range);
  } else {
    ch.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

// 在 root 内查找 target 文本的位置（跨文本节点，兼容批注 span 包裹后节点结构变化）
function findTextRange(root, target) {
  const t = (target || "").trim();
  if (!t) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let full = "";
  let node;
  while ((node = walker.nextNode())) {
    nodes.push(node);
    full += node.textContent;
  }
  const idx = full.indexOf(t);
  if (idx < 0) return null;
  let pos = 0;
  for (const n of nodes) {
    const len = n.textContent.length;
    if (idx >= pos && idx < pos + len) {
      const start = idx - pos;
      const range = document.createRange();
      range.setStart(n, start);
      range.setEnd(n, Math.min(start + t.length, len));
      return range;
    }
    pos += len;
  }
  return null;
}

// 跳转后闪烁提示批注位置
function flashAnno(range) {
  let el = range.startContainer.parentElement;
  while (el && el !== layer && !el.classList.contains("anno-hl") && !el.classList.contains("anno-ul")) {
    el = el.parentElement;
  }
  if (el && el !== layer) {
    el.classList.add("anno-jump-flash");
    setTimeout(() => el.classList.remove("anno-jump-flash"), 2600);
  }
}

// 编辑批注笔记
function editAnnoNote(a, item) {
  const span = item.querySelector(".anno-note-text");
  if (!span || span.querySelector("input")) return;
  const cur = a.note || "";
  const input = h("input", { class: "anno-note-edit", value: cur, placeholder: "笔记..." });
  span.replaceWith(input);
  input.focus();
  const save = async () => {
    a.note = input.value.trim();
    await db.put("annotations", a);
    refreshAnnoList();
  };
  input.addEventListener("blur", save);
  input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); input.blur(); } });
}

// 删除批注
async function doRemoveAnno(a) {
  await db.del("annotations", a.id);
  session.annotations = session.annotations.filter((x) => x.id !== a.id);
  // 重新渲染（去掉标注样式）
  const content = layer.querySelector(".reader-content");
  if (content) {
    const st = content.scrollTop;
    renderContent(content, session.book, session.annotations);
    applyContentStyle(content, session.settings);
    content.scrollTop = st;
  }
  toast("已删除批注");
  refreshAnnoList();
}

function confirmRemoveAnno(a, item) {
  if (item.classList.contains("confirming")) return;
  item.classList.add("confirming");
  const act = item.querySelector(".anno-note-text") || item.querySelector(".anno-note-edit") || item.querySelector(".anno-text");
  const row = act ? act.parentNode : item;
  const confirm = h("span", { class: "anno-del-confirm" },
    h("button", { class: "bm-del-btn yes", onclick: (ev) => { ev.stopPropagation(); doRemoveAnno(a); } }, "删除"),
    h("button", { class: "bm-del-btn no", onclick: (ev) => { ev.stopPropagation(); refreshAnnoList(); } }, "取消")
  );
  row.appendChild(confirm);
  item._confirmT = setTimeout(() => refreshAnnoList(), 4000);
}

function jumpToBookmark(bm) {
  const content = layer.querySelector(".reader-content");
  if (!content) return;
  const target = (bm.fraction || 0) * (content.scrollHeight - content.clientHeight);
  content.scrollTop = Math.max(0, target);
}

// ============ 批注工具栏 ============
// 是否在阅读内容区内有一段有效的文字选区
function hasActiveSelection() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return false;
  const t = sel.toString().trim();
  if (t.length < 2) return false;
  const node = sel.anchorNode;
  return !!(node && layer && layer.contains(node));
}

function onSelectionChange() {
  clearTimeout(selTimer);
  selTimer = setTimeout(checkSelection, 150);
}

function checkSelection() {
  // 只负责显示工具栏，不负责隐藏（点击内容/标注完成/滚动才隐藏），
  // 彻底避免点颜色/标注按钮时选区被浏览器清空导致工具栏误关
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  const text = sel.toString().trim();
  if (text.length < 2) return;
  const node = sel.anchorNode;
  if (!node || !layer || !layer.contains(node)) return;
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  if (!rect || (!rect.width && !rect.height)) return;
  showAnnoBar(rect, text);
}

function showAnnoBar(rect, text) {
  if (!annoBar) {
    annoBar = h("div", { class: "anno-bar" });
    // 荧光笔按钮
    const hlBtn = h("button", { class: "anno-type", title: "荧光笔" }, "");
    hlBtn.addEventListener("click", () => {
      const all = annoBar.querySelectorAll(".anno-type");
      all.forEach((b) => b.classList.remove("on"));
      hlBtn.classList.add("on");
      annoBar.dataset.mode = "highlight";
    });
    hlBtn.classList.add("on");
    annoBar.dataset.mode = "highlight";

    // 下划线按钮
    const ulBtn = h("button", { class: "anno-type", title: "下划线" }, "U");
    ulBtn.addEventListener("click", () => {
      const all = annoBar.querySelectorAll(".anno-type");
      all.forEach((b) => b.classList.remove("on"));
      ulBtn.classList.add("on");
      annoBar.dataset.mode = "underline";
    });

    // 颜色色块
    const colorsRow = h("div", { class: "anno-colors" });
    HL_COLORS.forEach((c, i) => {
      const dot = h("span", { class: "anno-color" + (i === 0 ? " on" : ""), style: `background:${c.v}`, title: c.n });
      dot.addEventListener("click", () => {
        colorsRow.querySelectorAll(".anno-color").forEach((d) => d.classList.remove("on"));
        dot.classList.add("on");
        annoBar.dataset.color = c.v;
      });
      colorsRow.appendChild(dot);
    });
    annoBar.dataset.color = HL_COLORS[0].v;

    // 快速标注（无笔记）
    const okBtn = h("button", { class: "anno-apply", onclick: () => applyAnnotationFromBar() }, "标注");
    // 写笔记 → 弹出独立编辑界面（Jane Reader 风格）
    const noteBtn = h("button", { class: "anno-note-btn", title: "写笔记", onclick: () => openAnnoEditor() }, "📝 笔记");
    annoBar.appendChild(hlBtn);
    annoBar.appendChild(ulBtn);
    annoBar.appendChild(colorsRow);
    annoBar.appendChild(okBtn);
    annoBar.appendChild(noteBtn);
    layer.appendChild(annoBar);
  }
  annoBar.style.display = "flex";
  annoBar.text = text;
}

// ============ 笔记编辑器（Jane Reader 风格底部弹窗）============
function openAnnoEditor() {
  if (!annoBar || !annoBar.text) { toast("请先选中文字"); return; }
  closeAnnoEditor(); // 防止重复
  const text = annoBar.text;
  const mode = annoBar.dataset.mode || "highlight";
  const color = annoBar.dataset.color || HL_COLORS[0].v;

  const mask = h("div", { class: "anno-editor-mask", onclick: closeAnnoEditor });
  const sheet = h("div", { class: "anno-editor" });
  sheet.dataset.mode = mode;
  sheet.dataset.color = color;

  // 标题
  sheet.appendChild(h("div", { class: "ae-head" },
    h("div", { class: "ae-title" }, "笔记"),
    h("button", { class: "icon-btn", style: "width:30px;height:30px;", onclick: closeAnnoEditor }, "✕")
  ));

  // 引用文字
  sheet.appendChild(h("div", { class: "ae-quote" },
    h("div", { class: "ae-label" }, "引用"),
    h("div", { class: "ae-quote-text" }, text)
  ));

  // 标注类型分段
  const typeSeg = h("div", { class: "seg" },
    segBtn("highlight", "荧光笔"), segBtn("underline", "下划线"));
  sheet.appendChild(h("div", { class: "ae-label" }, "标注类型"));
  sheet.appendChild(typeSeg);

  // 颜色
  const colorsRow = h("div", { class: "anno-colors", style: "margin-top:8px;" });
  HL_COLORS.forEach((c, i) => {
    const dot = h("span", { class: "anno-color" + (c.v === color ? " on" : ""), style: `background:${c.v}`, title: c.n });
    dot.addEventListener("click", () => {
      colorsRow.querySelectorAll(".anno-color").forEach((d) => d.classList.remove("on"));
      dot.classList.add("on");
      sheet.dataset.color = c.v;
    });
    colorsRow.appendChild(dot);
  });
  sheet.appendChild(colorsRow);

  // 笔记正文
  sheet.appendChild(h("div", { class: "ae-label", style: "margin-top:14px;" }, "我的笔记"));
  const note = h("textarea", { class: "ae-note", placeholder: "写下你的想法…", rows: 4 });
  sheet.appendChild(note);

  // 按钮
  sheet.appendChild(h("div", { class: "row", style: "gap:10px;margin-top:14px;" },
    h("button", { class: "btn ghost", style: "flex:1", onclick: closeAnnoEditor }, "取消"),
    h("button", { class: "btn", style: "flex:1", onclick: () => saveAnnoFromEditor() }, "保存")
  ));

  layer.appendChild(mask);
  layer.appendChild(sheet);
  setTimeout(() => note.focus(), 150);

  function segBtn(v, label) {
    const b = h("button", { class: sheet.dataset.mode === v ? "on" : "", onclick: () => {
      sheet.dataset.mode = v;
      [...typeSeg.children].forEach((c) => c.classList.toggle("on", c === b));
    } }, label);
    return b;
  }
}

function closeAnnoEditor() {
  const mask = layer && layer.querySelector(".anno-editor-mask");
  const sheet = layer && layer.querySelector(".anno-editor");
  if (mask) mask.remove();
  if (sheet) sheet.remove();
}

async function saveAnnoFromEditor() {
  if (!annoBar) return;
  const text = annoBar.text;
  if (!text) { toast("未选中文字"); closeAnnoEditor(); return; }
  const sheet = layer.querySelector(".anno-editor");
  if (!sheet) return;
  const mode = sheet.dataset.mode || "highlight";
  const color = sheet.dataset.color || HL_COLORS[0].v;
  const note = (sheet.querySelector(".ae-note")?.value || "").trim();
  const content = layer.querySelector(".reader-content");
  if (!content) return;
  const ci = currentChapterIndex(content);
  const dup = session.annotations.find(
    (a) => a.bookId === session.book.id && a.chapterIndex === ci &&
      a.selectedText === text && a.type === mode && a.color === color
  );
  if (dup) { toast("该批注已存在"); closeAnnoEditor(); return; }
  const anno = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    bookId: session.book.id, chapterIndex: ci, selectedText: text,
    type: mode, color, note, createdAt: Date.now(),
  };
  await db.put("annotations", anno);
  session.annotations.push(anno);
  closeAnnoEditor();
  hideAnnoBar();
  annoBar.text = null;
  window.getSelection()?.removeAllRanges();
  const st = content.scrollTop;
  renderContent(content, session.book, session.annotations);
  applyContentStyle(content, session.settings);
  content.scrollTop = st;
  toast(note ? "已保存批注笔记" : "已保存批注");
}


// 只隐藏不清空 text：手机上点击"标注"按钮时选区先被浏览器清空，
// 若此时清空 text，按钮点击将拿不到文本导致标注失效
function hideAnnoBar() {
  if (annoBar) annoBar.style.display = "none";
}

async function applyAnnotationFromBar() {
  if (!annoBar) return;
  const text = annoBar.text;
  if (!text) return;
  const mode = annoBar.dataset.mode || "highlight";
  const color = annoBar.dataset.color || "#ffeb3b";
  const note = ""; // 快速标注不带笔记；写笔记走独立编辑器
  const content = layer.querySelector(".reader-content");
  if (!content) return;
  const ci = currentChapterIndex(content);
  const dup = session.annotations.find(
    (a) => a.bookId === session.book.id && a.chapterIndex === ci &&
      a.selectedText === text && a.type === mode && a.color === color
  );
  if (dup) { toast("该批注已存在"); hideAnnoBar(); return; }

  const anno = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    bookId: session.book.id, chapterIndex: ci, selectedText: text,
    type: mode, color, note, createdAt: Date.now(),
  };
  await db.put("annotations", anno);
  session.annotations.push(anno);
  hideAnnoBar();
  annoBar.text = null;
  window.getSelection()?.removeAllRanges();
  const scrollTop = content.scrollTop;
  renderContent(content, session.book, session.annotations);
  applyContentStyle(content, session.settings);
  content.scrollTop = scrollTop;
  toast(mode === "highlight" ? "荧光笔标注" : "下划线标注");
}

// ============ 章节导航 ============
function gotoNextChapter(content) {
  const chapters = [...content.querySelectorAll(".reader-chapter")];
  const ci = currentChapterIndex(content);
  if (ci < chapters.length - 1) chapters[ci + 1].scrollIntoView({ behavior: "smooth", block: "start" });
}
function gotoPrevChapter(content) {
  const chapters = [...content.querySelectorAll(".reader-chapter")];
  const ci = currentChapterIndex(content);
  if (ci > 0) chapters[ci - 1].scrollIntoView({ behavior: "smooth", block: "start" });
}

function currentChapterIndex(content) {
  const chapters = [...content.querySelectorAll(".reader-chapter")];
  const top = content.scrollTop;
  let best = 0;
  for (let i = 0; i < chapters.length; i++) {
    if (chapters[i].offsetTop <= top + content.clientHeight * 0.4) best = i;
    else break;
  }
  return best;
}

function scrollFraction(content) {
  return content.scrollHeight > content.clientHeight
    ? content.scrollTop / (content.scrollHeight - content.clientHeight) : 1;
}

// ============ 设置面板 ============
function buildSettingsPanel(content) {
  const panel = h("div", { class: "reader-settings" });
  panel.style.display = "none";

  const fontVal = h("span", { class: "muted" }, session.settings.font + "px");
  const fontMinus = h("button", { class: "cat-mini", onclick: () => changeFont(-1) }, "A-");
  const fontPlus = h("button", { class: "cat-mini", onclick: () => changeFont(1) }, "A+");

  const lineVal = h("span", { class: "muted" }, session.settings.line.toFixed(1));
  const lineMinus = h("button", { class: "cat-mini", onclick: () => changeLine(-0.1) }, "—");
  const linePlus = h("button", { class: "cat-mini", onclick: () => changeLine(0.1) }, "＋");

  const themeSeg = h("div", { class: "seg" },
    themeBtn("day", "日用"), themeBtn("sepia", "护眼"), themeBtn("night", "夜间"));
  const marginSeg = h("div", { class: "seg" },
    marginBtn("narrow", "窄"), marginBtn("normal", "标准"), marginBtn("wide", "宽"));

  panel.appendChild(h("div", { class: "rs-block" },
    h("div", { class: "rs-label" }, "字号"), h("div", { class: "rs-row" }, fontMinus, fontVal, fontPlus)));
  panel.appendChild(h("div", { class: "rs-block" },
    h("div", { class: "rs-label" }, "行距"), h("div", { class: "rs-row" }, lineMinus, lineVal, linePlus)));
  panel.appendChild(h("div", { class: "rs-block" }, h("div", { class: "rs-label" }, "主题"), themeSeg));
  panel.appendChild(h("div", { class: "rs-block" }, h("div", { class: "rs-label" }, "边距"), marginSeg));
  panel.appendChild(h("button", { class: "btn block", style: "margin-top:6px;", onclick: () => { panel.style.display = "none"; } }, "完成"));

  function changeFont(d) {
    session.settings.font = Math.max(13, Math.min(28, session.settings.font + d));
    fontVal.textContent = session.settings.font + "px";
    applyContentStyle(content, session.settings);
    db.setSetting("readerFont", session.settings.font);
  }
  function changeLine(d) {
    session.settings.line = Math.max(1.3, Math.min(2.2, Math.round((session.settings.line + d) * 10) / 10));
    lineVal.textContent = session.settings.line.toFixed(1);
    applyContentStyle(content, session.settings);
    db.setSetting("readerLine", session.settings.line);
  }
  function themeBtn(v, label) {
    const b = h("button", { class: session.settings.theme === v ? "on" : "", onclick: () => {
      session.settings.theme = v;
      [...themeSeg.children].forEach((c) => c.classList.toggle("on", c === b));
      applyContentStyle(content, session.settings);
      db.setSetting("readerTheme", v);
    } }, label);
    return b;
  }
  function marginBtn(v, label) {
    const b = h("button", { class: session.settings.margin === v ? "on" : "", onclick: () => {
      session.settings.margin = v;
      [...marginSeg.children].forEach((c) => c.classList.toggle("on", c === b));
      applyContentStyle(content, session.settings);
      db.setSetting("readerMargin", v);
    } }, label);
    return b;
  }
  return panel;
}

function openReaderSettings() { openPanel("reader-settings"); }

function toggleUI(forceShow) {
  if (!session) return;
  session.uiHidden = forceShow ? false : !session.uiHidden;
  if (layer) layer.classList.toggle("ui-hidden", session.uiHidden);
}

// ============ 计时 & 保存 ============
function onVisibility() { if (document.hidden) flush(); }

function updateChapterName(content, el) {
  const heads = [...content.querySelectorAll(".r-ch")];
  if (!heads.length) { el.textContent = ""; return; }
  const top = content.scrollTop + 20;
  let name = "";
  for (const hd of heads) { if (hd.offsetTop <= top) name = hd.textContent; else break; }
  if (!name && heads[0]) name = heads[0].textContent;
  el.textContent = name;
}

async function flush() {
  if (!session) return;
  const now = Date.now();
  const dur = Math.round((now - session.lastFlush) / 1000);
  session.lastFlush = now;
  if (dur > 0) {
    await db.put("readingLog", {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      bookId: session.book.id, ts: now, date: fmtKey(now), durationSec: dur,
    });
    session.book.lastReadAt = now;
    await db.put("books", session.book);
  }
}
function fmtKey(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function fmtPct(f) { return Math.round((f || 0) * 100) + "%"; }

function closeReader() {
  flush();
  if (session && session.flushTimer) clearInterval(session.flushTimer);
  document.removeEventListener("visibilitychange", onVisibility);
  document.removeEventListener("selectionchange", onSelectionChange);
  window.removeEventListener("beforeunload", flush);
  hideAnnoBar();
  closeAnnoEditor();
  if (annoBar) { annoBar.remove(); annoBar = null; }
  if (layer) { layer.remove(); layer = null; }
  document.body.classList.remove("reading");
  session = null;
  if (window.__route) window.__route("reader");
}

// ============ PDF 预览 ============
async function openPdf(book) {
  document.body.classList.add("reading");
  const blob = new Blob([book.raw], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const top = h("div", { class: "reader-top" },
    h("button", { class: "icon-btn", onclick: closePdf }, "←"),
    h("div", { class: "reader-title" }, book.title || "PDF"),
    h("div", { class: "icon-btn" }));
  const frame = h("iframe", { class: "reader-pdf", src: url });
  const layer2 = h("div", { class: "reader-layer" }, top, frame);
  document.body.appendChild(layer2);
  const start = Date.now();
  window.__pdfClose = () => {
    const dur = Math.round((Date.now() - start) / 1000);
    if (dur > 5) db.put("readingLog", { id: Date.now().toString(36), bookId: book.id, ts: Date.now(), date: fmtKey(Date.now()), durationSec: dur });
    URL.revokeObjectURL(url);
    layer2.remove();
    document.body.classList.remove("reading");
    if (window.__route) window.__route("reader");
  };
}
function closePdf() { if (window.__pdfClose) window.__pdfClose(); }

window.__openBook = openBook;
