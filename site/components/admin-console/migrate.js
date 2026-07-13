/* ============================================================
   Contract-data migration engine for the admin console.

   Moves EVERYTHING out of a live contract into a freshly deployed
   import-capable revision: read the old contract's full state via
   its public getters, replay it verbatim through the new
   contract's owner-gated import functions, read the target back
   and diff it field-by-field, then permanently seal the imports.

   Encoding: the same minimal hand-rolled ABI codec philosophy as
   js/core/chain.js, extended here with dynamic arrays and tuple[]
   (the import functions take the EXACT structs the getters
   return, so one schema drives both the decode of the source and
   the encode of the import - pinned against viem in
   test/admin-console.test.mjs).

   No DOM in this module: it returns data + ready-to-send tx
   plans; the component drives the wallet and paints progress.
   ============================================================ */
import { baseRpc, pad32, encUint, encStr, encBytesTail, hexBig,
         decodeStructArray, DEP_SCHEMA, DEP_SCHEMA_V1, APP_SCHEMA, VER_SCHEMA } from "../../js/core/chain.js";
import { CONTRACTS } from "../../js/gen/contract-artifacts.js";

/* ---- codec: tuples + arrays on top of chain.js's word encoders ---- */

export function encTuple(schema, obj) {
  let off = schema.length * 32; const heads = [], tails = [];
  for (const f of schema) {
    const v = obj[f.k];
    if (f.t === "str") { const e = encStr(String(v ?? "")); heads.push(encUint(off)); off += e.words * 32; tails.push(e.body); }
    else if (f.t === "uint") heads.push(encUint(v ?? 0));
    else if (f.t === "bool") heads.push(encUint(v ? 1 : 0));
    else heads.push(pad32(String(v || "0x0").replace(/^0x/, "")));   // addr | bytes32
  }
  const body = heads.join("") + tails.join("");
  return { body, words: body.length / 64 };
}

export function encTupleArr(schema, rows) {
  let off = rows.length * 32; const heads = [], tails = [];
  for (const r of rows) { const e = encTuple(schema, r); heads.push(encUint(off)); off += e.words * 32; tails.push(e.body); }
  const body = encUint(rows.length) + heads.join("") + tails.join("");
  return { body, words: body.length / 64 };
}

/* encCall extended with array/tuple args:
   {t:"tuple[]", schema, v:[objs]} · {t:"str[]"|"bytes[]"|"uint[]"|"bool[]"|"addr[]"|"bytes32[]", v}
   (any uintN[] uses "uint[]" - the width only matters to the selector, which
   comes from viem via the artifacts). Scalars as in chain.js encCall. */
export function encCallX(selector, args) {
  let off = args.length * 32; const heads = [], tails = [];
  const dyn = (body) => { heads.push(encUint(off)); off += (body.length / 64) * 32; tails.push(body); };
  for (const a of args) {
    if (a.t === "tuple[]") dyn(encTupleArr(a.schema, a.v).body);
    else if (a.t === "str[]" || a.t === "bytes[]") {
      let eoff = a.v.length * 32; const eheads = [], etails = [];
      for (const s of a.v) {
        const body = a.t === "str[]" ? encStr(String(s ?? "")).body : encBytesTail(s || "0x");
        eheads.push(encUint(eoff)); eoff += (body.length / 64) * 32; etails.push(body);
      }
      dyn(encUint(a.v.length) + eheads.join("") + etails.join(""));
    } else if (a.t && a.t.endsWith("[]")) {
      const words = a.v.map((v) => a.t === "uint[]" ? encUint(v) : a.t === "bool[]" ? encUint(v ? 1 : 0) : pad32(String(v).replace(/^0x/, "")));
      dyn(encUint(a.v.length) + words.join(""));
    } else if (a.t === "str") { const e = encStr(a.v); heads.push(encUint(off)); off += e.words * 32; tails.push(e.body); }
    else if (a.t === "uint") heads.push(encUint(a.v));
    else if (a.t === "bool") heads.push(encUint(a.v ? 1 : 0));
    else heads.push(pad32(String(a.v).replace(/^0x/, "")));
  }
  return "0x" + selector + heads.join("") + tails.join("");
}

/* ---- low-level reads ---- */

