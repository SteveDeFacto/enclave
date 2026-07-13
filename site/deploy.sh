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
# the union failing is silent breakage for every tab holding older HTML
# (observed 2026-07-10: a deploy shipped only the fresh generation, 404ing a
# prior build's chunks) - refuse to ship a tree smaller than the archive
[ "$(ls dist/js/chunks | wc -l)" -ge "$(ls "$ARCHIVE/js/chunks" | wc -l)" ] || {
  echo "[deploy] ERROR: chunk union did not take (dist has fewer chunks than the archive)"; exit 1; }

# ---- server-side chunk archive: the local archive above is EMPTY on CI
# (fresh checkout every run), so a CI deploy ships no prior generation
# (observed 2026-07-12: a CI deploy dropped every older chunk; cached tabs
# 404'd their imports). The site box always holds the PREVIOUS tree, so it
# keeps its own archive: harvest the live tree's hashed artifacts before the
# swap, union them back in after - correct no matter which machine deploys.
# mtimes are tar-preserved build times, so 48h retention is by build age.
ssh nan 'mkdir -p /opt/nan-chunk-archive/js/chunks /opt/nan-chunk-archive/privy && \
  { cp -p /opt/nan-site/js/chunks/* /opt/nan-chunk-archive/js/chunks/ 2>/dev/null; \
    cp -p /opt/nan-site/privy/*     /opt/nan-chunk-archive/privy/     2>/dev/null; \
    find /opt/nan-chunk-archive -type f -mmin +2880 -delete; true; }'

# ship the bundle: replace the whole tree (tar over ssh; no rsync needed),
# so the IPFS pin never accumulates stale files from earlier layouts.
# NOTE: /opt/nan-site is wholly owned by this script — never park anything
# else there. (The ipfs add-gateway lives in /opt/enclave-gateway for exactly
# this reason; see scripts/deploy-ipfs-gateway.sh.)
ssh nan 'rm -rf /opt/nan-site && mkdir -p /opt/nan-site'
tar -C dist -czf - . | ssh nan 'tar -C /opt/nan-site -xzf -'

# union the box's archive into the fresh tree (cp -n: the new build's own
# files always win; hashed names are content-addressed so collisions are
# identical bytes - and stable-named privy/entry.js is protected by -n)
ssh nan '{ cp -pn /opt/nan-chunk-archive/js/chunks/* /opt/nan-site/js/chunks/ 2>/dev/null; \
  cp -pn /opt/nan-chunk-archive/privy/* /opt/nan-site/privy/ 2>/dev/null; true; }; \
  echo "[deploy] server chunk union: $(ls /opt/nan-site/js/chunks | wc -l) js chunks, $(ls /opt/nan-site/privy | wc -l) privy files"'

ssh nan 'chown -R ipfs:ipfs /opt/nan-site && \
  sudo -u ipfs IPFS_PATH=/var/lib/ipfs /usr/local/bin/nan-deploy.sh /opt/nan-site'

# ---- CLI installers: Caddy serves these from /opt/enclave-get on
# enclave.host/install.{sh,ps1} and get.enclave.host (curl|sh one-liners) ----
tar -C ../cli -czf - install.sh install.ps1 | \
  ssh nan 'mkdir -p /opt/enclave-get && tar -C /opt/enclave-get -xzf - && chmod 0644 /opt/enclave-get/install.*'
echo "[deploy] installers shipped to /opt/enclave-get"
