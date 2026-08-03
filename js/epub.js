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
  // 收集图片 → data:URI，供章节 HTML 内联替换 img src
  const imageMap = {};
  for (const [id, entry] of Object.entries(manifest)) {
    if (!/^image\//.test(entry.type)) continue;
    const imgPath = normalize(dir + entry.href).toLowerCase();
    const imgData = zip.get(imgPath);
    if (!imgData) continue;
    const b64 = uint8ToBase64(imgData);
    const uri = `data:${entry.type};base64,${b64}`;
    imageMap[imgPath] = uri;
    imageMap[entry.href.toLowerCase()] = uri; // 也存 href 原文（相对路径查找备用）
  }

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
    const { title: ctitle, html } = preserveHtml(body, imageMap, dir);
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

// ---------------- HTML 保留（保留图片和富文本格式）----------------
function preserveHtml(body, imageMap, dir) {
  let title = "";
  // 标记第一个标题供目录/导航使用
  const heading = body.querySelector("h1,h2,h3,h4,h5,h6");
  if (heading) {
    title = heading.textContent.replace(/\s+/g, " ").trim();
    heading.classList.add("r-ch");
  }

  // 保留完整 innerHTML（图片、粗体、斜体、链接等），只清理脚本和替换图片路径
  let html = body.innerHTML || "";
  // 去掉 script / iframe / object / embed
  html = html.replace(/<(script|iframe|object|embed)\b[\s\S]*?<\/\1>/gi, "");
  // 替换 img src 为内联 data:URI（显示 EPUB 内图片）
  html = html.replace(/<img\s[^>]*src\s*=\s*["']([^"']+)["'][^>]*>/gi, (full, src) => {
    const imgPath = normalize(dir + src).toLowerCase();
    const uri = imageMap[imgPath] || imageMap[src.toLowerCase()];
    if (uri) return full.replace(src, uri);
    // 文件名尾匹配备用
    const fn = (src.split("/").pop() || "").toLowerCase();
    for (const [k, v] of Object.entries(imageMap)) {
      if (k.endsWith("/" + fn)) return full.replace(src, v);
    }
    return full; // 找不到则保留原样（外部图片等）
  });
  // 若内文完全无标题，兜底一个
  if (!title) {
    const anyH = body.querySelector("h1,h2,h3,h4,h5,h6");
    if (anyH) title = anyH.textContent.replace(/\s+/g, " ").trim();
  }
  return { title, html };
}

function uint8ToBase64(u8) {
  let binary = "";
  const len = u8.length;
  for (let i = 0; i < len; i++) binary += String.fromCharCode(u8[i]);
  return btoa(binary);
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
