// 阅读器：全屏阅读界面 + 目录 + 书签 + 批注（荧光笔/下划线 多色）+ 两种翻页模式。
// 翻页模式：scroll 连续滚动 / cover 无动画分页切换（参考开源阅读，每页文字均匀）。
// 富文本渲染（图片/粗体/斜体保留），阅读计时，进度自动保存。
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
const MODE_LABEL = { scroll: "滚动", cover: "切换" };

async function getReaderSettings() {
  return {
    font: (await db.getSetting("readerFont", 18)),
    line: (await db.getSetting("readerLine", 1.7)),
    theme: (await db.getSetting("readerTheme", "day")),
    margin: (await db.getSetting("readerMargin", "normal")),
    mode: (await db.getSetting("readerMode", "scroll")),
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

function padOf(s) { return { narrow: "14px", normal: "22px", wide: "40px" }[s.margin] || "22px"; }

// ============ 主入口 ============
export async function openBook(id) {
  const book = await db.get("books", id);
  if (!book) return toast("图书不存在");
  if (book.format === "pdf") return openPdf(book);
  // 入栈：返回键可从阅读器回到书库
  try { history.pushState({ view: "__reader" }, ""); } catch (e) {}
  window.__readerOpen = true;

  const s = await getReaderSettings();
  const bookmarks = await db.getAll("bookmarks");
  const annotations = await db.getAll("annotations");
  document.body.classList.add("reading");
  session = { book, settings: s, lastFlush: Date.now(), acc: 0, raf: 0, bookmarks, annotations,
    uiHidden: false, pages: [], pageIndex: 0, animLock: false, touchX: 0 };

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

  const progText = h("div", { class: "reader-prog-text" }, Math.round((book.progress || 0) * 100) + "%");
  const chapText = h("div", { class: "reader-chap" }, "");
  const bottom = h("div", { class: "reader-bottom" },
    h("button", { class: "reader-nav", onclick: () => gotoPrev() }, "‹ 上一"),
    h("div", { class: "reader-center" }, chapText, progText),
    h("button", { class: "reader-nav", onclick: () => gotoNext() }, "下一 ›")
  );

  // 内容区：按翻页模式构建
  const content = buildContentArea(s);

  // 点击分区
  content.addEventListener("click", onContentClick);

  // 触摸滑动（分页模式翻页手势）
  content.addEventListener("touchstart", (e) => { session.touchX = e.touches[0].clientX; }, { passive: true });
  content.addEventListener("touchend", (e) => {
    if (session.settings.mode === "scroll") return;
    const dx = e.changedTouches[0].clientX - session.touchX;
    if (Math.abs(dx) > 50) turnPage(dx < 0 ? 1 : -1);
  }, { passive: true });

  document.addEventListener("selectionchange", onSelectionChange);
  content.addEventListener("contextmenu", (e) => {
    if (hasActiveSelection()) { e.preventDefault(); checkSelection(); }
  });

  // 滚动模式：滚动更新进度/章节名
  if (session.settings.mode === "scroll") {
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
  }

  layer = h("div", { class: "reader-layer" }, top, content, bottom,
    buildSettingsPanel(content), buildTOCPanel(content), buildBookmarkPanel(content), buildAnnoPanel(content));
  document.body.appendChild(layer);

  // 定位到上次进度
  requestAnimationFrame(() => {
    if (session.settings.mode === "scroll") {
      const target = (book.progress || 0) * (content.scrollHeight - content.clientHeight);
      content.scrollTop = Math.max(0, target || 0);
      updateChapterName(content, chapText);
    } else {
      session.pages = buildPages(session.settings);
      if (!session.pages.length) session.pages = [{ chapterIndex: 0, html: "<p>（空书）</p>" }];
      session.pageIndex = Math.max(0, Math.min(session.pages.length - 1,
        Math.round((book.progress || 0) * (session.pages.length - 1))));
      renderPage(session.pageIndex);
      updatePageInfo(progText, chapText);
    }
  });

  session.flushTimer = setInterval(flush, 15000);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("beforeunload", flush);
}

// 构建内容区：滚动模式=可滚动容器；分页模式=视口容器
function buildContentArea(s) {
  if (s.mode === "scroll") {
    const content = h("div", {});
    renderContent(content, session.book, session.annotations);
    applyContentStyle(content, s);
    return content;
  }
  const vp = h("div", { class: "page-viewport r-theme-" + s.theme });
  vp.style.fontSize = s.font + "px";
  vp.style.lineHeight = s.line;
  return vp;
}

// ============ 分页引擎 ============
function buildPages(s) {
  const { book } = session;
  // 用视口容器真实尺寸（不是整个 layer——layer 含顶栏+底栏，用它每页会超高）
  const vp = layer.querySelector(".page-viewport");
  if (!vp) return [];
  const vw = vp.clientWidth || (layer.clientWidth - 4);
  const vh = vp.clientHeight || (layer.clientHeight - 120);
  const pad = padOf(s);
  const pageH = Math.max(120, vh - 18 - 40);

  // 测量容器（与真实页同宽同样式，隐藏）
  const measurer = document.createElement("div");
  measurer.style.cssText = `position:fixed;left:-10000px;top:0;visibility:hidden;width:${vw}px;font-size:${s.font}px;line-height:${s.line};padding-left:${pad}px;padding-right:${pad}px;`;
  measurer.className = "r-theme-" + s.theme;
  document.body.appendChild(measurer);

  const pages = [];
  let cur = [];
  const flush = () => { if (cur.length) { pages.push({ chapterIndex: cur[0].ci, html: cur.map((b) => b.html).join("") }); cur = []; } };

  book.chapters.forEach((ch, ci) => {
    const html = annotateChapter(ch.html, book.id, ci, session.annotations);
    const blocks = parseBlocks(html);
    for (const b of blocks) {
      measurer.innerHTML = cur.map((x) => x.html).join("");
      const h0 = measurer.scrollHeight;
      measurer.innerHTML += b;
      if (measurer.scrollHeight <= pageH) { cur.push({ ci, html: b }); continue; }
      // 放不下
      if (cur.length) { flush(); measurer.innerHTML = b; if (measurer.scrollHeight <= pageH) { cur.push({ ci, html: b }); continue; } }
      // 单块超高：拆子元素
      splitBlock(b, pageH, measurer, pages, ci);
    }
  });
  flush();
  measurer.remove();
  return pages;
}

// 解析章节 HTML 为顶层块数组（保留标签结构）
function parseBlocks(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const body = doc.body || doc.documentElement;
  const out = [];
  const walk = (node) => {
    for (const el of node.children) {
      out.push(el.outerHTML);
      // 顶层容器（如 div）内的直接块级子元素也单独拆出
      if (el.children.length && /^div$/i.test(el.tagName)) {
        out.pop();
        walk(el);
      }
    }
  };
  walk(body);
  if (!out.length && body.textContent.trim()) out.push(body.innerHTML);
  return out;
}

// 单块超高/放不下：优先拆子元素；纯文本块按字符二分切分填满页面（每页文字均匀）
function splitBlock(blockHtml, pageH, measurer, pages, ci) {
  const doc = new DOMParser().parseFromString(blockHtml, "text/html");
  const root = doc.body.firstElementChild || doc.body;
  const children = root.children && root.children.length ? [...root.children] : [root];
  let sub = [];
  const flushSub = () => { if (sub.length) { pages.push({ chapterIndex: ci, html: sub.join("") }); sub = []; } };
  for (const c of children) {
    measurer.innerHTML = sub.join("");
    const h0 = measurer.scrollHeight;
    let html = c.outerHTML;
    if (c.tagName === "IMG") html = c.outerHTML.replace(/<img/i, '<img style="max-height:55vh"').replace(/\/>$/, "/>");
    measurer.innerHTML += html;
    if (measurer.scrollHeight <= pageH) { sub.push(html); continue; }
    flushSub();
    measurer.innerHTML = html;
    if (measurer.scrollHeight <= pageH) { sub.push(html); continue; }
    // 单独也放不下：文本类元素按字符二分，尽量填满每页
    if (/^(p|div|li|h[1-6]|blockquote|section|article)$/i.test(c.tagName) && c.textContent.trim().length > 4) {
      let restHtml = html;
      while (restHtml && restHtml.trim().length > 4) {
        const fit = splitTextFit(restHtml, pageH, measurer);
        if (!fit.first) break;
        pages.push({ chapterIndex: ci, html: fit.first });
        restHtml = fit.rest;
      }
      if (restHtml && restHtml.trim()) pages.push({ chapterIndex: ci, html: restHtml });
    } else {
      // 图片或其它非文本：限高独立成页
      pages.push({ chapterIndex: ci, html });
    }
  }
  flushSub();
}

// 把一段 HTML 的文本按字符二分，返回能刚好放满一页的前缀与剩余部分
function splitTextFit(html, pageH, measurer) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const root = doc.body.firstElementChild || doc.body;
  const tag = root.tagName.toLowerCase();
  const text = root.textContent;
  if (text.length <= 2) return { first: null, rest: html };
  let lo = 1, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    measurer.innerHTML = `<${tag}>${escapeText(text.slice(0, mid))}</${tag}>`;
    if (measurer.scrollHeight <= pageH) lo = mid; else hi = mid - 1;
  }
  if (lo < 2) return { first: null, rest: html };
  return { first: `<${tag}>${escapeText(text.slice(0, lo))}</${tag}>`, rest: `<${tag}>${escapeText(text.slice(lo))}</${tag}>` };
}

