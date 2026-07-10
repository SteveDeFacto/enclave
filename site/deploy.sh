#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"    # paths below are relative to site/, however this script is invoked

# bundle the site (tailwind + esbuild + inlined component templates) -> dist/
(cd .. && npm run -s build:site)

# ---- mixed-version protection: hashed chunks outlive their deploy ----
# The gateway serves everything with max-age=14400 (4h). Stable-named
# entries (page HTML, js/boot.js, privy/entry.js) cached by a browser or
# the CDN import the HASHED chunk names of THEIR build; a bare tree-swap
# 404s those the moment a new deploy lands (that's what silently killed
# the deploy console mid-churn: cached boot.js -> import("./deploy.js")
# gone -> console never boots, empty API field). Keep a 48h local archive
# of every hashed artifact and ship the union: any entry cached within the
# TTL still finds its exact chunks. cp -n never clobbers current files;
# hashed names are content-addressed, so name collisions are identical.
ARCHIVE=.chunk-archive
mkdir -p "$ARCHIVE/js/chunks" "$ARCHIVE/privy"
cp -p dist/js/chunks/* "$ARCHIVE/js/chunks/" 2>/dev/null || true
cp -p dist/privy/*     "$ARCHIVE/privy/"     2>/dev/null || true
find "$ARCHIVE" -type f -mmin +2880 -delete
cp -pn "$ARCHIVE/js/chunks/"* dist/js/chunks/ 2>/dev/null || true
cp -pn "$ARCHIVE/privy/"*     dist/privy/     2>/dev/null || true
echo "[deploy] chunk union: $(ls dist/js/chunks | wc -l) js chunks, $(ls dist/privy | wc -l) privy files (48h archive)"

# ship the bundle: replace the whole tree (tar over ssh; no rsync needed),
# so the IPFS pin never accumulates stale files from earlier layouts.
# NOTE: /opt/nan-site is wholly owned by this script — never park anything
# else there. (The ipfs add-gateway lives in /opt/enclave-gateway for exactly
# this reason; see scripts/deploy-ipfs-gateway.sh.)
ssh nan 'rm -rf /opt/nan-site && mkdir -p /opt/nan-site'
tar -C dist -czf - . | ssh nan 'tar -C /opt/nan-site -xzf -'
ssh nan 'chown -R ipfs:ipfs /opt/nan-site && \
  sudo -u ipfs IPFS_PATH=/var/lib/ipfs /usr/local/bin/nan-deploy.sh /opt/nan-site'
