"use strict";

const $ = (id) => document.getElementById(id);
const ICON = {
  ac: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="8" rx="2.5"/><path d="M7 16c0 1.5-1 2-1 3.5M12 16c0 1.5-1 2-1 3.5M17 16c0 1.5-1 2-1 3.5"/></svg>',
  light: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3Z"/></svg>',
  tv: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="12" rx="2.5"/><path d="M8 21h8M12 17v4"/></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z"/></svg>',
  door: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 8l-4 4 4 4M6 12h10"/></svg>',
};
const SCENE_ICON = { night: ICON.moon, out: ICON.door };
const SCENE_HINT = { night: "消灯・就寝設定", out: "すべてOFF" };
const MODES = { cool: "冷房", heat: "暖房", dry: "除湿", fan: "送風", auto: "自動" };
const FANS = { auto: "自動", low: "弱", mid: "中", high: "強" };
const INPUTS = { HDMI1: "HDMI 1", HDMI2: "HDMI 2", TV: "地上波" };

let S = null;           // サーバーから受け取った状態
let timers = {};        // 連打をまとめるための待ち時間
let toastTimer;

function toast(msg, err = false) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.toggle("err", err);
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), err ? 3600 : 1800);
}

function setConn(ok) {
  const c = $("conn");
  c.className = "conn " + (ok ? "ok" : "ng");
  c.querySelector("b").textContent = ok ? "接続中" : "つながりません";
  document.body.classList.toggle("offline", !ok);
}