function escapeText(t) {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ============ 分页渲染与翻页（无动画切换，参考开源阅读）============
function renderPage(idx) {
  const vp = layer.querySelector(".page-viewport");
  if (!vp) return;
  const pad = padOf(session.settings);
  vp.innerHTML = `<div class="page-cur" style="padding-left:${pad};padding-right:${pad}">${session.pages[idx].html}</div>`;
  session.pageIndex = idx;
}

function turnPage(dir) {
  if (session.animLock) return;
  const { pages, pageIndex } = session;
  const next = pageIndex + dir;
  if (next < 0 || next >= pages.length) return;
  session.pageIndex = next;
  renderPage(next);
  updateAfterTurn();
}

function updateAfterTurn() {
  const progText = layer.querySelector(".reader-prog-text");
  const chapText = layer.querySelector(".reader-chap");
  updatePageInfo(progText, chapText);
}

function updatePageInfo(progText, chapText) {
  if (!layer) return;
  const { pages, pageIndex, book } = session;
  if (!pages.length) return;
  session.book.progress = pages.length > 1 ? pageIndex / (pages.length - 1) : 0;
  if (progText) progText.textContent = Math.round(session.book.progress * 100) + "%";
  const ci = pages[pageIndex].chapterIndex;
  const ch = book.chapters[ci];
  if (chapText) chapText.textContent = ch ? ch.title : "";
}

function gotoPrev() {
  if (session.settings.mode === "scroll") gotoScrollDir(-1);
  else turnPage(-1);
}
function gotoNext() {
  if (session.settings.mode === "scroll") gotoScrollDir(1);
  else turnPage(1);
}
function gotoScrollDir(dir) {
  const content = layer.querySelector(".reader-content");
  if (!content) return;
  const heads = [...content.querySelectorAll(".reader-chapter")];
  if (!heads.length) return;
  const ci = currentChapterIndex(content);
  if (dir > 0 && ci < heads.length - 1) heads[ci + 1].scrollIntoView({ behavior: "smooth", block: "start" });
  else if (dir < 0 && ci > 0) heads[ci - 1].scrollIntoView({ behavior: "smooth", block: "start" });
}

function onContentClick(e) {
  if (session.uiHidden) { toggleUI(true); return; }
  if (hasActiveSelection()) { hideAnnoBar(); return; }
  if (annoBar && annoBar.style.display !== "none") { hideAnnoBar(); return; }
  if (session.settings.mode === "scroll") {
    const content = layer.querySelector(".reader-content");
    const y = e.clientY;
    const h2 = window.innerHeight / 2;
    if (y < h2 * 0.62) content.scrollBy({ top: -window.innerHeight * 0.9, behavior: "smooth" });
    else if (y > h2 * 1.38) content.scrollBy({ top: window.innerHeight * 0.9, behavior: "smooth" });
    else toggleUI();
    return;
  }
  // 分页模式：左 1/3 上一页，右 1/3 下一页，中间 UI
  const w = window.innerWidth / 3;
  if (e.clientX < w) turnPage(-1);
  else if (e.clientX > w * 2) turnPage(1);
  else toggleUI();
}

// ============ 内容渲染 ============
function annotateChapter(html, bookId, chapterIndex, annotations) {
  const chapAnnos = annotations.filter((a) => a.bookId === bookId && a.chapterIndex === chapterIndex)
    .sort((a, b) => (b.selectedText || "").length - (a.selectedText || "").length);
  let out = html;
  for (const a of chapAnnos) out = applyAnnotation(out, a);
  return out;
}

function renderContent(content, book, annotations) {
  content.innerHTML = book.chapters.map((c, i) =>
    `<div class="reader-chapter" data-chapter="${i}">${annotateChapter(c.html, book.id, i, annotations)}</div>`).join("");
}

function applyAnnotation(html, a) {
  const cls = a.type === "highlight" ? "anno-hl" : "anno-ul";
  const text = a.selectedText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(${text})(?![^<]*>)`, "g");
  return html.replace(re, `<span class="${cls}" style="--anno-color:${a.color}">$1</span>`);
}

// ============ 目录面板 ============
function buildTOCPanel(content) {
  const panel = h("div", { class: "reader-toc" });
  panel.style.display = "none";
  panel.appendChild(h("button", { class: "icon-btn", style: "margin-bottom:10px;", onclick: closePanel }, "←"));
  const list = h("div", { class: "toc-list" });
  session.book.chapters.forEach((c, i) => {
    const item = h("div", { class: "toc-item", onclick: () => { jumpToChapter(i); closePanel(); } },
      h("span", { class: "toc-num" }, String(i + 1)),
      h("span", { class: "toc-title" }, c.title || `第 ${i + 1} 节`)
    );
    list.appendChild(item);
  });
  panel.appendChild(list);
  return panel;
}

function toggleTOC() { openPanel("reader-toc"); }

function jumpToChapter(ci) {
  if (session.settings.mode === "scroll") {
    const content = layer.querySelector(".reader-content");
    const el = content && content.querySelector(`.reader-chapter[data-chapter="${ci}"]`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  // 分页模式：找该章节第一页
  const idx = session.pages.findIndex((p) => p.chapterIndex === ci);
  if (idx >= 0) turnToPage(idx);
}

function turnToPage(idx) {
  if (session.animLock) return;
  session.pageIndex = Math.max(0, Math.min(session.pages.length - 1, idx));
  renderPage(session.pageIndex);
  updateAfterTurn();
}

function openPanel(cls) {
  const existing = layer.querySelector("." + cls);
  if (!existing) return;
  const visible = existing.style.display !== "none";
  layer.querySelectorAll(".reader-toc,.reader-bookmarks,.reader-settings,.reader-annotations").forEach((p) => p.style.display = "none");
  hideAnnoBar();
  closeAnnoEditor();
  if (!visible) existing.style.display = "block";
}
function closePanel() {
  layer.querySelectorAll(".reader-toc,.reader-bookmarks,.reader-settings,.reader-annotations").forEach((p) => p.style.display = "none");
}

// ============ 书签面板 ============
function toggleBookmarks() { openPanel("reader-bookmarks"); refreshBookmarkList(); }

function buildBookmarkPanel(content) {
  const panel = h("div", { class: "reader-bookmarks" });
  panel.style.display = "none";
  panel.appendChild(h("button", { class: "icon-btn", style: "margin-bottom:10px;", onclick: closePanel }, "←"));
  panel.appendChild(h("button", { class: "btn block", style: "margin-bottom:12px;", onclick: () => addBookmark() }, "＋ 添加当前位置书签"));
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

function currentPosition() {
  if (session.settings.mode === "scroll") {
    const content = layer.querySelector(".reader-content");
    const ci = content ? currentChapterIndex(content) : 0;
    return { ci, frac: content ? scrollFraction(content) : 0 };
  }
  const ci = session.pages.length ? session.pages[session.pageIndex].chapterIndex : 0;
  return { ci, frac: session.pages.length > 1 ? session.pageIndex / (session.pages.length - 1) : 0 };
}

async function addBookmark() {
  const { ci, frac } = currentPosition();
  const ch = session.book.chapters[ci];
  const title = (ch ? ch.title : "") || `第 ${ci + 1} 章`;
  const bm = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    bookId: session.book.id, chapterIndex: ci, fraction: frac, title, createdAt: Date.now(),
  };
  await db.put("bookmarks", bm);
  session.bookmarks.push(bm);
  toast("已添加书签");
  refreshBookmarkList();
}

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
  item._confirmTimer = setTimeout(() => refreshBookmarkList(), 4000);
}

async function doRemoveBookmark(item, bm) {
  clearTimeout(item._confirmTimer);
  await db.del("bookmarks", bm.id);
  session.bookmarks = session.bookmarks.filter((b) => b.id !== bm.id);
  toast("已删除书签");
  refreshBookmarkList();
}

function jumpToBookmark(bm) {
  if (session.settings.mode === "scroll") {
    const content = layer.querySelector(".reader-content");
    if (!content) return;
    const target = (bm.fraction || 0) * (content.scrollHeight - content.clientHeight);
    content.scrollTop = Math.max(0, target);
    return;
  }
  const idx = session.pages.findIndex((p) => p.chapterIndex === bm.chapterIndex);
  if (idx >= 0) turnToPage(idx);
}

// ============ 批注总览面板 ============
function toggleAnnotations() { openPanel("reader-annotations"); refreshAnnoList(); }

function buildAnnoPanel(content) {
  const panel = h("div", { class: "reader-annotations" });
  panel.style.display = "none";
  panel.appendChild(h("button", { class: "icon-btn", style: "margin-bottom:10px;", onclick: closePanel }, "←"));
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
      item.addEventListener("click", () => { openAnnoEditor(a); jumpToAnno(a); closePanel(); });
      list.appendChild(item);
    });
  });
}

function jumpToAnno(a) {
  if (session.settings.mode === "scroll") {
    const content = layer.querySelector(".reader-content");
    if (!content) return;
    const ch = content.querySelector(`.reader-chapter[data-chapter="${a.chapterIndex}"]`);
    if (!ch) return;
    const range = findTextRange(ch, a.selectedText);
    if (range) {
      const rect = range.getBoundingClientRect();
      const contentRect = content.getBoundingClientRect();
      const target = content.scrollTop + (rect.top - contentRect.top) - 60;
      content.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
      flashAnno(range);
    } else {
      ch.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    return;
  }
  // 分页模式：找包含批注文本的页
  let idx = session.pages.findIndex((p) => p.chapterIndex === a.chapterIndex && p.html.includes(a.selectedText));
  if (idx < 0) idx = session.pages.findIndex((p) => p.chapterIndex === a.chapterIndex);
  if (idx >= 0) { turnToPage(idx); setTimeout(() => flashPageAnno(a), 350); }
}

function flashPageAnno(a) {
  const cur = layer.querySelector(".page-cur");
  if (!cur) return;
  const range = findTextRange(cur, a.selectedText);
  if (range) flashAnno(range);
}

function findTextRange(root, target) {
  const t = (target || "").trim();
  if (!t) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let full = "";
  let node;
  while ((node = walker.nextNode())) { nodes.push(node); full += node.textContent; }
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

async function doRemoveAnno(a) {
  await db.del("annotations", a.id);
  session.annotations = session.annotations.filter((x) => x.id !== a.id);
  rerenderAnnotated();
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

// 批注增删改后重渲染（滚动保持位置；分页重分页跳到原章节）
function rerenderAnnotated() {
  const content = layer.querySelector(".reader-content") || layer.querySelector(".page-viewport");
  if (!content) return;
  const ci = session.settings.mode === "scroll" ? currentChapterIndex(content) : session.pages[session.pageIndex]?.chapterIndex || 0;
  const st = session.settings.mode === "scroll" ? content.scrollTop : 0;
  if (session.settings.mode === "scroll") {
    renderContent(content, session.book, session.annotations);
    applyContentStyle(content, session.settings);
    content.scrollTop = st;
  } else {
    session.pages = buildPages(session.settings);
    const idx = session.pages.findIndex((p) => p.chapterIndex === ci);
    turnToPage(idx >= 0 ? idx : session.pageIndex);
  }
}

// ============ 批注工具栏 ============
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
    const hlBtn = h("button", { class: "anno-type", title: "荧光笔" }, "");
    hlBtn.addEventListener("click", () => {
      annoBar.querySelectorAll(".anno-type").forEach((b) => b.classList.remove("on"));
      hlBtn.classList.add("on");
      annoBar.dataset.mode = "highlight";
    });
    hlBtn.classList.add("on");
    annoBar.dataset.mode = "highlight";
    const ulBtn = h("button", { class: "anno-type", title: "下划线" }, "U");
    ulBtn.addEventListener("click", () => {
      annoBar.querySelectorAll(".anno-type").forEach((b) => b.classList.remove("on"));
      ulBtn.classList.add("on");
      annoBar.dataset.mode = "underline";
    });
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
    const okBtn = h("button", { class: "anno-apply", onclick: () => applyAnnotationFromBar() }, "标注");
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

function hideAnnoBar() {
  if (annoBar) annoBar.style.display = "none";
}

async function applyAnnotationFromBar() {
  if (!annoBar) return;
  const text = annoBar.text;
  if (!text) return;
  const mode = annoBar.dataset.mode || "highlight";
  const color = annoBar.dataset.color || "#ffeb3b";
  const note = "";
  const ci = currentAnnoChapter();
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
  rerenderAnnotated();
  toast(mode === "highlight" ? "荧光笔标注" : "下划线标注");
}

function currentAnnoChapter() {
  if (session.settings.mode === "scroll") {
    const content = layer.querySelector(".reader-content");
    return content ? currentChapterIndex(content) : 0;
  }
  return session.pages[session.pageIndex]?.chapterIndex || 0;
}

// ============ 笔记编辑器（Jane Reader 风格底部弹窗）============
function openAnnoEditor(anno) {
  const isEdit = !!anno;
  const text = isEdit ? anno.selectedText : (annoBar && annoBar.text);
  if (!text) { toast("请先选中文字"); return; }
  closeAnnoEditor();
  const mode = isEdit ? anno.type : (annoBar.dataset.mode || "highlight");
  const color = isEdit ? anno.color : (annoBar.dataset.color || HL_COLORS[0].v);

  const mask = h("div", { class: "anno-editor-mask", onclick: closeAnnoEditor });
  const sheet = h("div", { class: "anno-editor" });
  sheet.dataset.mode = mode;
  sheet.dataset.color = color;

  sheet.appendChild(h("div", { class: "ae-head" },
    h("div", { class: "ae-title" }, isEdit ? "批注详情" : "笔记"),
    h("button", { class: "icon-btn", style: "width:30px;height:30px;", onclick: closeAnnoEditor }, "✕")
  ));
  sheet.appendChild(h("div", { class: "ae-quote" },
    h("div", { class: "ae-label" }, "引用"),
    h("div", { class: "ae-quote-text" }, text)
  ));

  const typeSeg = h("div", { class: "seg" }, segBtn("highlight", "荧光笔"), segBtn("underline", "下划线"));
  sheet.appendChild(h("div", { class: "ae-label" }, "标注类型"));
  sheet.appendChild(typeSeg);

  const colorsRow = h("div", { class: "anno-colors", style: "margin-top:8px;" });
  HL_COLORS.forEach((c) => {
    const dot = h("span", { class: "anno-color" + (c.v === color ? " on" : ""), style: `background:${c.v}`, title: c.n });
    dot.addEventListener("click", () => {
      colorsRow.querySelectorAll(".anno-color").forEach((d) => d.classList.remove("on"));
      dot.classList.add("on");
      sheet.dataset.color = c.v;
    });
    colorsRow.appendChild(dot);
  });
  sheet.appendChild(colorsRow);

  sheet.appendChild(h("div", { class: "ae-label", style: "margin-top:14px;" }, "我的笔记"));
  const note = h("textarea", { class: "ae-note", placeholder: "写下你的想法…", rows: 4 });
  if (isEdit && anno.note) note.value = anno.note;
  sheet.appendChild(note);

  const btns = h("div", { class: "row", style: "gap:10px;margin-top:14px;" },
    isEdit ? h("button", { class: "btn danger", style: "flex:1", onclick: () => delAnnoFromEditor(anno) }, "删除") : null,
    h("button", { class: "btn ghost", style: "flex:1", onclick: closeAnnoEditor }, "取消"),
    h("button", { class: "btn", style: "flex:1", onclick: () => saveAnnoFromEditor(anno) }, "保存")
  );
  sheet.appendChild(btns);

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

async function saveAnnoFromEditor(targetAnno) {
  const sheet = layer.querySelector(".anno-editor");
  if (!sheet) return;
  const mode = sheet.dataset.mode || "highlight";
  const color = sheet.dataset.color || HL_COLORS[0].v;
  const note = (sheet.querySelector(".ae-note")?.value || "").trim();

  if (targetAnno) {
    targetAnno.type = mode;
    targetAnno.color = color;
    targetAnno.note = note;
    await db.put("annotations", targetAnno);
    closeAnnoEditor();
    rerenderAnnotated();
    toast("批注已更新");
    return;
  }
  const text = annoBar ? annoBar.text : "";
  if (!text) { toast("未选中文字"); closeAnnoEditor(); return; }
  const ci = currentAnnoChapter();
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
  rerenderAnnotated();
  toast(note ? "已保存批注笔记" : "已保存批注");
}

async function delAnnoFromEditor(anno) {
  await db.del("annotations", anno.id);
  session.annotations = session.annotations.filter((x) => x.id !== anno.id);
  closeAnnoEditor();
  rerenderAnnotated();
  toast("已删除批注");
  refreshAnnoList();
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

  const themeSeg = h("div", { class: "seg" }, themeBtn("day", "日用"), themeBtn("sepia", "护眼"), themeBtn("night", "夜间"));
  const marginSeg = h("div", { class: "seg" }, marginBtn("narrow", "窄"), marginBtn("normal", "标准"), marginBtn("wide", "宽"));
  const modeSeg = h("div", { class: "seg" }, modeBtn("scroll", "滚动"), modeBtn("cover", "切换"));

  panel.appendChild(h("div", { class: "rs-block" }, h("div", { class: "rs-label" }, "字号"), h("div", { class: "rs-row" }, fontMinus, fontVal, fontPlus)));
  panel.appendChild(h("div", { class: "rs-block" }, h("div", { class: "rs-label" }, "行距"), h("div", { class: "rs-row" }, lineMinus, lineVal, linePlus)));
  panel.appendChild(h("div", { class: "rs-block" }, h("div", { class: "rs-label" }, "翻页方式"), modeSeg));
  panel.appendChild(h("div", { class: "rs-block" }, h("div", { class: "rs-label" }, "主题"), themeSeg));
  panel.appendChild(h("div", { class: "rs-block" }, h("div", { class: "rs-label" }, "边距"), marginSeg));
  panel.appendChild(h("button", { class: "btn block", style: "margin-top:6px;", onclick: () => { panel.style.display = "none"; } }, "完成"));

  function changeFont(d) {
    session.settings.font = Math.max(13, Math.min(28, session.settings.font + d));
    fontVal.textContent = session.settings.font + "px";
    applyAndRebuild();
    db.setSetting("readerFont", session.settings.font);
  }
  function changeLine(d) {
    session.settings.line = Math.max(1.3, Math.min(2.2, Math.round((session.settings.line + d) * 10) / 10));
    lineVal.textContent = session.settings.line.toFixed(1);
    applyAndRebuild();
    db.setSetting("readerLine", session.settings.line);
  }
  function modeBtn(v, label) {
    const b = h("button", { class: session.settings.mode === v ? "on" : "", onclick: () => {
      if (session.settings.mode === v) return;
      session.settings.mode = v;
      [...modeSeg.children].forEach((c) => c.classList.toggle("on", c === b));
      db.setSetting("readerMode", v);
      switchMode();
    } }, label);
    return b;
  }
  function themeBtn(v, label) {
    const b = h("button", { class: session.settings.theme === v ? "on" : "", onclick: () => {
      session.settings.theme = v;
      [...themeSeg.children].forEach((c) => c.classList.toggle("on", c === b));
      applyAndRebuild();
      db.setSetting("readerTheme", v);
    } }, label);
    return b;
  }
  function marginBtn(v, label) {
    const b = h("button", { class: session.settings.margin === v ? "on" : "", onclick: () => {
      session.settings.margin = v;
      [...marginSeg.children].forEach((c) => c.classList.toggle("on", c === b));
      applyAndRebuild();
      db.setSetting("readerMargin", v);
    } }, label);
    return b;
  }
  return panel;
}

// 字号/行距/主题/边距变化后的重建（滚动=应用样式；分页=重新分页）
function applyAndRebuild() {
  if (session.settings.mode === "scroll") {
    const content = layer.querySelector(".reader-content");
    if (content) { applyContentStyle(content, session.settings); }
    return;
  }
  const ci = session.pages[session.pageIndex]?.chapterIndex || 0;
  session.pages = buildPages(session.settings);
  const vp = layer.querySelector(".page-viewport");
  if (vp) {
    vp.style.fontSize = session.settings.font + "px";
    vp.style.lineHeight = session.settings.line;
    vp.className = "page-viewport r-theme-" + session.settings.theme;
  }
  const idx = session.pages.findIndex((p) => p.chapterIndex === ci);
  turnToPage(idx >= 0 ? idx : session.pageIndex);
}

// 翻页方式切换（滚动↔分页）
function switchMode() {
  const oldMode = session.settings.mode === "scroll" ? "scroll" : "page";
  const ci = session.pages.length ? session.pages[session.pageIndex]?.chapterIndex || 0 : 0;
  const frac = session.book.progress || 0;
  const oldContent = layer.querySelector(".reader-content");
  const oldVp = layer.querySelector(".page-viewport");
  const newContent = buildContentArea(session.settings);
  if (oldContent) oldContent.remove();
  if (oldVp) oldVp.remove();
  // 重新绑定事件到新内容区
  bindContentEvents(newContent);
  // 插入到 bottom 之前
  layer.insertBefore(newContent, layer.querySelector(".reader-bottom"));
  requestAnimationFrame(() => {
    if (session.settings.mode === "scroll") {
      renderContent(newContent, session.book, session.annotations);
      applyContentStyle(newContent, session.settings);
      const target = frac * (newContent.scrollHeight - newContent.clientHeight);
      newContent.scrollTop = Math.max(0, target || 0);
    } else {
      session.pages = buildPages(session.settings);
      if (!session.pages.length) session.pages = [{ chapterIndex: 0, html: "<p>（空书）</p>" }];
      session.pageIndex = Math.max(0, Math.min(session.pages.length - 1,
        Math.round(frac * (session.pages.length - 1))));
      renderPage(session.pageIndex);
      // 尝试落到原章节
      const idx = session.pages.findIndex((p) => p.chapterIndex === ci);
      if (idx >= 0) { session.pageIndex = idx; renderPage(idx); }
    }
    updateAfterTurn();
  });
}

function bindContentEvents(content) {
  content.addEventListener("click", onContentClick);
  content.addEventListener("contextmenu", (e) => {
    if (hasActiveSelection()) { e.preventDefault(); checkSelection(); }
  });
  content.addEventListener("touchstart", (e) => { session.touchX = e.touches[0].clientX; }, { passive: true });
  content.addEventListener("touchend", (e) => {
    if (session.settings.mode === "scroll") return;
    const dx = e.changedTouches[0].clientX - session.touchX;
    if (Math.abs(dx) > 50) turnPage(dx < 0 ? 1 : -1);
  }, { passive: true });
  if (session.settings.mode === "scroll") {
    content.addEventListener("scroll", () => {
      if (session.raf) return;
      session.raf = requestAnimationFrame(() => {
        session.raf = 0;
        const frac = content.scrollHeight > content.clientHeight
          ? content.scrollTop / (content.scrollHeight - content.clientHeight) : 1;
        session.book.progress = Math.max(0, Math.min(1, frac));
        const p = layer.querySelector(".reader-prog-text");
        if (p) p.textContent = Math.round(session.book.progress * 100) + "%";
        updateChapterName(content, layer.querySelector(".reader-chap"));
      });
    }, { passive: true });
  }
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
  if (!el) return;
  const heads = [...content.querySelectorAll(".r-ch")];
  if (!heads.length) { el.textContent = ""; return; }
  const top = content.scrollTop + 20;
  let name = "";
  for (const hd of heads) { if (hd.offsetTop <= top) name = hd.textContent; else break; }
  if (!name && heads[0]) name = heads[0].textContent;
  el.textContent = name;
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
  if (session === null && !layer) return; // 幂等：已关闭过
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
  window.__readerOpen = false;
  const st = window.history.state && window.history.state.view;
  if (st === "__reader") {
    // 顶栏 ← / 程序关闭：回退历史，popstate 会 route 回书库
    try { history.back(); } catch (e) { if (window.__route) window.__route("reader"); }
  } else {
    // Android 返回键场景：popstate 已把 __reader 弹出，直接回书库
    if (window.__route) window.__route("reader");
  }
}

// ============ PDF 预览 ============
async function openPdf(book) {
  document.body.classList.add("reading");
  try { history.pushState({ view: "__reader" }, ""); } catch (e) {}
  window.__readerOpen = true;
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
    window.__readerOpen = false;
    const st = window.history.state && window.history.state.view;
    if (st === "__reader") { try { history.back(); } catch (e) { if (window.__route) window.__route("reader"); } }
    else if (window.__route) window.__route("reader");
  };
}
function closePdf() { if (window.__pdfClose) window.__pdfClose(); }

window.__openBook = openBook;
window.__closeReader = closeReader;
