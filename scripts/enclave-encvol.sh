#!/usr/bin/env bash
# enclave-encvol: pack + push an encrypted volume for Enclave deployments.
#
# The client half of encrypted volumes (rclone crypt over S3): encrypts a
# local directory with `rclone crypt` and syncs the CIPHERTEXT to any
# S3-compatible bucket. The enclave-side manager later pulls + decrypts it
# into the deployment's /enc/<name> when the owner unlocks from the app UI
# (see enclave-apps/encrypted-volumes). The bucket, the network, and the
# operator's host only ever see ciphertext; the key never leaves this
# machine except over the deployment's attested, in-enclave-terminated TLS
# at unlock time.
#
#   enclave-encvol.sh push <dir>  --endpoint URL --bucket B [--path P]   encrypt + upload <dir>
#   enclave-encvol.sh pull <dir>  --endpoint URL --bucket B [--path P]   download + decrypt into <dir>
#   enclave-encvol.sh ls          --endpoint URL --bucket B [--path P]   list the volume's decrypted names
#   enclave-encvol.sh message <keyId>                                    print the exact message a wallet signs
#   enclave-encvol.sh derive  --sig 0x…                                  print the password/salt a signature derives
#   enclave-encvol.sh seal-creds --sig 0x…                               encrypt AWS_* creds under the wallet key -> a
#                                                                        credsEnvelope value for the (public) App Config
#
# WALLET MODE (the encrypted-volumes app's primary flow): the key is DERIVED
# from a deterministic ECDSA personal_sign of the canonical message (printed
# by `message`), so only the wallet holder can reproduce it - no password to
# keep. Byte-exact derivation, identical here and in the app:
#     sig      = lowercase 65-byte signature hex, 0x-prefixed
#     password = sha256_hex( sig + "\n" + "enclave-encvol-v1:password" )
#     salt     = sha256_hex( sig + "\n" + "enclave-encvol-v1:salt" )
# Sign in the deployed app (its "push credentials" panel shows all of this),
# or anywhere else, e.g.:  cast wallet sign "$(enclave-encvol.sh message myvol)"
# Wallets must sign deterministically (RFC 6979 - MetaMask, Ledger, EOAs
# generally do); if two signatures of the same message differ, use a password.
#
# CREDENTIALS ENVELOPE (seal-creds): S3 credentials can ride the PUBLIC App
# Config encrypted under the same wallet signature, so one signature in the
# app unlocks everything - no S3 fields to type. Byte-exact contract, shared
# with the encrypted-volumes app's JS (pinned by test/encvol-e2e.py):
#     encKey   = SHA-256( sig + "\n" + "enclave-encvol-v1:creds-enc" )   32 raw bytes
#     macKey   = SHA-256( sig + "\n" + "enclave-encvol-v1:creds-mac" )   32 raw bytes
#     iv       = 16 random bytes
#     ct       = AES-256-CTR( encKey, iv, '{"accessKeyId":"…","secretAccessKey":"…"[,"sessionToken":"…"]}' )
#     tag      = HMAC-SHA256( macKey, iv || ct )
#     envelope = "encv1:" + base64( iv || ct || tag )
# The envelope is exactly as sensitive as the volume itself (same wallet
# guards both); it goes in the encVolumes entry as "credsEnvelope". The
# manager ignores it; the app decrypts it in the browser at unlock time.
#
# Options / environment:
#   --endpoint URL      S3 endpoint (https://s3.eu-central-1.amazonaws.com, any S3-compatible)
#   --bucket B          bucket name
#   --path P            key prefix inside the bucket (default: none)
#   --name N            volume name used in the printed App Config snippet (default: basename of <dir>)
#   --sig 0x…           wallet mode: derive password+salt from this personal_sign signature
#   --filename-encryption standard|off|obfuscate   (default standard; must match at unlock)
#   --no-dir-encryption keep directory names in the clear
#   ENCVOL_WALLET_SIG   same as --sig
#   ENCVOL_PASSWORD     crypt password  (prompted if unset and no signature given)
#   ENCVOL_SALT         crypt salt / password2 (optional but recommended; prompted, empty = none)
#   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN
#                       bucket credentials (omit for a public bucket)
#
# Uses ONLY environment-defined rclone remotes - no rclone.conf is read or
# written, and no secret ever lands in argv. Mirrors exactly what the
# in-enclave manager runs at unlock, so a push here always pulls there.
set -euo pipefail

die() { echo "enclave-encvol: $*" >&2; exit 1; }
_sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -d' ' -f1; else shasum -a 256 | cut -d' ' -f1; fi; }

# The canonical wallet message. BYTE-EXACT contract with the app's UI (and
# any other signer): change it and every derived key changes.
_message() { printf 'Enclave encrypted volume key v1\nvolume: %s\n\nSigning derives this volume'"'"'s encryption key. Only sign in apps you trust with its contents.' "$1"; }

