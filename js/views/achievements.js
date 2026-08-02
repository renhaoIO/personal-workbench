// 成就 / 养熊猫：专注番茄数驱动等级与成就解锁（本地）
import { db } from "../db.js";
import { h, fmtDate, toast } from "../util.js";

export async function renderAchievements(root) {
  root.innerHTML = "";

  const sessions = (await db.getAll("pomodoro")).filter((s) => s.type === "work");
  const tomatoes = sessions.length;

  const byDate = {};
  let night = false, early = false;
  for (const s of sessions) {
    const d = fmtDate(s.startedAt);
    byDate[d] = (byDate[d] || 0) + 1;
    const hr = new Date(s.startedAt).getHours();
    if (hr >= 0 && hr < 5) night = true;
    if (hr >= 5 && hr < 8) early = true;
  }
  let streak = 0;
  const dt = new Date(); dt.setHours(0, 0, 0, 0);
  while (byDate[fmtDate(dt.getTime())] > 0) { streak++; dt.setDate(dt.getDate() - 1); }

  const cats = await db.getAll("categories");
  const level = Math.floor(tomatoes / 10) + 1;
  const inLevel = tomatoes % 10;

  // 熊猫
  const panda = h("div", { class: "panda" }, "🐼");
  const pandaCard = h("div", { class: "card", style: "text-align:center;" },
    panda,
    h("div", { style: "font-weight:700; font-size:16px; margin-top:6px;" }, "熊猫 Lv." + level),
    h("div", { class: "muted", style: "margin:4px 0 8px;" }, "已收集 " + tomatoes + " 颗番茄 🍅"),
    h("div", { style: "height:10px; background:var(--surface-2); border-radius:6px; overflow:hidden;" },
      h("div", { style: `height:100%; width:${(inLevel / 10) * 100}%; background:var(--primary);` })
    ),
    h("div", { class: "muted", style: "font-size:12px; margin-top:4px;" }, inLevel + " / 10 升下一级")
  );
  root.appendChild(pandaCard);
  setTimeout(() => { panda.classList.add("bounce"); setTimeout(() => panda.classList.remove("bounce"), 350); }, 200);

  // 成就定义
  const ACH = [
    { id: "first", icon: "🌱", name: "第一颗番茄", desc: "完成 1 次专注", ok: tomatoes >= 1 },
    { id: "ten", icon: "🌿", name: "小有成效", desc: "完成 10 次专注", ok: tomatoes >= 10 },
    { id: "fifty", icon: "🌳", name: "专注达人", desc: "完成 50 次专注", ok: tomatoes >= 50 },
    { id: "hundred", icon: "🏔️", name: "专注宗师", desc: "完成 100 次专注", ok: tomatoes >= 100 },
    { id: "streak7", icon: "🔥", name: "七天不断", desc: "连续专注 7 天", ok: streak >= 7 },
    { id: "streak30", icon: "⚡", name: "月度坚持", desc: "连续专注 30 天", ok: streak >= 30 },
    { id: "night", icon: "🌙", name: "深夜学霸", desc: "在 0-5 点专注过", ok: night },
    { id: "early", icon: "🌅", name: "早起鸟儿", desc: "在 5-8 点专注过", ok: early },
    { id: "organizer", icon: "🗂️", name: "分类达人", desc: "使用了至少 5 个分类", ok: cats.length >= 5 },
  ];

  const unlocked = (await db.getSetting("achievements", [])) || [];
  const newly = [];
  for (const a of ACH) {
    if (a.ok && !unlocked.includes(a.id)) { unlocked.push(a.id); newly.push(a.name); }
  }
  if (newly.length) {
    await db.setSetting("achievements", unlocked);
    newly.forEach((n) => toast("🏆 解锁成就：" + n));
  }

  root.appendChild(h("h2", { class: "section", style: "margin-top:16px;" }, `成就（${unlocked.length}/${ACH.length}）`));
  const grid = h("div", { style: "display:grid; grid-template-columns:repeat(2,1fr); gap:10px;" });
  for (const a of ACH) {
    const got = unlocked.includes(a.id);
    grid.appendChild(h("div", { class: "card", style: `opacity:${got ? 1 : 0.5}; text-align:center; ${got ? "" : "filter:grayscale(1);"}` },
      h("div", { style: "font-size:30px;" }, got ? a.icon : "🔒"),
      h("div", { style: "font-weight:600; margin-top:4px; font-size:14px;" }, a.name),
      h("div", { class: "muted", style: "font-size:12px; margin-top:2px;" }, a.desc)
    ));
  }
  root.appendChild(grid);
}
