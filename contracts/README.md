# Enclave on-chain discovery (EnclaveRegistry)

Transparent, gateway-free enclave discovery. The registry is the on-chain source
of truth for *which enclaves exist, where, and what code they claim*. Callers
read it from any RPC and connect to an enclave **directly**, verifying its live
attestation with Tinfoil's SecureClient. There is no trusted middleman: the
contract publishes claims, attestation (at connect time) gates trust.

```
caller --(eth_call)--> EnclaveRegistry            "enclave at URL, repo=org/repo"
caller --(/availability)--> each enclave      live free share (off-chain)
caller --(SecureClient(URL, repo))--> enclave verifies SEV-SNP/TDX + Sigstore, pins TLS
```

## Files
- `contracts/EnclaveRegistry.sol` — the registry (open, no deps, ~120 lines).
- `contracts/EnclaveRegistry.abi.json` — ABI for JS callers (re-emitted by the deploy script).
- `scripts/deploy-registry.mjs` — compile + deploy + wire config (mirrors the other deploy scripts).
- supervisor self-registration — built into `supervisor.js` (`registerOnChain`).
- `scripts/enclave-discover.mjs` — caller-side read + availability aggregation + pick.

## 1. Deploy the contract to Base (chain 8453)

No constructor args, no owner — the deployer keeps no special power. A viem+solc
script mirrors `deploy-app-catalog.mjs` and **wires `enclaves/gpu/tinfoil-config.yml`'s
`REGISTRY_ADDRESS` plus `enclave-discover.mjs`'s default automatically** on success
(pass `--no-write-config` to skip):

```bash
# compile + plan only, no broadcast:
DEPLOYER_PRIVATE_KEY=0x... node scripts/deploy-registry.mjs --dry-run --yes

# Base Sepolia (discovery reads only — the supervisor registers on MAINNET):
DEPLOYER_PRIVATE_KEY=0x... node scripts/deploy-registry.mjs

# Base MAINNET (what enclaves self-register against):
NETWORK=base DEPLOYER_PRIVATE_KEY=0x... node scripts/deploy-registry.mjs
```

> `registerOnChain` in `supervisor.js` signs on Base mainnet (viem `base`), so
> the registry enclaves advertise to must live on chain 8453. A Sepolia deploy
> is still useful to exercise `enclave-discover.mjs` (`BASE_RPC=https://sepolia.base.org`).

## 2. Give each enclave a registry config

The enclave self-registers on boot when `REGISTRY_ENABLED` is set. The supervisor
container's env in `enclaves/gpu/tinfoil-config.yml` already carries the block — the deploy
script fills in the address; the one value you set **per enclave** is its own URL:

```yaml
env:
  REGISTRY_ENABLED: "1"
  REGISTRY_ADDRESS: ""       # written by scripts/deploy-registry.mjs
  ENCLAVE_ENDPOINT: ""       # per enclave, e.g. "https://enclave1.enclave.host"; empty = don't advertise
  ENCLAVE_REPO: "EnclaveHost/enclave"          # what callers attest against (Sigstore-measured; exact GitHub casing — Sigstore compares it verbatim)
  # REGISTRY_HEARTBEAT_SEC: "900"           # optional, default 15 min
```

And the operator key as an **enclave secret** (not plaintext env — already listed
under `secrets:`), one EOA **per enclave** so concurrent heartbeats never fight
over an account nonce:
```
REGISTRY_PRIVATE_KEY = 0x...   # an EOA that owns this enclave's registry entry
```

