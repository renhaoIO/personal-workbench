// 课表：周视图、课程增删改、外部导入（JSON/CSV）
import { db, uid } from "../db.js";
import { h, toast, openModal, closeModal, confirmDialog } from "../util.js";

const WEEK_DAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const PRESET_COLORS = ["#3b6ef5", "#22b07d", "#f5a623", "#ef4d56", "#8b5cf6", "#33b1cf", "#ec5a8d", "#6c63ff", "#10b3a3", "#bd7b46"];
const START_HOUR = 6;
const END_HOUR = 24;

function timeToMin(t) {
  const [h_, m] = t.split(":").map(Number);
  return h_ * 60 + m;
}

function minToTime(m) {
  const h_ = Math.floor(m / 60);
  const mn = m % 60;
  return `${String(h_).padStart(2, "0")}:${String(mn).padStart(2, "0")}`;
}

export async function renderSchedule(root) {
  root.innerHTML = "";
  const courses = await db.getAll("schedules");
  courses.sort((a, b) => a.dayOfWeek - b.dayOfWeek || timeToMin(a.startTime) - timeToMin(b.startTime));

  const header = h("div", { class: "row spread", style: "margin-bottom:12px;" },
    h("div", {}, h("b", {}, "本周课表"), h("div", { class: "muted", style: "font-size:.75rem;" }, "点击空白格添加，点击课程编辑")),
    h("div", { class: "row", style: "gap:8px;" },
      h("button", { class: "btn ghost", style: "padding:8px 12px; font-size:.8125rem;", onclick: importSchedule }, "导入"),
      h("button", { class: "btn", style: "padding:8px 14px; font-size:.8125rem;", onclick: () => editCourse(null) }, "＋ 课程")
    )
  );
  root.appendChild(header);

  const wrap = h("div", { class: "schedule-wrap card" });

  // 表头：空左上角 + 7 天
  const thead = h("div", { class: "sch-row sch-head" },
    h("div", { class: "sch-time-head" }, "时间"),
    ...WEEK_DAYS.map((d, i) => h("div", { class: "sch-day-head" + (i === ((new Date().getDay() + 6) % 7) ? " today" : "") }, d))
  );
  wrap.appendChild(thead);

  // 网格主体
  const body = h("div", { class: "sch-body" });
  const totalMin = (END_HOUR - START_HOUR) * 60;

  for (let h_ = START_HOUR; h_ < END_HOUR; h_++) {
    const row = h("div", { class: "sch-row" });
    row.appendChild(h("div", { class: "sch-time-label" }, `${String(h_).padStart(2, "0")}:00`));
    for (let d = 0; d < 7; d++) {
      const cell = h("div", { class: "sch-cell", onclick: () => editCourse(null, { dayOfWeek: d, startTime: `${String(h_).padStart(2, "0")}:00` }) });
      row.appendChild(cell);
    }
    body.appendChild(row);
  }

  // 放置课程块（绝对定位覆盖在网格上）
  const overlay = h("div", { class: "sch-overlay" });
  for (const c of courses) {
    const startMin = timeToMin(c.startTime);
    const endMin = timeToMin(c.endTime);
    if (startMin < START_HOUR * 60 || endMin > END_HOUR * 60) continue;
    const topPct = ((startMin - START_HOUR * 60) / totalMin) * 100;
    const heightPct = ((endMin - startMin) / totalMin) * 100;
    const leftPct = (c.dayOfWeek / 7) * 100;
    const widthPct = 100 / 7;
    const block = h("div", {
      class: "sch-course",
      style: `top:${topPct}%;left:${leftPct}%;width:${widthPct}%;height:${heightPct}%;background:${c.color || PRESET_COLORS[0]};`,
      title: `${c.name} ${c.startTime}-${c.endTime} ${c.location || ""}`,
      onclick: (e) => { e.stopPropagation(); editCourse(c); },
    },
      h("div", { class: "sch-course-name" }, c.name),
      h("div", { class: "sch-course-meta" }, `${c.startTime}-${c.endTime}`),
      c.location ? h("div", { class: "sch-course-meta" }, c.location) : null
    );
    overlay.appendChild(block);
  }

  wrap.appendChild(body);
  wrap.appendChild(overlay);
  root.appendChild(wrap);

  // 图例 / 统计
  if (courses.length) {
    const legend = h("div", { class: "sch-legend" });
    const names = [...new Set(courses.map((c) => c.name))];
    for (const n of names) {
      const c = courses.find((x) => x.name === n);
      legend.appendChild(h("div", { class: "sch-legend-item" },
        h("span", { class: "sch-dot", style: `background:${c.color};` }),
        h("span", {}, n)
      ));
    }
    root.appendChild(legend);
  }
}

