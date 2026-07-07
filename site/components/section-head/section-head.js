/* ============================================================
   <c-section-head eyebrow="…" heading="…" [flush]>
     <p>rich description…</p>   ← slotted
   </c-section-head>
   The eyebrow + h2 + description pattern that opens every
   section on the site. `flush` drops the bottom margin (the API
   reference header sits in a flex row).
   ============================================================ */
import { EnclaveElement, register } from "../../js/lib/enclave-element.js";

class SectionHead extends EnclaveElement {
  static properties = { eyebrow: "", heading: "" };
  static templateUrl = new URL("./section-head.html", import.meta.url);
}
register("c-section-head", SectionHead);
