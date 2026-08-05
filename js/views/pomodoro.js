// 番茄时钟模块：工作/休息计时，可绑定任务，记录专注会话
import { db, uid } from "../db.js";
import { h, fmtDate, fromNow, toast, openModal, closeModal, confirmDialog } from "../util.js";
import { donut } from "./charts.js";

const DEFAULTS = { workMin: 25, breakMin: 5, longBreakMin: 15, roundsBeforeLong: 4 };

let settings = { ...DEFAULTS };
let mode = "work"; // work | break | long
let running = false;
let remaining = 0; // 秒
let endTime = 0;
let rounds = 0;
let taskId = null;
let catId = null;
let timer = null;
let taskOptions = [];

function dur() {
  return (mode === "work" ? settings.workMin : mode === "break" ? settings.breakMin : settings.longBreakMin) * 60;
}
function modeLabel(m) {
  return m === "work" ? "专注" : m === "break" ? "短休息" : "长休息";
}

async function loadSettings() {
  settings = { ...DEFAULTS, ...(await db.getSetting("pomodoroSettings", {})) };
  settings.pomoFloat = !!(await db.getSetting("pomoFloat", false));
}

// ============ 番茄悬浮球（应用内）============
let floatEl = null;
let floatTimer = null;

function ensureFloat() {
  if (floatEl) return;
  floatEl = h("div", { class: "pomo-float" });
  floatEl.innerHTML = '<span class="pf-icon">🍅</span><span class="pf-time">25:00</span>';
  floatEl.addEventListener("click", () => { if (window.__route) window.__route("pomodoro"); });
  document.body.appendChild(floatEl);
  floatTimer = setInterval(updateFloat, 500);
  updateFloat();
}

function updateFloat() {
  if (!floatEl) return;
  const inPomo = window.__getCurrent && window.__getCurrent() === "pomodoro";
  // 开启开关后即可见（不要求 running）：离开本页右下角显示当前阶段与剩余时间
  const show = !!settings.pomoFloat && !inPomo;
  floatEl.style.display = show ? "flex" : "none";
  if (show) {
    const m = Math.floor(remaining / 60), s = remaining % 60;
    const t = String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
    floatEl.querySelector(".pf-time").textContent = modeLabel(mode) + " " + t;
  }
}
// 路由变化后由 app.js 调用，刷新悬浮球可见性
window.__pomoFloatSync = updateFloat;

// ============ 原生桥同步（APK 版：系统悬浮窗 + 通知栏）============
// 运行中且开启悬浮窗 → 启动原生前台服务（原生侧计时，后台不被冻结）；
// 否则停止。PWA 版无 window.PomoBridge，此函数空转。
function syncBridge() {
  if (!window.PomoBridge) return;
  try {
    if (running && settings.pomoFloat) {
      window.PomoBridge.startPomo(endTime, modeLabel(mode));
    } else {
      window.PomoBridge.stopPomo();
    }
  } catch (e) {}
}

// 阶段切换提示音：workDone=专注结束(上升三音) / breakDone=休息结束(下降两音)
function chime(kind) {
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const notes = kind === "workDone" ? [660, 880, 990] : [880, 660];
    notes.forEach((freq, i) => {
      const t = ac.currentTime + i * 0.18;
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.connect(g); g.connect(ac.destination);
      o.type = "sine";
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.28, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      o.start(t); o.stop(t + 0.2);
    });
  } catch (e) {}
}