const call = (to, data) => baseRpc("eth_call", [{ to, data }, "latest"]);
const word = (hex, i) => (hex || "").replace(/^0x/, "").slice(i * 64, i * 64 + 64);
const wNum = (hex, i) => Number(hexBig("0x" + (word(hex, i) || "0")));
const wAddr = (hex, i) => "0x" + word(hex, i).slice(24);
const wB32 = (hex, i) => "0x" + word(hex, i);

/* has the target got the import surface, and is it still open?
   old revisions revert on the selector -> "not import-capable". */
export async function importState(target, contractName) {
  try {
    const r = await call(target, "0x" + CONTRACTS[contractName].sel.importsSealed);
    if (!r || r === "0x") return { capable: false };
    return { capable: true, sealed: hexBig(r) !== 0n };
  } catch (e) { return { capable: false }; }
}

/* ---- per-kind engines ----
   Each kind: { label, contractName, bookKey,
                read(source) -> data, counts(data) -> string,
                plan(data) -> [{label, dataHex}]  (txs to send TO the target),
                verify(data, target) -> {total, ok, bad: [labels]} } */

const PAGE = 50;
const CHUNK = { deployments: 12, apps: 20, versions: 25, volumes: 30, members: 15 };

/* -- deployments -- */
// Struct-schema revision sniff (same idea as the catalog's): rev-1 sources
// have no deploymentsSchema getter (the call reverts) and their Deployment
// tuples carry the removed sshPubKey string - decode those with the v1
// schema and drop the field, so the import always encodes the rev-2 tuple.
async function depRevOf(addr) {
  const sel = CONTRACTS.EnclaveDeployments.sel;
  try { return wNum(await call(addr, "0x" + sel.deploymentsSchema), 0) || 1; }   // word 0 of the return
  catch (e) { return 1; }
}
async function readDeployments(source) {
  const sel = CONTRACTS.EnclaveDeployments.sel;
  const schema = (await depRevOf(source)) >= 2 ? DEP_SCHEMA : DEP_SCHEMA_V1;
  const total = wNum(await call(source, "0x" + sel.count), 0);
  const rows = [];
  for (let s = 0; s < total; s += PAGE)
    rows.push(...decodeStructArray(await call(source, encCallX(sel.getPage, [{ t: "uint", v: s }, { t: "uint", v: PAGE }])), schema));
  return rows.map(({ sshPubKey, ...r }) => r);
}
const depKey = (d) => d.id;
const depClean = (d) => ({ ...d, runner: "0x" + "0".repeat(64), runnerOperator: "0x" + "0".repeat(40), leaseUntil: 0 });
const depCmp = (a, b) => DEP_SCHEMA.every((f) => ["runner", "runnerOperator", "leaseUntil"].includes(f.k)
  || String(a[f.k]).toLowerCase() === String(b[f.k]).toLowerCase());

/* -- catalog -- */
// Struct-schema revision sniff: rev-4 catalogs' VERSION tuples carry
// `config`; a source without the marker getter (call reverts) is rev 2;
// rev 3 (the retired app-level-config layout, 0xa036d5e8…) has config-LESS
// versions - decode both pre-4 shapes WITHOUT config and default the field,
// so the migration reads clean and the import encodes the full rev-4 tuple.
// (Rev-3 App tuples carry a trailing app-level config; decoding them with
// the 9-field APP_SCHEMA is a safe prefix read - that field is dropped,
// deliberately: nothing in rev 4 stores app-level config.)
const VER_SCHEMA_V2 = VER_SCHEMA.filter((f) => f.k !== "config");
async function catalogRevOf(addr) {
  const sel = CONTRACTS.EnclaveAppCatalog.sel;
  // wNum's 2nd arg is the WORD INDEX (the return is one word at index 0) -
  // it was 2, so this always fell back to rev 2 and readCatalog prefix-
  // decoded rev-4 versions config-LESS: a silent config drop the verify pass
  // couldn't see (both sides dropped it). Deployments hit the loud version
  // of the same bug (mid-struct field -> every row garbled, 0/N verify).
  try { return wNum(await call(addr, "0x" + sel.catalogSchema), 0) || 2; }
  catch (e) { return 2; }
}
async function readCatalog(source) {
  const sel = CONTRACTS.EnclaveAppCatalog.sel;
  const rev = await catalogRevOf(source);
  const verSchema = rev >= 4 ? VER_SCHEMA : VER_SCHEMA_V2;
  const total = wNum(await call(source, "0x" + sel.appCount), 0);
  const apps = [];
  for (let s = 0; s < total; s += PAGE)
    apps.push(...decodeStructArray(await call(source, encCallX(sel.getAppsPage, [{ t: "uint", v: s }, { t: "uint", v: PAGE }])), APP_SCHEMA));
  for (const a of apps) {
    a.versions = [];
    for (let s = 0; s < a.versionCount; s += PAGE)
      a.versions.push(...decodeStructArray(await call(source, encCallX(sel.getVersionsPage, [{ t: "bytes32", v: a.appId }, { t: "uint", v: s }, { t: "uint", v: PAGE }])), verSchema));
    if (rev < 4) for (const v of a.versions) v.config = "";
  }
  return apps;
}
const appCmp = (a, b) => APP_SCHEMA.every((f) => String(a[f.k]).toLowerCase() === String(b[f.k]).toLowerCase());
const verCmp = (a, b) => VER_SCHEMA.every((f) => String(a[f.k]).toLowerCase() === String(b[f.k]).toLowerCase());