> The key needs a little ETH on **Base** for gas: register is one tx at boot,
> then one cheap heartbeat every 15 min (~a few cents/month on Base). Fund the
> address before first boot or registration silently fails (non-fatal — the
> enclave still serves, it just won't advertise until it can pay gas).

On boot you'll see: `[registry] registered https://... repo=... id=0x... tx=0x...`
then periodic `[registry] heartbeat tx=0x...`.

`ENCLAVE_MEASUREMENT` is optional (a cross-check digest); leave unset (0x0) and
let the live attestation be authoritative, which it is regardless.

## 3. Callers discover + connect

Read the registry and aggregate availability (no gateway, runs anywhere):
```bash
REGISTRY_ADDRESS=0x... BASE_RPC=https://mainnet.base.org node scripts/enclave-discover.mjs 0.25 0.05
```
Prints aggregate free capacity across all live enclaves and the best one for a
deployment buying a 25% GPU share + 5% CPU share (args: gpuShare cpuShare,
0..1 each; gpuShare 0 for a CPU-only app: CPU enclaves first, GPU leftovers as
fallback — derive the minimum shares from the app's exact specs against each
enclave's /availability), ending with the endpoint+repo to hand to SecureClient.

Then connect with attestation (the part that actually gates trust):
```js
// JS/TS, browser or server
import { SecureClient } from "tinfoil";
const c = new SecureClient({ baseURL: chosen.endpoint /*, repo handling per tinfoil-js*/ });
await c.ready();                       // verifies SEV-SNP/TDX + Sigstore, pins TLS
await c.fetch("/availability");        // now provably talking to attested code
await c.fetch(`/x/${deploymentId}/run`, { method: "POST", body });
```
```go
// Go
import "github.com/tinfoilsh/verifier/client"
tc := client.NewSecureClient(chosen.endpoint, chosen.repo)
resp, _ := tc.Get("/availability", nil)
```

## Trust boundaries (what this does and does not do)
- **Discovery is trustless**: the enclave list is public chain state; no operator
  sits in the request path. Picking the wrong enclave costs placement, not safety.
- **Trust is gated by attestation at connect**, done by the caller's SecureClient
  — not by registration. A malicious operator can register an enclave, but its
  live quote won't match an Enclave-good `repo`/measurement, so callers reject it.
- **Liveness is advisory**: heartbeats set `lastSeen`; readers drop entries
  staler than their window (the helper uses 1h).
- **Open registration for now.** Sybil resistance via stake-to-register +
  slashing is a future add (see the note at the bottom of the .sol); it isn't
  needed for correctness because attestation, not registration, gates trust.

## Verify on first deploy
After one enclave registers:
```bash
node scripts/enclave-discover.mjs        # should list it with live availability
```
You should see it in `all[]` with real `gpuShareFree`/`cpuShareFree`, and `chosen` set. That's the
full loop: chain registry -> live availability -> a pick, with nothing trusted
in the middle.

---

# Enclave app store (EnclaveAppCatalog)

A second, independent on-chain contract: the public catalog of **Wasm apps**
users can browse and publish. Where `EnclaveRegistry` answers "which enclaves exist,"
`EnclaveAppCatalog` answers "which apps exist and where their code lives." It backs
the **Apps** tab on the site.

```
browser --(eth_call getAppsPage)------> EnclaveAppCatalog   apps: {appId,slug,name,desc,publisher,versionCount,active}
browser --(eth_call getVersionsPage)--> EnclaveAppCatalog   per app: {cid,version,vramMb,gpuGflops,memMb,cpuGflops,createdAt,verified,yanked,ports,approval,config}
browser --(fetch CID)-----------------> any IPFS peer   the .wasm bytes (hash == CID, verify yourself)
browser --(publishVersion tx)---------> EnclaveAppCatalog   one Base tx; publisher = msg.sender
```

## Two catalogs, on purpose

- **Attested, baked-in catalog** (`wasm/apps/catalog.json`) — curated apps compiled
  into the measured wasm-manager image. What the enclave runs today is exactly what
  attestation measured. Deploys reference these by id (e.g. `hello-world`).
- **On-chain community catalog** (`EnclaveAppCatalog`) — open discovery. Anyone
  publishes; each entry is a `wasi:http` component addressed by its **IPFS CID**.
  This is *discovery*, not custody or attestation: the catalog stores the CID (a
  hash of the exact wasm), never the bytes, so a caller fetches from any IPFS peer
  and verifies the bytes match the CID independently.

**Deploy a catalog version (implemented).** Listed apps deploy, not just browse —
once the catalog owner **approves** the version (see the trust model below;
unapproved versions get `403 not_approved`). Deployments are created **on-chain**
through `EnclaveDeployments` (see `DEPLOYMENTS.md`), and the deployment's `appRef`
is a **catalog reference**, `catalog://<appId>/<versionIndex>` — a pointer to the
approved catalog VERSION, not to raw bytes. **Raw CID references (`ipfs://<cid>`)
are refused by runners**: a CID names bytes, not a reviewed version, so a deployer
can never attach code or config the owner didn't approve. The store card's
**Use in Deploy** carries the friendly `slug:version`, which the browser resolves
against the on-chain catalog (unique because version labels are unique per app) to
the `catalog://<appId>/<versionIndex>` ref it records on-chain. Baked-in catalog ids
(`hello-world`) still deploy by id — they ship inside the attested wasm-manager image.

To run a version, the enclave's wasm-manager resolves it to the version's CID,
fetches that CID from `IPFS_GATEWAY` as a **CAR**, verifies every block hashes to
its CID and reassembles the file rooted at the requested CID (`wasm/ipfs_fetch.py`),
rejects anything that isn't a wasi:http component, caches it under `APPS_DIR`, and
runs it. A tampering gateway fails the hash check, so the operator's own gateway is
fine to use. The verified CID is folded into the attestation
(`getMeasurements().app.cid`), so "what ran = this exact CID" holds.

Manager env: `IPFS_GATEWAY` (default `https://ipfs.enclave.host`), `WASM_MAX_BYTES`
(default 2 GiB), `IPFS_FETCH_TIMEOUT`.

## Versioning & trust model
- An **app** is `appId = keccak256(publisher, slug)` — a slug in the publisher's own
  namespace. Because the appId embeds `msg.sender`, only you can ever write to your
  app; lineage ownership is structural, not a spoofable check, and slugs can't be
  squatted across publishers.
- `publishVersion(slug, …)` appends an **immutable Version** (its own CID, label, and
  the app's exact minimum resources on four axes, packed as
  `[vramMb, gpuGflops, memMb, cpuGflops]` — memory and compute of a GPU card and of a
  node (compute in GFLOPS = 1/1000 TFLOPS); runners calculate the allocation shares
  from them, and `cidStatus` returns them so runners refuse deployments that asked for
  less on any axis), creating the app on first use. Versions are append-only history;
  you don't edit a release, you publish a new one. `editApp` changes display metadata;
  `setActive` delists the whole app; `yankVersion` pulls a bad release (kept for
  history, hidden by readers).
- **CID ownership**: a wasm artifact belongs to the app that FIRST listed it — no
  other app can ever list the same CID, so a CID maps unambiguously into one
  lineage. The owning app may re-list its CID in a later version (the metadata
  fix: same bytes, corrected specs/ports); `cidStatus` then follows the newest
  listing, which starts Pending again.
- **Per-version firewall config** (`Version.ports`): a CSV of ports the release may
  bind — `http:N` / `tcp:N` / `udp:N` (empty = standard wasi:http web app). It can
  change from version to version. The store's **Use in Deploy** defaults the
  deployment's firewall from it; the enclave's wasm-manager grants wasi:sockets
  only when ports are declared, audits actual binds, and kills an app that binds
  an unassigned port. Ports are **logical** (labels 1-19999; 8080/8091
  infra-reserved; below 1024, e.g. `udp:53`, always remapped internally): every deployment gets its own actual loopback bind (passed to
  the app as `ENCLAVE_PORTS=tcp:5432=31245`, logical=actual), so any number of
  tenants can run the same app simultaneously with no port conflicts. Declared
  TCP ports are reached through the attested origin as a WebSocket bridge at
  `/x/{id}/tcp/{logical-port}`.
- **Per-version publisher fee** (`versionFee(appId, index)`, catalog schema rev 5;
  a side mapping, so App/Version tuples decode unchanged on every rev): a version
  may declare a per-second fee (USDC 6dp), capped at publish by the owner-set
  `maxFeePerSec6` (`setMaxFee`). Like config and ports it is immutable once
  published and covered by the owner's approval — re-pricing is a new version,
  re-reviewed like any release, so an approved app can never silently change its
  price. The catalog only records the number (discovery, not custody):
  EnclaveDeployments snapshots it at create and forwards the publisher's
  pro-rata cut of every funding straight to `App.publisher`'s wallet, and
  runners refuse to claim a deployment that under-declares the fee of the
  version it references (fail closed, the same off-chain gate as approval).
- `verified` is an OPTIONAL owner-curated signal, set **per version** (you verify a
  specific CID; a new release starts unverified and must be re-checked). It does
  **not** gate execution — the CID does. The site can filter to verified.
- **`approval` DOES gate API deploys.** Publishing stays permissionless, but every
  version starts **Pending** and the supervisor refuses to deploy its CID
  (`403 not_approved`) until the catalog **owner** — the EOA that deployed the
  contract — signs a `setApproval(appId, index, Approved)` transaction (Rejected is
  a standing "no"; only the owner can rule, enforced by the contract). Approval is
  per CID: a new release of the same app starts Pending again. The supervisor
  resolves deployability in one `cidStatus(cid)` eth_call (listed + app active +
  not yanked + Approved) against `APP_CATALOG_ADDRESS` from the enclave config,
  and **fails closed**: no catalog configured or RPC unreachable ⇒ no catalog-app
  deploys. Baked-in catalog ids (e.g. `hello-world`) are exempt — they ship inside the
  attested wasm-manager image. The site's Apps tab shows the per-version status
  badge and gives the owner wallet approve/reject buttons.

## Deploy the contract to Base (chain 8453)

No constructor args; the deployer EOA becomes `owner` (approves/rejects versions,
can flip `verified`, can `transferOwnership`). A viem+solc script mirrors
`deploy-enclave-pay.mjs` and **wires the site and `enclaves/gpu/tinfoil-config.yml` automatically**
on success:

```bash
# Base Sepolia dry run (compile + plan, no broadcast):
DEPLOYER_PRIVATE_KEY=0x... node scripts/deploy-app-catalog.mjs --dry-run --yes

# Base Sepolia deploy (auto-wires site to chain 84532 + the sepolia RPC):
DEPLOYER_PRIVATE_KEY=0x... node scripts/deploy-app-catalog.mjs

# Base MAINNET deploy (auto-wires site back to chain 8453 + mainnet RPC):
NETWORK=base DEPLOYER_PRIVATE_KEY=0x... node scripts/deploy-app-catalog.mjs
```

On a successful deploy it rewrites `APP_CATALOG_ADDRESS`, `APP_CATALOG_CHAIN`, and
`APP_CATALOG_RPC` in `site/index.html`, plus `APP_CATALOG_ADDRESS` in
the enclave configs so the supervisor enforces the approval gate against the same
deployment (pass `--no-write-config` to skip both). It also re-emits
`contracts/EnclaveAppCatalog.abi.json` from source on every run so the checked-in ABI
can't drift from what's deployed.

> **Deploy once.** Re-running deploys a *fresh, empty* contract at a new address
> (and, by default, repoints the site at it). Contracts are immutable — schema/logic
> changes mean a new deploy, so make them before apps are published.

## Wire the site (usually automatic)

The deploy script sets these for you; they only need hand-editing for IPFS or a
custom RPC. Five constants near the top of the page's script:

```js
const APP_CATALOG_ADDRESS = "0x…";                    // written by the deploy script
const APP_CATALOG_CHAIN   = 8453;                     // written by the deploy script (84532 = Base Sepolia)
const APP_CATALOG_RPC     = "https://mainnet.base.org"; // written by the deploy script (must match the chain)
const IPFS_UPLOAD_URL     = "https://ipfs.enclave.host/add-wasm"; // validating upload gateway; empty => paste-a-CID
const IPFS_GATEWAY        = "https://ipfs.io/ipfs/";    // where "fetch .wasm" links resolve
```

**Uploads go through a validating gateway, not Kubo directly.** Because the browser's
checks are bypassable, the raw Kubo `/api/v0/add` is **not** exposed. Instead:

```
browser → Caddy (/add-wasm, size cap) → scripts/ipfs-add-gateway.py (127.0.0.1:5051) → Kubo (127.0.0.1:5001)
```

The gateway (`scripts/ipfs-add-gateway.py`, stdlib Python, runs on the VM) re-enforces
size + the wasm/component preamble server-side, optionally runs `wasm-tools validate`
(set `WASM_TOOLS`), then adds+pins with hardcoded params and returns `{cid}`. Set
`IPFS_UPLOAD_URL` to that gateway (empty => users paste a CID they pinned themselves).

**Defense in depth, by layer:**
- Browser (`validateWasm`): extension, size (`MAX_WASM_MB`, default 2048), magic `\0asm`
  + component layer field. UX only — fast feedback, catches honest mistakes.
- Caddy `request_body { max_size 2049MiB }` on `/add-wasm`: the enforceable size ceiling.
- Gateway: the enforceable **content** gate for what gets pinned to *your node*.
- wasm-manager at deploy (`wasmtime serve`): the authoritative "is it a runnable
  wasi:http component" check.

**What server-side upload validation still can't do:** the catalog contract is
permissionless — anyone can pin bytes elsewhere and call `publishVersion` with that
CID directly, and the contract can't inspect bytes. So bad *listings* remain possible;
they just fail to deploy. To keep the *store view* clean you'd add an off-chain
validating indexer (fetch each listed CID, validate, hide the ones that fail) or lean
on the owner `verified` flag as the trust signal.

The browser ABI codec is hand-rolled (no web3 lib on the page, matching the pay
flow): a generic `encCall` and a schema-driven `decodeStructArray`. Every encoder
plus the `App[]`/`Version[]` decoders were verified byte-for-byte against viem
before shipping.

## Verify on first deploy
Deploy to Base Sepolia (the script wires the site to chain 84532 + the sepolia RPC),
redeploy the site, open the **Apps** tab, publish a slug at `1.0.0`, publish the same
slug again at `1.1.0`, and confirm one card shows both in the version selector. Then
re-deploy to mainnet with `NETWORK=base`.