export async function renderPomodoro(root) {
  root.innerHTML = "";
  // 进入本视图时清掉可能残留的旧计时器，避免悬空 tick
  clearInterval(timer);
  running = false;
  await loadSettings();
  ensureFloat();
  updateFloat();
  if (remaining === 0) remaining = dur();
  taskOptions = (await db.getAll("tasks")).filter((t) => !t.done);
  const taskCats = (await db.getAll("categories")).filter((c) => c.kind === "task");
  const cats = await db.getAll("categories");
  const catName = (id) => (cats.find((c) => c.id === id) || {}).name || "未分类";
  const catColor = (id) => (cats.find((c) => c.id === id) || {}).color || "#9aa3b2";
  const mono = document.documentElement.getAttribute("data-theme") === "eink";

  const timerEl = h("div", { class: "timer" }, fmt(remaining));
  const modeEl = h("div", { class: "timer-sub" }, modeLabel(mode) + (taskId ? " · " + (taskOptions.find((t) => t.id === taskId)?.title || "") : ""));

  const sel = h("select", { class: "input", style: "margin:6px 0 14px;" },
    h("option", { value: "" }, "（不绑定任务）"),
    ...taskOptions.map((t) => h("option", { value: t.id, selected: t.id === taskId ? "selected" : null }, t.title))
  );
  sel.addEventListener("change", () => {
    taskId = sel.value || null;
    const t = taskOptions.find((x) => x.id === taskId);
    if (t && t.category) { catId = t.category; catSel.value = catId; }
    paint();
  });

  const catSel = h("select", { class: "input", style: "margin:6px 0 14px;" },
    h("option", { value: "" }, "（不分类）"),
    ...taskCats.map((c) => h("option", { value: c.id, selected: c.id === catId ? "selected" : null }, (c.icon || "") + " " + c.name))
  );
  catSel.addEventListener("change", () => { catId = catSel.value || null; });

  const startBtn = h("button", { class: "btn block", style: "font-size:16px; padding:14px;", onclick: toggle }, running ? "⏸ 暂停" : "▶ 开始");
  const skipBtn = h("button", { class: "btn ghost", style: "flex:1", onclick: skip }, mode === "work" ? "⏭ 跳过此段" : "⏭ 跳过休息");
  const endBtn = h("button", { class: "btn danger", style: "flex:1", onclick: endSession }, "⏹ 结束学习");
  const resetBtn = h("button", { class: "btn ghost", style: "flex:1", onclick: reset }, "↺ 重置");
  const setBtn = h("button", { class: "btn ghost", style: "flex:1", onclick: editSettings }, "⚙ 时长");
  const noiseBtn = h("button", { class: "btn ghost", style: "flex:1", onclick: () => window.__route("whitenoise") }, "🎧 白噪音");
  const floatBtn = h("button", { class: "btn ghost", style: "flex:1", onclick: async () => {
    settings.pomoFloat = !settings.pomoFloat;
    await db.setSetting("pomoFloat", settings.pomoFloat);
    floatBtn.textContent = settings.pomoFloat ? "⭕ 悬浮窗：开" : "⚪ 悬浮窗：关";
    // APK 版：开启时若未授予系统悬浮窗权限，引导去设置页授权
    if (settings.pomoFloat && window.PomoBridge) {
      try {
        if (!window.PomoBridge.hasOverlayPermission()) {
          window.PomoBridge.requestOverlayPermission();
          toast("已打开悬浮窗：请在系统弹出的设置页允许「显示在其他应用上层」");
        } else {
          toast("已开启悬浮窗：通知栏 + 其他应用上方显示");
        }
      } catch (e) { toast("已开启悬浮窗"); }
    } else {
      toast(settings.pomoFloat ? "已开启悬浮窗：离开本页后右下角显示" : "已关闭悬浮窗");
    }
    updateFloat();
    syncBridge();
  } }, settings.pomoFloat ? "⭕ 悬浮窗：开" : "⚪ 悬浮窗：关");

  const card = h("div", { class: "card" },
    h("div", { class: "row spread" }, h("b", {}, "番茄时钟"), h("span", { class: "muted", id: "pomo-round" }, "第 " + (rounds + 1) + " 轮")),
    timerEl, modeEl, sel, catSel, startBtn,
    h("div", { class: "row", style: "gap:10px; margin-top:10px;" }, skipBtn, endBtn),
    h("div", { class: "row", style: "gap:10px; margin-top:10px;" }, resetBtn, setBtn, noiseBtn),
    h("div", { class: "row", style: "gap:10px; margin-top:10px;" }, floatBtn)
  );
  root.appendChild(card);

  // 统计
  const sessions = (await db.getAll("pomodoro")).filter((s) => s.type === "work");
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todaySessions = sessions.filter((s) => s.startedAt >= today.getTime());
  const todayMin = Math.round(todaySessions.reduce((a, s) => a + (s.durationSec || 0), 0) / 60);

  const countB = h("b", {}, String(todaySessions.length));
  const minB = h("b", {}, String(todayMin));
  const roundB = h("b", {}, String(rounds));

  root.appendChild(h("div", { class: "stat-grid" },
    h("div", { class: "stat" }, countB, h("span", {}, "今日专注")),
    h("div", { class: "stat" }, minB, h("span", {}, "专注分钟")),
    h("div", { class: "stat" }, roundB, h("span", {}, "已完成轮次"))
  ));

  // 分类专注分布（环形图）
  const totalMinAll = Math.round(sessions.reduce((a, s) => a + (s.durationSec || 0), 0) / 60);
  const byCat = {};
  for (const s of sessions) {
    const cid = s.category || "none";
    byCat[cid] = (byCat[cid] || 0) + Math.round((s.durationSec || 0) / 60);
  }
  const segs = Object.entries(byCat)
    .map(([cid, min]) => ({ label: catName(cid), value: min, color: catColor(cid) }))
    .sort((a, b) => b.value - a.value);
  root.appendChild(h("h2", { class: "section", style: "margin-top:18px;" }, "专注分类分布"));
  if (!sessions.length) {
    root.appendChild(h("div", { class: "center-empty" }, "还没有专注记录"));
  } else {
    root.appendChild(h("div", { class: "card" },
      donut(segs, { centerLabel: totalMinAll + "′", centerSub: "总专注", mono })
    ));
  }

  // 历史
  root.appendChild(h("h2", { class: "section", style: "margin-top:16px;" }, "最近记录"));
  const recent = sessions.slice(-12).reverse();
  if (!recent.length) root.appendChild(h("div", { class: "center-empty" }, "还没有专注记录"));
  for (const s of recent) {
    root.appendChild(h("div", { class: "card row spread" },
      h("div", {}, h("div", { class: "item-title" }, "🍅 专注 " + Math.round((s.durationSec || 0) / 60) + " 分钟"), h("div", { class: "item-sub" }, fromNow(s.startedAt))),
      h("span", { class: "tag" }, fmtDate(s.startedAt))
    ));
  }

  function fmt(sec) {
    const m = Math.floor(sec / 60), s = sec % 60;
    return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  }
  function paint() {
    timerEl.textContent = fmt(remaining);
    startBtn.textContent = running ? "⏸ 暂停" : "▶ 开始";
    skipBtn.textContent = mode === "work" ? "⏭ 跳过此段" : "⏭ 跳过休息";
    modeEl.textContent = modeLabel(mode) + (taskId ? " · " + (taskOptions.find((t) => t.id === taskId)?.title || "") : "");
  }
  function tick() {
    remaining = Math.max(0, Math.round((endTime - Date.now()) / 1000));
    paint();
    if (remaining <= 0) complete();
  }
  function toggle() {
    if (running) {
      running = false; clearInterval(timer);
    } else {
      running = true;
      endTime = Date.now() + remaining * 1000;
      timer = setInterval(tick, 250);
    }
    paint();
    syncBridge();
  }
  function reset() {
    running = false; clearInterval(timer); remaining = dur(); paint();
    syncBridge();
  }
  async function complete() {
    clearInterval(timer);
    if (mode === "work") {
      await db.put("pomodoro", { id: uid(), type: "work", startedAt: Date.now() - settings.workMin * 60000, durationSec: settings.workMin * 60, taskId, category: catId });
      rounds++;
      chime("workDone");
      mode = rounds % settings.roundsBeforeLong === 0 ? "long" : "break";
      toast("专注完成，休息一下 ☕");
      // 自动衔接：休息阶段也开始计时
      remaining = dur();
      running = true;
      endTime = Date.now() + remaining * 1000;
      timer = setInterval(tick, 250);
      paint();
      // 更新轮次/统计（不整页重渲染，避免打断自动计时）
      countB.textContent = String(todaySessions.length + 1);
      minB.textContent = String(todayMin + settings.workMin);
      roundB.textContent = String(rounds);
      const roundEl = root.querySelector("#pomo-round");
      if (roundEl) roundEl.textContent = "第 " + (rounds + 1) + " 轮";
    } else {
      chime("breakDone");
      mode = "work";
      toast("休息结束，继续加油 💪");
      // 自动衔接：下一轮专注直接开始
      remaining = dur();
      running = true;
      endTime = Date.now() + remaining * 1000;
      timer = setInterval(tick, 250);
      paint();
      const roundEl = root.querySelector("#pomo-round");
      if (roundEl) roundEl.textContent = "第 " + (rounds + 1) + " 轮";
    }
    syncBridge();
  }
  // 提前结束：彻底结束学习，不进入休息，按实际已专注时长计入统计
  async function endSession() {
    if (mode === "work") {
      const elapsed = dur() - remaining; // 已专注秒数 = 总时长 - 剩余
      if (elapsed >= 1) {
        const mins = Math.round(elapsed / 60);
        const ok = await confirmDialog("结束本次学习？已专注 " + mins + " 分钟将被记录到统计。");
        if (!ok) return;
        running = false; clearInterval(timer);
        await db.put("pomodoro", {
          id: uid(), type: "work",
          startedAt: Date.now() - elapsed * 1000, // 按实际跨度回填开始时间
          durationSec: elapsed, taskId, category: catId,
        });
        toast("已结束学习，记录专注 " + mins + " 分钟");
      } else {
        running = false; clearInterval(timer);
        toast("已结束学习");
      }
    } else {
      // 休息中也允许结束学习（无专注数据，仅停止）
      running = false; clearInterval(timer);
      toast("已结束学习");
    }
    // 彻底结束：回到专注初始态，不进休息，轮次保留（已完成轮次仍计入统计）
    mode = "work";
    remaining = dur();
    syncBridge();
    window.__rerender();
  }
  // 跳过：休息模式直接进下一轮专注；专注模式跳过本段（按实际时长计入）并进入休息
  async function skip() {
    running = false; clearInterval(timer);
    if (mode === "work") {
      const elapsed = dur() - remaining;
      if (elapsed >= 1) {
        const mins = Math.round(elapsed / 60);
        const ok = await confirmDialog("跳过本段学习？已专注 " + mins + " 分钟将被记录，随后进入休息。");
        if (!ok) return;
        await db.put("pomodoro", {
          id: uid(), type: "work",
          startedAt: Date.now() - elapsed * 1000,
          durationSec: elapsed, taskId, category: catId,
        });
        rounds++;
        toast("已跳过本段，记录专注 " + mins + " 分钟");
      } else {
        toast("已跳过本段学习");
      }
      mode = rounds % settings.roundsBeforeLong === 0 ? "long" : "break";
    } else {
      mode = "work";
      toast("已跳过休息");
    }
    remaining = dur();
    syncBridge();
    window.__rerender();
  }

  // APK 版：App 进程被系统回收后重建，若原生前台服务仍在计时，恢复剩余时间继续
  if (window.PomoBridge) {
    try {
      if (window.PomoBridge.isRunning()) {
        const ms = window.PomoBridge.getRemainingMs();
        if (ms > 0) {
          running = true;
          remaining = Math.max(1, Math.ceil(ms / 1000));
          endTime = Date.now() + ms;
          timer = setInterval(tick, 250);
          paint();
        }
      }
    } catch (e) {}
  }
}