async function api(path, body) {
  try {
    const res = await fetch(path, body === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const data = await res.json();
    setConn(true);
    return data;
  } catch {
    setConn(false);
    return { ok: false, error: "ラズパイに接続できません" };
  }
}

function adopt(data) {
  if (data.devices) { S = data; renderAll(); }
}

async function command(device, values, { action = "set", quiet = false } = {}) {
  const card = $("card-" + device);
  card.classList.add("busy");
  const data = await api("/api/command", { device, action, values });
  card.classList.remove("busy");
  if (data.ok) { adopt(data); if (!quiet) toast(data.message); }
  else { toast(data.error, true); refresh(); }
}

// 同じ機器への連続操作は、最後の値だけをまとめて送る
function commandSoon(device, values, ms = 450) {
  Object.assign(S.devices[device], values);
  renderCard(device);
  clearTimeout(timers[device]);
  timers[device] = setTimeout(() => command(device, values), ms);
}

async function runScene(id) {
  const btn = document.querySelector(`[data-scene="${id}"]`);
  btn.classList.add("busy");
  const data = await api(`/api/scenes/${id}/run`, {});
  btn.classList.remove("busy");   // 成功時は再描画で作り直されるが、失敗時のために戻す
  if (data.ok) { adopt(data); toast(data.message); } else toast(data.error, true);
}

async function refresh() { adopt(await api("/api/state")); }

function ago(ts) {
  if (!ts) return "未送信";
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return "たった今";
  if (s < 3600) return `${Math.floor(s / 60)}分前`;
  if (s < 86400) return `${Math.floor(s / 3600)}時間前`;
  return `${Math.floor(s / 86400)}日前`;
}

function seg(items, current, attr) {
  return `<div class="seg" role="group">${Object.entries(items).map(([k, v]) =>
    `<button data-${attr}="${k}" aria-pressed="${k === current}">${v}</button>`).join("")}</div>`;
}

function head(icon, title, sub, on) {
  return `<div class="card-head">
    <div class="card-title"><span class="ico">${icon}</span><div><h2>${title}</h2><p>${sub}</p></div></div>
    <button class="switch" data-power aria-pressed="${on}" aria-label="${title}の電源"></button>
  </div>`;
}

const ARC = 395.8, RING = 527.8;

// エアコンは骨組みを1回だけ作り、以後は値だけ書き換える(つまみや数字を滑らかに動かすため)
function renderAircon(d, el) {
  if (!el.querySelector(".dial")) {
    el.innerHTML = head(ICON.ac, "エアコン", "", d.power) + `
      <div class="dial">
        <svg viewBox="0 0 200 200" aria-hidden="true">
          <circle class="track" cx="100" cy="100" r="84" stroke-dasharray="${ARC} ${RING}"/>
          <circle class="fill" cx="100" cy="100" r="84" stroke-dasharray="${ARC} ${RING}"/>
          <circle class="knob" r="10"/>
        </svg>
        <div class="center"><div class="temp"></div><div class="sub">設定温度</div></div>
        <button class="step minus" data-step="-1" aria-label="温度を下げる">−</button>
        <button class="step plus" data-step="1" aria-label="温度を上げる">＋</button>
      </div>
      <div class="seg-label">運転モード</div>${seg(MODES, d.mode, "mode")}
      <div class="seg-label">風量</div>${seg(FANS, d.fan, "fan")}
      <div class="est"><span><span class="badge">推定</span><span class="sent"></span></span>
        <button class="resend" data-resend>実機に再送</button></div>`;
  }
  const { tempMin: lo, tempMax: hi } = S.limits;
  const frac = (d.temp - lo) / (hi - lo);
  const theta = frac * 270 * Math.PI / 180;   // svg は 135° 回転済みなので 0° 起点で計算できる
  el.dataset.mode = d.mode;
  el.querySelector("[data-power]").setAttribute("aria-pressed", d.power);
  el.querySelector(".card-title p").textContent = d.power ? `${MODES[d.mode]} ・ 風量 ${FANS[d.fan]}` : "停止中";
  el.querySelector(".fill").style.strokeDashoffset = ARC * (1 - frac);
  const knob = el.querySelector(".knob");
  knob.style.cx = (100 + 84 * Math.cos(theta)) + "px";
  knob.style.cy = (100 + 84 * Math.sin(theta)) + "px";
  const temp = el.querySelector(".temp");
  if (temp.dataset.v !== String(d.temp)) {
    const first = temp.dataset.v === undefined;
    temp.innerHTML = `${d.temp}<sup>℃</sup>`;
    temp.dataset.v = d.temp;
    if (!first) { temp.classList.remove("bump"); void temp.offsetWidth; temp.classList.add("bump"); }
  }
  el.querySelector(".minus").disabled = d.temp <= lo;
  el.querySelector(".plus").disabled = d.temp >= hi;
  el.querySelectorAll("[data-mode]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.mode === d.mode));
  el.querySelectorAll("[data-fan]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.fan === d.fan));
  el.querySelector(".sent").textContent = `最後に送信: ${ago(d.sentAt)}`;
}

function renderCard(device) {
  const d = S.devices[device];
  const el = $("card-" + device);
  el.classList.toggle("on", d.power);

  if (device === "aircon") {
    renderAircon(d, el);
  } else if (device === "light") {
    if (document.activeElement && document.activeElement.id === "level") return;  // ドラッグ中は作り直さない
    el.innerHTML = head(ICON.light, "照明", d.power ? `明るさ ${d.level}%` : "消灯中", d.power) + `
      <div class="slider"><label for="level">明るさ <output>${d.level}%</output></label>
        <input id="level" type="range" min="10" max="100" step="10" value="${d.level}" style="--p:${(d.level - 10) / 90 * 100}%"></div>`;
  } else {
    el.innerHTML = head(ICON.tv, "テレビ", d.power ? INPUTS[d.input] : "電源OFF", d.power) +
      seg(INPUTS, d.input, "input");
  }
}

const DEVICE_NAME = { aircon: "エアコン", light: "照明", tv: "テレビ" };

function describeSend(device, p) {
  if (device === "aircon") return p.power ? `${MODES[p.mode]} ${p.temp}℃・風量${FANS[p.fan]}` : "停止";
  if (device === "light") return p.power ? `点灯 明るさ${p.level}%` : "消灯";
  return p.power ? `電源ON・${INPUTS[p.input]}` : "電源OFF";
}

function renderLog() {
  const el = $("card-log");
  $("demo").hidden = !S.dummy;
  el.hidden = !S.dummy;       // 実機の送信に切り替えたら、ダミー用の表示は消える
  if (!S.dummy) return;
  const rows = S.log.map((e) => {
    const t = new Date(e.at * 1000);
    const hms = [t.getHours(), t.getMinutes(), t.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
    return `<li><time>${hms}</time><span>${DEVICE_NAME[e.device]}: ${describeSend(e.device, e.params)}</span></li>`;
  }).join("");
  el.innerHTML = `<div class="card-head"><div class="card-title"><div><h2>送信ログ</h2><p>送信したはずの内容(実際には送られません)</p></div></div><span class="badge">ダミー送信</span></div>` +
    (rows ? `<ol>${rows}</ol>` : `<p class="empty">まだ送信していません</p>`);
}

function renderAll() {
  const app = $("app");
  if (app.classList.contains("loading")) {      // 初回だけ登場アニメーション
    app.classList.remove("loading");
    app.classList.add("enter");
    setTimeout(() => app.classList.remove("enter"), 900);
  }
  $("scenes").innerHTML = S.scenes.map((s) =>
    `<button class="scene ${s.id}" data-scene="${s.id}">${SCENE_ICON[s.id] || ""}<span><small>${SCENE_HINT[s.id] || ""}</small><strong>${s.name}</strong></span></button>`).join("");
  ["aircon", "light", "tv"].forEach(renderCard);
  renderLog();
  renderAi();
}

// 操作は親要素でまとめて受ける(再描画しても効く)
document.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b || !S) return;
  const card = b.closest(".card");
  const device = card && card.id.replace("card-", "");
  if (b.dataset.scene) return runScene(b.dataset.scene);
  if (b.hasAttribute("data-power")) return command(device, { power: !S.devices[device].power });
  if (b.dataset.step) {
    const { tempMin: lo, tempMax: hi } = S.limits;
    const t = Math.min(hi, Math.max(lo, S.devices.aircon.temp + Number(b.dataset.step)));
    // 停止中に温度を触ったら、そのまま運転開始とみなす
    return commandSoon("aircon", { temp: t, power: true });
  }
  if (b.dataset.mode) return command("aircon", { mode: b.dataset.mode, power: true });
  if (b.dataset.fan) return command("aircon", { fan: b.dataset.fan });
  if (b.dataset.input) return command("tv", { input: b.dataset.input, power: true });
  if (b.hasAttribute("data-resend")) return command("aircon", {}, { action: "resend" });
});

document.addEventListener("input", (e) => {
  if (e.target.id !== "level") return;
  const v = Number(e.target.value);
  e.target.style.setProperty("--p", ((v - 10) / 90 * 100) + "%");
  e.target.closest(".slider").querySelector("output").textContent = v + "%";
});
document.addEventListener("change", (e) => {
  if (e.target.id === "level") commandSoon("light", { level: Number(e.target.value), power: true }, 0);
});

// 表示の切り替え(ライト/ダーク)。選んだ内容はこの端末のブラウザに覚えさせる
const THEME_COLOR = { light: "#f4f5f8", dark: "#0c0e14" };

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  $("theme-color").setAttribute("content", THEME_COLOR[t]);
  const btn = $("theme");
  btn.setAttribute("aria-pressed", t === "dark");
  btn.setAttribute("aria-label", t === "dark" ? "ライト表示に切り替える" : "ダーク表示に切り替える");
}

