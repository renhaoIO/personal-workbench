// 健身规划：训练计划（名称 / 每周日程 / 动作组数次数重量休息）+ 今日训练逐动作完成 + 周统计。
// 数据存 IndexedDB "workouts"（type: plan | log）。
import { db, uid } from "../db.js";
import { h, fmtDate, toast, openModal, closeModal, confirmDialog } from "../util.js";

const WEEK = ["日", "一", "二", "三", "四", "五", "六"];
const SCHEDULE_COLORS = ["#ef4d56", "#f5873f", "#f5b73f", "#22b07d", "#3b7df6", "#8b5cf6", "#64748b"];

export async function renderFitness(root) {
  root.innerHTML = "";
  const plans = (await db.getAll("workouts")).filter((w) => w.type === "plan");
  const logs = (await db.getAll("workouts")).filter((w) => w.type === "log");

  // 本周一
  const now = new Date();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  monday.setHours(0, 0, 0, 0);
  const weekDates = new Set();
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday); d.setDate(monday.getDate() + i);
    weekDates.add(fmtDate(d.getTime()));
  }
  const doneDays = new Set(logs.filter((l) => weekDates.has(l.date)).map((l) => l.date));

  // ---- 概览 ----
  root.appendChild(h("div", { class: "card fit-overview" },
    h("div", { class: "stat-grid" },
      h("div", { class: "stat" }, h("b", {}, String(plans.length)), h("span", {}, "训练计划")),
      h("div", { class: "stat" }, h("b", {}, String(doneDays.size)), h("span", {}, "本周打卡(天)")),
      h("div", { class: "stat" }, h("b", {}, String(logs.length)), h("span", {}, "累计完成(组)"))
    )
  ));

  // ---- 今日训练 ----
  const todayDow = now.getDay();
  const todayKey = fmtDate(now);
  const todayPlans = plans.filter((p) => (p.days || []).includes(todayDow));
  root.appendChild(h("h2", { class: "section" }, "今日训练"));
  if (!todayPlans.length) {
    root.appendChild(h("div", { class: "center-empty", style: "padding:24px;" }, "今天没有排训练 💪\n在计划里勾选今天对应的星期即可。"));
  } else {
    for (const p of todayPlans) {
      root.appendChild(todayPlanCard(p, todayKey, logs, () => renderFitness(root)));
    }
  }

  // ---- 全部计划 ----
  root.appendChild(h("h2", { class: "section" }, "全部计划"));
  if (!plans.length) {
    root.appendChild(h("div", { class: "center-empty", style: "padding:24px;" }, "还没有训练计划，点右下角 ＋ 新建。"));
  }
  for (const p of plans.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))) {
    root.appendChild(planCard(p, logs, () => renderFitness(root)));
  }

  // FAB
  const fab = h("button", { class: "fab", title: "新建计划", onclick: () => planForm(null, () => renderFitness(root)) }, "＋");
  root.appendChild(fab);
}

function scheduleChips(days) {
  return h("div", { class: "fit-days" },
    ...WEEK.map((w, i) =>
      h("span", { class: "fit-day" + ((days || []).includes(i) ? " on" : "") }, w)
    )
  );
}

function todayPlanCard(p, todayKey, logs, rerender) {
  const card = h("div", { class: "card fit-today" });
  card.appendChild(h("div", { class: "row spread", style: "margin-bottom:8px;" },
    h("div", { class: "item-title" }, p.name),
    h("button", { class: "cat-mini", title: "详情", onclick: () => planDetail(p, rerender) }, "⋮")
  ));
  const exList = h("div", { class: "fit-exlist" });
  for (const ex of p.exercises || []) {
    const done = logs.some((l) => l.planId === p.id && l.exerciseId === ex.id && l.date === todayKey);
    const row = h("div", { class: "fit-ex" + (done ? " done" : "") },
      h("div", { class: "check" + (done ? " done" : ""), onclick: async () => {
        await toggleExercise(p, ex, todayKey);
        rerender();
      } }, done ? "✓" : ""),
      h("div", { class: "fit-ex-main" },
        h("div", { class: "item-title" }, ex.name),
        h("div", { class: "item-sub" }, exSummary(ex))
      )
    );
    exList.appendChild(row);
  }
  if (!(p.exercises || []).length) exList.appendChild(h("div", { class: "muted", style: "padding:6px 2px;" }, "该计划暂无动作，点 ⋮ 编辑添加。"));
  card.appendChild(exList);
  return card;
}

