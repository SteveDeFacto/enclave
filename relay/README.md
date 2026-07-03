# NAN public relays

Two small, **untrusted**, stateless daemons that live outside the enclave —
on any box with a public IP — and give the fleet a friendly front door
without ever entering the trust boundary:

- [`relay.js`](relay.js) — **TCP relay**: normal public TCP endpoints for
  service apps (SNI-routed, TLS terminates in-enclave). Details below.
- [`api-relay.js`](api-relay.js) — **API relay**: fleet discovery + placement.
  Reads NanRegistry on Base for live enclaves, polls their `/availability`,
  and steers new work to the most available one.

## API relay

```bash
cd relay && npm install
REGISTRY_ADDRESS=0x... node api-relay.js         # on-chain discovery, or:
ENCLAVES=https://enclave1...,https://enclave2... node api-relay.js
```

| route | |
|---|---|
| `GET /enclaves` | live fleet table + aggregate free capacity |
| `GET /route?share=0.05` | best enclave that fits: `{ endpoint, repo, availability }` |
| `ANY /v1/*`, `/availability` | `307` redirect to the current best enclave |
| `GET /health` | poller freshness |

Trust model: same as the TCP relay — it routes, it never terminates. Answers
are JSON or a `307`, so the client always lands on the enclave's **own
attested origin** and verifies attestation there (Tinfoil SecureClient with
the registry's `repo`). A malicious API relay can hand you a suboptimal
placement, never a fake enclave. It mirrors `scripts/nan-discover.mjs` —
run that locally if you'd rather not trust anyone's relay at all.

Notes:
- Placement steers **new deployments only**. A deployment lives on one
  enclave; after creating it, talk to that enclave directly (the `307`'s
  `Location` / `/route`'s `endpoint` tells you which). The relay deliberately
  does not forward `/x/*` for this reason.
- `fetch()`/undici strip `Authorization` on cross-origin redirects — authed
  callers should `GET /route` and hit the enclave directly; the `307` path
  suits curl (`-L`) and unauthenticated calls.
- Config: `REGISTRY_ADDRESS` or `ENCLAVES` (required), `BASE_RPC`,
  `API_RELAY_PORT` (8100), `AVAIL_POLL_SEC` (10), `REGISTRY_POLL_SEC` (300),
  `STALE_AFTER_SEC` (3600).

## TCP relay

Gives service apps (declared `tcp:N` firewall ports) a **normal public TCP
endpoint** — `irssi -c dep_abc123.tcp.nan.host -p 6667 --tls`, `psql
"host=dep_xyz.tcp.nan.host sslmode=require"` — with the enclave's guarantees
fully intact. No per-user websocat, no app-side TLS code.

## How it stays trustless

The enclave's only ingress is the Tinfoil shim (HTTPS/443), so *some* box must
own the raw public port. This daemon does — but the client's TLS session
**terminates inside the attested enclave**, not here. The supervisor holds the
platform cert (`TLS_BRIDGE_CERT`/`TLS_BRIDGE_KEY`, enclave secrets) and unwraps
the session at `/x/:id/tls/:port`; the relay just peeks the **SNI** hostname
from the ClientHello (plaintext by design, never decrypted) to pick a route,
then splices ciphertext:

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

1. **Cert** (once, platform-wide): issue a wildcard cert for `*.tcp.nan.host`
   (DNS-01 ACME). Set the PEM chain and key as the supervisor's
   `TLS_BRIDGE_CERT` / `TLS_BRIDGE_KEY` enclave secrets. The key never touches
   the relay box. Renewals = update the secrets.
2. **DNS**: `*.tcp.nan.host  A  <relay ip>` (repeat per relay for round-robin).
3. **Relay**:

```bash
cd relay && npm install
RELAY_DOMAIN=tcp.nan.host \
ENCLAVE_URL=https://enclave1.nan.containers.tinfoil.dev \
RELAY_PORTS=6667,5432 \
node relay.js
```

Clients then reach a deployment at `<deploymentId>.tcp.nan.host:<port>` with
plain TLS. The deployment must be `public: true` (the bridge enforces the same
auth as `/x/:id/tcp/:port`; a relay has no owner token, so private deployments
stay unreachable through it — by design).

## Verifying the endpoint is the enclave (optional)

CA validation alone proves you reached *someone* holding a `*.tcp.nan.host`
cert — it can't prove that key lives inside an attested enclave. The
supervisor closes that gap by publishing the bridge cert **over the attested
origin** at `GET /v1/tls-bridge` (`fingerprint256`, `spkiPinSha256`, the PEM).
A verifying client:

1. Verifies the enclave itself (`/v1/attestation` — TDX quote + H200 CC
   evidence, checked against the Sigstore-signed release measurements).
2. Reads the expected cert fingerprint from that same attested origin.
3. Pins it on the TCP connection:

```bash
curl -s https://<enclave>/v1/tls-bridge | jq -r .fingerprint256
openssl s_client -connect dep-abc123.tcp.nan.host:6667 \
  -servername dep-abc123.tcp.nan.host </dev/null 2>/dev/null \
  | openssl x509 -noout -fingerprint -sha256      # must match
```

With the pin, a MITM relay or a mis-issued certificate fails even though it
would pass CA validation — the session is transitively bound to the measured
enclave. Casual clients can skip all of this and rely on plain CA trust.

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
  is reached at `dep-abc123.tcp.nan.host`. Underscores aren't valid hostname
  label characters, and OpenSSL refuses to wildcard-match them — strict
  clients (psql, python) would reject the cert. The relay maps a leading
  `dep-` back to the canonical `dep_` id.
- Non-TLS protocols can't ride this relay (no SNI to route on) — that's what
  keeps it trustless. Plaintext protocols keep using the owner-side bridge.
- Each client connection costs one WSS connection through the shim; size
  `RELAY_MAX_CONNS` with the supervisor in mind.
- Ready-to-install systemd units for both daemons are in
  [`systemd/`](systemd/) — they read config from
  `/etc/nan-relay/{tcp-relay,api-relay}.env` and expect the code at
  `/opt/nan-relay`.