_derive() {  # $1 = signature; sets ENCVOL_PASSWORD / ENCVOL_SALT
  local sig
  sig="$(printf '%s' "$1" | tr -d '[:space:]' | tr 'A-Z' 'a-z')"
  [[ "$sig" =~ ^0x[0-9a-f]{130}$ ]] || die "signature must be 65-byte ECDSA hex (0x + 130 hex chars); got ${#sig} chars"
  ENCVOL_PASSWORD="$(printf '%s\n%s' "$sig" "enclave-encvol-v1:password" | _sha256)"
  ENCVOL_SALT="$(printf '%s\n%s' "$sig" "enclave-encvol-v1:salt" | _sha256)"
}

CMD="${1:-}"; case "$CMD" in push|pull|ls|message|derive|seal-creds) shift ;; *) die "usage: enclave-encvol.sh <push|pull|ls|message|derive|seal-creds> …" ;; esac

if [[ "$CMD" == "message" ]]; then
  KEYID="${1:-}"; [[ -n "$KEYID" ]] || die "usage: enclave-encvol.sh message <keyId>"
  _message "$KEYID"; echo
  exit 0
fi

DIR=""
if [[ "$CMD" == "push" || "$CMD" == "pull" ]]; then DIR="${1:-}"; [[ -n "$DIR" && "$DIR" != --* ]] || die "$CMD needs a local directory"; shift; fi

ENDPOINT="" BUCKET="" VPATH="" NAME="" FENC="standard" DENC="true" SIG="${ENCVOL_WALLET_SIG:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --endpoint) ENDPOINT="${2:-}"; shift 2 ;;
    --bucket)   BUCKET="${2:-}";   shift 2 ;;
    --path)     VPATH="${2:-}";    shift 2 ;;
    --name)     NAME="${2:-}";     shift 2 ;;
    --sig)      SIG="${2:-}";      shift 2 ;;
    --filename-encryption) FENC="${2:-}"; shift 2 ;;
    --no-dir-encryption) DENC="false"; shift ;;
    *) die "unknown option: $1" ;;
  esac
done

if [[ "$CMD" == "derive" ]]; then
  [[ -n "$SIG" ]] || die "derive needs --sig 0x… (or ENCVOL_WALLET_SIG)"
  _derive "$SIG"
  echo "export ENCVOL_PASSWORD=$ENCVOL_PASSWORD"
  echo "export ENCVOL_SALT=$ENCVOL_SALT"
  exit 0
fi

if [[ "$CMD" == "seal-creds" ]]; then
  [[ -n "$SIG" ]] || die "seal-creds needs --sig 0x… (or ENCVOL_WALLET_SIG)"
  command -v openssl >/dev/null 2>&1 || die "seal-creds needs openssl"
  [[ -n "${AWS_ACCESS_KEY_ID:-}" && -n "${AWS_SECRET_ACCESS_KEY:-}" ]] \
    || die "seal-creds reads AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (and optional AWS_SESSION_TOKEN) from the environment"
  sig="$(printf '%s' "$SIG" | tr -d '[:space:]' | tr 'A-Z' 'a-z')"
  [[ "$sig" =~ ^0x[0-9a-f]{130}$ ]] || die "signature must be 65-byte ECDSA hex (0x + 130 hex chars); got ${#sig} chars"
  ENC_KEY="$(printf '%s\n%s' "$sig" "enclave-encvol-v1:creds-enc" | _sha256)"
  MAC_KEY="$(printf '%s\n%s' "$sig" "enclave-encvol-v1:creds-mac" | _sha256)"
  # ENCVOL_SEAL_IV: test hook so the pinned e2e vector is reproducible.
  IV="${ENCVOL_SEAL_IV:-$(openssl rand -hex 16)}"
  [[ "$IV" =~ ^[0-9a-f]{32}$ ]] || die "ENCVOL_SEAL_IV must be 32 lowercase hex chars"
  _jesc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
  PT="{\"accessKeyId\":\"$(_jesc "$AWS_ACCESS_KEY_ID")\",\"secretAccessKey\":\"$(_jesc "$AWS_SECRET_ACCESS_KEY")\""
  [[ -n "${AWS_SESSION_TOKEN:-}" ]] && PT="$PT,\"sessionToken\":\"$(_jesc "$AWS_SESSION_TOKEN")\""
  PT="$PT}"
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
  # iv || ct  (iv hex -> raw bytes; plaintext never lands on disk or argv)
  printf '%b' "$(printf '%s' "$IV" | sed 's/../\\x&/g')" > "$TMP/ivct"
  printf '%s' "$PT" | openssl enc -aes-256-ctr -K "$ENC_KEY" -iv "$IV" >> "$TMP/ivct"
  openssl dgst -sha256 -mac hmac -macopt "hexkey:$MAC_KEY" -binary "$TMP/ivct" > "$TMP/tag"
  ENVELOPE="encv1:$(cat "$TMP/ivct" "$TMP/tag" | base64 | tr -d '\n')"
  echo "$ENVELOPE"
  cat >&2 <<EOF

