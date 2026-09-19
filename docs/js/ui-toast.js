/**
 * TrendPublish 全站统一提示条（toast）
 *
 * 背景：这个提示条原先在 5 个页面里各复制了一份（CSS + showToast 函数），
 * 结果是 publish.html 修好了「提示被弹窗遮罩压暗」的问题，其他 4 页仍是旧的
 * 右下角 12px 小灰字 —— 样式持续漂移。现在收敛到这一个文件。
 *
 * 用法：
 *   <div class="toast" id="toast"></div>          <!-- 可留可删，脚本会自建 -->
 *   <script src="./js/ui-toast.js"></script>      <!-- 必须在调用方脚本之前 -->
 *
 *   showToast("草稿已保存", "success");   // success | error | info（默认 info）
 *
 * 设计要点：
 * - 顶部居中，不放在右下角（注意力盲区）
 * - z-index:60，高于 .modal-overlay(20)，否则会被弹窗遮罩压暗
 * - success / error / info 三态用不同颜色 + 圆形图标区分
 * - 自注入 <style>，页面无需再写 toast 相关 CSS
 * - 幂等：重复引入或页面已自建 #toast 元素都不会出问题
 */
(function () {
  "use strict";

  if (window.__tpToastReady) {
    return;
  }
  window.__tpToastReady = true;

  var STYLE_ID = "tp-toast-style";
  var ICONS = { success: "✓", error: "✕", info: "i" };
  var DURATIONS = { success: 3000, error: 4200, info: 2400 };

  var CSS = [
    ".toast {",
    "  position: fixed;",
    "  top: 26px;",
    "  left: 50%;",
    "  transform: translate(-50%, -14px) scale(0.97);",
    "  display: flex;",
    "  align-items: center;",
    "  gap: 10px;",
    "  min-width: 220px;",
    "  max-width: min(560px, 88vw);",
    "  padding: 13px 20px;",
    "  border-radius: 14px;",
    "  background: rgba(18, 24, 32, 0.985);",
    "  border: 1px solid rgba(255, 255, 255, 0.14);",
    "  box-shadow: 0 18px 46px rgba(0, 0, 0, 0.55);",
    "  color: var(--text, #e8e6e2);",
    "  font-size: 15px;",
    "  font-weight: 600;",
    "  line-height: 1.4;",
    "  white-space: pre-wrap;",
    "  opacity: 0;",
    "  pointer-events: none;",
    "  transition: opacity 0.22s ease, transform 0.28s cubic-bezier(0.22, 1, 0.36, 1);",
    "  z-index: 60;",
    "}",
    ".toast.show {",
    "  opacity: 1;",
    "  transform: translate(-50%, 0) scale(1);",
    "}",
    ".toast-icon {",
    "  width: 26px;",
    "  height: 26px;",
    "  border-radius: 50%;",
    "  display: grid;",
    "  place-items: center;",
    "  font-size: 14px;",
    "  font-weight: 700;",
    "  flex: none;",
    "}",
    ".toast.info .toast-icon {",
    "  background: rgba(148, 163, 184, 0.22);",
    "  color: #cbd5e1;",
    "}",
    ".toast.success {",
    "  border-color: rgba(110, 231, 183, 0.5);",
    "  box-shadow: 0 18px 46px rgba(0, 0, 0, 0.55), 0 0 0 4px rgba(110, 231, 183, 0.1);",
    "}",
    ".toast.success .toast-icon {",
    "  background: rgba(110, 231, 183, 0.2);",
    "  color: #6ee7b7;",
    "}",
    ".toast.error {",
    "  border-color: rgba(244, 114, 182, 0.55);",
    "  box-shadow: 0 18px 46px rgba(0, 0, 0, 0.55), 0 0 0 4px rgba(244, 114, 182, 0.1);",
    "}",
    ".toast.error .toast-icon {",
    "  background: rgba(244, 114, 182, 0.2);",
    "  color: #f472b6;",
    "}",
  ].join("\n");

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  var toastEl = null;
  var iconEl = null;
  var textEl = null;
  var hideTimer = null;

  function buildElement() {
    var el = document.getElementById("toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "toast";
      (document.body || document.documentElement).appendChild(el);
    }
    // 统一内部结构：图标 + 文字（旧页面里可能是个空 div，这里重建内容）
    el.textContent = "";
    el.classList.remove("success", "error");
    el.classList.add("info");
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");

    iconEl = document.createElement("span");
    iconEl.className = "toast-icon";
    textEl = document.createElement("span");
    textEl.className = "toast-text";
    el.appendChild(iconEl);
    el.appendChild(textEl);
    return el;
  }

  function ensureElement() {
    if (!toastEl || !toastEl.isConnected || !iconEl || !textEl) {
      toastEl = buildElement();
    }
    return toastEl;
  }

  /**
   * @param {string} message 提示文案
   * @param {"success"|"error"|"info"} [type] 语义类型，决定颜色与图标
   */
  window.showToast = function (message, type) {
    ensureStyle();
    var el = ensureElement();
    var kind = Object.prototype.hasOwnProperty.call(ICONS, type) ? type : "info";

    textEl.textContent = message == null ? "" : String(message);
    iconEl.textContent = ICONS[kind];

    el.classList.remove("success", "error", "info", "show");
    // 强制重排：连续两次提示时也能重放进入动画
    void el.offsetWidth;
    el.classList.add(kind, "show");

    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(function () {
      el.classList.remove("show");
    }, DURATIONS[kind]);
  };

  ensureStyle();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ensureStyle);
  }
})();
