# Enclave portable deployments (EnclaveDeployments) — design

**Status: implemented. The contract compiles clean; the claim loop is wired
into `supervisor.js` (search `startClaimLoop`) behind `CLAIM_ENABLED` +
`DEPLOYMENTS_ADDRESS` in `enclaves/*/tinfoil-config.yml`. The code excerpts below are the
design reference; `supervisor.js` is authoritative where they diverge.**

Today a deployment is one enclave's private state: the spec and the funded-time
balance live in that supervisor's `state.json`, and the on-chain `Paid` events
reference a `payRef` whose preimage only that enclave knows. If the enclave dies
for good, the deployment — including paid, unconsumed runtime — dies with it.

`EnclaveDeployments` turns deployments into **work items on a queue**, like
transactions waiting to be processed. The chain holds the three things a
stranger enclave needs to take over:

1. the **intent** — what to run (`appRef`), the two shares bought (GPU + CPU), ports, visibility;
2. the **balance** — funded runtime (USDC 6dp), credited by payments, burned by leases;
3. the **lease** — who is serving it right now, and until when.

```
user    --(create tx)------------> EnclaveDeployments   intent recorded, id minted
user    --(fundWithAuthorization)> EnclaveDeployments   USDC -> payout (same tx), balance += value
enclave --(poll getPage)---------> EnclaveDeployments   "anything claimable I can fit?"
enclave --(claim tx)-------------> EnclaveDeployments   lease taken, min(leaseSec, balance/rate) burned
enclave --(wasm-manager launch)--> runs the app     same provisioning path as today
enclave --(renew tx, each lease)-> EnclaveDeployments   healthy runner keeps extending
enclave dies                      (nothing)         lease expires on its own
enclave'--(claim tx)-------------> EnclaveDeployments   another enclave picks it up, continues
...until balance < rate           claim reverts     "no more time left" — the queue drops it
```

At-most-one-runner-at-a-time is enforced by the chain (a live lease blocks
`claim`), not by any operator. A dead runner needs no detection protocol: its
silence *is* the signal, because the lease it stopped renewing expires.

A *half*-dead runner — outbound chain access intact, public front gone — is
the one case silence doesn't catch: it would happily claim and renew work
nobody can reach (observed 2026-07-11: a CVM lost its DNS record and front
routing but kept renewing for six hours). Runners close that hole themselves
with a reachability watchdog: each claim tick they ask public DoH resolvers
for their own advertised hostname, and once every resolver has *affirmed* the
name gone several rounds in a row they release everything they hold, stop
claiming, and stop renewing until the name resolves again (supervisor
`reachTick`; `REACH_DNS_STRIKES=0` disables).

## What changes, what doesn't

| | today (EnclavePay path) | portable (EnclaveDeployments path) |
|---|---|---|
| deployment created by | HTTP `POST /v1/deployments` to one enclave | `create()` transaction |
| spec lives in | that enclave's `state.json` | chain |
| balance lives in | `rec.remainingMs` in `state.json` | chain (`balance6`), leases prepay slices of it |
| payment | EnclavePay `Paid` event, credited off-chain | `fundWithAuthorization` / `fundEth`, credited on-chain |
| enclave death | deployment lost | lease expires, any enclave claims the remainder |
| billing clock | per-tick, freezes during outages | lease-quantum; `release()` refunds unused tail |
| app state | ephemeral ramdisk `/data` | unchanged — a takeover is a relaunch from the CID |
| attestation, approval gate, isolation | — | unchanged (runners still check `cidStatus`, fail closed) |

