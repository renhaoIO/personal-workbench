// 设置模块：主题、分类、数据导出 / 导入、清空
import { db } from "../db.js";
import { h, toast, openModal, closeModal, confirmDialog } from "../util.js";
import { openCategoryManager } from "./categories.js";
import { APP_VERSION, BUILD } from "../version.js";

function download(filename, text) {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function openSettings() {
  const theme = document.documentElement.getAttribute("data-theme") || "light";
  const accent = (await db.getSetting("accent")) || "auto";

  const MODES = [
    { key: "light", ico: "☀️", name: "白天" },
    { key: "dark", ico: "🌙", name: "黑夜" },
    { key: "gray", ico: "🌫️", name: "灰色" },
    { key: "eink", ico: "📄", name: "墨水屏" },
  ];
  const ACCENTS = [
    { key: "auto", c: null, name: "跟随主题" },
    { key: "blue", c: "#3b6ef5", name: "晴蓝（白天）" },
    { key: "amber", c: "#f5a623", name: "琥珀金（黑夜）" },
    { key: "clay", c: "#bd7b46", name: "暖陶（灰色）" },
    { key: "indigo", c: "#6c63ff", name: "靛蓝" },
    { key: "violet", c: "#9b5de5", name: "紫罗兰" },
    { key: "teal", c: "#10b3a3", name: "青碧" },
    { key: "cyan", c: "#33b1cf", name: "湖蓝" },
    { key: "green", c: "#22b07d", name: "松绿" },
    { key: "gold", c: "#e8b84d", name: "柔金" },
    { key: "orange", c: "#f5772e", name: "暖橙" },
    { key: "pink", c: "#ec5a8d", name: "玫粉" },
    { key: "red", c: "#ef4d56", name: "朱红" },
    { key: "sky", c: "#6ea8ff", name: "天蓝（备选）" },
  ];

  // 外观模式
  const themeGrid = h("div", { class: "theme-grid" });
  MODES.forEach((m) => {
    const opt = h("div", { class: "theme-opt" + (theme === m.key ? " on" : ""), onclick: () => {
      document.documentElement.setAttribute("data-theme", m.key);
      db.setSetting("theme", m.key);
      [...themeGrid.children].forEach((c) => c.classList.remove("on"));
      opt.classList.add("on");
      window.__applyTheme && window.__applyTheme();
    } },
      h("span", { class: "to-ico" }, m.ico),
      h("span", { class: "to-name" }, m.name)
    );
    themeGrid.appendChild(opt);
  });

  // 预设配色（强调色）
  const accentRow = h("div", { class: "accent-row" });
  ACCENTS.forEach((a) => {
    let style, content = null;
    if (a.key === "auto") {
      style = "background:linear-gradient(135deg,#3b6ef5,#22b07d,#f5a623,#ef4d56);color:#fff;display:grid;place-items:center;font-size:13px;font-weight:800;";
      content = "A";
    } else {
      style = `background:${a.c}`;
    }
    const dot = h("div", {
      class: "accent-dot" + (accent === a.key ? " on" : ""),
      style, title: a.name || a.key,
      onclick: () => {
        if (a.key === "auto") document.documentElement.removeAttribute("data-accent");
        else document.documentElement.setAttribute("data-accent", a.key);
        db.setSetting("accent", a.key);
        [...accentRow.children].forEach((c) => c.classList.remove("on"));
        dot.classList.add("on");
        window.__applyTheme && window.__applyTheme();
      }
    }, content);
    accentRow.appendChild(dot);
  });

  const fileInput = h("input", { type: "file", accept: "application/json", style: "display:none;" });
  fileInput.addEventListener("change", async () => {
    const f = fileInput.files[0];
    if (!f) return;
    try {
      const text = await f.text();
      const obj = JSON.parse(text);
      const mode = (await confirmDialog("替换全部数据，还是合并？点「确定」=替换，点「取消」=合并"))
        ? "replace"
        : "merge";
      await db.importAll(obj, { mode });
      toast("导入完成");
      closeModal();
      window.__rerender();
    } catch (e) {
      toast("导入失败：" + (e.message || e));
    }
  });

  const reminderOn = await db.getSetting("reminderOn", false);
  const remSwitch = h("button", {
    class: "btn" + (reminderOn ? "" : " ghost"),
    style: "flex:1;",
    onclick: async () => {
      let on = !(await db.getSetting("reminderOn", false));
      if (on && "Notification" in window && Notification.permission === "default") {
        try { await Notification.requestPermission(); } catch (e) {}
      }
      await db.setSetting("reminderOn", on);
      remSwitch.textContent = on ? "已开启" : "未开启";
      remSwitch.className = "btn" + (on ? "" : " ghost");
      toast(on ? "已开启本地提醒（逾期任务会通知）" : "已关闭提醒");
    },
  }, reminderOn ? "已开启" : "未开启");

  // 字体大小：跟随系统 / 自定义
  const fontMode = (await db.getSetting("fontMode")) || "follow";
  const fontSize = Number(await db.getSetting("fontSize")) || 16;
  const fontSel = h("select", { class: "input", style: "width:100%;" },
    h("option", { value: "follow", selected: fontMode === "follow" ? "selected" : null }, "跟随系统"),
    h("option", { value: "custom", selected: fontMode === "custom" ? "selected" : null }, "自定义")
  );
  const fontRange = h("input", { type: "range", min: "12", max: "24", step: "1", value: String(fontSize), style: "width:100%; margin-top:10px;" });
  const fontVal = h("span", { class: "muted", style: "font-size:.8125rem;" }, fontSize + "px");
  const setFontMode = (m) => {
    fontRange.style.display = m === "custom" ? "block" : "none";
    fontVal.style.display = m === "custom" ? "inline" : "none";
  };
  setFontMode(fontMode);
  fontSel.addEventListener("change", async () => {
    await db.setSetting("fontMode", fontSel.value);
    setFontMode(fontSel.value);
    await window.__applyFont();
    toast(fontSel.value === "custom" ? "已切换为自定义字体大小" : "已跟随系统字体大小");
  });
  fontRange.addEventListener("input", () => { fontVal.textContent = fontRange.value + "px"; });
  fontRange.addEventListener("change", async () => {
    await db.setSetting("fontSize", +fontRange.value);
    await window.__applyFont();
  });

  const box = h("div", {},
    h("div", { class: "field" }, h("label", {}, "外观模式"), themeGrid),
    h("div", { class: "field" },
      h("label", {}, "字体大小"),
      h("div", { class: "muted", style: "margin:-2px 0 9px;" }, "跟随系统时按手机设置缩放；自定义可调 12-24px"),
      fontSel,
      h("div", { class: "row", style: "gap:10px; align-items:center;" }, fontRange, fontVal)
    ),
    h("div", { class: "field" },
      h("label", {}, "强调色 · 预设配色"),
      h("div", { class: "muted", style: "margin:-2px 0 9px;" }, "点「A 跟随主题」即恢复各主题自带配色，随时可切回"),
      accentRow
    ),
    h("div", { class: "field" },
      h("label", {}, "分类（任务 / 日记）"),
      h("button", { class: "btn ghost block", onclick: () => openCategoryManager() }, "🏷️ 管理分类")
    ),
    h("div", { class: "field" },
      h("label", {}, "专注提醒（本地，需通知权限）"),
      h("div", { class: "row", style: "gap:10px;" }, remSwitch)
    ),
    h("div", { class: "field" },
      h("label", {}, "数据（全部存在本机，不上传）"),
      h("div", { class: "row", style: "gap:10px;" },
        h("button", { class: "btn ghost", style: "flex:1", onclick: async () => {
            const data = await db.exportAll();
            download("workbench-backup-" + new Date().toISOString().slice(0, 10) + ".json", JSON.stringify(data, null, 2));
            toast("已导出");
          } }, "⬇ 导出备份"),
        h("button", { class: "btn ghost", style: "flex:1", onclick: () => fileInput.click() }, "⬆ 导入")
      )
    ),
    h("div", { class: "field" },
      h("label", {}, "危险操作"),
      h("button", { class: "btn danger block", onclick: async () => {
          if (await confirmDialog("将清空全部任务/速记/笔记/番茄/日记/分类，且无法恢复。继续？")) {
            for (const s of ["tasks", "captures", "notes", "pomodoro", "diary", "categories"]) await db.clearStore(s);
            toast("已清空"); closeModal(); window.__rerender();
          }
        } }, "清空全部数据")
    ),
    h("div", { class: "muted", style: "margin-top:6px; line-height:1.6;" },
      `个人工作台 v${APP_VERSION}（构建 ${BUILD}）· 本地优先 · 离线可用`,
      h("br", {}),
      "数据仅保存在你的浏览器/手机本地（IndexedDB）。卸载或清缓存会丢失，记得定期导出备份。"
    ),
    h("div", { class: "row", style: "margin-top:14px;" },
      h("button", { class: "btn block", onclick: () => closeModal() }, "关闭")
    )
  );

  openModal("设置", box);
}
