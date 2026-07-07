/* ============================================================
   EnclaveElement — a Lightning-Web-Components-flavored base class
   for the site's custom elements (tags register under the `c-`
   namespace, like LWC's).

   Like LWC, every component is a folder-bundle of three files:

     components/header/
       header.html    the template
       header.js      the component class
       header.css     its styles (stitched into the site
                          bundle at build time — the same "not
                          scoped" behavior as LWC light DOM)

   What it mirrors from LWC:
     • the .js/.html pairing: `static templateUrl` points at the
       component's own .html (one line instead of LWC's implicit
       pairing); the base class fetches it once per CLASS, caches
       it, and renders every instance from it
     • `{property}` bindings in the template: any declared
       property name in braces is substituted, HTML-escaped
     • a default <slot>: the component's as-authored children are
       captured on first connect and re-inserted wherever the
       template says <slot></slot>
     • reactive public properties: `static properties` declares
       them (like @api); assigning one re-renders, and each is
       seeded from the matching HTML attribute
     • reactive private state: this.track({...}) returns a proxy
       (like @track); mutating it re-renders
     • the LWC lifecycle names: connectedCallback,
       renderedCallback, disconnectedCallback, errorCallback
     • events: this.dispatch('name', detail) sends a composed,
       bubbling CustomEvent

   What it deliberately does differently: components render into
   LIGHT DOM (LWC's `renderMode = 'light'`) so the site's global
   stylesheet and Tailwind utilities apply without shadow-DOM
   plumbing. Set `static renderMode = 'shadow'` to opt into a
   shadow root (the compiled stylesheet is adopted into it).
   ============================================================ */

const escHtml = (s) => String(s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/* template literal tag for components that build markup in JS; joins parts
   verbatim, arrays are joined, null/undefined become "" */
export const html = (strings, ...vals) =>
  strings.reduce((out, s, i) => {
    const v = vals[i - 1];
    return out + (Array.isArray(v) ? v.join("") : v == null ? "" : String(v)) + s;
  });

export class EnclaveElement extends HTMLElement {
  static renderMode = "light";          // 'light' | 'shadow'
  static properties = {};               // { propName: defaultValue } — @api-like
  static templateUrl = null;            // new URL("./<name>.html", import.meta.url)

  constructor() {
    super();
    this._renderScheduled = false;
    this._connected = false;
    const props = this.constructor.properties || {};
    for (const [name, def] of Object.entries(props)) {
      let value = this.hasAttribute(name) ? this.getAttribute(name) : def;
      Object.defineProperty(this, name, {
        get: () => value,
        set: (v) => { if (v !== value) { value = v; this.requestRender(); } },
      });
    }
  }

  /* @track-like reactive state: mutate the returned proxy → re-render */
  track(obj) {
    const el = this;
    return new Proxy(obj, {
      set(t, k, v) { if (t[k] !== v) { t[k] = v; el.requestRender(); } return true; },
      deleteProperty(t, k) { delete t[k]; el.requestRender(); return true; },
    });
  }

  get root() { return this.shadowRoot || this; }

  connectedCallback() {
    if (this.constructor.renderMode === "shadow" && !this.shadowRoot) {
      this.attachShadow({ mode: "open" });
      const link = document.querySelector('link[rel="stylesheet"]');
      if (link) this.shadowRoot.appendChild(link.cloneNode());   // share the site stylesheet
    }
    if (this._slotContent == null) this._slotContent = Array.from(this.childNodes);   // authored children → <slot>
    this._connected = true;
    this._render();
  }

  disconnectedCallback() { this._connected = false; }

  /* batch prop/state changes into one render per microtask */
  requestRender() {
    if (!this._connected || this._renderScheduled) return;
    this._renderScheduled = true;
    queueMicrotask(() => { this._renderScheduled = false; this._render(); });
  }

  /* Fetch the paired .html once per CLASS and cache it in sessionStorage,
     so every navigation after the first renders the component synchronously
     (no template round trip, no chrome pop-in) — which also guarantees the
     header/footer exist at first paint for cross-document view transitions. */
  _render() {
    const ctor = this.constructor;
    if (ctor.templateUrl && ctor._tpl == null) {
      const key = "enclave_tpl:" + ctor.templateUrl.pathname;
      try { const c = sessionStorage.getItem(key); if (c != null) ctor._tpl = c; } catch (e) {}
    }
    if (ctor.templateUrl && ctor._tpl == null) {
      if (!ctor._tplLoading) ctor._tplLoading = fetch(ctor.templateUrl)
        .then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); })
        .then(t => {
          ctor._tpl = t;
          try { sessionStorage.setItem("enclave_tpl:" + ctor.templateUrl.pathname, t); } catch (e) {}
        })
        .catch(e => { ctor._tplLoading = null; throw e; });
      ctor._tplLoading.then(
        () => { if (this._connected) this._renderNow(); },
        (e) => console.error("[" + this.tagName.toLowerCase() + "] template " + ctor.templateUrl + " failed:", e));
      return;
    }
    this._renderNow();
  }

  _renderNow() {
    try {
      // data-ssr = build-time prerendered (scripts/build-site.mjs baked the
      // template into the page HTML): HYDRATE - leave the DOM as-is and only
      // run renderedCallback (wiring, async fills). LWC's SSR+hydrate model.
      const tpl = this.hasAttribute("data-ssr") ? null : this.render();
      if (tpl != null) {
        this.root.innerHTML = tpl;
        const slot = this.root.querySelector("slot");
        if (slot) slot.replaceWith(...(this._slotContent || []));
      }
      if (typeof this.renderedCallback === "function") this.renderedCallback();
    } catch (e) {
      if (typeof this.errorCallback === "function") this.errorCallback(e);
      else console.error("[" + this.tagName.toLowerCase() + "] render failed:", e);
    }
  }

  /* default render: the paired template with {property} bindings substituted.
     Override for fully computed markup (return html`…`), or return null to
     leave the as-authored DOM alone. */
  render() {
    const tpl = this.constructor._tpl;
    return tpl == null ? null : this.interpolate(tpl);
  }

  /* {name} → escaped property value, for declared properties only (stray
     braces in markup never match) */
  interpolate(tpl) {
    let out = tpl;
    for (const name of Object.keys(this.constructor.properties || {}))
      out = out.split("{" + name + "}").join(escHtml(this[name]));
    return out;
  }

  dispatch(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }
}

/* define a component once (hot-reload / double-import safe) */
export function register(tag, cls) {
  if (!customElements.get(tag)) customElements.define(tag, cls);
}