Both paths coexist: `EnclavePay` + the HTTP deploy flow keep working unchanged;
`EnclaveDeployments` is opt-in per enclave (`CLAIM_ENABLED`) and per user (deploy
via transaction instead of via one enclave's API).

## Contract summary (`EnclaveDeployments.sol`)

- **`create(appRef, gpuMilli, cpuMilli, appPort, ports, isPublic, configCid)`**
  (schema rev 2 — rev-1 contracts carried an extra `sshPubKey` string here and in
  the `Deployment` struct; consumers sniff `deploymentsSchema()` to pick the shape.
  Rev 3 keeps the rev-2 shapes byte-for-byte and only marks the `setAppRef`
  surface, so struct decodes gate on `>= 2` and version changes on `>= 3`)
  — permissionless; inert until funded. `appRef` is `catalog://<appId>/<versionIndex>`,
  the on-chain record of the catalog VERSION to run (2026-07-09; CID refs are refused
  by runners — a CID names bytes, not a version). The record supplies the wasm,
  config (ENCLAVE_CONFIG + volumes) and ports the catalog owner approved;
  `ports`/`appPort` ride along untrusted, and `configCid` is **retired**: the
  contract still accepts and stores the field (length-bounded only), but every
  runner refuses a deployment whose `configCid` is non-empty (fail-closed), so in
  practice it must be `""` — a deployer can never attach behavior the owner didn't
  review. A deployment BUYS two shares, both in
  1/1000ths: `gpuMilli` of one GPU card (VRAM + compute together; `0` = a
  CPU-only deployment) and `cpuMilli` of a node's vCPU+RAM (1..1000). The
  contract enforces `gpuMilli == 0 || gpuMilli >= cpuMilli` — a GPU app's CPU
  slice rides on the same node as its card. The app's exact specs in
  EnclaveAppCatalog (vramMb, gpuGflops, memMb, cpuGflops) set its MINIMUM shares: each RUNNER
  re-derives them against its own hardware (spec / server spec, the larger of
  the memory and compute axes, ceil to the percent grain) and skips
  under-provisioned deployments — the chain stays hardware-agnostic. The GPU
  share is also capped from above: `create` refuses `gpuMilli > maxGpuMilli`,
  an owner-set on-chain parameter (`setMaxGpuMilli`, 0..1000, default 1000 =
  uncapped; 0 pauses GPU creates). The cap gates **deploys only** — the catalog
  keeps listing apps whose specs exceed it (publishable, just not deployable
  until the cap covers their minimum), existing records and owner imports are
  untouched, and every client (console dials, quick-deploy, CLI) re-checks it
  before the wallet signature so nobody signs a doomed create. Both
  shares are paid for:
  `rate = (pricePerSec6 × gpuMilli + cpuPricePerSec6 × cpuMilli) / 1000`,
  rounded up, snapshotted at create (price changes never re-price existing
  deployments). `id = keccak256(creator, nonce)`.
  **Routing (enforced by runners at claim time): GPU work (`gpuMilli > 0`) is
  claimed ONLY by GPU-enabled enclaves; CPU-only work is claimed by CPU-only
  enclaves immediately and by GPU enclaves only after `CPU_CLAIM_GRACE_SEC`
  (default 120s), out of their leftover CPU/RAM pool — e.g. a tenant taking a
  whole card + 10% of the node leaves 90% of that node's CPU for CPU-only work.**
- **`fundWithAuthorization(id, ...)` / `fundEth(id)`** — non-custodial, exactly
  EnclavePay's pattern (EIP-3009 nonce bound to the first 16 bytes of `id`; funds
  forward to `payout` in the same tx). The difference: the credit lands in
  on-chain `balance6` instead of an off-chain clock. ETH is priced by the
  Chainlink ETH/USD feed *in the contract* (staleness-checked), because the
  balance is chain state so the conversion must be too.
- **`claim(id, enclaveId)`** — gated to the operator of an **active EnclaveRegistry
  entry** (structural, like catalog lineage ownership). Requires no live lease
  and a balance that buys ≥ 1 second. Burns `min(leaseSec, balance/rate)`.
- **`renew(id)`** — current runner only, before expiry only; extends **from**
  `leaseUntil` (that time is already paid). After expiry even the same runner
  must re-`claim` — the job is back on the open queue.
- **`setActive(id, bool)`** — the owner's suspend/resume switch. `false` takes
  the record off the claim queue; a well-behaved runner sees `ActiveSet`, tears
  down and releases (refunding the lease tail), and the balance STAYS on the
  record. `true` re-queues it — the app relaunches fresh from its published
  version, spending what's left. The dashboard's Suspend/Resume buttons and the
  CLI's `stop`/`resume` are exactly this toggle.