/* -- volumes -- */
async function volCreationBlock(source) {
  // binary-search the deployment block via eth_getCode (the first revision has
  // no enumeration, so discovery is a VolumeCreated log scan from creation)
  let lo = 0n, hi = hexBig(await baseRpc("eth_blockNumber", []));
  const codeAt = async (b) => (await baseRpc("eth_getCode", [source, "0x" + b.toString(16)])) !== "0x";
  if (!(await codeAt(hi))) throw new Error("no code at source address");
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if (await codeAt(mid)) hi = mid; else lo = mid + 1n;
  }
  return lo;
}
async function readVolumes(source) {
  const sel = CONTRACTS.EnclaveVolumeAccess.sel;
  let volIds = [];
  try {   // import-capable revisions enumerate; the first revision needs the log scan
    const r = await call(source, "0x" + sel.volCount);
    if (!r || r === "0x") throw new Error("no enumeration");
    const n = wNum(r, 0);
    for (let i = 0; i < n; i++) volIds.push(wB32(await call(source, encCallX(sel.volIdAt, [{ t: "uint", v: i }])), 0));
  } catch (e) {
    const from = await volCreationBlock(source);
    const latest = hexBig(await baseRpc("eth_blockNumber", []));
    const topic = CONTRACTS.EnclaveVolumeAccess.evt.VolumeCreated;
    for (let b = from; b <= latest; b += 45000n) {
      const to = (b + 44999n) > latest ? latest : (b + 44999n);
      const logs = await baseRpc("eth_getLogs", [{ address: source, topics: [topic],
        fromBlock: "0x" + b.toString(16), toBlock: "0x" + to.toString(16) }]);
      for (const l of logs || []) volIds.push(l.topics[1]);
    }
    volIds = [...new Set(volIds)];
  }
  const vols = [];
  for (const id of volIds) {
    const v = await call(source, encCallX(sel.getVolume, [{ t: "bytes32", v: id }]));
    if (hexBig("0x" + word(v, 1)) === 0n) continue;                    // !exists (retired id)
    const vol = { volId: id, owner: wAddr(v, 0), createdAt: wNum(v, 2), members: [] };
    const n = wNum(v, 3);
    for (let i = 0; i < n; i++) {
      const addr = wAddr(await call(source, encCallX(sel.memberAt, [{ t: "bytes32", v: id }, { t: "uint", v: i }])), 0);
      vol.members.push({ addr, ...(await readMember(source, id, addr)) });
    }
    vols.push(vol);
  }
  return vols;
}
async function readMember(source, volId, addr) {
  // getMember -> (uint8 role, bytes32 pubkey, bool registered, bytes sealedVEK, uint64 updatedAt)
  const sel = CONTRACTS.EnclaveVolumeAccess.sel;
  const r = await call(source, encCallX(sel.getMember, [{ t: "bytes32", v: volId }, { t: "addr", v: addr }]));
  const off = wNum(r, 3), len = Number(hexBig("0x" + (r.replace(/^0x/, "").slice(off * 2, off * 2 + 64) || "0")));
  const sealedVEK = "0x" + r.replace(/^0x/, "").slice(off * 2 + 64, off * 2 + 64 + len * 2);
  return { role: wNum(r, 0), pubkey: wB32(r, 1), registered: hexBig("0x" + word(r, 2)) !== 0n, sealedVEK, updatedAt: wNum(r, 4) };
}
const memCmp = (a, b) => a.role === b.role && a.pubkey.toLowerCase() === b.pubkey.toLowerCase()
  && a.updatedAt === b.updatedAt && a.sealedVEK.toLowerCase() === b.sealedVEK.toLowerCase();