function editSettings() {
  const w = h("input", { class: "input", type: "number", min: "1", value: settings.workMin });
  const b = h("input", { class: "input", type: "number", min: "1", value: settings.breakMin });
  const l = h("input", { class: "input", type: "number", min: "1", value: settings.longBreakMin });
  const r = h("input", { class: "input", type: "number", min: "1", value: settings.roundsBeforeLong });
  const form = h("div", {},
    h("div", { class: "field" }, h("label", {}, "专注（分钟）"), w),
    h("div", { class: "field" }, h("label", {}, "短休息（分钟）"), b),
    h("div", { class: "field" }, h("label", {}, "长休息（分钟）"), l),
    h("div", { class: "field" }, h("label", {}, "几轮后长休息"), r),
    h("div", { class: "row", style: "gap:10px;" },
      h("button", { class: "btn ghost", style: "flex:1", onclick: () => closeModal() }, "取消"),
      h("button", { class: "btn", style: "flex:1", onclick: async () => {
          settings = {
            workMin: Math.max(1, +w.value || 25),
            breakMin: Math.max(1, +b.value || 5),
            longBreakMin: Math.max(1, +l.value || 15),
            roundsBeforeLong: Math.max(1, +r.value || 4),
          };
          await db.setSetting("pomodoroSettings", settings);
          remaining = dur();
          closeModal(); window.__rerender(); toast("已保存");
        } }, "保存")
    )
  );
  openModal("番茄时长设置", form);
}