function editCourse(c, defaults = {}) {
  const isEdit = !!c;
  const model = c || {
    id: uid(),
    name: "",
    dayOfWeek: defaults.dayOfWeek ?? 0,
    startTime: defaults.startTime ?? "08:00",
    endTime: "09:00",
    color: PRESET_COLORS[0],
    location: "",
    teacher: "",
  };

  const nameI = h("input", { class: "input", placeholder: "课程名称", value: model.name });
  const locI = h("input", { class: "input", placeholder: "地点（可选）", value: model.location || "" });
  const teacherI = h("input", { class: "input", placeholder: "教师（可选）", value: model.teacher || "" });
  const startI = h("input", { class: "input", type: "time", value: model.startTime });
  const endI = h("input", { class: "input", type: "time", value: model.endTime });

  const daySel = h("select", { class: "input" },
    ...WEEK_DAYS.map((d, i) => h("option", { value: i, selected: i === model.dayOfWeek ? "selected" : null }, d))
  );

  const colorRow = h("div", { class: "sch-color-row" });
  for (const col of PRESET_COLORS) {
    const dot = h("span", {
      class: "sch-color-dot" + (model.color === col ? " on" : ""),
      style: `background:${col};`,
      onclick: () => {
        model.color = col;
        [...colorRow.children].forEach((x) => x.classList.remove("on"));
        dot.classList.add("on");
      },
    });
    colorRow.appendChild(dot);
  }

  const form = h("div", {},
    h("div", { class: "field" }, h("label", {}, "课程名称"), nameI),
    h("div", { class: "row", style: "gap:10px;" },
      h("div", { class: "field", style: "flex:1;" }, h("label", {}, "星期"), daySel),
      h("div", { class: "field", style: "flex:1;" }, h("label", {}, "开始"), startI),
      h("div", { class: "field", style: "flex:1;" }, h("label", {}, "结束"), endI)
    ),
    h("div", { class: "field" }, h("label", {}, "颜色"), colorRow),
    h("div", { class: "field" }, h("label", {}, "地点"), locI),
    h("div", { class: "field" }, h("label", {}, "教师"), teacherI),
    h("div", { class: "row", style: "gap:10px; margin-top:8px;" },
      h("button", { class: "btn ghost", style: "flex:1", onclick: () => closeModal() }, "取消"),
      isEdit ? h("button", { class: "btn danger", style: "flex:1", onclick: async () => {
        if (await confirmDialog("确定删除该课程？")) { await db.del("schedules", model.id); closeModal(); window.__rerender(); }
      } }, "删除") : null,
      h("button", { class: "btn", style: "flex:1", onclick: async () => {
        const name = nameI.value.trim();
        if (!name) return toast("请填写课程名称");
        const sMin = timeToMin(startI.value);
        const eMin = timeToMin(endI.value);
        if (eMin <= sMin) return toast("结束时间必须晚于开始时间");
        model.name = name;
        model.dayOfWeek = +daySel.value;
        model.startTime = startI.value;
        model.endTime = endI.value;
        model.location = locI.value.trim();
        model.teacher = teacherI.value.trim();
        await db.put("schedules", model);
        closeModal();
        window.__rerender();
      } }, "保存")
    )
  );
  openModal(isEdit ? "编辑课程" : "添加课程", form);
}

async function importSchedule() {
  const fileInput = h("input", { type: "file", accept: ".json,.csv,.txt", style: "display:none;" });
  fileInput.addEventListener("change", async () => {
    const f = fileInput.files[0];
    if (!f) return;
    try {
      const text = await f.text();
      let imported = [];
      if (f.name.toLowerCase().endsWith(".json")) {
        const obj = JSON.parse(text);
        imported = Array.isArray(obj) ? obj : (obj.schedules || obj.data || []);
      } else {
        imported = parseCsv(text);
      }
      if (!imported.length) return toast("未识别到课程数据");
      let count = 0;
      for (const raw of imported) {
        const c = normalizeCourse(raw);
        if (c) { await db.put("schedules", c); count++; }
      }
      toast(`已导入 ${count} 门课程`);
      closeModal();
      window.__rerender();
    } catch (e) {
      toast("导入失败：" + (e.message || e));
    }
  });

  const help = h("div", { class: "muted", style: "font-size:.8125rem; line-height:1.6; margin-bottom:12px;" },
    "支持 JSON 数组或 CSV（name,dayOfWeek,startTime,endTime,color,location,teacher）。dayOfWeek 为 0-6（周一=0）。"
  );
  const sample = h("pre", { class: "muted", style: "font-size:.75rem; background:var(--surface-2); padding:10px; border-radius:10px; overflow:auto;" },
    `name,dayOfWeek,startTime,endTime,color,location\n高数,0,08:00,09:35,#3b6ef5,教学楼A301`
  );
  const box = h("div", {},
    help,
    sample,
    h("div", { class: "row", style: "gap:10px; margin-top:12px;" },
      h("button", { class: "btn ghost", style: "flex:1", onclick: () => closeModal() }, "取消"),
      h("button", { class: "btn", style: "flex:1", onclick: () => fileInput.click() }, "选择文件")
    )
  );
  openModal("导入课表", box);
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((s) => s.trim());
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(",");
    const row = {};
    headers.forEach((h_, idx) => row[h_] = vals[idx] ? vals[idx].trim() : "");
    out.push(row);
  }
  return out;
}

function normalizeCourse(raw) {
  const name = (raw.name || raw.课程 || raw.title || "").trim();
  if (!name) return null;
  let day = Number(raw.dayOfWeek ?? raw.day ?? raw.星期);
  if (Number.isNaN(day)) day = 0;
  day = ((day % 7) + 7) % 7;
  let start = (raw.startTime || raw.start || raw.开始 || "08:00").trim();
  let end = (raw.endTime || raw.end || raw.结束 || "09:00").trim();
  if (!/^\d{1,2}:\d{2}$/.test(start)) start = "08:00";
  if (!/^\d{1,2}:\d{2}$/.test(end)) end = "09:00";
  return {
    id: uid(),
    name,
    dayOfWeek: day,
    startTime: start,
    endTime: end,
    color: (raw.color || raw.颜色 || PRESET_COLORS[day % PRESET_COLORS.length]).trim(),
    location: (raw.location || raw.地点 || "").trim(),
    teacher: (raw.teacher || raw.教师 || "").trim(),
  };
}
