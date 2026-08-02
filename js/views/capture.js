// 速记捕获模块：快速记录灵感，支持文字 / 链接 / 图片 / 语音，可转任务或笔记
import { db, uid } from "../db.js";
import { h, escapeHtml, linkify, fromNow, toast, openModal, closeModal, confirmDialog } from "../util.js";

let type = "text";
let recorder = null;
let recording = false;

function blobToDataURL(blob) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = rej;
    fr.readAsDataURL(blob);
  });
}

function fileToDataURL(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = rej;
    fr.readAsDataURL(file);
  });
}

export async function renderCapture(root) {
  root.innerHTML = "";

  const ta = h("textarea", { class: "textarea", placeholder: "随手记点什么…（链接会自动识别）", style: "min-height:70px;" });
  const fileInput = h("input", { type: "file", accept: "image/*", capture: "environment", style: "display:none;" });
  const recBtn = h("button", { class: "btn ghost", style: "display:none;" }, "🎙️ 开始录音");

  const typeRow = h(
    "div",
    { class: "row", style: "gap:8px; margin-bottom:10px; flex-wrap:wrap;" },
    ...[
      ["text", "文字"],
      ["link", "链接"],
      ["image", "图片"],
      ["voice", "语音"],
    ].map(([v, label]) =>
      h(
        "button",
        {
          class: "chip",
          style: type === v ? "background:var(--primary);color:#fff;" : "cursor:pointer;",
          onclick: () => {
            type = v;
            syncType();
            [...typeRow.children].forEach((c, i) => {
              const vv = ["text", "link", "image", "voice"][i];
              c.style.background = vv === type ? "var(--primary)" : "";
              c.style.color = vv === type ? "#fff" : "";
            });
          },
        },
        label
      )
    )
  );

  const saveBtn = h("button", { class: "btn block", onclick: saveText }, "保存速记");

  const box = h(
    "div",
    { class: "card" },
    typeRow,
    h("div", { id: "captureInputWrap" }, ta, fileInput, recBtn),
    h("div", { style: "margin-top:10px;" }, saveBtn)
  );
  root.appendChild(box);

  // 列表
  const list = h("div", {});
  root.appendChild(list);

  function syncType() {
    ta.style.display = type === "text" || type === "link" ? "" : "none";
    fileInput.style.display = type === "image" ? "" : "none";
    recBtn.style.display = type === "voice" ? "" : "none";
    if (type === "link") ta.placeholder = "粘贴一个链接…";
    else ta.placeholder = "随手记点什么…（链接会自动识别）";
  }

  async function saveText() {
    const text = ta.value.trim();
    if (!text) return toast("写点东西吧");
    const t = type === "link" || /^https?:\/\//.test(text) ? "link" : "text";
    await db.put("captures", { id: uid(), type: t, text, createdAt: Date.now(), tags: [] });
    ta.value = "";
    toast("已保存");
    window.__rerender();
  }

  fileInput.addEventListener("change", async () => {
    const f = fileInput.files[0];
    if (!f) return;
    const src = await fileToDataURL(f);
    await db.put("captures", { id: uid(), type: "image", text: "", src, createdAt: Date.now(), tags: [] });
    fileInput.value = "";
    toast("已保存图片");
    window.__rerender();
  });

  recBtn.addEventListener("click", async () => {
    if (!recording) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        recorder = new MediaRecorder(stream);
        const chunks = [];
        recorder.ondataavailable = (e) => chunks.push(e.data);
        recorder.onstop = async () => {
          const blob = new Blob(chunks, { type: "audio/webm" });
          const src = await blobToDataURL(blob);
          await db.put("captures", { id: uid(), type: "voice", text: "语音备忘", src, createdAt: Date.now(), tags: [] });
          stream.getTracks().forEach((t) => t.stop());
          window.__rerender();
          toast("已保存语音");
        };
        recorder.start();
        recording = true;
        recBtn.textContent = "⏹ 停止";
        recBtn.classList.add("danger");
      } catch (e) {
        toast("无法录音：" + (e.message || e.name));
      }
    } else {
      recorder && recorder.stop();
      recording = false;
      recBtn.textContent = "🎙️ 开始录音";
      recBtn.classList.remove("danger");
    }
  });

  syncType();

  // 渲染列表
  let items = await db.getAll("captures");
  items.sort((a, b) => b.createdAt - a.createdAt);
  if (!items.length) {
    list.appendChild(h("div", { class: "center-empty" }, "还没有速记，上面的输入框随时记一句"));
  }
  for (const c of items) list.appendChild(capCard(c));

  function capCard(c) {
    const ico = { text: "📝", link: "🔗", image: "🖼️", voice: "🎙️" }[c.type] || "📝";
    const head = h("div", { class: "row spread" }, h("b", {}, ico + " " + ({ text: "文字", link: "链接", image: "图片", voice: "语音" }[c.type] || "")), h("span", { class: "muted" }, fromNow(c.createdAt)));

    let media = null;
    if (c.type === "image" && c.src) media = h("img", { class: "thumb", src: c.src, style: "width:100%;height:160px;margin-top:8px;" });
    else if (c.type === "voice" && c.src) {
      media = h("audio", { controls: "", src: c.src, style: "width:100%;margin-top:8px;" });
    } else if (c.text) {
      const isLink = c.type === "link";
      media = h("div", { class: "item-sub", style: "margin-top:6px; word-break:break-word;", html: isLink ? linkify(c.text) : escapeHtml(c.text) });
    }

    const actions = h(
      "div",
      { class: "row", style: "gap:8px; margin-top:10px;" },
      h("button", { class: "btn ghost", style: "flex:1; font-size:13px;", onclick: async () => {
          await db.put("tasks", { id: uid(), title: c.text || "来自速记", note: c.text || "", done: false, priority: "mid", due: null, list: "", createdAt: Date.now() });
          toast("已转为任务");
        } }, "转任务"),
      h("button", { class: "btn ghost", style: "flex:1; font-size:13px;", onclick: async () => {
          await db.put("notes", { id: uid(), title: (c.text || "速记").slice(0, 30), body: c.text || "", createdAt: Date.now(), updatedAt: Date.now(), tags: [], pinned: false });
          toast("已转为笔记");
        } }, "转笔记"),
      h("button", { class: "btn ghost", style: "flex:1; font-size:13px;", onclick: async () => {
          if (await confirmDialog("删除这条速记？")) { await db.del("captures", c.id); window.__rerender(); }
        } }, "删除")
    );

    return h("div", { class: "card" }, head, media, actions);
  }
}