function planCard(p, logs, rerender) {
  const lastDone = logs.filter((l) => l.planId === p.id).map((l) => l.date).sort().pop();
  return h("div", { class: "card fit-plan", onclick: () => planDetail(p, rerender) },
    h("div", { class: "row spread" },
      h("div", { class: "item-title" }, p.name),
      h("span", { class: "tag" }, (p.exercises || []).length + " 个动作")
    ),
    h("div", { class: "item-sub", style: "margin:6px 0;" }, lastDone ? "上次完成 " + lastDone : "尚未完成过"),
    scheduleChips(p.days)
  );
}

function exSummary(ex) {
  const parts = [];
  if (ex.sets) parts.push(ex.sets + " 组");
  if (ex.reps) parts.push(ex.reps);
  if (ex.weight) parts.push(ex.weight);
  if (ex.rest) parts.push("休 " + ex.rest + "s");
  return parts.join(" · ");
}

async function toggleExercise(plan, ex, date) {
  const logs = (await db.getAll("workouts")).filter((w) => w.type === "log");
  const exist = logs.find((l) => l.planId === plan.id && l.exerciseId === ex.id && l.date === date);
  if (exist) {
    await db.del("workouts", exist.id);
  } else {
    await db.put("workouts", { id: uid(), type: "log", planId: plan.id, exerciseId: ex.id, date, doneAt: Date.now() });
    toast("已完成：" + ex.name);
  }
}

function planDetail(p, rerender) {
  const todayKey = fmtDate(Date.now());
  const todayDow = new Date().getDay();
  const content = h("div", {},
    h("div", { class: "row", style: "gap:10px; align-items:center; margin-bottom:8px;" },
      h("div", { class: "cat-dot", style: `background:${p.color || "#3b7df6"}` }, p.icon || "🏋️"),
      h("div", { class: "item-title" }, p.name)
    ),
    h("div", { class: "item-sub", style: "margin-bottom:10px;" }, "每周：" + ((p.days || []).map((d) => "周" + WEEK[d]).join("、") || "未排期")),
    h("div", { class: "fit-exlist" },
      ...(p.exercises || []).map((ex) =>
        h("div", { class: "fit-ex" },
          h("div", { class: "fit-ex-main" },
            h("div", { class: "item-title" }, ex.name),
            h("div", { class: "item-sub" }, exSummary(ex))
          )
        )
      )
    ),
    h("div", { class: "row", style: "margin-top:16px; gap:10px;" },
      h("button", { class: "btn ghost", style: "flex:1", onclick: () => planForm(p, rerender) }, "编辑"),
      h("button", { class: "btn danger", style: "flex:1", onclick: async () => {
        if (await confirmDialog("删除该训练计划？相关打卡记录也会清除。")) {
          const logs = (await db.getAll("workouts")).filter((w) => w.type === "log" && w.planId === p.id);
          for (const l of logs) await db.del("workouts", l.id);
          await db.del("workouts", p.id);
          toast("已删除");
          closeModal(); rerender();
        }
      } }, "删除"),
      h("button", { class: "btn", style: "flex:1", onclick: () => closeModal() }, "关闭")
    )
  );
  openModal("计划详情", content);
}

