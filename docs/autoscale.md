# Demand-driven fleet autoscaling

`autoscale.yml` (cron, every 30 min) + `scripts/autoscale.mjs`. Finds funded
deployments the current fleet has no capacity to claim, and starts (or
creates) standby enclave containers through the Tinfoil controlplane; stops
auto-managed enclaves that sit idle. Built so that triggering it is always
**more expensive for an attacker than for us** — see the threat model below.

## How a scale-up decision is made

`plan` (read-only) assembles three views and applies the policy in
`decide()` (unit-tested in `test/autoscale.test.mjs`):

1. **Demand — from the chain, nowhere else.** `EnclaveDeployments.getPage`
   over every record; a candidate is `active`, funded past the contract's
   `claimable()` boundary (`balance6 >= rate`), and not under a live lease.
   On top of that it must have:
   - **dwell**: `createdAt` at least `AUTOSCALE_DWELL_SEC` (10 min) ago — the
     normal claim path gets first shot;
   - **real money**: at least `AUTOSCALE_MIN_FUNDED_SEC` (1 h) of prepaid
     runtime at its snapshotted rate. The defaults are sized to the console's
     typical top-up (a $5 funding of a ~49% share ≈ 1.6 h) so REAL customers
     trigger scaling; every threshold can be overridden per-run via repo
     VARIABLES of the same names (see autoscale.yml `env`).
2. **Structural filter.** Each candidate is checked against the fleet's own
   claim logic (`POST /v1/claim-hint`): reasons like *below the app's minimum
   shares*, *deactivated*, *configCid retired*, *app not deployable* mark the
   record permanently unclaimable — more capacity would not help, so it is
   **not** demand (this also covers the stranded-funding class of records).
   `accepted: true` means an enclave is already claiming it — also not demand.
3. **Supply.** The relay's `GET /enclaves` per-enclave availability. A
   candidate is *unmet* only if **no single live enclave** can fit its shares
   (GPU shares are single-card; CPU shares single-node). If the relay is
   unreachable, the run takes **no actions at all** — an outage must not look
   like "no capacity". (A *reachable* relay with zero enclaves is a genuinely
   cold fleet, and scaling is exactly the fix.)

Scale-up for a flavor happens only when the unmet demand clears **both**
economic gates:

- aggregate unmet share ≥ `AUTOSCALE_MIN_UNMET_{GPU,CPU}_SHARE` (0.10 / 0.25)
- aggregate prepaid, non-refundable runtime ≥ `AUTOSCALE_MIN_COMMITTED_USD_{GPU,CPU}`
  ($4 / $1.50), counting at most 24 h per deployment

and the structural caps allow it:

- at most `AUTOSCALE_MAX_{GPU,CPU}` (1 / 1) auto containers per flavor, inside
  Tinfoil's 10-container org quota — and note the REAL GPU ceiling learned
  live 2026-07-17: the account allows **2 active 1-GPU containers total**
  ("paid 1 + 1 spare for debug / zero-downtime updates"), so one auto GPU box
  next to the baseline is the maximum until the Tinfoil account is upgraded
  (a create beyond it 403s and apply reports it as QUOTA-BLOCKED, not red).
  Caveat: while the auto box occupies the spare slot, blue-green fleet
  updates may lose their zero-downtime slot — coordinate with Tinfoil;
- no lifecycle change on that flavor's auto containers within
  `AUTOSCALE_COOLDOWN_SEC` (30 min);
- one action per flavor per run (runs are 30 min apart).

