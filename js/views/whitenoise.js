// 白噪音视图：用 WebAudio 实时合成环境音，无需任何音频文件
import { db } from "../db.js";
import { h, toast } from "../util.js";

const TYPES = [
  { key: "white", name: "白噪音", ico: "⚪" },
  { key: "pink", name: "粉噪音", ico: "🌸" },
  { key: "brown", name: "棕噪音", ico: "🟤" },
  { key: "rain", name: "雨声", ico: "🌧️" },
  { key: "waves", name: "海浪", ico: "🌊" },
  { key: "wind", name: "风声", ico: "🍃" },
];

let actx = null;
let current = null; // { src, gain, lfo }
let playing = null; // key
let volume = 0.5;

function ensureCtx() {
  if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
  if (actx.state === "suspended") actx.resume();
  return actx;
}

function baseBuffer(type) {
  const ctx = ensureCtx();
  const len = ctx.sampleRate * 2;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  if (type === "pink") {
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.12;
    }
  } else if (type === "brown") {
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    }
  } else {
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }
  return buf;
}

function stopCurrent() {
  if (!current) return;
  try { current.src.stop(); } catch (e) {}
  try { current.lfo && current.lfo.stop(); } catch (e) {}
  try { current.src.disconnect(); current.gain.disconnect(); } catch (e) {}
  current = null;
}

function play(key) {
  if (playing === key) {
    stopCurrent();
    playing = null;
    paint();
    return;
  }
  stopCurrent();
  const ctx = ensureCtx();
  const src = ctx.createBufferSource();
  src.buffer = baseBuffer(key === "waves" ? "brown" : key === "rain" || key === "wind" ? "white" : key);
  src.loop = true;
  let node = src;
  if (key === "rain") {
    const f = ctx.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = 1600; f.Q.value = 0.5;
    src.connect(f); node = f;
  } else if (key === "wind") {
    const f = ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 500;
    src.connect(f); node = f;
  }
  const gain = ctx.createGain();
  gain.gain.value = volume;
  node.connect(gain); gain.connect(ctx.destination);

  let lfo = null;
  if (key === "waves" || key === "wind") {
    lfo = ctx.createOscillator();
    lfo.frequency.value = key === "waves" ? 0.12 : 0.2;
    const lg = ctx.createGain(); lg.gain.value = volume * 0.6;
    lfo.connect(lg); lg.connect(gain.gain); lfo.start();
  }
  src.start();
  current = { src, gain, lfo };
  playing = key;
  paint();
}

export async function renderWhiteNoise(root) {
  root.innerHTML = "";
  volume = (await db.getSetting("noiseVol", 0.5)) || 0.5;

  root.appendChild(h("div", { class: "card" },
    h("div", { class: "row spread" },
      h("b", {}, "🎧 专注环境音"),
      h("span", { class: "muted" }, playing ? "播放中…" : "已停止")
    ),
    h("input", {
      type: "range", min: "0", max: "1", step: "0.05", value: String(volume),
      style: "width:100%; margin-top:12px;",
      oninput: (e) => {
        volume = +e.target.value;
        db.setSetting("noiseVol", volume);
        if (current) current.gain.gain.value = volume;
      },
    }),
    h("div", { class: "muted", style: "font-size:12px; margin-top:4px;" }, "音量 " + Math.round(volume * 100) + "%")
  ));

  const grid = h("div", { class: "noise-grid", style: "margin-top:12px;" });
  for (const t of TYPES) {
    grid.appendChild(h("div", {
      class: "noise-btn" + (playing === t.key ? " on" : ""),
      "data-k": t.key,
      onclick: () => { try { play(t.key); } catch (e) { toast("无法播放：" + (e.message || e)); } },
    },
      h("div", { class: "n-ico" }, t.ico),
      h("div", { class: "n-name" }, t.name)
    ));
  }
  root.appendChild(grid);
  root.appendChild(h("div", { class: "muted", style: "font-size:12px; margin-top:12px; line-height:1.6;" },
    "声音由设备实时合成，无需联网、不上传。配合番茄钟使用，专注更沉浸。"));
}

function paint() {
  document.querySelectorAll(".noise-btn").forEach((b) => {
    b.classList.toggle("on", b.dataset.k === playing);
  });
  const tag = document.querySelector("#view .muted");
}
