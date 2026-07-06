#!/usr/bin/env bash
# sync-contract-addresses.sh - fan the deployed contract addresses out to every
# file that ships them, so no flavor/config drifts after a redeploy.
#
# The deploy scripts each wire their own primary target (deploy-registry /
# -nanpay / -deployments write enclaves/gpu/tinfoil-config.yml; deploy-app-catalog
# writes site/index.html) but none of them touch the CPU flavor's config, and the
# catalog address is never copied into the enclave configs. This script reads
# the authoritative values from those primary targets and rewrites BOTH
# tinfoil configs. Idempotent; safe to run any time from anywhere in the repo.
set -euo pipefail
REPO="$(git rev-parse --show-toplevel)"
GPU="$REPO/enclaves/gpu/tinfoil-config.yml"
CPU="$REPO/enclaves/cpu/tinfoil-config.yml"
SITE="$REPO/site/index.html"
ADDR='0x[0-9a-fA-F]{40}'

from_cfg() { grep -oE "$1: \"$ADDR\"" "$GPU" | head -1 | grep -oE "$ADDR" || true; }
REGISTRY="$(from_cfg REGISTRY_ADDRESS)"
DEPLOYMENTS="$(from_cfg DEPLOYMENTS_ADDRESS)"
FORWARDER="$(from_cfg FORWARDER_ADDRESS)"
VOLACCESS="$(from_cfg VOLUME_ACCESS_ADDRESS)"
CATALOG="$(grep -oE "APP_CATALOG_ADDRESS = \"$ADDR\"" "$SITE" | grep -oE "$ADDR" || true)"

set_key() { # $1=file $2=env key $3=address — only where the file already carries the key
  [ -n "$3" ] || return 0
  grep -qE "$2: \"$ADDR\"" "$1" || return 0
  sed -i -E "s/($2: \")$ADDR(\")/\1$3\2/" "$1"
}
for f in "$GPU" "$CPU"; do
  [ -f "$f" ] || continue
  set_key "$f" REGISTRY_ADDRESS      "$REGISTRY"
  set_key "$f" DEPLOYMENTS_ADDRESS   "$DEPLOYMENTS"
  set_key "$f" FORWARDER_ADDRESS     "$FORWARDER"
  set_key "$f" VOLUME_ACCESS_ADDRESS "$VOLACCESS"
  set_key "$f" APP_CATALOG_ADDRESS   "$CATALOG"
done
echo "[sync] registry=${REGISTRY:-?} deployments=${DEPLOYMENTS:-?} nanpay=${FORWARDER:-?} volume-access=${VOLACCESS:-?} catalog=${CATALOG:-?}"