Preference order: **start** a stopped `auto-<flavor>-N` standby (stopped
containers don't bill and keep their config), else **create** one. The tag is
inherited from the live fleet (attestation-locked to `/releases/latest` by the
update-fleet job); a first-ever CPU box derives `<gpu tag>-cpu` and the plan
verifies that release exists before proposing.

## Scale-down

Only containers named `auto-*` are ever touched, and the only verb is
**stop** — never delete, and never the baseline fleet. A stop requires *all*
of: zero unmet demand for the flavor, the box's own `/v1/health` reporting
`deployments: 0` (re-checked at apply time), no lifecycle change within the
cooldown, and `AUTOSCALE_IDLE_STOP_SEC` (45 min) since the last one. gpu8
flavors are out of scope entirely.

## Consolidation (scale-down by moving tenants)

When a flavor is fully quiet — zero unmet demand, no cooldown, no other
action — and a running `auto-*` box's live tenants would ALL fit on one other
box (with margin), the planner proposes **evacuate**: each tenant is released
through the source enclave's `POST /v1/admin/deployments/:id/release`
(ADMIN_TOKEN-gated; ships in supervisors ≥ the release carrying it). A
release stops the app, refunds the unused lease tail on-chain, and holds the
id off the source for 15 min so the target's sweep re-claims it. The emptied
box then idle-stops on a later tick — hysteresis by construction. Tenants
experience one restart (identical to any lease migration): RAM-backed `/data`
resets, encrypted volumes persist, no funded time is lost.

Guards: only `auto-*` sources (stopping a baseline box saves nothing), one
evacuation per run, every tenant must have ≥ `AUTOSCALE_EVAC_MIN_REMAINING_SEC`
(30 min) of runtime left (a draining box is cheaper to just wait out), and the
whole feature is disabled with `AUTOSCALE_CONSOLIDATE=0`. Requires the
`ADMIN_TOKEN` repo secret (same value as the fleet's Tinfoil vault secret);
without it apply skips evacuations with a notice.

## Approval gating

By default every apply waits on the **`fleet-scale` environment** (required
reviewer): the cron plans continuously, but a container starts only after a
human approves that run. Concurrency keeps only the freshest pending run;
apply re-verifies container state before each action, so approving a stale
plan is safe. Set the repo variable `AUTOSCALE_MODE=auto` to go unattended —
the caps above still bound worst-case behavior. Without the
`TINFOIL_API_KEY` secret the whole workflow is inert.

## Threat model — why this can't be used to grief us

**The demand signal costs the attacker real money they never get back.**
Funding is non-custodial: `fund`/`fundWithAuthorization`/`fundEth` forward
the USDC/ETH to the payout wallet inside the funding transaction, and the
contract has **no withdraw path** (`balance6` is an accounting number;
`setActive(false)` stops a deployment but cannot pull funds out). To make the
planner even consider scaling, an attacker must permanently part with
`MIN_COMMITTED_USD` of funding — paid to us.

**Worst-case forced spend is capped and small.** Suppose an attacker funds
$4+ of GPU demand, waits for the box, then deactivates everything. Our cost
is one H200 container for roughly boot + idle-window + cooldown (≈ 1.5–2 h)
before the box stops again; their cost is ≥ $4, non-refundable and paid to
us. Repeating the cycle is bounded by the cooldown + cron cadence to well
under one box-day per day per flavor, each cycle requiring fresh funding —
a hard ceiling of a few tens of dollars per day, partially offset by the
attacker's own donations. The $4 default trades a thinner griefing margin
for real-customer responsiveness; raise `AUTOSCALE_MIN_COMMITTED_USD_GPU`
(repo variable) if abuse ever materializes.

**Capacity can't be faked downward cheaply either.** Supply comes from the
relay we operate; demand comes from the chain via a public-RPC fallback pool.
A compromised relay could *suppress* scaling (report infinite capacity) or
waste bounded money (report none — still capped by the funding gates and
container caps); a compromised RPC could fabricate demand — bounded by the
same caps, and mitigated by the multi-provider fallback list. Neither lets an
attacker exceed `MAX_AUTO` containers or touch the baseline fleet.

**Blast radius is structurally limited.** The script can only: start/create
containers named `auto-*` bound to the org's existing vault secrets at the
fleet's current release tag, and stop idle `auto-*` containers. It never
deletes, never rebinds secrets, never changes tags on baseline containers,
never touches gpu8. Failures roll back (an unroutable box is stopped, not
left burning).

## Trust-chain assumptions (read before first use)

A created container binds the **current vault values** of the secret names in
the flavor's `tinfoil-config.yml` — exactly what a dashboard create does
today. That includes `REGISTRY_PRIVATE_KEY`, i.e. a new box registers with
the **same operator EOA** as whatever the vault currently holds:

- If that is the canonical fleet operator (`0x390e…`, the relays' baked
  `TRUSTED_OPERATORS` default), the new box is trusted and routable
  immediately, and its gas is already funded. The cost is shared-EOA nonce
  contention on heartbeats/claims — low-rate, retried, and bounded at 2–3
  boxes, but it is contention (`contracts/README.md` recommends one EOA per
  enclave).
- If the vault holds a per-enclave EOA instead, a new box registers under an
  operator the relays do **not** trust. apply detects this — the box never
  appears in `GET /enclaves` — and **rolls it back to stopped** with
  instructions. The fix is adding the EOA to `TRUSTED_OPERATORS` on the relay
  boxes (api-relay, egress-relay, fleet relays) and pre-funding it with Base
  ETH for gas.

Per-container distinct secret values are not expressible on Tinfoil today
(values live in the org/repo vault by name and are re-read on any
start/relaunch/update), so a proper per-enclave key-slot mechanism needs
supervisor support (e.g. slot-indexed secret names selected by a non-secret
variable). That is the designed hardening follow-up; until then the
shared-operator trade-off above is the honest state of the fleet.

Verification after any scale-up (apply does all of this): container reaches
Running → `/v1/health` answers on its domain → the relay lists it within
`AUTOSCALE_TRUST_TIMEOUT_SEC` (7 min; the relay re-reads the registry every
5). Then watch the queued deployments get claimed.

## Rollout checklist

1. `TINFOIL_API_KEY` repo secret (shared with the update-fleet job).
2. `fleet-scale` environment with a required reviewer (`scripts/ci-setup.sh`
   creates it alongside `contract-deploy`).
3. Watch a few gated cycles; optionally set `AUTOSCALE_MODE=auto` later.
4. Local dry-run any time: `TINFOIL_API_KEY=admin_… node scripts/autoscale.mjs plan`.
