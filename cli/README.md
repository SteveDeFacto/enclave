# The `enclave` CLI

One file, wallet-native; your wallet is your account. Every command maps 1:1 onto the
[public API](https://enclave.host/#api) and the on-chain contracts on Base;
full reference in the site's [Develop → CLI](https://enclave.host/#cli) chapter,
or `enclave help`.

```
enclave key new                      # bring a wallet; fund it with USDC on Base
enclave publish app.wasm --slug hello-world
enclave deploy hello-world:1 --fund 2  # create + fund $2 + wait for live; prints the URL
enclave attest 0x3xk9…               # verify the enclave locally BEFORE sending data
enclave logs 0x3xk9… -f
```

## Install

Needs node ≥ 20 on every platform.

```sh
./cli/install.sh           # Linux/macOS: one ~1 MB file -> ~/.local/bin/enclave
```

```powershell
.\cli\install.ps1          # Windows: %LOCALAPPDATA%\enclave\bin + `enclave` shim (+ user PATH)
```

```sh
cd cli && npm install && npm install -g .   # any OS: npm makes the platform shims itself
```

(npm symlinks a local-directory global install, so the deps have to exist in
`cli/node_modules`, hence the `npm install` first.)

Dependencies are pinned in `cli/package-lock.json`; the installers use `npm ci`
(exact locked versions) rather than resolving the caret ranges fresh: this is a
key-holding binary, so its supply chain is locked, not floated.

or run it straight from a checkout (`node cli/enclave.mjs …`; deps resolve
from the repo's `node_modules`). Both installers share `cli/build.mjs` for the
esbuild bundling step.

On Windows the key file lands in `%USERPROFILE%\.config\enclave\key` (override
with `XDG_CONFIG_HOME`); note the 0600 tightening is a POSIX permission; on
NTFS the file is only as private as your user profile.

## How it holds your trust

- **Key** (`~/.config/enclave/key`, 0600, or `ENCLAVE_KEY`): never leaves the
  machine. API auth signs a one-time SIWE challenge; create/fund/publish sign
  Base transactions locally and broadcast to `--rpc`.
- **Payment**: `fundWithAuthorization` is an EIP-3009 `ReceiveWithAuthorization`
  signature over USDC, its nonce bound to the deployment id's first 16 bytes, so
  the money can land on that deployment's balance and nowhere else.
- **Attestation**: `enclave attest` runs Tinfoil's verifier *locally* (hardware
  quote → vendor root, Sigstore code provenance, measurement match, TLS
  binding) and exits non-zero on FAIL.
- **No hidden traffic**: any command run with `-x` prints every REST call and
  transaction before it is sent, ready to replay with `curl`.

Contract addresses are pinned in `enclave.mjs` (`DEFAULTS`) and kept in
lockstep with the enclave configs by `scripts/sync-contract-addresses.sh`.

Tests: `node --test test/cli.test.mjs` from the repo root: an offline double
of the platform (stub API with real SIWE verification + stub Base RPC that
decodes the CLI's actually-signed transactions).
