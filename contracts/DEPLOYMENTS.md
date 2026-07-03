# NAN portable deployments (NanDeployments) — design

**Status: implemented. The contract compiles clean; the claim loop is wired
into `supervisor.js` (search `startClaimLoop`) behind `CLAIM_ENABLED` +
`DEPLOYMENTS_ADDRESS` in `tinfoil-config.yml`. The code excerpts below are the
design reference; `supervisor.js` is authoritative where they diverge.**

Today a deployment is one enclave's private state: the spec and the funded-time
balance live in that supervisor's `state.json`, and the on-chain `Paid` events
reference a `payRef` whose preimage only that enclave knows. If the enclave dies
for good, the deployment — including paid, unconsumed runtime — dies with it.

`NanDeployments` turns deployments into **work items on a queue**, like
transactions waiting to be processed. The chain holds the three things a
stranger enclave needs to take over:

1. the **intent** — what to run (`appRef`), share, ports, visibility, ssh key;
2. the **balance** — funded runtime (USDC 6dp), credited by payments, burned by leases;
3. the **lease** — who is serving it right now, and until when.

```
user    --(create tx)------------> NanDeployments   intent recorded, id minted
user    --(fundWithAuthorization)> NanDeployments   USDC -> payout (same tx), balance += value
enclave --(poll getPage)---------> NanDeployments   "anything claimable I can fit?"
enclave --(claim tx)-------------> NanDeployments   lease taken, min(leaseSec, balance/rate) burned
enclave --(wasm-manager launch)--> runs the app     same provisioning path as today
enclave --(renew tx, each lease)-> NanDeployments   healthy runner keeps extending
enclave dies                      (nothing)         lease expires on its own
enclave'--(claim tx)-------------> NanDeployments   another enclave picks it up, continues
...until balance < rate           claim reverts     "no more time left" — the queue drops it
```

At-most-one-runner-at-a-time is enforced by the chain (a live lease blocks
`claim`), not by any operator. A dead runner needs no detection protocol: its
silence *is* the signal, because the lease it stopped renewing expires.

## What changes, what doesn't

| | today (NanPay path) | portable (NanDeployments path) |
|---|---|---|
| deployment created by | HTTP `POST /v1/deployments` to one enclave | `create()` transaction |
| spec lives in | that enclave's `state.json` | chain |
| balance lives in | `rec.remainingMs` in `state.json` | chain (`balance6`), leases prepay slices of it |
| payment | NanPay `Paid` event, credited off-chain | `fundWithAuthorization` / `fundEth`, credited on-chain |
| enclave death | deployment lost | lease expires, any enclave claims the remainder |
| billing clock | per-tick, freezes during outages | lease-quantum; `release()` refunds unused tail |
| app state | ephemeral ramdisk `/data` | unchanged — a takeover is a relaunch from the CID |
| attestation, approval gate, isolation | — | unchanged (runners still check `cidStatus`, fail closed) |

