// EPUB / FB2 解析：把电子书转成统一的 { title, author, chapters:[{title, html}] }
// 全部基于浏览器原生 API（DOMParser / DecompressionStream），无第三方依赖，离线可用。
import { unzip } from "./zip.js";
import { escapeHtml } from "./util.js";

// ---------------- EPUB ----------------
export async function parseEpub(buf) {
  const zip = await unzip(buf);
  const container = zip.get("META-INF/container.xml".toLowerCase());
  if (!container) throw new Error("EPUB 缺少 container.xml");
  const xml = new TextDecoder("utf-8").decode(container);
  const opfPath = /full-path=["']([^"']+)["']/.exec(xml)?.[1];
  if (!opfPath) throw new Error("找不到 OPF 路径");
  const opfBytes = zip.get(normalize(opfPath).toLowerCase());
  if (!opfBytes) throw new Error("找不到 OPF 文件");
  const opf = new DOMParser().parseFromString(new TextDecoder("utf-8").decode(opfBytes), "application/xml");
  const dir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";

  const title = textOf(opf, "title") || "未命名书籍";
  const author = textOf(opf, "creator") || "未知作者";

  const manifest = {};
  opf.querySelectorAll("manifest > item").forEach((it) => {
    const entry = {
      href: it.getAttribute("href"),
      type: (it.getAttribute("media-type") || "").toLowerCase(),
    };
    const id = it.getAttribute("id");
    manifest[id] = entry;
    manifest[id.toLowerCase()] = entry; // spine 的 idref 大小写偶发不一致时也能命中
  });
  const order = [...opf.querySelectorAll("spine > itemref")].map((r) => r.getAttribute("idref"));

  const chapters = [];
  for (const id of order) {
    const m = manifest[id];
    if (!m) continue;
    let type = m.type;
    if (!type) {
      // OPF 未声明 media-type 时按扩展名推断
      const ext = (m.href.split(".").pop() || "").toLowerCase();
      type = ({ xhtml: "application/xhtml+xml", html: "text/html", htm: "text/html", xml: "application/xml" })[ext] || "";
    }
    if (!/xhtml|html|svg|xml/.test(type)) continue; // 跳过图片 / css / 字体
    const href = m.href || "";
    // 以 / 开头的 href 视为相对 zip 根（部分导出工具会这么写），否则相对 OPF 所在目录
    const path = href.startsWith("/") ? normalize(href.slice(1)) : normalize(dir + href);
    const data = zip.get(path.toLowerCase());
    if (!data) continue;
    // 用 text/html 解析：浏览器/WebView 的 HTML 解析器容错极强（HTML 实体、未闭合标签均不会失败），
    // 而 application/xhtml+xml 严格 XML 模式遇到 &nbsp; 等未定义实体会返回 parsererror 导致正文丢失。
    const doc = new DOMParser().parseFromString(new TextDecoder("utf-8").decode(data), "text/html");
    const body = doc.body || doc.documentElement;
    const { title: ctitle, html } = extractHtml(body);
    chapters.push({ title: ctitle || `第 ${chapters.length + 1} 节`, html });
  }
  if (!chapters.length) throw new Error("EPUB 未解析出正文");
  return { title, author, chapters };
}

// ---------------- FB2 ----------------
export async function parseFb2(buf) {
  const xml = new TextDecoder("utf-8").decode(new Uint8Array(buf));
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const title = textOf(doc, "book-title") || "未命名书籍";
  const first = textOf(doc, "first-name");
  const last = textOf(doc, "last-name");
  const nick = textOf(doc, "nickname");
  const author = (first || last ? (first + " " + last).trim() : nick) || "未知作者";

  const chapters = [];
  const sections = doc.querySelectorAll("body > section");
  const list = sections.length ? sections : doc.querySelectorAll("body > section > section");
  (list.length ? list : [doc.querySelector("body")]).forEach((sec, i) => {
    if (!sec) return;
    const tEl = sec.querySelector(":scope > title");
    const ctitle = (tEl ? tEl.textContent : "").replace(/\s+/g, " ").trim() || `第 ${i + 1} 节`;
    const html = extractFb2(sec, !!tEl);
    if (html) chapters.push({ title: ctitle, html });
  });
  if (!chapters.length) {
    const html = extractFb2(doc.querySelector("body"), false);
    if (html) chapters.push({ title: "正文", html });
  }
  return { title, author, chapters };
}

// ---------------- 通用提取 ----------------
function extractHtml(body) {
  let title = "";
  const heading = body.querySelector("h1,h2,h3,h4,h5,h6");
  if (heading) title = heading.textContent.replace(/\s+/g, " ").trim();
  const paras = [];
  body.querySelectorAll("p, li, blockquote, h1, h2, h3, h4, h5, h6").forEach((el) => {
    const t = el.textContent.replace(/\s+/g, " ").trim();
    if (t) paras.push(escapeHtml(t));
  });
  if (!paras.length) {
    const t = body.textContent.replace(/\s+/g, " ").trim();
    if (t) paras.push(escapeHtml(t));
  }
  const html = `<h2 class="r-ch">${escapeHtml(title)}</h2>` + paras.map((p) => `<p>${p}</p>`).join("");
  return { title, html };
}

function extractFb2(sec, hasTitleTag) {
  const paras = [];
  const nodes = sec.querySelectorAll("p, subtitle, text-author, cite, th, td");
  nodes.forEach((el) => {
    const t = el.textContent.replace(/\s+/g, " ").trim();
    if (t) paras.push(escapeHtml(t));
  });
  if (!paras.length) {
    const t = sec.textContent.replace(/\s+/g, " ").trim();
    if (t) paras.push(escapeHtml(t));
  }
  return paras.map((p) => `<p>${p}</p>`).join("");
}

function textOf(doc, tag) {
  const el = doc.querySelector(tag);
  return el ? el.textContent.trim() : "";
}

function normalize(p) {
  const parts = p.replace(/\\/g, "/").split("/");
  const stack = [];
  for (const s of parts) {
    if (s === "..") stack.pop();
    else if (s && s !== ".") stack.push(s);
  }
  return stack.join("/");
}