- **`setAppRef(id, appRef)`** (rev 3+; `deploymentsSchema() >= 3` is the feature
  probe) — the owner's VERSION CHANGE. Repoints the deployment at another
  catalog version record; funded time, shares, rate and any live lease all
  stay, so picking up a new release never costs a second buy-in. The ledger
  doesn't parse the ref (same trust model as `create`): runners re-gate it on
  catalog approval + minimum shares. The CURRENT runner restarts the app in
  place on its next audit pass — new wasm prefetched before the old instance
  stops, so the gap is ≈ one relaunch — and an unclaimed deployment simply
  launches the new version when claimed. A change the runner can't apply
  (unapproved target, minimums over the immutable bought shares, catalog
  unreachable) keeps the OLD version serving and surfaces why on the record
  (`versionChange` in the status API), retrying every pass. The dashboard's
  Version control and the CLI's `upgrade` are this call, both pre-checking
  approval and share fit before the wallet signature.
- **`release(id)`** — graceful hand-back; refunds the unused lease tail to
  `balance6`. Called on clean shutdown, after the owner `setActive(false)`,
  or when provisioning fails right after a claim.
- **Reads**: `getPage` (enclaves page + filter client-side, like registry
  discovery), `claimable(id)`, `secondsFundable(id)`, `get(id)` (clients
  resolve `id -> runner -> endpoint`).

### Fairness bounds (the price of decentralized failover)

The old per-tick clock could freeze during outages because one trusted party
kept it. Without that party, the quantum of trust is the **lease**:

- A runner that dies mid-lease has burned that lease. The user's worst-case
  loss is `leaseSec` per runner death (default 30 min). Clean shutdowns lose
  nothing (`release` refunds).
- Two enclaves racing to claim: the loser's tx reverts. Gas on Base is cents;
  the jittered sweep below makes races rare.
- `leaseSec` is the tuning knob: shorter = tighter fairness + more gas;
  longer = cheaper + more exposure to dead runners.

## Supervisor-side claim loop

Everything below is written against `supervisor.js`'s existing internals:
`deployments` (the Map), `allocGpu`/`releaseGpu`, `provisionTenant`,
`gateAppReference`, `parseFirewall`, `saveStateSoon`, `chainClient`, and the
registry identity (`REGISTRY_PK`, `registerOnChain`). The claim loop **must**
sign with `REGISTRY_PRIVATE_KEY` — the contract checks that `msg.sender` is the
operator of the enclave's registry entry, so the two features share one EOA.

### Config

```js
const DEPLOYMENTS_ADDRESS = process.env.DEPLOYMENTS_ADDRESS || "";
const CLAIM_ENABLED   = /^(1|true|on)$/i.test(process.env.CLAIM_ENABLED || "");
const CLAIM_POLL_SEC  = parseInt(process.env.CLAIM_POLL_SEC  || "60", 10);  // queue sweep + split-brain check cadence
const RENEW_MARGIN_SEC= parseInt(process.env.RENEW_MARGIN_SEC|| "300", 10); // renew when < this much lease is left
// GPU enclaves wait this long after a CPU-only deployment becomes claimable
// before bidding, so CPU-only enclaves get first claim (GPU leftovers = fallback)
const CPU_CLAIM_GRACE_SEC = parseInt(process.env.CPU_CLAIM_GRACE_SEC || "120", 10);
const CLAIM_PAGE      = 100;
// ready iff we advertise on the registry (claims are gated to its operators)
// and we know our own enclave id (keccak256 of the advertised endpoint —
// registerOnChain already computes it; export it as _enclaveId).
const CLAIM_READY = CLAIM_ENABLED && !!(DEPLOYMENTS_ADDRESS && REGISTRY_READY);

const DEPLOYMENTS_ABI = [
  { type: "function", name: "claim",   stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "bytes32" }, { name: "enclaveId", type: "bytes32" }], outputs: [] },
  { type: "function", name: "renew",   stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "bytes32" }], outputs: [] },
  { type: "function", name: "release", stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "bytes32" }], outputs: [] },
  { type: "function", name: "claimable", stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "count",  stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "get",     stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }], outputs: [{ type: "tuple", components: DEPLOYMENT_TUPLE }] },
  { type: "function", name: "getPage", stateMutability: "view",
    inputs: [{ name: "start", type: "uint256" }, { name: "n", type: "uint256" }],
    outputs: [{ type: "tuple[]", components: DEPLOYMENT_TUPLE }] },
];
// DEPLOYMENT_TUPLE mirrors the struct; generate it from EnclaveDeployments.abi.json.
```

### The sweep: find work, filter locally, claim with jitter

