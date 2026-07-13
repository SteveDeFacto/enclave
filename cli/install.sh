#!/bin/sh
# enclave CLI installer (Linux/macOS). Two ways in, same artifact out:
#
#   curl -fsSL https://enclave.host/install.sh | sh    # hosted one-liner (also: get.enclave.host)
#   ./cli/install.sh                                   # from a checkout
#   PREFIX=/usr/local ./cli/install.sh
#
# Either way it bundles cli/enclave.mjs (deps inlined, ~1 MB, exact versions
# from the checked-in package-lock.json) into a single executable and drops it
# on your PATH. The hosted mode downloads the source tarball of
# EnclaveHost/enclave@main from GitHub over TLS and builds it locally - no
# prebuilt binary is ever downloaded, so what you run is what's in the repo.
# (If a prebuilt-bundle path is ever added, pin its sha256/signature here
# BEFORE shipping it: this is a key-holding signing binary.)
#
# Needs node >= 20 and npm; hosted mode also needs tar and curl or wget.
# Windows: irm https://enclave.host/install.ps1 | iex  (or npm install -g ./cli)
set -eu

need() { command -v "$1" >/dev/null 2>&1 || { echo "error: $1 is required" >&2; exit 1; }; }

fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1"
  elif command -v wget >/dev/null 2>&1; then wget -qO- "$1"
  else echo "error: curl or wget is required" >&2; exit 1
  fi
}

main() {
  need node
  node -e 'process.exit(parseInt(process.versions.node) >= 20 ? 0 : 1)' \
    || { echo "error: node >= 20 required (found $(node -v))" >&2; exit 1; }

  # checkout mode: this script sits in cli/ next to enclave.mjs. Piped through
  # `curl | sh` there is no script path, so fetch the repo and build from that.
  CLI_DIR="$(cd "$(dirname -- "$0")" 2>/dev/null && pwd || true)"
  TMP=""
  if [ ! -f "$CLI_DIR/enclave.mjs" ]; then
    need tar; need npm
    TARBALL="https://github.com/EnclaveHost/enclave/archive/refs/heads/main.tar.gz"
    TMP="$(mktemp -d "${TMPDIR:-/tmp}/enclave-install.XXXXXX")"
    trap 'rm -rf "$TMP"' EXIT INT TERM
    echo "fetching $TARBALL"
    fetch "$TARBALL" | tar -xzf - -C "$TMP"
    set -- "$TMP"/*/cli
    CLI_DIR="$1"
    [ -f "$CLI_DIR/enclave.mjs" ] || { echo "error: download did not contain cli/enclave.mjs" >&2; exit 1; }
  fi

  BIN_DIR="${PREFIX:-$HOME/.local}/bin"
  OUT="$BIN_DIR/enclave"

  # bundle deps: the repo root has them; a bare checkout of cli/ installs its own
  if [ ! -d "$CLI_DIR/../node_modules/viem" ] && [ ! -d "$CLI_DIR/node_modules/viem" ]; then
    need npm
    echo "installing bundle dependencies (viem, @tinfoilsh/verifier, esbuild)…"
    # Prefer `npm ci` — it installs the EXACT versions from the checked-in
    # package-lock.json (this is a key-holding signing binary; floating caret
    # ranges have no place in it). Fall back to `npm install` only if the lockfile
    # is missing (e.g. an old checkout).
    if [ -f "$CLI_DIR/package-lock.json" ]; then
      npm --prefix "$CLI_DIR" ci --no-fund --no-audit
    else
      echo "note: no package-lock.json found — falling back to 'npm install' (unpinned)" >&2
      npm --prefix "$CLI_DIR" install --no-fund --no-audit
    fi
  fi

  mkdir -p "$BIN_DIR"
  node "$CLI_DIR/build.mjs" "$OUT"

  echo "installed $OUT"
  case ":$PATH:" in *":$BIN_DIR:"*) ;; *) echo "note: $BIN_DIR is not on your PATH" ;; esac
  "$OUT" version >/dev/null && echo "try: enclave help"
}

# the function wrapper forces sh to read the whole script before running any of
# it - piped installs would otherwise race commands below against the download
# (a command that reads stdin would eat the rest of the script).
main "$@" </dev/null