Both paths coexist: `NanPay` + the HTTP deploy flow keep working unchanged;
`NanDeployments` is opt-in per enclave (`CLAIM_ENABLED`) and per user (deploy
via transaction instead of via one enclave's API).

## Contract summary (`NanDeployments.sol`)

- **`create(appRef, gpu, milliShare, appPort, ports, isPublic, sshPubKey, configCid)`**
  — permissionless; inert until funded. `gpu` picks the flavor AND the price
  schedule: `true` = a GPU deployment (`milliShare` is 1/1000ths of a card,
  priced from `pricePerSec6`), `false` = a CPU deployment (`milliShare` is
  1/1000ths of a CPU node's vCPU+RAM, priced from `cpuPricePerSec6`). `rate`
  (USDC 6dp/sec) is snapshotted at create, so price changes never re-price
  existing deployments. `id = keccak256(creator, nonce)`.
  **Partition rule (enforced by runners at claim time): CPU deployments are
  claimed ONLY by CPU-only enclaves (`GPU_COUNT=0`); GPU deployments ONLY by
  GPU-enabled enclaves.**
- **`fundWithAuthorization(id, ...)` / `fundEth(id)`** — non-custodial, exactly
  NanPay's pattern (EIP-3009 nonce bound to the first 16 bytes of `id`; funds
  forward to `payout` in the same tx). The difference: the credit lands in
  on-chain `balance6` instead of an off-chain clock. ETH is priced by the
  Chainlink ETH/USD feed *in the contract* (staleness-checked), because the
  balance is chain state so the conversion must be too.
- **`claim(id, enclaveId)`** — gated to the operator of an **active NanRegistry
  entry** (structural, like catalog lineage ownership). Requires no live lease
  and a balance that buys ≥ 1 second. Burns `min(leaseSec, balance/rate)`.
- **`renew(id)`** — current runner only, before expiry only; extends **from**
  `leaseUntil` (that time is already paid). After expiry even the same runner
  must re-`claim` — the job is back on the open queue.
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
// DEPLOYMENT_TUPLE mirrors the struct; generate it from NanDeployments.abi.json.
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
      if (Boolean(d.gpu) !== IS_GPU) continue;          // partition rule: never claim across the CPU/GPU line
      if (!d.active || Number(d.leaseUntil) * 1000 > Date.now()) continue;  // stopped or leased
      if (d.balance6 < d.rate) continue;                // out of funded time — queue drops it
      // capacity check BEFORE claiming: never burn a user's lease we can't serve
      const share = Number(d.milliShare) / 1000, vramGb = share * CARD_VRAM_GB;
      if (vramGb > maxFreeVram() + 1e-9) continue;      // (CPU enclaves check the node-share pool instead)
      // catalog approval gate, same as the HTTP deploy path (fail closed)
      const g = await gateAppReference(d.appRef);
      if (g.error) continue;
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
  const share = Number(d.milliShare) / 1000;
  const gpu = allocGpu(share * CARD_VRAM_GB, share);
  if (!gpu) { await releaseOnChain(d.id); return; }     // capacity vanished; refund the lease
  const rec = {
    id: d.id, owner: d.owner.toLowerCase(), status: "claimed",
    public: d.isPublic, firewall: firewallFromPorts(d.ports),  // CSV -> the parseFirewall shape
    image: { reference: resolvedRef }, command: [],
    resources: { vramGb: share * CARD_VRAM_GB, computeShare: share, share, cardId: gpu.cardId },
    network: { port: Number(d.appPort), protocol: "https", endpoint: null }, // filled from originOf per request
    createdAt: new Date(Number(d.createdAt) * 1000).toISOString(), startedAt: null,
    // the local clock only covers the CURRENT lease; the chain holds the rest
    remainingMs: Number(d.leaseUntil) * 1000 - Date.now(), consumedMs: 0,
    rate: Number(d.rate) / 1e6, paidUsdc: Number(d.spent6) + Number(d.balance6),
    _onchain: true, _leaseUntil: Number(d.leaseUntil),
    _gpu: gpu, _gpuSpec: { cardId: gpu.cardId, vramCapGb: gpu.vramGb, computeShare: gpu.computeShare },
    _authorizedKey: (d.sshPubKey || "").trim(), _sshKeySource: "on-chain",
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
NanDeployments.get(id)      -> runner (enclave id), leaseUntil, appRef, balance
NanRegistry.get(runner)     -> endpoint, repo
SecureClient(endpoint,repo) -> attest, then https://<endpoint>/x/<id>[...]
```

On failover the endpoint changes; clients re-resolve (a 404/refused from the
old runner or a `Claimed` event both work as triggers) and re-attest against
the new enclave. This is the same no-trusted-gateway shape as discovery today.

## Open problems (known, deferred)

- **Secrets.** `configCid` contents are public unless encrypted, and there is
  no portable decryption key yet. v1: public config only. Candidates: a fleet
  key negotiated over attested enclave-to-enclave channels (same measurement ⇒
  mutual trust); or the owner re-posts secrets to the new runner via a
  SIWE-authed endpoint after each failover (trustless but manual).
- **SSH host keys.** Each enclave generates its sandbox host key at boot
  (RTMR-measured), so a failover changes the fingerprint; clients must re-pin.
  Only user keys (`sshPubKey`) are portable — enclave-minted user keys are
  deliberately not supported for portable deployments.
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

# Base Sepolia (uses REGISTRY_ADDRESS from tinfoil-config.yml; prices are hardcoded
# in the contract: ~$6/h full GPU card, ~$2/h whole CPU node — no setter txs sent):
DEPLOYER_PRIVATE_KEY=0x... node scripts/deploy-deployments.mjs

# Base MAINNET:
NETWORK=base DEPLOYER_PRIVATE_KEY=0x... node scripts/deploy-deployments.mjs
```

The script writes `DEPLOYMENTS_ADDRESS` into `tinfoil-config.yml` when the line
exists (add it under the supervisor `env:` alongside `FORWARDER_ADDRESS`), and
re-emits `contracts/NanDeployments.abi.json` so the checked-in ABI can't drift.
Constructor wiring: `usdc`, `payout` (nan.eth), `registry` (claim gating),
`ethUsdFeed` (Chainlink; `ETH_USD_FEED=none` disables ETH funding).