```js
// One claim-loop pass: page the ledger, adopt anything claimable that fits.
// Runs every CLAIM_POLL_SEC alongside the payment watcher; never throws.
async function claimSweep() {
  if (!CLAIM_READY || !_enclaveId) return;              // not advertising yet
  for (let start = 0; ; start += CLAIM_PAGE) {
    const page = await chainClient.readContract({ address: DEPLOYMENTS_ADDRESS,
      abi: DEPLOYMENTS_ABI, functionName: "getPage", args: [BigInt(start), BigInt(CLAIM_PAGE)] });
    if (!page.length) break;
    for (const d of page) {
      if (deployments.has(d.id)) continue;              // already ours (running or recovering)
      if (!d.active || Number(d.leaseUntil) * 1000 > Date.now()) continue;  // stopped or leased
      if (d.balance6 < d.rate) continue;                // out of funded time — queue drops it
      // routing + capacity BEFORE claiming: never burn a user's lease we can't
      // serve. The deployment bought two shares; GPU work fits a card AND the
      // node's cpu pool; CPU-only work runs on CPU enclaves immediately, on GPU
      // enclaves only after a grace window (CPU enclaves get first claim) and
      // only out of LEFTOVER cpu pool.
      const gpuShare = Number(d.gpuMilli) / 1000, cpuShare = Number(d.cpuMilli) / 1000;
      if (gpuShare > 0) {
        if (!IS_GPU) continue;                          // GPU work never runs on a CPU-only enclave
        if (gpuShare * CARD_VRAM_GB > maxFreeVram() + 1e-9 || cpuShare > maxFreeCpu() + 1e-9) continue;
      } else {
        if (IS_GPU && Date.now() < (Math.max(Number(d.createdAt), Number(d.leaseUntil)) + CPU_CLAIM_GRACE_SEC) * 1000) continue;
        if (cpuShare > maxFreeCpu() + 1e-9) continue;
      }
      // catalog approval gate, same as the HTTP deploy path (fail closed); the
      // app's specs also set its minimum shares on OUR hardware — a deployment
      // that bought less is nobody's work item
      const g = await gateAppReference(d.appRef);
      if (g.error) continue;
      const mins = minSharesOf(g.min);       // specs / our hardware -> minimum shares
      if (gpuShare < mins.gpuShare - 1e-9 || cpuShare < mins.cpuShare - 1e-9) continue;
      await tryClaim(d, g.ref);
    }
    if (page.length < CLAIM_PAGE) break;
  }
}

// Jitter + re-check + claim. The jitter de-syncs enclaves that all saw the same
// queue state; the eth_call re-check catches a claim that landed during the wait
// without paying for a reverted tx.
async function tryClaim(d, resolvedRef) {
  await new Promise(r => setTimeout(r, Math.random() * 5000));
  const open = await chainClient.readContract({ address: DEPLOYMENTS_ADDRESS,
    abi: DEPLOYMENTS_ABI, functionName: "claimable", args: [d.id] });
  if (!open) return;                                    // someone beat us to it — fine
  const hash = await claimWallet.writeContract({ address: DEPLOYMENTS_ADDRESS,
    abi: DEPLOYMENTS_ABI, functionName: "claim", args: [d.id, _enclaveId] });
  const rcpt = await chainClient.waitForTransactionReceipt({ hash });
  if (rcpt.status !== "success") return;                // lost the race; tx cost ~cents
  const fresh = await chainClient.readContract({ address: DEPLOYMENTS_ADDRESS,
    abi: DEPLOYMENTS_ABI, functionName: "get", args: [d.id] });
  await adopt(fresh, resolvedRef);
}
```

### Adoption: on-chain record → local `rec`, same provisioning path

The local record uses the **on-chain id as `rec.id`**, so the data path
(`/x/:id`, the TCP bridge, UDP addressing) works unchanged and clients can
derive the URL from chain state alone. `rec.owner` is the on-chain owner
address — SIWE tokens already carry an address, so private-deployment auth
works with zero changes.

