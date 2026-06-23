const { listen } = window.__TAURI__.event;
const border = document.getElementById("border");

function fire(cls) {
  border.classList.remove("fire", "firegreen");
  void border.offsetWidth; // 强制 reflow 重启动画
  border.classList.add(cls);
}

listen("alert", () => fire("fire"));          // 红：需要确认
listen("done-alert", () => fire("firegreen")); // 绿：刚完成
