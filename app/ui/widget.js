const { listen } = window.__TAURI__.event;
const { isPermissionGranted, requestPermission, sendNotification } =
  window.__TAURI__.notification;
const { invoke } = window.__TAURI__.core;
const winApi = window.__TAURI__.window;
const appWin = winApi.getCurrentWindow();

// Ghostty 标签编号映射（通过辅助功能读取）
let tabMap = [];
async function refreshTabs() {
  try {
    tabMap = await invoke("cc_tabs");
  } catch (_) {
    tabMap = [];
  }
  render(last);
}
// 给每个会话分配一个不重复的 Ghostty 标签（同名项目按顺序占用不同标签）
function buildAssignments(sessions) {
  const used = new Set();
  const map = {};
  for (const s of sessions) {
    const idx = tabMap.findIndex(
      (t, i) => !used.has(i) && t.title && t.title.includes(s.project)
    );
    if (idx >= 0) {
      used.add(idx);
      map[s.sessionId] = { win: tabMap[idx].win, tab: tabMap[idx].tab };
    }
  }
  return map;
}

// 把窗口贴到主屏右下角，并随展开/收起改大小（避免大块死区挡住终端）
const WIN_W = 268;
const PILL_H = 52;
const ROW_H = 46;
const LIST_PAD = 16;
async function layout() {
  try {
    const n = last.sessions.length || 1;
    const h = expanded ? PILL_H + n * ROW_H + LIST_PAD + 24 : PILL_H + 8;
    const mon = await winApi.primaryMonitor();
    const scale = mon.scaleFactor || 1;
    const sw = mon.size.width / scale;
    const sh = mon.size.height / scale;
    const margin = 14;
    await appWin.setSize(new winApi.LogicalSize(WIN_W, h));
    await appWin.setPosition(
      new winApi.LogicalPosition(Math.round(sw - WIN_W - margin), Math.round(sh - h - margin))
    );
  } catch (_) {}
}
let lastSig = "";
function maybeLayout() {
  const sig = expanded + ":" + (last.sessions.length || 0);
  if (sig !== lastSig) {
    lastSig = sig;
    layout();
  }
}

const COLORS = {
  working: "#f59e0b",
  waiting: "#ef4444",
  attention: "#60a5fa",
  idle: "#22c55e",
};
const LABEL = {
  working: "工作中",
  waiting: "需要交互",
  attention: "空闲等待",
  idle: "空闲/完成",
};
const $ = (s) => document.querySelector(s);

let expanded = false;
let last = { sessions: [], agg: "idle" };

function dur(sec) {
  const d = Math.floor(Date.now() / 1000) - sec;
  return d < 60 ? d + "s" : Math.floor(d / 60) + "m";
}

function render(p) {
  const agg = p.agg;
  const dot = $("#wdot");
  dot.style.background = COLORS[agg];
  dot.style.boxShadow = "0 0 12px " + COLORS[agg];
  dot.style.animation = agg === "waiting" ? "blink .6s steps(1) infinite" : "none";

  const waiting = p.sessions.filter((s) => s.state === "waiting").length;
  const attention = p.sessions.filter((s) => s.state === "attention").length;
  $("#wtxt").textContent = waiting
    ? waiting + " 个等你交互"
    : attention
    ? attention + " 个空闲等待"
    : agg === "working"
    ? "工作中"
    : "全部就绪";

  const asn = buildAssignments(p.sessions);
  const ordered = [...p.sessions].sort((a, b) => {
    const A = asn[a.sessionId];
    const B = asn[b.sessionId];
    if (A && B) return A.win - B.win || A.tab - B.tab;
    if (A) return -1;
    if (B) return 1;
    return 0;
  });
  $("#list").innerHTML =
    ordered
      .map((s) => {
        const a = asn[s.sessionId];
        const no = a ? "⌘" + a.tab : "";
        const data = a ? `data-win="${a.win}" data-tab="${a.tab}"` : "";
        return `
      <div class="row ${s.state === "waiting" ? "hot" : ""}" ${data} title="点击跳转到该标签">
        <span class="rdot" style="background:${COLORS[s.state]};box-shadow:0 0 7px ${COLORS[s.state]}"></span>
        <div><div class="rname">${s.project}${no ? ` <span class="rcmd">${no}</span>` : ""}</div><div class="rstate">${LABEL[s.state]}</div></div>
        <span class="rdur">${dur(s.updatedAt)}</span>
      </div>`;
      })
      .join("") ||
    '<div class="row"><div class="rstate">无活跃会话</div></div>';

  maybeLayout();
}

// ---- sound ----
const SOUND_KEY = "cctl_sound";
function soundOn() {
  return localStorage.getItem(SOUND_KEY) !== "off";
}
function beep() {
  if (!soundOn()) return;
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.connect(g);
    g.connect(ac.destination);
    o.type = "sine";
    o.frequency.setValueAtTime(880, ac.currentTime);
    o.frequency.setValueAtTime(660, ac.currentTime + 0.12);
    g.gain.setValueAtTime(0.0001, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.25, ac.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.32);
    o.start();
    o.stop(ac.currentTime + 0.34);
  } catch (_) {}
}

// ---- notification ----
async function ensureNotifyPerm() {
  let granted = await isPermissionGranted();
  if (!granted) granted = (await requestPermission()) === "granted";
  return granted;
}
ensureNotifyPerm();

// ---- events ----
listen("state-update", (e) => {
  last = e.payload;
  render(last);
});

listen("alert", async (e) => {
  beep();
  if (await isPermissionGranted()) {
    sendNotification({
      title: "CC 状态灯",
      body: (e.payload.project || "某会话") + " 需要你确认",
    });
  }
});

$("#wbody").addEventListener("click", () => {
  expanded = !expanded;
  $("#list").classList.toggle("show", expanded);
  layout();
  if (expanded) refreshTabs();
});

$("#list").addEventListener("click", (e) => {
  const row = e.target.closest(".row[data-win]");
  if (row)
    invoke("cc_jump_index", {
      win: parseInt(row.dataset.win, 10),
      tab: parseInt(row.dataset.tab, 10),
    });
});
$("#wbody").addEventListener("contextmenu", (ev) => {
  ev.preventDefault();
  localStorage.setItem(SOUND_KEY, soundOn() ? "off" : "on");
  $("#wtxt").textContent = "提示音" + (soundOn() ? "开" : "关");
});

setInterval(() => render(last), 5000);
setInterval(() => {
  if (expanded) refreshTabs();
}, 4000);
render(last);
