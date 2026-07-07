# wasm/apps — boot-probe fixtures only

Deployable app sources live in their own repos (~/Projects/enclave-apps/…)
and reach users via the on-chain catalog; the enclave image ships NO
deployable apps (store-only policy).

`nn-demo.wasm` is the ONE exception and it is NOT an app shipment: the
wasm-manager's readiness probe serves it through the real wasmtime + ORT
stack at boot (Dockerfile.wasm copies it to /opt/enclave/apps/). Deleting
it breaks the image build outright — and without it the probe would
silently skip its ORT e2e stage.
