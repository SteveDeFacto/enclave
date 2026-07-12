#!/usr/bin/env bash
# enclave-encvol: pack + push an encrypted volume for Enclave deployments.
#
# The client half of encrypted volumes (rclone crypt over S3): encrypts a
# local directory with `rclone crypt` and syncs the CIPHERTEXT to any
# S3-compatible bucket. The enclave-side manager later pulls + decrypts it
# into the deployment's /enc/<name> when the owner unlocks from the app UI
# (see enclave-apps/encrypted-volumes). The bucket, the network, and the
# operator's host only ever see ciphertext; the password never leaves this
# machine except over the deployment's attested, in-enclave-terminated TLS
# at unlock time.
#
#   enclave-encvol.sh push <dir>  --endpoint URL --bucket B [--path P]   encrypt + upload <dir>
#   enclave-encvol.sh pull <dir>  --endpoint URL --bucket B [--path P]   download + decrypt into <dir>
#   enclave-encvol.sh ls          --endpoint URL --bucket B [--path P]   list the volume's decrypted names
#
# Options / environment:
#   --endpoint URL      S3 endpoint (https://s3.eu-central-1.amazonaws.com, any S3-compatible)
#   --bucket B          bucket name
#   --path P            key prefix inside the bucket (default: none)
#   --name N            volume name used in the printed App Config snippet (default: basename of <dir>)
#   --filename-encryption standard|off|obfuscate   (default standard; must match at unlock)
#   --no-dir-encryption keep directory names in the clear
#   ENCVOL_PASSWORD     crypt password  (prompted if unset)
#   ENCVOL_SALT         crypt salt / password2 (optional but recommended; prompted, empty = none)
#   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN
#                       bucket credentials (omit for a public bucket)
#
# Uses ONLY environment-defined rclone remotes - no rclone.conf is read or
# written, and no secret ever lands in argv. Mirrors exactly what the
# in-enclave manager runs at unlock, so a push here always pulls there.
set -euo pipefail

die() { echo "enclave-encvol: $*" >&2; exit 1; }
command -v rclone >/dev/null || die "rclone not found (https://rclone.org/install/)"

CMD="${1:-}"; case "$CMD" in push|pull|ls) shift ;; *) die "usage: enclave-encvol.sh <push|pull|ls> [dir] --endpoint URL --bucket B [--path P]" ;; esac
DIR=""
if [[ "$CMD" != "ls" ]]; then DIR="${1:-}"; [[ -n "$DIR" && "$DIR" != --* ]] || die "$CMD needs a local directory"; shift; fi

ENDPOINT="" BUCKET="" VPATH="" NAME="" FENC="standard" DENC="true"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --endpoint) ENDPOINT="${2:-}"; shift 2 ;;
    --bucket)   BUCKET="${2:-}";   shift 2 ;;
    --path)     VPATH="${2:-}";    shift 2 ;;
    --name)     NAME="${2:-}";     shift 2 ;;
    --filename-encryption) FENC="${2:-}"; shift 2 ;;
    --no-dir-encryption) DENC="false"; shift ;;
    *) die "unknown option: $1" ;;
  esac
done
[[ -n "$ENDPOINT" && -n "$BUCKET" ]] || die "--endpoint and --bucket are required"
case "$FENC" in standard|off|obfuscate) ;; *) die "--filename-encryption must be standard|off|obfuscate" ;; esac
[[ "$CMD" != "push" || -d "$DIR" ]] || die "no such directory: $DIR"

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
      "bucket": "$BUCKET"$( [[ -n "$VPATH" ]] && printf ',\n      "path": "%s"' "$VPATH" )$( [[ "$FENC" != standard ]] && printf ',\n      "filenameEncryption": "%s"' "$FENC" )$( [[ "$DENC" == false ]] && printf ',\n      "directoryNameEncryption": false' )
  } ] }

(maxMb defaults to 1024; readOnly: true drops push-back credentials at unlock.)
EOF
    ;;
  pull) rclone sync encvol: "$DIR" --progress ;;
  ls)   rclone ls encvol: ;;
esac