```js
async function adopt(d, resolvedRef) {
  const gpuShare = Number(d.gpuMilli) / 1000, cpuShare = Number(d.cpuMilli) / 1000;
  // GPU work reserves a card slice AND its cpuShare; CPU-only work just the cpu pool
  const gpu = gpuShare > 0 ? allocGpu(gpuShare * CARD_VRAM_GB, gpuShare, cpuShare) : allocCpu(cpuShare);
  if (!gpu) { await releaseOnChain(d.id); return; }     // capacity vanished; refund the lease
  const rec = {
    id: d.id, owner: d.owner.toLowerCase(), status: "claimed",
    public: d.isPublic, firewall: firewallFromPorts(d.ports),  // CSV -> the parseFirewall shape
    image: { reference: resolvedRef }, command: [],
    resources: gpuShare > 0 ? { gpuShare, cpuShare, cardId: gpu.cardId } : { gpuShare: 0, cpuShare },
    network: { port: Number(d.appPort), protocol: "https", endpoint: null }, // filled from originOf per request
    createdAt: new Date(Number(d.createdAt) * 1000).toISOString(), startedAt: null,
    // the local clock only covers the CURRENT lease; the chain holds the rest
    remainingMs: Number(d.leaseUntil) * 1000 - Date.now(), consumedMs: 0,
    rate: Number(d.rate) / 1e6, paidUsdc: Number(d.spent6) + Number(d.balance6),
    _onchain: true, _leaseUntil: Number(d.leaseUntil),
    _gpu: gpu, _gpuSpec: gpuShare > 0 ? { cardId: gpu.cardId, vramCapGb: gpu.vramGb, computeShare: gpu.computeShare } : null,
  };
  deployments.set(rec.id, rec); saveStateSoon();
  if (!(await provisionTenant(rec))) {                  // launch failed (bad wasm, OOM, ...):
    deployments.delete(rec.id);                         // hand it back with a refund so another
    await releaseOnChain(rec.id); saveStateSoon();      // enclave can try — the user paid nothing
  }
}
```

### Renewal: piggyback on the billing ticker

The existing reaper already tears down when `remainingMs` hits zero. For
on-chain records, `remainingMs` means "paid until lease end", so the only new
behavior is *extending it* by renewing before expiry:

```js
// inside the BILL_TICK_SEC ticker, before the reaper check:
if (rec._onchain && rec.status === "running"
    && rec._leaseUntil * 1000 - Date.now() < RENEW_MARGIN_SEC * 1000 && !rec._renewing) {
  rec._renewing = true;
  claimWallet.writeContract({ address: DEPLOYMENTS_ADDRESS, abi: DEPLOYMENTS_ABI,
                              functionName: "renew", args: [rec.id] })
    .then(h => chainClient.waitForTransactionReceipt({ hash: h }))
    .then(() => chainClient.readContract({ address: DEPLOYMENTS_ADDRESS,
                  abi: DEPLOYMENTS_ABI, functionName: "get", args: [rec.id] }))
    .then(d => { rec._leaseUntil = Number(d.leaseUntil);
                 rec.remainingMs = rec._leaseUntil * 1000 - Date.now(); saveStateSoon(); })
    .catch(e => console.warn(`[claim] renew ${rec.id} failed (${e.shortMessage || e.message}) — `
                           + `letting the lease run out`))   // "unfunded" lands here: reaper handles it
    .finally(() => { rec._renewing = false; });
}
```

If `renew` reverts with `unfunded`, the balance can't buy another second: the
lease runs to its end, the existing reaper tears the app down (grace applies),
and the queue never offers the deployment again until someone tops it up —
"processed until there is no more time left", with no new teardown code.

### Split-brain guard

A partitioned enclave might keep serving after its lease expired and someone
else claimed. Each `claimSweep` pass therefore re-reads every adopted record:

```js
for (const rec of [...deployments.values()].filter(r => r._onchain)) {
  const d = await chainClient.readContract({ address: DEPLOYMENTS_ADDRESS,
    abi: DEPLOYMENTS_ABI, functionName: "get", args: [rec.id] });
  const mine = d.runnerOperator.toLowerCase() === claimAccount.address.toLowerCase();
  if (!d.active) {                     // owner stopped it: tear down AND release (refunds the tail)
    await teardown(rec); await releaseOnChain(rec.id);
  } else if (!mine || Number(d.leaseUntil) * 1000 < Date.now()) {
    await teardown(rec);               // lost the lease: stop serving; do NOT release (not ours)
  }
}
```

The check is one `eth_call` per adopted deployment per minute — the data path
itself stays chain-free. The exposure window (serving a few seconds past a
takeover) is harmless: the new runner is attested identically, app state is
ephemeral by design, and both instances are the same measured CID.

