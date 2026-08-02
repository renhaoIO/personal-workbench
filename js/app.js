// 应用外壳：左侧可收缩侧边栏导航、主题、Service Worker 注册、分类种子
import { db, uid } from "./db.js";
import { $, $$, toast } from "./util.js";
import { renderHome } from "./views/home.js";
import { renderPomodoro } from "./views/pomodoro.js";
import { renderTasks } from "./views/tasks.js";
import { renderCapture } from "./views/capture.js";
import { renderNotes } from "./views/notes.js";
import { renderDiary } from "./views/diary.js";
import { renderStats } from "./views/stats.js";
import { renderWhiteNoise } from "./views/whitenoise.js";
import { renderAchievements } from "./views/achievements.js";
import { renderFitness } from "./views/fitness.js";
import { renderReader } from "./views/reader.js";
import "./views/read.js"; // 副作用引入：注册 window.__openBook 全屏阅读器
import { openSettings } from "./views/settings.js";
import { openCategoryManager } from "./views/categories.js";

const NAV = [
  { key: "home", title: "主页", ico: "🏠" },
  { key: "pomodoro", title: "番茄钟", ico: "🍅" },
  { key: "tasks", title: "任务", ico: "✅" },
  { key: "capture", title: "速记", ico: "⚡" },
  { key: "notes", title: "笔记", ico: "📝" },
  { key: "diary", title: "日记", ico: "📔" },
  { key: "fitness", title: "健身", ico: "🏋️" },
  { key: "reader", title: "阅读", ico: "📚" },
  { key: "stats", title: "统计", ico: "📊" },
  { key: "whitenoise", title: "白噪音", ico: "🎧" },
  { key: "achievements", title: "成就", ico: "🏆" },
];

const VIEWS = {
  home: { title: "主页", render: renderHome },
  pomodoro: { title: "番茄钟", render: renderPomodoro },
  tasks: { title: "任务", render: renderTasks },
  capture: { title: "速记", render: renderCapture },
  notes: { title: "笔记", render: renderNotes },
  diary: { title: "日记", render: renderDiary },
  fitness: { title: "健身规划", render: renderFitness },
  reader: { title: "阅读", render: renderReader },
  stats: { title: "统计", render: renderStats },
  whitenoise: { title: "白噪音", render: renderWhiteNoise },
  achievements: { title: "成就", render: renderAchievements },
};

let current = "home";

const SEED_CATS = [
  { kind: "task", name: "工作", color: "#2f6df6", icon: "💼" },
  { kind: "task", name: "学习", color: "#2fa66b", icon: "📚" },
  { kind: "task", name: "生活", color: "#e8a33d", icon: "🌿" },
  { kind: "task", name: "其他", color: "#9aa3b2", icon: "📦" },
  { kind: "diary", name: "日常", color: "#2f6df6", icon: "🌞" },
  { kind: "diary", name: "工作", color: "#2fa66b", icon: "💼" },
  { kind: "diary", name: "学习", color: "#e8a33d", icon: "📚" },
  { kind: "diary", name: "心情", color: "#e5484d", icon: "💗" },
  { kind: "diary", name: "其他", color: "#9aa3b2", icon: "📦" },
  { kind: "book", name: "小说", color: "#8b5cf6", icon: "📖" },
  { kind: "book", name: "技术", color: "#3b7df6", icon: "💻" },
  { kind: "book", name: "随笔", color: "#22b07d", icon: "✍️" },
  { kind: "book", name: "其他", color: "#9aa3b2", icon: "📦" },
];

async function seedCategories() {
  const exist = await db.getAll("categories");
  for (const c of SEED_CATS) {
    if (!exist.find((e) => e.kind === c.kind && e.name === c.name)) {
      await db.put("categories", { id: uid(), ...c });
    }
  }
}

