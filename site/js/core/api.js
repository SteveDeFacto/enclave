/* ============================================================
   Live client (Enclave) — the exact client the pages use; mirrors
   the published HTTP API. Base URL persists across pages via
   localStorage (the Deploy page exposes the field).
   ============================================================ */
import { DEFAULT_API_BASE } from "./config.js";
import { lsGet, lsSet } from "./util.js";

/* ---- typed error carrying HTTP status ---- */
export class EnclaveError extends Error {
  constructor(message, status, body){ super(message); this.name = "EnclaveError"; this.status = status; this.body = body; }
}

export const Enclave = {
  base: (lsGet("enclave_api_base") || DEFAULT_API_BASE).replace(/\/+$/, ""),
  token: null, address: null, chainId: null, provider: null, walletRdns: null, walletEmail: null,
  setBase(u){ this.base = String(u || "").trim().replace(/\/+$/, "") || DEFAULT_API_BASE; lsSet("enclave_api_base", this.base); },
  authed(){ return !!this.token; },
  async _req(method, path, opts){
    opts = opts || {};
    let url = this.base + path;
    if (opts.query){
      const qs = Object.entries(opts.query)
        .filter(([, v]) => v !== undefined && v !== null && v !== "")
        .map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&");
      if (qs) url += "?" + qs;
    }
    const headers = { "Accept": "application/json" };
    const hasBody = opts.body !== undefined;
    if (hasBody) headers["Content-Type"] = "application/json";
    if (opts.auth){
      if (!this.token) throw new EnclaveError("Not signed in. Connect your wallet first.", 401);
      headers["Authorization"] = "Bearer " + this.token;
    }
    let res;
    try {
      res = await fetch(url, { method, headers, mode: "cors", body: hasBody ? JSON.stringify(opts.body) : undefined });
    } catch(e){
      throw new EnclaveError("Could not reach " + url + ". Check the endpoint is live and returns CORS headers.", 0);
    }
    const text = await res.text();
    let data = null;
    if (text){ try { data = JSON.parse(text); } catch(e){ data = text; } }
    if (!res.ok){
      const msg = (data && data.message) ? data.message
        : (typeof data === "string" && data) ? data
        : ("HTTP " + res.status + " " + res.statusText);
      throw new EnclaveError(msg, res.status, data);
    }
    return data;
  },
  /* Auth (public) */
  getNonce(address){ return this._req("GET", "/auth/nonce", { query: { address } }); },
  login(message, signature){ return this._req("POST", "/auth/login", { body: { message, signature } }); },
  /* Account */
  getAccount(){ return this._req("GET", "/account", { auth: true }); },
  topup(id){ return this._req("POST", "/deployments/" + encodeURIComponent(id) + "/topup", { auth: true }); },
  /* Pricing (public) */
  getPricing(){ return this._req("GET", "/pricing"); },
  getAvailability(){
    // served at the ROOT origin, not under /v1 (the spec's own servers note) -
    // calling BASE/v1/availability 404s and spams the console
    const url = (this.base || "").replace(/\/v1\/?$/, "") + "/availability";
    return fetch(url, { headers: { "Accept": "application/json" } }).then(r => {
      if (!r.ok) throw new EnclaveError("availability: HTTP " + r.status, r.status);
      return r.json();
    });
  },
  /* Deployments */
  createDeployment(body){ return this._req("POST", "/deployments", { auth: true, body }); },
  listDeployments(query){ return this._req("GET", "/deployments", { auth: true, query }); },
  getDeployment(id){ return this._req("GET", "/deployments/" + encodeURIComponent(id), { auth: true }); },
  terminateDeployment(id){ return this._req("DELETE", "/deployments/" + encodeURIComponent(id), { auth: true }); },
  logs(id, query){ return this._req("GET", "/deployments/" + encodeURIComponent(id) + "/logs", { auth: true, query }); },
  attestation(id){ return this._req("GET", "/deployments/" + encodeURIComponent(id) + "/attestation", { auth: true }); },
  /* System (public) */
  health(){ return this._req("GET", "/health"); },
  version(){ return this._req("GET", "/version"); }
};
