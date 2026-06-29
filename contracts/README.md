# NAN on-chain discovery (NanRegistry)

Transparent, gateway-free enclave discovery. The registry is the on-chain source
of truth for *which enclaves exist, where, and what code they claim*. Callers
read it from any RPC and connect to an enclave **directly**, verifying its live
attestation with Tinfoil's SecureClient. There is no trusted middleman: the
contract publishes claims, attestation (at connect time) gates trust.

```
caller --(eth_call)--> NanRegistry            "enclave at URL, repo=org/repo"
caller --(/availability)--> each enclave      live free share (off-chain)
caller --(SecureClient(URL, repo))--> enclave verifies SEV-SNP/TDX + Sigstore, pins TLS
```

## Files
- `contracts/NanRegistry.sol` — the registry (open, no deps, ~120 lines).
- `contracts/NanRegistry.abi.json` — ABI for JS callers.
- supervisor self-registration — built into `supervisor.js` (`registerOnChain`).
- `scripts/nan-discover.mjs` — caller-side read + availability aggregation + pick.

## 1. Deploy the contract to Base (chain 8453)

No constructor args. Any toolchain works; quickest is Remix or Foundry.

Foundry:
```bash
forge create contracts/NanRegistry.sol:NanRegistry \
  --rpc-url https://mainnet.base.org \
  --private-key $DEPLOYER_PK \
  --broadcast
```
Note the deployed address — that's `REGISTRY_ADDRESS` everywhere below. (Test on
Base Sepolia first with its RPC + a faucet if you want a dry run.)

## 2. Give each enclave a registry config

The enclave self-registers on boot when `REGISTRY_ENABLED` is set. Add to the
supervisor container's env in `tinfoil-config.yml`:

```yaml
env:
  REGISTRY_ENABLED: "1"
  REGISTRY_ADDRESS: "0x<deployed registry address>"
  ENCLAVE_ENDPOINT: "https://enclave1.nan.containers.tinfoil.dev"  # this enclave's own URL
  ENCLAVE_REPO:     "SteveDeFacto/Nan"      # what callers attest against (Sigstore-measured)
  # REGISTRY_HEARTBEAT_SEC: "900"           # optional, default 15 min
```

And the operator key as an **enclave secret** (not plaintext env):
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
REGISTRY_ADDRESS=0x... BASE_RPC=https://mainnet.base.org node scripts/nan-discover.mjs 0.25
```
Prints aggregate free capacity across all live enclaves and the best one for a
0.25 share, ending with the endpoint+repo to hand to SecureClient.

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
  live quote won't match a NAN-good `repo`/measurement, so callers reject it.
- **Liveness is advisory**: heartbeats set `lastSeen`; readers drop entries
  staler than their window (the helper uses 1h).
- **Open registration for now.** Sybil resistance via stake-to-register +
  slashing is a future add (see the note at the bottom of the .sol); it isn't
  needed for correctness because attestation, not registration, gates trust.

## Verify on first deploy
After one enclave registers:
```bash
node scripts/nan-discover.mjs        # should list it with live availability
```
You should see it in `all[]` with a real `maxShare`, and `chosen` set. That's the
full loop: chain registry -> live availability -> a pick, with nothing trusted
in the middle.