const THEME_ORDER = ["light", "dark", "gray", "eink"];
const THEME_ICON = { light: "☀️", dark: "🌙", gray: "🌫️", eink: "📄" };
const THEME_LABEL = { light: "白天", dark: "黑夜", gray: "灰色", eink: "墨水屏" };
const THEME_META = { light: "#eef1f7", dark: "#0e1014", gray: "#ECE9E3", eink: "#ffffff" };

async function applyTheme() {
  const theme = (await db.getSetting("theme")) || "light";
  const accent = (await db.getSetting("accent")) || "auto";
  document.documentElement.setAttribute("data-theme", theme);
  if (accent === "auto") {
    // 跟随主题：移除属性，--primary 回落到当前主题的默认强调色
    document.documentElement.removeAttribute("data-accent");
  } else {
    document.documentElement.setAttribute("data-accent", accent);
  }
  const t = $("#themeToggle");
  if (t) t.textContent = THEME_ICON[theme] || "🌙";
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", THEME_META[theme] || "#eef1f7");
}

async function setTheme(theme) {
  await db.setSetting("theme", theme);
  await applyTheme();
}

// 供设置页在切换外观/配色后即时刷新（含顶栏图标与 meta）
window.__applyTheme = async () => { await applyTheme(); };

function buildSidebar() {
  const nav = $("#sideNav");
  nav.innerHTML = "";
  for (const item of NAV) {
    nav.appendChild(
      h2side(item)
    );
  }
  // 设置项
  const setItem = h2side({ key: "__settings", title: "设置", ico: "⚙️" });
  setItem.addEventListener("click", () => {
    closeSidebar();
    openSettings();
  });
  nav.appendChild(setItem);
  // 分类管理
  const catItem = h2side({ key: "__cats", title: "分类", ico: "🏷️" });
  catItem.addEventListener("click", () => {
    closeSidebar();
    openCategoryManager();
  });
  nav.appendChild(catItem);
}

function h2side(item) {
  const el = document.createElement("button");
  el.className = "side-item" + (item.key === current ? " active" : "");
  el.dataset.view = item.key;
  el.innerHTML = `<span class="si-ico">${item.ico}</span><span>${item.title}</span>`;
  el.addEventListener("click", () => {
    if (item.key === "__settings") return; // 单独处理
    route(item.key);
    closeSidebar();
  });
  return el;
}

function openSidebar() {
  $("#sidebar").classList.add("open");
  $("#scrim").classList.add("show");
}
function closeSidebar() {
  $("#sidebar").classList.remove("open");
  $("#scrim").classList.remove("show");
}

function route(name) {
  if (!VIEWS[name]) name = "home";
  current = name;
  $$(".side-item").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  const title = $("#appTitle");
  if (title) title.textContent = VIEWS[name].title;
  const root = $("#view");
  root.innerHTML = "";
  VIEWS[name].render(root);
  window.scrollTo(0, 0);
}

// 供各模块在增删改后刷新当前视图
window.__rerender = () => route(current);
// 供各模块跳转到指定视图
window.__route = (name) => route(name);

async function init() {
  // 原生包（Capacitor）下用本地服务器加载，无需 Service Worker 离线缓存
  if (!window.Capacitor && "serviceWorker" in navigator) {
    try {
      await navigator.serviceWorker.register("./sw.js");
    } catch (e) {
      console.warn("SW 注册失败", e);
    }
  }

  await applyTheme();
  await seedCategories();
  buildSidebar();

  $("#menuBtn").addEventListener("click", openSidebar);
  $("#scrim").addEventListener("click", closeSidebar);

  $("#themeToggle").addEventListener("click", async () => {
    const cur = document.documentElement.getAttribute("data-theme") || "light";
    const next = THEME_ORDER[(THEME_ORDER.indexOf(cur) + 1) % THEME_ORDER.length];
    await setTheme(next);
    toast("主题：" + (THEME_LABEL[next] || next));
  });

  $("#settingsBtn").addEventListener("click", () => openSettings());

  route("home");
}

init();
