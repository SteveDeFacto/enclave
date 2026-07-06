#!/bin/sh
# enclave CLI installer (Linux/macOS) — the target of
# `curl -fsSL https://get.enclave.host | sh`. Until that host serves a prebuilt
# bundle, this script installs from a checkout: it bundles cli/enclave.mjs
# (deps inlined, ~1 MB) into a single executable file and drops it on your
# PATH. Needs node >= 20; nothing else touches your machine.
# Windows: use cli/install.ps1 (or `npm install -g ./cli`, which works anywhere).
#
#   ./cli/install.sh              -> ~/.local/bin/enclave
#   PREFIX=/usr/local ./cli/install.sh
set -eu

need() { command -v "$1" >/dev/null 2>&1 || { echo "error: $1 is required" >&2; exit 1; }; }
need node
node -e 'process.exit(parseInt(process.versions.node) >= 20 ? 0 : 1)' \
  || { echo "error: node >= 20 required (found $(node -v))" >&2; exit 1; }

CLI_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN_DIR="${PREFIX:-$HOME/.local}/bin"
OUT="$BIN_DIR/enclave"

# bundle deps: the repo root has them; a bare checkout of cli/ installs its own
if [ ! -d "$CLI_DIR/../node_modules/viem" ] && [ ! -d "$CLI_DIR/node_modules/viem" ]; then
  need npm
  echo "installing bundle dependencies (viem, @tinfoilsh/verifier, esbuild)…"
  npm --prefix "$CLI_DIR" install --no-fund --no-audit
fi

mkdir -p "$BIN_DIR"
node "$CLI_DIR/build.mjs" "$OUT"

echo "installed $OUT"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) echo "note: $BIN_DIR is not on your PATH" ;; esac
"$OUT" version >/dev/null && echo "try: enclave help"
