// 阅读器：全屏阅读界面。连续滚动 + 点击分区翻页；字号 / 行距 / 主题(日用·护眼·夜间) / 边距 可调并持久化；
// 阅读计时（总时长 + 分书时长）写入 readingLog；进度自动保存。PDF 走内嵌预览。
import { db } from "../db.js";
import { h, toast, openModal, closeModal } from "../util.js";

let layer = null;     // 阅读器全屏层
let session = null;   // 当前阅读会话状态

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

export async function openBook(id) {
  const book = await db.get("books", id);
  if (!book) return toast("图书不存在");
  if (book.format === "pdf") return openPdf(book);

  const s = await getReaderSettings();
  document.body.classList.add("reading");
  session = { book, settings: s, lastFlush: Date.now(), acc: 0, raf: 0 };

  const top = h("div", { class: "reader-top" },
    h("button", { class: "icon-btn", onclick: closeReader }, "←"),
    h("div", { class: "reader-title" }, book.title || "未命名"),
    h("button", { class: "icon-btn", onclick: () => openReaderSettings() }, "Aa")
  );

  const content = h("div", {});
  content.innerHTML = book.chapters.map((c) => c.html).join("");
  applyContentStyle(content, s);

  const progText = h("div", { class: "reader-prog-text" }, Math.round((book.progress || 0) * 100) + "%");
  const chapText = h("div", { class: "reader-chap" }, "");
  const bottom = h("div", { class: "reader-bottom" },
    h("button", { class: "reader-nav", onclick: () => gotoChapter(content, -1) }, "‹ 上一章"),
    h("div", { class: "reader-center" }, chapText, progText),
    h("button", { class: "reader-nav", onclick: () => gotoChapter(content, 1) }, "下一章 ›")
  );

  // 点击分区翻页
  content.addEventListener("click", (e) => {
    if (session.uiHidden) { toggleUI(true); return; }
    const y = e.clientY;
    const h2 = window.innerHeight / 2;
    if (y < h2 * 0.62) content.scrollBy({ top: -window.innerHeight * 0.9, behavior: "smooth" });
    else if (y > h2 * 1.38) content.scrollBy({ top: window.innerHeight * 0.9, behavior: "smooth" });
    else toggleUI();
  });

  // 滚动：更新进度 + 章节名
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

  layer = h("div", { class: "reader-layer" }, top, content, bottom, buildSettingsPanel(content));
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

function onVisibility() {
  if (document.hidden) flush();
}

function updateChapterName(content, el) {
  const heads = [...content.querySelectorAll(".r-ch")];
  const top = content.scrollTop + 20;
  let name = "";
  for (const hd of heads) { if (hd.offsetTop <= top) name = hd.textContent; else break; }
  if (!name && heads[0]) name = heads[0].textContent;
  el.textContent = name;
}

function gotoChapter(content, dir) {
  const heads = [...content.querySelectorAll(".r-ch")];
  if (!heads.length) return;
  const top = content.scrollTop;
  if (dir > 0) {
    const next = heads.find((hd) => hd.offsetTop > top + 5);
    if (next) content.scrollTo({ top: next.offsetTop - 8, behavior: "smooth" });
    else content.scrollTo({ top: content.scrollHeight, behavior: "smooth" });
  } else {
    const prevs = heads.filter((hd) => hd.offsetTop < top - 5);
    const t = prevs.length ? prevs[prevs.length - 1].offsetTop - 8 : 0;
    content.scrollTo({ top: Math.max(0, t), behavior: "smooth" });
  }
}

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
    themeBtn("day", "日用"), themeBtn("sepia", "护眼"), themeBtn("night", "夜间")
  );
  const marginSeg = h("div", { class: "seg" },
    marginBtn("narrow", "窄"), marginBtn("normal", "标准"), marginBtn("wide", "宽")
  );

  panel.appendChild(h("div", { class: "rs-block" },
    h("div", { class: "rs-label" }, "字号"), h("div", { class: "rs-row" }, fontMinus, fontVal, fontPlus)
  ));
  panel.appendChild(h("div", { class: "rs-block" },
    h("div", { class: "rs-label" }, "行距"), h("div", { class: "rs-row" }, lineMinus, lineVal, linePlus)
  ));
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

function openReaderSettings() {
  const panel = layer.querySelector(".reader-settings");
  if (panel) panel.style.display = panel.style.display === "none" ? "block" : "none";
}

function toggleUI(forceShow) {
  if (!session) return;
  session.uiHidden = forceShow ? false : !session.uiHidden;
  if (layer) layer.classList.toggle("ui-hidden", session.uiHidden);
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

function closeReader() {
  flush();
  if (session && session.flushTimer) clearInterval(session.flushTimer);
  document.removeEventListener("visibilitychange", onVisibility);
  window.removeEventListener("beforeunload", flush);
  if (layer) { layer.remove(); layer = null; }
  document.body.classList.remove("reading");
  session = null;
  // 回到书库刷新进度
  if (window.__route) window.__route("reader");
}

// ---------------- PDF 预览 ----------------
async function openPdf(book) {
  document.body.classList.add("reading");
  const blob = new Blob([book.raw], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const top = h("div", { class: "reader-top" },
    h("button", { class: "icon-btn", onclick: closePdf }, "←"),
    h("div", { class: "reader-title" }, book.title || "PDF"),
    h("div", { class: "icon-btn" })
  );
  const frame = h("iframe", { class: "reader-pdf", src: url });
  const layer2 = h("div", { class: "reader-layer" }, top, frame);
  document.body.appendChild(layer2);
  // 简单计时
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

// 供书库通过 window.__openBook(id) 打开
window.__openBook = openBook;
