const { listen } = window.__TAURI__.event;
const border = document.getElementById("border");

listen("alert", () => {
  border.classList.remove("fire");
  void border.offsetWidth; // 强制 reflow 以重启动画
  border.classList.add("fire");
});
