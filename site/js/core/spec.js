/* ============================================================
   OpenAPI spec access + schema tools. The spec used to be
   inlined into the page (1,900 lines, duplicating openapi.json
   byte for byte); it is now fetched once and cached here.
   Callers that render from it await loadSpec() first.
   ============================================================ */
import { esc } from "./util.js";

let SPEC = null;
let _loading = null;

export function loadSpec(){
  if (SPEC) return Promise.resolve(SPEC);
  if (!_loading) _loading = fetch("openapi.json", { headers: { "Accept": "application/json" } })
    .then(r => { if (!r.ok) throw new Error("openapi.json: HTTP " + r.status); return r.json(); })
    .then(j => (SPEC = j))
    .catch(e => { _loading = null; throw e; });
  return _loading;
}
export function getSpec(){ return SPEC; }   // null until loadSpec() resolves

/* ---- schema ref resolution + example synthesis ---- */
export function resolveRef(ref) {
  const parts = ref.replace(/^#\//, "").split("/");
  let o = SPEC; for (const p of parts) o = o && o[p];
  return o;
}
export function deref(s) { let g = 0; while (s && s.$ref && g < 24) { s = resolveRef(s.$ref); g++; } return s; }
export function refName(s) { return s && s.$ref ? s.$ref.split("/").pop() : null; }

export function schemaExample(schema) {
  schema = deref(schema);
  if (!schema) return null;
  if ("example" in schema) return schema.example;
  if (schema.enum) return schema.enum[0];
  if ("default" in schema) return schema.default;
  switch (schema.type) {
    case "object": {
      const o = {}, props = schema.properties || {};
      for (const k in props) o[k] = schemaExample(props[k]);
      return o;
    }
    case "array":   return [schemaExample(schema.items || {})];
    case "integer":
    case "number":  return 0;
    case "boolean": return true;
    case "string":  return schema.format === "date-time" ? "2026-06-26T17:05:00Z" : "string";
    default:        return null;
  }
}

export function typeLabel(schema) {
  const r = deref(schema);
  if (!r) return "any";
  if (r.type === "array") {
    const it = r.items || {};
    const inner = refName(it) || (deref(it) || {}).type || "any";
    return "array&lt;" + esc(inner) + "&gt;";
  }
  let t = refName(schema) || r.type || "object";
  t = esc(t);
  if (r.format) t += ' <span class="sopt">&lt;' + esc(r.format) + "&gt;</span>";
  return t;
}

/* recursive schema tree for the API viewer */
export function schemaTree(schema, name, required, depth) {
  depth = depth || 0;
  const r = deref(schema) || {};
  let line = '<div class="srow">';
  if (name !== undefined) line += '<span class="skey">' + esc(name) + "</span>";
  if (required) line += '<span class="sreq">*</span>';
  if (name !== undefined) line += '<span class="sopt">: </span>';
  line += '<span class="stype">' + typeLabel(schema) + "</span>";
  if (r.enum) line += ' <span class="sopt">(' + r.enum.map(esc).join(" | ") + ")</span>";
  if ("default" in r) line += ' <span class="sopt">= ' + esc(JSON.stringify(r.default)) + "</span>";
  const desc = (schema && schema.description) || r.description;
  if (desc) line += '  <span class="sdesc">// ' + esc(desc) + "</span>";
  line += "</div>";
  let kids = "";
  if (depth < 6) {
    if (r.type === "object" && r.properties) {
      const reqd = r.required || [];
      for (const k in r.properties) kids += schemaTree(r.properties[k], k, reqd.includes(k), depth + 1);
    } else if (r.type === "array" && r.items) {
      kids += schemaTree(r.items, "items", false, depth + 1);
    }
  }
  return kids ? line + '<div class="sindent">' + kids + "</div>" : line;
}

export function bodyExample(op) {
  const rb = op.requestBody; if (!rb) return null;
  const sch = rb.content && rb.content["application/json"] && rb.content["application/json"].schema;
  return sch ? schemaExample(sch) : null;
}
export function bodySchema(op) {
  const rb = op.requestBody; if (!rb) return null;
  return rb.content && rb.content["application/json"] && rb.content["application/json"].schema;
}
/* success + example for a response code */
export function responseExample(resp) {
  const sch = resp && resp.content && resp.content["application/json"] && resp.content["application/json"].schema;
  return sch ? schemaExample(sch) : null;
}

export function collectOps() {
  const out = [];
  for (const path in SPEC.paths) {
    const item = SPEC.paths[path];
    for (const m of ["get", "post", "patch", "delete", "put"]) {
      if (item[m]) out.push({ method: m.toUpperCase(), path, op: item[m] });
    }
  }
  return out;
}
