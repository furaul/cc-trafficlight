const { listen } = window.__TAURI__.event;
const { isPermissionGranted, requestPermission, sendNotification } =
  window.__TAURI__.notification;

const COLORS = { working: "#f59e0b", waiting: "#ef4444", idle: "#22c55e" };
const LABEL = { working: "工作中", waiting: "需要交互", idle: "空闲/完成" };
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
  $("#wtxt").textContent = waiting
    ? waiting + " 个等你交互"
    : agg === "working"
    ? "工作中"
    : "全部就绪";

  $("#list").innerHTML =
    p.sessions
      .map(
        (s) => `
      <div class="row ${s.state === "waiting" ? "hot" : ""}">
        <span class="rdot" style="background:${COLORS[s.state]};box-shadow:0 0 7px ${COLORS[s.state]}"></span>
        <div><div class="rname">${s.project}</div><div class="rstate">${LABEL[s.state]}</div></div>
        <span class="rdur">${dur(s.updatedAt)}</span>
      </div>`
      )
      .join("") ||
    '<div class="row"><div class="rstate">无活跃会话</div></div>';
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
});
$("#wbody").addEventListener("contextmenu", (ev) => {
  ev.preventDefault();
  localStorage.setItem(SOUND_KEY, soundOn() ? "off" : "on");
  $("#wtxt").textContent = "提示音" + (soundOn() ? "开" : "关");
});

setInterval(() => render(last), 5000);
render(last);