function planForm(plan, rerender) {
  const isEdit = !!plan;
  const model = plan || { id: uid(), type: "plan", name: "", days: [], color: "#3b7df6", icon: "🏋️", exercises: [], createdAt: Date.now() };

  const nameI = h("input", { class: "input", placeholder: "计划名称，如：胸肩推举", value: model.name, maxlength: "20" });

  // 每周日程
  const days = [...(model.days || [])];
  const dayRow = h("div", { class: "fit-days big" },
    ...WEEK.map((w, i) =>
      h("span", {
        class: "fit-day" + (days.includes(i) ? " on" : ""),
        onclick: (e) => {
          if (days.includes(i)) { days.splice(days.indexOf(i), 1); e.target.classList.remove("on"); }
          else { days.push(i); e.target.classList.add("on"); }
        },
      }, w)
    )
  );

  // 动作卡片列表（可增删）
  const exWrap = h("div", { class: "fit-exeditor" });
  function renderEx() {
    exWrap.innerHTML = "";
    if (!model.exercises.length) exWrap.appendChild(h("div", { class: "muted", style: "padding:8px 2px;" }, "还没有动作，点下方添加"));
    model.exercises.forEach((ex, idx) => {
      const name = h("input", { class: "input fex-name", placeholder: "动作名称，如：哑铃卧推", value: ex.name });
      const sets = h("input", { class: "input fex-num", type: "number", min: "0", placeholder: "4", value: ex.sets || "" });
      const reps = h("input", { class: "input fex-mid", placeholder: "12", value: ex.reps || "" });
      const weight = h("input", { class: "input fex-mid", placeholder: "20kg", value: ex.weight || "" });
      const rest = h("input", { class: "input fex-num", type: "number", min: "0", placeholder: "60", value: ex.rest || "" });
      name.oninput = () => (ex.name = name.value);
      sets.oninput = () => (ex.sets = sets.value);
      reps.oninput = () => (ex.reps = reps.value);
      weight.oninput = () => (ex.weight = weight.value);
      rest.oninput = () => (ex.rest = rest.value);

      exWrap.appendChild(h("div", { class: "fit-excard" },
        h("button", { class: "cat-mini del fex-del", title: "删除", onclick: () => { model.exercises.splice(idx, 1); renderEx(); } }, "✕"),
        h("div", { class: "fex-head" }, name),
        h("div", { class: "fex-grid" },
          h("div", { class: "fex-cell" },
            h("label", {}, "组数"),
            sets
          ),
          h("div", { class: "fex-cell" },
            h("label", {}, "次数 / 时长"),
            reps
          ),
          h("div", { class: "fex-cell" },
            h("label", {}, "重量"),
            weight
          ),
          h("div", { class: "fex-cell" },
            h("label", {}, "休息 (秒)"),
            rest
          )
        )
      ));
    });
  }
  renderEx();
  const addBtn = h("button", { class: "btn ghost block", style: "margin-top:10px;", onclick: () => { model.exercises.push({ id: uid(), name: "", sets: "", reps: "", weight: "", rest: "" }); renderEx(); } }, "＋ 添加动作");

  const form = h("div", {},
    h("div", { class: "field" }, h("label", {}, "名称"), nameI),
    h("div", { class: "field" }, h("label", {}, "每周日程（点选星期）"), dayRow),
    h("div", { class: "field" }, h("label", {}, "动作"), exWrap, addBtn),
    h("div", { class: "row", style: "margin-top:8px; gap:10px;" },
      h("button", { class: "btn ghost", style: "flex:1", onclick: () => openCategoryManagerPlan(rerender) }, "取消"),
      h("button", { class: "btn", style: "flex:1", onclick: async () => {
        const n = nameI.value.trim();
        if (!n) return toast("请填写计划名称");
        model.name = n; model.days = [...days];
        model.exercises = model.exercises.filter((e) => e.name && e.name.trim());
        await db.put("workouts", model);
        toast(isEdit ? "已保存" : "已添加计划");
        closeModal(); rerender();
      } }, "保存")
    )
  );
  openModal(isEdit ? "编辑计划" : "新建计划", form);
}

function openCategoryManagerPlan(rerender) {
  closeModal();
  rerender();
}
