#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"    # paths below are relative to site/, however this script is invoked

# bundle the site (tailwind + esbuild + inlined component templates) -> dist/
(cd .. && npm run -s build:site)

# ship the bundle: one tree, deletions included, so the IPFS pin never
# accumulates stale files from earlier layouts
rsync -az --delete --exclude 'cm-*' dist/ nan:/opt/nan-site/
ssh nan 'chown -R ipfs:ipfs /opt/nan-site && \
  sudo -u ipfs IPFS_PATH=/var/lib/ipfs /usr/local/bin/nan-deploy.sh /opt/nan-site'
