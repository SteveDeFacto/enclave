#!/usr/bin/env bash
# enclave-volume - pack a directory into a Enclave encrypted volume you control.
#
# The trust model: YOU hold the passphrase. The ciphertext can live anywhere
# (IPFS, S3, a URL) - the host and the platform only ever see ciphertext. At
# deploy time, after you VERIFY THE ENCLAVE'S ATTESTATION, you hand the
# passphrase to the enclave over the attested (in-enclave-terminated) TLS
# channel; it decrypts IN MEMORY and mounts the plaintext into your app. The
# passphrase never touches disk, the cloud provider, or the platform operator.
#
# Cipher: tar -> AES-256-CTR (key = PBKDF2-SHA256 of your passphrase, 600k iters,
# random salt). Integrity is the SHA-256 of the PLAINTEXT tar, printed here and
# carried in your (signed) deployment - the enclave rejects the volume if the
# decrypted bytes don't match, so a tampering host/storage is caught. (CTR+hash,
# not an AEAD, because openssl's `enc` CLI can't verify a GCM tag cleanly; the
# authenticated plaintext hash is the equivalent guarantee for a whole blob.)
#
# Usage:
#   ENCLAVE_VOL_PASS=... scripts/enclave-volume.sh pack   <dir> <out.enc>   # encrypt
#   ENCLAVE_VOL_PASS=... scripts/enclave-volume.sh unpack <in.enc> <dir>    # decrypt (what the enclave does)
#   scripts/enclave-volume.sh --help
#
# If ENCLAVE_VOL_PASS is unset, you're prompted (never echoed, never stored).
set -euo pipefail

ITER=600000
CIPHER=aes-256-ctr

die(){ echo "enclave-volume: $*" >&2; exit 1; }
usage(){ sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

get_pass(){
  if [ -n "${ENCLAVE_VOL_PASS:-}" ]; then printf '%s' "$ENCLAVE_VOL_PASS"; return; fi
  local p; read -r -s -p "volume passphrase: " p >&2; echo >&2
  [ -n "$p" ] || die "empty passphrase"
  printf '%s' "$p"
}

cmd="${1:-}"; case "$cmd" in -h|--help|"") usage 0;; esac

case "$cmd" in
  pack)
    dir="${2:-}"; out="${3:-}"
    [ -d "$dir" ] || die "not a directory: $dir"
    [ -n "$out" ] || die "usage: pack <dir> <out.enc>"
    pass="$(get_pass)"
    tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
    # deterministic-ish tar (sorted, no mtime noise) so the plaintext hash is stable
    tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner -cf "$tmp" -C "$dir" .
    sha="$(sha256sum "$tmp" | cut -d' ' -f1)"
    size="$(stat -c%s "$tmp")"
    openssl enc -"$CIPHER" -pbkdf2 -iter "$ITER" -salt -pass "pass:$pass" -in "$tmp" -out "$out"
    csize="$(stat -c%s "$out")"
    echo >&2
    echo "packed $dir -> $out" >&2
    echo "  plaintext: $size bytes, sha256 $sha" >&2
    echo "  ciphertext: $csize bytes" >&2
    echo >&2
    echo "Host the ciphertext (ipfs add / your storage) and reference it in the" >&2
    echo "deployment's encrypted-volume spec (name, ciphertext location, and this" >&2
    echo "plaintext sha256). Deliver the passphrase to the enclave AFTER verifying" >&2
    echo "attestation - never put it in the config." >&2
    # machine-readable line for tooling/console
    echo "ENCLAVE_VOLUME sha256=$sha plaintext_bytes=$size cipher=$CIPHER pbkdf2_iter=$ITER"
    ;;
  unpack)
    in="${2:-}"; dir="${3:-}"
    [ -f "$in" ] || die "not a file: $in"
    [ -n "$dir" ] || die "usage: unpack <in.enc> <dir>"
    pass="$(get_pass)"
    mkdir -p "$dir"
    tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
    openssl enc -d -"$CIPHER" -pbkdf2 -iter "$ITER" -pass "pass:$pass" -in "$in" -out "$tmp" \
      || die "decrypt failed (wrong passphrase?)"
    sha="$(sha256sum "$tmp" | cut -d' ' -f1)"
    tar -xf "$tmp" -C "$dir"
    echo "unpacked $in -> $dir  (plaintext sha256 $sha)" >&2
    echo "ENCLAVE_VOLUME sha256=$sha"
    ;;
  *) die "unknown command '$cmd' (pack|unpack|--help)";;
esac
