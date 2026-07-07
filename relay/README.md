# Enclave public relays

Small, **untrusted**, stateless daemons that live outside the enclave —
on any box with a public IP — and give the fleet a friendly front door
without ever entering the trust boundary:

- [`relay.js`](relay.js) — **TCP relay (SNI)**: normal public TCP endpoints for
  service apps on shared ports, demuxed by TLS SNI, TLS terminates in-enclave.
  Details below.
- [`tcp6-relay.js`](tcp6-relay.js) — **dedicated-IP TCP relay**: each deployment's
  `tcp:N` ports served on its OWN IPv6 at the real port, routed by destination
  address (no SNI, no TLS required — any protocol). Details below.
- [`udp-relay.js`](udp-relay.js) — **UDP relay**: public reach for apps'
  declared `udp:N` ports, one IPv6 per deployment. Details below.
- [`egress-relay.js`](egress-relay.js) — **dedicated-IP egress relay**: the
  OUTBOUND half — the app connects out FROM its own IPv6 (via `ENCLAVE_EGRESS`),
  source-bound at the relay. Details below.
- [`api-relay.js`](api-relay.js) — **API relay**: fleet discovery + placement.
  Reads EnclaveRegistry on Base for live enclaves, polls their `/availability`,
  and steers new work to the most available one.
- [`net-guard.mjs`](net-guard.mjs) — shared SSRF classifier (symlink to the
  repo-root canonical file; also imported by the enclave's `egress.js`).
- [`fleet.mjs`](fleet.mjs) — shared fleet discovery for the dedicated-IP
  relays: `REGISTRY_ADDRESS` (EnclaveRegistry on Base, re-read periodically) or
  `ENCLAVES` (static list; `ENCLAVE_URL` still accepted as a one-entry alias).

Every deployment gets a **dedicated IPv6** out of the box's routed /64,
deterministic from its id. The `tcp6-relay` serves its `tcp:N` ports there, the
`udp-relay` serves its `udp:N` ports there, and the `egress-relay` makes its
OUTBOUND connections leave from it — one stable address per deployment, in both
directions, its declared ports at their real numbers (`[addr]:5432`,
`[addr]:443`). The SNI `relay.js` remains as a shared-port fallback (works
without a routed /64, and gives in-enclave TLS termination on the platform
cert).

The dedicated-IP relays are **fleet-aware**: point them at the registry (or a
static list) and they serve *every* live enclave — each poll merges every
enclave's map, and each binding/control channel remembers its owning enclave.
Enclaves join and leave without any relay config change. Requirements that
follow: every enclave that enables dedicated addressing sets `DEP_ADDR_PREFIX`
to THIS box's routed /64 (all derived addresses are bound here; ids are unique
fleet-wide so addresses never collide), and every enclave sets the SAME
`EGRESS_RELAY_TOKEN` (like the shared `SECRET`).

## API relay

```bash
cd relay && npm install
REGISTRY_ADDRESS=0x... node api-relay.js         # on-chain discovery, or:
ENCLAVES=https://enclave1...,https://enclave2... node api-relay.js
```

