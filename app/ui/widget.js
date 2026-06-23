const { listen, emit } = window.__TAURI__.event;
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

// 「刚完成」绿的有效期：idle 且距上次更新不超过此秒数才算“待查看”
const DONE_TTL = 300;
const PEEK_PRIO = { waiting: 2, idle: 1 };
const viewed = new Set();   // 已点开查看过的绿（跳转后标记，状态再变时清除）
let jumpCursor = 0;
let prevGreen = false;      // 绿框边沿触发用

function nowSecs() { return Math.floor(Date.now() / 1000); }
function isPending(s) {
  if (s.state === "waiting") return true;
  if (s.state === "idle" && nowSecs() - s.updatedAt < DONE_TTL) return true;
  return false;
}
// 待响应集合（带 tab 分配），按 红>绿、再 (win,tab) 升序
function pendingList() {
  const asn = buildAssignments(last.sessions);
  return last.sessions
    .filter((s) => isPending(s) && !viewed.has(s.sessionId))
    .map((s) => ({ ...s, asn: asn[s.sessionId] }))
    .sort((a, b) => {
      const pa = PEEK_PRIO[a.state] || 0, pb = PEEK_PRIO[b.state] || 0;
      if (pa !== pb) return pb - pa;
      const A = a.asn, B = b.asn;
      if (A && B) return A.win - B.win || A.tab - B.tab;
      return A ? -1 : B ? 1 : 0;
    });
}
function hasPending() { return last.sessions.some((s) => isPending(s) && !viewed.has(s.sessionId)); }

function dur(sec) {
  const d = Math.floor(Date.now() / 1000) - sec;
  return d < 60 ? d + "s" : Math.floor(d / 60) + "m";
}

function renderPeek() {
  // 清理已失效的“已查看”标记：会话没了或不再是 idle 就移除
  for (const id of [...viewed]) {
    const s = last.sessions.find((x) => x.sessionId === id);
    if (!s || s.state !== "idle") viewed.delete(id);
  }
  const pl = pendingList();
  const peek = $("#peek");
  if (!pl.length) { peek.classList.remove("show"); maybeGreen(false); return; }
  if (jumpCursor >= pl.length) jumpCursor = 0;
  const cur = pl[0]; // 动作条始终显示最紧急的那一个
  $("#adot").style.background = COLORS[cur.state];
  $("#adot").style.boxShadow = "0 0 7px " + COLORS[cur.state];
  $("#adot").style.animation = cur.state === "waiting" ? "blink .6s steps(1) infinite" : "none";
  const cmd = cur.asn ? ` <span class="rcmd">⌘${cur.asn.tab}</span>` : "";
  $("#aname").innerHTML = cur.project + cmd;
  $("#astate").textContent = LABEL[cur.state] + " · " + dur(cur.updatedAt);
  $("#amore").textContent = pl.length > 1 ? "+" + (pl.length - 1) : "";
  peek.classList.add("show");
  // 绿框：无红 且 有刚完成绿 → 触发一次
  const hasWaiting = pl.some((x) => x.state === "waiting");
  maybeGreen(!hasWaiting && pl.some((x) => x.state === "idle"));
}

function maybeGreen(on) {
  if (on && !prevGreen) emit("done-alert");
  prevGreen = on;
}

function jumpTo(item) {
  if (!item || !item.asn) return;
  invoke("cc_jump_index", { win: item.asn.win, tab: item.asn.tab });
  if (item.state === "idle") viewed.add(item.sessionId); // 绿点了=已查看
  renderPeek();
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

  renderPeek();
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

listen("hotkey-cycle", async () => {
  await refreshTabs();          // 确保 tabMap 最新（药丸没展开过时也能跳）
  const pl = pendingList();
  if (!pl.length) return;
  const item = pl[jumpCursor % pl.length];
  jumpTo(item);
  jumpCursor = (jumpCursor + 1) % pl.length; // 下次跳下一个
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
$("#actionbar").addEventListener("click", () => {
  const pl = pendingList();
  if (pl.length) jumpTo(pl[0]);
});
$("#wbody").addEventListener("contextmenu", (ev) => {
  ev.preventDefault();
  localStorage.setItem(SOUND_KEY, soundOn() ? "off" : "on");
  $("#wtxt").textContent = "提示音" + (soundOn() ? "开" : "关");
});

setInterval(() => render(last), 5000);
setInterval(() => {
  if (expanded || hasPending()) refreshTabs();
}, 4000);
render(last);