const chunked = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

/* Fold the planned import calls into multicall(bytes[]) transactions so a
   whole migration usually rides ONE wallet confirmation. Greedy packing by
   rough per-call gas estimates against a per-tx budget (well under Base's
   block limit; the wallet still estimates the real number before signing).
   Inner auth is untouched - multicall delegatecalls self, msg.sender holds. */
const GAS_BUDGET = 15_000_000;
function packPlan(contractName, txs) {
  if (txs.length <= 1) return txs;
  const sel = CONTRACTS[contractName].sel;
  const groups = [[]];
  let used = 0;
  for (const t of txs) {
    const g = t.gas || 1_000_000;
    if (groups[groups.length - 1].length && used + g > GAS_BUDGET) { groups.push([]); used = 0; }
    groups[groups.length - 1].push(t); used += g;
  }
  return groups.map((g) => g.length === 1 ? g[0] : {
    label: `multicall · ${g.length} calls (${g.map((t) => t.label.split(" ·")[0]).filter((v, i, a) => a.indexOf(v) === i).join(", ")})`,
    dataHex: encCallX(sel.multicall, [{ t: "bytes[]", v: g.map((t) => t.dataHex) }]),
  });
}

export const MIG_KINDS = {
  deployments: {
    label: "Deployments", contractName: "EnclaveDeployments", bookKey: "deployments",
    read: readDeployments,
    counts: (d) => `${d.length} deployment${d.length === 1 ? "" : "s"}`,
    /* delta plan: skip anything the target already holds, so an interrupted
       run resumes by re-clicking Migrate, and a second pass right before the
       book flips picks up records created on the source in the meantime. */
    plan(data, after) {
      const sel = CONTRACTS.EnclaveDeployments.sel;
      const have = new Set(after.map((d) => d.id.toLowerCase()));
      const todo = data.filter((d) => !have.has(d.id.toLowerCase())).map(depClean);
      return packPlan("EnclaveDeployments", chunked(todo, CHUNK.deployments).map((c, i) => ({
        label: `importDeployments · batch ${i + 1} (${c.length})`,
        gas: 120_000 + 450_000 * c.length,
        dataHex: encCallX(sel.importDeployments, [{ t: "tuple[]", schema: DEP_SCHEMA, v: c }]),
      })));
    },
    async verify(data, target) {
      const after = await readDeployments(target);
      const byId = Object.fromEntries(after.map((d) => [d.id.toLowerCase(), d]));
      const bad = data.filter((d) => !byId[d.id.toLowerCase()] || !depCmp(d, byId[d.id.toLowerCase()]))
        .map((d) => d.id.slice(0, 10) + "… (" + d.appRef + ")");
      return { total: data.length, ok: data.length - bad.length, bad };
    },
  },
  catalog: {
    label: "App catalog", contractName: "EnclaveAppCatalog", bookKey: "appCatalog",
    read: readCatalog,
    counts: (d) => `${d.length} app${d.length === 1 ? "" : "s"}, ${d.reduce((n, a) => n + a.versions.length, 0)} versions`,
    plan(data, after) {
      const sel = CONTRACTS.EnclaveAppCatalog.sel;
      const have = Object.fromEntries(after.map((a) => [a.appId.toLowerCase(), a]));
      const newApps = data.filter((a) => !have[a.appId.toLowerCase()]);
      const txs = chunked(newApps, CHUNK.apps).map((c, i) => ({
        label: `importApps · batch ${i + 1} (${c.length})`,
        gas: 100_000 + 250_000 * c.length,
        dataHex: encCallX(sel.importApps, [{ t: "tuple[]", schema: APP_SCHEMA, v: c }]),
      }));
      for (const a of data) {
        // versions are append-only in publish order: the target holds a prefix
        const done = have[a.appId.toLowerCase()] ? have[a.appId.toLowerCase()].versions.length : 0;
        for (const [i, c] of chunked(a.versions.slice(done), CHUNK.versions).entries())
          txs.push({ label: `importVersions · ${a.slug} (${c.length}${done || i ? ", cont." : ""})`,
            gas: 100_000 + 300_000 * c.length,
            dataHex: encCallX(sel.importVersions, [{ t: "bytes32", v: a.appId }, { t: "tuple[]", schema: VER_SCHEMA, v: c }]) });
      }
      return packPlan("EnclaveAppCatalog", txs);
    },
    async verify(data, target) {
      const after = await readCatalog(target);
      const byId = Object.fromEntries(after.map((a) => [a.appId.toLowerCase(), a]));
      const bad = [];
      for (const a of data) {
        const t = byId[a.appId.toLowerCase()];
        if (!t || !appCmp(a, t)) { bad.push(a.slug); continue; }
        if (a.versions.length !== t.versions.length || !a.versions.every((v, i) => verCmp(v, t.versions[i])))
          bad.push(a.slug + " (versions)");
      }
      return { total: data.length, ok: data.length - bad.length, bad };
    },
  },
  volumes: {
    label: "Volume access", contractName: "EnclaveVolumeAccess", bookKey: "volumeAccess",
    read: readVolumes,
    counts: (d) => `${d.length} volume${d.length === 1 ? "" : "s"}, ${d.reduce((n, v) => n + v.members.length, 0)} members`,
    plan(data, after) {
      const sel = CONTRACTS.EnclaveVolumeAccess.sel;
      const have = Object.fromEntries(after.map((v) => [v.volId.toLowerCase(), v]));
      const newVols = data.filter((v) => !have[v.volId.toLowerCase()]);
      const txs = chunked(newVols, CHUNK.volumes).map((c, i) => ({
        label: `importVolumes · batch ${i + 1} (${c.length})`,
        gas: 80_000 + 100_000 * c.length,
        dataHex: encCallX(sel.importVolumes, [
          { t: "bytes32[]", v: c.map((v) => v.volId) },
          { t: "addr[]", v: c.map((v) => v.owner) },
          { t: "uint[]", v: c.map((v) => v.createdAt) }]),
      }));
      for (const v of data) {
        const done = have[v.volId.toLowerCase()];
        const doneAddrs = new Set(done ? done.members.map((m) => m.addr.toLowerCase()) : []);
        const todo = v.members.filter((m) => !doneAddrs.has(m.addr.toLowerCase()));
        for (const [i, c] of chunked(todo, CHUNK.members).entries())
          txs.push({ label: `importMembers · ${v.volId.slice(0, 10)}… (${c.length}${i ? ", cont." : ""})`,
            gas: 80_000 + 180_000 * c.length,
            dataHex: encCallX(sel.importMembers, [
              { t: "bytes32", v: v.volId },
              { t: "addr[]", v: c.map((m) => m.addr) },
              { t: "bytes32[]", v: c.map((m) => m.pubkey) },
              { t: "uint[]", v: c.map((m) => m.role) },
              { t: "uint[]", v: c.map((m) => m.updatedAt) },
              { t: "bytes[]", v: c.map((m) => m.sealedVEK) }]) });
      }
      return packPlan("EnclaveVolumeAccess", txs);
    },
    async verify(data, target) {
      const after = await readVolumes(target);
      const byId = Object.fromEntries(after.map((v) => [v.volId.toLowerCase(), v]));
      const bad = [];
      for (const v of data) {
        const t = byId[v.volId.toLowerCase()];
        if (!t || t.owner.toLowerCase() !== v.owner.toLowerCase() || t.createdAt !== v.createdAt) { bad.push(v.volId.slice(0, 10) + "…"); continue; }
        const tm = Object.fromEntries(t.members.map((m) => [m.addr.toLowerCase(), m]));
        if (!v.members.every((m) => tm[m.addr.toLowerCase()] && memCmp(m, tm[m.addr.toLowerCase()])))
          bad.push(v.volId.slice(0, 10) + "… (members)");
      }
      return { total: data.length, ok: data.length - bad.length, bad };
    },
  },
};

export function sealTx(contractName) {
  return "0x" + CONTRACTS[contractName].sel.sealImports;
}