Sealed. Add "credsEnvelope" to the volume's encVolumes entry in the (public)
App Config - it is ciphertext under the SAME wallet that guards the volume:

      "unlock": "wallet",
      "credsEnvelope": "$ENVELOPE"

One signature in the app then derives the crypt key AND opens these
credentials - no S3 fields to enter, after any restart.
EOF
  exit 0
fi

[[ -n "$ENDPOINT" && -n "$BUCKET" ]] || die "--endpoint and --bucket are required"
case "$FENC" in standard|off|obfuscate) ;; *) die "--filename-encryption must be standard|off|obfuscate" ;; esac
[[ "$CMD" != "push" || -d "$DIR" ]] || die "no such directory: $DIR"

if [[ -n "$SIG" ]]; then
  _derive "$SIG"      # wallet mode: password+salt come from the signature
else
  if [[ -z "${ENCVOL_PASSWORD:-}" ]]; then
    read -rs -p "crypt password: " ENCVOL_PASSWORD; echo >&2
    [[ -n "$ENCVOL_PASSWORD" ]] || die "empty password"
    if [[ "$CMD" == "push" ]]; then
      read -rs -p "confirm password: " P2; echo >&2
      [[ "$ENCVOL_PASSWORD" == "$P2" ]] || die "passwords do not match"
    fi
  fi
  if [[ -z "${ENCVOL_SALT+x}" ]]; then
    read -rs -p "salt / password2 (empty for none): " ENCVOL_SALT; echo >&2
  fi
fi

# env-only rclone config: encsrc = the S3 backend, encvol = crypt on top.
# Secrets ride the environment (obscured via stdin), never argv, never a file.
export RCLONE_CONFIG=/dev/null
export RCLONE_CONFIG_ENCSRC_TYPE=s3 RCLONE_CONFIG_ENCSRC_PROVIDER="${ENCVOL_PROVIDER:-Other}"
export RCLONE_CONFIG_ENCSRC_ENDPOINT="$ENDPOINT"
if [[ -n "${AWS_ACCESS_KEY_ID:-}" ]]; then
  export RCLONE_CONFIG_ENCSRC_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID"
  export RCLONE_CONFIG_ENCSRC_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-}"
  [[ -n "${AWS_SESSION_TOKEN:-}" ]] && export RCLONE_CONFIG_ENCSRC_SESSION_TOKEN="$AWS_SESSION_TOKEN"
else
  export RCLONE_CONFIG_ENCSRC_ENV_AUTH=false
fi
REMOTE="encsrc:${BUCKET}${VPATH:+/$VPATH}"
export RCLONE_CONFIG_ENCVOL_TYPE=crypt RCLONE_CONFIG_ENCVOL_REMOTE="$REMOTE"
export RCLONE_CONFIG_ENCVOL_FILENAME_ENCRYPTION="$FENC" RCLONE_CONFIG_ENCVOL_DIRECTORY_NAME_ENCRYPTION="$DENC"
command -v rclone >/dev/null || die "rclone not found (https://rclone.org/install/)"
RCLONE_CONFIG_ENCVOL_PASSWORD="$(printf '%s' "$ENCVOL_PASSWORD" | rclone obscure -)"
export RCLONE_CONFIG_ENCVOL_PASSWORD
if [[ -n "$ENCVOL_SALT" ]]; then
  RCLONE_CONFIG_ENCVOL_PASSWORD2="$(printf '%s' "$ENCVOL_SALT" | rclone obscure -)"
  export RCLONE_CONFIG_ENCVOL_PASSWORD2
fi

case "$CMD" in
  push)
    rclone sync "$DIR" encvol: --progress
    NAME="${NAME:-$(basename "$(realpath "$DIR")")}"
    cat >&2 <<EOF

Pushed. Add this to the version's App Config (the publish form's App config
box, or \`enclave publish --config\`) and unlock from the app after deploying:

  { "encVolumes": [ {
      "name": "$NAME",
      "endpoint": "$ENDPOINT",
      "bucket": "$BUCKET"$( [[ -n "$VPATH" ]] && printf ',\n      "path": "%s"' "$VPATH" )$( [[ -n "$SIG" ]] && printf ',\n      "unlock": "wallet"' )$( [[ "$FENC" != standard ]] && printf ',\n      "filenameEncryption": "%s"' "$FENC" )$( [[ "$DENC" == false ]] && printf ',\n      "directoryNameEncryption": false' )
  } ] }

(maxMb defaults to 1024; readOnly: true drops push-back credentials at unlock.$( [[ -n "$SIG" ]] && printf '\nWallet mode: if the keyId you signed differs from "%s", add "keyId" too.\nTip: `seal-creds` prints a "credsEnvelope" field so wallet unlocks need no S3 fields.' "$NAME" ))
EOF
    ;;
  pull) rclone sync encvol: "$DIR" --progress ;;
  ls)   rclone ls encvol: ;;
esac
