// 通用工具函数
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function escapeHtml(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// 把纯文本里的链接变成可点击的 <a>
export function linkify(s = "") {
  const esc = escapeHtml(s);
  return esc.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
}

export function fmtDate(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function fmtDateTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${fmtDate(ts)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fromNow(ts) {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return fmtDate(ts);
}

// 简单的 DOM 构建器
export function h(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") e.className = v;
    else if (k === "html") e.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(e.dataset, v);
    else if (v !== null && v !== undefined) e.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return e;
}

let toastTimer = null;
export function toast(msg) {
  const t = $("#toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 1800);
}

// 弹出一个底部抽屉式 modal，content 是一个 DOM 节点
export function openModal(title, contentNode, opts = {}) {
  const root = $("#modalRoot");
  root.innerHTML = "";
  const mask = h("div", { class: "modal-mask" });
  const modal = h("div", { class: "modal" }, h("h3", {}, title), contentNode);
  mask.appendChild(modal);
  mask.addEventListener("click", (e) => {
    if (e.target === mask && !opts.noClose) closeModal();
  });
  root.appendChild(mask);
  return { close: closeModal };
}
export function closeModal() {
  const root = $("#modalRoot");
  root.innerHTML = "";
}

export function confirmDialog(msg) {
  return new Promise((resolve) => {
    const box = h("div", {}, h("p", { class: "muted" }, msg));
    const actions = h(
      "div",
      { class: "row", style: "margin-top:14px; gap:10px;" },
      h("button", { class: "btn ghost", style: "flex:1", onclick: () => { closeModal(); resolve(false); } }, "取消"),
      h("button", { class: "btn danger", style: "flex:1", onclick: () => { closeModal(); resolve(true); } }, "确定")
    );
    box.appendChild(actions);
    openModal("请确认", box);
  });
}
