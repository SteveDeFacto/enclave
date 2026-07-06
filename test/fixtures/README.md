# Egress test fixtures (phase-2 transparent egress)

Two tiny `wasm32-wasip2` guest components the phase-2 e2e tests in
[`../egress.test.mjs`](../egress.test.mjs) drive through a REAL patched wasmtime
to prove transparent egress works for **unmodified** apps:

- `egress-guest-tcp.wasm` (`run` mode) — `std::net::TcpStream::connect($TARGET)`,
  i.e. raw `wasi:sockets`. Proves an unmodified socket app's outbound is routed
  through the dedicated-IP tunnel and that the raw path is closed. Source:
  [`egress-guest-tcp.rs`](egress-guest-tcp.rs).
- `egress-guest-http.wasm` (`serve` mode) — a `wasi:http` proxy that fetches
  `http://$TARGET/` on each request. Proves the `wasi:http` outgoing handler is
  intercepted too (socks5h domain path). Source:
  [`egress-guest-http.rs`](egress-guest-http.rs).

These tests **skip** unless a patched wasmtime is provided, so `npm test` stays
green on machines without the toolchain:

```bash
NAN_EGRESS_WASMTIME=/path/to/patched/wasmtime npm test
```

## Regenerating the fixtures

The guests are plain wasip2 components (needs `rustup target add wasm32-wasip2`;
the http one pulls the `wasi` crate). From each source:

```bash
# tcp guest (a [[bin]] crate with egress-guest-tcp.rs as src/main.rs)
cargo build --release --target wasm32-wasip2      # -> egress-guest-tcp.wasm

# http guest (a cdylib crate with egress-guest-http.rs as src/lib.rs,
# dependency: wasi = "0.14")
cargo build --release --target wasm32-wasip2      # -> egress-guest-http.wasm
```

The patched wasmtime is built by [`../../wasm/Dockerfile.wasmtime`](../../wasm/Dockerfile.wasmtime)
(applies `wasm/wasmtime-egress.patch`); for a local binary you can `cargo build
-p wasmtime-cli` in a v45.0.0 checkout with the patch applied. `wasmtime serve`
needs the pooling allocator, so if you built `--no-default-features` pass
`-O pooling-allocator=n` (the test does this automatically).