The same audit pass is where owner **version changes** land: a healthy record
whose ledger row carries a different `appRef` (the owner sent `setAppRef`) is
re-gated like a fresh claim and restarted in place onto the new version — see
`switchTenantVersion` in `supervisor.js`.

### Graceful shutdown and restart

- **SIGTERM/SIGINT** (already hooked for `saveStateNow`): additionally
  `release()` every adopted deployment, in parallel with a ~10 s cap, then
  exit. Each release refunds the lease tail — a clean shutdown costs users
  nothing and reopens the queue immediately.
- **Restart** (same enclave): `loadState()` restores `_onchain` records; for
  each, the first `claimSweep` pass re-reads the chain — still ours with a
  live lease → resume (respawn the app if needed); lost meanwhile → drop
  locally. No special recovery protocol: the chain is the source of truth.

### Client-side resolution (site)

The dashboard/CLI resolves a portable deployment without contacting any
particular enclave first:

```
EnclaveDeployments.get(id)      -> runner (enclave id), leaseUntil, appRef, balance
EnclaveRegistry.get(runner)     -> endpoint, repo
SecureClient(endpoint,repo) -> attest, then https://<endpoint>/x/<id>[...]
```

On failover the endpoint changes; clients re-resolve (a 404/refused from the
old runner or a `Claimed` event both work as triggers) and re-attest against
the new enclave. This is the same no-trusted-gateway shape as discovery today.

## Open problems (known, deferred)

- **Secrets.** App config is the version's on-chain record — public by
  construction (and deployer-supplied config is retired entirely, so there is
  no per-deployment secret channel at all). Candidates: a fleet key negotiated
  over attested enclave-to-enclave channels (same measurement ⇒ mutual trust);
  or the owner posts secrets to the runner via a SIWE-authed endpoint after
  each claim (trustless but manual).
- **UDP addressing.** The per-deployment IPv6 host bits derive from the id and
  survive failover, but the /64 prefix is per relay box; a takeover by an
  enclave behind a different relay changes the address. Client re-resolution
  covers it, long-lived UDP flows don't.
- **No on-chain refunds to the payer.** Funding is forwarded to `payout`
  immediately (non-custodial by design); `balance6` is accounting. Refunding a
  stopped deployment's remainder stays a payout-wallet action, exactly as today.
- **Consumed-time attestation** (future note in the .sol): runners posting
  signed usage checkpoints would shrink the dead-runner loss below `leaseSec`.

## Deploy

```bash
# Base Sepolia dry run (compile + plan, no broadcast; re-emits the ABI):
DEPLOYER_PRIVATE_KEY=0x... node scripts/deploy-deployments.mjs --dry-run --yes

# Base Sepolia (uses REGISTRY_ADDRESS from enclaves/gpu/tinfoil-config.yml; prices are hardcoded
# in the contract: ~$6/h full GPU card, ~$1/h whole CPU node — no setter txs sent):
DEPLOYER_PRIVATE_KEY=0x... node scripts/deploy-deployments.mjs

# Base MAINNET:
NETWORK=base DEPLOYER_PRIVATE_KEY=0x... node scripts/deploy-deployments.mjs
```

> **CPU price.** The contract's hardcoded default CPU rate is
> `cpuPricePerSec6 = 834` µUSDC/s ≈ **$3.00/hour** for a full node — the same
> figure the site fallback (`pricing.js CPU_NODE_RATE`) and the fleet's
> `/v1/pricing` (`supervisor.js CPU_RATE`) advertise, so a fresh deploy needs
> no follow-up `setCpuPrice` tx. (The pre-2026-07-18 default was 278 ≈
> $1.00/hour, which had drifted below the advertised price — a redeploy back
> then would have silently reverted the live rate.)

The script writes `DEPLOYMENTS_ADDRESS` into `tinfoil-config.yml` when the line
exists (add it under the supervisor `env:` alongside `FORWARDER_ADDRESS`), and
re-emits `contracts/EnclaveDeployments.abi.json` so the checked-in ABI can't drift.
Constructor wiring: `usdc`, `payout` (the Enclave cold wallet), `registry` (claim gating),
`ethUsdFeed` (Chainlink; `ETH_USD_FEED=none` disables ETH funding).
