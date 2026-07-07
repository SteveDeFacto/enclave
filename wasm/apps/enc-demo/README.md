# enc-demo — the encrypted-volumes example app

Deploy this with a wallet-gated `encVolumes` config and it serves whatever the
platform decrypted at `/enc/<name>` — a browsable proof that the guest sees
plaintext while the operator's host only ever saw ciphertext.

The point for app authors: **your code needs no crypto**. The deployment holds
at `awaiting_unlock` until an authorized wallet delivers the sealed volume key
(vault app or `enclave-vault-client unlock`); after that, `/enc/<name>` is an
ordinary read-only directory (`ENCLAVE_ENC` lists the names) and plain `std::fs`
works — identically for the small tier (NANVOL1, decrypted to enclave RAM) and
the large tier (NANVOL2, blocks decrypted on demand under the wasmtime
vault-fs shim).

## Routes

| route                | what                                          |
|----------------------|-----------------------------------------------|
| `GET /`              | volume browser                                |
| `GET /ls`            | JSON listing of every `ENCLAVE_ENC` volume        |
| `GET /f/<vol>/<path>`| raw file bytes (streamed; any size)           |
| `GET /ping`          | liveness                                      |

## Try it locally

```sh
cargo component build --release --target wasm32-wasip2
wasmtime serve --addr 127.0.0.1:8080 -Scli -Shttp \
  --dir ./some-plaintext-dir::/enc/demo --env ENCLAVE_ENC=demo \
  target/wasm32-wasip*/release/enc_demo.wasm
```

## Deploy it for real

```sh
# 1. encrypt a directory (prints the VEK + the plaintext hash to pin)
node scripts/enclave-vault.mjs pack ./secret-dir ./secret.enc

# 2. host secret.enc anywhere public (IPFS, a release asset, any URL)

# 3. pin a config and deploy with its CID as configCid:
#    {"encVolumes":[{"name":"demo","source":"https://…/secret.enc",
#      "sha256":"<printed plaintext hash>",
#      "vault":{"owner":"0x<you>","volume":"demo","autoGrant":true}}]}

# 4. on-chain ACL + unlock (or use the vault app UI):
node scripts/enclave-vault-client.mjs setup  --volume demo --vek 0x<printed VEK>
node scripts/enclave-vault-client.mjs unlock --id 0x<deployment> --owner 0x<you> --name demo
```
