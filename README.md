# Enclave

**Trustless compute you can actually verify.** Enclave is a confidential-compute platform: publish a WebAssembly app to an on-chain catalog, fund a deployment straight from your wallet, and it runs inside a hardware-attested enclave (Intel TDX + NVIDIA confidential computing on H200 nodes) that neither the operator nor the host can see into. TLS terminates inside the enclave, billing is per-second on Base, and the whole chain of trust, from the CPU's attestation quote down to the exact commit of this repo that built the running image, can be verified from a browser before you send the service a byte.

- **Site / deploy console / app store:** https://enclave.host
- **Developer guide + API reference:** https://enclave.host/develop.html (OpenAPI spec: [site/openapi.json](site/openapi.json))
- **REST API:** https://api.enclave.host/v1 (CORS-enabled; drive it from a browser)
- **Deployed apps:** `https://<id>.app.enclave.host`, TLS terminated in-enclave

There are no accounts and no KYC: an Ethereum wallet is the identity (email sign-in gets an embedded wallet). The project was formerly named **NaN**; the rename to **Enclave** is complete across code and contracts, with only a few live infrastructure names (the `nan.host` legacy domain, the Tinfoil org hostname) keeping the old token.

## How it works

1. **Apps are Wasm components** (`wasi:http`). Anyone publishes to the on-chain app store (`EnclaveAppCatalog` on Base): the bytes go to IPFS addressed by CID, the listing, versions, and resource specs live on-chain. The enclave image ships no deployable apps; everything it runs is fetched by CID and hash-verified inside the enclave.
2. **Deployments are on-chain work items** (`EnclaveDeployments`: create → fund → claim → lease). Funding is USDC (EIP-3009) or ETH, metered per second; top up to extend, stop anytime.
3. **Enclaves claim the work.** Each enclave self-registers in `EnclaveRegistry`, polls for funded work it can serve, claims it, and runs the app in a wasmtime sandbox: per-tenant process isolation, a private RAM-backed `/data`, no network beyond the served HTTP socket unless the app declares firewall ports.
4. **Every layer attests.** Tinfoil measures the container image (with a Sigstore transparency-log record tying it to this repo's release), the enclave proves the measurement in its attestation quote, and TLS keys never leave it. The site and CLI verify the full chain client-side before connecting.

Beyond plain web apps: GPU inference via `wasi-nn` (ONNX on an MPS-capped slice of an H200), attested read-only **model volumes** mounted at `/models` (Tinfoil Modelwrap; the attestation commits to the exact weight bytes), raw TCP/UDP services behind an SNI relay, per-deployment dedicated IPv6 (inbound and outbound), and a **platform model tier**, an 8×GPU vLLM flavor serving large models over an attested OpenAI-compatible API.

## Repository layout

| path | what it is |
|---|---|
| `supervisor.js` | the in-enclave service: REST API, deployment lifecycle, metering, attestation endpoints, platform-model proxy |
| `wasm/` | wasm-manager sidecar: the wasmtime sandbox that runs tenant apps |
| `worker/` | GPU worker: `wasi-nn` ONNX inference on MPS-capped GPU slices |
| `mps-daemon/` | NVIDIA MPS control daemon (fractional GPU shares) |
| `vllm/` | the 8×GPU platform-model image (vLLM) |
| `contracts/` | Solidity on Base: `EnclaveRegistry`, `EnclaveAppCatalog`, `EnclaveDeployments` |
| `relay/` | SNI relay + dedicated-IP relay (TLS passthrough to enclaves, IPv6 ingress/egress) |
| `egress.js` / `net-guard.mjs` | outbound egress shim and network guard |
| `site/` | the enclave.host static site, published to IPFS (LWC-style web components, soft-nav router; `npm run build:site`) |
| `cli/` | the `enclave` CLI (deploy, fund, attest-verify from a terminal) |
| `enclaves/` | Tinfoil config flavors: `gpu/`, `cpu/`, `gpu8/` (platform model) |
| `scripts/` | build, release, and CI setup |
| `test/` | `npm test` (node --test) |

## Resources: apps declare specs, deployments buy shares

**Apps** declare their exact resource specs in the on-chain catalog (EnclaveAppCatalog): `vramMb` + `gpuGflops` of one GPU card (both 0 = CPU-only app) and `memMb` + `cpuGflops` of the node (compute in GFLOPS = 1/1000 TFLOPS). Every app deploys from that catalog by IPFS CID; the enclave image ships no deployable apps.

**Deployments** buy exactly TWO shares, the only two settings on the deploy page (0–100% each):

- **`gpuShare`**: a slice of ONE GPU card. VRAM and compute move together: the same fraction caps both (MPS compute % + VRAM cap). 0 = CPU-only app.
- **`cpuShare`**: a slice of the node's vCPU+RAM. The wasm guest's memory cap is that slice of the node's RAM.

The app's specs set the **minimum shares**: each pool's floor is the spec divided by the server's spec (H200 = 141 GB / 989 TFLOPS via `GPU_VRAM_GB`/`GPU_TFLOPS`; node = 64 GB / ~1000 GFLOPS via `NODE_RAM_GB`/`NODE_GFLOPS`; CPU compute is denominated in GFLOPS because a whole node is only ~1/1000 of a card), taking the **larger** of the memory and compute axes, rounded up to the whole percent. A GPU app's CPU minimum also lifts its GPU minimum, because of the invariant: **`gpuShare >= cpuShare` whenever `gpuShare > 0`** (a GPU app's CPU slice rides on the same node as its card). Runners enforce the minimums at deploy and claim time; the site's deploy page floors its two dials at them.

The leftovers are the point: a tenant buying 100% GPU + 10% CPU leaves 90% of that node's CPU/RAM rentable by CPU-only apps. Pricing is additive: `rate = gpuShare × cardRate ($6/hr) + cpuShare × nodeRate ($1/hr)`, per second.

Routing: GPU work (`gpuShare > 0`) runs **only** on GPU-enabled enclaves. CPU-only work is served by CPU-only enclaves first; GPU enclaves bid on it only after a grace window (`CPU_CLAIM_GRACE_SEC`, default 120s) and only out of leftover CPU pool.

## Enclave flavors & releases (operators)

The service runs as a [Tinfoil container](https://docs.tinfoil.sh/containers/overview); each flavor's config lives under `enclaves/` and **flavor selection happens by release tag**. The Tinfoil dashboard has no config-file picker; it always reads `tinfoil-config.yml` from the repo root of a release tag. That is why there is deliberately no root config on `main`: each release workflow copies its flavor's config to the root **in the release-tag commit**. Deploy a `vX.Y.Z` tag for the GPU flavor or a `vX.Y.Z-cpu` tag for the CPU flavor. Each release creates an auditable record in the Sigstore transparency log.

- `enclaves/gpu/tinfoil-config.yml`: GPU flavor (supervisor + MPS daemon + GPU worker + wasm-manager). Serves GPU deployments, plus CPU-only deployments out of leftover CPU/RAM. Released as `vX.Y.Z` via `gh workflow run tinfoil-release.yml -f version=vX.Y.Z`.
- `enclaves/cpu/tinfoil-config.yml`: CPU flavor (supervisor + wasm-manager only, `GPU_COUNT=0`). Serves CPU-only deployments (GPU asks are refused with a 422). Released as `vX.Y.Z-cpu` via `tinfoil-release-cpu.yml`.
- `enclaves/gpu8/tinfoil-config.yml`: the 8×GPU platform-model flavor (vLLM serving a large model over the supervisor's attested proxy). Released via `tinfoil-release-gpu8.yml`.

To spin up a CPU enclave:

1. Release the CPU flavor (CPU versions must end in `-cpu`; the workflow copies `enclaves/cpu/tinfoil-config.yml` to the root, pins the supervisor digest, and measures that copy). `scripts/release.sh` repins image digests into **both** flavor configs.
2. In the Tinfoil dashboard, deploy the `-cpu` release tag with the same secrets (`SECRET`, `ADMIN_TOKEN`, `REGISTRY_PRIVATE_KEY`; use a distinct registry EOA per enclave). No config selection is needed: the `-cpu` tag's default config IS the CPU flavor.
3. The enclave self-registers in EnclaveRegistry like any other; callers read both pools from `/availability` (`gpuShareFree` / `cpuShareFree`; `gpu: false` marks the CPU flavor).

How the routing is enforced:

- **Deploys**: the supervisor floors `resources.{gpuShare, cpuShare}` at the app's spec-derived minimums, enforces `gpuShare >= cpuShare` for GPU apps, and refuses `gpuShare > 0` on a CPU enclave. CPU-only requests are served on either flavor from the node's CPU pool.
- **On-chain**: `EnclaveDeployments.create(appRef, gpuMilli, cpuMilli, ...)` takes the two shares in 1/1000ths (the contract enforces the invariant and prices both). GPU enclaves only adopt `gpuMilli > 0` work; CPU-only work goes to CPU enclaves first, with GPU enclaves as a delayed fallback (`CPU_CLAIM_GRACE_SEC`). Each runner re-derives the app's minimum shares from its catalog specs (via `cidStatus`) and skips under-provisioned deployments.
- **Apps**: catalog apps declare exact specs on-chain on four axes: `vramMb`/`gpuGflops`/`memMb`/`cpuGflops` (EnclaveAppCatalog, returned by `cidStatus`). Those specs only set minimum shares; GPU-needing apps are refused on nodes with `NODE_HAS_GPU=0`.

Verification caveat: verifiers that check against this repo's *latest* release (the `tinfoil-cli` default) will see the GPU flavor's measurement, so verify CPU enclaves against their matching `-cpu` release explicitly.

## CI/CD (push-to-main deploys)

Every push to `main` runs `.github/workflows/deploy.yml`, which diffs against the
last successfully deployed commit and deploys only what changed:

| what changed | what happens |
|---|---|
| `site/**` | scp + IPFS publish to the site box (`site/deploy.sh`) |
| `relay/**` | scp + systemd restart on the relay box (`relay/deploy.sh`) |
| `contracts/<Name>.sol` | that contract deploys to Base (`scripts/deploy-*.mjs`), **after a one-click approval** on the `contract-deploy` environment; addresses are wired into both tinfoil configs + the site and committed back |
| `Dockerfile` / `supervisor.js` / `package*.json` | a new Tinfoil release (supervisor is built by `tinfoil-release.yml`) |
| `worker/**`, `mps-daemon/**`, `wasm/**` | changed sidecar images are built + digest-repinned (`scripts/release.sh`), then a Tinfoil release |
| `enclaves/*/tinfoil-config.yml` (non-`image:` lines) | a new Tinfoil release (config is part of the measurement) |

Releases are auto-versioned (latest `vX.Y.Z` tag, patch-bumped) and dispatch the
existing `tinfoil-release.yml`, plus `tinfoil-release-cpu.yml` when the CPU
flavor is affected (supervisor/wasm-manager/config; worker and mps are GPU-only).
A registry redeploy automatically cascades into a deployments redeploy (claims
are gated to the registry).

Deliberately still manual:

- **Approving contract deploys:** redeploys mint fresh addresses and on-chain
  state (registry entries, deployment balances) does not migrate. Approve or
  reject under the run's **Review deployments** prompt; rejecting skips the
  contract jobs and the rest of the pipeline continues on the next push.
- **Updating the running enclaves:** after a release publishes, click
  **Update** in the [Tinfoil dashboard](https://dash.tinfoil.sh) (no public API).

One-time setup on a new machine/repo: `scripts/ci-setup.sh` (SSH deploy key,
repo secrets/vars, the `contract-deploy` environment), then set
`DEPLOYER_PRIVATE_KEY` on that environment. The local `scripts/hooks/pre-push`
site-deploy hook predates this pipeline and is now redundant; disable it with
`git config --unset core.hooksPath` if you don't want pushes deploying the site
twice.

## Development

- `npm test` runs the supervisor/contract test suite (`test/*.test.mjs`).
- `npm run build:site` bundles the site into `site/dist/` (Tailwind + esbuild + build-time component prerender). `site/` itself is valid unbundled ES modules; serve it raw for dev, or `npm run watch:site` for CSS. Site URLs are extensionless (`/apps`, `/dashboard`): `site/_redirects` rewrites them on the DNSLink/subdomain IPFS gateway, and the router always fetches the real `.html` files, so soft navigation works on any dumb static server; only a HARD reload of a pretty URL needs rewrite support (use `npx serve site`, or just hit the `.html` path; the router re-prettifies the bar).
- `site/deploy.sh` builds and publishes the site to the box and IPFS (the IPNS gateway caches ~5 min). CI does this automatically on push.

## Documentation & support

- App developers: the guide and API reference live on the site at https://enclave.host/develop.html
- The underlying confidential-container platform is [Tinfoil](https://docs.tinfoil.sh) ([contact@tinfoil.sh](mailto:contact@tinfoil.sh))
