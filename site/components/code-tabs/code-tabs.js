/* ============================================================
   <c-code-tabs>
     <c-code tab="Linux / macOS" os="linux mac" fn="…">…</c-code>
     <c-code tab="Windows" os="windows" fn="…">…</c-code>
     <c-code tab="git + npm" fn="…">…</c-code>
   </c-code-tabs>
   A tab bar over a group of <c-code> panels: one panel visible
   at a time, the default picked by the visitor's user agent
   (each panel's `os` attr lists the platforms it serves:
   windows | mac | linux; no match falls back to the first
   panel). `tab` is the button label. Without JavaScript the
   bar never appears and the panels simply stack.
   ============================================================ */
import { EnclaveElement, register } from "../../js/lib/enclave-element.js";

class CodeTabs extends EnclaveElement {
  static templateUrl = new URL("./code-tabs.html", import.meta.url);

  renderedCallback() {
    const wrap = this.querySelector(".code-tabs");
    const bar = this.querySelector(".code-tabs-bar");
    if (!wrap || !bar || bar._wired) return;
    const panels = Array.from(this.querySelectorAll("c-code"));
    if (!panels.length) return;
    bar._wired = true;

    const select = (i) => {
      panels.forEach((p, j) => { p.style.display = j === i ? "" : "none"; });
      bar.querySelectorAll("button").forEach((b, j) => {
        b.classList.toggle("on", j === i);
        b.setAttribute("aria-selected", String(j === i));
      });
    };
    panels.forEach((p, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "tab");
      b.textContent = p.getAttribute("tab") || p.getAttribute("fn") || "tab " + (i + 1);
      b.addEventListener("click", () => select(i));
      bar.appendChild(b);
    });

    const ua = navigator.userAgent || "";
    const os = /windows/i.test(ua) ? "windows"
      : /mac os x|macintosh/i.test(ua) ? "mac"
      : "linux";
    const hit = panels.findIndex(p => (p.getAttribute("os") || "").split(/\s+/).includes(os));
    wrap.classList.add("wired");
    select(hit === -1 ? 0 : hit);
  }
}
register("c-code-tabs", CodeTabs);
