# Enclave Wasm apps

Sources and prebuilt artifacts for the platform's first-party apps. **Nothing
here is deployable straight from the image**: every app — first-party or
community — is published to the **on-chain app catalog** (`EnclaveAppCatalog` on
Base, the **Apps** tab on the site), addressed by IPFS CID, and deploys as
`ipfs://<cid>`. The manager fetches the CID in-enclave and verifies the bytes
hash to it (`ipfs_fetch.py`), so "what ran == this exact CID" holds without
trusting the gateway, and the verified CID is folded into attestation. The
supervisor refuses any non-CID reference (and any CID the catalog owner has
not approved) — one catalog, one deploy path, fail closed.

> One `.wasm` here IS still copied into the image: `nn-demo.wasm`, as the boot
> probe's fixture. The CUDA readiness probe serves it through the real
> wasmtime + ONNX Runtime stack at startup to prove GPU inference end to end
> before GPU deploys are allowed. It is launched only by the manager itself;
> it is not deployable by id through the API.

First-party apps to publish (see each directory for source):

| app | artifact | publish specs (exact, GFLOPS = 1/1000 TFLOPS) |
|---|---|---|
| `hello-world` | `hello-world.wasm` (committed) | vram 0 / gpu 0 / mem 128 MB / cpu ~10 GFLOPS |
| `nn-demo` | `nn-demo.wasm` (committed) | vram 1024 MB / gpu 10 / mem 128 MB / cpu 10 / storage 64 MB |
| `llm-chat` | release asset `llm-chat-v0.1.1` (123MB, past git's file limit) | vram 1024 MB / gpu 10 / mem 512 MB / cpu 10 / storage 0 |

## App requirements

Apps must be **`wasi:http` components** (the format `wasmtime serve` runs). The
component exports the `wasi:http/incoming-handler` interface: it receives an HTTP
request and returns a response, like a serverless function. The manager owns the
listener and binds it to a per-tenant loopback port; the app never opens its own
socket.

**Service apps (firewall ports).** A catalog version published with a firewall
config (`http:N` / `tcp:N` / `udp:N`) runs differently: the manager launches it
with `wasmtime run` and grants **wasi:sockets** (`-Stcp -Sudp
-Sallow-ip-name-lookup` plus, for the network address policy, either
`-Sinherit-network` **or** — when dedicated-IP egress is enabled and the
toolchain carries the transparent shim — `-S egress=<host>:<port>` in its place).
The app is a long-running *command* component that binds its ports itself (Rust
`std::net` on `wasm32-wasip2` maps to wasi:sockets). Under `-S egress` the guest
keeps its inbound binds (`tcp:N`/`udp:N`) but its outbound is transparently
source-tagged and it has no raw network — see *Dedicated-IP egress* below.

**WASIp3 (component-model async).** Both modes are also launched with `-S p3`
(wasmtime 45+), so apps may target the WASIp3 API surface — native async
sockets/streams instead of wasip2's poll-based ones — as an alternative to
wasip2. Every other rule is unchanged: same `ENCLAVE_PORTS` contract, same bind
audit, same no-fs/no-env sandbox, and the p3 flag does not widen network
access (that stays gated by the socket grants above). Note guest toolchains
are still young — e.g. Rust lists a `wasm32-wasip3` target but most distros
don't ship its std yet. Operators can set `WASM_P3=0` on the wasm-manager to
drop the flag fleet-wide.

**GPU inference (wasi-nn).** A deployment that buys a GPU share (`gpuShare > 0`)
is launched with `-S nn`: the component may import `wasi:nn`
(0.2.0-rc-2024-10-28, vendored from wasmtime 45) and run ONNX inference through
the host's ONNX Runtime — `ExecutionTarget::Gpu` is the CUDA execution provider
on the enclave's H200, `::Cpu` the CPU provider. Enforcement is per OS process
via MPS, the same scheme as the worker backend's PTX children: the tenant's
wasmtime process launches with `CUDA_MPS_ACTIVE_THREAD_PERCENTAGE` = gpuShare
and `CUDA_MPS_PINNED_DEVICE_MEM_LIMIT` = gpuShare × `GPU_VRAM_GB`, so SM% and
VRAM are hardware-capped. Deployments without a GPU share never get the flag —
a component importing `wasi:nn` then fails to instantiate ("not found in the
linker"); the boundary is structural. The platform's wasmtime carries
`wasm/wasmtime-onnx-gpu-strict.patch`: `::Gpu` either initializes CUDA or
`load()` fails — never ONNX Runtime's silent CPU fallback. Complete examples:
[`nn-demo/`](nn-demo/) (minimal; also the boot probe's fixture inside the
image) and [`llm-chat/`](llm-chat/) (full transformer decode; regenerate
nn-demo's model with `gen-model.py`, rebuild either with `cargo component
build --release --target wasm32-wasip2`). Operator kill-switch: `WASM_NN=0`
on the wasm-manager.

Declared ports are **logical** — the app's stable, advertised interface, like a
container's EXPOSE. Each deployment gets its own **actual** loopback bind, so two
tenants can run "the tcp:5432 app" at the same time with zero conflicts; the URL
routes by deployment id, never by raw port. The mapping is handed to the app as

```
ENCLAVE_PORTS=tcp:5432=31245,udp:9053=31246     # logical=actual — BIND THE ACTUAL
```

**The one rule for app authors: read `ENCLAVE_PORTS` and bind the actual ports.
Never hardcode.** (When the logical number is free the manager assigns it
unchanged, so hardcoded apps limp along single-instance — until the audit kills
them for binding an unassigned port when it isn't.) Enforcement: a /proc audit
sweep kills any app binding an unassigned port ≤19999; logical labels are
1-19999 (8080/8091 reserved; below 1024 — e.g. `udp:53` — always remapped, since
privileged actuals are never bound). `http:N` means "the app serves HTTP on N" and
the supervisor proxies `/x/:id` to its actual bind; `tcp:N` ports are reached
via the WebSocket bridge `/x/:id/tcp/N` — always the logical N; the supervisor
resolves it to the deployment's actual (see `portMap` on the deployment record).

**Direct public TCP (no websocat).** A declared `tcp:N` is also served at
`/x/:id/tls/N`: same bridge, but the supervisor terminates the *client's* TLS
in-enclave first (platform key + cert minted in-enclave at boot; enabled by
`TLS_BRIDGE_DOMAIN`). An untrusted public relay (`relay/README.md`) SNI-routes
`<dep-id>.tcp.<domain>:<port>` into that path, so stock clients (`irssi --tls`,
`psql sslmode=require`) connect directly while the relay only ever carries
ciphertext. Apps need nothing for this — keep speaking plain TCP on the
assigned port; TLS is platform dressing. Verifying clients can bind the
session to the attestation: `GET /v1/tls-bridge` (served over the attested
origin) publishes the platform cert's fingerprints to pin.

**Public UDP (`udp:N`).** A declared `udp:N` is bridged at `/x/:id/udp/N`
(datagrams over the WS, 1 message = 1 datagram). Because UDP has no SNI, each
deployment gets its **own IPv6** (from the box's /64; the deploy response's
`network.udp` shows `[address]:port`), and the UDP relay routes by address.
The app just binds its assigned actual UDP port as normal. Two limits worth
knowing: it's **IPv6-only** (a box has one v4), and the relay sees **cleartext**
(it's not a confidentiality boundary — encrypt at the app, e.g. DTLS, if you
need privacy). See `relay/README.md`.

**Dedicated-IP egress (transparent + `ENCLAVE_EGRESS`).** The other direction: when
the operator enables egress, **all** of a deployment's outbound — a `run`-mode
app's raw `wasi:sockets` connects *and* a `serve`-mode app's `wasi:http` calls —
**leaves from the deployment's own IPv6**, the same address its inbound
`tcp:N`/`udp:N` ports are served on. So a deployment has one stable identity in
both directions, like a VM with a public IP, and **you write nothing** — an
unmodified app is already source-tagged. It is transparent because the
platform's wasmtime intercepts the guest's connect / outgoing-HTTP path and
routes it through the enclave's egress front; with it on the guest has **no raw
network at all** (no ambient `-Sinherit-network`), so nothing can egress
off-identity.

The tenant env still carries **`ENCLAVE_EGRESS`** (a
`socks5h://<id>:<token>@127.0.0.1:<port>` URL) for apps that want to steer
outbound explicitly — point an HTTP client's proxy or a SOCKS dialer at it — but
you no longer *need* to: routing is automatic. Notes: dedicated source is
**IPv6-only** (v4 destinations, if allowed at all, share the box's v4); the relay
resolves DNS and enforces SSRF (no loopback/private targets — so an app also
can't reach the enclave's own `127.0.0.1` control ports); **raw UDP egress is
denied** (not mediated yet; inbound `udp:N` binds still work); and, as with the
inbound relays, the relay sees whatever you send — speak your own TLS for
confidentiality. One quirk worth knowing: under the lockdown a non-blocking
`connect_timeout` can report success for a DENIED dial — the socket then fails
on its first read/write (`NotConnected`); a plain blocking `connect` reports
the denial directly. No bytes ever flow either way. The credential is per-deployment: you can only egress as
yourself. On older toolchains without the transparent shim this degrades to the
explicit-`ENCLAVE_EGRESS`-only (proxy-aware) behavior. See `relay/README.md`.

Sandbox defaults (nothing to configure): a private writable `/data` (see below),
no host environment, no network beyond the served HTTP socket, memory capped per
deployment at its CPU share of the node's RAM (`cpuShare × NODE_RAM_GB` — always
at least the `mem_mb` the app's specs declare, since the specs floor the share).
Peer isolation = separate Wasm sandbox + separate OS process per app.

**Scratch filesystem (`/data`).** Every deployment is launched with a private,
writable `/data` preopen (wasi:filesystem via `wasmtime --dir`), so off-the-shelf
code that reads and writes files — a SQLite DB, a cache, config, logs — ports to
wasm without being rewritten. In Rust it's just `std::fs`/`std::path` under
`/data`; other languages' stdlib file I/O maps to the same wasi interface.

It is **RAM-backed and strictly ephemeral**: the enclave's whole filesystem is a
ramdisk (already inside the TEE's encrypted memory), and `/data` is torn down
when the deployment ends. There is no persistence and no shared storage — treat
it as scratch space, not a database of record. Isolation is the wasi capability
model: an app sees *only* its own `/data`; there is no preopen for anything else,
and a path escaping the tree (`/data/../../etc/...`) is refused by the runtime.

Usage is capped per app by `storage_mb` (default 256; the audit sweep kills an
app that exceeds it, since a ramdisk file tree consumes RAM the linear-memory
cap doesn't cover). Set `storage_mb: 0` to opt an app out of `/data` entirely (back to the
old no-filesystem sandbox). Operators can disable the feature fleet-wide with
`WASM_FS=0` on the wasm-manager, or relocate the backing dir with `WASM_FS_DIR`.

## Publish specs

The on-chain catalog records each version's **exact specs** on four axes:
memory (MB) and compute (GFLOPS = 1/1000 TFLOPS) of a GPU card and of a node.
The specs set the MINIMUM shares a deployment must buy: spec / the node's
spec, the larger of the memory and compute axes, rounded up to the percent
grain. Either GPU axis > 0 marks a GPU app: it is refused on `NODE_HAS_GPU=0`
nodes. The guest linear-memory cap is the deployment's `cpuShare ×
NODE_RAM_GB` (enforced via `wasmtime -W max-memory-size`, floor
`WASM_APP_MIN_MEM_MB`=64 — not RLIMIT_AS, which would kill wasmtime's
terabyte-scale virtual reservations), so it is always >= the declared memory.
`storage_mb` caps the app's `/data` scratch filesystem (see above), enforced
by the audit sweep; `0` disables `/data`.

## llm-chat (oversized artifact)

`llm-chat` bakes a whole model into the component (SmolLM2-135M-Instruct,
ONNX q4f16 + tokenizer + chat UI = 123MB), which is past git's 100MB file
limit, so its artifact is not committed: download it from the
**llm-chat-v0.1.1 GitHub release** (or rebuild from source: `llm-chat/`,
`fetch-model.sh` pins the model by HF revision + sha256, then
`cargo component build --release --target wasm32-wasip2`; the manual
**Wasm Apps** workflow does the same in CI and re-uploads the asset). Publish
the artifact to the on-chain catalog like any other app — 123MB is under the
manager's 256MB fetch cap. It needs the enclave-wasmtime toolchain from enclave
release v0.5.26+: tensor dtypes (i64 token ids, fp16 outputs, zero-size KV
bootstrap tensors; patch parts 3+4) and the per-process session cache (part
5 — without it every request re-initializes the 117MB session, which under
CC is slow enough to trip the proxy and wedge the tenant).

## Building the sample `hello-world.wasm`

Requires the Rust toolchain and `cargo-component`:

```bash
rustup target add wasm32-wasip2
cargo install cargo-component

# in a scratch crate:
cargo component new hello-world --lib && cd hello-world
```

Set `wit/world.wit`:

```wit
package enclave:hello-world;
world hello-world { export wasi:http/incoming-handler@0.2.0; }
```

`src/lib.rs`:

```rust
use wasi::http::types::{Fields, IncomingRequest, OutgoingBody, OutgoingResponse, ResponseOutparam};
wasi::http::proxy::export!(Component);
struct Component;
impl wasi::exports::http::incoming_handler::Guest for Component {
    fn handle(_req: IncomingRequest, out: ResponseOutparam) {
        let resp = OutgoingResponse::new(Fields::new());
        let body = resp.body().unwrap();
        ResponseOutparam::set(out, Ok(resp));
        let stream = body.write().unwrap();
        stream.blocking_write_and_flush(b"Hello World!\n").unwrap();
        drop(stream);
        OutgoingBody::finish(body, None).unwrap();
    }
}
```

Build, then publish the artifact to the on-chain catalog (Apps tab on the
site) and deploy it by CID:

```bash
cargo component build --release --target wasm32-wasip2
# artifact: target/wasm32-wasip2/release/hello_world.wasm
```

(Exact WASI binding APIs shift between `wasi` crate versions; pin the crate
version documented for your `cargo-component`, and let the build errors guide the
handler signature. The shape above is the stable wasi:http/proxy pattern.)

## Verifying an app locally

```bash
wasmtime serve -S cli --addr 127.0.0.1:8080 apps/hello-world.wasm
curl 127.0.0.1:8080/    # -> Hello World!
```

If that works locally, it works in the enclave; the manager runs the identical
command per tenant on a private port.
