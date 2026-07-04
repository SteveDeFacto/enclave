# Tinfoil Containers Template

A GitHub template repository for deploying a pre-built Docker image as a [Tinfoil Container](https://docs.tinfoil.sh/containers/overview) (in a secure enclave)

Out of the box, this template deploys [`tinfoil-containers-hello-world`](https://github.com/tinfoilsh/tinfoil-containers-hello-world): a tiny HTTP server that reads a `MESSAGE` env var and a `GREETING_TOKEN` secret, and responds with both.

## Deploy It

1. Click **[Use this template](https://github.com/tinfoilsh/tinfoil-containers-template/generate)** → **Create a new repository**
2. In the [Tinfoil Dashboard](https://dash.tinfoil.sh), open the **Secrets** tab and add `GREETING_TOKEN` with any value
3. Release a version by running the **Tinfoil Release** workflow:
   - **CLI:** `gh workflow run tinfoil-release.yml -f version=v0.0.1`
   - **UI:** **Actions** tab → **Tinfoil Release** → **Run workflow**, then enter the version
4. **Containers** → **Deploy**, select your repo and tag, and click **Deploy**

Once running, `curl https://<container-name>.<org>.containers.tinfoil.dev` returns:

```
MESSAGE: <value from tinfoil-config.yml>
GREETING_TOKEN: <present if secret exists>
```

## Use your own image

1. If you have a prebuilt image, edit `tinfoil-config.yml` to point at the image you want to deploy: change `image:` to your `<repo>@sha256:<digest>`, adjust `env`/`secrets`/`shim` for your container, then release a new version.
2. If you have your own code in a private repo, [`tinfoil-containers-hello-world`](https://github.com/tinfoilsh/tinfoil-containers-hello-world) shows the build-and-publish side and can be added to an existing repository.
3. If you have your own code in a public repo, use the simple [`tinfoil-public-containers-template`](https://github.com/tinfoilsh/tinfoil-public-containers-template) for an all-in-one-repo example. Since the `tinfoil-config.yml` has to be public, public app code can live in the same repo as the config.

## Updating

Edit `tinfoil-config.yml`, commit, then release a new version (`gh workflow run tinfoil-release.yml -f version=v0.0.2`, or via the **Actions** tab). Then click **Update** in the dashboard. Each release creates an auditable record in the Sigstore transparency log.

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
| `tinfoil-config*.yml` (non-`image:` lines) | a new Tinfoil release (config is part of the measurement) |

Releases are auto-versioned (latest `vX.Y.Z` tag, patch-bumped) and dispatch the
existing `tinfoil-release.yml` — plus `tinfoil-release-cpu.yml` when the CPU
flavor is affected (supervisor/wasm-manager/config; worker and mps are GPU-only).
A registry redeploy automatically cascades into a deployments redeploy (claims
are gated to the registry).

Deliberately still manual:

- **Approving contract deploys** — redeploys mint fresh addresses and on-chain
  state (registry entries, deployment balances) does not migrate. Approve or
  reject under the run's **Review deployments** prompt; rejecting skips the
  contract jobs and the rest of the pipeline continues on the next push.
- **Updating the running enclaves** — after a release publishes, click
  **Update** in the [Tinfoil dashboard](https://dash.tinfoil.sh) (no public API).

One-time setup on a new machine/repo: `scripts/ci-setup.sh` (SSH deploy key,
repo secrets/vars, the `contract-deploy` environment), then set
`DEPLOYER_PRIVATE_KEY` on that environment. The local `scripts/hooks/pre-push`
site-deploy hook predates this pipeline and is now redundant — disable it with
`git config --unset core.hooksPath` if you don't want pushes deploying the site
twice.

## Resources: exact resources in, two shares calculated

Apps specify **exact resources on four axes** — memory and compute for each pool: `vramMb` + `gpuGflops` of one GPU card (both 0 = CPU-only app), and `memMb` + `cpuGflops` of the node (`memMb` is also the wasm guest's runtime-enforced memory cap; compute is measured in TFLOPS, stored as integer GFLOPS = 1/1000 TFLOPS on-chain). The platform **calculates two normalized shares** — the allocation/routing/billing unit — by dividing the app's spec by the server's spec, taking the LARGER of the memory- and compute-derived share per pool, rounded UP to the whole-percent grain so a share is never worth less than what was asked for:

- **`gpuShare` (0..1)** = `max(vramGb / CARD_VRAM_GB, gpuTflops / GPU_TFLOPS)`. The MPS compute % and VRAM cap both follow it.
- **`cpuShare` (0..1)** = `max(memMb / node RAM, cpuTflops / NODE_TFLOPS)`. The node's vCPUs come along in the same proportion.

Server specs: H200 card = 141 GB / 989 TFLOPS (`GPU_VRAM_GB` / `GPU_TFLOPS`); node = 64 GB / ~1 TFLOPS (`NODE_RAM_GB` / `NODE_TFLOPS`). The max() means a compute-bound app (little VRAM, many TFLOPS) still pays for the throughput it occupies, and vice versa.

Invariant: a GPU app's CPU slice rides on the same node as its card, so the derived **`gpuShare >= cpuShare` whenever `gpuShare > 0`**. The leftovers are the point — a tenant taking a whole card + 10% of the node leaves 90% of that node's CPU/RAM rentable by CPU-only apps. Pricing is additive on the derived shares: `rate = gpuShare × cardRate ($6/hr) + cpuShare × nodeRate ($2/hr)`, per second.

Routing: GPU work (either GPU axis > 0) runs **only** on GPU-enabled enclaves. CPU-only work is served by CPU-only enclaves first; GPU enclaves bid on it only after a grace window (`CPU_CLAIM_GRACE_SEC`, default 120s) and only out of leftover CPU pool.

## CPU-only enclaves

The repo ships two enclave flavors:

- `tinfoil-config.yml` — the GPU flavor (supervisor + MPS daemon + GPU worker + wasm-manager). Serves GPU deployments, plus CPU-only deployments out of leftover CPU/RAM.
- `tinfoil-config.cpu.yml` — the CPU flavor (supervisor + wasm-manager only, `GPU_COUNT=0`). Serves CPU-only deployments (`gpuShare` is refused with a 422).

To spin one up:

1. Release the CPU flavor: `gh workflow run tinfoil-release-cpu.yml -f version=v0.0.1-cpu` (CPU versions must end in `-cpu`; the workflow pins the supervisor digest into `tinfoil-config.cpu.yml` and measures that config). `scripts/release.sh` repins image digests into **both** configs.
2. In the Tinfoil dashboard, deploy the `-cpu` release with the same secrets (`SECRET`, `ADMIN_TOKEN`, `REGISTRY_PRIVATE_KEY` — use a distinct registry EOA per enclave).
3. The enclave self-registers in NanRegistry like any other; callers read both pools from `/availability` (`gpuShareFree` / `cpuShareFree`; `gpu: false` marks the CPU flavor).

How the routing is enforced:

- **HTTP deploys**: the supervisor takes `resources.{vramGb, gpuTflops, memMb, cpuTflops}`, calculates the shares, enforces the derived `gpuShare >= cpuShare` for GPU apps, and refuses GPU asks on a CPU enclave. CPU-only requests are served on either flavor from the node's CPU pool.
- **On-chain deploys**: `NanDeployments.create(appRef, [vramMb, gpuGflops, memMb, cpuGflops], ...)` takes the exact axes; the contract derives and snapshots `gpuMilli`/`cpuMilli` against owner-set reference specs (`cardVramMb`/`cardGflops`/`nodeRamMb`/`nodeGflops`, matching the fleet), enforces the invariant, and prices both derived shares. GPU enclaves only adopt GPU work; CPU-only work goes to CPU enclaves first, with GPU enclaves as a delayed fallback (`CPU_CLAIM_GRACE_SEC`).
- **Apps**: catalog apps declare exact minimum resources on the same four axes — `vramMb`/`gpuGflops`/`memMb`/`cpuGflops` on-chain (NanAppCatalog, returned by `cidStatus`) and `vram_mb`/`gpu_gflops`/`mem_mb`/`cpu_gflops` in `wasm/apps/catalog.json` for baked-in apps. Runners refuse deployments that asked for less on any axis; GPU-needing apps are refused on nodes with `NODE_HAS_GPU=0`.

Verification caveat: verifiers that check against this repo's *latest* release (the `tinfoil-cli` default) will see the GPU flavor's measurement — verify CPU enclaves against their matching `-cpu` release explicitly.

## Documentation

For the full configuration reference, secrets management, debug mode, and more:

**[docs.tinfoil.sh/containers](https://docs.tinfoil.sh/containers/overview)**

## Support

- [Documentation](https://docs.tinfoil.sh)
- [Email Support](mailto:contact@tinfoil.sh)
