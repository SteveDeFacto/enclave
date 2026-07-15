#!/bin/sh
# enclave CLI installer (Linux/macOS). Two ways in, same artifact out:
#
#   curl -fsSL https://get.enclave.host | sh          # hosted one-liner (also: enclave.host/install.sh)
#   ./cli/install.sh                                   # from a checkout
#   PREFIX=/usr/local ./cli/install.sh
#
# Either way it bundles cli/enclave.mjs (deps inlined, ~1 MB, exact versions
# from the checked-in package-lock.json) into a single executable and drops it
# on your PATH. This is a KEY-HOLDING signing binary, so the hosted mode does
# NOT build the moving branch tip: it downloads a PINNED release tarball plus its
# SHA256SUMS and REFUSES to build unless the checksum matches. Pin an exact tag
# with ENCLAVE_CLI_VERSION=cli-vX.Y.Z; unset resolves the latest cli-* release.
# ENCLAVE_CLI_CHANNEL=edge is an explicit, UNVERIFIED escape hatch that builds the
# current main tip (dev only). No prebuilt binary is ever downloaded.
#
# Needs node >= 20 and npm; hosted mode also needs tar and curl or wget.
# Windows: irm https://get.enclave.host/install.ps1 | iex  (or npm install -g ./cli)
set -eu

need() { command -v "$1" >/dev/null 2>&1 || { echo "error: $1 is required" >&2; exit 1; }; }

fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1"
  elif command -v wget >/dev/null 2>&1; then wget -qO- "$1"
  else echo "error: curl or wget is required" >&2; exit 1
  fi
}

# fetch to a file, failing the script (set -e) on any HTTP/transport error.
fetch_to() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then wget -qO "$2" "$1"
  else echo "error: curl or wget is required" >&2; exit 1
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else echo "error: sha256sum or shasum is required to verify the download" >&2; exit 1
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
    GH="https://github.com/EnclaveHost/enclave"
    API="https://api.github.com/repos/EnclaveHost/enclave"
    TMP="$(mktemp -d "${TMPDIR:-/tmp}/enclave-install.XXXXXX")"
    trap 'rm -rf "$TMP"' EXIT INT TERM

    if [ "${ENCLAVE_CLI_CHANNEL:-}" = "edge" ]; then
      # explicit, UNVERIFIED dev path: build the current main tip, no checksum.
      echo "WARNING: ENCLAVE_CLI_CHANNEL=edge builds the UNVERIFIED main tip (no checksum). Dev use only." >&2
      fetch "$GH/archive/refs/heads/main.tar.gz" | tar -xzf - -C "$TMP"
    else
      # pinned + checksum-verified release. ENCLAVE_CLI_VERSION pins an exact tag;
      # unset resolves the latest cli-* release.
      ver="${ENCLAVE_CLI_VERSION:-}"
      if [ -z "$ver" ]; then
        ver="$(fetch "$API/releases" 2>/dev/null \
          | grep '"tag_name"' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/' \
          | grep '^cli-' | head -1 || true)"
        [ -n "$ver" ] || { echo "error: no cli-* release found (and ENCLAVE_CLI_VERSION unset). Set ENCLAVE_CLI_VERSION=cli-vX.Y.Z, or ENCLAVE_CLI_CHANNEL=edge for an unverified dev build." >&2; exit 1; }
      fi
      base="$GH/releases/download/$ver"
      tarname="enclave-cli-$ver.tar.gz"
      echo "fetching $ver (checksum-verified)…"
      fetch_to "$base/$tarname"    "$TMP/cli.tar.gz"
      fetch_to "$base/SHA256SUMS"  "$TMP/SHA256SUMS"
      want="$(awk -v f="$tarname" '$2==f || $2=="*"f {print $1}' "$TMP/SHA256SUMS")"
      got="$(sha256_of "$TMP/cli.tar.gz")"
      [ -n "$want" ] && [ "$want" = "$got" ] || { echo "error: checksum mismatch for $ver (want=$want got=$got) — refusing to build" >&2; exit 1; }
      tar -xzf "$TMP/cli.tar.gz" -C "$TMP"
    fi

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