function savedTheme() {
  try { return localStorage.getItem("theme"); } catch { return null; }
}

applyTheme(document.documentElement.dataset.theme);
$("theme").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  try { localStorage.setItem("theme", next); } catch { /* 保存できなくても切り替えは効く */ }
  applyTheme(next);
});
// まだボタンで選んでいない間は、端末の設定が変わったら追従する
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
  if (!savedTheme()) applyTheme(e.matches ? "dark" : "light");
});

// 話しかけて操作(音声は、iPhoneのキーボードのマイクで入力できる)
const AI_EXAMPLES = ["暑いから冷房つけて", "電気を消して", "もう寝るよ", "24度の暖房にして"];

function renderAi() {
  $("ai-engine").textContent = S.ai.engine === "claude" ? `AIで解釈(${S.ai.model})` : "簡易解釈(AI未接続)";
  const chips = $("ai-chips");
  if (!chips.children.length) {
    chips.innerHTML = AI_EXAMPLES.map((t) => `<button type="button" data-ai-example="${t}">${t}</button>`).join("");
  }
}

async function sendAi(text) {
  const input = $("ai-input"), btn = $("ai-send"), out = $("ai-result"), card = $("card-ai");
  text = text.trim();
  if (!text) return;
  btn.disabled = true;
  out.className = "ai-result";
  out.textContent = "考え中…";
  const data = await api("/api/ai", { text });
  btn.disabled = false;
  if (data.ok) {
    adopt(data);
    out.textContent = data.message;
    if (data.note) out.insertAdjacentHTML("beforeend", `<small>${data.note}</small>`);
    card.classList.toggle("on", data.executed);
    if (data.executed) input.value = "";
  } else {
    out.className = "ai-result err";
    out.textContent = data.error;
  }
}

$("ai-form").addEventListener("submit", (e) => { e.preventDefault(); sendAi($("ai-input").value); });
$("ai-chips").addEventListener("click", (e) => {
  const b = e.target.closest("[data-ai-example]");
  if (!b) return;
  $("ai-input").value = b.dataset.aiExample;
  sendAi(b.dataset.aiExample);
});

// 外の気温・湿度(ラズパイが天気サービスから取得したもの。部屋の実測ではない)
const WX_ICON = {
  temp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0Z"/><path d="M12 9v7"/></svg>',
  humi: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3s6 6.2 6 10.5a6 6 0 0 1-12 0C6 9.2 12 3 12 3Z"/></svg>',
};

async function loadWeather() {
  const el = $("wx");
  const data = await api("/api/weather");
  const w = data.ok && data.weather;
  el.classList.toggle("empty", !w);
  if (!w) { el.textContent = "外の気温・湿度を取得できません"; return; }
  const t = new Date(w.observedAt);
  const hm = String(t.getHours()).padStart(2, "0") + ":" + String(t.getMinutes()).padStart(2, "0");
  el.innerHTML = `
    <div>${WX_ICON.temp}<span><small>${w.place}の気温</small><b>${w.temp.toFixed(1)}<i>℃</i></b></span></div>
    <div class="humi">${WX_ICON.humi}<span><small>${w.place}の湿度</small><b>${Math.round(w.humidity)}<i>%</i></b></span></div>
    <div class="wx-note">外の天気データ ${hm} 時点(部屋の実測ではありません)</div>`;
}
loadWeather();
setInterval(() => { if (!document.hidden) loadWeather(); }, 10 * 60 * 1000);

$("today").textContent = new Date().toLocaleDateString("ja-JP", { month: "long", day: "numeric", weekday: "long" });
refresh();
setInterval(() => { if (!document.hidden) refresh(); }, 15000);   // 他の端末の操作を反映
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