| route | |
|---|---|
| `GET /enclaves` | live fleet table + aggregate free capacity |
| `GET /route?gpuShare=0.25&cpuShare=0.05` | best enclave with both shares free (gpuShare 0 = CPU-only: CPU enclaves first, GPU leftovers as fallback; derive minimum shares from the app's specs against /availability): `{ endpoint, repo, availability }` |
| `POST /v1/deployments` | **placement**: routed by the body's `resources.{gpuShare,cpuShare}` with the `/route` rule, then proxied there |
| `GET /v1/deployments` | fanned out to every live enclave, lists merged (one wallet, one list) |
| `/v1/deployments/{id}...`, `/x/{id}...` | proxied to the enclave that **owns** that deployment (probed once, cached) |
| `GET /availability` | **fleet aggregate**: best single-card slice + best node pool across enclaves, plus `gpuEnclaveCpuShareFree` (a GPU deployment's CPU share must fit the GPU enclave's own node) |
| `/v1/auth/*`, other `/v1/*` | one sticky enclave (SIWE nonces are per-enclave state; GPU enclave preferred, it serves the full surface) |
| `GET /health` | poller freshness |

Trust model: as a **router** it can only misroute, never impersonate —
clients verify attestation on the enclave's own origin (Tinfoil SecureClient
with the registry's `repo`), and `/route` exists for clients that want to
skip the gateway entirely (it mirrors `scripts/enclave-discover.mjs`; run that
locally if you'd rather not trust anyone's relay). The `/v1` gateway path,
however, terminates TLS here and sees control-plane tokens and bodies in
plaintext — the accepted trade for giving browsers a single origin.

Notes:
- **Set the same `SECRET` on every enclave.** Sessions are stateless JWTs
  signed with it, so with one shared secret a login on the sticky enclave
  works fleet-wide — which is what makes create-placement plus
  per-deployment routing seamless. Different secrets = a token only works on
  the enclave that issued it.
- Config: `REGISTRY_ADDRESS` or `ENCLAVES` (required), `BASE_RPC`,
  `API_RELAY_PORT` (8100), `AVAIL_POLL_SEC` (10), `REGISTRY_POLL_SEC` (300),
  `STALE_AFTER_SEC` (3600), `APP_DOMAIN` (per-deployment app subdomains).

## UDP relay

Gives an app's declared `udp:N` ports a reachable public endpoint. UDP carries
no SNI, so a shared port can't disambiguate tenants — instead **every
deployment gets its own IPv6** out of the box's routed /64, and the relay
routes by destination address:

```
client ──UDP──> [<per-deployment IPv6>]:N ──WS (1 msg = 1 datagram)──> enclave
                                              /x/<id>/udp/N ──UDP──> app
```

The supervisor derives each deployment's address deterministically from its id
(`/v1/udp-map` publishes the list); the relay polls that map, binds each live
`[address]:port`, and tunnels datagrams over the same WSS bridge the TCP relay
uses. A new tenant's `udp:N` appears within one poll — no relay config change.

### Setup

1. **Enclave**: set `UDP_ADDR_PREFIX` on the supervisor to this box's routed /64
   (e.g. `2a01:4f9:c013:bdfd::/64`). Unset = UDP addressing off.
2. **Box, AnyIP** (once): make the whole /64 bind-able without configuring 2^64
   addresses. The systemd unit does this in `ExecStartPre`; manually it's
   `ip -6 route add local 2a01:4f9:c013:bdfd::/64 dev lo`.
3. **Relay**:

```bash
UDP_PREFIX=2a01:4f9:c013:bdfd::/64 \
REGISTRY_ADDRESS=0x... node udp-relay.js     # on-chain fleet discovery, or:
ENCLAVES=https://enclave1...,https://enclave2... node udp-relay.js
```

Clients then reach a deployment at its advertised `[2a01:4f9:c013:bdfd:…]:N`
(shown in the deploy response's `network.udp`). Public deployments only in v1.

### Caveats (read these)

- **IPv6 only.** A box has one IPv4; there aren't enough v4 addresses to give
  each app its own. v4-only clients can't reach a v6 endpoint. For stock v4
  UDP clients, the fallback is an exclusive-port claim on the single v4 (not
  built yet — ask when a tenant needs it).
- **The relay sees plaintext.** Unlike the TCP path (TLS terminates
  in-enclave), a stock UDP client sends cleartext, so this relay can read/drop
  datagrams — it holds no keys and no state beyond live flows, but it is *not*
  a confidentiality boundary. Apps needing privacy must encrypt themselves
  (e.g. DTLS). Consider marking UDP apps ⚠ in the catalog.
- **TCP under the hood** means loss becomes head-of-line *delay*, not drop.
  Fine for request/response (DNS-style); realtime/loss-tolerant protocols feel
  it. Datagram boundaries are preserved (1 WS message = 1 datagram).
- Config: `REGISTRY_ADDRESS` or `ENCLAVES` (required; `ENCLAVE_URL` = legacy
  one-entry alias), `UDP_POLL_SEC` (5), `UDP_IDLE_MS` (120000),
  `UDP_MAX_FLOWS` (4096). `UDP_PREFIX` is only read by the systemd unit's
  AnyIP step, not the daemon.

## Dedicated-IP TCP relay

Serves each deployment's declared `tcp:N` ports on its **own IPv6**, at the
real (logical) port — `[2a01:4f9:c013:9b52:…]:5432`, `[…]:443` — routed purely
by destination address. No SNI, no TLS requirement: **any** TCP protocol works
(databases, game servers, plaintext, or the app's own TLS), and the port is
the one the app declared (no remapping). This is the "give me an IP and a
port" model.

```
client ──TCP──> [<per-deployment IPv6>]:N ──WSS──> enclave
                                             /x/<id>/tcp/N ──TCP──> app
```

Same addressing as the UDP relay: the supervisor derives each deployment's
IPv6 from its id and publishes `/v1/net-map` (`{id, address, tcp[], udp[]}`);
this relay polls it, binds each live `[address]:tcpPort`, and splices raw bytes
to the enclave's `/x/<id>/tcp/N` bridge. A new tenant's `tcp:N` appears within
one poll — no relay config change.

### Setup

1. **Enclave**: set `DEP_ADDR_PREFIX` (or the legacy `UDP_ADDR_PREFIX`) on the
   supervisor to this box's routed /64. Unset = dedicated addressing off.
2. **Box, AnyIP** (once): `ip -6 route add local <prefix>/64 dev lo` — the
   systemd unit does this in `ExecStartPre` (shared with the udp-relay; same
   /64, whichever starts first wins and the other no-ops).
3. **Relay**:

```bash
REGISTRY_ADDRESS=0x... node tcp6-relay.js    # on-chain fleet discovery, or:
ENCLAVES=https://enclave1...,https://enclave2... node tcp6-relay.js
```

Clients reach a deployment at its advertised `[<prefix>:…]:N` (shown in the
deploy response's `network.tcp` / `network.address`). Public deployments only.

### Caveats

- **IPv6 only** (same reason as UDP — one v4 per box). v4-only clients can't
  reach it; the SNI `relay.js` (below) is the v4-reachable path.
- **The relay sees whatever the app sends.** Raw passthrough: if the app
  speaks TLS the relay sees ciphertext; a plaintext app is visible to it (it
  can drop, not forge — no keys, no state). For platform-terminated TLS on the
  attested cert instead, use the SNI relay.
- **Privileged logical ports** (`tcp:80`, `tcp:443`) need
  `CAP_NET_BIND_SERVICE` — the systemd unit grants it.
- Config: `REGISTRY_ADDRESS` or `ENCLAVES` (required; `ENCLAVE_URL` = legacy
  one-entry alias), `NET_POLL_SEC` (5), `TCP6_MAX_CONNS` (4096),
  `TCP6_HANDSHAKE_MS` (10000). `TCP6_PREFIX` is only read by the systemd
  unit's AnyIP step, not the daemon.

## Egress relay (dedicated-IP outbound) — `egress-relay.js`

The outbound half of the dedicated address: a deployment's app **connects out
from its own IPv6**, so it has one stable identity in both directions (what a
VM with a public IP gives you). The inbound relays above bind the address for
listening; this one source-binds it for dialing.

```
guest ──SOCKS5(ENCLAVE_EGRESS)──> supervisor ──OPEN{cid,dst,source}──> egress-relay
egress-relay ──connect(localAddress = <deployment IPv6>)──> destination
egress-relay ──data WS /x/egress/<cid>──> supervisor ──> guest's SOCKS tunnel
```

The enclave (see `egress.js`) is the SOCKS front; this daemon holds ONE
relay-initiated control WS to the enclave (so the shim stays the only ingress),
dials each requested destination with the deployment's address as the source,
and splices raw bytes back over a per-connection data WS. It never chooses the
source — the enclave derives it from the authenticated deployment — so a
tenant can only ever egress as its own address.

### How apps use it

Guests opt in by honouring **`ENCLAVE_EGRESS`** (injected into the tenant env when
egress is enabled): a `socks5h://<id>:<token>@127.0.0.1:<port>` URL. Point an
HTTP client's proxy or a SOCKS-aware dialer at it and outbound traffic leaves
from the deployment's IPv6. `socks5h` = the relay resolves DNS (remote side),
so names resolve and are SSRF-checked where the dial happens.

### Setup

1. **Enclave**: set `DEP_ADDR_PREFIX` (as for the inbound relays) **and**
   `EGRESS_RELAY_TOKEN` (a shared secret proving the control/data channels are
   the real relay). Optional `EGRESS_SOCKS_PORT` (default 1080).
2. **Box, AnyIP**: the same `ip -6 route add local <prefix>/64 dev lo` +
   `ip_nonlocal_bind=1` the inbound relays use — the systemd unit shares it. No
   `CAP_NET_BIND_SERVICE` here: source-binding for `connect()` needs neither a
   privileged port nor a configured address, only `ip_nonlocal_bind`.
3. **Relay** — `/etc/nan-relay/egress-relay.env`:

```bash
REGISTRY_ADDRESS=0x...              # on-chain fleet discovery (or ENCLAVES=...)
EGRESS_RELAY_TOKEN=<same on every enclave>
EGRESS_PREFIX=<same /64>            # systemd AnyIP step only
# EGRESS_ALLOW_V4=1                 # optional; see caveats
node egress-relay.js
```

`deploy.sh` ships the unit but only `enable --now`s it once this env file
exists.

### Caveats

- **Dedicated source is IPv6-only.** Only a v6 destination can carry the
  deployment's v6 source. v4 destinations are refused unless `EGRESS_ALLOW_V4=1`,
  and even then they leave from the box's **shared** v4 (no per-deployment
  identity) — documented, off by default.
- **Transparent (phase 2).** The platform's wasmtime carries an `-S egress`
  shim (`wasm/wasmtime-egress.patch`) that routes a guest's raw `wasi:sockets`
  connects *and* its `wasi:http` outgoing requests through this same front —
  automatically, for unmodified apps — and the wasm-manager drops the ambient
  `-Sinherit-network` when egress is on, so the guest has no raw network to
  bypass with. The per-deployment SOCKS credential is delivered host-side
  (`ENCLAVE_EGRESS_CRED`, guest-invisible), reusing all three guardrails below;
  `ENCLAVE_EGRESS` stays exported for apps that still want to steer outbound
  explicitly. On a toolchain without the shim this degrades to phase-1
  (proxy-aware) behavior. UDP egress is not mediated yet, so raw outbound UDP is
  denied under the lockdown (inbound `udp:N` still works). Guaranteed in every
  mode: **no deployment can egress as another's address.**
- **The relay sees whatever the app sends** — same passthrough trust as the
  inbound relays. TLS out → the relay sees ciphertext; plaintext → visible to
  it (drop, not forge). Apps wanting confidentiality against the relay speak
  their own TLS.
- **SSRF (guardrail):** destinations in loopback/link-local/ULA/private/
  multicast ranges are refused — once in the enclave for literal IPs, and again
  here after DNS resolution (`net-guard.mjs`, shared with the enclave). This
  protects both the enclave's and this box's own localhost/private services.
- Config: `REGISTRY_ADDRESS` or `ENCLAVES` (required; `ENCLAVE_URL` = legacy
  one-entry alias), `EGRESS_RELAY_TOKEN` (required, same on every enclave),
  `EGRESS_ALLOW_V4` (off), `EGRESS_MAX_CONNS` (4096), `EGRESS_DIAL_MS` (10000).
  `EGRESS_PREFIX` is the systemd AnyIP step only, not the daemon.

## TCP relay (SNI, shared-port)

Gives service apps (declared `tcp:N` firewall ports) a **normal public TCP
endpoint** — `irssi -c dep_abc123.tcp.enclave.host -p 6667 --tls`, `psql
"host=dep_xyz.tcp.enclave.host sslmode=require"` — with the enclave's guarantees
fully intact. No per-user websocat, no app-side TLS code. Multiplexes every
deployment onto shared public ports, demuxed by the TLS SNI, and terminates
TLS in-enclave on the platform cert. The dedicated-IP relay above is the newer,
protocol-agnostic path; this one is the v4-reachable, TLS-terminated fallback.

## How it stays trustless

The enclave's only ingress is the Tinfoil shim (HTTPS/443), so *some* box must
own the raw public port. This daemon does — but the client's TLS session
**terminates inside the attested enclave**, not here. The supervisor **mints
the platform key + cert in-enclave at boot** (self-signed for
`*.<TLS_BRIDGE_DOMAIN>`; the private key never exists outside the CVM — no
ACME account, no secret store, no operator copy) and unwraps the session at
`/x/:id/tls/:port`; the relay just peeks the **SNI** hostname from the
ClientHello (plaintext by design, never decrypted) to pick a route, then
splices ciphertext:

```
client ──TLS──> relay:6667 ──wss──> shim ──> supervisor(/x/:id/tls/:port) ──plain──> app
         └────────── key exists only inside the enclave ──────────┘        loopback
```

Compromise the relay and you get ciphertext plus connection metadata — the
same power as any router between the user and the enclave. It holds no
secrets, keeps no state, and needs no trust: run it on the cheapest VPS you
can find, run several behind round-robin DNS, or let anyone run their own
against your enclaves.

## Setup

1. **Domain** (once, platform-wide): set the supervisor's `TLS_BRIDGE_DOMAIN`
   env to the SNI suffix (e.g. `tcp.enclave.host`, plain config in
   `tinfoil-config.yml`). At boot the enclave mints its own key + self-signed
   cert for `*.tcp.enclave.host` — no ACME, no secrets, no renewals; the key never
   exists outside the CVM, let alone on the relay box.
2. **DNS**: `*.tcp.enclave.host  A  <relay ip>` (repeat per relay for round-robin).
3. **Relay**:

```bash
cd relay && npm install
RELAY_DOMAIN=tcp.enclave.host \
ENCLAVE_URL=https://enclave1.nan.containers.tinfoil.dev \
RELAY_PORTS=6667,5432 \
node relay.js
```

Clients then reach a deployment at `<deploymentId>.tcp.enclave.host:<port>` with
plain TLS. The deployment must be `public: true` (the bridge enforces the same
auth as `/x/:id/tcp/:port`; a relay has no owner token, so private deployments
stay unreachable through it — by design).

## Verifying the endpoint is the enclave (optional)

The bridge cert is self-signed — CA validation was never the trust anchor
here (a CA cert would only prove you reached *someone* holding a
`*.tcp.enclave.host` cert, not that the key lives inside an attested enclave —
and its key would have to exist outside the enclave to be issued at all).
Instead the supervisor publishes the cert **over the attested origin** at
`GET /v1/tls-bridge` (`fingerprint256`, `spkiPinSha256`, the PEM). A
verifying client:

1. Verifies the enclave itself (`/v1/attestation` — TDX quote + H200 CC
   evidence, checked against the Sigstore-signed release measurements).
2. Reads the expected cert fingerprint from that same attested origin.
3. Pins it on the TCP connection:

```bash
curl -s https://<enclave>/v1/tls-bridge | jq -r .fingerprint256
openssl s_client -connect dep-abc123.tcp.enclave.host:6667 \
  -servername dep-abc123.tcp.enclave.host </dev/null 2>/dev/null \
  | openssl x509 -noout -fingerprint -sha256      # must match
```

With the pin, a MITM relay fails outright — the private key it would need
never left the CVM — so the session is transitively bound to the measured
enclave. Strict clients can also use the published PEM as their sole trust
root (`psql sslmode=verify-full sslrootcert=bridge.pem`; the SAN covers
`*.tcp.enclave.host`). Casual clients that don't validate certs (`sslmode=require`,
`irssi --tls`) connect unchanged, with the same what-any-router-sees exposure
they always had.

## Config

| env | | |
|---|---|---|
| `RELAY_DOMAIN` | required | SNI suffix; connections whose SNI isn't `<id>.<domain>` are dropped |
| `ENCLAVE_URL` | required | enclave origin; `https://` becomes `wss://` |
| `RELAY_PORTS` | required | comma list of `public[:logical]`, e.g. `6667` or `6697:6667` (public 6697 → the app's declared `tcp:6667`) |
| `RELAY_MAX_CONNS` | 1024 | concurrent client connection cap |
| `RELAY_HELLO_TIMEOUT_MS` | 10000 | drop clients that never finish a ClientHello |

The `public:logical` form exists for protocol conventions (IRC clients expect
TLS on 6697 while the app declares `tcp:6667`) and for colocated testing.

## Notes

- **Hostnames spell the deployment id with a hyphen**: deployment `dep_abc123`
  is reached at `dep-abc123.tcp.enclave.host`. Underscores aren't valid hostname
  label characters, and OpenSSL refuses to wildcard-match them — strict
  clients (psql, python) would reject the cert. The relay maps a leading
  `dep-` back to the canonical `dep_` id.
- Non-TLS protocols can't ride this relay (no SNI to route on) — that's what
  keeps it trustless. Plaintext protocols keep using the owner-side bridge.
- Each client connection costs one WSS connection through the shim; size
  `RELAY_MAX_CONNS` with the supervisor in mind.
- Ready-to-install systemd units for all daemons are in
  [`systemd/`](systemd/) — they read config from
  `/etc/nan-relay/{tcp-relay,tcp6-relay,udp-relay,api-relay}.env` and expect
  the code at `/opt/nan-relay`. The `tcp6-relay.env` and `udp-relay.env` carry
  `ENCLAVE_URL` plus the `TCP6_PREFIX` / `UDP_PREFIX` for the AnyIP route (same
  /64); `deploy.sh` never touches the env files (host state).
